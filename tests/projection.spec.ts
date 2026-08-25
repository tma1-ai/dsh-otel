import { beforeEach, describe, expect, it } from 'vitest'
import type { SessionEvent, SessionEventMap } from '@deepseek-ai/dsh-session'
import { projectEvent } from '../src/projection.js'
import { assistantMessage, callId, event, resetSeq, toolResult, userMessage, T0 } from './fixtures.js'

const SESSION_ID = 'sess-1'

/** One marker per channel, so a leak names its own source. */
const SENTINELS = {
  userPrompt: 'SENTINEL_USER_PROMPT',
  assistantText: 'SENTINEL_ASSISTANT_TEXT',
  toolArguments: 'SENTINEL_TOOL_ARGUMENTS',
  toolResult: 'SENTINEL_TOOL_RESULT',
  toolMeta: 'SENTINEL_TOOL_META',
  systemPrompt: 'SENTINEL_SYSTEM_PROMPT',
  toolSchema: 'SENTINEL_TOOL_SCHEMA',
  errorMessage: 'SENTINEL_ERROR_MESSAGE',
  todoText: 'SENTINEL_TODO_TEXT',
} as const

function seeded(): SessionEvent[] {
  return [
    event('turn/start', { turn: 1 }, T0),
    userMessage(SENTINELS.userPrompt, T0 + 1),
    event('request/header', {
      reason: 'initial',
      header: {
        systemPrompt: SENTINELS.systemPrompt,
        tools: [{ name: 'bash', description: SENTINELS.toolSchema }],
      },
    } as unknown as SessionEventMap['request/header'], T0 + 2),
    event('step/start', { turn: 1, step: 1 }, T0 + 3),
    assistantMessage({ turn: 1, step: 1, time: T0 + 4, text: SENTINELS.assistantText, usage: { inputTokens: 10, outputTokens: 5 } }),
    event('tool/call', {
      turn: 1,
      step: 1,
      callId: callId('c1'),
      name: 'bash',
      arguments: JSON.stringify({ command: SENTINELS.toolArguments }),
    }, T0 + 5),
    {
      ...toolResult({ turn: 1, step: 1, callId: callId('c1'), time: T0 + 6, isError: true, text: SENTINELS.toolResult, error: { name: 'ToolError', code: 'E_RUN' } }),
      data: {
        ...(toolResult({ turn: 1, step: 1, callId: callId('c1'), time: T0 + 6, isError: true, text: SENTINELS.toolResult, error: { name: 'ToolError', code: 'E_RUN' } }).data as object),
        meta: { diff: SENTINELS.toolMeta },
      },
    } as SessionEvent,
    event('todo/write', { todos: [{ content: SENTINELS.todoText, status: 'pending' }] } as unknown as SessionEventMap['todo/write'], T0 + 7),
    event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: SENTINELS.assistantText } } as unknown as SessionEventMap['assistant/chunk'], T0 + 8),
    event('turn/end', {
      turn: 1,
      reason: { kind: 'error', error: { message: SENTINELS.errorMessage, code: 'UNKNOWN' } },
    } as unknown as SessionEventMap['turn/end'], T0 + 9),
  ]
}

function projectAll(mode: 'none' | 'full' | 'full+prompt'): string {
  return JSON.stringify(seeded().map(e => projectEvent(SESSION_ID, e, mode)))
}

describe('content: none withholds every payload channel', () => {
  beforeEach(resetSeq)

  it.each(Object.entries(SENTINELS))('does not export %s', (_channel, sentinel) => {
    expect(projectAll('none')).not.toContain(sentinel)
  })

  it('still exports the structure a query needs', () => {
    const projected = projectAll('none')
    expect(projected).toContain('"session_id":"sess-1"')
    expect(projected).toContain('"tool_name":"bash"')
    expect(projected).toContain('"tool_outcome":"error"')
    expect(projected).toContain('"errorCode":"E_RUN"')
    expect(projected).toContain('"inputTokens":10')
  })
})

describe('content: full', () => {
  beforeEach(resetSeq)

  it('exports conversation and tool payloads', () => {
    const projected = projectAll('full')
    expect(projected).toContain(SENTINELS.userPrompt)
    expect(projected).toContain(SENTINELS.assistantText)
    expect(projected).toContain(SENTINELS.toolArguments)
    expect(projected).toContain(SENTINELS.toolResult)
  })

  it('still withholds the system prompt, tool schemas, and tool-private meta', () => {
    const projected = projectAll('full')
    expect(projected).not.toContain(SENTINELS.systemPrompt)
    expect(projected).not.toContain(SENTINELS.toolSchema)
    expect(projected).not.toContain(SENTINELS.toolMeta)
  })

  it('releases the system prompt only at full+prompt', () => {
    const projected = projectAll('full+prompt')
    expect(projected).toContain(SENTINELS.systemPrompt)
    expect(projected).toContain(SENTINELS.toolSchema)
    // No mode exports `meta`.
    expect(projected).not.toContain(SENTINELS.toolMeta)
  })
})

describe('unknown event types', () => {
  beforeEach(resetSeq)

  it('exports identity only, never the payload', () => {
    const unknown = {
      type: 'plugin/secret-thing',
      seq: 42,
      time: T0,
      data: { secret: 'SENTINEL_PLUGIN_PAYLOAD', nested: { deep: 'SENTINEL_DEEP' } },
    } as unknown as SessionEvent

    for (const mode of ['none', 'full', 'full+prompt'] as const) {
      const projected = projectEvent(SESSION_ID, unknown, mode)
      const serialized = JSON.stringify(projected)
      expect(serialized).not.toContain('SENTINEL_PLUGIN_PAYLOAD')
      expect(serialized).not.toContain('SENTINEL_DEEP')
      expect(projected?.attributes['event_type']).toBe('plugin/secret-thing')
      expect(projected?.attributes['event_seq']).toBe(42)
    }
  })
})

describe('dropped events', () => {
  beforeEach(resetSeq)

  it('drops assistant/chunk in every mode', () => {
    const chunk = event('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', text: 'x' } } as unknown as SessionEventMap['assistant/chunk'], T0)
    for (const mode of ['none', 'full', 'full+prompt'] as const) {
      expect(projectEvent(SESSION_ID, chunk, mode)).toBeUndefined()
    }
  })

  it('drops request/header below full+prompt', () => {
    const header = event('request/header', { reason: 'initial', header: {} } as unknown as SessionEventMap['request/header'], T0)
    expect(projectEvent(SESSION_ID, header, 'none')).toBeUndefined()
    expect(projectEvent(SESSION_ID, header, 'full')).toBeUndefined()
    expect(projectEvent(SESSION_ID, header, 'full+prompt')).toBeDefined()
  })
})

describe('extracted attribute keys stay scalar and underscore-named', () => {
  beforeEach(resetSeq)

  it('never emits a dotted key or a non-scalar value', () => {
    for (const e of seeded()) {
      const projected = projectEvent(SESSION_ID, e, 'full+prompt')
      if (projected === undefined) continue
      for (const [key, value] of Object.entries(projected.attributes)) {
        expect(key).not.toContain('.')
        expect(['string', 'number', 'boolean']).toContain(typeof value)
      }
    }
  })
})
