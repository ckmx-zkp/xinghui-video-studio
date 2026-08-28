import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import ffmpegStaticPath from 'ffmpeg-static'
import fs from 'node:fs'
import multer from 'multer'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createProjectStore } from './projects.mjs'
import { briefReadiness, completionText, dedupeDirectorChoices, directorSystemFor, extractJson, parseDirectorReply, resolveShotList, snapshotForDirector } from './director.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
dotenv.config({ path: path.join(root, '.env') })

export const app = express()
const port = Number(process.env.STUDIO_PORT || 4175)
const apiHost = process.env.MINIMAX_API_HOST || 'https://api.minimaxi.com'
const apiKey = process.env.MINIMAX_API_KEY || ''
const textModel = process.env.MINIMAX_TEXT_MODEL || 'MiniMax-M3'
const comfyUrl = process.env.COMFY_URL || 'http://127.0.0.1:8188'
const comfyWsUrl = `${comfyUrl.replace(/^http/i, 'ws')}/ws?clientId=xinghui-studio`
const comfyProgressByTask = new Map()
let currentComfyExecution = null
let comfySocket = null
let comfyReconnectTimer = null
// Keep dialogue and rendering modes independent: a machine without a GPU can
// still use the real director model while only simulating local video output.
export function resolveRuntimeModes(env = process.env) {
  return {
    directorDemoMode: env.STUDIO_DIRECTOR_DEMO_MODE === '1',
    videoDemoMode: env.STUDIO_VIDEO_DEMO_MODE === '1' || env.STUDIO_DEMO_MODE === '1',
  }
}
const { directorDemoMode, videoDemoMode } = resolveRuntimeModes()
const ffmpegPath = process.env.FFMPEG_PATH || ffmpegStaticPath
const comfyRoot = path.join(root, 'ComfyUI_windows_portable', 'ComfyUI')
const outputDir = path.join(root, 'outputs', 'cloud')
const localDir = path.join(root, 'outputs', 'local')
const taskFile = path.join(outputDir, 'tasks.json')
fs.mkdirSync(outputDir, { recursive: true })
fs.mkdirSync(localDir, { recursive: true })
const store = createProjectStore(root)
const BRIEF_KEYS = ['goal', 'audience', 'platform', 'story', 'subject', 'visualStyle', 'tone', 'audio', 'constraints', 'referenceNotes']
const PROJECT_PHASES = new Set(['discovery', 'brief_review', 'concept_selection', 'storyboard_review', 'quality_review', 'ready_to_generate', 'generating', 'delivery_review', 'delivered'])
const SKILLS = new Set(['narrative-film', 'product-ad', 'social-koc', 'knowledge-video', 'custom-video'])

// Natural-language confirmations advance one planning gate. “Direct start” is
// a distinct, explicit command: the director fills reasonable defaults and
// advances to the explicit review gate without turning the conversation into a questionnaire.
export function isAdvanceIntent(value) {
  const text = String(value || '').trim().replace(/[，。！？、,.!？\s]+/g, '')
  return /(?:确认|继续|下一步|开拍|开干|直接开始|开始制作(?:视频)?|直接制作|直接做|开始生成|开始做|开始吧|做吧|生成吧)$/u.test(text)
    || /^(?:好|好的|可以|行|没问题|就这样|就按这个)$/u.test(text)
}

export function isDirectStartIntent(value) {
  const text = String(value || '').trim().replace(/[，。！？、,.!？\s]+/g, '')
  if (/(?:不要|不能|暂不|先不|别|不想).*?(?:开拍|开始制作|开始生成|直接开始|直接制作|直接做)/u.test(text)) return false
  return /(?:直接开始(?:制作|生成)?(?:视频)?|直接制作(?:视频)?|直接做(?:视频)?|立即开始(?:制作|生成)?|现在开始(?:制作|生成)?|开拍)/u.test(text)
}

function isShortAdvanceIntent(value) {
  const text = String(value || '').trim().replace(/[，。！？、,.!？\s]+/g, '')
  return /^(?:好|好的|可以|行|没问题|就这样|就按这个|确认|继续|下一步|开拍|开干|直接开始|开始制作|直接制作|直接做|开始生成|开始做|开始吧|做吧|生成吧)$/u.test(text)
}

function projectOr404(id) {
  const project = store.load(id)
  if (!project) {
    const error = new Error('项目不存在')
    error.status = 404
    throw error
  }
  return project
}

// store.save() normalizes into a fresh object, so callers keep their pre-save
// snapshot. Any mutation that moves the brief versions must refresh the stale
// flag on the caller's object right away.
function markBriefStale(project) {
  project.briefStale = (project.shots?.length || 0) > 0 && Number(project.briefVersion || 0) !== Number(project.storyboardBriefVersion || 0)
}

function applyBriefPatch(project, action) {
  const patch = action.brief && typeof action.brief === 'object' ? action.brief : {}
  project.creativeBrief = project.creativeBrief || {}
  const changed = []
  for (const key of BRIEF_KEYS) {
    if (typeof patch[key] !== 'string' || !patch[key].trim()) continue
    const value = patch[key].trim().slice(0, 2000)
    if (project.creativeBrief[key] !== value) changed.push(key)
    project.creativeBrief[key] = value
  }
  if (typeof action.title === 'string' && action.title.trim()) {
    const value = action.title.trim().slice(0, 120)
    if (project.title !== value) changed.push('title')
    project.title = value
  }
  if (['16:9', '9:16', '1:1'].includes(action.aspect)) {
    if (project.aspect !== action.aspect) changed.push('aspect')
    project.aspect = action.aspect
  }
  const duration = Number(action.duration)
  if (Number.isInteger(duration) && duration >= 5 && duration <= 60) {
    if (project.duration !== duration) changed.push('duration')
    project.duration = duration
  }
  if (['local', 'cloud'].includes(action.engine)) {
    if (project.engine !== action.engine) changed.push('engine')
    project.engine = action.engine
  }
  if (SKILLS.has(action.skill)) {
    if (project.skill !== action.skill) changed.push('skill')
    project.skill = action.skill
  }
  if (project.creativeBrief.goal) project.idea = project.creativeBrief.goal
  if (changed.length) {
    project.briefVersion = Number(project.briefVersion || 0) + 1
    markBriefStale(project)
  }
  return changed
}

function normalizeChoices(values) {
  return (Array.isArray(values) ? values : []).slice(0, 4).map((item) => ({
    id: crypto.randomUUID(),
    label: String(item?.label || '').trim().slice(0, 80),
    description: String(item?.description || '').trim().slice(0, 300),
    reply: String(item?.reply || item?.label || '').trim().slice(0, 500),
  })).filter((item) => item.label && item.reply)
}

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

const referenceUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, callback) => {
    if (!file.mimetype?.startsWith('image/')) return callback(new Error('请选择图片文件'))
    callback(null, true)
  },
})

function receiveReferenceImage(req, res, next) {
  referenceUpload.single('image')(req, res, (error) => {
    if (!error) return next()
    const tooLarge = error.code === 'LIMIT_FILE_SIZE'
    res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? '参考图不能超过20MB' : error.message })
  })
}

function imageAttachment(projectId, filename, mime = '') {
  return {
    id: filename,
    filename,
    type: 'image',
    mime,
    url: `/api/projects/${projectId}/media/${encodeURIComponent(filename)}`,
  }
}

export function historyForDirector(messages, currentImageUrls = []) {
  const history = (messages || []).slice(-16).map((item) => ({
    role: item.role === 'assistant' ? 'assistant' : 'user',
    content: item.content,
  }))
  if (currentImageUrls.length && history.at(-1)?.role === 'user') {
    history[history.length - 1].content = [
      { type: 'text', text: String(history.at(-1).content || '请分析这张参考图，并结合图片继续创作访谈。') },
      ...currentImageUrls.slice(0, 4).map((url) => ({ type: 'image_url', image_url: { url } })),
    ]
  }
  return history
}

