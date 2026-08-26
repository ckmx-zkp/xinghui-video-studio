import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import ffmpegPath from 'ffmpeg-static'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createProjectStore } from './projects.mjs'
import { DIRECTOR_SYSTEM, extractJson, parseDirectorReply, resolveShotList, snapshotForDirector } from './director.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
dotenv.config({ path: path.join(root, '.env') })

const app = express()
const port = Number(process.env.STUDIO_PORT || 4175)
const apiHost = process.env.MINIMAX_API_HOST || 'https://api.minimaxi.com'
const apiKey = process.env.MINIMAX_API_KEY || ''
const textModel = process.env.MINIMAX_TEXT_MODEL || 'MiniMax-M3'
const comfyUrl = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const comfyRoot = path.join(root, 'ComfyUI_windows_portable', 'ComfyUI')
const outputDir = path.join(root, 'outputs', 'cloud')
const localDir = path.join(root, 'outputs', 'local')
const taskFile = path.join(outputDir, 'tasks.json')
fs.mkdirSync(outputDir, { recursive: true })
fs.mkdirSync(localDir, { recursive: true })
const store = createProjectStore(root)

const H3_MODELS = [
  { id: 'dit', file: 'minimax_h3_fl2va_pruned-Q4_K.gguf', dir: 'diffusion_models' },
  { id: 'clip', file: 'qwen3vl-32B-MiniMax-H3-Q2_K.gguf', dir: 'text_encoders' },
  { id: 'video_vae', file: 'minimax_h3_video_vae_int8_convrot.safetensors', dir: 'vae' },
  { id: 'audio_vae', file: 'minimax_h3_audio_vae_bf16.safetensors', dir: 'vae' },
  { id: 'turbo', file: 'minimax_h3_turbo_v4_step600_ema.safetensors', dir: 'loras' },
]
const H3_SIZE = {
  '16:9': [864, 480],
  '9:16': [480, 864],
  '1:1': [640, 640],
}

app.use(cors())
app.use(express.json({ limit: '28mb' }))
app.use('/media', express.static(outputDir))
app.use('/media', express.static(localDir))

const authHeaders = () => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' })
const readTasks = () => {
  try { return JSON.parse(fs.readFileSync(taskFile, 'utf8')) } catch { return [] }
}
const writeTasks = (tasks) => fs.writeFileSync(taskFile, JSON.stringify(tasks, null, 2))
const upsertTask = (task) => {
  const tasks = readTasks()
  const index = tasks.findIndex((item) => item.id === task.id)
  if (index >= 0) tasks[index] = { ...tasks[index], ...task }
  else tasks.unshift(task)
  writeTasks(tasks)
  return tasks.find((item) => item.id === task.id)
}
const miniFetch = async (url, options = {}) => {
  if (!apiKey) throw new Error('MINIMAX_API_KEY 尚未配置')
  const response = await fetch(url, { ...options, headers: { ...authHeaders(), ...(options.headers || {}) } })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = { message: text } }
  if (!response.ok || data?.base_resp?.status_code) {
    throw new Error(data?.base_resp?.status_msg || data?.message || `MiniMax API ${response.status}`)
  }
  return data
}

function listH3Models() {
  return H3_MODELS.map((item) => {
    const fullPath = path.join(comfyRoot, 'models', item.dir, item.file)
    return { ...item, present: fs.existsSync(fullPath), path: fullPath }
  })
}

function h3Length(seconds) {
  const frames = Math.max(5, Math.round(Number(seconds || 6) * 24))
  return 17 * Math.max(0, Math.ceil((frames - 5) / 17)) + 5
}

function h3Size(aspect) {
  return H3_SIZE[aspect] || H3_SIZE['16:9']
}

async function comfyOk() {
  try {
    const response = await fetch(`${comfyUrl}/system_stats`, { signal: AbortSignal.timeout(2500) })
    return response.ok
  } catch {
    return false
  }
}

