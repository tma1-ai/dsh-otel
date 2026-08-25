/**
 * Per-session span and metric state machine.
 *
 * Spans are rebuilt from an append-only event stream, not from async context,
 * so parents are threaded explicitly and timestamps come from events rather
 * than a wall clock that would drift by the handler latency.
 *
 * Chat and tool spans are siblings because DSH appends `assistant/message`
 * before running the tools it requested; nesting would put every child after
 * its parent's end.
 *
 * @module recorder
 */

import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
  type Context as OtelContext,
  type Span,
  type Tracer,
} from '@opentelemetry/api'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Instruments } from './metrics.js'
import {
  ATTR_DSH_ERROR_CODE,
  ATTR_DSH_RESPONSE_INTERRUPTED,
  ATTR_DSH_SESSION_ID,
  ATTR_DSH_SPAN_UNCLOSED,
  ATTR_DSH_STEP,
  ATTR_DSH_TOKEN_DETAIL_KIND,
  ATTR_DSH_TOOL_OUTCOME,
  ATTR_DSH_TURN,
  ATTR_DSH_TURN_END_REASON,
  ATTR_DSH_USAGE_CACHE_READ_TOKENS,
  ATTR_DSH_USAGE_CACHE_WRITE_TOKENS,
  ATTR_DSH_USAGE_REASONING_TOKENS,
  ATTR_DSH_USAGE_UNCACHED_INPUT_TOKENS,
  ATTR_ERROR_TYPE,
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  DSH_AGENT_NAME,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
} from './semconv.js'

/** Used before `request/context` reveals the model. */
const UNKNOWN_MODEL = 'unknown'

/** A span still awaiting its closing event. */
interface OpenSpan {
  readonly span: Span
  /** Event time the span started, for duration metrics. */
  readonly startTime: number
  /** Step the span belongs to; chat and tool spans are siblings correlated by this. */
  readonly step: number
  /** Tool name, retained for the invocation counter because `tool/result` does not repeat it. */
  readonly toolName?: string
}

/**
 * Reconstructs one session's spans and metrics from its event stream.
 *
 * One instance per live session. All methods are synchronous: they mutate local
 * state and hand work to the SDK's queue, never awaiting export.
 */
export class SessionRecorder {
  private turnSpan: Span | undefined
  private turnStartTime = 0
  private turnNumber = 0
  /** At most one open chat span per step. */
  private readonly chatSpans = new Map<number, OpenSpan>()
  /** Keyed by call id, the only identifier that survives the call/result gap. */
  private readonly toolSpans = new Map<string, OpenSpan>()
  /** `step/end` is appended in a `finally`, so it precedes `agent/error` and is the right end time for a failed request. */
  private readonly stepEndTimes = new Map<number, number>()
  private provider: string | undefined
  private model: string | undefined
  /** Fallback end time for a span whose closing event never arrives. */
  private lastEventTime: number
  /**
   * Held past `turn/end` because that event is handled before its own log
   * record is emitted, and it is the one most worth linking from.
   */
  private lastContext: OtelContext | undefined

  /**
   * @param sessionId - the session this recorder follows.
   * @param tracer - tracer for span creation.
   * @param instruments - metric instruments to record into.
   * @param createdAt - session creation time, the initial fallback end time.
   */
  constructor(
    private readonly sessionId: string,
    private readonly tracer: Tracer,
    private readonly instruments: Instruments,
    createdAt: number,
  ) {
    this.lastEventTime = createdAt
  }

  /**
   * Restore the route for a recorder that joins mid-session. DSH appends
   * `request/context` only on change, so without this a hot reload leaves every
   * later chat span on the placeholder model.
   * @param provider - the provider route in effect.
   * @param model - the model in effect.
   */
  seedRoute(provider: string, model: string): void {
    this.provider = provider
    this.model = model
  }

