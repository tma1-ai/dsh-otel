/**
 * Per-signal URLs and headers.
 *
 * GreptimeDB routes on request headers rather than payload, and rejects trace
 * writes that omit the pipeline header, so it is mandatory rather than a knob.
 *
 * @module otlp
 */

import { signalUrl, type ResolvedConfig, type Signal } from './config.js'

/** Required by GreptimeDB for OTLP trace ingestion. */
export const TRACE_PIPELINE_NAME = 'greptime_trace_v1'

/**
 * Promoted to real columns. They must stay underscore-named and scalar:
 * extraction rejects non-scalars, and `json_get_*` cannot address a dotted key
 * left behind in the JSON column.
 */
export const EXTRACTED_LOG_KEYS = ['session_id', 'event_type', 'turn', 'step'] as const

/**
 * @param config - the resolved plugin configuration.
 * @param signal - the signal being exported.
 * @returns url, headers, and timeout for an OTLP/proto exporter.
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
