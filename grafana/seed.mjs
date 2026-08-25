#!/usr/bin/env node
/**
 * Fill GreptimeDB with synthetic DSH activity so the dashboards have something
 * to draw before a real agent has run.
 *
 * It drives the plugin's own recorder and log emitter, so what lands is
 * byte-identical to what a live session produces.
 *
 *   node grafana/seed.mjs [--endpoint http://localhost:4000/v1/otlp] [--turns 60]
 *
 * @module grafana/seed
 */

import { createPipeline, resolveConfig, SessionRecorder, emitEvent } from '../lib/index.js'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])

const endpoint = args.get('--endpoint') ?? 'http://localhost:4000/v1/otlp'
const turnCount = Number(args.get('--turns') ?? '60')
const logTable = args.get('--log-table') ?? 'dsh_logs'

const MODELS = ['deepseek-chat', 'deepseek-reasoner']
const TOOLS = ['bash', 'read_file', 'edit_file', 'web_search', 'todo_write']

// Deterministic pseudo-randomness keeps repeated seeds comparable.
let state = 42
const rand = () => {
  state = (state * 1103515245 + 12345) & 0x7fffffff
  return state / 0x7fffffff
}
const pick = (list) => list[Math.floor(rand() * list.length)]
const between = (min, max) => Math.floor(min + rand() * (max - min))

const config = resolveConfig({
  endpoint,
  logTable,
  scheduledDelayMillis: 200,
  exportTimeoutMillis: 5_000,
  metricIntervalMillis: 5_000,
})
const errors = []
const pipeline = createPipeline(config, '0.0.0-seed', error => errors.push(error))
if (!pipeline.tracer || !pipeline.instruments || !pipeline.logger) {
  throw new Error('seed needs all three signals enabled')
}

let seq = 0
const event = (type, data, time) => ({ type, seq: seq++, time, data })

/** Spread the seeded activity over the last hour so time-range panels have shape. */
const now = Date.now()
const span = 60 * 60 * 1000
let emitted = 0

for (let turn = 1; turn <= turnCount; turn += 1) {
  const sessionId = `seed-session-${String(Math.ceil(turn / 6))}`
  const recorder = new SessionRecorder(sessionId, pipeline.tracer, pipeline.instruments, now - span)
  const model = pick(MODELS)
  let t = now - span + Math.floor((span * turn) / (turnCount + 1))

  const feed = (e) => {
    recorder.handle(e)
    emitEvent(pipeline.logger, sessionId, e, 'none')
    emitted += 1
  }

  feed(event('turn/start', { turn }, t))
  t += between(5, 30)
  feed(event('user/message', {
    id: `u-${String(turn)}`,
    role: 'user',
    content: [{ type: 'text', text: 'seeded prompt' }],
    source: { kind: 'user' },
  }, t))

  const steps = between(1, 4)
  const failTurn = rand() < 0.08
  for (let step = 1; step <= steps; step += 1) {
    t += between(5, 20)
    feed(event('step/start', { turn, step }, t))
    if (step === 1) {
      t += 2
      feed(event('request/context', { provider: 'deepseek', model, contextWindow: 128_000 }, t))
    }

    // A failed request produces no assistant message; step/end still lands.
    if (failTurn && step === steps) {
      t += between(400, 3_000)
      feed(event('step/end', { turn, step }, t))
      recorder.fail(step, new Error('upstream timeout'))
      break
    }

    t += between(300, 4_000)
    const cacheRead = rand() < 0.7 ? between(500, 9_000) : 0
    const toolCount = step < steps ? between(1, 3) : 0
    const calls = Array.from({ length: toolCount }, (_unused, index) => ({
      id: `c-${String(turn)}-${String(step)}-${String(index)}`,
      name: pick(TOOLS),
    }))
    feed(event('assistant/message', {
      turn,
      step,
      message: {
        id: `a-${String(turn)}-${String(step)}`,
        role: 'assistant',
        content: calls.map(call => ({ type: 'tool-call', id: call.id, name: call.name, arguments: '{}' })),
        source: { kind: 'model', provider: 'deepseek', model },
      },
      usage: {
        inputTokens: between(200, 2_500),
        outputTokens: between(50, 1_200),
        ...cacheRead > 0 ? { cacheReadTokens: cacheRead } : {},
        ...rand() < 0.3 ? { cacheWriteTokens: between(100, 800) } : {},
        ...model === 'deepseek-reasoner' ? { reasoningTokens: between(100, 900) } : {},
      },
    }, t))

    for (const call of calls) {
      t += between(2, 15)
      feed(event('tool/call', { turn, step, callId: call.id, name: call.name, arguments: '{}' }, t))
      t += between(20, 2_500)
      const isError = rand() < 0.12
      feed(event('tool/result', {
        turn,
        step,
        message: {
          id: `r-${call.id}`,
          role: 'user',
          content: [{ type: 'tool-result', toolCallId: call.id, content: [{ type: 'text', text: 'seeded result' }], isError }],
          source: { kind: 'tool', callId: call.id },
        },
        ...isError ? { error: { name: 'ToolError', code: 'E_SEED' } } : {},
      }, t))
    }

    t += between(5, 20)
    feed(event('step/end', { turn, step }, t))
  }

  t += between(5, 20)
  // A few turns are killed mid-flight (Ctrl-C, crash). They reach closeAll
  // without a turn/end, which is what puts `dsh.span.unclosed` on the wire and
  // therefore creates the column the agent dashboard reads.
  if (rand() >= 0.06) {
    feed(event('turn/end', {
      turn,
      reason: failTurn ? { kind: 'error', error: { message: 'seeded failure', code: 'UPSTREAM' } } : { kind: 'completed' },
    }, t))
  }
  recorder.closeAll()
}

await pipeline.shutdown()
if (errors.length > 0) {
  console.error('seed reported export errors:', errors)
  process.exit(1)
}
console.log(`seeded ${String(turnCount)} turns (${String(emitted)} events) into ${endpoint}`)