  /**
   * Advance the state machine by one session event.
   * @param event - the appended session event.
   */
  handle(event: SessionEvent): void {
    this.lastEventTime = event.time
    switch (event.type) {
      case 'turn/start':
        return this.startTurn(event.data.turn, event.time)
      case 'turn/end':
        return this.endTurn(event.data.reason.kind, event.time)
      case 'step/start':
        return this.startStep(event.data.turn, event.data.step, event.time)
      case 'step/end':
        this.stepEndTimes.set(event.data.step, event.time)
        return
      case 'request/context':
        return this.setRoute(event.data.provider, event.data.model)
      case 'assistant/message':
        return this.endChat(event.data.step, event.time, event.data.usage, event.data.interrupted === true)
      case 'tool/call':
        return this.startTool(event.data.callId, event.data.name, event.data.step, event.time)
      case 'tool/result':
        return this.endTool(
          event.data.message.source.callId,
          event.time,
          event.data.message.content[0].isError === true,
          event.data.error,
        )
      default:
        return
    }
  }

  /**
   * Close the chat span for a failed model request at its step's recorded end.
   * @param step - the step whose request failed.
   * @param error - the thrown value.
   */
  fail(step: number, error: unknown): void {
    const open = this.chatSpans.get(step)
    if (open === undefined) return
    this.chatSpans.delete(step)
    const endTime = this.stepEndTimes.get(step) ?? this.lastEventTime
    // Deliberately NOT `recordException`: it writes `exception.message` and
    // `exception.stacktrace` as span events, which bypasses the projection
    // allowlist and puts provider text — which can quote the prompt back — on
    // the wire in every content mode. The stable type is what a receiver can
    // alert on; the message stays in the host's own logs.
    open.span.setStatus({ code: SpanStatusCode.ERROR })
    open.span.setAttribute(ATTR_ERROR_TYPE, errorType(error))
    open.span.end(endTime)
    this.recordDuration(GEN_AI_OPERATION_NAME_VALUE_CHAT, open.startTime, endTime)
  }

  /**
   * Close every open span, marked as lacking its own end event. Ends at the last
   * event seen so durations stay lower bounds instead of absorbing idle time.
   */
  closeAll(): void {
    for (const [step, open] of this.chatSpans) {
      this.chatSpans.delete(step)
      this.closeUnclosed(open, GEN_AI_OPERATION_NAME_VALUE_CHAT)
    }
    for (const [callId, open] of this.toolSpans) {
      this.toolSpans.delete(callId)
      this.closeUnclosed(open, GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL)
    }
    if (this.turnSpan !== undefined) {
      this.turnSpan.setAttribute(ATTR_DSH_SPAN_UNCLOSED, true)
      this.turnSpan.end(this.lastEventTime)
      this.turnSpan = undefined
    }
  }

