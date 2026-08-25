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

import { ExportResultCode, type ExportResult } from '@opentelemetry/core'
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { LoggerProvider, BatchLogRecordProcessor } from '@opentelemetry/sdk-logs'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto'
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { metrics, trace, type Tracer } from '@opentelemetry/api'
import { logs, type Logger } from '@opentelemetry/api-logs'
import { ATTR_SERVICE_NAME } from './semconv.js'
import { exporterOptions } from './otlp.js'
import type { ResolvedConfig } from './config.js'
import { createInstruments, type Instruments } from './metrics.js'

/** Instrumentation scope reported for every span, metric, and log record. */
export const SCOPE_NAME = '@tma1-ai/dsh-plugin-greptimedb'

/** Where a reported failure came from, so the log line can say which. */
export type FailureStage = 'export' | 'shutdown'

/** Receives every contained pipeline failure. */
export type FailureSink = (stage: FailureStage, error: unknown) => void

/**
 * Wrap an exporter so failed exports are reported instead of vanishing.
 *
 * The batch processors swallow export failures: they hand the result back to
 * the SDK's global `diag` and nothing else. A GreptimeDB rejection — a schema
 * mismatch, a bad table name, expired credentials — therefore looks exactly
 * like success from the outside, with the data silently absent. Wrapping the
 * exporter is precise (one callback per export) and leaves the process-global
 * `diag` alone for the host application to own.
 *
 * @param inner - the exporter to wrap.
 * @param onError - receives the failure of each rejected export.
 * @returns a proxy delegating everything except the export result inspection.
 */
function reportingExporter<T extends object>(inner: T, onError: FailureSink): T {
  return new Proxy(inner, {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, receiver)
      if (property !== 'export' || typeof value !== 'function') return value
      return (items: unknown, resultCallback: (result: ExportResult) => void): void => {
        (value as (i: unknown, cb: (r: ExportResult) => void) => void).call(target, items, (result) => {
          if (result.code === ExportResultCode.FAILED) {
            onError('export', result.error ?? new Error('OTLP export failed without an error'))
          }
          resultCallback(result)
        })
      }
    },
  })
}

/**
 * The SDK pipeline for one plugin instance.
 *
 * Every accessor is always present. A disabled signal gets the API's no-op
 * implementation, which records nothing and builds no exporter, so each signal
 * is genuinely independent: enabling only traces still produces spans, and
 * enabling only metrics still records instruments. Handing back `undefined`
 * instead made callers guard on one signal to use another, which silently
 * dropped data for any single-signal configuration.
 */
export interface Pipeline {
  /** Span factory; a no-op tracer when traces are disabled. */
  readonly tracer: Tracer
  /** Metric instruments; backed by a no-op meter when metrics are disabled. */
  readonly instruments: Instruments
  /** Log emitter; a no-op logger when logs are disabled. */
  readonly logger: Logger
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
 * @param onError - receives every contained export and shutdown failure.
 * @returns the pipeline, whose absent members correspond to disabled signals.
 */
export function createPipeline(
  config: ResolvedConfig,
  version: string,
  onError: FailureSink,
): Pipeline {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName })
  const shutdowns: (() => Promise<void>)[] = []

  // The API's global providers are never registered by this plugin, so these
  // resolve to the no-op implementations.
  let tracer: Tracer = trace.getTracer(SCOPE_NAME, version)
  if (config.signals.has('traces')) {
    const provider = new NodeTracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor(reportingExporter(new OTLPTraceExporter(exporterOptions(config, 'traces')), onError), {
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

  let instruments: Instruments = createInstruments(metrics.getMeter(SCOPE_NAME, version))
  if (config.signals.has('metrics')) {
    const provider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: reportingExporter(new OTLPMetricExporter(exporterOptions(config, 'metrics')), onError),
          exportIntervalMillis: config.metricIntervalMillis,
          exportTimeoutMillis: config.exportTimeoutMillis,
        }),
      ],
    })
    instruments = createInstruments(provider.getMeter(SCOPE_NAME, version))
    shutdowns.push(() => provider.shutdown())
  }

  let logger: Logger = logs.getLogger(SCOPE_NAME, version)
  if (config.signals.has('logs')) {
    const provider = new LoggerProvider({
      resource,
      processors: [
        new BatchLogRecordProcessor({
          exporter: reportingExporter(new OTLPLogExporter(exporterOptions(config, 'logs')), onError),
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
 * @returns resolves once the sequence settles or the deadline passes.
 */
export async function shutdownAll(
  shutdowns: readonly (() => Promise<void>)[],
  timeoutMillis: number,
  onError: FailureSink,
): Promise<void> {
  // Only the first failure is worth reporting; a later one is almost always the
  // same transport fault seen by another provider, and after a deadline has
  // already been reported the sequence's own outcome adds nothing.
  let reported = false
  const report = (error: unknown): void => {
    if (reported) return
    reported = true
    onError('shutdown', error)
  }
  // Every provider's shutdown is STARTED before anything is awaited. Awaiting
  // them one at a time meant a first provider that never resolves kept the
  // others from beginning theirs, so the deadline returned with two exporters
  // still holding their timers.
  const started = shutdowns.map(shutdown => shutdown())
  const sequence = (async () => {
    const settled = await Promise.allSettled(started)
    const first = settled.find(outcome => outcome.status === 'rejected')
    if (first !== undefined) throw (first as PromiseRejectedResult).reason
  })()
  // Observed, not abandoned: a rejection arriving after the deadline would
  // otherwise be unhandled.
  sequence.catch(report)
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => { reject(new Error(`@tma1-ai/dsh-plugin-greptimedb: telemetry shutdown exceeded ${timeoutMillis}ms`)) },
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
