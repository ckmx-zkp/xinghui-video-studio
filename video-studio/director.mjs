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
  return { ready: missing.length === 0, missing, turnsRemaining: 0, minimumTurns: 0 }
}

const PHASE_ORDER = ['discovery', 'brief_review', 'concept_selection', 'storyboard_review', 'quality_review', 'ready_to_generate', 'generating', 'delivery_review', 'delivered']

export const PROCESS_STEPS = [
  { id: 'discovery', label: '需求访谈', gate: 'discovery' },
  { id: 'brief', label: '创作简报', gate: 'brief_review' },
  { id: 'concept', label: '创意方向', gate: 'concept_selection' },
  { id: 'storyboard', label: '分镜', gate: 'storyboard_review' },
  { id: 'generate', label: '出片', gate: 'ready_to_generate' },
  { id: 'delivery', label: '交付', gate: 'delivery_review' },
]

export function storyboardShotCount(project) {
  const requested = Number(project?.storyboardShotCount)
  if (Number.isInteger(requested) && requested >= 1 && requested <= 10) return requested
  return Math.max(1, Math.ceil((Number(project?.duration) || 18) / 6))
}

export function storyboardShotDurations(project, count) {
  const total = Math.max(5, Number(project?.duration) || 18)
  if (count === 1) return [total]
  const durations = Array.from({ length: count }, () => 6)
  durations[count - 1] = Math.max(5, total - 6 * (count - 1))
  return durations
}

// A shot list only matches the brief when its structure equals what the current
// duration and shot count imply. This catches stale storyboards even on legacy
// projects that were created before brief versions existed.
export function storyboardMatchesBrief(project) {
  const shots = Array.isArray(project?.shots) ? project.shots : []
  if (!shots.length) return true
  if (shots.length !== storyboardShotCount(project)) return false
  const durations = storyboardShotDurations(project, shots.length)
  return shots.every((shot, index) => Math.round(Number(shot?.duration || 6)) === Math.round(durations[index]))
}

const clampScore = (value) => Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
const average = (values) => {
  const items = values.filter((item) => Number.isFinite(item))
  return items.length ? items.reduce((sum, item) => sum + item, 0) / items.length : 0
}
const richness = (text, min = 6, good = 36) => {
  const n = String(text || '').trim().length
  if (!n) return 0
  if (n >= good) return 100
  if (n <= min) return Math.round(40 * n / min)
  return Math.round(40 + 60 * (n - min) / (good - min))
}
const pastPhase = (phase, gate) => PHASE_ORDER.indexOf(phase) > PHASE_ORDER.indexOf(gate)

