import { useEffect, useRef, useState } from 'react'
import { Check, ChevronRight, CircleAlert, Cloud, Film, FolderOpen, History, ImagePlus, LoaderCircle, Plus, Send, Settings, Sparkles, X } from 'lucide-react'
import './App.css'

type Shot = {
  id: string
  index: number
  title: string
  description: string
  video_prompt: string
  status: string
  taskId?: string
  filename?: string
  imageFile?: string
}
type Message = { role: 'user' | 'assistant'; content: string; ts?: string }
type Project = {
  id: string
  title: string
  idea: string
  aspect: string
  duration: number
  engine: string
  shots: Shot[]
  messages: Message[]
  finalUrl?: string
  finalFilename?: string
}
type Status = {
  m3: boolean
  comfy: boolean
  model: string
  quota: { used: number; total: number; weeklyUsed: number; weeklyTotal: number }
  models?: { ready: boolean }
}

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) } })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || '请求失败')
  return data
}
const readFile = (file: File) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader()
  reader.onload = () => resolve(String(reader.result))
  reader.onerror = () => reject(new Error('读取图片失败'))
  reader.readAsDataURL(file)
})
const statusLabel = (value: string) => value === 'Success' ? '已完成' : value === 'Fail' ? '失败' : value === 'ready' ? '待生成' : '处理中'