async function comfyJson(pathname, options = {}) {
  const response = await fetch(`${comfyUrl}${pathname}`, {
    ...options,
    headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(30000),
  })
  const text = await response.text()
  let data
  try { data = JSON.parse(text) } catch { data = { message: text } }
  if (!response.ok) {
    const nodeErrors = data?.node_errors ? JSON.stringify(data.node_errors).slice(0, 800) : ''
    throw new Error(data?.error || data?.message || nodeErrors || `ComfyUI ${response.status}`)
  }
  return data
}

function buildH3Prompt({ prompt, width, height, length, imageName, seed }) {
  const graph = {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'minimax_h3_fl2va_pruned-Q4_K.gguf' } },
    '2': { class_type: 'MiniMaxH3TurboLoRA', inputs: { model: ['1', 0], lora_name: 'minimax_h3_turbo_v4_step600_ema.safetensors', strength: 1, low_vram: true } },
    '3': { class_type: 'CLIPLoaderGGUF', inputs: { clip_name: 'qwen3vl-32B-MiniMax-H3-Q2_K.gguf', type: 'minimax' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_int8_convrot.safetensors' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_bf16.safetensors' } },
    '7': {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: { clip: ['3', 0], vae: ['4', 0], prompt, width, height, length },
    },
    '8': { class_type: 'MiniMaxH3TurboSampler', inputs: {} },
    '9': { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: 'simple', steps: 6, denoise: 1 } },
    '10': { class_type: 'RandomNoise', inputs: { noise_seed: seed } },
    '11': { class_type: 'BasicGuider', inputs: { model: ['2', 0], conditioning: ['7', 0] } },
    '12': {
      class_type: 'SamplerCustomAdvanced',
      inputs: { noise: ['10', 0], guider: ['11', 0], sampler: ['8', 0], sigmas: ['9', 0], latent_image: ['7', 1] },
    },
    '13': { class_type: 'VAEDecode', inputs: { samples: ['12', 0], vae: ['4', 0] } },
    '14': { class_type: 'VAEDecodeAudio', inputs: { samples: ['12', 0], vae: ['5', 0] } },
    '15': { class_type: 'CreateVideo', inputs: { images: ['13', 0], audio: ['14', 0], fps: 24, bit_depth: 8 } },
    '16': { class_type: 'SaveVideo', inputs: { video: ['15', 0], filename_prefix: 'video/H3Studio', format: 'auto', codec: 'auto' } },
  }
  if (imageName) {
    graph['6'] = { class_type: 'LoadImage', inputs: { image: imageName } }
    graph['7'].inputs.first_frame = ['6', 0]
  }
  return graph
}

async function uploadComfyImage(dataUrl) {
  const match = String(dataUrl).match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
  if (!match) throw new Error('参考图格式无效')
  const mime = match[1]
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
  const form = new FormData()
  form.append('image', new Blob([Buffer.from(match[2], 'base64')], { type: mime }), `h3-ref.${ext}`)
  form.append('overwrite', 'true')
  const response = await fetch(`${comfyUrl}/upload/image`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) })
  const data = await response.json()
  if (!response.ok || !data?.name) throw new Error(data?.error || '参考图上传到 ComfyUI 失败')
  return data.name
}

function collectVideos(outputs = {}) {
  const files = []
  for (const node of Object.values(outputs)) {
    for (const key of ['videos', 'gifs', 'images', 'files']) {
      for (const item of node?.[key] || []) {
        if (item?.filename) files.push(item)
      }
    }
  }
  return files
}

function resolveComfyFile(file) {
  const kind = file.type === 'temp' ? 'temp' : 'output'
  return path.join(comfyRoot, kind, file.subfolder || '', file.filename)
}