export function buildProcessProgress(project) {
  const phase = PROJECT_PHASE(project)
  const brief = project.creativeBrief || {}
  const readiness = briefReadiness(project)
  const required = Object.keys(BRIEF_LABELS)
  const filled = required.filter((key) => String(brief[key] || '').trim()).length
  const concepts = Array.isArray(project.concepts) ? project.concepts : []
  const selected = concepts.find((item) => item.id === project.selectedConceptId)
  const shots = Array.isArray(project.shots) ? project.shots : []
  const expectedShots = storyboardShotCount(project)
  const successShots = shots.filter((item) => item.status === 'Success').length
  const failedShots = shots.filter((item) => item.status === 'Fail').length

  const discoveryDone = pastPhase(phase, 'discovery') || readiness.ready
  const discovery = {
    completeness: discoveryDone ? 100 : clampScore((filled / required.length) * 100),
    quality: clampScore(average(required.map((key) => richness(brief[key]))) + ((project.referenceImages || []).length ? 8 : 0)),
    missing: [
      ...readiness.missing,
    ].filter(Boolean),
  }

  const briefDone = Boolean(project.briefConfirmedAt) || pastPhase(phase, 'brief_review')
  const briefMissing = ['platform', 'audio', 'constraints'].filter((key) => !String(brief[key] || '').trim()).map((key) => ({ platform: '发布平台', audio: '声音', constraints: '边界' }[key]))
  const briefStep = {
    completeness: briefDone ? 100 : phase === 'brief_review' ? 85 : discoveryDone ? 55 : clampScore((filled / required.length) * 40),
    quality: clampScore(discovery.quality * 0.55 + richness(brief.platform) * 0.15 + richness(brief.audio) * 0.15 + richness(brief.constraints) * 0.15),
    missing: briefDone ? [] : briefMissing,
  }

  const conceptDone = Boolean(project.selectedConceptId) || pastPhase(phase, 'concept_selection')
  const conceptStep = {
    completeness: conceptDone ? 100 : concepts.length ? 55 : 0,
    quality: concepts.length
      ? clampScore(average(concepts.map((item) => average(['title', 'logline', 'narrative', 'visualHook', 'ending'].map((key) => richness(item[key], 4, 24))))) + (selected ? 6 : 0))
      : 0,
    missing: conceptDone ? [] : concepts.length ? ['还没选定创意方向'] : ['还没有创意方向'],
  }

  const storyboardDone = Boolean(project.storyboardConfirmedAt) || pastPhase(phase, 'storyboard_review')
  const weakPrompts = shots.filter((item) => String(item.video_prompt || '').trim().length < 40).length
  const reviewFails = (project.qualityReview?.checks || []).filter((item) => item.status === 'fail').map((item) => item.label)
  const storyboardStep = {
    completeness: storyboardDone ? 100 : shots.length ? clampScore(40 + 60 * Math.min(1, shots.length / expectedShots)) : 0,
    quality: clampScore(project.qualityReview?.score ?? (shots.length ? average(shots.map((item) => richness(item.video_prompt, 40, 180))) : 0)),
    missing: storyboardDone
      ? reviewFails
      : [
        shots.length ? '' : '还没有分镜',
        shots.length && shots.length < expectedShots ? `镜头数不足，目标 ${expectedShots} 镜` : '',
        weakPrompts ? `${weakPrompts} 个镜头提示过短` : '',
      ].filter(Boolean),
  }

  const generateDone = ['delivery_review', 'delivered'].includes(phase) && successShots === shots.length && shots.length > 0
  const generateStep = {
    completeness: generateDone
      ? 100
      : phase === 'ready_to_generate' ? 15
        : shots.length ? clampScore(100 * successShots / Math.max(shots.length, expectedShots))
          : 0,
    quality: shots.length ? clampScore((100 * successShots / shots.length) - failedShots * 12) : 0,
    missing: generateDone ? [] : [
      failedShots ? `${failedShots} 镜失败` : '',
      shots.filter((item) => item.taskId && !['Success', 'Fail'].includes(item.status)).length ? '生成仍在进行' : '',
      !shots.length ? '还没开拍' : '',
    ].filter(Boolean),
  }

  const deliveryDone = phase === 'delivered'
  const deliveryStep = {
    completeness: deliveryDone ? 100 : project.finalUrl ? 80 : 0,
    quality: project.finalError ? 35 : deliveryDone ? 92 : project.finalUrl ? 78 : 0,
    missing: deliveryDone ? [] : project.finalError ? [project.finalError] : project.finalUrl ? ['成片待确认交付'] : ['还没有成片'],
  }

  const byId = { discovery, brief: briefStep, concept: conceptStep, storyboard: storyboardStep, generate: generateStep, delivery: deliveryStep }
  const currentId = PROCESS_STEPS.find((item) => item.gate === phase)?.id
    || (phase === 'quality_review' ? 'storyboard' : phase === 'generating' ? 'generate' : PROCESS_STEPS[0].id)
  const steps = PROCESS_STEPS.map((item) => {
    const data = byId[item.id]
    const current = item.id === currentId
    const status = data.completeness >= 100 && !current ? 'done' : current ? 'active' : data.completeness > 0 ? 'active' : 'todo'
    return {
      id: item.id,
      label: item.label,
      completeness: data.completeness,
      quality: data.quality,
      status,
      current,
      missing: data.missing,
      canContinue: true,
      note: data.completeness >= 100
        ? '已完整，仍可继续对话修改'
        : data.missing[0] || '进行中',
    }
  })
  const scored = steps.filter((item) => item.completeness > 0 && item.quality > 0)
  return {
    overallCompleteness: clampScore(average(steps.map((item) => item.completeness))),
    overallQuality: scored.length ? clampScore(average(scored.map((item) => item.quality))) : 0,
    currentId,
    steps,
  }
}

function PROJECT_PHASE(project) {
  return PHASE_ORDER.includes(project?.phase) ? project.phase : 'discovery'
}