const authHeaders = () => ({ Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' })

function demoCompletion(options = {}) {
  const body = JSON.parse(options.body || '{}')
  const messages = body.messages || []
  const prompt = String(messages.at(-1)?.content || '')
  const system = messages.filter((item) => item.role === 'system').map((item) => item.content).join('\n')
  let result
  if (prompt.includes('文字创作总监')) {
    result = {
      artifacts: [
        { type: 'director_treatment', title: '导演阐述', summary: '明确核心表达和观众体验', content: { premise: '从用户熟悉的真实处境切入，以一次清晰变化建立主题价值。', approach: '减少解释，用动作、空间和声音的前后反差推动叙事。', audiencePromise: '观众能在前几秒理解处境，并在结尾记住核心价值。' } },
        { type: 'script', title: '完整脚本', summary: '首版画面、旁白与字幕结构', content: { timeline: ['0-6秒：建立主体和现实处境，快速呈现问题。', '6-12秒：通过一个可见动作触发变化，让核心价值自然出现。', '12-18秒：减少画面信息，在明确动作或品牌落点上收束。'], opening: '建立主体和现实处境，快速呈现问题。', development: '通过一个可见动作触发变化，让核心价值自然出现。', ending: '减少画面信息，在明确动作或品牌落点上收束。', voiceover: '旁白保持简短，只补充画面无法表达的信息。', captions: '字幕使用短句，核心信息一次只出现一条。' } },
        { type: 'visual_guide', title: '视听说明', summary: '统一画面、镜头和声音语言', content: { subject: '主体外观、服装和关键道具保持连续。', scenes: '场景从现实状态过渡到更清晰有序的状态。', camera: '以稳定运动和明确景别变化为主。', colorLight: '真实光线，转折后适度提升层次与通透感。', sound: '环境音建立处境，转折处用简洁声音提示变化。' } },
        { type: 'production_notes', title: '制作说明', summary: '记录默认判断、风险和修改入口', content: { assumptions: ['未指定项由导演按短视频可看性和模型可执行性决定'], risks: ['复杂群体动作和画面内小字可能降低生成稳定性'], nextRevision: '可直接用自然语言修改旁白、节奏、主体、场景或视觉风格。' } },
      ],
    }
  } else if (prompt.includes('资深创意制片人')) {
    result = {
      insight: '这个项目最有价值的突破口，是先用一个清晰的情绪变化抓住观众，再让产品或人物自然成为变化的原因。',
      tasks: [
        { title: '创意定调', purpose: '统一目标与表达', deliverable: '确认的创意方向', owner: '导演' },
        { title: '镜头设计', purpose: '把叙事拆成可执行画面', deliverable: '连续分镜与提示词', owner: '画面' },
        { title: '声音与节奏', purpose: '强化情绪变化', deliverable: '声音设计方案', owner: '声音' },
        { title: '生成与合成', purpose: '完成镜头并检查连续性', deliverable: '可评审成片', owner: '剪辑' },
      ],
      concepts: [
        { title: '现实共鸣', logline: '从一个熟悉的真实困境进入，让变化自然发生。', narrative: '问题、转折、解决', visualHook: '环境从拥挤杂乱逐步变得克制清晰', ending: '在一个安静有力的动作上收束' },
        { title: '视觉隐喻', logline: '把核心价值转化成一个贯穿全片的视觉符号。', narrative: '符号出现、扩散、完成转化', visualHook: '光线与空间随人物情绪改变', ending: '符号凝聚为最终记忆点' },
        { title: '悬念反转', logline: '先隐藏真正主题，在最后一镜完成意义反转。', narrative: '悬念、线索、揭晓', visualHook: '局部特写与受限视角', ending: '拉远揭示完整场景' },
      ],
    }
  } else if (prompt.includes('专业短视频导演') && prompt.includes('选定方向')) {
    const count = Number(prompt.match(/拆成 (\d+) 个/)?.[1] || 3)
    result = {
      title: '演示创作项目',
      summary: '用连续的情绪变化完成一支有明确记忆点的短片。',
      insight: '前两镜应快速建立问题与变化，最后一镜减少信息量，把空间留给品牌或主题落点。',
      choices: [
        { label: '情绪更强', description: '加强前后反差与人物反应', reply: '请让整体情绪反差更强，并保持镜头连续。' },
        { label: '节奏更快', description: '更早出现核心转折', reply: '请把核心转折提前，让前两镜节奏更紧凑。' },
        { label: '画面更克制', description: '减少元素，突出主体', reply: '请减少环境元素，用更克制的镜头突出主体。' },
      ],
      shots: Array.from({ length: count }, (_, index) => ({
        title: `镜头 ${index + 1}`,
        description: index === 0 ? '建立人物与现实处境。' : index === count - 1 ? '完成情绪落点并留下主题记忆。' : '用动作和空间变化推动转折。',
        video_prompt: `连续短片第 ${index + 1} 镜，保持同一主体外观与环境连续，真实摄影质感，清晰动作，稳定镜头运动，自然环境音。`,
      })),
    }
  } else if (prompt.includes('质量审核导演')) {
    result = {
      score: 86,
      verdict: 'pass',
      summary: '叙事目标明确，镜头数量与时长匹配，主体连续性描述完整；正式生成前仍应重点观察动作衔接。',
      checks: [
        { label: '目标一致性', status: 'pass', note: '分镜围绕同一情绪变化展开。' },
        { label: '镜头可执行性', status: 'pass', note: '每镜动作单一，适合视频模型执行。' },
        { label: '连续性', status: 'warning', note: '生成后需复核服装、光线和空间方向。' },
      ],
      recommendations: ['参考图尽量使用同一主体与服装', '生成后优先检查相邻镜头的动作方向'],
    }
  } else if (prompt.includes('只修改这一镜')) {
    result = { title: '调整后的镜头', description: '按用户选择强化画面表达。', video_prompt: `根据修改要求调整：${prompt.slice(-180)}` }
  } else {
    const phase = system.match(/当前阶段：([^\n]+)/)?.[1]?.trim() || 'discovery'
    const lastUser = String(messages.filter((item) => item.role === 'user').at(-1)?.content || '这支视频')
    let snapshot = {}
    try { snapshot = JSON.parse(system.match(/当前项目：(\{.*\})/s)?.[1] || '{}') } catch {}
    const originalGoal = snapshot.creativeBrief?.goal || snapshot.idea || lastUser
    const firstDiscoveryTurn = phase === 'discovery' && Number(snapshot.discoveryTurns || 0) <= 1
    const brief = {
      goal: String(originalGoal).slice(0, 300), audience: '希望快速理解主题的短视频观众', platform: '短视频平台',
      story: '从现实问题进入，通过清晰转折完成情绪与主题落点', subject: '一个具有明确外观和行动目标的核心主体',
      visualStyle: '真实摄影、克制构图、连续光线', tone: '先建立张力，再逐步释放', audio: '环境音推动节奏，结尾使用简洁音乐落点',
      constraints: '避免复杂群体动作和画面内文字', referenceNotes: '演示模式使用通用参考策略',
    }
    result = {
      say: firstDiscoveryTurn ? '我已经按专业默认值形成了初步方向。现在只需要确定最影响成片的一点：你更希望观众被真实处境打动，还是先感受到鲜明的视觉风格？' : phase === 'discovery' ? '关键方向已经明确，我会直接补齐其余判断并形成可修改方案。' : '我已经根据你的要求更新当前方案。',
      insight: '当前需求最需要先锁定的是观众感受到的变化，而不是堆叠更多画面元素。',
      question: firstDiscoveryTurn ? { key: 'primary_expression', text: '你更希望观众被真实处境打动，还是先感受到鲜明的视觉风格？', importance: '这会改变脚本入口和镜头语言。' } : null,
      choices: [
        { label: '真实共鸣', description: '更自然、更容易让观众代入', reply: '选择真实共鸣，用生活化情境表达。' },
        { label: '电影质感', description: '更强调光影、构图和仪式感', reply: '选择电影质感，强化光影和镜头调度。' },
        { label: '轻快直接', description: '信息更快，适合短视频节奏', reply: '选择轻快直接，尽快进入核心转折。' },
      ],
      actions: phase === 'discovery' ? [{ op: 'update_brief', brief, skill: 'custom-video', title: '演示创作项目' }, ...(!firstDiscoveryTurn ? [{ op: 'present_brief' }] : [])] : [],
    }
  }
  return { choices: [{ message: { content: JSON.stringify(result) } }] }
}
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
  if (directorDemoMode) {
    if (url.includes('/chat/completions')) return demoCompletion(options)
  }
  if (!apiKey) throw new Error('MINIMAX_API_KEY 尚未配置')
  const response = await fetch(url, {
    ...options,
    headers: { ...authHeaders(), ...(options.headers || {}) },
    signal: options.signal || AbortSignal.timeout(90000),
  })
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
    '2': { class_type: 'MiniMaxH3TurboLoRA', inputs: { model: ['1', 0], lora_name: 'minimax_h3_turbo_v4_step600_ema.safetensors', strength: 1, low_vram: false } },
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

async function uploadComfyImage(dataUrl, prefix = 'reference') {
  const match = String(dataUrl).match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
  if (!match) throw new Error('参考图格式无效')
  const mime = match[1]
  const ext = mime.includes('png') ? 'png' : mime.includes('webp') ? 'webp' : 'jpg'
  const form = new FormData()
  const safePrefix = String(prefix).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'reference'
  form.append('image', new Blob([Buffer.from(match[2], 'base64')], { type: mime }), `${safePrefix}-${crypto.randomUUID()}.${ext}`)
  form.append('overwrite', 'false')
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

// H3's sampler does not consistently publish a step counter on AMD/Windows.
// Keep the range explicit: this is a stage estimate, never a fake percentage.
export function comfyStageForNode(node) {
  const number = Number(node)
  if (!Number.isFinite(number)) return { key: 'working', label: '正在执行工作流', min: 0, max: 99 }
  if (number <= 5) return { key: 'loading', label: '加载模型与编码提示词', min: 1, max: 9 }
  if (number <= 11) return { key: 'prepare', label: '准备采样参数', min: 9, max: 12 }
  if (number === 12) return { key: 'sampling', label: '采样生成视频帧', min: 12, max: 85 }
  if (number <= 14) return { key: 'decode', label: '解码视频与音频', min: 85, max: 96 }
  if (number <= 16) return { key: 'saving', label: '封装并保存成片', min: 96, max: 99 }
  return { key: 'working', label: '正在完成工作流', min: 0, max: 99 }
}

function recordComfyEvent(message) {
  const data = message?.data || {}
  const taskId = data.prompt_id || data.promptId
  if (message?.type === 'executing') {
    if (data.node === null) currentComfyExecution = null
    else if (data.node !== undefined) {
      const progress = { node: String(data.node), updatedAt: new Date().toISOString() }
      currentComfyExecution = { ...progress, taskId }
      if (taskId) comfyProgressByTask.set(taskId, progress)
    }
    return
  }
  if (message?.type === 'progress') {
    const progress = {
      node: data.node === undefined ? undefined : String(data.node),
      value: Number(data.value),
      max: Number(data.max),
      updatedAt: new Date().toISOString(),
    }
    currentComfyExecution = { ...currentComfyExecution, ...progress, taskId: taskId || currentComfyExecution?.taskId }
    if (taskId) comfyProgressByTask.set(taskId, progress)
    return
  }
  if (['execution_success', 'execution_error', 'execution_interrupted'].includes(message?.type) && taskId) {
    comfyProgressByTask.delete(taskId)
    if (currentComfyExecution?.taskId === taskId) currentComfyExecution = null
  }
}

function scheduleComfyReconnect() {
  if (videoDemoMode || comfyReconnectTimer) return
  comfyReconnectTimer = setTimeout(() => {
    comfyReconnectTimer = null
    startComfyProgressFeed()
  }, 5000)
  comfyReconnectTimer.unref?.()
}

function startComfyProgressFeed() {
  if (videoDemoMode || (comfySocket && comfySocket.readyState < 2) || typeof WebSocket !== 'function') return
  try {
    comfySocket = new WebSocket(comfyWsUrl)
    comfySocket.addEventListener('message', (event) => {
      try { recordComfyEvent(JSON.parse(String(event.data))) } catch { /* Ignore non-JSON Comfy messages. */ }
    })
    comfySocket.addEventListener('close', () => {
      comfySocket = null
      scheduleComfyReconnect()
    })
    comfySocket.addEventListener('error', () => { /* close handler reconnects */ })
  } catch {
    comfySocket = null
    scheduleComfyReconnect()
  }
}

function liveProgressForShot(shot) {
  if (shot.status !== 'Processing') return undefined
  const live = comfyProgressByTask.get(shot.taskId) || currentComfyExecution
  if (!live) return { ...comfyStageForNode(undefined), estimated: true }
  const stage = comfyStageForNode(live.node)
  if (Number.isFinite(live.value) && Number.isFinite(live.max) && live.max > 0) {
    return { ...stage, value: Math.max(0, live.value), max: live.max, exact: true, updatedAt: live.updatedAt }
  }
  return { ...stage, estimated: true, updatedAt: live.updatedAt }
}

function decorateProjectProgress(project) {
  return {
    ...project,
    shots: (project.shots || []).map((shot) => ({ ...shot, generationProgress: liveProgressForShot(shot) })),
  }
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
    m3: Boolean(apiKey) || directorDemoMode,
    demo: directorDemoMode,
    directorMode: directorDemoMode ? 'demo' : apiKey ? 'live' : 'offline',
    videoDemo: videoDemoMode,
    videoMode: videoDemoMode ? 'demo' : 'live',
    comfy: false,
    quota: { used: 0, total: 0, weeklyUsed: 0, weeklyTotal: 0 },
    model: textModel,
    models: { ready: videoDemoMode || models.every((item) => item.present), simulated: videoDemoMode, files: models.map(({ id, file, present }) => ({ id, file, present })) },
  }
  if (apiKey) {
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
  }
  result.comfy = videoDemoMode || await comfyOk()
  res.json(result)
})

app.post(['/api/storyboard', '/api/cloud/generate', '/api/local/generate'], (_req, res) => {
  res.status(410).json({ error: '旧的直达接口已停用，请通过项目创作流程操作' })
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

app.post('/api/merge', (_req, res) => {
  res.status(410).json({ error: '旧的直达接口已停用，请先完成分镜评审' })
})

async function makeConcepts(project) {
  const brief = project.creativeBrief || {}
  const prompt = `你是资深创意制片人。根据已确认的创作简报和当前已生效文字标准，先给出你对本项目创意突破口的专业判断，再拆解一条可执行的制作计划，并提出3个差异明确、都能实际完成的创意方向。用户手动修改过的文字标准优先级最高，不得擅自恢复旧版本。计划应覆盖策划、素材、分镜、生成、声音、合成与审核，但不要加入本项目做不到的事项。创意方向之间应在叙事结构或视觉表达上真正不同，不能只是换标题。只返回JSON：{"insight":"创意判断和依据","tasks":[{"title":"任务名","purpose":"为什么做","deliverable":"交付物","owner":"导演|画面|声音|剪辑"}],"concepts":[{"title":"方向名","logline":"一句话故事","narrative":"叙事方法","visualHook":"核心视觉记忆点","ending":"结尾设计"}]}。使用的创作方法：${project.skill || 'custom-video'}。创作简报：${JSON.stringify({ ...brief, aspect: project.aspect, duration: project.duration, engine: project.engine })}。当前已生效文字标准：${JSON.stringify(currentTextStandards(project))}`
  const data = await miniFetch(`${apiHost}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 6000, temperature: 0.7 }),
  })
  const parsed = extractJson(data.choices?.[0]?.message?.content || '')
  project.stageInsight = String(parsed.insight || '').slice(0, 1000)
  project.stageChoices = []
  const concepts = Array.isArray(parsed.concepts) ? parsed.concepts.slice(0, 3) : []
  if (concepts.length < 2) throw new Error('导演没有给出足够的创意方向，请重试')
  project.concepts = concepts.map((item) => ({
    id: crypto.randomUUID(),
    title: String(item.title || '未命名方向').slice(0, 100),
    logline: String(item.logline || '').slice(0, 500),
    narrative: String(item.narrative || '').slice(0, 1000),
    visualHook: String(item.visualHook || '').slice(0, 1000),
    ending: String(item.ending || '').slice(0, 1000),
  }))
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 10) : []
  project.productionPlan = tasks.map((item, index) => ({
    id: crypto.randomUUID(),
    index,
    title: String(item.title || `制作任务 ${index + 1}`).slice(0, 100),
    purpose: String(item.purpose || '').slice(0, 500),
    deliverable: String(item.deliverable || '').slice(0, 500),
    owner: String(item.owner || '导演').slice(0, 50),
  }))
  project.selectedConceptId = ''
  project.shots = []
  project.finalUrl = ''
  project.finalFilename = ''
  return project.concepts
}

export function storeTextArtifacts(project, drafts, model = textModel) {
  project.textArtifacts = Array.isArray(project.textArtifacts) ? project.textArtifacts : []
  const allowedTypes = new Set(['director_treatment', 'script', 'visual_guide', 'production_notes'])
  const created = []
  for (const draft of Array.isArray(drafts) ? drafts : []) {
    const type = String(draft?.type || '').trim().slice(0, 80)
    if (!allowedTypes.has(type) || !draft?.content || typeof draft.content !== 'object') continue
    const content = Object.fromEntries(Object.entries(draft.content).slice(0, 12).map(([key, value]) => [
      String(key).slice(0, 80),
      Array.isArray(value)
        ? value.slice(0, 12).map((item) => String(item).trim().slice(0, 1000)).filter(Boolean)
        : String(value ?? '').trim().slice(0, 4000),
    ]))
    const previous = [...project.textArtifacts].reverse().find((item) => item.type === type)
    for (const item of project.textArtifacts) if (item.type === type && item.status === 'current') item.status = 'superseded'
    const artifact = {
      id: crypto.randomUUID(),
      type,
      title: String(draft.title || type).trim().slice(0, 100),
      summary: String(draft.summary || '').trim().slice(0, 500),
      version: Number(previous?.version || 0) + 1,
      status: 'current',
      content,
      sourceArtifactIds: previous ? [previous.id] : [],
      model,
      createdAt: new Date().toISOString(),
    }
    project.textArtifacts.push(artifact)
    created.push(artifact)
  }
  project.textArtifacts = project.textArtifacts.slice(-40)
  return created
}

export function currentTextStandards(project) {
  return (Array.isArray(project.textArtifacts) ? project.textArtifacts : [])
    .filter((item) => item.status === 'current')
    .map(({ id, type, title, summary, version, content }) => ({ id, type, title, summary, version, content }))
}

function archiveCurrentRender(project) {
  if (!project.finalUrl && !project.finalFilename) return
  project.previousRenders = Array.isArray(project.previousRenders) ? project.previousRenders : []
  project.previousRenders.push({
    id: crypto.randomUUID(),
    url: project.finalUrl || '',
    filename: project.finalFilename || '',
    deliveredAt: project.deliveredAt || new Date().toISOString(),
  })
}

export function invalidateDownstreamForStandards(project) {
  if (['delivery_review', 'delivered'].includes(project.phase)) archiveCurrentRender(project)
  if (project.phase !== 'discovery') project.phase = 'brief_review'
  project.briefConfirmedAt = ''
  project.storyboardConfirmedAt = ''
  project.concepts = []
  project.selectedConceptId = ''
  project.productionPlan = []
  project.shots = []
  project.qualityReview = null
  project.stageChoices = []
  project.finalUrl = ''
  project.finalFilename = ''
  project.finalError = ''
  project.deliveredAt = ''
  project.storyboardBriefVersion = Number(project.briefVersion || 0)
  markBriefStale(project)
  project.standardRevision = Number(project.standardRevision || 0) + 1
  project.standardUpdatedAt = new Date().toISOString()
  return project
}

async function makeTextPackage(project, revisionInstruction = '') {
  const prompt = `你是商业短视频项目的文字创作总监。根据当前创作简报，直接完成一套可供用户修改的首版文字方案，不要继续提问，不要生成视频。内容必须具体、有导演判断，避免空泛套话。完整脚本必须按总时长给出timeline数组，每项写明时间段、画面、动作、旁白或字幕，并同时总结开场、发展、结尾、旁白和字幕策略；视听说明必须覆盖主体连续性、场景、镜头、光线色彩和声音。只返回JSON：{"artifacts":[{"type":"director_treatment","title":"导演阐述","summary":"一句话摘要","content":{"premise":"核心表达","approach":"叙事方法","audiencePromise":"观众所得"}},{"type":"script","title":"完整脚本","summary":"一句话摘要","content":{"timeline":["0-6秒：画面、动作、旁白或字幕"],"opening":"开场画面和作用","development":"发展与转折","ending":"结尾落点","voiceover":"完整旁白或旁白策略","captions":"字幕内容或策略"}},{"type":"visual_guide","title":"视听说明","summary":"一句话摘要","content":{"subject":"主体连续性","scenes":"场景设计","camera":"镜头语言","colorLight":"色彩光线","sound":"声音设计"}},{"type":"production_notes","title":"制作说明","summary":"一句话摘要","content":{"assumptions":["导演采用的假设"],"risks":["执行风险"],"nextRevision":"用户可继续修改的方向"}}]}。项目：${JSON.stringify({ title: project.title, idea: project.idea, aspect: project.aspect, duration: project.duration, skill: project.skill, creativeBrief: project.creativeBrief })}。当前已生效文字标准：${JSON.stringify(currentTextStandards(project))}。${revisionInstruction ? `用户本轮修改要求：${revisionInstruction}` : '这是首版方案。'}`
  const request = (recovery = false) => miniFetch(`${apiHost}/v1/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: recovery ? `${prompt}\n上次输出不完整。请严格只返回上述JSON对象。` : prompt }], max_tokens: recovery ? 12000 : 8000, temperature: recovery ? 0.2 : 0.45, response_format: { type: 'json_object' } }),
  })
  let data = await request(false)
  let parsed
  try {
    parsed = extractJson(completionText(data.choices?.[0]?.message))
    if (!Array.isArray(parsed.artifacts) || parsed.artifacts.length < 4) throw new Error('文字方案产物不完整')
  } catch {
    data = await request(true)
    parsed = extractJson(completionText(data.choices?.[0]?.message))
  }
  const created = storeTextArtifacts(project, parsed.artifacts, textModel)
  if (created.length < 4) throw new Error('文字方案产物不完整，请重试')
  return created
}

