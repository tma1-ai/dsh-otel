/**
 * Metric instruments recorded alongside spans.
 *
 * The standard `gen_ai.client.*` instruments carry only the values the
 * convention defines, so a dashboard built for any GenAI application reads them
 * unchanged. DSH-specific counts live under `dsh.*` rather than as extra
 * dimensions on the standard instruments, which would make a naive
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
} from './semconv.js'

/** The instrument set every session recorder records into. */
export interface Instruments {
  /** Billed input and output tokens, split by `gen_ai.token.type`. */
  readonly tokenUsage: Histogram
  /** Chat and tool operation duration in seconds, per the GenAI convention's unit. */
  readonly operationDuration: Histogram
  /** Cache-read, cache-write, and reasoning token counts, kept off the standard token histogram. */
  readonly tokenDetail: Histogram
  /** Tool invocations by name and outcome. */
  readonly toolInvocations: Counter
  /** Turns opened. */
  readonly turns: Counter
  /** Steps opened. */
  readonly steps: Counter
}

/**
 * Create the instrument set.
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
      description: 'Duration of a GenAI operation',
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