async function harvestLocalTask(task) {
  const history = await comfyJson(`/history/${encodeURIComponent(task.id)}`)
  const entry = history?.[task.id]
  if (!entry) {
    const queue = await comfyJson('/queue')
    const running = (queue.queue_running || []).some((item) => item?.[1] === task.id)
    const pending = (queue.queue_pending || []).some((item) => item?.[1] === task.id)
    if (running) task.status = 'Processing'
    else if (pending) task.status = 'Queueing'
    else {
      task.status = 'Fail'
      task.error = '任务已离开 ComfyUI 队列且没有成片（可能被中断）'
    }
    task.updatedAt = new Date().toISOString()
    return upsertTask(task)
  }
  const messages = JSON.stringify(entry.status?.messages || [])
  if (entry.status?.status_str === 'error') {
    task.status = 'Fail'
    task.error = messages.slice(0, 500)
    task.updatedAt = new Date().toISOString()
    return upsertTask(task)
  }
  const videos = collectVideos(entry.outputs)
  const video = videos.find((item) => /\.(mp4|webm|mkv)$/i.test(item.filename)) || videos[0]
  if (video) {
    const source = resolveComfyFile(video)
    const filename = `h3-${task.id.slice(0, 8)}.mp4`
    const dest = path.join(localDir, filename)
    if (fs.existsSync(source) && !fs.existsSync(dest)) fs.copyFileSync(source, dest)
    if (fs.existsSync(dest)) {
      task.status = 'Success'
      task.filename = filename
      task.comfyFile = video
    }
  } else if (entry.status?.completed) {
    task.status = 'Fail'
    task.error = 'ComfyUI 未返回视频文件'
  } else {
    task.status = 'Processing'
  }
  task.updatedAt = new Date().toISOString()
  return upsertTask(task)
}

app.get('/api/status', async (_req, res) => {
  const models = listH3Models()
  const result = {
    m3: Boolean(apiKey),
    comfy: false,
    quota: { used: 0, total: 0, weeklyUsed: 0, weeklyTotal: 0 },
    model: textModel,
    models: { ready: models.every((item) => item.present), files: models.map(({ id, file, present }) => ({ id, file, present })) },
  }
  try {
    const quota = await miniFetch('https://www.minimaxi.com/v1/token_plan/remains')
    const video = quota.model_remains?.find((item) => item.model_name === 'video')
    if (video) result.quota = {
      used: video.current_interval_usage_count,
      total: video.current_interval_total_count,
      weeklyUsed: video.current_weekly_usage_count,
      weeklyTotal: video.current_weekly_total_count,
      resetMs: video.remains_time,
    }
  } catch (error) { result.m3Error = error.message }
  result.comfy = await comfyOk()
  res.json(result)
})