export function storyboardShotCount(project) {
  const requested = Number(project.storyboardShotCount)
  if (Number.isInteger(requested) && requested >= 1 && requested <= 10) return requested
  return Math.max(1, Math.ceil(Number(project.duration || 18) / 6))
}

export function storyboardShotDurations(project, count) {
  const total = Math.max(5, Number(project.duration || 18))
  if (count === 1) return [total]
  const durations = Array.from({ length: count }, () => 6)
  durations[count - 1] = Math.max(5, total - 6 * (count - 1))
  return durations
}

async function makeStoryboard(project, revisionInstruction = '') {
  const brief = project.creativeBrief || {}
  const concept = (project.concepts || []).find((item) => item.id === project.selectedConceptId)
  if (!concept) throw new Error('请先选择创意方向')
  const count = storyboardShotCount(project)
  const durations = storyboardShotDurations(project, count)
  const previous = project.shots || []
  const prompt = `你是专业短视频导演。严格依据已确认的创作简报、用户选择的创意方向和当前已生效文字标准，制作恰好 ${count} 个连续镜头，总时长 ${project.duration} 秒；镜头时长依次固定为 ${durations.join('、')} 秒，画幅${project.aspect || '16:9'}。不得增加、删除或合并用户明确指定以外的情节。用户手动修改过的脚本、视听说明、制作说明和本轮返修要求优先级最高。保持主体外观、服装、道具和环境连续。每个video_prompt必须可独立生成视频，写清主体特征、动作、环境、镜头运动、构图、光线、声音以及与前后镜头的连续性，避免模型难以完成的复杂快速动作。先给出你对分镜节奏和视觉组织的专业判断，再提供2-3个可供用户继续调整的方向。只返回JSON：{"title":"片名","summary":"一句话创意","insight":"分镜设计判断和理由","choices":[{"label":"调整方向","description":"对成片的影响","reply":"用户选择后送回导演的修改要求"}],"shots":[{"title":"镜头1","description":"观众看到和听到什么","video_prompt":"可直接生成视频的详细提示词"}]}。创作简报：${JSON.stringify({ ...brief, aspect: project.aspect, duration: project.duration, engine: project.engine })}。当前已生效文字标准：${JSON.stringify(currentTextStandards(project))}。选定方向：${JSON.stringify(concept)}。现有分镜（仅在返修要求明确保留时作为保留依据）：${JSON.stringify(previous.map(({ index, title, description, video_prompt }) => ({ index, title, description, video_prompt })))}。${revisionInstruction ? `本轮返修要求（最高优先级）：${revisionInstruction}` : ''}`
  const data = await miniFetch(`${apiHost}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 8000, temperature: 0.4 }),
  })
  let plan
  try {
    plan = extractJson(data.choices?.[0]?.message?.content || '')
  } catch {
    const retry = await miniFetch(`${apiHost}/v1/chat/completions`, {
      method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt + '\n请只返回JSON对象，不要解释。' }], max_tokens: 8000, temperature: 0.2 }),
    })
    plan = extractJson(retry.choices?.[0]?.message?.content || '')
  }
  project.title = plan.title || project.title
  project.summary = plan.summary || project.summary
  project.stageInsight = String(plan.insight || '').slice(0, 1000)
  project.stageChoices = normalizeChoices(plan.choices)
  project.shots = (plan.shots || []).slice(0, count).map((shot, index) => ({
    id: previous[index]?.id || crypto.randomUUID(),
    index,
    title: shot.title,
    description: shot.description,
    video_prompt: shot.video_prompt,
    duration: durations[index],
    status: 'ready',
    imageFile: previous[index]?.imageFile || project.referenceImages?.[index] || (index === 0 ? project.pendingImage : '') || '',
  }))
  if (project.pendingImage) project.pendingImage = ''
  project.storyboardBriefVersion = Number(project.briefVersion || 0)
  markBriefStale(project)
  return project
}

async function reviseStoryboard(project, action = {}) {
  const phase = project.phase
  if (!['storyboard_review', 'quality_review', 'ready_to_generate', 'delivery_review', 'delivered'].includes(phase)) {
    throw new Error('当前阶段不能整体返修分镜')
  }
  if (['delivery_review', 'delivered'].includes(phase)) archiveCurrentRender(project)
  const changed = applyBriefPatch(project, action)
  const shotCount = Number(action.shotCount)
  if (Number.isInteger(shotCount) && shotCount >= 1 && shotCount <= 10) {
    if (project.storyboardShotCount !== shotCount) changed.push('shotCount')
    project.storyboardShotCount = shotCount
  }
  const instruction = String(action.instruction || '').trim().slice(0, 4000)
  if (instruction) {
    project.storyboardRevisionInstruction = instruction
    changed.push('storyboard')
  }
  // The four production-standard documents must describe the storyboard under
  // review, so a structural revision rebuilds them from the latest brief too.
  const briefAffecting = changed.some((field) => BRIEF_KEYS.includes(field) || ['aspect', 'duration', 'title', 'shotCount'].includes(field))
  if (briefAffecting || instruction) await makeTextPackage(project, instruction)
  await makeStoryboard(project, instruction)
  project.phase = 'storyboard_review'
  project.storyboardConfirmedAt = ''
  project.qualityReview = null
  project.finalUrl = ''
  project.finalFilename = ''
  project.finalError = ''
  project.deliveredAt = ''
  return [...new Set(changed)]
}

async function rewriteShot(project, shotNo, instruction) {
  const shot = project.shots.find((item) => item.index === shotNo - 1)
  if (!shot) throw new Error(`没有第 ${shotNo} 镜`)
  const concept = (project.concepts || []).find((item) => item.id === project.selectedConceptId)
  const prompt = `只修改这一镜，严格遵守创作简报、当前已生效文字标准和选定方向，保持主体外观与前后镜头连续。用户手动修改的标准优先级最高。创作简报:${JSON.stringify(project.creativeBrief || {})}。当前已生效文字标准:${JSON.stringify(currentTextStandards(project))}。选定方向:${JSON.stringify(concept || {})}。原标题:${shot.title}。原描述:${shot.description}。原提示词:${shot.video_prompt}。修改要求:${instruction}。只返回JSON：{"title":"...","description":"...","video_prompt":"..."}`
  const data = await miniFetch(`${apiHost}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 4000, temperature: 0.4 }),
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
  if (videoDemoMode) {
    const id = crypto.randomUUID()
    const filename = `demo-preview-${shot.index + 1}`
    const task = upsertTask({
      id, engine: 'demo', prompt: shot.video_prompt, model: 'Demo-video', status: 'Success',
      projectId: project.id, shotId: shot.id, filename, createdAt: new Date().toISOString(),
    })
    shot.taskId = task.id
    shot.status = task.status
    shot.filename = filename
    project.demoPreview = true
    return task
  }
  if (!await comfyOk()) throw new Error('本机生成服务未连接，请先打开星绘工坊启动脚本')
  const missing = listH3Models().filter((item) => !item.present)
  if (missing.length) throw new Error('本机模型文件不完整')
  const [width, height] = h3Size(project.aspect)
  const firstFrame = shot.imageFile ? store.imageDataUrl(project.id, shot.imageFile) : ''
  const imageName = firstFrame ? await uploadComfyImage(firstFrame, `${project.id}-${shot.id}`) : undefined
  const seed = Number(String(Date.now()).slice(-9))
  const submitted = await comfyJson('/prompt', {
    method: 'POST',
    body: JSON.stringify({ prompt: buildH3Prompt({ prompt: shot.video_prompt, width, height, length: h3Length(shot.duration || 6), imageName, seed }), client_id: 'xinghui-studio' }),
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
  if (Number(shot.duration || 6) !== 6) throw new Error('云端当前只支持单镜 6 秒；请切换为本机生成，或拆成 6 秒镜头后再开拍')
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
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', path.join(outputDir, output)])
      let error = ''; child.stderr.on('data', (chunk) => { error += chunk })
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(error.slice(-1200))))
    })
  } finally {
    if (fs.existsSync(list)) fs.unlinkSync(list)
  }
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
  const shots = project.shots || []
  const ready = shots.length > 0 && shots.every((shot) => shot.status === 'Success' && shot.filename)
  if (ready && !project.finalUrl) {
    try {
      if (videoDemoMode && project.demoPreview) {
        project.finalFilename = 'demo-preview'
        project.finalUrl = 'demo://preview'
      } else if (shots.length === 1) {
        project.finalFilename = shots[0].filename
        project.finalUrl = `/media/${shots[0].filename}`
      } else {
        await mergeProject(project)
      }
      project.finalError = ''
      project.phase = 'delivery_review'
      changed = true
    } catch (error) {
      project.finalError = `镜头已经完成，但自动合片失败：${error.message}`
      changed = true
    }
  }
  if (changed) store.save(project)
  return decorateProjectProgress(project)
}

