/**
 * Synthetic session events for recorder and projection tests.
 *
 * The builders mirror the shapes DSH actually appends — notably that
 * `tool/result` carries its call id inside `message.source` and its outcome
 * inside the single result block — so a test cannot pass against a shape the
 * loop never produces.
 *
 * @module tests/fixtures
 */

import type { SessionEvent, SessionEventMap, SessionEventType } from '@deepseek-ai/dsh-session'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'

/** Wall time the first synthetic event carries; later events offset from it. */
export const T0 = 1_800_000_000_000

let seq = 0

/** Reset the shared sequence counter so each test reads seq numbers from zero. */
export function resetSeq(): void {
  seq = 0
}

/**
 * Build one session event.
 * @param type - the event type.
 * @param data - the event payload.
 * @param time - the append time in epoch milliseconds.
 * @returns the event, with the next sequence number.
 */
export function event<T extends SessionEventType>(type: T, data: SessionEventMap[T], time: number): SessionEvent {
  return { type, seq: seq++, time, data } as SessionEvent
}

/**
 * Build an `assistant/message` event.
 * @param options - turn, step, time, optional usage, interruption marker, and requested tool calls.
 * @returns the event.
 */
export function assistantMessage(options: {
  turn: number
  step: number
  time: number
  usage?: TokenUsage
  interrupted?: true
  toolCalls?: { id: string; name: string }[]
  text?: string
}): SessionEvent {
  const content = [
    ...options.text === undefined ? [] : [{ type: 'text' as const, text: options.text }],
    ...(options.toolCalls ?? []).map(call => ({
      type: 'tool-call' as const,
      id: call.id,
      name: call.name,
      arguments: '{}',
    })),
  ]
  return event('assistant/message', {
    turn: options.turn,
    step: options.step,
    message: {
      id: `msg-${String(options.step)}`,
      role: 'assistant',
      content,
      source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
    },
    ...options.usage === undefined ? {} : { usage: options.usage },
    ...options.interrupted === undefined ? {} : { interrupted: options.interrupted },
  } as SessionEventMap['assistant/message'], options.time)
}

/**
 * Build a `tool/result` event.
 * @param options - turn, step, call id, time, failure flag, optional internal error identity, and result text.
 * @returns the event.
 */
export function toolResult(options: {
  turn: number
  step: number
  callId: string
  time: number
  isError?: boolean
  error?: { name: string; code: string }
  text?: string
}): SessionEvent {
  return event('tool/result', {
    turn: options.turn,
    step: options.step,
    message: {
      id: `res-${options.callId}`,
      role: 'user',
      content: [{
        type: 'tool-result',
        toolCallId: options.callId,
        content: options.text === undefined ? [] : [{ type: 'text', text: options.text }],
        ...options.isError === undefined ? {} : { isError: options.isError },
      }],
      source: { kind: 'tool', callId: options.callId },
    },
    ...options.error === undefined ? {} : { error: options.error },
  } as SessionEventMap['tool/result'], options.time)
}

/**
 * Build a `user/message` event.
 * @param text - the prompt text.
 * @param time - the append time.
 * @returns the event.
 */
export function userMessage(text: string, time: number): SessionEvent {
  return event('user/message', {
    id: 'user-1',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  } as SessionEventMap['user/message'], time)
}
