/**
 * Plugin configuration and its explicit resolution step.
 *
 * {@link Config} is what a `cordis.yml` author writes; {@link ResolvedConfig} is
 * what the rest of the plugin consumes. Defaulting and validation happen once
 * in {@link resolveConfig} so no downstream module carries a `?? default`, and
 * every rejection names the field that caused it.
 *
 * @module config
 */

import z from '@deepseek-ai/schemastery'

/** Signals this plugin can export. */
export type Signal = 'traces' | 'metrics' | 'logs'

/** Every signal, in the order the shutdown sequence drains them. */
export const ALL_SIGNALS: readonly Signal[] = ['traces', 'metrics', 'logs']

/**
 * How much of a session event's payload may leave the process.
 *
 * `none` emits structure and accounting only. `full` adds conversation and tool
 * payloads. `full+prompt` additionally allows `request/header`, which carries
 * the complete system prompt and every tool schema.
 */
export type ContentMode = 'none' | 'full' | 'full+prompt'

/** Default outer allowance for the whole three-provider shutdown sequence. */
export const DEFAULT_SHUTDOWN_TIMEOUT_MILLIS = 3_000
/** Default metric collection period. */
export const DEFAULT_METRIC_INTERVAL_MILLIS = 30_000
/** Default span/log batch size handed to one export request. */
export const DEFAULT_MAX_EXPORT_BATCH_SIZE = 512
/** Default upper bound on spans/records buffered before new ones are dropped. */
export const DEFAULT_MAX_QUEUE_SIZE = 2_048
/** Default delay between batch exports. */
export const DEFAULT_SCHEDULED_DELAY_MILLIS = 5_000
/** Default per-request export deadline. */
export const DEFAULT_EXPORT_TIMEOUT_MILLIS = 30_000
/** Default GreptimeDB database. */
export const DEFAULT_DATABASE = 'public'
/** Default OTel `service.name`. */
export const DEFAULT_SERVICE_NAME = 'dsh'

/** Node clamps larger timer delays to one millisecond; a runtime limit, not a tunable. */
const MAX_TIMER_DELAY_MILLIS = 2_147_483_647

/** Plugin configuration as written in `cordis.yml`. */
export interface Config {
  /**
   * GreptimeDB OTLP base endpoint, e.g. `http://localhost:4000/v1/otlp`. Each
   * signal's `/v1/{traces,metrics,logs}` suffix is appended by this plugin, so
   * a per-signal path here is a misconfiguration.
   */
  endpoint: string
  /** GreptimeDB database name; sent as `X-Greptime-DB-Name`. */
  database?: string
  /** Basic-auth user. Authorization is sent only when both this and {@link password} are non-empty. */
  username?: string
  /** Basic-auth password. */
  password?: string
  /** Signals to export; omitting a signal builds none of its SDK pipeline. */
  signals?: Signal[]
  /** How much event payload may be exported; defaults to the structure-only `none`. */
  content?: ContentMode
  /** OTel `service.name` on the exported Resource. */
  serviceName?: string
  /** Table for logs; sent as `X-Greptime-Log-Table-Name`. GreptimeDB defaults to `opentelemetry_logs`. */
  logTable?: string
  /** Table for traces; sent as `X-Greptime-Trace-Table-Name`. GreptimeDB defaults to `opentelemetry_traces`. */
  traceTable?: string
  /** Outer deadline for the entire shutdown sequence across all three providers. */
  shutdownTimeoutMillis?: number
  /** Metric reader collection period. */
  metricIntervalMillis?: number
  /** Spans/records per export request. */
  maxExportBatchSize?: number
  /** Buffered spans/records before new ones are dropped. */
  maxQueueSize?: number
  /** Delay between batch exports. */
  scheduledDelayMillis?: number
  /** Per-request export deadline. */
  exportTimeoutMillis?: number
}

/**
 * Schemastery validator; cordis runs it before the plugin starts. It checks
 * field presence and primitive types only — range and format checks live in
 * {@link resolveConfig}, whose errors name the offending field.
 */
export const Config: z<Config> = z.object({
  endpoint: z.string().required(),
  database: z.string(),
  username: z.string(),
  password: z.string(),
  // An array field with no default resolves a missing key to `[]`, which would
  // silently disable every signal. Scalar fields have no such behavior and are
  // defaulted in resolveConfig instead.
  signals: z.array(z.union(['traces', 'metrics', 'logs'] as const)).default([...ALL_SIGNALS]),
  content: z.union(['none', 'full', 'full+prompt'] as const),
  serviceName: z.string(),
  logTable: z.string(),
  traceTable: z.string(),
  shutdownTimeoutMillis: z.number(),
  metricIntervalMillis: z.number(),
  maxExportBatchSize: z.number(),
  maxQueueSize: z.number(),
  scheduledDelayMillis: z.number(),
  exportTimeoutMillis: z.number(),
})

