import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import {
  apply,
  createEndpointHandler,
  createStateStore,
  estimateTokens,
  normalizeConfig,
  renderSection,
} from '../index.js'

function makeAgent(id, status = 'idle') {
  const sections = []
  return {
    id,
    status,
    sections,
    ctx: {
      inject(_services, callback) {
        callback({
          systemPrompt: {
            section(section) {
              sections.push(section)
              return () => {}
            },
          },
        })
        return { dispose() {} }
      },
    },
  }
}

function makeHost({ agents = [] } = {}) {
  let route
  const listeners = new Map()
  const cleanups = []
  const ctx = {
    effect(factory, _label) {
      const dispose = factory()
      cleanups.push(dispose)
      return dispose
    },
    on(event, handler) {
      listeners.set(event, handler)
      return () => listeners.delete(event)
    },
    agents: {
      list: () => agents,
      get: (id) => agents.find((agent) => agent.id === id),
    },
    sessions: {},
    connection: {
      requestRejection: () => undefined,
    },
    webServer: {
      register(value) {
        route = value
        return () => {}
      },
    },
  }
  apply(ctx, { maxTokens: 5000, sectionOrder: 9500 })
  return {
    ctx,
    listeners,
    route,
    dispose() {
      for (const cleanup of cleanups.splice(0)) {
        try {
          cleanup?.()
        } catch {}
      }
    },
  }
}

function makeResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(name, value) {
      this.headers[name] = value
    },
    end(body = '') {
      this.body = String(body)
    },
  }
}

async function callRoute(route, endpoint, payload) {
  const req = Readable.from([Buffer.from(JSON.stringify(payload))])
  req.method = 'POST'
  req.url = `/dsh-session-prompt/${endpoint}`
  req.headers = { 'content-type': 'application/json' }
  const res = makeResponse()
  await route.handler(req, res)
  return { status: res.statusCode, body: res.body.length > 0 ? JSON.parse(res.body) : null }
}

test('estimateTokens stays conservative around the 5,000-token budget', () => {
  const chinese = estimateTokens('中'.repeat(1000))
  const english = estimateTokens('a'.repeat(1000))
  assert.ok(chinese > 500 && chinese < 700, `Chinese estimate ${chinese}`)
  assert.ok(english > 100 && english < 250, `English estimate ${english}`)
  assert.ok(estimateTokens('中'.repeat(9500)) > 5000)
  assert.ok(estimateTokens('a'.repeat(30000)) > 5000)
})

test('renderSection is empty when unset and preserves the text when set', () => {
  assert.equal(renderSection(''), '')
  assert.equal(renderSection('   '), '')
  const value = renderSection('Always answer in Chinese.')
  assert.match(value, /Session-pinned prompt/)
  assert.match(value, /<session_prompt>\nAlways answer in Chinese\.\n<\/session_prompt>/)
})

test('endpoint handler saves per-session text and enforces idle/limits', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-prompt-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home

  const store = createStateStore()
  let status = 'idle'
  const statusOf = () => status
  const endpoint = createEndpointHandler(store, statusOf, normalizeConfig({ maxTokens: 5000 }))

  const initial = await endpoint('get', { sessionId: 'session-a' })
  assert.equal(initial.ok, true)
  assert.equal(initial.value.text, '')

  const saved = await endpoint('save', { sessionId: 'session-a', text: '只使用 TypeScript，不要引入新依赖。' })
  assert.equal(saved.ok, true, JSON.stringify(saved))
  assert.equal(saved.value.tokens > 0, true)

  status = 'running'
  const refused = await endpoint('save', { sessionId: 'session-a', text: 'changed' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'RUNNING')

  status = 'idle'
  const tooLong = await endpoint('save', { sessionId: 'session-a', text: '中'.repeat(9500) })
  assert.equal(tooLong.ok, false)
  assert.equal(tooLong.error.code, 'TOO_LONG')

  const missing = await endpoint('save', { sessionId: '', text: 'x' })
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'INVALID_SESSION')
})

test('a second store instance reloads the persisted per-session text', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-prompt-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home

  const first = createStateStore()
  const endpointA = createEndpointHandler(first, () => 'idle', normalizeConfig({}))
  const saved = await endpointA('save', { sessionId: 'session-a', text: 'remember this' })
  assert.equal(saved.ok, true)

  const second = createStateStore()
  const endpointB = createEndpointHandler(second, () => 'idle', normalizeConfig({}))
  const loaded = await endpointB('get', { sessionId: 'session-a' })
  assert.equal(loaded.ok, true)
  assert.equal(loaded.value.text, 'remember this')
})

test('apply registers the prompt section for existing and new agents', (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-prompt-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home

  const first = makeAgent('session-a')
  const host = makeHost({ agents: [first] })
  t.after(() => host.dispose())

  assert.equal(first.sections.length, 1)
  assert.equal(first.sections[0].name, 'session-prompt:pinned')
  assert.equal(first.sections[0].order, 9500)
  assert.equal(first.sections[0].text(), '')

  const created = makeAgent('session-b')
  host.listeners.get('agent/created')({ agent: created })
  assert.equal(created.sections.length, 1)
})

test('apply registers an HTTP prefix route that returns JSON', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-session-prompt-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  process.env.DSH_HOME = home

  const agent = makeAgent('session-http')
  const host = makeHost({ agents: [agent] })
  t.after(() => host.dispose())
  assert.equal(host.route.kind, 'prefix')
  assert.equal(host.route.path, '/dsh-session-prompt')

  const saved = await callRoute(host.route, 'save', { sessionId: 'session-http', text: 'HTTP path works' })
  assert.equal(saved.status, 200)
  assert.equal(saved.body.ok, true)
  assert.match(agent.sections[0].text(), /HTTP path works/)

  const got = await callRoute(host.route, 'get', { sessionId: 'session-http' })
  assert.equal(got.status, 200)
  assert.equal(got.body.ok, true)
  assert.equal(got.body.value.text, 'HTTP path works')
})

test('normalizeConfig keeps defaults and accepts explicit values', () => {
  assert.deepEqual(normalizeConfig({}), { maxTokens: 5000, sectionOrder: 9500 })
  assert.deepEqual(normalizeConfig({ maxTokens: 300, sectionOrder: 100 }), { maxTokens: 300, sectionOrder: 100 })
  assert.deepEqual(normalizeConfig({ maxTokens: -1, sectionOrder: NaN }), { maxTokens: 5000, sectionOrder: 9500 })
})
