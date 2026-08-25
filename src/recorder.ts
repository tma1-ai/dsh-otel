/**
 * Per-session span and metric state machine.
 *
 * Spans are reconstructed from an append-only event stream rather than from
 * async context, so parents are threaded explicitly and every timestamp comes
 * from the event that justifies it — never from a wall clock read at handling
 * time, which would drift from the log by the whole handler latency.
 *
 * The chat/tool sibling layout is forced by the loop's real order: DSH appends
 * `assistant/message` and only then executes the tools that message requested.
 * Nesting tool spans under a chat span that ends at `assistant/message` would
 * place every child entirely after its parent's end.
 *
 * @module recorder
 */

import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Attributes,
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

/** Span name used before `request/context` reveals the model. */
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
  /** Chat spans by step number; a turn has at most one open chat span per step. */
  private readonly chatSpans = new Map<number, OpenSpan>()
  /** Tool spans by call id, the only key that survives the call/result gap. */
  private readonly toolSpans = new Map<string, OpenSpan>()
  /**
   * Last `step/end` time per step. `step/end` is appended in a `finally` and
   * therefore always precedes `agent/error`, making it the correct end time for
   * a chat span that failed before producing an assistant message.
   */
  private readonly stepEndTimes = new Map<number, number>()
  private provider: string | undefined
  private model: string | undefined
  /** Time of the most recent event, the fallback end time for a span with no closing event. */
  private lastEventTime: number

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
        // Every other event type — chunks, todos, headers, and plugin-declared
        // types — moves no span boundary.
        return
    }
  }

  /**
   * Close the chat span for a failed model request.
   *
   * The loop appends `step/end` in a `finally` before emitting `agent/error`,
   * so the step's recorded end time is available and is the honest boundary.
   * @param step - the step whose request failed.
   * @param error - the thrown value.
   */
  fail(step: number, error: unknown): void {
    const open = this.chatSpans.get(step)
    if (open === undefined) return
    this.chatSpans.delete(step)
    const endTime = this.stepEndTimes.get(step) ?? this.lastEventTime
    open.span.recordException(toException(error), endTime)
    open.span.setStatus({ code: SpanStatusCode.ERROR })
    open.span.setAttribute(ATTR_ERROR_TYPE, errorType(error))
    open.span.end(endTime)
    this.recordDuration(GEN_AI_OPERATION_NAME_VALUE_CHAT, open.startTime, endTime)
  }

  /**
   * Close every span still open, marking each as lacking its own end event.
   *
   * Called at session disposal and at plugin teardown. The end time is the last
   * event seen, so a span's duration stays a lower bound rather than absorbing
   * the idle time until shutdown.
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
    // A turn/start with a turn span still open means the previous turn's
    // turn/end never arrived (crash, or a log whose tail was lost).
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
    this.instruments.turns.add(1)
  }

  private endTurn(reason: string, time: number): void {
    // Tool results land within their turn; anything still open at turn/end has
    // no result event coming.
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
    // request/context is appended inside the step, after its chat span opened
    // with a placeholder name.
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
      // `error` is optional internal failure identity; `isError` already
      // decided the outcome, so its absence is not a success signal.
      open.span.setAttribute(ATTR_ERROR_TYPE, error?.name ?? 'tool_error')
      if (error !== undefined) open.span.setAttribute(ATTR_DSH_ERROR_CODE, error.code)
    }
    open.span.end(time)
    this.recordDuration(GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL, open.startTime, time)
    this.instruments.toolInvocations.add(1, {
      ...open.toolName === undefined ? {} : { [ATTR_GEN_AI_TOOL_NAME]: open.toolName },
      [ATTR_DSH_TOOL_OUTCOME]: outcome,
    })
  }

  private closeUnclosed(open: OpenSpan, operation: string): void {
    open.span.setAttribute(ATTR_DSH_SPAN_UNCLOSED, true)
    open.span.end(this.lastEventTime)
    this.recordDuration(operation, open.startTime, this.lastEventTime)
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

  private turnContext() {
    return this.turnSpan === undefined ? ROOT_CONTEXT : trace.setSpan(ROOT_CONTEXT, this.turnSpan)
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

  private recordDuration(operation: string, startTime: number, endTime: number): void {
    this.instruments.operationDuration.record(Math.max(0, endTime - startTime) / 1000, {
      [ATTR_GEN_AI_OPERATION_NAME]: operation,
      ...this.model === undefined ? {} : { [ATTR_GEN_AI_REQUEST_MODEL]: this.model },
    })
  }
}

/**
 * Billed input tokens.
 *
 * DSH reports disjoint counts: `inputTokens` is uncached input only, with cache
 * hits and writes accounted separately. The GenAI convention's
 * `gen_ai.usage.input_tokens` is the billed total, so exporting `inputTokens`
 * alone would understate every cached request.
 *
 * @param usage - the provider-reported accounting for one model call.
 * @returns uncached input plus cache reads plus cache writes.
 */
export function billedInputTokens(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

/**
 * Build the token attributes for a chat span.
 * @param usage - the provider-reported accounting for one model call.
 * @returns standard billed totals plus the DSH breakdown.
 */
export function usageAttributes(usage: TokenUsage): Attributes {
  return {
    [ATTR_GEN_AI_USAGE_INPUT_TOKENS]: billedInputTokens(usage),
    // `outputTokens` already includes reasoning tokens; adding them would
    // double-count.
    [ATTR_GEN_AI_USAGE_OUTPUT_TOKENS]: usage.outputTokens,
    [ATTR_DSH_USAGE_UNCACHED_INPUT_TOKENS]: usage.inputTokens,
    ...usage.cacheReadTokens === undefined ? {} : { [ATTR_DSH_USAGE_CACHE_READ_TOKENS]: usage.cacheReadTokens },
    ...usage.cacheWriteTokens === undefined ? {} : { [ATTR_DSH_USAGE_CACHE_WRITE_TOKENS]: usage.cacheWriteTokens },
    ...usage.reasoningTokens === undefined ? {} : { [ATTR_DSH_USAGE_REASONING_TOKENS]: usage.reasoningTokens },
  }
}

function toException(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function errorType(error: unknown): string {
  return error instanceof Error ? error.name : typeof error
}
