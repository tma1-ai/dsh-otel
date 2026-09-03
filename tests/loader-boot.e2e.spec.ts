/**
 * Boot the packed package through DSH's real `boot()`, drive a real agent loop
 * against a scripted LLM adapter, and assert on the OTLP bytes a collector
 * actually receives.
 *
 * This is the only check that exercises the whole installed path: the Loader
 * resolving a bare package name, `!!js` scalars being evaluated at mount,
 * cordis satisfying `inject: ['sessions']`, and the exporters posting protobuf
 * with GreptimeDB's headers. The events come from the loop rather than from
 * hand-written `session.append` calls, so a payload the loop really produces —
 * tool `meta`, a request header, a structured turn failure — cannot be missed
 * by a fixture that never carried it.
 *
 * Every payload the plugin could leak is planted as a sentinel at its real
 * source, and each content mode asserts the full sentinel set, present and
 * absent. Protobuf string fields are plain UTF-8 on the wire, so the sentinels
 * are searched in the raw body without a decoder.
 *
 * @module tests/loader-boot.e2e
 */

import { execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { ToolCallId, LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-loop'
import type { ContentMode } from '../src/config.js'
import { TARBALL_ENV } from './global-setup.js'

const PACKAGE_NAME = '@tma1-ai/dsh-plugin-greptimedb'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const PROVIDER = 'mock'
const MODEL = 'mock-model'
const TOOL_NAME = 'sentinel_probe'
const TOOL_CALL_ID = ToolCallId('call-sentinel')

/**
 * One marker per payload the plugin can see, planted where the loop really
 * produces it. Distinct strings, so a leak names the source it came from.
 */
const SENTINEL = {
  /** The prompt handed to `agent.followup`. */
  userMessage: 'SENTINEL_USER_MESSAGE',
  /** Text the model streams back. */
  assistantText: 'SENTINEL_ASSISTANT_TEXT',
  /** Model-authored tool-call arguments — routinely paths, commands, file contents. */
  toolArguments: 'SENTINEL_TOOL_ARGUMENTS',
  /** The tool's model-facing result content. */
  toolResult: 'SENTINEL_TOOL_RESULT',
  /** The tool's private presentation payload, which no content mode releases. */
  toolMeta: 'SENTINEL_TOOL_META',
  /** The tool description, sent to the model inside the request header. */
  toolSchema: 'SENTINEL_TOOL_SCHEMA',
  /** A registered system-prompt section, likewise inside the request header. */
  systemPrompt: 'SENTINEL_SYSTEM_PROMPT',
  /** Provider failure text, which can quote the prompt back and is never exported. */
  errorMessage: 'SENTINEL_ERROR_MESSAGE',
  /** The session's working directory — host filesystem layout. */
  cwd: 'SENTINEL_CWD',
} as const

const MODES: readonly ContentMode[] = ['none', 'full', 'full+prompt']

interface Capture {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

/** What one booted, driven, and drained composition produced. */
interface Run {
  readonly captures: readonly Capture[]
  /** The value the loop reported through `agent/error`, whose stack the plugin must not export. */
  readonly reportedError: unknown
}

let collector: Server
/**
 * Where the collector files what it receives. Each run points this at its own
 * array and detaches it before the next run starts, so an export that arrives
 * after the drain window cannot be read as the next content mode's payload.
 */
let sink: Capture[] = []
let installRoot: string
let bareLink: string
const runs = new Map<ContentMode, Run>()

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

async function startCollector(): Promise<number> {
  collector = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      sink.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) })
      // An empty ExportTraceServiceResponse is a success for every signal.
      response.writeHead(200, { 'Content-Type': 'application/x-protobuf' })
      response.end(Buffer.alloc(0))
    })
  })
  await new Promise<void>(resolve => collector.listen(0, '127.0.0.1', resolve))
  const address = collector.address()
  if (address === null || typeof address === 'string') throw new Error('collector did not bind a port')
  return address.port
}

