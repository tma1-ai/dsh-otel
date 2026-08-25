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

export const ATTR_DSH_SESSION_ID = 'dsh.session.id'
export const ATTR_DSH_TURN = 'dsh.turn'
/** Chat and tool spans are siblings, so this attribute, not the span parent, links a tool call to the model call that requested it. */
export const ATTR_DSH_STEP = 'dsh.step'
export const ATTR_DSH_TURN_END_REASON = 'dsh.turn.end_reason'
export const ATTR_DSH_RESPONSE_INTERRUPTED = 'dsh.response.interrupted'
/** Marks a span closed without its own end event; its duration is a lower bound, not a measurement. */
export const ATTR_DSH_SPAN_UNCLOSED = 'dsh.span.unclosed'
export const ATTR_DSH_TOOL_OUTCOME = 'dsh.tool.outcome'
export const ATTR_DSH_ERROR_CODE = 'dsh.error.code'

/** Uncached prompt tokens alone; `gen_ai.usage.input_tokens` carries the billed total, so this is what makes cache effectiveness queryable. */
export const ATTR_DSH_USAGE_UNCACHED_INPUT_TOKENS = 'dsh.usage.uncached_input_tokens'
export const ATTR_DSH_USAGE_CACHE_READ_TOKENS = 'dsh.usage.cache_read_tokens'
export const ATTR_DSH_USAGE_CACHE_WRITE_TOKENS = 'dsh.usage.cache_write_tokens'
/** Reasoning tokens, already counted inside `gen_ai.usage.output_tokens`. */
export const ATTR_DSH_USAGE_REASONING_TOKENS = 'dsh.usage.reasoning_tokens'

/**
 * Separate from `gen_ai.client.operation.duration` because folding a whole turn
 * into it would mix a 20-second agent run with a 2-second inference in one
 * distribution. A literal because the JS semconv package has not published the
 * agent and tool metrics yet.
 */
export const METRIC_GEN_AI_INVOKE_AGENT_DURATION = 'gen_ai.invoke_agent.duration'
/** See {@link METRIC_GEN_AI_INVOKE_AGENT_DURATION} for why these are literals. */
export const METRIC_GEN_AI_EXECUTE_TOOL_DURATION = 'gen_ai.execute_tool.duration'

export const METRIC_DSH_TOOL_INVOCATIONS = 'dsh.tool.invocations'
export const METRIC_DSH_TURNS = 'dsh.turns'
export const METRIC_DSH_STEPS = 'dsh.steps'
export const METRIC_DSH_TOKEN_DETAIL = 'dsh.token.detail'
export const ATTR_DSH_TOKEN_DETAIL_KIND = 'dsh.token.detail_kind'

/** Matches the GenAI `invoke_agent {name}` span-name convention. */
export const DSH_AGENT_NAME = 'dsh'
