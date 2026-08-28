import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { briefReadiness, buildProcessProgress, completionText, dedupeDirectorChoices, detectStructuralRevision, extractJson, parseDirectorReply, resolveShotList, storyboardMatchesBrief } from '../director.mjs'

// server.mjs reads its runtime modes at import time, so the demo switch must be
// set before the dynamic import below. Director replies in tests therefore come
// from the fixed demo generator and never reach the real MiniMax API.
let app
let answerPendingDecision
let applyActions
let applyDirectorDefaults
let comfyStageForNode
let currentTextStandards
let historyForDirector
let invalidateDownstreamForStandards
let isAdvanceIntent
let isDirectStartIntent
let recordDirectorQuestion
let resolveRuntimeModes
let storyboardShotCount
let storyboardShotDurations
let storeTextArtifacts

let root
let server
let baseUrl
const createdProjects = []

before(async () => {
  process.env.STUDIO_DIRECTOR_DEMO_MODE = '1'
  process.env.STUDIO_LOGIN_PASSWORDS = 'test-pass,1q1qwwww'
  process.env.STUDIO_COOKIE_SECRET = 'test-secret'
  ;({
    app,
    answerPendingDecision,
    applyActions,
    applyDirectorDefaults,
    comfyStageForNode,
    currentTextStandards,
    historyForDirector,
    invalidateDownstreamForStandards,
    isAdvanceIntent,
    isDirectStartIntent,
    recordDirectorQuestion,
    resolveRuntimeModes,
    storyboardShotCount,
    storyboardShotDurations,
    storeTextArtifacts,
  } = await import('../server.mjs'))
  const here = path.dirname(fileURLToPath(import.meta.url))
  root = path.resolve(here, '../..')
  server = app.listen(0, '127.0.0.1')
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve) => server.close(resolve))
  for (const id of createdProjects) {
    const folder = path.join(root, 'outputs', 'projects', id)
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

describe('director workflow contract', () => {
  const completeBrief = {
    goal: '制作新品广告',
    audience: '城市通勤人群',
    story: '从嘈杂通勤切换到安静沉浸体验',
    subject: '一名年轻通勤者和无线耳机',
    visualStyle: '克制、现代、真实摄影',
    tone: '先紧张后放松',
  }

  it('does not force extra interview turns after the brief is complete', () => {
    const result = briefReadiness({ idea: '做一个耳机广告', discoveryTurns: 1, creativeBrief: completeBrief })
    assert.equal(result.ready, true)
    assert.equal(result.turnsRemaining, 0)
  })

  it('allows review after discovery is complete', () => {
    const result = briefReadiness({ idea: '做一个耳机广告', discoveryTurns: 3, creativeBrief: completeBrief })
    assert.equal(result.ready, true)
    assert.deepEqual(result.missing, [])
  })

  it('exposes per-process completeness and quality without locking conversation', () => {
    const empty = buildProcessProgress({ phase: 'discovery', discoveryTurns: 0, creativeBrief: {}, shots: [], concepts: [] })
    assert.equal(empty.steps.length, 6)
    assert.ok(empty.overallCompleteness < 40)
    assert.equal(empty.steps[0].canContinue, true)
    assert.match(empty.steps[0].missing.join(), /创作目标/)

    const readyDiscovery = buildProcessProgress({
      phase: 'brief_review',
      discoveryTurns: 3,
      creativeBrief: completeBrief,
      shots: [],
      concepts: [],
    })
    assert.equal(readyDiscovery.steps.find((item) => item.id === 'discovery')?.completeness, 100)
    assert.match(readyDiscovery.steps.find((item) => item.id === 'discovery')?.note || '', /仍可继续/)

    const scoredBoard = buildProcessProgress({
      phase: 'generating',
      discoveryTurns: 3,
      briefConfirmedAt: '2026-08-28',
      storyboardConfirmedAt: '2026-08-28',
      selectedConceptId: 'c1',
      creativeBrief: completeBrief,
      concepts: [{ id: 'c1', title: '方向A', logline: '一句话故事成立', narrative: '有完整叙事方法', visualHook: '记忆点清晰', ending: '收束明确' }],
      shots: [
        { status: 'Success', video_prompt: 'a'.repeat(80) },
        { status: 'Processing', video_prompt: 'b'.repeat(80) },
        { status: 'Queueing', video_prompt: 'c'.repeat(80) },
      ],
      duration: 18,
      qualityReview: { score: 58, verdict: 'revise', checks: [{ status: 'fail', label: '画幅' }] },
    })
    assert.equal(scoredBoard.steps.find((item) => item.id === 'storyboard')?.quality, 58)
    assert.equal(scoredBoard.steps.find((item) => item.id === 'generate')?.current, true)
    assert.ok((scoredBoard.steps.find((item) => item.id === 'generate')?.completeness || 0) < 100)
  })

  it('parses professional insight and selectable replies', () => {
    const parsed = parseDirectorReply(JSON.stringify({
      say: '这个题材适合先确定情绪入口。',
      insight: '从通勤噪声切入能最快建立产品价值。',
      question: { key: 'primary_expression', text: '更偏真实还是视觉风格？', importance: '改变脚本入口' },
      choices: [
        { label: '现实通勤', description: '强调真实共鸣', reply: '选择现实通勤方向' },
        { label: '视觉隐喻', description: '强调品牌质感', reply: '选择视觉隐喻方向' },
      ],
      actions: [],
    }))
    assert.match(parsed.insight, /通勤噪声/)
    assert.equal(parsed.choices.length, 2)
    assert.equal(parsed.choices[1].reply, '选择视觉隐喻方向')
    assert.equal(parsed.question.key, 'primary_expression')
  })

  it('records one keyed decision and resolves it without accepting duplicates', () => {
    const project = { decisionLedger: [] }
    const question = { key: 'primary_expression', text: '更偏真实还是视觉风格？', importance: '改变脚本入口' }
    assert.ok(recordDirectorQuestion(project, question))
    assert.equal(recordDirectorQuestion(project, question), null)
    assert.equal(answerPendingDecision(project, '更偏真实共鸣'), project.decisionLedger[0])
    assert.equal(project.decisionLedger[0].status, 'answered')
    assert.equal(answerPendingDecision(project, '重复回答'), null)
  })

  it('versions text artifacts instead of overwriting prior work', () => {
    const project = { textArtifacts: [] }
    const first = storeTextArtifacts(project, [{ type: 'script', title: '完整脚本', summary: '首版', content: { opening: '开场A' } }], 'MiniMax-M3')
    const second = storeTextArtifacts(project, [{ type: 'script', title: '完整脚本', summary: '修订版', content: { opening: '开场B' } }], 'MiniMax-M3')
    assert.equal(first[0].version, 1)
    assert.equal(second[0].version, 2)
    assert.equal(project.textArtifacts.length, 2)
    assert.equal(project.textArtifacts[0].status, 'superseded')
    assert.deepEqual(project.textArtifacts[1].sourceArtifactIds, [project.textArtifacts[0].id])
    assert.deepEqual(currentTextStandards(project).map((item) => item.content.opening), ['开场B'])
  })

  it('invalidates stale downstream work while preserving standards and source assets', () => {
    const project = {
      phase: 'delivered', finalUrl: '/media/final.mp4', finalFilename: 'final.mp4', deliveredAt: '2026-08-28',
      briefConfirmedAt: 'yes', storyboardConfirmedAt: 'yes', concepts: [{ id: 'c1' }], selectedConceptId: 'c1',
      productionPlan: [{ id: 'p1' }], shots: [{ id: 's1' }], qualityReview: { score: 90 }, referenceImages: ['ref.png'],
      textArtifacts: [{ id: 'a1', type: 'script', status: 'current' }], previousRenders: [],
    }
    invalidateDownstreamForStandards(project)
    assert.equal(project.phase, 'brief_review')
    assert.deepEqual(project.concepts, [])
    assert.deepEqual(project.shots, [])
    assert.equal(project.qualityReview, null)
    assert.deepEqual(project.referenceImages, ['ref.png'])
    assert.equal(project.textArtifacts.length, 1)
    assert.equal(project.previousRenders.length, 1)
  })

  it('removes repeated or near-identical director choices', () => {
    const previous = [{ label: '现实通勤', description: '用地铁噪声建立真实共鸣' }]
    const choices = dedupeDirectorChoices([
      { label: '真实通勤', description: '从地铁噪声切入建立现实共鸣', reply: '选择真实通勤' },
      { label: '抽象静音世界', description: '用视觉隐喻突出降噪', reply: '选择抽象静音世界' },
    ], previous)
    assert.deepEqual(choices.map((item) => item.label), ['抽象静音世界'])
  })

  it('repairs common near-JSON output from the director model', () => {
    const parsed = extractJson('{"say":"继续","insight":"画面成立","choices":[{"label":"方向A","reply":"选择A"},{"label":"方向B","reply":"选择B"}],')
    assert.equal(parsed.say, '继续')
    assert.equal(parsed.choices.length, 2)
  })

  it('reads text from segmented completion content', () => {
    assert.equal(completionText({ content: [
      { type: 'text', text: '{"say":"继续",' },
      { type: 'text', text: '"actions":[]}' },
    ] }), '{"say":"继续","actions":[]}')
  })

  it('resolves only pending or explicitly selected shots', () => {
    const project = { shots: [
      { index: 0, status: 'Success', taskId: 'done' },
      { index: 1, status: 'ready' },
      { index: 2, status: 'Fail', taskId: 'failed' },
    ] }
    assert.deepEqual(resolveShotList('pending', project).map((item) => item.index), [1, 2])
    assert.deepEqual(resolveShotList([1, 3], project).map((item) => item.index), [0, 2])
  })

  it('keeps a structural revision as one exact-duration shot', () => {
    const project = { duration: 10, storyboardShotCount: 1 }
    assert.equal(storyboardShotCount(project), 1)
    assert.deepEqual(storyboardShotDurations(project, 1), [10])
  })
})

describe('runtime mode isolation', () => {
  it('keeps the legacy demo switch limited to simulated video output', () => {
    assert.deepEqual(resolveRuntimeModes({ STUDIO_DEMO_MODE: '1' }), {
      directorDemoMode: false,
      videoDemoMode: true,
    })
  })

  it('requires an explicit switch before using fixed director replies', () => {
    assert.deepEqual(resolveRuntimeModes({ STUDIO_DIRECTOR_DEMO_MODE: '1' }), {
      directorDemoMode: true,
      videoDemoMode: false,
    })
  })
})

describe('ComfyUI progress semantics', () => {
  it('shows sampler progress as an estimate range when ComfyUI has no step counter', () => {
    assert.deepEqual(comfyStageForNode('12'), { key: 'sampling', label: '采样生成视频帧', min: 12, max: 85 })
    assert.equal(comfyStageForNode('14').key, 'decode')
    assert.equal(comfyStageForNode(undefined).key, 'working')
  })
})

describe('natural-language planning confirmations', () => {
  it('recognizes short Chinese confirmations without treating creative detail as a no-op', () => {
    for (const text of ['好', '确认', '继续', '直接开始', '开始制作视频！']) assert.equal(isAdvanceIntent(text), true)
    assert.equal(isAdvanceIntent('小狗在推车里开心玩耍，儿童奶音，然后开始制作'), true)
    assert.equal(isAdvanceIntent('把小狗换成黑色'), false)
    assert.equal(isAdvanceIntent('小狗从家里开始跑'), false)
  })

  it('treats direct start as a distinct instruction and fills safe planning defaults', () => {
    assert.equal(isDirectStartIntent('直接开始制作视频！'), true)
    assert.equal(isDirectStartIntent('直接开始制作一个智能酒店控制面板宣传片'), true)
    assert.equal(isDirectStartIntent('继续'), false)
    assert.equal(isDirectStartIntent('现在不要开拍'), false)
    assert.equal(isDirectStartIntent('先不直接制作，我还要补充资料'), false)
    const project = { idea: '小狗坐推车兜风', creativeBrief: { goal: '小狗坐推车兜风' } }
    applyDirectorDefaults(project)
    for (const key of ['goal', 'audience', 'story', 'subject', 'visualStyle', 'tone']) assert.ok(project.creativeBrief[key])
    assert.match(project.creativeBrief.audio, /不阻塞生成/)
  })
})

describe('multimodal director messages', () => {
  it('adds the current image to the final user turn only', () => {
    const history = historyForDirector([
      { role: 'user', content: '上一轮描述', attachments: [{ url: 'old-image' }] },
      { role: 'assistant', content: '上一轮回答' },
      { role: 'user', content: '请根据这张图做短片' },
    ], ['data:image/png;base64,current'])
    assert.equal(history[0].content, '上一轮描述')
    assert.deepEqual(history[2].content, [
      { type: 'text', text: '请根据这张图做短片' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,current' } },
    ])
  })
})

describe('server phase gates', () => {
  it('uploads a mobile reference image before sending chat text', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lZ5K8QAAAABJRU5ErkJggg==', 'base64')
    const form = new FormData()
    form.append('image', new Blob([png], { type: 'image/png' }), 'phone-reference.png')

    const response = await fetch(`${baseUrl}/api/projects/${created.id}/images`, { method: 'POST', body: form })
    assert.equal(response.status, 201)
    const body = await response.json()
    assert.equal(body.attachment.type, 'image')
    assert.equal(body.attachment.mime, 'image/png')
    assert.deepEqual(body.project.referenceImages, [body.attachment.id])
    assert.equal(fs.existsSync(path.join(root, 'outputs', 'projects', created.id, 'images', body.attachment.filename)), true)
  })

  it('disables legacy direct-generation endpoints', async () => {
    const response = await fetch(`${baseUrl}/api/cloud/generate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
    assert.equal(response.status, 410)
  })

  it('does not fall back to the latest project for an unknown id', async () => {
    const response = await fetch(`${baseUrl}/api/projects/not-a-project/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '开始拍摄' }),
    })
    assert.equal(response.status, 404)
  })

  it('rejects generation before all review gates are complete', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const response = await fetch(`${baseUrl}/api/projects/${created.id}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shots: 'pending' }),
    })
    assert.equal(response.status, 409)
    const body = await response.json()
    assert.match(body.error, /确认创作简报和分镜/)
  })

  it('prepares a delivered project for a second shoot without deleting source assets', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    const delivered = {
      ...created,
      phase: 'delivered',
      deliveredAt: '2026-08-28T00:00:00.000Z',
      finalUrl: '/media/final.mp4',
      finalFilename: 'final.mp4',
      shots: [{ id: 'shot-1', index: 0, title: '开场', description: '主体入场', video_prompt: '可执行提示词', status: 'Success', taskId: 'task-1', filename: 'shot-1.mp4', imageFile: 'reference.png' }],
    }
    fs.writeFileSync(file, JSON.stringify(delivered, null, 2))

    const response = await fetch(`${baseUrl}/api/projects/${created.id}/prepare-reshoot`, { method: 'POST' })
    assert.equal(response.status, 200)
    const project = await response.json()
    assert.equal(project.phase, 'ready_to_generate')
    assert.equal(project.previousRenders.length, 1)
    assert.equal(project.shots[0].status, 'ready')
    assert.equal(project.shots[0].imageFile, 'reference.png')
    assert.equal(project.shots[0].taskId, undefined)
    assert.equal(project.shots[0].filename, undefined)
    assert.equal(project.finalUrl, '')
  })

  it('saves edited right-rail artifacts as the new production standard', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    const ready = {
      ...created,
      phase: 'ready_to_generate',
      creativeBrief: { ...created.creativeBrief, goal: '旧目标', audience: '旧受众', story: '旧故事', subject: '旧主体', visualStyle: '旧风格', tone: '旧基调' },
      textArtifacts: [{ id: 'script-v1', type: 'script', title: '完整脚本', summary: '旧版', version: 1, status: 'current', content: { timeline: ['0-6秒：旧画面'], voiceover: '旧旁白' }, sourceArtifactIds: [], model: 'MiniMax-M3', createdAt: '2026-08-28' }],
      concepts: [{ id: 'c1' }], selectedConceptId: 'c1', shots: [{ id: 's1', index: 0, status: 'ready' }], qualityReview: { score: 88 },
      briefConfirmedAt: 'yes', storyboardConfirmedAt: 'yes',
    }
    fs.writeFileSync(file, JSON.stringify(ready, null, 2))

    const response = await fetch(`${baseUrl}/api/projects/${created.id}/update-artifacts`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        settings: { title: '新版项目', aspect: '9:16', duration: 30, engine: 'local', skill: 'product-ad' },
        creativeBrief: { ...ready.creativeBrief, goal: '新版销售目标' },
        artifacts: [{ type: 'script', title: '完整脚本', summary: '手工修订', content: { timeline: '0-6秒：新版画面\n6-12秒：新版转折', voiceover: '新版旁白' } }],
      }),
    })
    assert.equal(response.status, 200)
    const project = await response.json()
    assert.equal(project.phase, 'brief_review')
    assert.equal(project.title, '新版项目')
    assert.equal(project.creativeBrief.goal, '新版销售目标')
    assert.equal(project.shots.length, 0)
    assert.equal(project.qualityReview, null)
    const scripts = project.textArtifacts.filter((item) => item.type === 'script')
    assert.equal(scripts.length, 2)
    assert.equal(scripts[0].status, 'superseded')
    assert.equal(scripts[1].version, 2)
    assert.equal(scripts[1].model, 'user')
    assert.deepEqual(scripts[1].content.timeline, ['0-6秒：新版画面', '6-12秒：新版转折'])
  })
})

describe('brief and storyboard consistency', () => {
  const fullBrief = {
    goal: '制作新品广告', audience: '城市通勤人群', platform: '短视频平台', story: '从嘈杂通勤切换到安静沉浸体验',
    subject: '一名年轻通勤者和无线耳机', visualStyle: '克制、现代、真实摄影', tone: '先紧张后放松',
    audio: '环境音为主', constraints: '避免复杂群像', referenceNotes: '',
  }

  it('records brief revisions after delivery without resetting the phase or assets', async () => {
    const project = {
      phase: 'delivered',
      briefVersion: 3,
      storyboardBriefVersion: 3,
      creativeBrief: { ...fullBrief, story: '旧故事主线' },
      shots: [{ id: 's1', index: 0, status: 'Success', filename: 'shot-1.mp4' }],
      messages: [],
    }
    const notes = []
    await applyActions(project, [{ op: 'update_brief', brief: { story: '新故事主线' } }], notes)
    assert.equal(project.creativeBrief.story, '新故事主线')
    assert.equal(project.briefVersion, 4)
    assert.notEqual(project.briefVersion, project.storyboardBriefVersion)
    assert.equal(project.phase, 'delivered')
    assert.equal(project.shots.length, 1)
    assert.match(notes.join(''), /重建分镜/)
  })

  it('invalidates storyboard confirmation when the brief changes before generation', async () => {
    const project = {
      phase: 'ready_to_generate',
      briefVersion: 2,
      storyboardBriefVersion: 2,
      storyboardConfirmedAt: 'yes',
      qualityReview: { score: 90 },
      creativeBrief: { ...fullBrief, story: '旧故事' },
      shots: [{ id: 's1', index: 0, status: 'ready' }],
      messages: [],
    }
    const notes = []
    await applyActions(project, [{ op: 'update_brief', brief: { story: '新故事' } }], notes)
    assert.equal(project.phase, 'storyboard_review')
    assert.equal(project.storyboardConfirmedAt, '')
    assert.equal(project.qualityReview, null)
    assert.equal(project.briefVersion, 3)
    assert.match(notes.join(''), /旧版简报/)
  })

  it('keeps the storyboard confirmed for engine-only changes', async () => {
    const project = {
      phase: 'ready_to_generate',
      briefVersion: 2,
      storyboardBriefVersion: 2,
      storyboardConfirmedAt: 'yes',
      creativeBrief: { ...fullBrief },
      shots: [{ id: 's1', index: 0, status: 'ready' }],
      messages: [],
    }
    const notes = []
    await applyActions(project, [{ op: 'update_brief', engine: 'cloud' }], notes)
    assert.equal(project.engine, 'cloud')
    assert.equal(project.phase, 'ready_to_generate')
    assert.equal(project.storyboardConfirmedAt, 'yes')
    assert.equal(project.briefVersion, 3)
  })

  it('detects structure drift between brief and storyboard regardless of versions', () => {
    assert.equal(storyboardMatchesBrief({ duration: 18, shots: [{ duration: 6 }, { duration: 6 }, { duration: 6 }] }), true)
    assert.equal(storyboardMatchesBrief({ duration: 10, shots: [{ duration: 6 }, { duration: 6 }, { duration: 6 }] }), false)
    assert.equal(storyboardMatchesBrief({ duration: 10, shots: [{ duration: 6 }, { duration: 5 }] }), true)
    assert.equal(storyboardMatchesBrief({ duration: 10, storyboardShotCount: 1, shots: [{ duration: 10 }] }), true)
    assert.equal(storyboardMatchesBrief({ duration: 18, shots: [] }), true)
  })

  it('blocks confirm and generate on a storyboard that predates the current brief', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    const base = {
      ...created,
      duration: 10,
      briefVersion: 1,
      storyboardBriefVersion: 1,
      selectedConceptId: 'c1',
      concepts: [{ id: 'c1', title: '方向A', logline: '一句话故事成立', narrative: '完整叙事', visualHook: '记忆点', ending: '收束' }],
      shots: [
        { id: 'a', index: 0, title: '一', description: '描述', video_prompt: '提示词一', status: 'ready', duration: 6 },
        { id: 'b', index: 1, title: '二', description: '描述', video_prompt: '提示词二', status: 'ready', duration: 6 },
        { id: 'c', index: 2, title: '三', description: '描述', video_prompt: '提示词三', status: 'ready', duration: 6 },
      ],
    }
    fs.writeFileSync(file, JSON.stringify({ ...base, phase: 'storyboard_review' }, null, 2))

    const confirmed = await fetch(`${baseUrl}/api/projects/${created.id}/confirm-storyboard`, { method: 'POST' })
    assert.equal(confirmed.status, 409)
    assert.match((await confirmed.json()).error, /旧版创作简报/)

    const stale = await fetch(`${baseUrl}/api/projects/${created.id}`).then((response) => response.json())
    assert.equal(stale.briefStale, true)

    fs.writeFileSync(file, JSON.stringify({
      ...base,
      phase: 'ready_to_generate',
      storyboardConfirmedAt: 'yes',
      qualityReview: { score: 90, verdict: 'pass', summary: '通过', checks: [], recommendations: [] },
    }, null, 2))
    const generated = await fetch(`${baseUrl}/api/projects/${created.id}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shots: 'pending' }),
    })
    assert.equal(generated.status, 409)
    assert.match((await generated.json()).error, /阻止开拍/)
  })

  it('lets confirmation proceed once the storyboard matches the brief again', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    fs.writeFileSync(file, JSON.stringify({
      ...created,
      phase: 'storyboard_review',
      duration: 10,
      briefVersion: 2,
      storyboardBriefVersion: 2,
      selectedConceptId: 'c1',
      concepts: [{ id: 'c1', title: '方向A', logline: '一句话故事成立', narrative: '完整叙事', visualHook: '记忆点', ending: '收束' }],
      shots: [
        { id: 'a', index: 0, title: '一', description: '描述', video_prompt: '提示词一', status: 'ready', duration: 6 },
        { id: 'b', index: 1, title: '二', description: '描述', video_prompt: '提示词二', status: 'ready', duration: 5 },
      ],
    }, null, 2))

    const confirmed = await fetch(`${baseUrl}/api/projects/${created.id}/confirm-storyboard`, { method: 'POST' })
    assert.equal(confirmed.status, 200)
    const project = await confirmed.json()
    assert.equal(project.phase, 'quality_review')
    assert.equal(project.briefStale, false)
  })

  it('rebuilds the storyboard and standards from the updated brief before a reshoot', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    const delivered = {
      ...created,
      phase: 'delivered',
      deliveredAt: '2026-08-28T00:00:00.000Z',
      finalUrl: '/media/final.mp4',
      finalFilename: 'final.mp4',
      duration: 18,
      briefVersion: 2,
      storyboardBriefVersion: 1,
      selectedConceptId: 'c1',
      concepts: [{ id: 'c1', title: '方向A', logline: '一句话故事成立', narrative: '完整叙事', visualHook: '记忆点', ending: '收束' }],
      shots: [{ id: 'shot-1', index: 0, title: '开场', description: '主体入场', video_prompt: '旧版提示词', status: 'Success', taskId: 'task-1', filename: 'shot-1.mp4' }],
    }
    fs.writeFileSync(file, JSON.stringify(delivered, null, 2))

    const response = await fetch(`${baseUrl}/api/projects/${created.id}/prepare-reshoot`, { method: 'POST' })
    assert.equal(response.status, 200)
    const project = await response.json()
    assert.equal(project.phase, 'storyboard_review')
    assert.equal(project.previousRenders.length, 1)
    assert.equal(project.shots.length, 3)
    assert.notEqual(project.shots[0].video_prompt, '旧版提示词')
    assert.equal(project.storyboardBriefVersion, project.briefVersion)
    assert.equal(project.briefStale, false)
    assert.match(project.storyboardRevisionInstruction, /最新创作简报/)
    assert.ok(project.textArtifacts.filter((item) => item.type === 'script').length >= 1)
    assert.ok(project.textArtifacts.length >= 4)
  })
})

