import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, ChevronRight, CircleAlert, ClipboardCheck, Cloud, FileText, Film, FolderOpen, History, ImagePlus, Lightbulb, LoaderCircle, Palette, Pencil, Play, Plus, RefreshCw, RotateCcw, Save, Send, Settings, SlidersHorizontal, Sparkles, Users, X } from 'lucide-react'
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
  generationProgress?: {
    key: string
    label: string
    min: number
    max: number
    value?: number
    exact?: boolean
    estimated?: boolean
  }
}
type DirectorChoice = { id: string; label: string; description: string; reply: string }
type Attachment = { id: string; filename: string; type: 'image'; mime?: string; size?: number; url: string }
type Message = { id?: string; role: 'user' | 'assistant'; content: string; attachments?: Attachment[]; insight?: string; choices?: DirectorChoice[]; ts?: string }
type UploadResult = { attachment: Attachment; project: Project }
type CreativeBrief = {
  goal: string
  audience: string
  platform: string
  story: string
  subject: string
  visualStyle: string
  tone: string
  audio: string
  constraints: string
  referenceNotes: string
}
type Concept = {
  id: string
  title: string
  logline: string
  narrative: string
  visualHook: string
  ending: string
}
type ProductionTask = { id: string; index: number; title: string; purpose: string; deliverable: string; owner: string }
type BriefRevision = { id: string; fields: string[]; insight?: string; createdAt: string }
type DecisionItem = { id: string; key: string; question: string; importance?: string; answer?: string; status: 'asked' | 'answered'; askedAt: string; answeredAt?: string }
type TextArtifact = {
  id: string
  type: string
  title: string
  summary: string
  version: number
  status: 'current' | 'superseded'
  content: Record<string, string | string[]>
  sourceArtifactIds: string[]
  model: string
  createdAt: string
}
type ArtifactEditDraft = {
  settings: { title: string; aspect: string; duration: number; engine: string; skill: string }
  creativeBrief: CreativeBrief
  artifacts: Array<{ type: string; title: string; summary: string; content: Record<string, string> }>
}
type PreviousRender = { id: string; url: string; filename: string; deliveredAt: string }
type QualityReview = {
  score: number
  verdict: 'pass' | 'revise'
  summary: string
  checks: Array<{ label: string; status: 'pass' | 'warning' | 'fail'; note: string }>
  recommendations: string[]
}
type Asset = { id: string; projectId: string; projectTitle: string; filename: string; title: string; url: string; updatedAt: string }
type ProcessStep = {
  id: string
  label: string
  completeness: number
  quality: number
  status: 'todo' | 'active' | 'done'
  current?: boolean
  missing: string[]
  canContinue: boolean
  note: string
}
type ProcessProgress = {
  overallCompleteness: number
  overallQuality: number
  currentId: string
  steps: ProcessStep[]
}
type Project = {
  id: string
  title: string
  idea: string
  aspect: string
  duration: number
  engine: string
  skill: string
  phase: string
  discoveryTurns: number
  creativeBrief: CreativeBrief
  concepts: Concept[]
  productionPlan: ProductionTask[]
  briefRevisions: BriefRevision[]
  decisionLedger: DecisionItem[]
  textArtifacts: TextArtifact[]
  previousRenders: PreviousRender[]
  referenceImages: string[]
  qualityReview?: QualityReview | null
  processProgress?: ProcessProgress
  stageInsight?: string
  stageChoices?: DirectorChoice[]
  selectedConceptId?: string
  shots: Shot[]
  messages: Message[]
  finalUrl?: string
  finalFilename?: string
  finalError?: string
  demoPreview?: boolean
}
type Status = {
  m3: boolean
  comfy: boolean
  demo?: boolean
  directorMode?: 'live' | 'demo' | 'offline'
  videoDemo?: boolean
  videoMode?: 'live' | 'demo'
  model: string
  quota: { used: number; total: number; weeklyUsed: number; weeklyTotal: number }
  models?: { ready: boolean; simulated?: boolean }
}

const api = async <T,>(url: string, options?: RequestInit): Promise<T> => {
  const headers = new Headers(options?.headers)
  if (!(options?.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(url, { ...options, headers })
  const contentType = response.headers.get('content-type') || ''
  const data = contentType.includes('application/json') ? await response.json() : { error: await response.text() }
  if (!response.ok) throw new Error(data.error || `请求失败 (${response.status})`)
  return data
}
const imageFromClipboard = (clipboard: DataTransfer) => {
  for (const item of Array.from(clipboard.items)) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile()
      if (file) return file
    }
  }
  return Array.from(clipboard.files).find((item) => item.type.startsWith('image/'))
}
const createClientId = () => typeof window.crypto?.randomUUID === 'function'
  ? window.crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const statusLabel = (value: string) => value === 'Success' ? '已完成' : value === 'Fail' ? '失败' : value === 'ready' ? '待生成' : '处理中'
const phaseLabel: Record<string, string> = {
  discovery: '需求访谈',
  brief_review: '简报评审',
  concept_selection: '创意方向',
  storyboard_review: '分镜评审',
  quality_review: '质量审核',
  ready_to_generate: '等待开拍',
  generating: '生成中',
  delivery_review: '交付评审',
  delivered: '已交付',
}
const skillLabel: Record<string, string> = {
  'narrative-film': '剧情短片',
  'product-ad': '产品广告',
  'social-koc': 'KOC 社媒',
  'knowledge-video': '知识视频',
  'custom-video': '自定义流程',
}

