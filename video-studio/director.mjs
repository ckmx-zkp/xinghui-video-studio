import { jsonrepair } from 'jsonrepair'

const BRIEF_LABELS = {
  goal: '创作目标',
  audience: '目标受众',
  story: '故事主线',
  subject: '主体或角色',
  visualStyle: '视觉风格',
  tone: '情绪基调',
}

export function briefReadiness(project) {
  const brief = project.creativeBrief || {}
  const missing = Object.entries(BRIEF_LABELS).filter(([key]) => !String(brief[key] || '').trim()).map(([, label]) => label)
  const detailedRequest = String(project.idea || '').trim().length >= 120
  const minimumTurns = detailedRequest ? 1 : 3
  const turnsRemaining = Math.max(0, minimumTurns - Number(project.discoveryTurns || 0))
  return { ready: missing.length === 0 && turnsRemaining === 0, missing, turnsRemaining, minimumTurns }
}

export function directorSystemFor(project) {
  const readiness = briefReadiness(project)
  const phase = project.phase || 'discovery'
  return `你是星绘视频工坊的创作导演。你要像专业导演访谈一样逐步理解用户，而不是听到一句话就写分镜或开拍。
用户不懂模型、工作流、节点和推理软件，永远不要向用户提这些内部术语。

当前阶段：${phase}
简报是否可以送审：${readiness.ready ? '可以' : '不可以'}
仍缺信息：${readiness.missing.join('、') || '无'}
还需完成的发现对话轮数：${readiness.turnsRemaining}

通用规则：
1. 根据整段对话理解意图，每轮只问一个最有价值、容易回答的问题。不要一次发问卷。
2. 先用一两句话回应用户刚才的选择，再自然地提出下一问。
3. 当前消息包含参考图时，必须结合实际图像内容回答：先指出观察到的主体、环境、构图或风格事实，再说明这些事实对创作的影响。不要假装看到了不存在的内容，并区分观察与推断。
4. 用户允许你决定某项时，可以给出专业建议并把决定写入简报；不适用的字段写清楚“不适用”及原因。
5. update_brief 只更新本轮真正新增或改变的字段。用户选择风格、节奏或叙事选项时，不得把该选项文字覆盖为创作目标 goal。
6. 不得在聊天中直接开拍。视频生成只能由用户在分镜确认后点击独立按钮触发。
7. 每一轮都要先给出明确的专业见解，再给用户 2-4 个真正有差异的选择；选择应降低决策难度，但用户也可以自由回答。不要只给“是/否”。
8. 只输出一个 JSON 对象，不要 markdown：{"say":"给用户的中文回复","insight":"你基于当前信息作出的专业判断及理由","choices":[{"label":"选项短标题","description":"选择后的创作影响","reply":"用户选择此项时送回导演的完整回答"}],"actions":[]}

阶段规则：
- discovery：提炼用户回答并 update_brief。简报不可送审时必须继续问一个问题；可送审时可以 present_brief，但仍然不能生成创意方向或分镜。
- brief_review：复述和修改简报。用户需要在界面确认简报；聊天不能代替确认。
- concept_selection：帮助比较创意方向。用户需要在界面选择一个方向；如用户要求换一批，可 regenerate_concepts。
- storyboard_review：讨论和修改分镜，可 rewrite_shot。用户需要在界面确认分镜。
- quality_review：解释质量检查结果；需要修改时可建议用户返回分镜评审。
- ready_to_generate：说明已经可以开拍，引导用户点击开拍按钮；不得输出生成动作。
- generating：汇报状态、回答问题，不要重复提交任务。
- delivery_review：收集成片反馈。用户需要在界面确认交付或返回分镜返修。
- delivered：项目已经交付，只回答总结性问题。

actions 可选：
{"op":"update_brief","brief":{"goal":"","audience":"","platform":"","story":"","subject":"","visualStyle":"","tone":"","audio":"","constraints":"","referenceNotes":""},"aspect":"16:9|9:16|1:1","duration":6|12|18|24|30|36|42|48|54|60,"engine":"local|cloud","skill":"narrative-film|product-ad|social-koc|knowledge-video|custom-video","title":"..."}
{"op":"present_brief"}
{"op":"regenerate_concepts"}
{"op":"rewrite_shot","shot":3,"instruction":"..."}

不要输出 create_storyboard、generate 或 merge。不要声称已经执行 actions 之外的操作。`
}

export function extractJson(raw) {
  if (raw && typeof raw === 'object') return raw
  const cleaned = String(raw || '').replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```json|```/g, '').trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start < 0) throw new Error('导演未返回有效 JSON')
  const candidate = end >= start ? cleaned.slice(start, end + 1) : cleaned.slice(start)
  try {
    return JSON.parse(candidate)
  } catch {
    try { return JSON.parse(jsonrepair(candidate)) }
    catch { throw new Error('导演未返回有效 JSON') }
  }
}

export function completionText(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((item) => {
    if (typeof item === 'string') return item
    if (typeof item?.text === 'string') return item.text
    if (typeof item?.content === 'string') return item.content
    return ''
  }).join('')
}

export function snapshotForDirector(project) {
  return {
    title: project.title,
    idea: project.idea,
    aspect: project.aspect,
    duration: project.duration,
    engine: project.engine,
    skill: project.skill || 'custom-video',
    phase: project.phase || 'discovery',
    discoveryTurns: project.discoveryTurns || 0,
    creativeBrief: project.creativeBrief || {},
    briefReadiness: briefReadiness(project),
    concepts: (project.concepts || []).map((item) => ({ id: item.id, title: item.title, logline: item.logline })),
    selectedConceptId: project.selectedConceptId || '',
    productionPlan: project.productionPlan || [],
    qualityReview: project.qualityReview || null,
    referenceImageCount: (project.referenceImages || []).length,
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
  const insight = String(parsed.insight || '').trim().slice(0, 1000)
  const choices = (Array.isArray(parsed.choices) ? parsed.choices : []).slice(0, 4).map((item) => ({
    id: crypto.randomUUID(),
    label: String(item?.label || '').trim().slice(0, 80),
    description: String(item?.description || '').trim().slice(0, 300),
    reply: String(item?.reply || item?.label || '').trim().slice(0, 500),
  })).filter((item) => item.label && item.reply)
  return { say: say || '我先根据你的话继续往下做。', insight, choices, actions }
}

export function resolveShotList(spec, project) {
  const shots = project.shots || []
  if (spec === 'all') return shots
  if (spec === 'pending' || spec == null) return shots.filter((item) => !item.taskId || item.status === 'Fail' || item.status === 'ready')
  const indexes = (Array.isArray(spec) ? spec : [spec]).map((value) => Number(value) - 1)
  return shots.filter((item) => indexes.includes(item.index))
}