describe('engine switching and asset library', () => {
  it('switches engine at project and per-shot level without invalidating the storyboard', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    fs.writeFileSync(file, JSON.stringify({
      ...created,
      phase: 'ready_to_generate',
      duration: 18,
      briefVersion: 1,
      storyboardBriefVersion: 1,
      selectedConceptId: 'c1',
      concepts: [{ id: 'c1', title: 'A', logline: 'l', narrative: 'n', visualHook: 'v', ending: 'e' }],
      shots: [
        { id: 'a', index: 0, title: '一', description: 'd', video_prompt: 'p1', status: 'ready', duration: 6 },
        { id: 'b', index: 1, title: '二', description: 'd', video_prompt: 'p2', status: 'ready', duration: 6 },
        { id: 'c', index: 2, title: '三', description: 'd', video_prompt: 'p3', status: 'ready', duration: 6 },
      ],
    }, null, 2))

    const engineSwitch = await fetch(`${baseUrl}/api/projects/${created.id}/set-engine`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'cloud' }),
    })
    assert.equal(engineSwitch.status, 200)
    const withEngine = await engineSwitch.json()
    assert.equal(withEngine.engine, 'cloud')
    assert.equal(withEngine.phase, 'ready_to_generate')
    assert.equal(withEngine.shots.length, 3)

    const shotEngine = await fetch(`${baseUrl}/api/projects/${created.id}/shots/2/engine`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ engine: 'local' }),
    })
    assert.equal(shotEngine.status, 200)
    const withShotEngine = await shotEngine.json()
    assert.equal(withShotEngine.shots[2].engine, 'local')
    assert.equal(withShotEngine.shots[0].engine || '', '')

    const mismatch = await fetch(`${baseUrl}/api/projects/${created.id}/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ shots: 'pending', confirmCloud: true, confirmedCount: 3 }),
    })
    assert.equal(mismatch.status, 409)
    assert.match((await mismatch.json()).error, /消耗 2 次/)
  })

  it('lists generated shot videos in the asset library', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    fs.writeFileSync(file, JSON.stringify({
      ...created,
      shots: [{ id: 's1', index: 0, title: '开场', description: 'd', video_prompt: 'p', status: 'Success', filename: 'h3-test.mp4' }],
    }, null, 2))
    const assets = await fetch(`${baseUrl}/api/assets`).then((response) => response.json())
    const video = assets.find((item) => item.id === `${created.id}:video:s1`)
    assert.ok(video)
    assert.equal(video.type, 'video')
    assert.equal(video.url, '/media/h3-test.mp4')
  })

  it('validates narration and first-frame requests before calling external APIs', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const emptyNarration = await fetch(`${baseUrl}/api/projects/${created.id}/narration`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ' ' }),
    })
    assert.equal(emptyNarration.status, 400)
    const missingShot = await fetch(`${baseUrl}/api/projects/${created.id}/shots/9/image-gen`, { method: 'POST', body: '{}' })
    assert.equal(missingShot.status, 404)
  })

  it('clears conversation history while keeping production artifacts', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    fs.writeFileSync(file, JSON.stringify({
      ...created,
      messages: [{ role: 'user', content: '旧消息' }, { role: 'assistant', content: '旧回复' }],
      stageChoices: [{ id: 'x', label: '旧选项', description: '', reply: 'r' }],
      shots: [{ id: 's1', index: 0, title: '保留', description: 'd', video_prompt: 'p', status: 'ready', duration: 6 }],
    }, null, 2))
    const cleared = await fetch(`${baseUrl}/api/projects/${created.id}/clear-chat`, { method: 'POST', body: '{}' })
    assert.equal(cleared.status, 200)
    const project = await cleared.json()
    assert.deepEqual(project.messages, [])
    assert.equal(project.shots.length, 1)
  })

  it('deletes a project completely on request', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    const removed = await fetch(`${baseUrl}/api/projects/${created.id}`, { method: 'DELETE' })
    assert.equal(removed.status, 200)
    const gone = await fetch(`${baseUrl}/api/projects/${created.id}`)
    assert.equal(gone.status, 404)
  })

  it('keeps replaced rendered shots as local material assets', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    fs.writeFileSync(file, JSON.stringify({
      ...created,
      phase: 'quality_review',
      duration: 18,
      selectedConceptId: 'c1',
      concepts: [{ id: 'c1', title: 'A', logline: 'l', narrative: 'n', visualHook: 'v', ending: 'e' }],
      shots: [
        { id: 'old-1', index: 0, title: '旧镜一', description: 'd', video_prompt: 'p1', status: 'Success', filename: 'h3-material.mp4', duration: 6 },
        { id: 'old-2', index: 1, title: '旧镜二', description: 'd', video_prompt: 'p2', status: 'Success', filename: 'h3-material2.mp4', duration: 6 },
        { id: 'old-3', index: 2, title: '旧镜三', description: 'd', video_prompt: 'p3', status: 'ready', duration: 6 },
      ],
    }, null, 2))
    const revised = await fetch(`${baseUrl}/api/projects/${created.id}/revise-storyboard`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ instruction: '删掉镜头二和三，只保留镜头一并重建' }),
    })
    assert.equal(revised.status, 200)
    const project = await revised.json()
    const materials = project.materialShots || []
    assert.equal(materials.length, 2)
    assert.deepEqual(materials.map((item) => item.filename).sort(), ['h3-material.mp4', 'h3-material2.mp4'])
    const assets = await fetch(`${baseUrl}/api/assets`).then((response) => response.json())
    const material = assets.find((item) => item.id === `${created.id}:material:old-1`)
    assert.ok(material)
    assert.match(material.title, /本地素材/)
  })

  it('issues a 30-day cookie only for an accepted password', async () => {
    const status = await fetch(`${baseUrl}/api/auth/status`).then((response) => response.json())
    assert.equal(status.loginEnabled, true)
    const wrong = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
    })
    assert.equal(wrong.status, 401)
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: '1q1qwwww' }),
    })
    assert.equal(login.status, 200)
    const cookie = (login.headers.get('set-cookie') || '').match(/kunpeng_studio=([a-f0-9]{64})/)
    assert.ok(cookie, 'login should set the signed cookie')
    const denied = await fetch(`${baseUrl}/api/auth/verify`)
    assert.equal(denied.status, 401)
    const verified = await fetch(`${baseUrl}/api/auth/verify`, { headers: { Cookie: `kunpeng_studio=${cookie[1]}` } })
    assert.equal(verified.status, 200)
  })

  it('parses structural revision commands the director failed to act on', () => {
    const full = detectStructuralRevision('删掉镜头2和3，只保留镜头1，重建为单个10秒镜头，引擎改为云端', { shots: [{}, {}, {}] })
    assert.equal(full.shotCount, 1)
    assert.equal(full.duration, 10)
    assert.equal(full.engine, 'cloud')
    assert.match(full.instruction, /删掉镜头2和3/)
    const deletedOnly = detectStructuralRevision('删掉镜头2和3', { shots: [{}, {}, {}] })
    assert.equal(deletedOnly.shotCount, 1)
    assert.equal(deletedOnly.duration, undefined)
    const engineOnly = detectStructuralRevision('使用云端接口重新出片', { shots: [] })
    assert.equal(engineOnly.engine, 'cloud')
    assert.equal(engineOnly.shotCount, undefined)
    assert.equal(detectStructuralRevision('做一支温馨治愈的视频', { shots: [] }), null)
  })

  it('executes the structural revision when the director only narrates', async () => {
    const created = await fetch(`${baseUrl}/api/projects`, { method: 'POST' }).then((response) => response.json())
    createdProjects.push(created.id)
    const file = path.join(root, 'outputs', 'projects', created.id, 'project.json')
    fs.writeFileSync(file, JSON.stringify({
      ...created,
      phase: 'delivered',
      deliveredAt: '2026-08-29T00:00:00.000Z',
      finalUrl: '/media/final.mp4',
      finalFilename: 'final.mp4',
      duration: 18,
      selectedConceptId: 'c1',
      concepts: [{ id: 'c1', title: 'A', logline: 'l', narrative: 'n', visualHook: 'v', ending: 'e' }],
      shots: [
        { id: 'k1', index: 0, title: '镜一', description: 'd', video_prompt: 'p1', status: 'Success', filename: 'h3-a.mp4', duration: 6 },
        { id: 'k2', index: 1, title: '镜二', description: 'd', video_prompt: 'p2', status: 'Success', filename: 'h3-b.mp4', duration: 6 },
        { id: 'k3', index: 2, title: '镜三', description: 'd', video_prompt: 'p3', status: 'Success', filename: 'h3-c.mp4', duration: 6 },
      ],
    }, null, 2))
    const reply = await fetch(`${baseUrl}/api/projects/${created.id}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: '删掉镜头2和3，只保留镜头1，重建为单个10秒镜头，引擎改为云端' }),
    })
    assert.equal(reply.status, 200)
    const project = await reply.json()
    assert.equal(project.phase, 'storyboard_review')
    assert.equal(project.shots.length, 1)
    assert.equal(project.shots[0].duration, 10)
    assert.equal(project.engine, 'cloud')
    assert.equal((project.materialShots || []).length, 3)
  })
})