app.post('/api/storyboard', async (req, res) => {
  try {
    const { idea, aspect = '16:9', totalDuration = 18, engine = 'cloud' } = req.body
    if (!idea?.trim()) return res.status(400).json({ error: '请先描述想拍的内容' })
    const count = Math.max(1, Math.ceil(Number(totalDuration) / 6))
    const prompt = `你是专业短视频导演。把用户需求拆为 ${count} 个连续镜头，每个恰好6秒，画幅${aspect}，引擎${engine === 'cloud' ? 'MiniMax-Hailuo-2.3' : '本地MiniMax-H3'}。保持人物和宠物外观、服装、环境连续。每个video_prompt必须可独立提交视频模型，写清主体、动作、环境、镜头、光线和音频，避免复杂快速动作。只返回JSON，不要解释：{"title":"片名","summary":"一句话创意","shots":[{"title":"镜头1","description":"中文概述","video_prompt":"可直接生成视频的详细提示词"}]}。用户需求：${idea}`
    const data = await miniFetch(`${apiHost}/v1/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 3000, temperature: 0.4 }),
    })
    const content = data.choices?.[0]?.message?.content || ''
    const plan = extractJson(content)
    plan.shots = (plan.shots || []).slice(0, count).map((shot, index) => ({ ...shot, id: crypto.randomUUID(), index, status: 'ready' }))
    res.json(plan)
  } catch (error) { res.status(502).json({ error: error.message }) }
})

app.post('/api/cloud/generate', async (req, res) => {
  try {
    const { prompt, firstFrame, model = 'MiniMax-Hailuo-2.3' } = req.body
    const payload = { model, prompt, duration: 6, resolution: '768P', aigc_watermark: false }
    if (firstFrame) payload.first_frame_image = firstFrame
    const data = await miniFetch(`${apiHost}/v1/video_generation`, { method: 'POST', body: JSON.stringify(payload) })
    const task = upsertTask({ id: data.task_id, engine: 'cloud', prompt, model, status: 'Queueing', createdAt: new Date().toISOString() })
    res.json(task)
  } catch (error) { res.status(502).json({ error: error.message }) }
})

app.post('/api/local/generate', async (req, res) => {
  try {
    const { prompt, firstFrame, aspect = '16:9', duration = 6 } = req.body
    if (!prompt?.trim()) return res.status(400).json({ error: '缺少镜头提示词' })
    if (!await comfyOk()) return res.status(503).json({ error: 'ComfyUI 未连接，请先启动本地 H3' })
    const missing = listH3Models().filter((item) => !item.present)
    if (missing.length) return res.status(409).json({ error: `缺少模型文件：${missing.map((item) => item.file).join(', ')}` })
    const [width, height] = h3Size(aspect)
    const length = h3Length(duration)
    const imageName = firstFrame ? await uploadComfyImage(firstFrame) : undefined
    const seed = Number(String(Date.now()).slice(-9))
    const promptGraph = buildH3Prompt({ prompt, width, height, length, imageName, seed })
    const submitted = await comfyJson('/prompt', {
      method: 'POST',
      body: JSON.stringify({ prompt: promptGraph, client_id: 'xinghui-studio' }),
    })
    if (submitted.node_errors && Object.keys(submitted.node_errors).length) {
      throw new Error(`工作流节点错误：${JSON.stringify(submitted.node_errors).slice(0, 800)}`)
    }
    const task = upsertTask({
      id: submitted.prompt_id,
      engine: 'local',
      prompt,
      model: 'MiniMax-H3-local',
      status: 'Queueing',
      aspect,
      width,
      height,
      length,
      seed,
      createdAt: new Date().toISOString(),
    })
    res.json(task)
  } catch (error) { res.status(502).json({ error: error.message }) }
})

async function downloadResult(fileId, taskId) {
  const data = await miniFetch(`${apiHost}/v1/files/retrieve?file_id=${encodeURIComponent(fileId)}`)
  const url = data.file?.download_url
  if (!url) throw new Error('视频下载地址为空')
  const response = await fetch(url)
  if (!response.ok) throw new Error(`下载视频失败 ${response.status}`)
  const filename = `hailuo-${taskId}.mp4`
  fs.writeFileSync(path.join(outputDir, filename), Buffer.from(await response.arrayBuffer()))
  return filename
}

async function refreshCloudTask(id) {
  const data = await miniFetch(`${apiHost}/v1/query/video_generation?task_id=${encodeURIComponent(id)}`)
  const tasks = readTasks()
  const task = tasks.find((item) => item.id === id) || { id, engine: 'cloud' }
  task.status = data.status
  task.fileId = data.file_id || task.fileId
  if (data.status === 'Success' && !task.filename) task.filename = await downloadResult(data.file_id, task.id)
  task.updatedAt = new Date().toISOString()
  return upsertTask(task)
}

app.get('/api/cloud/task/:id', async (req, res) => {
  try { res.json(await refreshCloudTask(req.params.id)) }
  catch (error) { res.status(502).json({ error: error.message }) }
})

app.get('/api/local/task/:id', async (req, res) => {
  try {
    const task = readTasks().find((item) => item.id === req.params.id)
    if (!task) return res.status(404).json({ error: '本地任务不存在' })
    res.json(await harvestLocalTask(task))
  } catch (error) { res.status(502).json({ error: error.message }) }
})

app.get('/api/task/:id', async (req, res) => {
  try {
    const existing = readTasks().find((item) => item.id === req.params.id)
    if (existing?.engine === 'local') return res.json(await harvestLocalTask(existing))
    res.json(await refreshCloudTask(req.params.id))
  } catch (error) { res.status(502).json({ error: error.message }) }
})

app.get('/api/tasks', (_req, res) => res.json(readTasks()))

app.post('/api/merge', async (req, res) => {
  try {
    const files = (req.body.files || []).map((name) => {
      const base = path.basename(name)
      const cloud = path.join(outputDir, base)
      const local = path.join(localDir, base)
      return fs.existsSync(cloud) ? cloud : local
    }).filter(fs.existsSync)
    if (!ffmpegPath || files.length < 2) throw new Error('至少需要两个已完成视频')
    const list = path.join(outputDir, `merge-${Date.now()}.txt`)
    fs.writeFileSync(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'))
    const output = `final-${Date.now()}.mp4`
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(outputDir, output)])
      let error = ''; child.stderr.on('data', (chunk) => { error += chunk })
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error.slice(-1200))))
    })
    fs.unlinkSync(list)
    res.json({ filename: output, url: `/media/${output}` })
  } catch (error) { res.status(400).json({ error: error.message }) }
})

async function makeStoryboard(project) {
  const idea = project.idea?.trim()
  if (!idea) throw new Error('还不知道要拍什么')
  const count = Math.max(1, Math.ceil(Number(project.duration || 18) / 6))
  const prompt = `你是专业短视频导演。把用户需求拆为 ${count} 个连续镜头，每个恰好6秒，画幅${project.aspect || '16:9'}。保持人物外观、服装、环境连续。每个video_prompt必须可独立生成视频，写清主体、动作、环境、镜头、光线和音频，避免复杂快速动作。只返回JSON：{"title":"片名","summary":"一句话创意","shots":[{"title":"镜头1","description":"中文概述","video_prompt":"可直接生成视频的详细提示词"}]}。用户需求：${idea}`
  const data = await miniFetch(`${apiHost}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 3000, temperature: 0.4 }),
  })
  let plan
  try {
    plan = extractJson(data.choices?.[0]?.message?.content || '')
  } catch {
    const retry = await miniFetch(`${apiHost}/v1/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt + '\n请只返回JSON对象，不要解释。' }], max_tokens: 3000, temperature: 0.2 }),
    })
    plan = extractJson(retry.choices?.[0]?.message?.content || '')
  }
  const previous = project.shots || []
  project.title = plan.title || project.title
  project.summary = plan.summary || project.summary
  project.shots = (plan.shots || []).slice(0, count).map((shot, index) => ({
    id: previous[index]?.id || crypto.randomUUID(),
    index,
    title: shot.title,
    description: shot.description,
    video_prompt: shot.video_prompt,
    status: 'ready',
    imageFile: previous[index]?.imageFile || (index === 0 ? project.pendingImage : '') || '',
  }))
  if (project.pendingImage) project.pendingImage = ''
  return project
}

async function rewriteShot(project, shotNo, instruction) {
  const shot = project.shots.find((item) => item.index === shotNo - 1)
  if (!shot) throw new Error(`没有第 ${shotNo} 镜`)
  const prompt = `只改这一镜的视频提示词，保持人物外观和前后镜头连续。原标题:${shot.title}。原描述:${shot.description}。原提示词:${shot.video_prompt}。修改要求:${instruction}。只返回JSON：{"title":"...","description":"...","video_prompt":"..."}`
  const data = await miniFetch(`${apiHost}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 1200, temperature: 0.4 }),
  })
  const next = extractJson(data.choices?.[0]?.message?.content || '')
  shot.title = next.title || shot.title
  shot.description = next.description || shot.description
  shot.video_prompt = next.video_prompt || shot.video_prompt
  shot.status = 'ready'
  shot.taskId = ''
  shot.filename = ''
  return shot
}

