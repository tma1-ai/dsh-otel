import { beforeEach, describe, expect, it } from 'vitest'
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace-base'
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader, AggregationTemporality } from '@opentelemetry/sdk-metrics'
import type { ResourceMetrics } from '@opentelemetry/sdk-metrics'
import { SpanStatusCode } from '@opentelemetry/api'
import { SessionRecorder, billedInputTokens } from '../src/recorder.js'
import { createInstruments } from '../src/metrics.js'
import { assistantMessage, callId, event, resetSeq, toolResult, T0 } from './fixtures.js'
import {
  ATTR_DSH_SPAN_UNCLOSED,
  ATTR_DSH_STEP,
  ATTR_DSH_TOOL_OUTCOME,
  ATTR_DSH_USAGE_CACHE_READ_TOKENS,
  ATTR_DSH_RESPONSE_INTERRUPTED,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
} from '../src/semconv.js'

const SESSION_ID = 'sess-1'

function hrToMillis(time: [number, number]): number {
  return time[0] * 1000 + time[1] / 1e6
}

function setup() {
  const spans = new InMemorySpanExporter()
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spans)] })
  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE)
  const reader = new PeriodicExportingMetricReader({ exporter: metricExporter, exportIntervalMillis: 60_000 })
  const meterProvider = new MeterProvider({ readers: [reader] })
  const recorder = new SessionRecorder(
    SESSION_ID,
    tracerProvider.getTracer('test'),
    createInstruments(meterProvider.getMeter('test')),
    T0,
  )
  const collect = async (): Promise<ResourceMetrics[]> => {
    await reader.forceFlush()
    return metricExporter.getMetrics()
  }
  return { recorder, spans, collect }
}

function byName(spans: ReadableSpan[], prefix: string): ReadableSpan {
  const found = spans.find(span => span.name.startsWith(prefix))
  if (found === undefined) throw new Error(`no span named ${prefix} among ${spans.map(s => s.name).join(', ')}`)
  return found
}

describe('SessionRecorder span tree', () => {
  beforeEach(resetSeq)

  it('makes chat and tool spans siblings under the turn span', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(event('request/context', { provider: 'deepseek', model: 'deepseek-chat' }, T0 + 11))
    recorder.handle(assistantMessage({ turn: 1, step: 1, time: T0 + 100, toolCalls: [{ id: 'c1', name: 'bash' }] }))
    recorder.handle(event('tool/call', { turn: 1, step: 1, callId: callId('c1'), name: 'bash', arguments: '{}' }, T0 + 110))
    recorder.handle(toolResult({ turn: 1, step: 1, callId: callId('c1'), time: T0 + 200 }))
    recorder.handle(event('step/end', { turn: 1, step: 1 }, T0 + 210))
    recorder.handle(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 220))

    const finished = spans.getFinishedSpans()
    const turn = byName(finished, 'invoke_agent')
    const chat = byName(finished, 'chat')
    const tool = byName(finished, 'execute_tool')

    expect(chat.parentSpanContext?.spanId).toBe(turn.spanContext().spanId)
    expect(tool.parentSpanContext?.spanId).toBe(turn.spanContext().spanId)
    // The loop appends assistant/message before running tools, so a nested
    // layout would put the child entirely after its parent's end.
    expect(hrToMillis(tool.startTime)).toBeGreaterThanOrEqual(hrToMillis(chat.endTime))
    expect(tool.attributes[ATTR_DSH_STEP]).toBe(1)
    expect(chat.attributes[ATTR_DSH_STEP]).toBe(1)
  })

  it('uses event times, not wall clock', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 5_000))

    const turn = byName(spans.getFinishedSpans(), 'invoke_agent')
    expect(hrToMillis(turn.startTime)).toBe(T0)
    expect(hrToMillis(turn.endTime)).toBe(T0 + 5_000)
  })

  it('renames the chat span once request/context reveals the model', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(event('request/context', { provider: 'deepseek', model: 'deepseek-reasoner' }, T0 + 11))
    recorder.handle(assistantMessage({ turn: 1, step: 1, time: T0 + 100 }))

    const chat = byName(spans.getFinishedSpans(), 'chat')
    expect(chat.name).toBe('chat deepseek-reasoner')
    expect(chat.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBe('deepseek-reasoner')
  })

  it('emits the deprecated gen_ai.system alongside gen_ai.provider.name', () => {
    // Existing GenAI dashboards select on `gen_ai.system`; a span without it
    // does not appear in them at all.
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(event('request/context', { provider: 'deepseek', model: 'deepseek-chat' }, T0 + 11))
    recorder.handle(assistantMessage({ turn: 1, step: 1, time: T0 + 100 }))

    const chat = byName(spans.getFinishedSpans(), 'chat')
    expect(chat.attributes[ATTR_GEN_AI_PROVIDER_NAME]).toBe('deepseek')
    expect(chat.attributes[ATTR_GEN_AI_SYSTEM]).toBe('deepseek')
  })

  it('keeps the placeholder model when no request/context arrives', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(assistantMessage({ turn: 1, step: 1, time: T0 + 100 }))

    const chat = byName(spans.getFinishedSpans(), 'chat')
    expect(chat.name).toBe('chat unknown')
    expect(chat.attributes[ATTR_GEN_AI_REQUEST_MODEL]).toBeUndefined()
  })
})