export function directorSystemFor(project) {
  const readiness = briefReadiness(project)
  const phase = project.phase || 'discovery'
  const progress = buildProcessProgress(project)
  const progressLine = progress.steps.map((item) => `${item.label}完整${item.completeness}%质量${item.quality}${item.missing.length ? `缺${item.missing.join('/')}` : ''}`).join('；')
  return `你是鲲鹏视频工坊的创作导演。你要像专业导演访谈一样逐步理解用户，而不是听到一句话就写分镜或开拍。
用户不懂模型、工作流、节点和推理软件，永远不要向用户提这些内部术语。

当前阶段：${phase}
制作完整度：${progress.overallCompleteness}%
过程质量：${progress.overallQuality}
各过程：${progressLine}
简报是否可以送审：${readiness.ready ? '可以' : '不可以'}
仍缺信息：${readiness.missing.join('、') || '无'}
已经形成的简报修订：${JSON.stringify((project.briefRevisions || []).slice(-6).map((item) => ({ fields: item.fields, insight: item.insight })))}
最近给过的选项：${JSON.stringify((project.messages || []).filter((item) => item.role === 'assistant' && item.choices?.length).slice(-4).flatMap((item) => item.choices).map(({ label, description }) => ({ label, description })))}
已经问过的关键决策：${JSON.stringify((project.decisionLedger || []).slice(-8).map(({ key, question, answer, status }) => ({ key, question, answer, status })))}

通用规则：
1. 根据整段对话理解意图。discovery 的第一轮可以问一个尚未决定、会实质改变成片的关键问题；用户回答后必须采用专业默认值补齐其余非关键项并立即形成可评审方案，不得继续采访。不得重复询问简报或关键决策记录里已有答案的事项。
2. 先明确说明本轮已经形成或更新了什么创作结论，再提出下一问。discovery 阶段每轮都必须用 update_brief 写入本轮新增或修正的产物字段；若用户没有提供新事实，采用有依据的专业默认值补齐最关键缺口。
3. 当前消息包含参考图时，必须结合实际图像内容回答：先指出观察到的主体、环境、构图或风格事实，再说明这些事实对创作的影响。不要假装看到了不存在的内容，并区分观察与推断。
4. 用户允许你决定某项时，可以给出专业建议并把决定写入简报；不适用的字段写清楚“不适用”及原因。
5. update_brief 只更新本轮真正新增或改变的字段。用户选择风格、节奏或叙事选项时，不得把该选项文字覆盖为创作目标 goal。
6. 不得在聊天中直接开拍。视频生成只能由用户在分镜确认后点击独立按钮触发。
7. 仅在 discovery 第一轮的关键问题或后续明确的阶段决策时给 2-4 个真正有差异的选择。普通修改回合 choices 必须为空。不得复用最近给过的选项，也不得用近义改写伪装成新选择。
8. 只输出一个 JSON 对象，不要 markdown：{"say":"给用户的中文回复","insight":"你基于当前信息作出的专业判断及理由","question":{"key":"稳定的英文决策键","text":"本轮唯一问题","importance":"为什么会改变结果"}|null,"choices":[{"label":"选项短标题","description":"选择后的创作影响","reply":"用户选择此项时送回导演的完整回答"}],"actions":[]}
9. 用户明确说“直接开始/直接制作/立即开始/开拍”时，这是授权你采用专业默认值的指令：本轮必须用 update_brief 补全全部相关简报字段，不得提问，choices 为空。服务端只会把产物送到下一道明确的 UI 审核门，不会在聊天中生成视频。
10. 完整度满只表示这一关可以往下走，不表示对话结束。任何阶段用户继续补充、改方向、改分镜时，必须吸收修改（update_brief / rewrite_shot / revise_storyboard / regenerate_concepts），并明确告诉用户“已经完整，仍可继续改”。不要因为某关已完整而拒绝交流或强迫进入下一关。
11. 用户明确要求只保留或删除某些镜头、改变镜头数量、把某镜扩展为唯一成片，或改变总时长时，不得只用 rewrite_shot 或口头复述；在 storyboard_review、quality_review、ready_to_generate 阶段必须输出 revise_storyboard，并给出完整 instruction、shotCount 和需要时的 duration。返修后的分镜必须与该动作一致，才可以重新审核。instruction 涉及目标、受众、故事、主体、风格、画幅或时长等简报级事实时，必须在 revise_storyboard 的 brief 字段里同步写出这些事实，服务端会同时重建制作标准文档，保证简报、制作标准与分镜一致。

阶段规则：
- discovery：第一轮提炼需求、用专业默认值形成尽可能完整的简报，同时只问一个最影响结果的问题并给出 question.key；用户回答该问题后吸收答案、补齐剩余字段并 present_brief，不得再问第二个问题。用户明确授权直接做时可跳过问题。
- brief_review：复述和修改简报。用户说“确认/好/继续/开始制作”时，如同时给出修改内容，先 update_brief；不要追问。服务端会负责进入下一道确认。用户若继续改简报，照样 update_brief。
- concept_selection：帮助比较创意方向。用户需要在界面选择一个方向；如用户要求换一批，可 regenerate_concepts。已选方向后若用户改口，仍可比较或换一批。
- storyboard_review：讨论和修改分镜，可 rewrite_shot。用户需要在界面确认分镜。分镜完整后仍可按用户意见改某一镜。
- quality_review：解释质量检查结果；用户要改分镜时用 rewrite_shot，不要只让用户点按钮。
- ready_to_generate：说明已经可以开拍，引导用户点击开拍按钮；不得输出生成动作。用户若继续改剧本或分镜，照样吸收。
- generating：汇报状态、回答问题，不要重复提交任务。用户仍可讨论成片和返修方向。
- delivery_review：收集成片反馈。用户需要在界面确认交付或返回分镜返修。
- delivered：项目已经交付，只回答总结性问题，用户仍可继续聊复盘。

actions 可选：
{"op":"update_brief","brief":{"goal":"","audience":"","platform":"","story":"","subject":"","visualStyle":"","tone":"","audio":"","constraints":"","referenceNotes":""},"aspect":"16:9|9:16|1:1","duration":"5-60的整数秒，常用6|10|12|18|24|30|36|42|48|54|60；用户给出约数时必须换算成整数写入 duration 字段，不要只写进文字","engine":"local|cloud","skill":"narrative-film|product-ad|social-koc|knowledge-video|custom-video","title":"..."}
{"op":"present_brief"}
{"op":"regenerate_concepts"}
{"op":"rewrite_shot","shot":3,"instruction":"..."}
{"op":"revise_storyboard","instruction":"完整的结构性分镜返修要求","shotCount":1,"duration":10,"brief":{"story":"","audio":"","constraints":""}}

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
    processProgress: buildProcessProgress(project),
    concepts: (project.concepts || []).map((item) => ({ id: item.id, title: item.title, logline: item.logline })),
    selectedConceptId: project.selectedConceptId || '',
    productionPlan: project.productionPlan || [],
    briefRevisions: (project.briefRevisions || []).slice(-6),
    decisionLedger: (project.decisionLedger || []).slice(-8),
    textArtifacts: (project.textArtifacts || []).slice(-8).map((item) => ({ id: item.id, type: item.type, title: item.title, version: item.version, summary: item.summary })),
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
  const question = parsed.question && typeof parsed.question === 'object' ? {
    key: String(parsed.question.key || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80),
    text: String(parsed.question.text || '').trim().slice(0, 300),
    importance: String(parsed.question.importance || '').trim().slice(0, 300),
  } : null
  const choices = (Array.isArray(parsed.choices) ? parsed.choices : []).slice(0, 4).map((item) => ({
    id: crypto.randomUUID(),
    label: String(item?.label || '').trim().slice(0, 80),
    description: String(item?.description || '').trim().slice(0, 300),
    reply: String(item?.reply || item?.label || '').trim().slice(0, 500),
  })).filter((item) => item.label && item.reply)
  return { say: say || '我先根据你的话继续往下做。', insight, question: question?.key && question?.text ? question : null, choices, actions }
}

const choiceText = (choice) => `${choice?.label || ''}${choice?.description || ''}`.toLowerCase().replace(/[\s，。！？、,.!?:：;；“”'"（）()\-_]/g, '')
const bigrams = (value) => {
  if (value.length < 2) return new Set(value ? [value] : [])
  return new Set(Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2)))
}
const choiceSimilarity = (left, right) => {
  const leftText = choiceText(left)
  const rightText = choiceText(right)
  const a = bigrams(leftText)
  const b = bigrams(rightText)
  const leftChars = new Set(leftText)
  const rightChars = new Set(rightText)
  if (!a.size || !b.size || !leftChars.size || !rightChars.size) return 0
  let sharedBigrams = 0
  let sharedChars = 0
  for (const item of a) if (b.has(item)) sharedBigrams += 1
  for (const item of leftChars) if (rightChars.has(item)) sharedChars += 1
  return Math.max(
    sharedBigrams / Math.min(a.size, b.size),
    sharedChars / Math.min(leftChars.size, rightChars.size),
  )
}

export function dedupeDirectorChoices(choices, previousChoices = []) {
  const kept = []
  for (const choice of choices || []) {
    if ([...previousChoices, ...kept].some((previous) => choiceSimilarity(choice, previous) >= 0.72)) continue
    kept.push(choice)
  }
  return kept.slice(0, 4)
}

export function resolveShotList(spec, project) {
  const shots = project.shots || []
  if (spec === 'all') return shots
  if (spec === 'pending' || spec == null) return shots.filter((item) => !item.taskId || item.status === 'Fail' || item.status === 'ready')
  const indexes = (Array.isArray(spec) ? spec : [spec]).map((value) => Number(value) - 1)
  return shots.filter((item) => indexes.includes(item.index))
}
