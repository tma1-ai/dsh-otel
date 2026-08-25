/**
 * End-to-end verification against a live GreptimeDB.
 *
 * Opt-in: set `GREPTIMEDB_OTLP_ENDPOINT` to run. Everything here goes over the
 * real OTLP/protobuf transport and comes back through SQL, so it is the only
 * check that proves the headers, the trace pipeline, and the extracted log
 * columns actually work — an in-memory exporter cannot.
 *
 * @module tests/greptimedb.integration
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createPipeline } from '../src/lifecycle.js'
import { resolveConfig } from '../src/config.js'
import { emitEvent } from '../src/logs.js'
import { SessionRecorder } from '../src/recorder.js'
import { assistantMessage, event, resetSeq, toolResult, userMessage, T0 } from './fixtures.js'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const ENDPOINT = process.env['GREPTIMEDB_OTLP_ENDPOINT']
const SQL_URL = process.env['GREPTIMEDB_SQL_URL'] ?? 'http://localhost:4000/v1/sql'
const SESSION_ID = `it-${String(T0)}`
const LOG_TABLE = 'dsh_logs_it'
const TRACE_TABLE = 'dsh_traces_it'

/** Billed input for the seeded usage: 100 uncached + 900 cache read + 20 cache write. */
const EXPECTED_BILLED_INPUT = 1_020

interface SqlResponse {
  output?: { records?: { schema?: { column_schemas?: { name: string }[] }; rows?: unknown[][] } }[]
}

async function sql(query: string): Promise<{ columns: string[]; rows: unknown[][] }> {
  const response = await fetch(SQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ sql: query }),
  })
  if (!response.ok) throw new Error(`SQL ${String(response.status)}: ${await response.text()}`)
  const body = await response.json() as SqlResponse
  const records = body.output?.[0]?.records
  return {
    columns: (records?.schema?.column_schemas ?? []).map(column => column.name),
    rows: records?.rows ?? [],
  }
}

function cell(result: { columns: string[]; rows: unknown[][] }, row: number, column: string): unknown {
  const index = result.columns.indexOf(column)
  if (index === -1) throw new Error(`no column ${column} in ${result.columns.join(', ')}`)
  return result.rows[row]?.[index]
}

/** One turn that succeeds with a tool call, then one turn whose request fails. */
function seededEvents(): SessionEvent[] {
  return [
    event('turn/start', { turn: 1 }, T0),
    userMessage('list the files', T0 + 1),
    event('step/start', { turn: 1, step: 1 }, T0 + 2),
    event('request/context', { provider: 'deepseek', model: 'deepseek-chat' }, T0 + 3),
    assistantMessage({
      turn: 1,
      step: 1,
      time: T0 + 100,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 20, reasoningTokens: 30 },
      toolCalls: [{ id: 'call-1', name: 'bash' }],
    }),
    event('tool/call', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' }, T0 + 110),
    toolResult({ turn: 1, step: 1, callId: 'call-1', time: T0 + 300, isError: false, text: 'a.txt' }),
    event('step/end', { turn: 1, step: 1 }, T0 + 310),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 320),
  ]
}