function App() {
  const [view, setView] = useState<'create' | 'history' | 'assets' | 'settings'>('create')
  const [status, setStatus] = useState<Status | null>(null)
  const [project, setProject] = useState<Project | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [pendingAttachment, setPendingAttachment] = useState<Attachment | null>(null)
  const [uploadingImage, setUploadingImage] = useState(false)
  const [draggingImage, setDraggingImage] = useState(false)
  const [pendingChoiceId, setPendingChoiceId] = useState<string | null>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const busyRef = useRef<HTMLDivElement>(null)

  const refreshStatus = () => api<Status>('/api/status').then(setStatus)
  const loadProject = async (id?: string) => {
    const next = await api<Project>(id ? `/api/projects/${id}` : '/api/projects/current')
    setProject(next)
    return next
  }

  const inflight = (project?.shots || []).filter((shot) => shot.taskId && !['Success', 'Fail'].includes(shot.status)).map((shot) => shot.taskId).join(',')
  // Load current project and backend status once after mount.
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect
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
    if (busy) busyRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }, [project?.messages?.length, busy])

  const send = async (override?: string, choiceId?: string) => {
    if (!project || busy) return
    if (uploadingImage) return setError('照片仍在上传，请等待缩略图显示后再发送')
    const text = override?.trim() || draft.trim()
    if (!text && !pendingAttachment) return setError('请输入内容或添加参考图')
    const projectId = project.id
    const submittedDraft = draft
    const submittedAttachment = pendingAttachment
    const submittedContent = text || '请分析这张参考图，并结合图片继续创作访谈。'
    const optimisticId = `pending-${createClientId()}`
    setBusy(true)
    setPendingChoiceId(choiceId || null)
    setError('')
    setDraft('')
    setPendingAttachment(null)
    setProject((current) => current?.id === projectId ? {
      ...current,
      messages: [...current.messages, {
        id: optimisticId,
        role: 'user',
        content: submittedContent,
        attachments: submittedAttachment ? [submittedAttachment] : [],
        ts: new Date().toISOString(),
      }],
    } : current)
    try {
      const next = await api<Project>(`/api/projects/${projectId}/chat`, {
        method: 'POST',
        body: JSON.stringify({ message: text, attachmentIds: submittedAttachment ? [submittedAttachment.id] : [] }),
      })
      setProject((current) => current?.id === projectId ? next : current)
      refreshStatus().catch(() => {})
    } catch (item) {
      setProject((current) => current?.id === projectId ? { ...current, messages: current.messages.filter((message) => message.id !== optimisticId) } : current)
      if (submittedAttachment) setPendingAttachment((current) => current || submittedAttachment)
      if (!override) setDraft((current) => current || submittedDraft)
      setError(item instanceof Error ? item.message : '对话失败')
    } finally {
      setBusy(false)
      setPendingChoiceId(null)
    }
  }

  const newProject = async () => {
    const created = await api<Project>('/api/projects', { method: 'POST' })
    setProject(created)
    setDraft('')
    setPendingAttachment(null)
  }

  const runProjectAction = async (action: string, body?: Record<string, unknown>) => {
    if (!project || busy) return
    setBusy(true)
    setError('')
    try {
      const next = await api<Project>(`/api/projects/${project.id}/${action}`, {
        method: 'POST',
        body: body ? JSON.stringify(body) : undefined,
      })
      setProject(next)
      refreshStatus().catch(() => {})
    } catch (item) {
      setError(item instanceof Error ? item.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  const saveArtifactStandards = async (nextDraft: ArtifactEditDraft) => {
    if (!project || busy) return false
    setBusy(true)
    setError('')
    try {
      const next = await api<Project>(`/api/projects/${project.id}/update-artifacts`, {
        method: 'POST',
        body: JSON.stringify(nextDraft),
      })
      setProject(next)
      return true
    } catch (item) {
      setError(item instanceof Error ? item.message : '生产标准保存失败')
      return false
    } finally {
      setBusy(false)
    }
  }

  const uploadReference = async (file: File, shotIndex?: number) => {
    if (!project) throw new Error('项目尚未载入')
    if (file.size > 20 * 1024 * 1024) throw new Error('参考图不能超过20MB')
    const supported = /^image\/(jpeg|png|webp)$/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name)
    if (!supported) throw new Error('当前支持 JPG、PNG、WebP；请先在手机相册中导出为兼容格式')
    const form = new FormData()
    form.append('image', file, file.name || 'reference-image')
    if (shotIndex !== undefined) form.append('shotIndex', String(shotIndex))
    return api<UploadResult>(`/api/projects/${project.id}/images`, { method: 'POST', body: form })
  }

  const selectReferenceImage = async (file?: File) => {
    if (!file || !project || uploadingImage) return
    setUploadingImage(true)
    setError('')
    try {
      const result = await uploadReference(file)
      setPendingAttachment(result.attachment)
      setProject(result.project)
    } catch (item) {
      setError(item instanceof Error ? item.message : '照片上传失败')
    } finally {
      setUploadingImage(false)
    }
  }

  const attachShotImage = async (index: number, file?: File) => {
    if (!file || !project) return
    setError('')
    try {
      const result = await uploadReference(file, index)
      setProject(result.project)
    } catch (item) {
      setError(item instanceof Error ? item.message : '镜头参考图上传失败')
    }
  }

  const preview = project?.finalUrl || (project?.shots?.find((shot) => shot.filename) ? `/media/${project.shots.find((shot) => shot.filename)?.filename}` : '')
  const messages = project?.messages || []
  const latestChoiceMessageIndex = messages.reduce((latest, message, index) => message.role === 'assistant' && message.choices?.length ? index : latest, -1)

  return (
    <div className="app-shell chat-app">
      <header className="topbar">
        <div className="brand"><Sparkles size={25} fill="currentColor" /><strong>星绘视频工坊</strong></div>
        <div className="connections">
          <span className={status?.m3 ? 'online' : 'offline'}><i />导演 {status?.directorMode === 'demo' ? '固定演示' : status?.m3 ? `${status.model} 已连接` : '未连接'}</span>
          <span className={status?.comfy ? 'online' : 'offline'}><i />本机生成 {status?.videoDemo ? '模拟模式' : status?.comfy ? '就绪' : '未启动'}</span>
          <span className="quota"><Cloud size={17} />{status?.quota.total ? `今日成片额度 ${status.quota.used}/${status.quota.total}` : '云端额度未连接'}</span>
        </div>
      </header>
      <aside className="sidebar">
        <nav>
          <button className={view === 'create' ? 'active' : ''} onClick={() => setView('create')}><Film />创作</button>
          <button className={view === 'history' ? 'active' : ''} onClick={() => setView('history')}><History />项目</button>
          <button className={view === 'assets' ? 'active' : ''} onClick={() => setView('assets')}><ImagePlus />素材</button>
          <button className={view === 'settings' ? 'active' : ''} onClick={() => setView('settings')}><Settings />设置</button>
        </nav>
        <div className="sidebar-note">直接说话即可<br />过程完整后仍可继续改<br />说“直接开始”会按默认值推进</div>
      </aside>

      {view === 'create' && (
        <>
          <main className="workspace chat-workspace">
            <div className="chat-log" ref={logRef}>
              {project?.processProgress && <ProcessStrip progress={project.processProgress} />}
              {project && <div className="mobile-artifacts"><CreativeArtifacts project={project} compact busy={busy} onSave={saveArtifactStandards} /></div>}
              {messages.length === 0 && (
                <>
                  <div className="bubble assistant">这次想做一支什么样的视频？先说一个大致想法，我会和你一起把故事、受众与画面方向梳理清楚。</div>
                  <div className="quick-starts">
                    <button onClick={() => setDraft('我想制作一支剧情短片，先帮我梳理故事和人物。')}>剧情短片</button>
                    <button onClick={() => setDraft('我想为一个产品制作广告，请先了解产品、受众和卖点。')}>产品广告</button>
                    <button onClick={() => setDraft('我想制作一支真实自然的 KOC 社媒视频。')}>KOC 社媒</button>
                    <button onClick={() => setDraft('我想把一个知识主题做成容易理解的短视频。')}>知识视频</button>
                  </div>
                </>
              )}
              {messages.map((message, index) => (
                <div key={`${message.ts || index}-${index}`} className={`bubble ${message.role}`}>
                  {Boolean(message.attachments?.length) && <div className="message-attachments">{message.attachments?.map((attachment) => <img key={attachment.id} src={attachment.url} alt="用户上传的参考图" />)}</div>}
                  <div>{message.content}</div>
                  {message.role === 'assistant' && message.insight && <div className="director-insight"><Sparkles /> <span><b>导演判断</b>{message.insight}</span></div>}
                  {message.role === 'assistant' && Boolean(message.choices?.length) && (
                    <div className="director-choices">
                      {message.choices?.map((choice) => (
                        <button key={choice.id} className={pendingChoiceId === choice.id ? 'submitting' : ''} disabled={busy || index !== latestChoiceMessageIndex} onClick={() => send(choice.reply, choice.id)}>
                          <b>{choice.label}</b><small>{pendingChoiceId === choice.id ? '正在提交给导演…' : choice.description}</small>{pendingChoiceId === choice.id ? <LoaderCircle className="spin" /> : <ChevronRight />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
              {busy && <div ref={busyRef} className="bubble assistant muted" role="status" aria-live="polite"><LoaderCircle className="spin" />导演正在想下一步…</div>}
            </div>
            {error && <div className="error"><CircleAlert size={18} />{error}<button onClick={() => setError('')}><X size={16} /></button></div>}
            <form className={`chat-input ${draggingImage ? 'is-dragging' : ''} ${busy ? 'is-busy' : ''}`} onSubmit={(event) => { event.preventDefault(); send() }} onDragOver={(event) => {
              event.preventDefault()
              if (event.dataTransfer.types.includes('Files')) setDraggingImage(true)
            }} onDragLeave={() => setDraggingImage(false)} onDrop={(event) => {
              event.preventDefault()
              setDraggingImage(false)
              const file = Array.from(event.dataTransfer.files).find((item) => item.type.startsWith('image/'))
              if (file) selectReferenceImage(file)
              else setError('请拖入 JPG、PNG 或 WebP 图片')
            }}>
              <div className={`chat-field ${pendingAttachment ? 'has-attachment' : ''}`}>
                {pendingAttachment && <div className="pending-attachment"><img src={pendingAttachment.url} alt="待发送参考图" /><button type="button" aria-label="移除待发送参考图" title="移除图片" onClick={() => setPendingAttachment(null)}><X /></button></div>}
                <textarea value={draft} disabled={busy} onChange={(event) => setDraft(event.target.value)} placeholder={project?.processProgress?.steps.some((item) => item.completeness >= 100) ? '这一关已完整，仍可继续补充或修改' : '描述需求或粘贴参考图'} rows={2} onPaste={(event) => {
                  const file = imageFromClipboard(event.clipboardData)
                  if (!file) return
                  event.preventDefault()
                  selectReferenceImage(file)
                }} onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send() }
                }} />
                <label className={`chat-image-button ${uploadingImage ? 'uploading' : ''} ${busy ? 'disabled' : ''}`} title={busy ? '正在发送' : uploadingImage ? '图片上传中' : '添加参考图'}>
                  <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy || uploadingImage} onChange={(event) => {
                    const file = event.currentTarget.files?.[0]
                    event.currentTarget.value = ''
                    selectReferenceImage(file)
                  }} />
                  {uploadingImage ? <LoaderCircle className="spin" /> : <ImagePlus />}
                </label>
                {draggingImage && <div className="drop-hint">松开添加图片</div>}
              </div>
              <button className="primary" type="submit" disabled={busy || uploadingImage} aria-busy={busy || uploadingImage}>
                {busy ? <><LoaderCircle className="spin" size={18} />发送中</> : uploadingImage ? <><LoaderCircle className="spin" size={18} />上传中</> : <><Send size={18} />发送</>}
              </button>
            </form>
            <section className="preview compact">
              <div className="section-head">
                <h2>成片</h2>
                <div>
                  <button onClick={() => api('/api/output/open', { method: 'POST' }).catch((item) => setError(item.message))}><FolderOpen />打开输出</button>
                  <button onClick={newProject}><Plus />新项目</button>
                </div>
              </div>
              <div className="player">{preview === 'demo://preview' ? <div className="demo-preview"><Film /><b>演示成片预览</b><span>阶段流转已完成，未执行真实视频推理</span></div> : preview ? <video src={preview} controls /> : <div className="empty-player"><span>镜头完成后会自动出现在这里</span></div>}</div>
            </section>
          </main>
          <aside className="plan-rail">
            <div className="rail-head">
              <div>
                <h2>{project?.title || '制作计划'}</h2>
                <p>
                  {phaseLabel[project?.phase || 'discovery']} · {project?.aspect} · {project?.engine === 'cloud' ? '云端成片' : '本机草稿'}
                  {project?.processProgress ? ` · 完整度 ${project.processProgress.overallCompleteness}%` : ''}
                </p>
              </div>
              {project?.processProgress && (
                <span className={`score-chip ${project.processProgress.overallQuality >= 80 ? 'pass' : project.processProgress.overallQuality >= 60 ? 'revise' : ''}`}>
                  {project.processProgress.overallQuality || project.qualityReview?.score || 0}
                </span>
              )}
            </div>
            {project && <CreativeArtifacts project={project} busy={busy} onSave={saveArtifactStandards} />}
            {project?.processProgress && <ProcessBoard progress={project.processProgress} />}
            {project && <WorkflowPanel project={project} busy={busy} onAction={runProjectAction} />}
            {project && project.productionPlan.length > 0 && <ProductionCanvas project={project} />}
            <div className="shots">
              {(project?.shots || []).map((shot) => (
                <article key={shot.id} className="shot">
                  <label className="shot-thumb">
                    <span>{shot.index + 1}</span>
                    {shot.filename && !project?.demoPreview ? <video src={`/media/${shot.filename}`} muted /> : shot.filename ? <Check /> : shot.imageFile ? <img src={`/api/projects/${project?.id}/media/${shot.imageFile}`} alt={shot.title} /> : <ImagePlus />}
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
      {view === 'assets' && project && <AssetsPage project={project} busy={busy} onUse={(asset) => runProjectAction('use-asset', { sourceProjectId: asset.projectId, filename: asset.filename })} />}
      {view === 'settings' && <SettingsPage status={status} />}
    </div>
  )
}

const artifactFieldLabels: Record<string, string> = {
  title: '项目标题', goal: '创作目标', audience: '目标受众', platform: '发布平台', story: '故事主线', subject: '主体角色',
  visualStyle: '视觉风格', tone: '情绪基调', audio: '声音设计', constraints: '制作边界', referenceNotes: '参考素材',
  aspect: '画幅', duration: '时长', engine: '生成方式', skill: '创作方法',
  'artifact:director_treatment': '导演阐述', 'artifact:script': '完整脚本', 'artifact:visual_guide': '视听说明', 'artifact:production_notes': '制作说明',
}

const artifactSections = [
  { id: 'positioning', title: '项目定位', icon: Users, fields: ['title', 'goal', 'audience', 'platform'] },
  { id: 'narrative', title: '叙事方案', icon: FileText, fields: ['story', 'subject', 'tone'] },
  { id: 'language', title: '视觉与声音', icon: Palette, fields: ['visualStyle', 'audio', 'referenceNotes'] },
  { id: 'execution', title: '制作约束', icon: SlidersHorizontal, fields: ['aspect', 'duration', 'engine', 'skill', 'constraints'] },
]

function artifactValue(project: Project, field: string) {
  if (field === 'title') return project.title
  if (field === 'aspect') return project.aspect
  if (field === 'duration') return `${project.duration} 秒`
  if (field === 'engine') return project.engine === 'cloud' ? '云端成片' : '本机生成'
  if (field === 'skill') return skillLabel[project.skill] || '自定义流程'
  return project.creativeBrief?.[field as keyof CreativeBrief] || ''
}

const textArtifactFieldLabels: Record<string, string> = {
  premise: '核心表达', approach: '叙事方法', audiencePromise: '观众所得', timeline: '时间脚本', opening: '开场', development: '发展', ending: '结尾',
  voiceover: '旁白', captions: '字幕', subject: '主体', scenes: '场景', camera: '镜头', colorLight: '光线色彩', sound: '声音',
  assumptions: '导演假设', risks: '执行风险', nextRevision: '修订重点',
}

function artifactDraftFor(project: Project): ArtifactEditDraft {
  return {
    settings: { title: project.title, aspect: project.aspect, duration: project.duration, engine: project.engine, skill: project.skill },
    creativeBrief: { ...project.creativeBrief },
    artifacts: (project.textArtifacts || []).filter((item) => item.status === 'current').map((item) => ({
      type: item.type,
      title: item.title,
      summary: item.summary,
      content: Object.fromEntries(Object.entries(item.content).map(([key, value]) => [key, Array.isArray(value) ? value.join('\n') : value])),
    })),
  }
}

function CreativeArtifacts({ project, compact = false, busy, onSave }: { project: Project; compact?: boolean; busy: boolean; onSave: (draft: ArtifactEditDraft) => Promise<boolean> }) {
  const [editDraft, setEditDraft] = useState<ArtifactEditDraft | null>(null)
  const recent = (project.briefRevisions || []).slice(-3).reverse()
  const artifactOrder = ['director_treatment', 'script', 'visual_guide', 'production_notes']
  const documents = (project.textArtifacts || [])
    .filter((item) => item.status === 'current')
    .sort((left, right) => artifactOrder.indexOf(left.type) - artifactOrder.indexOf(right.type))
  const changed = new Set(recent[0]?.fields || [])
  const filled = artifactSections.flatMap((section) => section.fields).filter((field) => artifactValue(project, field)).length
  const total = artifactSections.flatMap((section) => section.fields).length
  const compactFields = recent[0]?.fields?.length
    ? recent[0].fields.slice(0, 4)
    : artifactSections.flatMap((section) => section.fields).filter((field) => artifactValue(project, field)).slice(0, 3)
  const setBriefField = (field: keyof CreativeBrief, value: string) => setEditDraft((current) => current ? { ...current, creativeBrief: { ...current.creativeBrief, [field]: value } } : current)
  const setSetting = (field: keyof ArtifactEditDraft['settings'], value: string | number) => setEditDraft((current) => current ? { ...current, settings: { ...current.settings, [field]: value } } : current)
  const setDocument = (type: string, patch: Partial<ArtifactEditDraft['artifacts'][number]>) => setEditDraft((current) => current ? {
    ...current,
    artifacts: current.artifacts.map((item) => item.type === type ? { ...item, ...patch } : item),
  } : current)
  const setDocumentField = (type: string, field: string, value: string) => setEditDraft((current) => current ? {
    ...current,
    artifacts: current.artifacts.map((item) => item.type === type ? { ...item, content: { ...item.content, [field]: value } } : item),
  } : current)
  const commitEdit = async () => {
    if (!editDraft) return
    if (await onSave(editDraft)) setEditDraft(null)
  }
  if (editDraft) {
    return (
      <section className={`artifact-canvas artifact-editor${compact ? ' compact' : ''}`} aria-label="编辑生产标准">
        <div className="workflow-title"><Pencil />编辑生产标准<div className="artifact-edit-actions"><button title="取消修改" aria-label="取消修改" disabled={busy} onClick={() => setEditDraft(null)}><X /></button><button title="保存生产标准" aria-label="保存生产标准" disabled={busy} onClick={commitEdit}>{busy ? <LoaderCircle className="spin" /> : <Save />}</button></div></div>
        <fieldset>
          <legend>项目与制作设置</legend>
          <label><span>项目标题</span><input value={editDraft.settings.title} onChange={(event) => setSetting('title', event.target.value)} /></label>
          <label><span>画幅</span><select value={editDraft.settings.aspect} onChange={(event) => setSetting('aspect', event.target.value)}><option value="16:9">16:9</option><option value="9:16">9:16</option><option value="1:1">1:1</option></select></label>
          <label><span>时长</span><select value={editDraft.settings.duration} onChange={(event) => setSetting('duration', Number(event.target.value))}>{Array.from({ length: 10 }, (_, index) => (index + 1) * 6).map((value) => <option value={value} key={value}>{value} 秒</option>)}</select></label>
          <label><span>生成方式</span><select value={editDraft.settings.engine} onChange={(event) => setSetting('engine', event.target.value)}><option value="local">本机生成</option><option value="cloud">云端成片</option></select></label>
          <label><span>创作方法</span><select value={editDraft.settings.skill} onChange={(event) => setSetting('skill', event.target.value)}>{Object.entries(skillLabel).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
        </fieldset>
        {artifactSections.slice(0, 3).map((section) => (
          <fieldset key={section.id}>
            <legend>{section.title}</legend>
            {section.fields.filter((field) => field !== 'title').map((field) => <label key={field}><span>{artifactFieldLabels[field]}</span><textarea rows={2} value={editDraft.creativeBrief[field as keyof CreativeBrief]} onChange={(event) => setBriefField(field as keyof CreativeBrief, event.target.value)} /></label>)}
          </fieldset>
        ))}
        <fieldset><legend>制作约束</legend><label><span>制作边界</span><textarea rows={3} value={editDraft.creativeBrief.constraints} onChange={(event) => setBriefField('constraints', event.target.value)} /></label></fieldset>
        {editDraft.artifacts.map((item) => (
          <fieldset key={item.type}>
            <legend>{item.title}</legend>
            <label><span>文档标题</span><input value={item.title} onChange={(event) => setDocument(item.type, { title: event.target.value })} /></label>
            <label><span>摘要</span><textarea rows={2} value={item.summary} onChange={(event) => setDocument(item.type, { summary: event.target.value })} /></label>
            {Object.entries(item.content).map(([field, value]) => <label key={field}><span>{textArtifactFieldLabels[field] || field}</span><textarea rows={field === 'timeline' ? 6 : 3} value={value} onChange={(event) => setDocumentField(item.type, field, event.target.value)} /></label>)}
          </fieldset>
        ))}
      </section>
    )
  }
  if (compact) {
    return (
      <section className="artifact-canvas compact" aria-label="本轮创作产物">
        <div className="workflow-title"><Sparkles />{recent[0] ? '本轮形成' : '当前创作产物'} <span>{filled}/{total}</span><button className="artifact-edit-button" title="编辑生产标准" aria-label="编辑生产标准" onClick={() => setEditDraft(artifactDraftFor(project))}><Pencil /></button></div>
        <dl>
          {compactFields.map((field) => <div key={field}><dt>{artifactFieldLabels[field] || field}</dt><dd>{artifactValue(project, field) || '待确认'}</dd></div>)}
        </dl>
        {documents.slice(0, 2).map((item) => <div className="artifact-compact-document" key={item.id}><b>{item.title} V{item.version}</b><span>{item.summary}</span></div>)}
      </section>
    )
  }
  return (
    <section className="artifact-canvas" aria-label="持续创作产物">
      <div className="workflow-title"><Sparkles />持续创作画布 <span>{filled}/{total} 项已形成</span><button className="artifact-edit-button" title="编辑生产标准" aria-label="编辑生产标准" onClick={() => setEditDraft(artifactDraftFor(project))}><Pencil /></button></div>
      <p>每轮对话确认的内容会立即写入这些生产文档，后续创意与分镜直接引用。</p>
      <div className="artifact-sections">
        {artifactSections.map((section) => {
          const Icon = section.icon
          return (
            <article key={section.id}>
              <header><Icon /><b>{section.title}</b></header>
              <dl>
                {section.fields.map((field) => {
                  const value = artifactValue(project, field)
                  return <div key={field} className={changed.has(field) ? 'updated' : value ? 'filled' : 'empty'}><dt>{artifactFieldLabels[field]}</dt><dd>{value || '待确认'}</dd>{changed.has(field) && <em>本轮更新</em>}</div>
                })}
              </dl>
            </article>
          )
        })}
      </div>
      {documents.length > 0 && <div className="artifact-documents">
        {documents.map((item) => (
          <article key={item.id}>
            <header><FileText /><b>{item.title}</b><span>V{item.version}</span></header>
            {item.summary && <p>{item.summary}</p>}
            <dl>
              {Object.entries(item.content).map(([key, value]) => (
                <div key={key}><dt>{textArtifactFieldLabels[key] || key}</dt><dd>{Array.isArray(value) ? value.join('；') : value}</dd></div>
              ))}
            </dl>
          </article>
        ))}
      </div>}
      {recent.length > 0 && <div className="artifact-revisions">
        <b>最近形成</b>
        {recent.map((revision) => <div key={revision.id}><span>{revision.fields.map((field) => artifactFieldLabels[field] || field).join(' · ')}</span>{revision.insight && <small>{revision.insight}</small>}</div>)}
      </div>}
    </section>
  )
}

function ProcessStrip({ progress }: { progress: ProcessProgress }) {
  const current = progress.steps.find((item) => item.current) || progress.steps[0]
  return (
    <section className="process-strip" aria-label="制作完整度">
      <div className="process-strip-head">
        <b>完整度 {progress.overallCompleteness}%</b>
        <span>过程质量 {progress.overallQuality || '—'}</span>
      </div>
      <div className="process-strip-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.overallCompleteness}>
        <div style={{ width: `${progress.overallCompleteness}%` }} />
      </div>
      <div className="process-strip-steps">
        {progress.steps.map((item) => (
          <span key={item.id} className={`${item.status}${item.current ? ' current' : ''}`}>
            {item.label}<em>{item.completeness}%</em>{item.quality > 0 ? <i>{item.quality}</i> : null}
          </span>
        ))}
      </div>
      <small>{current.completeness >= 100 ? `${current.label}已完整，仍可继续对话修改。` : current.missing[0] ? `${current.label}还缺：${current.missing.join('、')}` : `${current.label}进行中，说完即可往下走。`}</small>
    </section>
  )
}

function ProcessBoard({ progress }: { progress: ProcessProgress }) {
  return (
    <section className="workflow-panel process-board">
      <div className="workflow-title"><ClipboardCheck />过程完整度 <span>质量 {progress.overallQuality || '—'}</span></div>
      <div className="process-board-list">
        {progress.steps.map((item) => (
          <article key={item.id} className={`${item.status}${item.current ? ' current' : ''}`}>
            <div>
              <b>{item.label}</b>
              <small>{item.note}</small>
            </div>
            <div className="process-board-meters">
              <span>完整 {item.completeness}%</span>
              <span className={item.quality >= 80 ? 'good' : item.quality >= 60 ? 'ok' : item.quality > 0 ? 'low' : ''}>质量 {item.quality || '—'}</span>
            </div>
            <div className="generation-progress-track" aria-hidden="true"><div className="generation-progress-fill" style={{ width: `${item.completeness}%` }} /></div>
          </article>
        ))}
      </div>
      <p className="workflow-hint">任何一关到 100% 都可以继续在对话里改，不会锁死。</p>
    </section>
  )
}

function WorkflowPanel({ project, busy, onAction }: {
  project: Project
  busy: boolean
  onAction: (action: string, body?: Record<string, unknown>) => void
}) {
  const pending = project.shots.filter((shot) => !shot.taskId || shot.status === 'Fail' || shot.status === 'ready')
  const processing = project.shots.filter((shot) => shot.taskId && !['Success', 'Fail'].includes(shot.status)).length
  const failed = project.shots.filter((shot) => shot.status === 'Fail').length

  if (project.phase === 'discovery') {
    return (
      <section className="workflow-panel discovery-panel">
        <div className="workflow-title"><Sparkles />需求访谈 <span>{project.discoveryTurns || 0} 轮</span></div>
        <p>{project.creativeBrief?.goal || '等待创作想法'}</p>
      </section>
    )
  }

  if (project.phase === 'brief_review') {
    return (
      <section className="workflow-panel">
        <div className="workflow-title"><Check />简报审核门</div>
        <p>上方四份创作产物已经形成。确认后会以它们为唯一依据生成多个差异明确的创意方向。</p>
        <button className="workflow-primary" disabled={busy} onClick={() => onAction('confirm-brief')}><Lightbulb />确认简报，生成创意方向</button>
      </section>
    )
  }

  if (project.phase === 'concept_selection') {
    return (
      <section className="workflow-panel">
        <div className="workflow-title"><Lightbulb />选择创意方向</div>
        {project.stageInsight && <p className="stage-insight">{project.stageInsight}</p>}
        <div className="concept-list">
          {project.concepts.map((concept) => (
            <article key={concept.id} className="concept-option">
              <h3>{concept.title}</h3>
              <p>{concept.logline}</p>
              <small>{concept.visualHook}</small>
              <button disabled={busy} onClick={() => onAction('select-concept', { conceptId: concept.id })}>选择此方向<ChevronRight /></button>
            </article>
          ))}
        </div>
        <div className="workflow-actions">
          <button disabled={busy} onClick={() => onAction('revise-brief')}><ArrowLeft />修改简报</button>
          <button disabled={busy} onClick={() => onAction('regenerate-concepts')}><RefreshCw />换一组</button>
        </div>
      </section>
    )
  }

  if (project.phase === 'storyboard_review') {
    return (
      <section className="workflow-panel">
        <div className="workflow-title"><Film />分镜评审</div>
        <p>{project.stageInsight || `共 ${project.shots.length} 镜，${project.duration} 秒`}</p>
        {Boolean(project.stageChoices?.length) && <div className="stage-choices">{project.stageChoices?.map((choice) => <button key={choice.id} disabled={busy} onClick={() => onAction('chat', { message: choice.reply })}><b>{choice.label}</b><small>{choice.description}</small></button>)}</div>}
        <button className="workflow-primary" disabled={busy || !project.shots.length} onClick={() => onAction('confirm-storyboard')}><Check />确认并继续</button>
        <button className="workflow-secondary" disabled={busy} onClick={() => onAction('reselect-concept')}><ArrowLeft />重新选择方向</button>
      </section>
    )
  }

  if (project.phase === 'quality_review') {
    return (
      <section className="workflow-panel quality-panel">
        <QualityReviewCard review={project.qualityReview} />
        <button className="workflow-primary" disabled={busy} onClick={() => onAction('approve-quality')}><Check />通过审核，准备开拍</button>
        <button className="workflow-secondary" disabled={busy} onClick={() => onAction('revise-storyboard')}><ArrowLeft />返回修改分镜</button>
      </section>
    )
  }

  if (project.phase === 'ready_to_generate') {
    const cloud = project.engine === 'cloud'
    return (
      <section className={`workflow-panel shoot-panel ${cloud ? 'cloud-shoot' : ''}`}>
        <div className="workflow-title"><Play />准备开拍</div>
        <p>{pending.length} 个镜头 · {cloud ? `将消耗 ${pending.length} 次云端额度` : '本机生成，不消耗云端额度'}</p>
        {project.qualityReview && <QualityReviewCard review={project.qualityReview} compact />}
        <button className="workflow-primary" disabled={busy || !pending.length} onClick={() => onAction('generate', cloud ? { shots: 'pending', confirmCloud: true, confirmedCount: pending.length } : { shots: 'pending' })}>
          <Play />{cloud ? `确认消耗 ${pending.length} 次并开拍` : '开始本机生成'}
        </button>
        <button className="workflow-secondary" disabled={busy} onClick={() => onAction('revise-storyboard')}><ArrowLeft />返回调整分镜</button>
      </section>
    )
  }

  if (project.phase === 'generating') {
    return (
      <section className="workflow-panel">
        <div className="workflow-title"><LoaderCircle className={processing ? 'spin' : ''} />镜头生成中</div>
        <GenerationProgress shots={project.shots} />
        <p>{processing ? `${processing} 个任务正在处理` : failed ? `${failed} 个镜头生成失败` : pending.length ? `${pending.length} 个镜头等待继续生成` : '正在整理成片'}</p>
        {project.qualityReview && <QualityReviewCard review={project.qualityReview} compact />}
        {pending.length > 0 && <button className="workflow-primary" disabled={busy} onClick={() => onAction('generate', project.engine === 'cloud' ? { shots: 'pending', confirmCloud: true, confirmedCount: pending.length } : { shots: 'pending' })}><RefreshCw />{failed ? '重试失败镜头' : '继续生成未完成镜头'}</button>}
        {project.finalError && <p className="workflow-error">{project.finalError}</p>}
      </section>
    )
  }

  if (project.phase === 'delivery_review') {
    return (
      <section className="workflow-panel delivery-panel">
        <div className="workflow-title"><Film />成片交付评审</div>
        <p>{project.title}</p>
        {project.qualityReview && <QualityReviewCard review={project.qualityReview} compact />}
        <button className="workflow-primary" disabled={busy} onClick={() => onAction('approve-delivery')}><Check />确认交付</button>
        <button className="workflow-secondary" disabled={busy} onClick={() => onAction('revise-storyboard')}><ArrowLeft />返回修改</button>
        <button className="workflow-secondary" disabled={busy} onClick={() => onAction('prepare-reshoot')}><RotateCcw />基于当前分镜重新开拍</button>
      </section>
    )
  }

  return (
    <section className="workflow-panel completed-panel">
      <div className="workflow-title"><Check />项目已完成</div>
      <p>{project.title}</p>
      {project.qualityReview && <QualityReviewCard review={project.qualityReview} compact />}
      {project.previousRenders.length > 0 && <p className="workflow-hint">已保留 {project.previousRenders.length} 个历史成片版本</p>}
      <button className="workflow-primary" disabled={busy} onClick={() => onAction('prepare-reshoot')}><RotateCcw />基于当前分镜重新开拍</button>
    </section>
  )
}

function QualityReviewCard({ review, compact = false }: { review?: QualityReview | null; compact?: boolean }) {
  const [open, setOpen] = useState(!compact)
  if (!review) {
    return (
      <div className="quality-score-card empty">
        <ClipboardCheck />
        <div><b>尚未质检</b><small>确认分镜后会给出分数和修改建议</small></div>
      </div>
    )
  }
  const fails = review.checks.filter((item) => item.status === 'fail').length
  const warns = review.checks.filter((item) => item.status === 'warning').length
  const verdictText = review.verdict === 'pass' ? '可以开拍' : '建议先改分镜'
  const counts = [
    fails ? `${fails} 项不通过` : '',
    warns ? `${warns} 项有风险` : '',
    !fails && !warns ? '检查项全部通过' : '',
  ].filter(Boolean).join(' · ')
  return (
    <div className={`quality-score-card ${review.verdict === 'pass' ? 'pass' : 'revise'}`}>
      <button type="button" className="quality-score-head" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <b>{review.score}</b>
        <span>
          <strong>分镜质检 · {verdictText}</strong>
          <small>{counts}</small>
        </span>
        <ChevronRight className={open ? 'open' : ''} />
      </button>
      {open && (
        <div className="quality-score-body">
          {review.summary && <p>{review.summary}</p>}
          <div className="quality-checks">
            {review.checks.map((check) => (
              <div key={check.label} className={check.status}><i /> <span><b>{check.label}</b><small>{check.note}</small></span></div>
            ))}
          </div>
          {(review.recommendations || []).length > 0 && (
            <ul>{review.recommendations.map((item) => <li key={item}>{item}</li>)}</ul>
          )}
        </div>
      )}
    </div>
  )
}

function GenerationProgress({ shots }: { shots: Shot[] }) {
  const total = Math.max(1, shots.length)
  const complete = shots.filter((shot) => shot.status === 'Success').length
  const active = shots.find((shot) => shot.status === 'Processing')
  const waiting = shots.filter((shot) => shot.status === 'Queueing').length
  const detail = active?.generationProgress
  const exactShotPercent = detail?.exact && detail.max && detail.value !== undefined ? Math.round((detail.value / detail.max) * 100) : undefined
  const exactSteps = detail?.exact && detail.value !== undefined && detail.max ? `${detail.value}/${detail.max}` : ''
  const overallPercent = exactShotPercent === undefined ? Math.round((complete / total) * 100) : Math.round(((complete + exactShotPercent / 100) / total) * 100)
  const currentText = active
    ? exactShotPercent === undefined
      ? `S${active.index + 1} · ${detail?.label || '正在连接 H3 工作流'}（阶段估算 ${detail?.min ?? 0}–${detail?.max ?? 99}%）`
      : `S${active.index + 1} · ${detail?.label || '采样生成视频帧'} · ${exactSteps} 步（精确 ${exactShotPercent}%）`
    : waiting ? `${waiting} 镜正在排队` : complete === total ? '镜头已完成，正在合成成片' : '正在同步生成状态'
  return (
    <div className="generation-progress" aria-live="polite">
      <div className="generation-progress-head"><b>成片完成</b><span>{complete}/{shots.length} 镜 · {overallPercent}%</span></div>
      <div className="generation-progress-track" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overallPercent} aria-label="视频生成总进度">
        <div className="generation-progress-fill" style={{ width: `${overallPercent}%` }} />
        {active && <div className="generation-progress-active" />}
      </div>
      <small>{currentText}</small>
      {active && <div className="generation-stage-list" aria-label="当前镜头阶段">
        {['加载与编码', '采样生成', '解码封装'].map((stage, index) => {
          const activeStage = detail?.key === 'loading' ? 0 : detail?.key === 'prepare' || detail?.key === 'sampling' ? 1 : 2
          return <span key={stage} className={index < activeStage ? 'done' : index === activeStage ? 'active' : ''}>{stage}</span>
        })}
      </div>}
      <div className="generation-progress-shots">
        {shots.map((shot) => <span key={shot.id} className={shot.status === 'Success' ? 'done' : shot.status === 'Processing' ? 'active' : shot.status === 'Fail' ? 'fail' : ''}>S{shot.index + 1}</span>)}
      </div>
    </div>
  )
}

function ProductionCanvas({ project }: { project: Project }) {
  return (
    <section className="production-canvas">
      <div className="workflow-title"><Sparkles />制作画布</div>
      <div className="production-nodes">
        {project.productionPlan.map((task, index) => (
          <article key={task.id}>
            <span>{String(index + 1).padStart(2, '0')}</span>
            <div><h3>{task.title}</h3><p>{task.deliverable}</p><small>{task.owner}</small></div>
          </article>
        ))}
      </div>
    </section>
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

function AssetsPage({ project, busy, onUse }: { project: Project; busy: boolean; onUse: (asset: Asset) => void }) {
  const [items, setItems] = useState<Asset[]>([])
  const [loadError, setLoadError] = useState('')
  useEffect(() => {
    api<Asset[]>('/api/assets').then(setItems).catch((item) => setLoadError(item instanceof Error ? item.message : '素材加载失败'))
  }, [project.id, project.referenceImages?.length])
  return (
    <main className="page assets-page">
      <h1>素材中心</h1>
      <p>当前项目：{project.title}</p>
      {loadError && <div className="error"><CircleAlert size={18} />{loadError}</div>}
      <div className="asset-grid">
        {items.map((asset) => (
          <article key={asset.id} className="asset-card">
            <img src={asset.url} alt={asset.title} />
            <div><b>{asset.title}</b><small>{asset.projectTitle}</small></div>
            <button disabled={busy || asset.projectId === project.id} onClick={() => onUse(asset)}>{asset.projectId === project.id ? <Check /> : <Plus />}{asset.projectId === project.id ? '已在项目中' : '用于当前项目'}</button>
          </article>
        ))}
        {!items.length && !loadError && <div className="empty">还没有沉淀的参考素材</div>}
      </div>
    </main>
  )
}

function SettingsPage({ status }: { status: Status | null }) {
  const director = status?.directorMode === 'demo' ? '固定演示（非 LLM）' : status?.directorMode === 'live' ? '真实模型已连接' : '未配置 API Key'
  return (
    <main className="page">
      <h1>设置</h1>
      <p>后台状态。创作时不需要打开这些。</p>
      <div className="settings-list">
        <Setting label="对话导演" value={`${status?.model || 'MiniMax-M3'} · ${director}`} ok={status?.directorMode === 'live'} />
        <Setting label="云端成片额度" value={status?.quota.total ? `今日 ${status.quota.used}/${status.quota.total}` : '未连接'} ok={Boolean(status?.quota.total)} />
        <Setting label="本机生成" value={status?.videoDemo ? '模拟模式（不执行推理）' : status?.comfy ? '已就绪' : '未启动'} ok={status?.comfy && !status?.videoDemo} />
        <Setting label="本机模型" value={status?.models?.simulated ? '模拟模式（未核验）' : status?.models?.ready ? '已就绪' : '不完整'} ok={Boolean(status?.models?.ready && !status?.models?.simulated)} />
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