async function startLocalShot(project, shot) {
  if (!await comfyOk()) throw new Error('本机生成服务未连接，请先打开星绘工坊启动脚本')
  const missing = listH3Models().filter((item) => !item.present)
  if (missing.length) throw new Error('本机模型文件不完整')
  const [width, height] = h3Size(project.aspect)
  const firstFrame = shot.imageFile ? store.imageDataUrl(project.id, shot.imageFile) : ''
  const imageName = firstFrame ? await uploadComfyImage(firstFrame) : undefined
  const seed = Number(String(Date.now()).slice(-9))
  const submitted = await comfyJson('/prompt', {
    method: 'POST',
    body: JSON.stringify({ prompt: buildH3Prompt({ prompt: shot.video_prompt, width, height, length: h3Length(6), imageName, seed }), client_id: 'xinghui-studio' }),
  })
  if (submitted.node_errors && Object.keys(submitted.node_errors).length) {
    throw new Error('生成任务提交失败')
  }
  const task = upsertTask({
    id: submitted.prompt_id, engine: 'local', prompt: shot.video_prompt, model: 'MiniMax-H3-local',
    status: 'Queueing', aspect: project.aspect, projectId: project.id, shotId: shot.id, createdAt: new Date().toISOString(),
  })
  shot.taskId = task.id
  shot.status = task.status
  return task
}

