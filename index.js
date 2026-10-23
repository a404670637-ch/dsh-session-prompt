/**
 * dsh-session-prompt — Host half.
 *
 * Stores one free-text prompt per DSH Session and registers it as a scoped
 * system-prompt section. System-prompt sections are assembled fresh for every
 * model request and are not part of the conversation surface that compaction
 * folds, so the text is sent in full on every turn and survives compaction.
 *
 * The Client half (client.js) renders the editor in the session header and
 * talks to this half over its own same-origin HTTP prefix.
 *
 * @module dsh-session-prompt
 */
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-session-prompt'
export const inject = ['connection', 'agents', 'sessions', 'systemPrompt', 'webServer']

const BASE_PATH = '/dsh-session-prompt'
const SECTION_NAME = 'session-prompt:pinned'
const DEFAULT_MAX_TOKENS = 5000
const DEFAULT_SECTION_ORDER = 9500
const MAX_RAW_CHARS = 100000
const MAX_BODY_BYTES = 1024 * 1024

/** Normalize the plugin row config; every field is optional. */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const maxTokens =
    Number.isSafeInteger(config.maxTokens) && config.maxTokens > 0 ? config.maxTokens : DEFAULT_MAX_TOKENS
  const sectionOrder = Number.isFinite(config.sectionOrder) ? config.sectionOrder : DEFAULT_SECTION_ORDER
  return { maxTokens, sectionOrder }
}

function isCjkCodePoint(cp) {
  return (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x20000 && cp <= 0x2fa1f)
  )
}

/**
 * Conservative token estimate for the route's DeepSeek tokenizer.
 *
 * Measured against deepseek-ai/DeepSeek-V3 tokenizer.json: Chinese prose is
 * ~1.77 chars/token and English prose ~5.75 chars/token. This estimator is
 * deliberately a little pessimistic (CJK 0.55 tok/char, ASCII letters/digits/
 * whitespace 0.17, ASCII punctuation 0.4, other non-ASCII 0.8) so a 5,000-token
 * budget holds for the real tokenizer with a small safety margin.
 */
export function estimateTokens(text) {
  let cjk = 0
  let ascii = 0
  let punctuation = 0
  let other = 0
  for (const char of String(text)) {
    const cp = char.codePointAt(0)
    if (cp === undefined) continue
    if (isCjkCodePoint(cp)) cjk += 1
    else if (cp <= 0x7f) {
      if (
        (cp >= 0x30 && cp <= 0x39) ||
        (cp >= 0x41 && cp <= 0x5a) ||
        (cp >= 0x61 && cp <= 0x7a) ||
        cp === 0x20 ||
        cp === 0x09 ||
        cp === 0x0a ||
        cp === 0x0d
      ) {
        ascii += 1
      } else {
        punctuation += 1
      }
    } else if (cp >= 0x1f000) {
      other += 2
    } else {
      other += 1
    }
  }
  const total = cjk + ascii + punctuation + other
  const punctuationRatio = total === 0 ? 0 : punctuation / total
  const cjkRatio = total === 0 ? 0 : cjk / total
  let cjkCoefficient
  let asciiCoefficient
  let punctuationCoefficient
  let otherCoefficient
  if (punctuationRatio > 0.12) {
    cjkCoefficient = 0.66
    asciiCoefficient = 0.34
    punctuationCoefficient = 0.82
    otherCoefficient = 1
  } else if (cjkRatio > 0.05) {
    cjkCoefficient = 0.66
    asciiCoefficient = 0.27
    punctuationCoefficient = 0.75
    otherCoefficient = 0.95
  } else {
    cjkCoefficient = 0.62
    asciiCoefficient = 0.19
    punctuationCoefficient = 0.5
    otherCoefficient = 0.9
  }
  return Math.ceil(cjk * cjkCoefficient + ascii * asciiCoefficient + punctuation * punctuationCoefficient + other * otherCoefficient)
}

export function renderSection(text) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') return ''
  return [
    '## Session-pinned prompt (not affected by context compression)',
    'The following text is fixed by the user for this conversation. It is sent in full with every request and must be followed. It is not part of the conversation history that context compaction may fold.',
    '',
    '<session_prompt>',
    trimmed,
    '</session_prompt>',
  ].join('\n')
}

function dshHome() {
  return process.env.DSH_HOME !== undefined && process.env.DSH_HOME !== ''
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')
}

function stateDirectory() {
  return join(dshHome(), 'dsh-session-prompt', 'sessions')
}

function stateFile(sessionId) {
  const digest = createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 32)
  return join(stateDirectory(), `${digest}.json`)
}