function runFor(mode: ContentMode): Run {
  const result = runs.get(mode)
  if (result === undefined) throw new Error(`no run recorded for content mode ${mode}`)
  return result
}

/** Every byte the collector received for one mode, across all three signals. */
function payload(mode: ContentMode): string {
  return runFor(mode).captures.map(capture => capture.body.toString('utf8')).join('\n')
}

function bodiesFor(mode: ContentMode, signal: string): string {
  return runFor(mode).captures.filter(capture => capture.path.endsWith(`/v1/${signal}`))
    .map(capture => capture.body.toString('utf8')).join('\n')
}

/** One step that answers with text and ends the turn. */
function* textStep(text: string): Generator<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'usage', usage: { inputTokens: 40, outputTokens: 12 } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** One step that requests the probe tool, with the cache accounting the metrics read. */
function* toolCallStep(): Generator<StreamChunk> {
  const args = JSON.stringify({ probe: SENTINEL.toolArguments })
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: TOOL_CALL_ID, name: TOOL_NAME, argumentsDelta: args }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: TOOL_CALL_ID, name: TOOL_NAME, arguments: args } }
  yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 900, cacheWriteTokens: 30 } }
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

/**
 * Two scripted turns: the first calls the tool and completes, the second fails
 * at the provider. Between them the loop emits every span and log the plugin
 * knows how to build.
 */
class ScriptedAdapter extends LlmAdapter {
  private calls = 0

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls += 1
    switch (this.calls) {
      case 1:
        yield* toolCallStep()
        return
      case 2:
        yield* textStep(SENTINEL.assistantText)
        return
      default:
        throw new Error(SENTINEL.errorMessage)
    }
  }
}

const probeTool = defineTool({
  name: TOOL_NAME,
  description: `Echo the probe value back. ${SENTINEL.toolSchema}`,
  parameters: {
    probe: { type: 'string', required: true, description: 'Opaque probe value.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { echoed: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.echoed }],
    presentationMeta: () => ({ probe: SENTINEL.toolMeta }),
  },
  execute: () => Promise.resolve({ echoed: SENTINEL.toolResult }),
})

function configFor(mode: ContentMode): string {
  return [
    '- id: llm',
    "  name: '@deepseek-ai/dsh-llm'",
    '',
    '- id: session',
    "  name: '@deepseek-ai/dsh-session'",
    '',
    // The loop injects `sessionProjections`; without this entry nothing mounts.
    '- id: session-projection',
    "  name: '@deepseek-ai/dsh-session-projection'",
    '',
    '- id: system-prompt',
    "  name: '@deepseek-ai/dsh-system-prompt'",
    '',
    '- id: tools',
    "  name: '@deepseek-ai/dsh-tools'",
    '',
    '- id: agents',
    "  name: '@deepseek-ai/dsh-agent'",
    '',
    '- id: agent-loop',
    "  name: '@deepseek-ai/dsh-agent-loop'",
    '  config:',
    '    agents: []',
    '',
    '- id: greptimedb-otel',
    `  name: '${PACKAGE_NAME}'`,
    '  config:',
    // The endpoint arrives as a `!!js` scalar, so a successful export also
    // proves the Loader evaluated the expression at mount.
    '    endpoint: !!js process.env.E2E_OTLP_ENDPOINT',
    '    database: e2e',
    '    logTable: dsh_logs_boot',
    `    content: '${mode}'`,
    '    scheduledDelayMillis: 100',
    '    exportTimeoutMillis: 2000',
    '    metricIntervalMillis: 2000',
    '',
  ].join('\n')
}

/** Boot one composition, drive both turns through the loop, and drain the exporters. */
async function bootAndDrive(mode: ContentMode): Promise<Run> {
  const captures: Capture[] = []
  sink = captures
  const workspace = mkdtempSync(join(tmpdir(), 'dsh-otel-boot-'))
  const cwd = join(workspace, SENTINEL.cwd)
  mkdirSync(cwd)
  writeFileSync(join(workspace, 'cordis.yml'), configFor(mode))

  const ctx = await boot('dsh-otel-e2e', join(workspace, 'cordis.yml'))
  let reportedError: unknown
  try {
    ctx.llm.registerAdapter([PROVIDER], new ScriptedAdapter())
    ctx.tools.register(probeTool)
    ctx.systemPrompt.section({ name: 'sentinel', order: 0, text: SENTINEL.systemPrompt })
    ctx.on('agent/error', ({ error }) => { reportedError = error })

    const agent = ctx.agentLoop.create(SessionId('sentinel-session'), { provider: PROVIDER, model: MODEL }, { cwd })
    // Turn one calls the tool and completes; turn two fails at the provider.
    for (let turn = 0; turn < 2; turn += 1) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: SENTINEL.userMessage }],
        source: { kind: 'user' },
      }))
      await agent.whenIdle()
    }
  } finally {
    // Disposal is what forces the batch processors to drain.
    await ctx.fiber.dispose()
    rmSync(workspace, { recursive: true, force: true })
  }
  await new Promise(resolve => setTimeout(resolve, 500))
  sink = []
  return { captures, reportedError }
}