async function startCloudShot(project, shot) {
  const payload = { model: 'MiniMax-Hailuo-2.3', prompt: shot.video_prompt, duration: 6, resolution: '768P', aigc_watermark: false }
  const firstFrame = shot.imageFile ? store.imageDataUrl(project.id, shot.imageFile) : ''
  if (firstFrame) payload.first_frame_image = firstFrame
  const data = await miniFetch(`${apiHost}/v1/video_generation`, { method: 'POST', body: JSON.stringify(payload) })
  const task = upsertTask({ id: data.task_id, engine: 'cloud', prompt: shot.video_prompt, model: 'MiniMax-Hailuo-2.3', status: 'Queueing', projectId: project.id, shotId: shot.id, createdAt: new Date().toISOString() })
  shot.taskId = task.id
  shot.status = task.status
  return task
}

async function mergeProject(project) {
  const files = (project.shots || []).map((shot) => {
    const base = shot.filename && path.basename(shot.filename)
    if (!base) return ''
    const cloud = path.join(outputDir, base)
    const local = path.join(localDir, base)
    return fs.existsSync(cloud) ? cloud : local
  }).filter(fs.existsSync)
  if (!ffmpegPath || files.length < 2) throw new Error('至少需要两个已完成镜头才能合并')
  const list = path.join(outputDir, `merge-${Date.now()}.txt`)
  fs.writeFileSync(list, files.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join('\n'))
  const output = `final-${Date.now()}.mp4`
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(outputDir, output)])
    let error = ''; child.stderr.on('data', (chunk) => { error += chunk })
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error.slice(-1200))))
  })
  fs.unlinkSync(list)
  project.finalFilename = output
  project.finalUrl = `/media/${output}`
  return project
}

async function refreshProject(project) {
  let changed = false
  for (const shot of project.shots || []) {
    if (!shot.taskId || ['Success', 'Fail'].includes(shot.status)) continue
    const task = readTasks().find((item) => item.id === shot.taskId)
    if (!task) continue
    const next = task.engine === 'local' ? await harvestLocalTask(task) : await refreshCloudTask(task.id)
    if (next.status !== shot.status || next.filename !== shot.filename) changed = true
    shot.status = next.status
    shot.filename = next.filename || shot.filename
  }
  const ready = (project.shots || []).length >= 2 && (project.shots || []).every((shot) => shot.status === 'Success' && shot.filename)
  if (ready && !project.finalUrl) {
    try { await mergeProject(project); changed = true } catch {}
  }
  if (changed) store.save(project)
  return project
}

async function applyActions(project, actions, notes) {
  for (const action of actions || []) {
    const op = action.op || action.type
    if (op === 'update_brief') {
      if (action.idea) project.idea = action.idea
      if (action.aspect) project.aspect = action.aspect
      if (action.duration) project.duration = Number(action.duration)
      if (action.engine) project.engine = action.engine
      if (action.title) project.title = action.title
    } else if (op === 'create_storyboard') {
      await makeStoryboard(project)
      notes.push('已写好分镜')
    } else if (op === 'rewrite_shot') {
      await rewriteShot(project, Number(action.shot || action.index), action.instruction || '')
      notes.push(`已改第 ${action.shot} 镜`)
    } else if (op === 'generate') {
      const targets = resolveShotList(action.shots, project)
      if (!targets.length) notes.push('没有需要生成的镜头')
      for (const shot of targets) {
        if (project.engine === 'cloud') await startCloudShot(project, shot)
        else await startLocalShot(project, shot)
      }
      if (targets.length) notes.push(project.engine === 'cloud' ? `已提交 ${targets.length} 个云端镜头` : `已开始生成 ${targets.length} 个镜头`)
    } else if (op === 'merge') {
      await mergeProject(project)
      notes.push('已合并成片')
    }
  }
  return project
}