/** Configuration after defaulting and validation; the only form the plugin's internals read. */
export interface ResolvedConfig {
  readonly endpoint: URL
  readonly database: string
  readonly authorization: string | undefined
  readonly signals: ReadonlySet<Signal>
  readonly content: ContentMode
  readonly serviceName: string
  readonly logTable: string | undefined
  readonly traceTable: string | undefined
  readonly shutdownTimeoutMillis: number
  readonly metricIntervalMillis: number
  readonly maxExportBatchSize: number
  readonly maxQueueSize: number
  readonly scheduledDelayMillis: number
  readonly exportTimeoutMillis: number
}

/**
 * Apply defaults and reject invalid values.
 * @param config - the raw plugin configuration.
 * @returns the resolved configuration every other module consumes.
 * @throws if the endpoint is not an `http(s)` URL, a duration is not a positive
 *   finite integer within Node's timer range, or `signals` is empty.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  const endpoint = parseEndpoint(config.endpoint)
  const signals = new Set(config.signals ?? ALL_SIGNALS)
  if (signals.size === 0) {
    throw new Error('dsh-plugin-greptimedb: signals must name at least one of traces, metrics, logs')
  }
  const username = config.username ?? ''
  const password = config.password ?? ''
  if ((username === '') !== (password === '')) {
    throw new Error('dsh-plugin-greptimedb: username and password must be set together')
  }
  const exportTimeoutMillis = duration(config.exportTimeoutMillis, DEFAULT_EXPORT_TIMEOUT_MILLIS, 'exportTimeoutMillis')
  const metricIntervalMillis = duration(config.metricIntervalMillis, DEFAULT_METRIC_INTERVAL_MILLIS, 'metricIntervalMillis')
  // The metric reader rejects this pairing in its constructor; failing here
  // names both fields instead of surfacing an SDK message at mount time.
  if (metricIntervalMillis < exportTimeoutMillis) {
    throw new Error(
      `dsh-plugin-greptimedb: metricIntervalMillis (${String(metricIntervalMillis)}) must be at least exportTimeoutMillis (${String(exportTimeoutMillis)})`,
    )
  }
  return {
    endpoint,
    database: nonEmpty(config.database) ?? DEFAULT_DATABASE,
    authorization: username === ''
      ? undefined
      : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`,
    signals,
    content: config.content ?? 'none',
    serviceName: nonEmpty(config.serviceName) ?? DEFAULT_SERVICE_NAME,
    logTable: nonEmpty(config.logTable),
    traceTable: nonEmpty(config.traceTable),
    shutdownTimeoutMillis: duration(config.shutdownTimeoutMillis, DEFAULT_SHUTDOWN_TIMEOUT_MILLIS, 'shutdownTimeoutMillis'),
    metricIntervalMillis,
    maxExportBatchSize: count(config.maxExportBatchSize, DEFAULT_MAX_EXPORT_BATCH_SIZE, 'maxExportBatchSize'),
    maxQueueSize: count(config.maxQueueSize, DEFAULT_MAX_QUEUE_SIZE, 'maxQueueSize'),
    scheduledDelayMillis: duration(config.scheduledDelayMillis, DEFAULT_SCHEDULED_DELAY_MILLIS, 'scheduledDelayMillis'),
    exportTimeoutMillis,
  }
}

/**
 * Build the full per-signal OTLP URL.
 * @param endpoint - the resolved base endpoint.
 * @param signal - the signal whose path to append.
 * @returns the absolute endpoint the exporter posts to.
 */
export function signalUrl(endpoint: URL, signal: Signal): string {
  const base = endpoint.href.endsWith('/') ? endpoint.href.slice(0, -1) : endpoint.href
  return `${base}/v1/${signal}`
}

function parseEndpoint(raw: string): URL {
  if (raw === undefined || raw === '') {
    throw new Error('dsh-plugin-greptimedb: endpoint is required (the GreptimeDB OTLP base URL, e.g. http://localhost:4000/v1/otlp)')
  }
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    // The only way to reach this catch is a string URL() cannot parse.
    throw new Error(`dsh-plugin-greptimedb: endpoint is not a valid URL: ${JSON.stringify(raw)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`dsh-plugin-greptimedb: endpoint must be http(s), got ${parsed.protocol}`)
  }
  if (/\/v1\/(traces|metrics|logs)\/?$/.test(parsed.pathname)) {
    throw new Error(`dsh-plugin-greptimedb: endpoint must be the OTLP base URL without a per-signal path, got ${parsed.pathname}`)
  }
  return parsed
}

function nonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value
}

function duration(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0 || value > MAX_TIMER_DELAY_MILLIS) {
    throw new Error(`dsh-plugin-greptimedb: ${field} must be a positive finite number no greater than ${MAX_TIMER_DELAY_MILLIS}, got ${String(value)}`)
  }
  return value
}

function count(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`dsh-plugin-greptimedb: ${field} must be a positive integer, got ${String(value)}`)
  }
  return value
}