export async function applyActions(project, actions, notes, artifactChanges = [], options = {}) {
  for (const action of actions || []) {
    const op = action.op || action.type
    if (op === 'update_brief') {
      if (['generating', 'delivery_review', 'delivered'].includes(project.phase)) {
        const changed = applyBriefPatch(project, action)
        artifactChanges.push(...changed)
        if (changed.length) {
          notes.push('成片已经在进行或完成：简报改动已记下，重新开拍时会先按新简报重建分镜与制作标准，当前成片会保留为历史版本')
        } else {
          notes.push('成片已经在进行或完成，本轮没有需要更新的简报内容')
        }
        continue
      }
      if (!['discovery', 'brief_review', 'concept_selection', 'storyboard_review', 'quality_review', 'ready_to_generate'].includes(project.phase)) {
        notes.push('当前阶段不能修改创作简报')
        continue
      }
      const changed = applyBriefPatch(project, action)
      artifactChanges.push(...changed)
      const briefAffecting = changed.some((field) => BRIEF_KEYS.includes(field) || ['aspect', 'duration'].includes(field))
      if (briefAffecting && ['quality_review', 'ready_to_generate'].includes(project.phase)) {
        project.phase = 'storyboard_review'
        project.storyboardConfirmedAt = ''
        project.qualityReview = null
        notes.push('简报已更新，已确认的分镜基于旧版简报，请重新确认分镜或让导演按新简报返修')
      } else {
        notes.push('已记下简报修改。这一关即使完整，也还可以继续对话调整')
      }
    } else if (op === 'present_brief') {
      if (project.phase !== 'discovery') continue
      if (options.holdDiscovery) {
        notes.push('已先形成专业默认方案，回答当前关键问题后即可送审')
        continue
      }
      const readiness = briefReadiness(project)
      if (!readiness.ready) {
        notes.push(`简报还不能送审：${[...readiness.missing, readiness.turnsRemaining ? `还需 ${readiness.turnsRemaining} 轮交流` : ''].filter(Boolean).join('、')}`)
        continue
      }
      project.phase = 'brief_review'
      notes.push('创作简报已整理好，请检查后确认')
    } else if (op === 'regenerate_concepts') {
      if (project.phase !== 'concept_selection') {
        notes.push('当前还不能重新生成创意方向')
        continue
      }
      await makeConcepts(project)
      notes.push('已换了一组创意方向')
    } else if (op === 'rewrite_shot') {
      if (!['storyboard_review', 'quality_review', 'ready_to_generate'].includes(project.phase)) {
        notes.push('当前没有可改的分镜，生成开始后请等本镜完成再返修')
        continue
      }
      await rewriteShot(project, Number(action.shot || action.index), action.instruction || '')
      if (project.phase !== 'storyboard_review') {
        project.phase = 'storyboard_review'
        project.storyboardConfirmedAt = ''
        notes.push(`已改第 ${action.shot} 镜，请再确认分镜`)
      } else {
        notes.push(`已改第 ${action.shot} 镜`)
      }
    } else if (op === 'revise_storyboard') {
      try {
        const changed = await reviseStoryboard(project, action)
        artifactChanges.push(...changed)
        notes.push(`已按最新要求重建 ${project.shots.length} 镜、${project.duration} 秒的分镜，请重新确认`)
      } catch (error) {
        notes.push(error.message)
      }
    }
  }
  // The model is allowed to recommend presenting the brief, but it must not be
  // able to keep a complete brief in an endless interview by omitting that one
  // action. The server owns the phase transition.
  if (project.phase === 'discovery' && briefReadiness(project).ready && !options.holdDiscovery) {
    project.phase = 'brief_review'
    notes.push('创作简报已整理好，可确认进入创意方向')
  }
  return project
}

