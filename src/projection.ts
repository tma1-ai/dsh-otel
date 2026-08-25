/**
 * The single exit through which session-event payloads leave the process.
 *
 * Every field exported by this plugin is named here explicitly. `SessionEventMap`
 * is merge-extensible: a plugin that adds an event type gets it exported through
 * the default branch, which emits identity only. That default-deny is the whole
 * point — a generic clone or `JSON.stringify` of `event.data` would silently
 * start exporting whatever a future event type happens to carry.
 *
 * No branch here reads `meta` (tool-private, opaque, arbitrary), and
 * `request/header` (the complete system prompt and every tool schema) is
 * withheld below the `full+prompt` mode.
 *
 * @module projection
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentMode } from './config.js'

/** Attribute value types GreptimeDB can promote out of `log_attributes` into a column. */
export type AttributeValue = string | number | boolean

/**
 * One projected event ready to become a log record.
 *
 * `attributes` uses underscore names throughout: GreptimeDB reads
 * `log_attributes` with `json_get_*`, which treats a dotted key as a nested
 * path and cannot address `session.id`.
 */
export interface ProjectedEvent {
  readonly attributes: Record<string, AttributeValue>
  readonly body: Record<string, unknown>
}

/**
 * Project one session event onto its exportable form.
 *
 * @param sessionId - the owning session's id.
 * @param event - the session event to project.
 * @param mode - how much payload the deployment allows out.
 * @returns the projection, or `undefined` for events this plugin never exports.
 */
export function projectEvent(sessionId: string, event: SessionEvent, mode: ContentMode): ProjectedEvent | undefined {
  const attributes: Record<string, AttributeValue> = {
    session_id: sessionId,
    event_type: event.type,
    event_seq: event.seq,
  }
  const body = projectBody(event, mode, attributes)
  if (body === undefined) return undefined
  return { attributes, body }
}

/**
 * Build the body and enrich the attributes for one event type.
 *
 * Each branch names the fields it exports. `attributes` gains only values worth
 * filtering on in SQL; everything else stays in the body.
 *
 * @param event - the event to project.
 * @param mode - the deployment's content policy.
 * @param attributes - identity attributes, extended in place by branches that have a turn, step, or tool to name.
 * @returns the log body, or `undefined` to drop the event.
 */
function projectBody(
  event: SessionEvent,
  mode: ContentMode,
  attributes: Record<string, AttributeValue>,
): Record<string, unknown> | undefined {
  switch (event.type) {
    case 'turn/start': {
      attributes['turn'] = event.data.turn
      return { turn: event.data.turn }
    }
    case 'turn/end': {
      attributes['turn'] = event.data.turn
      const reason = event.data.reason
      attributes['turn_end_reason'] = reason.kind
      // `error.message` is provider text that can quote the prompt; only the
      // stable code identifies the failure.
      return {
        turn: event.data.turn,
        reason: reason.kind,
        ...reason.kind === 'error' ? { errorCode: reason.error.code } : {},
      }
    }
    case 'step/start':
    case 'step/end': {
      attributes['turn'] = event.data.turn
      attributes['step'] = event.data.step
      return { turn: event.data.turn, step: event.data.step }
    }
    case 'request/context': {
      return {
        provider: event.data.provider,
        model: event.data.model,
        ...event.data.contextWindow === undefined ? {} : { contextWindow: event.data.contextWindow },
      }
    }
    case 'user/message': {
      const content = mode === 'none'
        ? {}
        : { content: event.data.content }
      return {
        role: 'user',
        source: event.data.source.kind,
        ...event.data.source.kind === 'plugin' ? { plugin: event.data.source.plugin } : {},
        blockTypes: blockTypes(event.data.content),
        ...content,
      }
    }
    case 'assistant/message': {
      attributes['turn'] = event.data.turn
      attributes['step'] = event.data.step
      const usage = event.data.usage
      return {
        turn: event.data.turn,
        step: event.data.step,
        blockTypes: blockTypes(event.data.message.content),
        toolCalls: event.data.message.content.filter(block => block.type === 'tool-call').length,
        ...event.data.interrupted === true ? { interrupted: true } : {},
        ...usage === undefined ? {} : {
          usage: {
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            ...usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
            ...usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
            ...usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens },
          },
        },
        ...mode === 'none' ? {} : { content: event.data.message.content },
      }
    }
    case 'tool/call': {
      attributes['turn'] = event.data.turn
      attributes['step'] = event.data.step
      attributes['tool_name'] = event.data.name
      attributes['call_id'] = event.data.callId
      return {
        turn: event.data.turn,
        step: event.data.step,
        callId: event.data.callId,
        name: event.data.name,
        // The raw argument JSON is model-authored and routinely carries file
        // paths, shell commands, and file contents.
        argumentsLength: event.data.arguments.length,
        ...mode === 'none' ? {} : { arguments: event.data.arguments },
      }
    }
    case 'tool/result': {
      const callId = event.data.message.source.callId
      const isError = event.data.message.content[0].isError === true
      attributes['turn'] = event.data.turn
      attributes['step'] = event.data.step
      attributes['call_id'] = callId
      attributes['tool_outcome'] = isError ? 'error' : 'ok'
      return {
        turn: event.data.turn,
        step: event.data.step,
        callId,
        isError,
        // `error` is the tool's optional internal failure identity; `isError`
        // above is the authoritative outcome.
        ...event.data.error === undefined ? {} : { errorName: event.data.error.name, errorCode: event.data.error.code },
        ...mode === 'none' ? {} : { content: event.data.message.content },
      }
    }
    case 'todo/write': {
      const todos = event.data.todos
      return {
        count: todos.length,
        statuses: countBy(todos.map(todo => todo.status)),
        ...mode === 'none' ? {} : { todos },
      }
    }
    case 'request/header': {
      // The header carries the complete system prompt and every tool schema —
      // the largest and most sensitive payload in the log.
      if (mode !== 'full+prompt') return undefined
      return { reason: event.data.reason, header: event.data.header }
    }
    case 'assistant/chunk':
      // Token-level deltas: tens of thousands per session, and every fact they
      // carry is already in the assembled `assistant/message`.
      return undefined
    default:
      // Merge-extensible: a plugin-declared event type reaches here. Identity
      // only — its payload is unknown to this projection and must not be
      // serialized blind.
      return {}
  }
}

/**
 * List the distinct block types in a message's content, in first-seen order.
 * @param content - the message content blocks.
 * @returns the distinct `type` discriminants.
 */
function blockTypes(content: readonly { type: string }[]): string[] {
  return [...new Set(content.map(block => block.type))]
}

/**
 * Count occurrences of each value.
 * @param values - the values to tally.
 * @returns a value-to-count map.
 */
function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}
