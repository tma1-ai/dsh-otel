/**
 * GreptimeDB-specific OTLP transport wiring: per-signal URLs and headers.
 *
 * GreptimeDB accepts OTLP over HTTP with protobuf encoding only, and reads its
 * routing decisions from request headers rather than from the payload. The
 * trace pipeline header is mandatory, not a tunable: without it GreptimeDB
 * rejects the write.
 *
 * @module otlp
 */

import { signalUrl, type ResolvedConfig, type Signal } from './config.js'

/** The pipeline GreptimeDB requires for OTLP trace ingestion. */
export const TRACE_PIPELINE_NAME = 'greptime_trace_v1'

/**
 * Log attribute keys promoted to real columns via `X-Greptime-Log-Extract-Keys`.
 *
 * These are exactly the keys a session query filters on. They must stay
 * underscore-named and scalar: GreptimeDB rejects array, float, and object
 * values for extraction, and `json_get_*` cannot address a dotted key left in
 * the `log_attributes` JSON column.
 */
export const EXTRACTED_LOG_KEYS = ['session_id', 'event_type', 'turn', 'step'] as const

/**
 * Build the exporter options for one signal.
 * @param config - the resolved plugin configuration.
 * @param signal - the signal being exported.
 * @returns url, headers, and per-request timeout for an OTLP/proto exporter.
 */
export function exporterOptions(
  config: ResolvedConfig,
  signal: Signal,
): { url: string; headers: Record<string, string>; timeoutMillis: number } {
  return {
    url: signalUrl(config.endpoint, signal),
    headers: headersFor(config, signal),
    timeoutMillis: config.exportTimeoutMillis,
  }
}

/**
 * Assemble the GreptimeDB headers for one signal.
 * @param config - the resolved plugin configuration.
 * @param signal - the signal being exported.
 * @returns the complete header set for that signal's requests.
 */
export function headersFor(config: ResolvedConfig, signal: Signal): Record<string, string> {
  const headers: Record<string, string> = { 'X-Greptime-DB-Name': config.database }
  if (config.authorization !== undefined) headers['Authorization'] = config.authorization
  switch (signal) {
    case 'traces':
      headers['X-Greptime-Pipeline-Name'] = TRACE_PIPELINE_NAME
      if (config.traceTable !== undefined) headers['X-Greptime-Trace-Table-Name'] = config.traceTable
      return headers
    case 'logs':
      headers['X-Greptime-Log-Extract-Keys'] = EXTRACTED_LOG_KEYS.join(',')
      if (config.logTable !== undefined) headers['X-Greptime-Log-Table-Name'] = config.logTable
      return headers
    case 'metrics':
      return headers
  }
}
