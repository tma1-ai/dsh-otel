/**
 * SDK provider construction and bounded teardown.
 *
 * OTel's own export timeout bounds the export request, not the `forceFlush()`
 * that shutdown awaits first: when the transport never obtains a socket, a
 * provider's shutdown promise can stay pending forever. A CLI that awaits it
 * would never exit, so the whole sequence — all three providers — runs under
 * one plugin-owned deadline, and the abandoned promises stay observed so a late
 * rejection cannot surface as an unhandled rejection.
 *
 * @module lifecycle
 */

import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import type { Tracer } from '@opentelemetry/api'
import type { Logger } from '@opentelemetry/api-logs'
import type { Meter } from '@opentelemetry/api'
import { ATTR_SERVICE_NAME } from './semconv.js'
import { exporterOptions } from './otlp.js'
import type { ResolvedConfig } from './config.js'
import { createInstruments, type Instruments } from './metrics.js'

/** Instrumentation scope reported for every span, metric, and log record. */
export const SCOPE_NAME = 'dsh-plugin-greptimedb'

/**
 * The SDK pipeline for one plugin instance.
 *
 * A provider is absent when its signal is not enabled, and the corresponding
 * accessor is `undefined` — callers branch on presence rather than emitting
 * into a no-op provider, so a disabled signal builds no exporter at all.
 */
export interface Pipeline {
  /** Span factory, present when traces are enabled. */
  readonly tracer: Tracer | undefined
  /** Metric instruments, present when metrics are enabled. */
  readonly instruments: Instruments | undefined
  /** Log emitter, present when logs are enabled. */
  readonly logger: Logger | undefined
  /**
   * Drain and quiesce every constructed provider, bounded by the configured
   * deadline. Never rejects: a shutdown failure is reported through `onError`
   * because best-effort telemetry must not fail application teardown.
   */
  shutdown(): Promise<void>
}

/**
 * Build the SDK pipeline for the enabled signals.
 * @param config - the resolved plugin configuration.
 * @param version - the plugin version, reported as the instrumentation scope version.
 * @param onError - receives a contained shutdown failure.
 * @returns the pipeline, whose absent members correspond to disabled signals.
 */
export function createPipeline(
  config: ResolvedConfig,
  version: string,
  onError: (error: unknown) => void,
): Pipeline {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName })
  const shutdowns: (() => Promise<void>)[] = []

  let tracer: Tracer | undefined
  if (config.signals.has('traces')) {
    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(new OTLPTraceExporter(exporterOptions(config, 'traces')), {
          maxExportBatchSize: config.maxExportBatchSize,
          maxQueueSize: config.maxQueueSize,
          scheduledDelayMillis: config.scheduledDelayMillis,
          exportTimeoutMillis: config.exportTimeoutMillis,
        }),
      ],
    })
    tracer = provider.getTracer(SCOPE_NAME, version)
    shutdowns.push(() => provider.shutdown())
  }

  let instruments: Instruments | undefined
  if (config.signals.has('metrics')) {
    const provider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter(exporterOptions(config, 'metrics')),
          exportIntervalMillis: config.metricIntervalMillis,
          exportTimeoutMillis: config.exportTimeoutMillis,
        }),
      ],
    })
    instruments = createInstruments(provider.getMeter(SCOPE_NAME, version))
    shutdowns.push(() => provider.shutdown())
  }

  let logger: Logger | undefined
  if (config.signals.has('logs')) {
    const provider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: new OTLPLogExporter(exporterOptions(config, 'logs')),
          maxExportBatchSize: config.maxExportBatchSize,
          maxQueueSize: config.maxQueueSize,
          scheduledDelayMillis: config.scheduledDelayMillis,
          exportTimeoutMillis: config.exportTimeoutMillis,
        }),
      ],
    })
    logger = provider.getLogger(SCOPE_NAME, version)
    shutdowns.push(() => provider.shutdown())
  }

  return {
    tracer,
    instruments,
    logger,
    shutdown: () => shutdownAll(shutdowns, config.shutdownTimeoutMillis, onError),
  }
}

/**
 * Run every provider shutdown under one shared deadline.
 *
 * Providers drain in registration order (traces, metrics, logs) so span exports
 * are attempted before the process is likely to be torn down.
 *
 * @param shutdowns - the provider shutdown thunks.
 * @param timeoutMillis - the deadline covering the whole sequence.
 * @param onError - receives the timeout or the first provider failure.
 */
async function shutdownAll(
  shutdowns: readonly (() => Promise<void>)[],
  timeoutMillis: number,
  onError: (error: unknown) => void,
): Promise<void> {
  // Only the first failure is worth reporting; a later one is almost always the
  // same transport fault seen by another provider, and after a deadline has
  // already been reported the sequence's own outcome adds nothing.
  let reported = false
  const report = (error: unknown): void => {
    if (reported) return
    reported = true
    onError(error)
  }
  const sequence = (async () => {
    // Every provider gets its shutdown attempted: an early failure must not
    // leave a later provider's exporter timers running.
    let first: unknown
    let failed = false
    for (const shutdown of shutdowns) {
      try {
        await shutdown()
      } catch (error) {
        if (!failed) { first = error; failed = true }
      }
    }
    if (failed) throw first
  })()
  // Observed, not abandoned: a rejection arriving after the deadline would
  // otherwise be unhandled.
  sequence.catch(report)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => { reject(new Error(`dsh-plugin-greptimedb: telemetry shutdown exceeded ${timeoutMillis}ms`)) },
      timeoutMillis,
    )
  })
  try {
    await Promise.race([sequence, deadline])
  } catch (error) {
    report(error)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}
