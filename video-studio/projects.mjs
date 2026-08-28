import fs from 'node:fs'
import path from 'node:path'
import { buildProcessProgress, storyboardMatchesBrief } from './director.mjs'

export function createProjectStore(root) {
  const projectsDir = path.join(root, 'outputs', 'projects')
  fs.mkdirSync(projectsDir, { recursive: true })

  const dirOf = (id) => path.join(projectsDir, id)
  const fileOf = (id) => path.join(dirOf(id), 'project.json')
  const imagesOf = (id) => path.join(dirOf(id), 'images')

  const emptyBrief = () => ({
    goal: '',
    audience: '',
    platform: '',
    story: '',
    subject: '',
    visualStyle: '',
    tone: '',
    audio: '',
    constraints: '',
    referenceNotes: '',
  })

  const empty = () => ({
    id: crypto.randomUUID(),
    title: '未命名项目',
    idea: '',
    aspect: '16:9',
    duration: 18,
    engine: 'local',
    skill: 'custom-video',
    phase: 'discovery',
    discoveryTurns: 0,
    creativeBrief: emptyBrief(),
    concepts: [],
    productionPlan: [],
    briefRevisions: [],
    decisionLedger: [],
    textArtifacts: [],
    previousRenders: [],
    referenceImages: [],
    selectedConceptId: '',
    qualityReview: null,
    stageInsight: '',
    stageChoices: [],
    briefConfirmedAt: '',
    storyboardConfirmedAt: '',
    deliveredAt: '',
    briefVersion: 0,
    storyboardBriefVersion: 0,
    shots: [],
    messages: [],
    finalUrl: '',
    finalFilename: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const normalize = (project) => {
    const base = empty()
    const next = {
      ...base,
      ...project,
      creativeBrief: { ...emptyBrief(), ...(project?.creativeBrief || {}) },
      concepts: Array.isArray(project?.concepts) ? project.concepts : [],
      productionPlan: Array.isArray(project?.productionPlan) ? project.productionPlan : [],
      briefRevisions: (Array.isArray(project?.briefRevisions) ? project.briefRevisions : []).slice(-30).map((item) => ({
        ...item,
        fields: Array.isArray(item?.fields) ? item.fields : [],
      })),
      decisionLedger: (Array.isArray(project?.decisionLedger) ? project.decisionLedger : []).slice(-30),
      textArtifacts: (Array.isArray(project?.textArtifacts) ? project.textArtifacts : []).slice(-40).map((item) => ({
        ...item,
        content: item?.content && typeof item.content === 'object' ? item.content : {},
        sourceArtifactIds: Array.isArray(item?.sourceArtifactIds) ? item.sourceArtifactIds : [],
      })),
      previousRenders: Array.isArray(project?.previousRenders) ? project.previousRenders : [],
      referenceImages: Array.isArray(project?.referenceImages) ? project.referenceImages : [],
      stageChoices: Array.isArray(project?.stageChoices) ? project.stageChoices : [],
      shots: Array.isArray(project?.shots) ? project.shots : [],
      messages: (Array.isArray(project?.messages) ? project.messages : []).map((message) => ({
        ...message,
        attachments: Array.isArray(message?.attachments) ? message.attachments : [],
      })),
    }
    if (!next.creativeBrief.goal && next.idea) next.creativeBrief.goal = next.idea
    next.briefVersion = Number(next.briefVersion || 0)
    next.storyboardBriefVersion = Number(next.storyboardBriefVersion || 0)
    next.briefStale = next.shots.length > 0
      && (next.briefVersion !== next.storyboardBriefVersion || !storyboardMatchesBrief(next))
    next.processProgress = buildProcessProgress(next)
    return next
  }

  const save = (project) => {
    project = normalize(project)
    const dir = dirOf(project.id)
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true })
    project.updatedAt = new Date().toISOString()
    fs.writeFileSync(fileOf(project.id), JSON.stringify(project, null, 2))
    return project
  }

  const load = (id) => {
    const file = fileOf(id)
    if (!fs.existsSync(file)) return null
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')))
  }

  const list = () => {
    if (!fs.existsSync(projectsDir)) return []
    return fs.readdirSync(projectsDir).map((id) => {
      try { return load(id) } catch { return null }
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  const create = (patch = {}) => save(normalize({ ...empty(), ...patch }))

  const latest = () => list()[0] || create()

  const detectImageType = (buffer) => {
    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
      return { ext: 'jpg', mime: 'image/jpeg' }
    }
    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
      return { ext: 'png', mime: 'image/png' }
    }
    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
      return { ext: 'webp', mime: 'image/webp' }
    }
    throw new Error('仅支持 JPG、PNG 或 WebP 图片；请先在手机相册中导出为兼容格式')
  }

  const saveImageBuffer = (projectId, buffer, name = 'ref') => {
    if (!Buffer.isBuffer(buffer) || !buffer.length) throw new Error('图片内容为空')
    const { ext, mime } = detectImageType(buffer)
    const filename = `${name}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}.${ext}`
    const folder = imagesOf(projectId)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, filename), buffer)
    return { filename, mime, size: buffer.length }
  }

  const saveImage = (projectId, dataUrl, name = 'ref') => {
    const match = String(dataUrl).match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
    if (!match) throw new Error('图片格式无效')
    return saveImageBuffer(projectId, Buffer.from(match[2], 'base64'), name).filename
  }

  const imagePath = (projectId, filename) => path.join(imagesOf(projectId), path.basename(filename))

  const imageDataUrl = (projectId, filename) => {
    const full = imagePath(projectId, filename)
    if (!filename || !fs.existsSync(full)) return ''
    const ext = path.extname(full).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`
  }

  const copyImage = (sourceProjectId, filename, targetProjectId) => {
    const source = imagePath(sourceProjectId, filename)
    if (!fs.existsSync(source)) throw new Error('素材文件不存在')
    const ext = ['.png', '.webp', '.jpg', '.jpeg'].includes(path.extname(source).toLowerCase()) ? path.extname(source).toLowerCase() : '.jpg'
    const targetName = `asset-${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`
    const targetFolder = imagesOf(targetProjectId)
    fs.mkdirSync(targetFolder, { recursive: true })
    fs.copyFileSync(source, path.join(targetFolder, targetName))
    return targetName
  }

  return { projectsDir, save, load, list, create, latest, saveImage, saveImageBuffer, imagePath, imageDataUrl, copyImage }
}
