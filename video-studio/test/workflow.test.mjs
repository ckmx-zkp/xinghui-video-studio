import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { briefReadiness, completionText, extractJson, parseDirectorReply, resolveShotList } from '../director.mjs'
import { app, historyForDirector, resolveRuntimeModes } from '../server.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
let server
let baseUrl
const createdProjects = []

before(async () => {
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

  it('keeps a short request in discovery for multiple turns', () => {
    const result = briefReadiness({ idea: '做一个耳机广告', discoveryTurns: 1, creativeBrief: completeBrief })
    assert.equal(result.ready, false)
    assert.equal(result.turnsRemaining, 2)
  })

  it('allows review after discovery is complete', () => {
    const result = briefReadiness({ idea: '做一个耳机广告', discoveryTurns: 3, creativeBrief: completeBrief })
    assert.equal(result.ready, true)
    assert.deepEqual(result.missing, [])
  })

  it('parses professional insight and selectable replies', () => {
    const parsed = parseDirectorReply(JSON.stringify({
      say: '这个题材适合先确定情绪入口。',
      insight: '从通勤噪声切入能最快建立产品价值。',
      choices: [
        { label: '现实通勤', description: '强调真实共鸣', reply: '选择现实通勤方向' },
        { label: '视觉隐喻', description: '强调品牌质感', reply: '选择视觉隐喻方向' },
      ],
      actions: [],
    }))
    assert.match(parsed.insight, /通勤噪声/)
    assert.equal(parsed.choices.length, 2)
    assert.equal(parsed.choices[1].reply, '选择视觉隐喻方向')
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
})
