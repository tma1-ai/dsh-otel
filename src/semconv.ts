/**
 * Attribute and instrument names used by this plugin.
 *
 * Standard GenAI names are re-exported from `@opentelemetry/semantic-conventions`
 * rather than written as string literals, so a semconv upgrade moves them here
 * and nowhere else.
 *
 * @module semconv
 */

// The GenAI conventions are still experimental and therefore live behind the
// package's `/incubating` entry, not its stable root.
export {
  ATTR_GEN_AI_CONVERSATION_ID,
  ATTR_GEN_AI_OPERATION_NAME,
  ATTR_GEN_AI_PROVIDER_NAME,
  /**
   * Deprecated in favour of `gen_ai.provider.name`, and emitted anyway with the
   * same value: existing GenAI dashboards and collectors filter on it, and a
   * span carrying only the new name is invisible to them. Deprecated is not
   * removed, and one extra attribute is cheaper than an ecosystem mismatch.
   */
  ATTR_GEN_AI_SYSTEM,
  ATTR_GEN_AI_REQUEST_MODEL,
  ATTR_GEN_AI_TOKEN_TYPE,
  ATTR_GEN_AI_TOOL_CALL_ID,
  ATTR_GEN_AI_TOOL_NAME,
  ATTR_GEN_AI_USAGE_INPUT_TOKENS,
  ATTR_GEN_AI_USAGE_OUTPUT_TOKENS,
  GEN_AI_OPERATION_NAME_VALUE_CHAT,
  GEN_AI_OPERATION_NAME_VALUE_EXECUTE_TOOL,
  GEN_AI_OPERATION_NAME_VALUE_INVOKE_AGENT,
  GEN_AI_TOKEN_TYPE_VALUE_INPUT,
  GEN_AI_TOKEN_TYPE_VALUE_OUTPUT,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
} from '@opentelemetry/semantic-conventions/incubating'

export { ATTR_ERROR_TYPE, ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'

/** Session this span or record belongs to. Duplicates `gen_ai.conversation.id` for queries that predate the GenAI convention. */
export const ATTR_DSH_SESSION_ID = 'dsh.session.id'
/** Turn number the span or record belongs to. */
export const ATTR_DSH_TURN = 'dsh.turn'
/**
 * Step number within the turn. Chat and tool spans are siblings under the turn
 * span, so this attribute — not the span parent — is what associates a tool
 * call with the model call that requested it.
 */
export const ATTR_DSH_STEP = 'dsh.step'
/** `TurnEndReason.kind` from `turn/end`. */
export const ATTR_DSH_TURN_END_REASON = 'dsh.turn.end_reason'
/** Set when the assistant message was finalized from an interrupted stream. */
export const ATTR_DSH_RESPONSE_INTERRUPTED = 'dsh.response.interrupted'
/**
 * Set when a span was closed without its own end event (process teardown, a
 * crashed session, a tool that never reported a result). Such a span's duration
 * is a lower bound, not a measurement.
 */
export const ATTR_DSH_SPAN_UNCLOSED = 'dsh.span.unclosed'
/** Tool outcome from the result block's `isError`. */
export const ATTR_DSH_TOOL_OUTCOME = 'dsh.tool.outcome'
/** Internal failure code from `tool/result.error.code`, when the tool reported one. */
export const ATTR_DSH_ERROR_CODE = 'dsh.error.code'

/**
 * Uncached prompt tokens alone. `gen_ai.usage.input_tokens` carries billed
 * input (uncached + cache read + cache write); this breakdown is what makes
 * cache effectiveness queryable.
 */
export const ATTR_DSH_USAGE_UNCACHED_INPUT_TOKENS = 'dsh.usage.uncached_input_tokens'
/** Prompt tokens served from the provider's cache. */
export const ATTR_DSH_USAGE_CACHE_READ_TOKENS = 'dsh.usage.cache_read_tokens'
/** Prompt tokens written into the provider's cache. */
export const ATTR_DSH_USAGE_CACHE_WRITE_TOKENS = 'dsh.usage.cache_write_tokens'
/** Reasoning tokens, already counted inside `gen_ai.usage.output_tokens`. */
export const ATTR_DSH_USAGE_REASONING_TOKENS = 'dsh.usage.reasoning_tokens'

/**
 * Duration of one agent invocation, per the GenAI conventions' agent metrics.
 *
 * Separate from `gen_ai.client.operation.duration`, which covers a single model
 * call: folding a whole turn into it would mix a 20-second agent run with a
 * 2-second inference into one distribution. Written as a literal because
 * `@opentelemetry/semantic-conventions` has not yet published the agent and
 * tool metrics from the GenAI conventions repository.
 */
export const METRIC_GEN_AI_INVOKE_AGENT_DURATION = 'gen_ai.invoke_agent.duration'
/** Duration of one tool execution; see {@link METRIC_GEN_AI_INVOKE_AGENT_DURATION} for why it is a literal. */
export const METRIC_GEN_AI_EXECUTE_TOOL_DURATION = 'gen_ai.execute_tool.duration'

/** Counter: tool invocations by name and outcome. */
export const METRIC_DSH_TOOL_INVOCATIONS = 'dsh.tool.invocations'
/** Counter: turns opened. */
export const METRIC_DSH_TURNS = 'dsh.turns'
/** Counter: steps opened. */
export const METRIC_DSH_STEPS = 'dsh.steps'
/** Histogram: cache-read/cache-write/reasoning token counts, kept out of the standard token metric. */
export const METRIC_DSH_TOKEN_DETAIL = 'dsh.token.detail'
/** Detail token kind for {@link METRIC_DSH_TOKEN_DETAIL}. */
export const ATTR_DSH_TOKEN_DETAIL_KIND = 'dsh.token.detail_kind'

/** Agent name used for the turn span, matching the GenAI `invoke_agent {name}` span-name convention. */
export const DSH_AGENT_NAME = 'dsh'