describe('SessionRecorder chat closure paths', () => {
  beforeEach(resetSeq)

  it('closes a failed request at its step/end time with ERROR', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(event('request/context', { provider: 'deepseek', model: 'deepseek-chat' }, T0 + 11))
    // No assistant/message: the request threw. step/end is appended in a
    // finally, so it lands before agent/error reaches this recorder.
    recorder.handle(event('step/end', { turn: 1, step: 1 }, T0 + 500))
    recorder.fail(1, new TypeError('socket hang up'))
    recorder.handle(event('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'x', code: 'UNKNOWN' } } }, T0 + 510))

    const chat = byName(spans.getFinishedSpans(), 'chat')
    expect(chat.status.code).toBe(SpanStatusCode.ERROR)
    expect(hrToMillis(chat.endTime)).toBe(T0 + 500)
    expect(chat.attributes[ATTR_DSH_SPAN_UNCLOSED]).toBeUndefined()
    expect(chat.events.some(e => e.name === 'exception')).toBe(true)
  })

  it('marks an interrupted response without treating it as unclosed', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(assistantMessage({ turn: 1, step: 1, time: T0 + 100, interrupted: true }))

    const chat = byName(spans.getFinishedSpans(), 'chat')
    expect(chat.attributes[ATTR_DSH_RESPONSE_INTERRUPTED]).toBe(true)
    expect(chat.attributes[ATTR_DSH_SPAN_UNCLOSED]).toBeUndefined()
    expect(chat.status.code).not.toBe(SpanStatusCode.ERROR)
  })

  it('marks a tool with no result as unclosed at turn end', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(assistantMessage({ turn: 1, step: 1, time: T0 + 100 }))
    recorder.handle(event('tool/call', { turn: 1, step: 1, callId: callId('c1'), name: 'bash', arguments: '{}' }, T0 + 110))
    recorder.handle(event('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } } }, T0 + 300))

    const tool = byName(spans.getFinishedSpans(), 'execute_tool')
    expect(tool.attributes[ATTR_DSH_SPAN_UNCLOSED]).toBe(true)
    expect(hrToMillis(tool.endTime)).toBe(T0 + 300)
  })

  it('closes everything still open on disposal at the last event time', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(event('tool/call', { turn: 1, step: 1, callId: callId('c1'), name: 'bash', arguments: '{}' }, T0 + 20))
    recorder.closeAll()

    const finished = spans.getFinishedSpans()
    expect(finished).toHaveLength(3)
    for (const span of finished) {
      expect(span.attributes[ATTR_DSH_SPAN_UNCLOSED]).toBe(true)
      expect(hrToMillis(span.endTime)).toBe(T0 + 20)
    }
  })

  it('closes an orphaned turn when the next turn starts', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('turn/start', { turn: 2 }, T0 + 100))

    const finished = spans.getFinishedSpans()
    expect(finished).toHaveLength(1)
    expect(finished[0]?.attributes[ATTR_DSH_SPAN_UNCLOSED]).toBe(true)
  })
})

describe('SessionRecorder tool outcome', () => {
  beforeEach(resetSeq)

  it.each([
    { label: 'isError with no internal error identity', isError: true, error: undefined, expected: 'error' },
    { label: 'isError with internal error identity', isError: true, error: { name: 'ToolError', code: 'E_FS' }, expected: 'error' },
    { label: 'success', isError: false, error: undefined, expected: 'ok' },
  ])('reads the result block for $label', ({ isError, error, expected }) => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('tool/call', { turn: 1, step: 1, callId: callId('c1'), name: 'bash', arguments: '{}' }, T0 + 10))
    recorder.handle(toolResult({ turn: 1, step: 1, callId: callId('c1'), time: T0 + 20, isError, ...error === undefined ? {} : { error } }))

    const tool = byName(spans.getFinishedSpans(), 'execute_tool')
    expect(tool.attributes[ATTR_DSH_TOOL_OUTCOME]).toBe(expected)
    expect(tool.status.code).toBe(expected === 'error' ? SpanStatusCode.ERROR : SpanStatusCode.UNSET)
  })
})

describe('token accounting', () => {
  beforeEach(resetSeq)

  it('reports billed input as uncached plus cache read plus cache write', () => {
    expect(billedInputTokens({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 20 })).toBe(1_020)
    expect(billedInputTokens({ inputTokens: 100, outputTokens: 50 })).toBe(100)
  })

  it('puts billed input on the span and keeps the breakdown separate', () => {
    const { recorder, spans } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(assistantMessage({
      turn: 1,
      step: 1,
      time: T0 + 100,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, reasoningTokens: 30 },
    }))

    const chat = byName(spans.getFinishedSpans(), 'chat')
    expect(chat.attributes[ATTR_GEN_AI_USAGE_INPUT_TOKENS]).toBe(1_000)
    // reasoning is already inside completion_tokens; adding it would double-count.
    expect(chat.attributes[ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]).toBe(50)
    expect(chat.attributes[ATTR_DSH_USAGE_CACHE_READ_TOKENS]).toBe(900)
  })

  it('records the standard token histogram with only input and output types', async () => {
    const { recorder, collect } = setup()
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('step/start', { turn: 1, step: 1 }, T0 + 10))
    recorder.handle(assistantMessage({
      turn: 1,
      step: 1,
      time: T0 + 100,
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 },
    }))

    const metrics = await collect()
    const scope = metrics.at(-1)?.scopeMetrics[0]
    const tokenUsage = scope?.metrics.find(m => m.descriptor.name === 'gen_ai.client.token.usage')
    const types = tokenUsage?.dataPoints.map(point => point.attributes['gen_ai.token.type'])
    expect(new Set(types)).toEqual(new Set(['input', 'output']))
  })
})
