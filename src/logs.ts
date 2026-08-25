/**
 * Session events as OTLP log records.
 *
 * Severity is mapped at emit time so a receiver can alert without knowing
 * anything about DSH.
 *
 * @module logs
 */

import type { Context as OtelContext } from '@opentelemetry/api'
import { SeverityNumber, type AnyValue, type Logger } from '@opentelemetry/api-logs'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentMode } from './config.js'
import { projectEvent } from './projection.js'

/**
 * @param logger - the logger to emit through.
 * @param sessionId - the owning session's id.
 * @param event - the appended session event.
 * @param mode - the deployment's content policy.
 * @param context - the active turn's context, so the record carries the trace
 *   and span ids that link it to the turn it belongs to; omit outside a turn.
 */
export function emitEvent(
  logger: Logger,
  sessionId: string,
  event: SessionEvent,
  mode: ContentMode,
  context?: OtelContext,
): void {
  const projected = projectEvent(sessionId, event, mode)
  if (projected === undefined) return
  const severityNumber = severityOf(event)
  logger.emit({
    timestamp: event.time,
    observedTimestamp: event.time,
    severityNumber,
    severityText: severityNumber === SeverityNumber.ERROR ? 'ERROR' : 'INFO',
    body: projected.body as AnyValue,
    attributes: projected.attributes,
    ...context === undefined ? {} : { context },
  })
}

/**
 * @param event - the session event.
 * @returns `ERROR` when the event's own payload reports failure.
 */
function severityOf(event: SessionEvent): SeverityNumber {
  if (event.type === 'tool/result') {
    return event.data.message.content[0].isError === true ? SeverityNumber.ERROR : SeverityNumber.INFO
  }
  if (event.type === 'turn/end') {
    return event.data.reason.kind === 'error' ? SeverityNumber.ERROR : SeverityNumber.INFO
  }
  return SeverityNumber.INFO
}