async function confirmBriefProject(project) {
  if (project.phase !== 'brief_review') throw new Error('当前不在创作简报评审阶段')
  const readiness = briefReadiness(project)
  if (!readiness.ready) throw new Error(`简报信息仍不完整：${readiness.missing.join('、')}`)
  await makeConcepts(project)
  project.briefConfirmedAt = new Date().toISOString()
  project.phase = 'concept_selection'
  return project
}

export function applyDirectorDefaults(project) {
  project.creativeBrief = project.creativeBrief || {}
  const brief = project.creativeBrief
  const goal = String(brief.goal || project.idea || '按用户描述制作一支短视频').trim()
  const defaults = {
    goal,
    audience: '泛短视频平台的普通观众',
    platform: '短视频平台',
    story: `围绕“${goal}”完成一个清晰、连续、可执行的短视频片段。`,
    subject: '以用户描述的主体为核心，保持参考图中的外观与场景特征。',
    visualStyle: '真实自然、主体清晰、适合短视频观看的摄影风格。',
    tone: '贴合用户描述的情绪，以清晰易懂和可看性优先。',
    audio: '首版以画面和环境氛围为主；未接通的配音、BGM、对口型不阻塞生成。',
    constraints: '未指定项由导演按可执行性、主体一致性和短视频节奏自动决定。',
  }
  const missing = Object.fromEntries(Object.entries(defaults).filter(([key]) => !String(brief[key] || '').trim()))
  return applyBriefPatch(project, { brief: missing })
}