  private startTurn(turn: number, time: number): void {
    // An open turn span here means the previous turn/end never arrived.
    if (this.turnSpan !== undefined) this.closeAll()
    this.turnNumber = turn
    this.turnStartTime = time
    this.stepEndTimes.clear()
    this.turnSpan = this.tracer.startSpan(
      `${GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT} ${DSH_AGENT_NAME}`,
      {
        startTime: time,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
          [ATTR_GEN_AI_CONVERSATION_ID]: this.sessionId,
          [ATTR_DSH_SESSION_ID]: this.sessionId,
          [ATTR_DSH_TURN]: turn,
        },
      },
      ROOT_CONTEXT,
    )
    this.lastContext = trace.setSpan(ROOT_CONTEXT, this.turnSpan)
    this.instruments.turns.add(1)
  }

  private endTurn(reason: string, time: number): void {
    // Tool results land within their turn, so anything still open has none coming.
    for (const [step, open] of this.chatSpans) {
      this.chatSpans.delete(step)
      this.closeUnclosed(open, GEN_AI_OPERATION_NAME_VALUE_CHAT)
    }
    for (const [callId, open] of this.toolSpans) {
      this.toolSpans.delete(callId)
      this.closeUnclosed(open, GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL)
    }
    const span = this.turnSpan
    if (span === undefined) return
    this.turnSpan = undefined
    span.setAttribute(ATTR_DSH_TURN_END_REASON, reason)
    if (reason === 'error') span.setStatus({ code: SpanStatusCode.ERROR })
    span.end(time)
    this.recordDuration(GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT, this.turnStartTime, time)
  }

  private startStep(turn: number, step: number, time: number): void {
    const span = this.tracer.startSpan(
      `${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${this.model ?? UNKNOWN_MODEL}`,
      { startTime: time, attributes: this.chatAttributes(turn, step) },
      this.turnContext(),
    )
    this.chatSpans.set(step, { span, startTime: time, step })
    this.instruments.steps.add(1)
  }

  private setRoute(provider: string, model: string): void {
    this.provider = provider
    this.model = model
    // Appended inside the step, after the chat span opened with a placeholder.
    for (const open of this.chatSpans.values()) {
      open.span.updateName(`${GEN_AI_OPERATION_NAME_VALUE_CHAT} ${model}`)
      open.span.setAttribute(ATTR_GEN_AI_REQUEST_MODEL, model)
      open.span.setAttributes(this.routeAttributes())
    }
  }

  private endChat(step: number, time: number, usage: TokenUsage | undefined, interrupted: boolean): void {
    const open = this.chatSpans.get(step)
    if (open === undefined) return
    this.chatSpans.delete(step)
    if (interrupted) open.span.setAttribute(ATTR_DSH_RESPONSE_INTERRUPTED, true)
    if (usage !== undefined) {
      open.span.setAttributes(usageAttributes(usage))
      this.recordUsage(usage)
    }
    open.span.end(time)
    this.recordDuration(GEN_AI_OPERATION_NAME_VALUE_CHAT, open.startTime, time)
  }

  private startTool(callId: string, name: string, step: number, time: number): void {
    const span = this.tracer.startSpan(
      `${GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL} ${name}`,
      {
        startTime: time,
        attributes: {
          [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
          [ATTR_GEN_AI_TOOL_NAME]: name,
          [ATTR_GEN_AI_TOOL_CALL_ID]: callId,
          [ATTR_GEN_AI_CONVERSATION_ID]: this.sessionId,
          [ATTR_DSH_SESSION_ID]: this.sessionId,
          [ATTR_DSH_TURN]: this.turnNumber,
          [ATTR_DSH_STEP]: step,
        },
      },
      this.turnContext(),
    )
    this.toolSpans.set(callId, { span, startTime: time, step, toolName: name })
  }

  private endTool(callId: string, time: number, isError: boolean, error: { name: string; code: string } | undefined): void {
    const open = this.toolSpans.get(callId)
    if (open === undefined) return
    this.toolSpans.delete(callId)
    const outcome = isError ? 'error' : 'ok'
    open.span.setAttribute(ATTR_DSH_TOOL_OUTCOME, outcome)
    if (isError) {
      open.span.setStatus({ code: SpanStatusCode.ERROR })
      // `isError` already decided the outcome; a missing `error` is not success.
      open.span.setAttribute(ATTR_ERROR_TYPE, error?.name ?? 'tool_error')
      if (error !== undefined) open.span.setAttribute(ATTR_DSH_ERROR_CODE, error.code)
    }
    open.span.end(time)
    this.recordDuration(GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL, open.startTime, time, open.toolName)
    this.instruments.toolInvocations.add(1, {
      ...open.toolName === undefined ? {} : { [ATTR_GEN_AI_TOOL_NAME]: open.toolName },
      [ATTR_DSH_TOOL_OUTCOME]: outcome,
    })
  }

  private closeUnclosed(open: OpenSpan, operation: string): void {
    open.span.setAttribute(ATTR_DSH_SPAN_UNCLOSED, true)
    open.span.end(this.lastEventTime)
    this.recordDuration(operation, open.startTime, this.lastEventTime, open.toolName)
  }

  private chatAttributes(turn: number, step: number): Attributes {
    return {
      [ATTR_GEN_AI_OPERATION_NAME]: GEN_AI_OPERATION_NAME_VALUE_CHAT,
      [ATTR_GEN_AI_CONVERSATION_ID]: this.sessionId,
      [ATTR_DSH_SESSION_ID]: this.sessionId,
      [ATTR_DSH_TURN]: turn,
      [ATTR_DSH_STEP]: step,
      ...this.routeAttributes(),
    }
  }

  /**
   * The provider and model attributes for the current route.
   *
   * `gen_ai.system` carries the same value as `gen_ai.provider.name`. It is
   * deprecated, but existing GenAI dashboards and collectors select on it, and
   * a span that omits it is invisible to them.
   * @returns the route attributes, empty until `request/context` reveals them.
   */
  private routeAttributes(): Attributes {
    return {
      ...this.model === undefined ? {} : { [ATTR_GEN_AI_REQUEST_MODEL]: this.model },
      ...this.provider === undefined ? {} : {
        [ATTR_GEN_AI_PROVIDER_NAME]: this.provider,
        [ATTR_GEN_AI_SYSTEM]: this.provider,
      },
    }
  }

  private turnContext(): OtelContext {
    return this.turnSpan === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, this.turnSpan)
  }

  /**
   * Context for correlating other signals; a log emitted with it carries the
   * turn's trace and span ids.
   * @returns the last turn's context, or undefined before the first turn.
   */
  activeContext(): OtelContext | undefined {
    return this.lastContext
  }

  private recordUsage(usage: TokenUsage): void {
    const dimensions = this.routeAttributes()
    this.instruments.tokenUsage.record(billedInputTokens(usage), {
      ...dimensions,
      [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_INPUT,
    })
    this.instruments.tokenUsage.record(usage.outputTokens, {
      ...dimensions,
      [ATTR_GEN_AI_TOKEN_TYPE]: GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
    })
    for (const [kind, value] of [
      ['cache_read', usage.cacheReadTokens],
      ['cache_write', usage.cacheWriteTokens],
      ['reasoning', usage.reasoningTokens],
    ] as const) {
      if (value === undefined) continue
      this.instruments.tokenDetail.record(value, { ...dimensions, [ATTR_DSH_TOKEN_DETAIL_KIND]: kind })
    }
  }

  /**
   * Record a duration into the instrument the conventions define for it. One
   * shared histogram would mix a whole agent run with a single inference, and a
   * p95 over that describes neither.
   * @param operation - the GenAI operation name.
   * @param startTime - operation start, in epoch milliseconds.
   * @param endTime - operation end, in epoch milliseconds.
   * @param toolName - the tool, for the tool-execution instrument's dimension.
   */
  private recordDuration(operation: string, startTime: number, endTime: number, toolName?: string): void {
    const seconds = Math.max(0, endTime - startTime) / 1000
    switch (operation) {
      case GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT:
        this.instruments.agentDuration.record(seconds, { [ATTR_GEN_AI_OPERATION_NAME]: operation })
        return
      case GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL:
        this.instruments.toolDuration.record(seconds, {
          [ATTR_GEN_AI_OPERATION_NAME]: operation,
          ...toolName === undefined ? {} : { [ATTR_GEN_AI_TOOL_NAME]: toolName },
        })
        return
      default:
        // `gen_ai.client.operation.duration` requires the provider dimension.
        this.instruments.operationDuration.record(seconds, {
          [ATTR_GEN_AI_OPERATION_NAME]: operation,
          ...this.routeAttributes(),
        })
    }
  }
}

/**
 * DSH reports disjoint counts, so `inputTokens` alone understates every cached
 * request; the convention's `input_tokens` is the billed total.
 * @param usage - the provider-reported accounting for one model call.
 * @returns uncached input plus cache reads plus cache writes.
 */
export function billedInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * @param usage - the provider-reported accounting for one model call.
 * @returns standard billed totals plus the DSH breakdown.
 */
export function usageAttributes(usage: TokenUsage): Attributes {
  return {
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: billedInputTokens(usage),
    // Already includes reasoning tokens; adding them would double-count.
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
    [ATTR_DSH_USAGE_UNCACHED_INPUT_TOKENS]: usage.inputTokens,
    ...usage.cacheReadTokens === undefined ? {} : { [ATTR_DSH_USAGE_CACHE_READ_TOKENS]: usage.cacheReadTokens },
    ...usage.cacheWriteTokens === undefined ? {} : { [ATTR_DSH_USAGE_CACHE_WRITE_TOKENS]: usage.cacheWriteTokens },
    ...usage.reasoningTokens === undefined ? {} : { [ATTR_DSH_USAGE_REASONING_TOKENS]: usage.reasoningTokens },
  }
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
