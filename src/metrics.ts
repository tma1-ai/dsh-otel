/**
 * Metric instruments recorded alongside spans.
 *
 * The standard `gen_ai.client.*` instruments carry only what the convention
 * defines, so any GenAI dashboard reads them unchanged. DSH-specific counts
 * live under `dsh.*` rather than as extra dimensions, which would make a naive
 * `SUM(gen_ai.client.token.usage)` double-count.
 *
 * @module metrics
 */

import type { Meter, Counter, Histogram } from '@opentelemetry/api'
import {
  METRIC_DSH_STEPS,
  METRIC_DSH_TOKEN_DETAIL,
  METRIC_DSH_TOOL_INVOCATIONS,
  METRIC_DSH_TURNS,
  METRIC_GEN_AI_CLIENT_OPERATION_DURATION,
  METRIC_GEN_AI_CLIENT_TOKEN_USAGE,
  METRIC_GEN_AI_EXECUTE_TOOL_DURATION,
  METRIC_GEN_AI_INVOKE_AGENT_DURATION,
} from './semconv.js'

/** The instrument set every session recorder records into. */
export interface Instruments {
  readonly tokenUsage: Histogram
  /** `chat` only: the convention scopes this to one inference. */
  readonly operationDuration: Histogram
  readonly agentDuration: Histogram
  readonly toolDuration: Histogram
  /** Kept off the standard token histogram so a plain sum cannot double-count. */
  readonly tokenDetail: Histogram
  readonly toolInvocations: Counter
  readonly turns: Counter
  readonly steps: Counter
}

/**
 * @param meter - the meter to register instruments on.
 * @returns the instruments, ready to record.
 */
export function createInstruments(meter: Meter): Instruments {
  return {
    tokenUsage: meter.createHistogram(METRIC_GEN_AI_CLIENT_TOKEN_USAGE, {
      description: 'Number of input and output tokens used by the model call',
      unit: '{token}',
    }),
    operationDuration: meter.createHistogram(METRIC_GEN_AI_CLIENT_OPERATION_DURATION, {
      description: 'Duration of one model call',
      unit: 's',
    }),
    agentDuration: meter.createHistogram(METRIC_GEN_AI_INVOKE_AGENT_DURATION, {
      description: 'Duration of one agent turn',
      unit: 's',
    }),
    toolDuration: meter.createHistogram(METRIC_GEN_AI_EXECUTE_TOOL_DURATION, {
      description: 'Duration of one tool execution',
      unit: 's',
    }),
    tokenDetail: meter.createHistogram(METRIC_DSH_TOKEN_DETAIL, {
      description: 'Cache-read, cache-write, and reasoning token counts reported by the provider',
      unit: '{token}',
    }),
    toolInvocations: meter.createCounter(METRIC_DSH_TOOL_INVOCATIONS, {
      description: 'Tool calls completed, by tool name and outcome',
      unit: '{invocation}',
    }),
    turns: meter.createCounter(METRIC_DSH_TURNS, {
      description: 'Agent turns opened',
      unit: '{turn}',
    }),
    steps: meter.createCounter(METRIC_DSH_STEPS, {
      description: 'Agent steps opened',
      unit: '{step}',
    }),
  }
}
