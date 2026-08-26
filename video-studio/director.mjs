export const DIRECTOR_SYSTEM = `你是星绘视频工坊的对话导演。用户不懂工作流、节点和本地推理软件，永远不要提到这些词，也不要让用户选择引擎细节。
默认用本机生成草稿（不消耗云端视频次数）。只有用户明确说「用云端」「更好画质」「定妆成片」时，才把 engine 设为 cloud，并先在 say 里说明会消耗次数、等待确认后再 generate。
缺信息才提问：没说拍什么时才问内容；没说横竖屏则默认 16:9；没说时长则默认 18 秒（3 个连续 6 秒镜头）。人物有多张参考图时，提醒用户把图拖到对应镜头上。
你只输出一个 JSON 对象，不要 markdown。形状：
{"say":"对用户说的中文","actions":[...]}
可用 actions：
{"op":"update_brief","idea":"...","aspect":"16:9|9:16|1:1","duration":6|12|18,"engine":"local|cloud","title":"..."}
{"op":"create_storyboard"}
{"op":"rewrite_shot","shot":3,"instruction":"改成更震撼的蒙太奇"}
{"op":"generate","shots":"pending"|"all"|[1,3]}
{"op":"merge"}
shot 编号从 1 开始（S1=1）。用户说「开始拍/生成」就 generate pending。用户说「第三镜头改更震撼」就 rewrite_shot 然后 generate 该镜。分镜已有且用户没要求改时，不要重复 create_storyboard。`

export function extractJson(raw) {
  const cleaned = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error('导演未返回有效 JSON')
  return JSON.parse(cleaned.slice(start, end + 1))
}

export function snapshotForDirector(project) {
  return {
    title: project.title,
    idea: project.idea,
    aspect: project.aspect,
    duration: project.duration,
    engine: project.engine,
    finalUrl: project.finalUrl || '',
    shots: (project.shots || []).map((shot) => ({
      no: shot.index + 1,
      title: shot.title,
      description: shot.description,
      video_prompt: shot.video_prompt,
      status: shot.status,
      hasImage: Boolean(shot.imageFile),
      hasVideo: Boolean(shot.filename),
    })),
  }
}

export function parseShotNumber(text) {
  const source = String(text || '')
  const patterns = [/S\s*(\d+)/i, /镜头\s*(\d+)/, /第\s*([一二三四五六七八九十\d]+)\s*镜/, /第\s*(\d+)\s*个/]
  for (const pattern of patterns) {
    const match = source.match(pattern)
    if (!match) continue
    const token = match[1]
    const map = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }
    return map[token] || Number(token)
  }
  return 0
}

export function inferActions(userText, project) {
  const text = String(userText || '')
  const actions = []
  if (!project.idea && text.trim()) actions.push({ op: 'update_brief', idea: text.trim() })
  const shot = parseShotNumber(text)
  if (shot && /(改|换|更|重做|重新|震撼|慢一点|快一点)/.test(text)) {
    actions.push({ op: 'rewrite_shot', shot, instruction: text })
    if (!/(不要|别|先不)/.test(text)) actions.push({ op: 'generate', shots: [shot] })
    return actions
  }
  if (/(开始拍|开拍|开始生成|出片|继续拍)/.test(text) || (/(生成)/.test(text) && !/(不要|别|先不)/.test(text))) {
    actions.push({ op: 'generate', shots: 'pending' })
    return actions
  }
  if (/(合并|拼接|拼起来|成片)/.test(text) && (project.shots || []).filter((item) => item.filename).length >= 2) {
    actions.push({ op: 'merge' })
    return actions
  }
  if (!(project.shots || []).length && (project.idea || text.trim())) {
    if (!project.idea) actions.push({ op: 'update_brief', idea: text.trim() })
    actions.push({ op: 'create_storyboard' })
  }
  return actions
}

export function parseDirectorReply(raw, userText, project) {
  let parsed
  try { parsed = extractJson(raw) } catch { parsed = { say: String(raw || '').slice(0, 800), actions: [] } }
  const say = String(parsed.say || parsed.message || '').trim()
  let actions = Array.isArray(parsed.actions) ? parsed.actions : []
  if (!actions.length) actions = inferActions(userText, project)
  return { say: say || '我先根据你的话继续往下做。', actions }
}

export function resolveShotList(spec, project) {
  const shots = project.shots || []
  if (spec === 'all') return shots
  if (spec === 'pending' || spec == null) return shots.filter((item) => !item.taskId || item.status === 'Fail' || item.status === 'ready')
  const indexes = (Array.isArray(spec) ? spec : [spec]).map((value) => Number(value) - 1)
  return shots.filter((item) => indexes.includes(item.index))
}
