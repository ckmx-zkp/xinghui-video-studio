import fs from 'node:fs'
import path from 'node:path'

export function createProjectStore(root) {
  const projectsDir = path.join(root, 'outputs', 'projects')
  fs.mkdirSync(projectsDir, { recursive: true })

  const dirOf = (id) => path.join(projectsDir, id)
  const fileOf = (id) => path.join(dirOf(id), 'project.json')
  const imagesOf = (id) => path.join(dirOf(id), 'images')

  const empty = () => ({
    id: crypto.randomUUID(),
    title: '未命名项目',
    idea: '',
    aspect: '16:9',
    duration: 18,
    engine: 'local',
    shots: [],
    messages: [],
    finalUrl: '',
    finalFilename: '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const save = (project) => {
    const dir = dirOf(project.id)
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true })
    project.updatedAt = new Date().toISOString()
    fs.writeFileSync(fileOf(project.id), JSON.stringify(project, null, 2))
    return project
  }

  const load = (id) => {
    const file = fileOf(id)
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  }

  const list = () => {
    if (!fs.existsSync(projectsDir)) return []
    return fs.readdirSync(projectsDir).map((id) => {
      try { return load(id) } catch { return null }
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
  }

  const create = (patch = {}) => save({ ...empty(), ...patch })

  const latest = () => list()[0] || create()

  const saveImage = (projectId, dataUrl, name = 'ref') => {
    const match = String(dataUrl).match(/^data:(image\/[\w.+-]+);base64,(.+)$/)
    if (!match) throw new Error('图片格式无效')
    const ext = match[1].includes('png') ? 'png' : match[1].includes('webp') ? 'webp' : 'jpg'
    const filename = `${name}-${Date.now()}.${ext}`
    const folder = imagesOf(projectId)
    fs.mkdirSync(folder, { recursive: true })
    fs.writeFileSync(path.join(folder, filename), Buffer.from(match[2], 'base64'))
    return filename
  }

  const imagePath = (projectId, filename) => path.join(imagesOf(projectId), path.basename(filename))

  const imageDataUrl = (projectId, filename) => {
    const full = imagePath(projectId, filename)
    if (!filename || !fs.existsSync(full)) return ''
    const ext = path.extname(full).toLowerCase()
    const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
    return `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`
  }

  return { projectsDir, save, load, list, create, latest, saveImage, imagePath, imageDataUrl }
}