function directStartFromChat(project) {
  const changed = applyDirectorDefaults(project)
  if (project.phase === 'discovery' && briefReadiness(project).ready) project.phase = 'brief_review'
  if (['delivery_review', 'delivered'].includes(project.phase)) {
    return { say: '这个项目已有成片。请在右侧点击“基于当前分镜重新开拍”，我会保留现有素材和分镜并建立新版本。', changed }
  }
  const guidance = {
    brief_review: '默认创作方案已经补齐并显示在右侧，请确认简报后生成创意方向。',
    concept_selection: '创意方向已经在右侧，请选择一个方向后继续。',
    storyboard_review: '分镜已经在右侧，请确认分镜后进入质量审核。',
    quality_review: '质量检查已经在右侧，请明确通过后进入开拍确认。',
    ready_to_generate: '项目已经准备好，请点击右侧开拍按钮；云端会明确显示本次额度。',
    generating: '项目正在生成，不会重复提交任务。请在右侧查看进度。',
  }
  return { say: guidance[project.phase] || '创作产物已更新在右侧，请从当前审核节点继续。', changed }
}

function currentGateGuidance(project) {
  const guidance = {
    brief_review: '创作简报已经在右侧，请点击“确认简报”进入创意方向。',
    concept_selection: '请在右侧选择一个创意方向；每个方向都会改变叙事或视觉执行。',
    storyboard_review: '分镜已经在右侧，请审阅后点击“确认分镜”。',
    quality_review: '质量审核结果已经在右侧，请明确通过或返回修改。',
    ready_to_generate: '项目已经准备好，请点击右侧开拍按钮。',
    generating: '项目正在生成，不会重复提交任务。',
    delivery_review: '成片正在等待交付确认；如需重拍，请点击右侧“基于当前分镜重新开拍”。',
    delivered: '项目已经交付；如需新版本，请点击右侧“基于当前分镜重新开拍”。',
  }
  return guidance[project.phase] || '请继续补充创作目标，我会把新增结论同步到右侧画布。'
}

function recordBriefRevision(project, fields, insight) {
  const unique = [...new Set(fields)].filter(Boolean)
  if (!unique.length) return
  project.briefRevisions = project.briefRevisions || []
  project.briefRevisions.push({
    id: crypto.randomUUID(),
    fields: unique,
    insight: String(insight || '').trim().slice(0, 500),
    createdAt: new Date().toISOString(),
  })
  project.briefRevisions = project.briefRevisions.slice(-30)
}

export function answerPendingDecision(project, answer) {
  project.decisionLedger = Array.isArray(project.decisionLedger) ? project.decisionLedger : []
  const pending = [...project.decisionLedger].reverse().find((item) => item.status === 'asked')
  if (!pending || !String(answer || '').trim()) return null
  pending.answer = String(answer).trim().slice(0, 1000)
  pending.status = 'answered'
  pending.answeredAt = new Date().toISOString()
  return pending
}

export function recordDirectorQuestion(project, question) {
  if (!question?.key || !question?.text) return null
  project.decisionLedger = Array.isArray(project.decisionLedger) ? project.decisionLedger : []
  if (project.decisionLedger.some((item) => item.key === question.key)) return null
  const item = {
    id: crypto.randomUUID(),
    key: question.key,
    question: question.text,
    importance: question.importance || '',
    status: 'asked',
    askedAt: new Date().toISOString(),
  }
  project.decisionLedger.push(item)
  project.decisionLedger = project.decisionLedger.slice(-30)
  return item
}

async function reviewStoryboard(project) {
  const concept = (project.concepts || []).find((item) => item.id === project.selectedConceptId)
  const prompt = `你是商业视频制作的质量审核导演。检查分镜是否忠于创作简报和当前已生效文字标准，主体是否连续，节奏是否适合总时长，每镜是否能被视频模型执行，声音设计是否连贯，结尾是否完成目标。用户手动修改的标准优先级最高。不要改写分镜，只返回JSON：{"score":0,"verdict":"pass|revise","summary":"总评","checks":[{"label":"检查项","status":"pass|warning|fail","note":"依据"}],"recommendations":["可执行建议"]}。创作简报：${JSON.stringify(project.creativeBrief || {})}。当前已生效文字标准：${JSON.stringify(currentTextStandards(project))}。创意方向：${JSON.stringify(concept || {})}。分镜：${JSON.stringify((project.shots || []).map(({ title, description, video_prompt }) => ({ title, description, video_prompt })))}`
  const data = await miniFetch(`${apiHost}/v1/chat/completions`, {
    method: 'POST', body: JSON.stringify({ model: textModel, messages: [{ role: 'user', content: prompt }], max_tokens: 6000, temperature: 0.2 }),
  })
  const parsed = extractJson(data.choices?.[0]?.message?.content || '')
  project.qualityReview = {
    score: Math.max(0, Math.min(100, Number(parsed.score) || 0)),
    verdict: parsed.verdict === 'pass' ? 'pass' : 'revise',
    summary: String(parsed.summary || '').slice(0, 1000),
    checks: (Array.isArray(parsed.checks) ? parsed.checks : []).slice(0, 10).map((item) => ({
      label: String(item.label || '检查项').slice(0, 100),
      status: ['pass', 'warning', 'fail'].includes(item.status) ? item.status : 'warning',
      note: String(item.note || '').slice(0, 500),
    })),
    recommendations: (Array.isArray(parsed.recommendations) ? parsed.recommendations : []).slice(0, 8).map((item) => String(item).slice(0, 500)),
    reviewedAt: new Date().toISOString(),
  }
  return project.qualityReview
}

app.get('/api/projects', (_req, res) => res.json(store.list().map((item) => ({ ...item, messages: undefined }))))
app.post('/api/projects', (_req, res) => res.json(store.create()))
app.get('/api/assets', (_req, res) => {
  const assets = store.list().flatMap((project) => (project.referenceImages || []).map((filename, index) => ({
    id: `${project.id}:${filename}`,
    projectId: project.id,
    projectTitle: project.title,
    filename,
    title: project.shots?.find((shot) => shot.imageFile === filename)?.title || `参考素材 ${index + 1}`,
    url: `/api/projects/${project.id}/media/${encodeURIComponent(filename)}`,
    updatedAt: project.updatedAt,
  })))
  res.json(assets)
})
app.get('/api/projects/current', async (_req, res) => {
  try { res.json(await refreshProject(store.latest())) }
  catch (error) { res.status(502).json({ error: error.message }) }
})
app.get('/api/projects/:id', async (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    res.json(await refreshProject(project))
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})
app.get('/api/projects/:id/media/:file', (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    const allowed = (project.shots || []).some((shot) => shot.imageFile === req.params.file) || project.pendingImage === req.params.file || (project.referenceImages || []).includes(req.params.file)
    if (!allowed) return res.status(404).end()
    const full = store.imagePath(project.id, req.params.file)
    if (!fs.existsSync(full)) return res.status(404).end()
    res.sendFile(full)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})
app.post('/api/projects/:id/images', receiveReferenceImage, (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (!req.file?.buffer?.length) return res.status(400).json({ error: '请选择要上传的参考图' })
    const rawShotIndex = req.body?.shotIndex
    const shotIndex = rawShotIndex === undefined || rawShotIndex === '' ? null : Number(rawShotIndex)
    const shot = shotIndex === null ? null : project.shots.find((item) => item.index === shotIndex)
    if (shotIndex !== null && !shot) return res.status(404).json({ error: '镜头不存在' })

    const saved = store.saveImageBuffer(project.id, req.file.buffer, shot ? `s${shot.index + 1}` : 'reference')
    project.referenceImages = project.referenceImages || []
    if (!project.referenceImages.includes(saved.filename)) project.referenceImages.push(saved.filename)
    if (shot) shot.imageFile = saved.filename
    store.save(project)
    res.status(201).json({
      attachment: { ...imageAttachment(project.id, saved.filename, saved.mime), size: saved.size },
      project,
    })
  } catch (error) {
    const unsupported = String(error.message || '').startsWith('仅支持')
    res.status(error.status || (unsupported ? 415 : 400)).json({ error: error.message })
  }
})
app.post('/api/projects/:id/shots/:index/image', (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    const shot = project.shots.find((item) => item.index === Number(req.params.index))
    if (!shot) return res.status(404).json({ error: '镜头不存在' })
    shot.imageFile = store.saveImage(project.id, req.body.image, `s${shot.index + 1}`)
    project.referenceImages = project.referenceImages || []
    if (!project.referenceImages.includes(shot.imageFile)) project.referenceImages.push(shot.imageFile)
    store.save(project)
    res.json(project)
  } catch (error) { res.status(400).json({ error: error.message }) }
})

