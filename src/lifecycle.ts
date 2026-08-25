/**
 * SDK provider construction and bounded teardown.
 *
 * OTel's export timeout bounds the request, not the `forceFlush()` that
 * shutdown awaits first, so a transport that never gets a socket leaves the
 * promise pending and a CLI that awaits it never exits. The whole sequence runs
 * under one plugin-owned deadline instead.
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

export type FailureStage = 'export' | 'shutdown'

export type FailureSink = (stage: FailureStage, error: unknown) => void

/**
 * Report failed exports instead of letting them vanish.
 *
 * The batch processors hand failures to the SDK's global `diag` and nothing
 * else, so a rejected write looks exactly like success with the data absent.
 * Wrapping is precise and leaves the process-global `diag` to the host.
 *
 * @param inner - the exporter to wrap.
 * @param onError - receives the failure of each rejected export.
 * @returns a proxy that only adds result inspection.
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
 * Every accessor is always present; a disabled signal gets the API's no-op
 * implementation. Handing back `undefined` made callers guard on one signal to
 * use another, which silently dropped data for single-signal configurations.
 */
export interface Pipeline {
  readonly tracer: Tracer
  readonly instruments: Instruments
  readonly logger: Logger
  /** Never rejects: best-effort telemetry must not fail application teardown. */
  shutdown(): Promise<void>
}

/**
 * @param config - the resolved plugin configuration.
 * @param version - reported as the instrumentation scope version.
 * @param onError - receives every contained export and shutdown failure.
 * @returns the pipeline; disabled signals are backed by no-op implementations.
 */
export function createPipeline(
  config: ResolvedConfig,
  version: string,
  onError: FailureSink,
): Pipeline {
  const resource = resourceFromAttributes({ [ATTR_SERVICE_NAME]: config.serviceName })
  const shutdowns: (() => Promise<void>)[] = []

  // No global provider is registered, so these resolve to no-ops.
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
  // A later failure is almost always the same transport fault seen again.
  let reported = false
  const report = (error: unknown): void => {
    if (reported) return
    reported = true
    onError('shutdown', error)
  }
  // All started before anything is awaited: awaiting one at a time let a hung
  // first provider keep the others from ever beginning.
  const started = shutdowns.map(shutdown => shutdown())
  const sequence = (async () => {
    const settled = await Promise.allSettled(started)
    const first = settled.find(outcome => outcome.status === 'rejected')
    if (first !== undefined) throw (first as PromiseRejectedResult).reason
  })()
  // Observed so a post-deadline rejection is not unhandled.
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