function App() {
  const [view, setView] = useState<'create' | 'history' | 'settings'>('create')
  const [status, setStatus] = useState<Status | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingImage, setPendingImage] = useState('')
  const logRef = useRef<HTMLDivElement>(null)

  const refreshStatus = () => api<Status>('/api/status').then(setStatus)
  const loadProject = async (id?: string) => {
    const next = await api<Project>(id ? `/api/projects/${id}` : '/api/projects/current')
    setProject(next)
    return next
  }

  const inflight = (project?.shots || []).filter((shot) => shot.taskId && !['Success', 'Fail'].includes(shot.status)).map((shot) => shot.taskId).join(',')
  // Load current project and backend status once after mount.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => {
    Promise.all([refreshStatus(), loadProject()]).catch((item) => setError(item.message))
  }, [])

  useEffect(() => {
    if (!inflight || !project?.id) return
    const id = project.id
    const timer = window.setInterval(() => { loadProject(id).catch(() => {}) }, 8000)
    return () => clearInterval(timer)
  }, [inflight, project?.id])

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' })
  }, [project?.messages?.length])

  const send = async () => {
    if (!project || busy) return
    const text = draft.trim()
    if (!text && !pendingImage) return
    setBusy(true)
    setError('')
    setDraft('')
    try {
      const next = await api<Project>(`/api/projects/${project.id}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: text || '请看我上传的参考图', image: pendingImage || undefined }),
      })
      setPendingImage('')
      setProject(next)
      refreshStatus().catch(() => {})
    } catch (item) {
      setError(item instanceof Error ? item.message : '对话失败')
    } finally {
      setBusy(false)
    }
  }

  const newProject = async () => {
    const created = await api<Project>('/api/projects', { method: 'POST' })
    setProject(created)
    setDraft('')
    setPendingImage('')
  }

  const attachShotImage = async (index: number, file?: File) => {
    if (!file || !project) return
    if (file.size > 20 * 1024 * 1024) return setError('参考图不能超过20MB')
    const image = await readFile(file)
    const next = await api<Project>(`/api/projects/${project.id}/shots/${index}/image`, { method: 'POST', body: JSON.stringify({ image }) })
    setProject(next)
  }

  const preview = project?.finalUrl || (project?.shots?.find((shot) => shot.filename) ? `/media/${project.shots.find((shot) => shot.filename)?.filename}` : '')
  const messages = project?.messages || []

  return (
    <div className="app-shell chat-app">
      <header className="topbar">
        <div className="brand"><Sparkles size={25} fill="currentColor" /><strong>星绘视频工坊</strong></div>
        <div className="connections">
          <span className={status?.m3 ? 'online' : 'offline'}><i />导演 {status?.m3 ? '已连接' : '未连接'}</span>
          <span className={status?.comfy ? 'online' : 'offline'}><i />本机生成 {status?.comfy ? '就绪' : '未启动'}</span>
          <span className="quota"><Cloud size={17} />今日成片额度 {status?.quota.used ?? 0}/{status?.quota.total ?? 3}</span>
        </div>
      </header>
      <aside className="sidebar">
        <nav>
          <button className={view === 'create' ? 'active' : ''} onClick={() => setView('create')}><Film />创作</button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}><History />项目</button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><Settings />设置</button>
        </nav>
        <div className="sidebar-note">直接说话即可<br />不用管后面的生成器</div>
      </aside>

      {view === 'create' && (
        <>
          <main className="workspace chat-workspace">
            <div className="chat-log" ref={logRef}>
              {messages.length === 0 && (
                <div className="bubble assistant">想拍什么直接说。例如「做玄奘第一集」。缺关键信息我再问你，默认横屏 18 秒、本机出片，不消耗云端次数。</div>
              )}
              {messages.map((message, index) => (
                <div key={`${message.ts || index}-${index}`} className={`bubble ${message.role}`}>{message.content}</div>
              ))}
              {busy && <div className="bubble assistant muted"><LoaderCircle className="spin" />导演正在想下一步…</div>}
            </div>
            {error && <div className="error"><CircleAlert size={18} />{error}<button onClick={() => setError('')}><X size={16} /></button></div>}
            <form className="chat-input" onSubmit={(event) => { event.preventDefault(); send() }}>
              <label className="chat-attach">
                <input type="file" accept="image/jpeg,image/png,image/webp" onChange={async (event) => {
                  const file = event.target.files?.[0]
                  if (!file) return
                  if (file.size > 20 * 1024 * 1024) return setError('参考图不能超过20MB')
                  setPendingImage(await readFile(file))
                }} />
                {pendingImage ? <img src={pendingImage} alt="待发送参考图" /> : <ImagePlus size={20} />}
              </label>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="说想拍什么，或「第三镜头更震撼」" rows={2} onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
              }} />
              <button className="primary" type="submit" disabled={busy}><Send size={18} />发送</button>
            </form>
            <section className="preview compact">
              <div className="section-head">
                <h2>成片</h2>
                <div>
                  <button onClick={() => api('/api/output/open', { method: 'POST' }).catch((item) => setError(item.message))}><FolderOpen />打开输出</button>
                  <button onClick={newProject}><Plus />新项目</button>
                </div>
              </div>
              <div className="player">{preview ? <video src={preview} controls /> : <div className="empty-player"><span>镜头完成后会自动出现在这里</span></div>}</div>
            </section>
          </main>
          <aside className="plan-rail">
            <div className="rail-head">
              <div>
                <h2>{project?.title || '制作计划'}</h2>
                <p>{project?.shots?.length || 0} 个镜头 · {project?.aspect} · {project?.engine === 'cloud' ? '云端成片' : '本机草稿'}</p>
              </div>
            </div>
            <div className="shots">
              {(project?.shots || []).map((shot) => (
                <article key={shot.id} className="shot">
                  <label className="shot-thumb">
                    <span>{shot.index + 1}</span>
                    {shot.filename ? <video src={`/media/${shot.filename}`} muted /> : shot.imageFile ? <img src={`/api/projects/${project?.id}/media/${shot.imageFile}`} alt={shot.title} /> : <ImagePlus />}
                    <input type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => attachShotImage(shot.index, event.target.files?.[0])} />
                  </label>
                  <div className="shot-body">
                    <div className="shot-time">S{shot.index + 1} · 00:{String(shot.index * 6).padStart(2, '0')}–00:{String((shot.index + 1) * 6).padStart(2, '0')}</div>
                    <h3>{shot.title}</h3>
                    <p>{shot.description}</p>
                    <footer><span>{shot.imageFile ? '已绑参考图' : '点左侧上传此镜参考图'}</span><StatusText value={shot.status} /></footer>
                  </div>
                </article>
              ))}
              {!project?.shots?.length && <div className="empty-shots">分镜出现后，可以把不同参考图拖到每一镜上。</div>}
            </div>
          </aside>
        </>
      )}

      {view === 'history' && <HistoryPage onOpen={async (id) => { await loadProject(id); setView('create') }} />}
      {view === 'settings' && <SettingsPage status={status} />}
    </div>
  )
}

function StatusText({ value }: { value: string }) {
  const done = value === 'Success'
  const fail = value === 'Fail'
  const idle = value === 'ready' || !value
  return (
    <span className={`task-status ${done ? 'done' : fail ? 'fail' : idle ? '' : ''}`}>
      {done ? <Check /> : fail ? <CircleAlert /> : idle ? null : <LoaderCircle className="spin" />}
      {statusLabel(value)}
    </span>
  )
}

function HistoryPage({ onOpen }: { onOpen: (id: string) => void }) {
  const [items, setItems] = useState<Project[]>([])
  useEffect(() => { api<Project[]>('/api/projects').then(setItems).catch(() => {}) }, [])
  return (
    <main className="page">
      <h1>项目</h1>
      <p>聊天、分镜、镜头任务会一起保存在本机。</p>
      <div className="history-list">
        {items.length ? items.map((item) => (
          <button key={item.id} className="history-row" onClick={() => onOpen(item.id)}>
            <Film />
            <span><b>{item.title}</b><small>{item.idea || '尚无简介'} · {item.shots?.length || 0} 镜</small></span>
            <ChevronRight />
          </button>
        )) : <div className="empty">还没有保存的项目</div>}
      </div>
    </main>
  )
}

function SettingsPage({ status }: { status: Status | null }) {
  return (
    <main className="page">
      <h1>设置</h1>
      <p>后台状态。创作时不需要打开这些。</p>
      <div className="settings-list">
        <Setting label="对话导演" value={`${status?.model || 'MiniMax-M3'} · ${status?.m3 ? '已连接' : '未连接'}`} ok={status?.m3} />
        <Setting label="云端成片额度" value={`今日 ${status?.quota.used ?? 0}/${status?.quota.total ?? 3}`} ok={Boolean(status?.quota.total)} />
        <Setting label="本机生成" value={status?.comfy ? '已就绪' : '未启动'} ok={status?.comfy} />
        <Setting label="本机模型" value={status?.models?.ready ? '已就绪' : '不完整'} ok={status?.models?.ready} />
      </div>
    </main>
  )
}

function Setting({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div>
      <span className={ok ? 'setting-icon ok' : 'setting-icon'}>{ok ? <Check /> : <X />}</span>
      <b>{label}</b>
      <p>{value}</p>
      <ChevronRight />
    </div>
  )
}

export default App
