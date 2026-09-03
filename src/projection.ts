/**
 * The single exit through which session-event payloads leave the process.
 *
 * Every exported field is named here. `SessionEventMap` is merge-extensible, so
 * an event type added later falls to the default branch and exports identity
 * only; a generic clone of `event.data` would export whatever it carries.
 *
 * No branch reads `meta`, and `request/header` is withheld below `full+prompt`.
 *
 * @module projection
 */

// `todo/write` lives in the todo tool's augmentation, not in the session core,
// so its branch below needs this import to reach the declaration.
import type {} from '@deepseek-ai/dsh-tool-todo'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentMode } from './config.js'

/** What GreptimeDB can promote out of `log_attributes` into a column. */
export type AttributeValue = string | number | boolean

/** Attributes are underscore-named: `json_get_*` reads a dotted key as a nested path and cannot address `session.id`. */
export interface ProjectedEvent {
  readonly attributes: Record<string, AttributeValue>
  readonly body: Record<string, unknown>
}

/**
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
 * `attributes` gains only what is worth filtering on in SQL; the rest stays in
 * the body.
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
      // Provider text can quote the prompt; the code identifies the failure.
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
        // Model-authored, and routinely carries paths, commands, and contents.
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
        // `isError` above is the authoritative outcome.
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
      // The largest and most sensitive payload in the log.
      if (mode !== 'full+prompt') return undefined
      return { reason: event.data.reason, header: event.data.header }
    }
    case 'assistant/chunk':
      // Tens of thousands per session, all of it already in the assembled message.
      return undefined
    default:
      // A plugin-declared type reaches here; its payload must not be serialized blind.
      return {}
  }
}

/**
 * @param content - the message content blocks.
 * @returns the distinct `type` discriminants, in first-seen order.
 */
function blockTypes(content: readonly { type: string }[]): string[] {
  return [...new Set(content.map(block => block.type))]
}

/**
 * @param values - the values to tally.
 * @returns a value-to-count map.
 */
function countBy(values: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return counts
}