app.get('/api/projects', (_req, res) => res.json(store.list().map((item) => ({ ...item, messages: undefined }))))
app.post('/api/projects', (_req, res) => res.json(store.create()))
app.get('/api/projects/current', async (_req, res) => {
  try { res.json(await refreshProject(store.latest())) }
  catch (error) { res.status(502).json({ error: error.message }) }
})
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = store.load(req.params.id)
    if (!project) return res.status(404).json({ error: '项目不存在' })
    res.json(await refreshProject(project))
  } catch (error) { res.status(502).json({ error: error.message }) }
})
app.get('/api/projects/:id/media/:file', (req, res) => {
  const full = store.imagePath(req.params.id, req.params.file)
  if (!fs.existsSync(full)) return res.status(404).end()
  res.sendFile(full)
})
app.post('/api/projects/:id/shots/:index/image', (req, res) => {
  try {
    const project = store.load(req.params.id)
    if (!project) return res.status(404).json({ error: '项目不存在' })
    const shot = project.shots.find((item) => item.index === Number(req.params.index))
    if (!shot) return res.status(404).json({ error: '镜头不存在' })
    shot.imageFile = store.saveImage(project.id, req.body.image, `s${shot.index + 1}`)
    store.save(project)
    res.json(project)
  } catch (error) { res.status(400).json({ error: error.message }) }
})
app.post('/api/projects/:id/chat', async (req, res) => {
  try {
    const project = store.load(req.params.id) || store.latest()
    const text = String(req.body.message || '').trim()
    const image = req.body.image
    if (!text && !image) return res.status(400).json({ error: '请先说想拍什么' })
    if (image) {
      const pending = (project.shots || []).find((item) => !item.imageFile) || project.shots?.[0]
      if (pending) pending.imageFile = store.saveImage(project.id, image, `s${(pending.index || 0) + 1}`)
      else project.pendingImage = store.saveImage(project.id, image, 'pending')
    }
    project.messages = project.messages || []
    project.messages.push({ role: 'user', content: text, ts: new Date().toISOString() })
    if (!project.idea && text) project.idea = text
    const history = project.messages.slice(-12).map((item) => ({ role: item.role === 'assistant' ? 'assistant' : 'user', content: item.content }))
    const data = await miniFetch(`${apiHost}/v1/chat/completions`, {
      method: 'POST',
      body: JSON.stringify({
        model: textModel,
        temperature: 0.3,
        max_tokens: 1800,
        messages: [
          { role: 'system', content: DIRECTOR_SYSTEM },
          { role: 'system', content: `当前项目：${JSON.stringify(snapshotForDirector(project))}` },
          ...history,
        ],
      }),
    })
    const parsed = parseDirectorReply(data.choices?.[0]?.message?.content || '')
    const notes = []
    try {
      await applyActions(project, parsed.actions, notes)
    } catch (actionError) {
      notes.push(actionError.message)
    }
    const reply = [parsed.say, notes.length ? notes.join('。') + '。' : ''].filter(Boolean).join('\n')
    project.messages.push({ role: 'assistant', content: reply, ts: new Date().toISOString() })
    store.save(project)
    res.json(project)
  } catch (error) { res.status(502).json({ error: error.message }) }
})

app.get('/api/local/open', (_req, res) => res.json({ url: comfyUrl, workflow: 'MiniMax_H3_FL2V_GGUF' }))
app.post('/api/output/open', (_req, res) => {
  const folder = path.join(root, 'outputs')
  if (process.platform === 'win32') {
    const child = spawn('explorer.exe', [folder], { detached: true, stdio: 'ignore' })
    child.unref()
  }
  res.json({ path: folder })
})

const dist = path.join(here, 'dist')
if (fs.existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/.*/, (_req, res) => res.sendFile(path.join(dist, 'index.html')))
}

app.listen(port, '127.0.0.1', () => console.log(`星绘视频工坊: http://127.0.0.1:${port}`))