describe.skipIf(ENDPOINT === undefined)('GreptimeDB round trip', () => {
  beforeAll(async () => {
    resetSeq()
    const config = resolveConfig({
      endpoint: ENDPOINT ?? '',
      logTable: LOG_TABLE,
      traceTable: TRACE_TABLE,
      // Export as soon as the batch closes rather than waiting out the default
      // cadence; shutdown below is what actually forces the drain.
      scheduledDelayMillis: 100,
      exportTimeoutMillis: 5_000,
      metricIntervalMillis: 5_000,
    })
    const errors: unknown[] = []
    const pipeline = createPipeline(config, '0.0.0-test', (error) => errors.push(error))
    if (pipeline.tracer === undefined || pipeline.instruments === undefined || pipeline.logger === undefined) {
      throw new Error('all three signals must be enabled for this test')
    }
    const recorder = new SessionRecorder(SESSION_ID, pipeline.tracer, pipeline.instruments, T0)
    for (const e of seededEvents()) {
      recorder.handle(e)
      emitEvent(pipeline.logger, SESSION_ID, e, 'none')
    }
    // A second turn whose model request fails before any assistant message.
    recorder.handle(event('turn/start', { turn: 2 }, T0 + 400))
    recorder.handle(event('step/start', { turn: 2, step: 2 }, T0 + 410))
    recorder.handle(event('step/end', { turn: 2, step: 2 }, T0 + 900))
    recorder.fail(2, new TypeError('socket hang up'))
    recorder.handle(event('turn/end', { turn: 2, reason: { kind: 'error', error: { message: 'boom', code: 'UNKNOWN' } } }, T0 + 910))
    recorder.closeAll()

    await pipeline.shutdown()
    expect(errors).toEqual([])
    // The metric reader's final collection races the write path's visibility.
    await new Promise(resolve => setTimeout(resolve, 2_000))
  }, 60_000)

  afterAll(async () => {
    await sql(`DROP TABLE IF EXISTS ${LOG_TABLE}`).catch(() => undefined)
    await sql(`DROP TABLE IF EXISTS ${TRACE_TABLE}`).catch(() => undefined)
  })

  it('writes chat and tool spans as siblings of the turn span', async () => {
    const spans = await sql(
      `SELECT span_name, span_id, parent_span_id, timestamp, timestamp_end, span_status_code
       FROM ${TRACE_TABLE}
       WHERE "span_attributes.dsh.session.id" = '${SESSION_ID}' AND "span_attributes.dsh.turn" = 1
       ORDER BY timestamp`,
    )
    const names = spans.rows.map((_row, index) => cell(spans, index, 'span_name'))
    expect(names).toContain('invoke_agent dsh')
    expect(names).toContain('chat deepseek-chat')
    expect(names).toContain('execute_tool bash')

    const turnIndex = names.indexOf('invoke_agent dsh')
    const turnSpanId = cell(spans, turnIndex, 'span_id')
    for (const name of ['chat deepseek-chat', 'execute_tool bash']) {
      expect(cell(spans, names.indexOf(name), 'parent_span_id')).toBe(turnSpanId)
    }
    // The loop runs tools after the assistant message, so the tool span must
    // start at or after the chat span's end.
    const chatEnd = Number(cell(spans, names.indexOf('chat deepseek-chat'), 'timestamp_end'))
    const toolStart = Number(cell(spans, names.indexOf('execute_tool bash'), 'timestamp'))
    expect(toolStart).toBeGreaterThanOrEqual(chatEnd)
  })

  it('reports billed input tokens, not just the uncached count', async () => {
    const usage = await sql(
      `SELECT "span_attributes.gen_ai.usage.input_tokens" AS input,
              "span_attributes.gen_ai.usage.output_tokens" AS output,
              "span_attributes.dsh.usage.uncached_input_tokens" AS uncached
       FROM ${TRACE_TABLE}
       WHERE "span_attributes.dsh.session.id" = '${SESSION_ID}'
         AND span_name = 'chat deepseek-chat' AND "span_attributes.dsh.turn" = 1
       LIMIT 1`,
    )
    expect(Number(cell(usage, 0, 'input'))).toBe(EXPECTED_BILLED_INPUT)
    // reasoning tokens are already inside completion_tokens
    expect(Number(cell(usage, 0, 'output'))).toBe(50)
    expect(Number(cell(usage, 0, 'uncached'))).toBe(100)
  })

  it('closes a failed request as ERROR at its step/end time', async () => {
    const failed = await sql(
      `SELECT span_status_code, duration_nano
       FROM ${TRACE_TABLE}
       WHERE "span_attributes.dsh.session.id" = '${SESSION_ID}'
         AND "span_attributes.dsh.turn" = 2 AND span_name LIKE 'chat%'
       LIMIT 1`,
    )
    expect(cell(failed, 0, 'span_status_code')).toBe('STATUS_CODE_ERROR')
    // step/start T0+410 → step/end T0+900: the failed request is measured, not
    // left to the fallback end time.
    expect(Number(cell(failed, 0, 'duration_nano'))).toBe(490 * 1_000_000)
  })

  it('marks no span as unclosed when every boundary event arrived', async () => {
    // GreptimeDB creates a column per attribute actually written, so the
    // absence of the column is the strongest available assertion that no span
    // in this session took the fallback path.
    const all = await sql(`SELECT * FROM ${TRACE_TABLE} LIMIT 1`)
    expect(all.columns).not.toContain('span_attributes.dsh.span.unclosed')
  })

  it('promotes the queryable log keys to real columns', async () => {
    const logs = await sql(
      `SELECT session_id, event_type, turn, step FROM ${LOG_TABLE}
       WHERE session_id = '${SESSION_ID}' ORDER BY timestamp LIMIT 5`,
    )
    // Reaching this row through named columns — not json_get_string — is the
    // assertion: a dotted attribute key would be unaddressable here.
    expect(logs.columns).toEqual(expect.arrayContaining(['session_id', 'event_type', 'turn', 'step']))
    expect(cell(logs, 0, 'session_id')).toBe(SESSION_ID)
    expect(cell(logs, 0, 'event_type')).toBe('turn/start')
  })

  it('withholds payloads at content: none', async () => {
    const logs = await sql(`SELECT body FROM ${LOG_TABLE} WHERE session_id = '${SESSION_ID}'`)
    const serialized = JSON.stringify(logs.rows)
    expect(serialized).not.toContain('list the files')
    expect(serialized).not.toContain('a.txt')
    expect(serialized).not.toContain('"command":"ls"')
  })

  it('writes the standard token metric', async () => {
    const metric = await sql(
      `SELECT SUM(greptime_value) AS total FROM gen_ai_client_token_usage_sum
       WHERE gen_ai_token_type = 'input'`,
    )
    expect(Number(cell(metric, 0, 'total'))).toBeGreaterThanOrEqual(EXPECTED_BILLED_INPUT)
  })
})