export function createStateStore() {
  const cache = new Map()
  return {
    read(sessionId) {
      const cached = cache.get(sessionId)
      if (cached !== undefined) return cached
      const file = stateFile(sessionId)
      let entry = { sessionId, text: '', updatedAt: 0 }
      try {
        if (existsSync(file)) {
          const parsed = JSON.parse(readFileSync(file, 'utf8'))
          if (parsed !== null && typeof parsed === 'object' && typeof parsed.text === 'string') {
            entry = {
              sessionId,
              text: parsed.text,
              updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
            }
          }
        }
      } catch {
        // A corrupt or unreadable file behaves like an empty prompt.
      }
      cache.set(sessionId, entry)
      return entry
    },
    write(sessionId, text) {
      const entry = { sessionId, text, updatedAt: Date.now() }
      mkdirSync(stateDirectory(), { recursive: true })
      const file = stateFile(sessionId)
      const temporary = `${file}.${process.pid}.${Date.now()}.tmp`
      writeFileSync(temporary, `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
      cache.set(sessionId, entry)
      return entry
    },
  }
}

function ok(value) {
  return { ok: true, value }
}

function failure(code, message, details = {}) {
  return { ok: false, error: { code, message, details } }
}

/**
 * Build the endpoint logic independently of HTTP so it stays unit-testable.
 * @param store - per-session state store.
 * @param statusOf - `(sessionId) => 'idle' | 'running'`.
 * @param config - normalized plugin config.
 * @returns handler for the `get` and `save` endpoints.
 */
export function createEndpointHandler(store, statusOf, config) {
  return async function handleEndpoint(endpoint, payload) {
    const input = payload !== null && typeof payload === 'object' ? payload : {}
    const sessionId = typeof input.sessionId === 'string' ? input.sessionId : ''
    if (sessionId === '' || sessionId.length > 256) {
      return failure('INVALID_SESSION', 'sessionId is required and must be at most 256 characters')
    }

    const snapshot = (entry) => {
      const text = String(entry.text ?? '')
      return {
        sessionId,
        text,
        chars: [...text].length,
        tokens: estimateTokens(text),
        maxTokens: config.maxTokens,
        updatedAt: entry.updatedAt,
        running: statusOf(sessionId) === 'running',
      }
    }

    if (endpoint === 'get') {
      return ok(snapshot(store.read(sessionId)))
    }

    if (endpoint === 'save') {
      const text = typeof input.text === 'string' ? input.text : undefined
      if (text === undefined) return failure('INVALID_INPUT', 'text must be a string')
      if ([...text].length > MAX_RAW_CHARS) {
        return failure('TOO_LONG', 'text exceeds the maximum raw length', {
          chars: [...text].length,
          maxChars: MAX_RAW_CHARS,
        })
      }
      if (statusOf(sessionId) === 'running') {
        return failure('RUNNING', 'the model is processing this session; edit after it becomes idle')
      }
      const tokens = estimateTokens(text)
      if (tokens > config.maxTokens) {
        return failure('TOO_LONG', 'text exceeds the token budget', {
          tokens,
          maxTokens: config.maxTokens,
          chars: [...text].length,
        })
      }
      const entry = store.write(sessionId, text)
      return ok(snapshot(entry))
    }

    return failure('UNKNOWN_ENDPOINT', `unknown endpoint ${JSON.stringify(endpoint)}`)
  }
}

function sendJson(res, status, value) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(value))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('request body too large'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = createStateStore()
  const fibers = new Map()

  const installPrompt = (agent) => {
    if (agent === null || agent === undefined || typeof agent.ctx?.inject !== 'function') return
    if (fibers.has(agent.id)) return
    const fiber = agent.ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: SECTION_NAME,
        order: config.sectionOrder,
        interpolate: false,
        text: () => renderSection(store.read(agent.id).text),
      })
    })
    fibers.set(agent.id, fiber)
  }

  const disposePrompt = (agentId) => {
    const fiber = fibers.get(agentId)
    if (fiber === undefined) return
    fibers.delete(agentId)
    Promise.resolve(fiber.dispose?.()).catch(() => {})
  }

  for (const agent of ctx.agents.list()) installPrompt(agent)
  ctx.on('agent/created', ({ agent }) => installPrompt(agent))
  ctx.on('agent/disposed', ({ agent }) => disposePrompt(agent.id))
  ctx.effect(
    () => () => {
      for (const agentId of [...fibers.keys()]) disposePrompt(agentId)
    },
    'session-prompt: prompt sections',
  )

  const statusOf = (sessionId) => {
    const agent = ctx.agents.get(sessionId)
    return agent !== undefined && agent.status === 'running' ? 'running' : 'idle'
  }
  const handleEndpoint = createEndpointHandler(store, statusOf, config)

  const handler = async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST')
        sendJson(res, 405, failure('METHOD_NOT_ALLOWED', 'use POST'))
        return
      }
      const connection = ctx.connection
      if (connection === undefined || connection === null || typeof connection.requestRejection !== 'function') {
        sendJson(res, 503, failure('TRUST_FENCE_UNAVAILABLE', 'the connection service is not available'))
        return
      }
      const rejection = connection.requestRejection(req)
      if (rejection !== undefined) {
        res.statusCode = rejection
        res.end()
        return
      }
      const url = new URL(String(req.url ?? '/'), 'http://localhost')
      const endpoint = url.pathname.slice(BASE_PATH.length).replace(/^\/+/, '').replace(/\/+$/, '')
      if (endpoint !== 'get' && endpoint !== 'save') {
        sendJson(res, 404, failure('UNKNOWN_ENDPOINT', `unknown endpoint ${JSON.stringify(endpoint)}`))
        return
      }
      let payload
      try {
        const raw = await readBody(req)
        payload = raw.trim() === '' ? {} : JSON.parse(raw)
      } catch (error) {
        if (error?.code === 'TOO_LARGE') {
          sendJson(res, 413, failure('TOO_LARGE', 'request body too large'))
        } else {
          sendJson(res, 400, failure('INVALID_JSON', 'request body is not JSON'))
        }
        return
      }
      const result = await handleEndpoint(endpoint, payload)
      sendJson(res, 200, result)
    } catch (error) {
      sendJson(res, 500, failure('INTERNAL', String(error?.message ?? error)))
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: BASE_PATH,
        handler,
      }),
    'session-prompt: http routes',
  )
}
