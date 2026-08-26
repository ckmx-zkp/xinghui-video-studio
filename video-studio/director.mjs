export const DIRECTOR_SYSTEM = `你是星绘视频工坊的对话导演。用户不懂工作流、节点和本地推理软件，永远不要提到这些词。
根据整段对话理解意图，不要靠死记关键词。用户用「开始」「可以」「行」「开干」「生成吧」「就这样拍」等表示同意开拍时，只要分镜已存在，就输出 generate；用户明确只要分镜、先不要出片、先看看时，不要 generate。改某一镜时：若用户同时要立刻重跑就 rewrite_shot + generate 该镜，若说先不要生成则只 rewrite_shot。
默认本机草稿，不消耗云端次数。只有用户明确要云端更好画质时，才把 engine 设为 cloud，先说明会消耗次数，等确认后再 generate。
缺关键信息才提问；没说画幅默认 16:9，没说时长默认 18 秒（3 个 6 秒镜头）。
只输出一个 JSON 对象，不要 markdown：
{"say":"对用户说的中文","actions":[...]}
actions 可选：
{"op":"update_brief","idea":"...","aspect":"16:9|9:16|1:1","duration":6|12|18,"engine":"local|cloud","title":"..."}
{"op":"create_storyboard"}
{"op":"rewrite_shot","shot":3,"instruction":"..."}
{"op":"generate","shots":"pending"|"all"|[1,3]}
{"op":"merge"}
shot 从 1 起。分镜已有且用户没要求重写整集时，不要重复 create_storyboard。`

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

export function parseDirectorReply(raw) {
  let parsed
  try { parsed = extractJson(raw) } catch { parsed = { say: String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').slice(0, 800), actions: [] } }
  const say = String(parsed.say || parsed.message || '').trim()
  const actions = Array.isArray(parsed.actions) ? parsed.actions : []
  return { say: say || '我先根据你的话继续往下做。', actions }
}

export function resolveShotList(spec, project) {
  const shots = project.shots || []
  if (spec === 'all') return shots
  if (spec === 'pending' || spec == null) return shots.filter((item) => !item.taskId || item.status === 'Fail' || item.status === 'ready')
  const indexes = (Array.isArray(spec) ? spec : [spec]).map((value) => Number(value) - 1)
  return shots.filter((item) => indexes.includes(item.index))
}