app.post('/api/projects/:id/use-asset', (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    const source = projectOr404(String(req.body.sourceProjectId || ''))
    const filename = path.basename(String(req.body.filename || ''))
    if (!source.referenceImages.includes(filename)) return res.status(404).json({ error: '素材不存在' })
    const copied = store.copyImage(source.id, filename, project.id)
    project.referenceImages = project.referenceImages || []
    project.referenceImages.push(copied)
    const shot = (project.shots || []).find((item) => !item.imageFile)
    if (shot) shot.imageFile = copied
    else project.pendingImage = copied
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.post('/api/projects/:id/update-artifacts', (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (project.phase === 'generating') return res.status(409).json({ error: '视频生成中不能修改生产标准，请等待当前任务完成' })

    const changed = []
    const brief = req.body?.creativeBrief
    if (brief && typeof brief === 'object') {
      project.creativeBrief = project.creativeBrief || {}
      for (const key of BRIEF_KEYS) {
        if (typeof brief[key] !== 'string') continue
        const value = brief[key].trim().slice(0, 2000)
        if (project.creativeBrief[key] !== value) changed.push(key)
        project.creativeBrief[key] = value
      }
      project.idea = project.creativeBrief.goal || project.idea
    }

    const settings = req.body?.settings && typeof req.body.settings === 'object' ? req.body.settings : {}
    const settingPatch = {
      title: settings.title,
      aspect: settings.aspect,
      duration: settings.duration,
      engine: settings.engine,
      skill: settings.skill,
    }
    changed.push(...applyBriefPatch(project, settingPatch))

    const arrayFields = new Set(['timeline', 'assumptions', 'risks'])
    for (const draft of Array.isArray(req.body?.artifacts) ? req.body.artifacts : []) {
      const type = String(draft?.type || '')
      const current = currentTextStandards(project).find((item) => item.type === type)
      if (!current || !draft?.content || typeof draft.content !== 'object') continue
      const content = Object.fromEntries(Object.entries(draft.content).map(([key, value]) => [
        key,
        arrayFields.has(key)
          ? (Array.isArray(value) ? value : String(value ?? '').split(/\r?\n/)).map((item) => String(item).trim()).filter(Boolean)
          : String(value ?? '').trim(),
      ]))
      const next = {
        type,
        title: String(draft.title || current.title).trim(),
        summary: String(draft.summary ?? current.summary).trim(),
        content,
      }
      if (JSON.stringify({ title: current.title, summary: current.summary, content: current.content })
        === JSON.stringify({ title: next.title, summary: next.summary, content: next.content })) continue
      storeTextArtifacts(project, [next], 'user')
      changed.push(`artifact:${type}`)
    }

    const unique = [...new Set(changed)]
    if (!unique.length) return res.json(project)
    invalidateDownstreamForStandards(project)
    recordBriefRevision(project, unique, '用户手动修改右侧生产标准，后续创意、分镜和视频生成均以新版本为准。')
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.post('/api/projects/:id/confirm-brief', async (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    await confirmBriefProject(project)
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || (error.message.includes('当前不在') || error.message.includes('信息仍不完整') ? 409 : 502)).json({ error: error.message }) }
})

app.post('/api/projects/:id/revise-brief', (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (!['brief_review', 'concept_selection', 'storyboard_review', 'quality_review', 'ready_to_generate'].includes(project.phase)) {
      return res.status(409).json({ error: '当前阶段不能返回修改简报' })
    }
    project.phase = 'brief_review'
    project.briefConfirmedAt = ''
    project.storyboardConfirmedAt = ''
    project.concepts = []
    project.selectedConceptId = ''
    project.shots = []
    project.finalUrl = ''
    project.finalFilename = ''
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.post('/api/projects/:id/select-concept', async (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (project.phase !== 'concept_selection') return res.status(409).json({ error: '当前不在创意方向选择阶段' })
    const concept = project.concepts.find((item) => item.id === req.body.conceptId)
    if (!concept) return res.status(400).json({ error: '请选择有效的创意方向' })
    project.selectedConceptId = concept.id
    await makeStoryboard(project)
    project.phase = 'storyboard_review'
    project.storyboardConfirmedAt = ''
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})

app.post('/api/projects/:id/regenerate-concepts', async (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (project.phase !== 'concept_selection') return res.status(409).json({ error: '当前不在创意方向选择阶段' })
    await makeConcepts(project)
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})

app.post('/api/projects/:id/reselect-concept', (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (!['storyboard_review', 'ready_to_generate'].includes(project.phase)) return res.status(409).json({ error: '当前不能重新选择创意方向' })
    project.phase = 'concept_selection'
    project.selectedConceptId = ''
    project.storyboardConfirmedAt = ''
    project.shots = []
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.post('/api/projects/:id/confirm-storyboard', async (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (project.phase !== 'storyboard_review') return res.status(409).json({ error: '当前不在分镜评审阶段' })
    if (!project.shots.length) return res.status(409).json({ error: '还没有可确认的分镜' })
    await reviewStoryboard(project)
    project.phase = 'quality_review'
    project.storyboardConfirmedAt = new Date().toISOString()
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})

app.post('/api/projects/:id/approve-quality', (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (project.phase !== 'quality_review') return res.status(409).json({ error: '当前不在质量审核阶段' })
    project.phase = 'ready_to_generate'
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.post('/api/projects/:id/revise-storyboard', async (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (!['quality_review', 'ready_to_generate', 'delivery_review'].includes(project.phase)) return res.status(409).json({ error: '当前不能返回修改分镜' })
    if (String(req.body?.instruction || '').trim()) {
      await reviseStoryboard(project, req.body)
      recordBriefRevision(project, ['storyboard', 'shotCount', 'duration'].filter((key) => key === 'storyboard' || req.body?.[key] !== undefined), '用户明确提交了结构性分镜返修，右侧分镜已更新为待审版本。')
      store.save(project)
      return res.json(project)
    }
    project.phase = 'storyboard_review'
    project.storyboardConfirmedAt = ''
    project.finalUrl = ''
    project.finalFilename = ''
    project.finalError = ''
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.post('/api/projects/:id/approve-delivery', (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (project.phase !== 'delivery_review') return res.status(409).json({ error: '当前没有待确认的成片' })
    project.phase = 'delivered'
    project.deliveredAt = new Date().toISOString()
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.post('/api/projects/:id/prepare-reshoot', async (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (!['delivery_review', 'delivered'].includes(project.phase)) return res.status(409).json({ error: '当前项目还没有可重拍的成片版本' })
    if (!project.shots?.length) return res.status(409).json({ error: '当前项目没有可复用的分镜' })
    // A brief edited after delivery must drive a fresh storyboard instead of a
    // silent re-render of the old one. Source assets stay in place either way.
    if (Number(project.briefVersion || 0) !== Number(project.storyboardBriefVersion || 0)) {
      await reviseStoryboard(project, { instruction: '创作简报在成片交付后有更新，请严格按最新创作简报重建分镜，保持总时长与画幅一致。' })
      recordBriefRevision(project, ['storyboard'], '重新开拍前先按更新后的简报重建了分镜与制作标准。')
      store.save(project)
      return res.json(project)
    }
    if (project.finalUrl || project.finalFilename) {
      project.previousRenders = project.previousRenders || []
      project.previousRenders.push({
        id: crypto.randomUUID(),
        url: project.finalUrl || '',
        filename: project.finalFilename || '',
        deliveredAt: project.deliveredAt || new Date().toISOString(),
      })
    }
    project.shots = project.shots.map((shot) => {
      const source = { ...shot }
      delete source.taskId
      delete source.filename
      delete source.error
      delete source.generationProgress
      return { ...source, status: 'ready' }
    })
    project.phase = 'ready_to_generate'
    project.finalUrl = ''
    project.finalFilename = ''
    project.finalError = ''
    project.deliveredAt = ''
    store.save(project)
    res.json(project)
  } catch (error) { res.status(error.status || 400).json({ error: error.message }) }
})

app.post('/api/projects/:id/generate', async (req, res) => {
  try {
    const project = projectOr404(req.params.id)
    if (!['ready_to_generate', 'generating'].includes(project.phase)) return res.status(409).json({ error: '请先确认创作简报和分镜' })
    const targets = resolveShotList(req.body.shots || 'pending', project)
    if (!targets.length) return res.status(409).json({ error: '没有需要生成的镜头' })
    if (project.engine === 'cloud') {
      if (req.body.confirmCloud !== true || Number(req.body.confirmedCount) !== targets.length) {
        return res.status(409).json({ error: `云端生成将消耗 ${targets.length} 次额度，请明确确认` })
      }
    }
    project.phase = 'generating'
    project.finalUrl = ''
    project.finalFilename = ''
    project.finalError = ''
    store.save(project)
    for (const shot of targets) {
      if (project.engine === 'cloud') await startCloudShot(project, shot)
      else await startLocalShot(project, shot)
      store.save(project)
    }
    res.json(await refreshProject(project))
  } catch (error) { res.status(error.status || 502).json({ error: error.message }) }
})

async function completeDirectorTurn(project, history, options = {}) {
  const projectSnapshot = snapshotForDirector(project)
  const needsDiscoveryQuestion = project.phase === 'discovery' && Number(project.discoveryTurns || 0) <= 1 && !options.directStart
  const baseMessages = [
    { role: 'system', content: directorSystemFor(project) },
    { role: 'system', content: `当前项目：${JSON.stringify(projectSnapshot)}` },
  ]
  const request = async (recovery = false) => miniFetch(`${apiHost}/v1/chat/completions`, {
    method: 'POST',
    body: JSON.stringify({
      model: textModel,
      temperature: recovery ? 0.1 : 0.3,
      max_tokens: recovery ? 12000 : 8000,
      ...(recovery ? {} : { response_format: { type: 'json_object' } }),
      messages: recovery ? [
        {
          role: 'system',
          content: `你是星绘视频工坊的创作导演。上一次回复没有完整输出，现在根据当前项目和用户最后一句话重新完成本轮工作。
当前项目：${JSON.stringify(projectSnapshot)}
要求：先回应用户刚才的决定，再给出专业判断。${needsDiscoveryQuestion ? '这是 discovery 第一轮，只追问一个最有价值的问题，输出 question 和 2-4 个有真实差异的选择。' : '关键问题已经回答，不得继续追问，question 为 null，choices 为空，并补齐简报送审。'}不得生成分镜或视频。
严格只输出一个简短 JSON 对象：{"say":"不超过240字","insight":"不超过180字","question":{"key":"英文决策键","text":"唯一问题","importance":"影响"}|null,"choices":[],"actions":[]}`,
        },
        history.at(-1) || { role: 'user', content: '请继续当前创作访谈。' },
      ] : [...baseMessages, ...history],
    }),
  })

  const parseComplete = (raw) => {
    const value = extractJson(raw)
    const choices = Array.isArray(value.choices) ? value.choices.filter((item) => item?.label && (item?.reply || item?.label)) : []
    const question = value.question && typeof value.question === 'object' ? value.question : null
    if (!String(value.say || value.message || '').trim() || !String(value.insight || '').trim()
      || (needsDiscoveryQuestion && (!question?.key || !question?.text || choices.length < 2))) {
      throw new Error('导演回复结构不完整')
    }
    return parseDirectorReply(JSON.stringify(value))
  }

  let data = await request(false)
  let raw = completionText(data.choices?.[0]?.message)
  try {
    return parseComplete(raw)
  } catch (firstError) {
    console.warn('[director] structured reply invalid; retrying with compact context', {
      finishReason: data.choices?.[0]?.finish_reason || 'unknown',
      contentLength: raw.length,
      reason: firstError.message,
    })
    data = await request(true)
    raw = completionText(data.choices?.[0]?.message)
    try {
      return parseComplete(raw)
    } catch (recoveryError) {
      console.warn('[director] compact recovery reply invalid', {
        finishReason: data.choices?.[0]?.finish_reason || 'unknown',
        contentLength: raw.length,
        reason: recoveryError.message,
      })
      throw new Error('导演本轮回复被截断，自动重试仍未完成，请再次提交刚才的选择')
    }
  }
}

app.post('/api/projects/:id/chat', async (req, res) => {
  let project
  let rollbackProject
  let userTurnPersisted = false
  try {
    project = projectOr404(req.params.id)
    rollbackProject = structuredClone(project)
    if (!PROJECT_PHASES.has(project.phase)) project.phase = 'discovery'
    const phaseAtStart = project.phase
    const text = String(req.body.message || '').trim()
    const image = req.body.image
    const requestedAttachments = (Array.isArray(req.body.attachmentIds) ? req.body.attachmentIds : [])
      .slice(0, 4)
      .map((item) => path.basename(String(item || '')))
      .filter((item) => project.referenceImages.includes(item))
    if (!text && !image && !requestedAttachments.length) return res.status(400).json({ error: '请先说想拍什么' })
    const attachmentFiles = [...new Set(requestedAttachments)]
    if (image) {
      const imageFile = store.saveImage(project.id, image, 'reference')
      project.referenceImages = project.referenceImages || []
      project.referenceImages.push(imageFile)
      attachmentFiles.push(imageFile)
    }
    for (const imageFile of attachmentFiles) {
      const pending = (project.shots || []).find((item) => !item.imageFile) || project.shots?.[0]
      if (pending) pending.imageFile = imageFile
      else project.pendingImage = imageFile
    }
    if (attachmentFiles.length && !project.creativeBrief.referenceNotes) project.creativeBrief.referenceNotes = '用户已上传参考图，创作需保持其主体与视觉特征'
    const userContent = text || '请分析这张参考图，并结合图片继续创作访谈。'
    project.messages = project.messages || []
    project.messages.push({
      role: 'user',
      content: userContent,
      attachments: attachmentFiles.map((filename) => imageAttachment(project.id, filename)),
      ts: new Date().toISOString(),
    })
    if (project.phase === 'discovery' && (text || attachmentFiles.length)) {
      project.discoveryTurns = Number(project.discoveryTurns || 0) + 1
      if (project.discoveryTurns > 1 && text) answerPendingDecision(project, text)
    }
    let initialGoalAdded = false
    if (!project.idea && text) {
      project.idea = text
      project.creativeBrief.goal = text
      initialGoalAdded = true
    }
    store.save(project)
    userTurnPersisted = true
    const directStart = isDirectStartIntent(text)
    const holdDiscovery = project.phase === 'discovery' && Number(project.discoveryTurns || 0) <= 1 && !directStart

    // A short confirmation should never be sent back through the interview
    // model. It is a command for the current planning gate, not new creative
    // input. This also makes “好/继续/开始制作” usable on mobile.
    if (isShortAdvanceIntent(text) && project.phase !== 'discovery') {
      const result = directStart ? directStartFromChat(project) : { say: currentGateGuidance(project), changed: [] }
      recordBriefRevision(project, result.changed, directStart ? '用户授权导演采用专业默认值，已补齐缺失的制作决定。' : '')
      project.messages.push({ role: 'assistant', content: result.say, insight: '', choices: [], ts: new Date().toISOString() })
      store.save(project)
      userTurnPersisted = false
      return res.json(project)
    }

    const history = historyForDirector(project.messages, attachmentFiles.map((filename) => store.imageDataUrl(project.id, filename)))
    const parsed = await completeDirectorTurn(project, history, { directStart })
    const notes = []
    const artifactChanges = initialGoalAdded ? ['goal'] : []
    try {
      await applyActions(project, parsed.actions, notes, artifactChanges, { holdDiscovery })
    } catch (actionError) {
      notes.push(actionError.message)
    }
    let reply = [parsed.say, notes.length ? notes.join('。') + '。' : ''].filter(Boolean).join('\n')
    // A detailed direct-start message may still contain useful factual changes.
    // Persist those changes, then stop at the current explicit UI review gate.
    if (directStart) {
      const result = directStartFromChat(project)
      artifactChanges.push(...result.changed)
      reply = result.say
    }
    if (project.phase === 'discovery' && Number(project.discoveryTurns || 0) > 1) {
      artifactChanges.push(...applyDirectorDefaults(project))
      project.phase = 'brief_review'
      notes.push('关键问题已经回答，其余非关键项已采用专业默认值')
    }
    const recordedQuestion = holdDiscovery ? recordDirectorQuestion(project, parsed.question) : null
    const shouldBuildTextPackage = project.phase === 'brief_review'
      && (phaseAtStart === 'discovery' || (phaseAtStart === 'brief_review' && !isShortAdvanceIntent(text)))
    if (shouldBuildTextPackage) {
      await makeTextPackage(project, phaseAtStart === 'brief_review' ? text : '')
      notes.push('导演阐述、完整脚本、视听说明和制作说明已生成在右侧')
      reply = [reply, notes.at(-1) + '。'].filter(Boolean).join('\n')
    }
    const previousChoices = project.messages.filter((item) => item.role === 'assistant').slice(-6).flatMap((item) => item.choices || [])
    const choices = recordedQuestion ? dedupeDirectorChoices(parsed.choices, previousChoices) : []
    recordBriefRevision(project, artifactChanges, parsed.insight)
    project.messages.push({ role: 'assistant', content: reply, insight: parsed.insight, choices, ts: new Date().toISOString() })
    store.save(project)
    userTurnPersisted = false
    res.json(project)
  } catch (error) {
    if (userTurnPersisted && rollbackProject) store.save(rollbackProject)
    res.status(error.status || 502).json({ error: error.message })
  }
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

let serverInstance
export function startServer() {
  if (serverInstance) return serverInstance
  serverInstance = app.listen(port, '127.0.0.1', () => console.log(`星绘视频工坊: http://127.0.0.1:${port}`))
  startComfyProgressFeed()
  return serverInstance
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) startServer()