describe('boot through the real DSH Loader', () => {
  beforeAll(async () => {
    const tarball = process.env[TARBALL_ENV]
    if (tarball === undefined) throw new Error(`${TARBALL_ENV} is unset; the global setup must run first`)

    // The Loader imports a bare specifier from its own location, so a plugin
    // must be reachable by Node's parent walk from there. A real install gets
    // that from `healProfilesModuleFallback`, which maintains a flat symlink
    // directory; unpacking under this project's node_modules and linking the
    // bare name reproduces the same resolution without a full dsh install.
    installRoot = join(root, 'node_modules', '.e2e-install')
    rmSync(installRoot, { recursive: true, force: true })
    mkdirSync(installRoot, { recursive: true })
    run('tar', ['xzf', tarball, '-C', installRoot], root)
    bareLink = join(root, 'node_modules', PACKAGE_NAME)
    rmSync(bareLink, { recursive: true, force: true })
    // A scoped name needs its scope directory to exist before the link.
    mkdirSync(dirname(bareLink), { recursive: true })
    symlinkSync(join(installRoot, 'package'), bareLink, 'dir')

    const port = await startCollector()
    process.env['E2E_OTLP_ENDPOINT'] = `http://127.0.0.1:${String(port)}/v1/otlp`

    // Sequential: the runs share one collector, and each reads the captures it
    // alone produced.
    for (const mode of MODES) runs.set(mode, await bootAndDrive(mode))
  }, 300_000)

  afterAll(async () => {
    await new Promise<void>(resolve => collector.close(() => resolve()))
    rmSync(bareLink, { recursive: true, force: true })
    rmSync(installRoot, { recursive: true, force: true })
    delete process.env['E2E_OTLP_ENDPOINT']
  })

  it('mounts through the Loader and exports to the evaluated endpoint', () => {
    // A bare package name resolved, `inject: ['sessions']` was satisfied, and
    // the `!!js` endpoint was evaluated — otherwise nothing would arrive.
    expect(runFor('none').captures.length).toBeGreaterThan(0)
    expect(new Set(runFor('none').captures.map(capture => capture.path))).toEqual(
      new Set(['/v1/otlp/v1/traces', '/v1/otlp/v1/metrics', '/v1/otlp/v1/logs']),
    )
  })

  it('sends GreptimeDB routing headers per signal', () => {
    const traces = runFor('none').captures.find(capture => capture.path.endsWith('/v1/traces'))
    expect(traces?.headers['x-greptime-pipeline-name']).toBe('greptime_trace_v1')
    expect(traces?.headers['x-greptime-db-name']).toBe('e2e')
    expect(traces?.headers['content-type']).toBe('application/x-protobuf')

    const logs = runFor('none').captures.find(capture => capture.path.endsWith('/v1/logs'))
    expect(logs?.headers['x-greptime-log-extract-keys']).toBe('session_id,event_type,turn,step')
    expect(logs?.headers['x-greptime-log-table-name']).toBe('dsh_logs_boot')
  })

  it('carries the span tree the loop produced, including the failed model call', () => {
    const traces = bodiesFor('none', 'traces')
    expect(traces).toContain('invoke_agent dsh')
    expect(traces).toContain(`chat ${MODEL}`)
    expect(traces).toContain(`execute_tool ${TOOL_NAME}`)
    expect(traces).toContain('gen_ai.usage.input_tokens')
    expect(traces).toContain('dsh.usage.cache_read_tokens')
    // The second turn's chat span has no `assistant/message`; only the
    // `agent/error` path can have closed it, and only with a stable type.
    expect(traces).toContain('error.type')
    expect(traces).toContain('LlmError')
    expect(traces).toContain('dsh.turn.end_reason')
  })

  it('records the loop as a real event stream, not a single turn', () => {
    const logs = bodiesFor('none', 'logs')
    expect(logs).toContain('turn/start')
    expect(logs).toContain('tool/call')
    expect(logs).toContain('tool/result')
    expect(logs).toContain('turn/end')
  })

  describe.each(MODES)('at content: %s', (mode) => {
    /** Payloads that only `full` and `full+prompt` release. */
    const conversation = [
      SENTINEL.userMessage,
      SENTINEL.assistantText,
      SENTINEL.toolArguments,
      SENTINEL.toolResult,
    ]
    /** Payloads only `full+prompt` releases. */
    const requestHeader = [SENTINEL.systemPrompt, SENTINEL.toolSchema]

    it(`${mode === 'none' ? 'withholds' : 'releases'} conversation content`, () => {
      for (const sentinel of conversation) {
        if (mode === 'none') expect(payload(mode)).not.toContain(sentinel)
        else expect(payload(mode)).toContain(sentinel)
      }
    })

    it(`${mode === 'full+prompt' ? 'releases' : 'withholds'} the system prompt and tool schemas`, () => {
      for (const sentinel of requestHeader) {
        if (mode === 'full+prompt') expect(payload(mode)).toContain(sentinel)
        else expect(payload(mode)).not.toContain(sentinel)
      }
      // Below `full+prompt` the whole record is dropped, not emptied — the loop
      // appended it either way.
      expect(bodiesFor(mode, 'logs').includes('request/header')).toBe(mode === 'full+prompt')
    })

    it('never exports tool meta, the working directory, or the failure text', () => {
      // No content mode releases these: `meta` is tool-private, `cwd` is host
      // filesystem layout, and provider failure text can quote the prompt back.
      expect(payload(mode)).not.toContain(SENTINEL.toolMeta)
      expect(payload(mode)).not.toContain(SENTINEL.cwd)
      expect(payload(mode)).not.toContain(SENTINEL.errorMessage)
    })

    it('never exports a stack frame or an exception span event', () => {
      // The absences below are only meaningful because the plugin really did
      // receive this Error: `stack` starts with `name: message`, so a leaked
      // stack puts the failure text on the wire first and this frame second.
      const reported = runFor(mode).reportedError
      expect(reported).toBeInstanceOf(Error)
      const stack = (reported as Error).stack ?? ''
      expect(stack).toContain(SENTINEL.errorMessage)
      const frame = stack.split('\n')[1]?.trim() ?? ''
      expect(frame).toMatch(/^at /)

      // `recordException` would write these keys with the message and stack
      // attached, bypassing the projection allowlist in every content mode.
      expect(payload(mode)).not.toContain('exception.message')
      expect(payload(mode)).not.toContain('exception.stacktrace')
      expect(payload(mode)).not.toContain('exception.type')
      expect(payload(mode)).not.toContain(frame)
    })

    it('exports the structural record either way', () => {
      const logs = bodiesFor(mode, 'logs')
      expect(logs).toContain('event_type')
      expect(logs).toContain('tool_name')
      // The failure is identified by its code, never by its message.
      expect(logs).toContain('errorCode')
    })
  })
})
