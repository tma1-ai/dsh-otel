/**
 * Boot the packed package through DSH's real `boot()` and assert on the OTLP
 * bytes a collector actually receives.
 *
 * This is the only check that exercises the whole installed path: the Loader
 * resolving a bare package name, `!!js` scalars being evaluated at mount,
 * cordis satisfying `inject: ['sessions']`, a real `SessionStore` appending
 * real events, and the exporters posting protobuf with GreptimeDB's headers.
 *
 * Protobuf string fields are plain UTF-8 on the wire, so span names and
 * redaction sentinels are checked against the raw body without a decoder.
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
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { TARBALL_ENV } from './global-setup.js'

const PACKAGE_NAME = '@tma1-ai/dsh-plugin-greptimedb'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROMPT_SENTINEL = 'SENTINEL_BOOT_PROMPT'
const TOOL_ARG_SENTINEL = 'SENTINEL_BOOT_TOOL_ARGUMENTS'

interface Capture {
  path: string
  headers: Record<string, string | string[] | undefined>
  body: Buffer
}

let collector: Server
let captures: Capture[] = []
let workspace: string
let installRoot: string
let bareLink: string
let ctx: Context | undefined

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

async function startCollector(): Promise<number> {
  collector = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      captures.push({ path: request.url ?? '', headers: request.headers, body: Buffer.concat(chunks) })
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

function bodiesFor(signal: string): string {
  return captures.filter(capture => capture.path.endsWith(`/v1/${signal}`))
    .map(capture => capture.body.toString('utf8')).join('\n')
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
    workspace = mkdtempSync(join(tmpdir(), 'dsh-otel-boot-'))

    // The endpoint arrives as a `!!js` scalar, so a successful export also
    // proves the Loader evaluated the expression at mount.
    process.env['E2E_OTLP_ENDPOINT'] = `http://127.0.0.1:${String(port)}/v1/otlp`
    writeFileSync(join(workspace, 'cordis.yml'), [
      '- id: session',
      "  name: '@deepseek-ai/dsh-session'",
      '',
      '- id: greptimedb-otel',
      `  name: '${PACKAGE_NAME}'`,
      '  config:',
      '    endpoint: !!js process.env.E2E_OTLP_ENDPOINT',
      '    database: e2e',
      '    logTable: dsh_logs_boot',
      '    content: none',
      '    scheduledDelayMillis: 100',
      '    exportTimeoutMillis: 2000',
      '    metricIntervalMillis: 2000',
      '',
    ].join('\n'))

    ctx = await boot('dsh-otel-e2e', join(workspace, 'cordis.yml'))

    const session: Session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('user/message', {
      id: 'u1',
      role: 'user',
      content: [{ type: 'text', text: PROMPT_SENTINEL }],
      source: { kind: 'user' },
      // The store validates the payload; the cast models what the loop appends.
    } as Parameters<typeof session.append>[1] as never, { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/context', { provider: 'deepseek', model: 'deepseek-chat' })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'a1',
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: `{"command":"${TOOL_ARG_SENTINEL}"}` }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 20 },
    } as never, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: `{"command":"${TOOL_ARG_SENTINEL}"}` } as never)
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: {
        id: 'r1',
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], isError: false }],
        source: { kind: 'tool', callId: 'c1' },
      },
    } as never, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })

    // Disposal is what forces the batch processors to drain.
    await ctx.fiber.dispose()
    ctx = undefined
    await new Promise(resolve => setTimeout(resolve, 500))
  }, 300_000)

  afterAll(async () => {
    if (ctx !== undefined) await ctx.fiber.dispose()
    await new Promise<void>(resolve => collector.close(() => resolve()))
    rmSync(workspace, { recursive: true, force: true })
    rmSync(bareLink, { recursive: true, force: true })
    rmSync(installRoot, { recursive: true, force: true })
    delete process.env['E2E_OTLP_ENDPOINT']
    captures = []
  })

  it('mounts through the Loader and exports to the evaluated endpoint', () => {
    // A bare package name resolved, `inject: ['sessions']` was satisfied, and
    // the `!!js` endpoint was evaluated — otherwise nothing would arrive.
    expect(captures.length).toBeGreaterThan(0)
    expect(new Set(captures.map(capture => capture.path))).toEqual(
      new Set(['/v1/otlp/v1/traces', '/v1/otlp/v1/metrics', '/v1/otlp/v1/logs']),
    )
  })

  it('sends GreptimeDB routing headers per signal', () => {
    const traces = captures.find(capture => capture.path.endsWith('/v1/traces'))
    expect(traces?.headers['x-greptime-pipeline-name']).toBe('greptime_trace_v1')
    expect(traces?.headers['x-greptime-db-name']).toBe('e2e')
    expect(traces?.headers['content-type']).toBe('application/x-protobuf')

    const logs = captures.find(capture => capture.path.endsWith('/v1/logs'))
    expect(logs?.headers['x-greptime-log-extract-keys']).toBe('session_id,event_type,turn,step')
    expect(logs?.headers['x-greptime-log-table-name']).toBe('dsh_logs_boot')
  })

  it('carries the reconstructed span tree on the wire', () => {
    const traces = bodiesFor('traces')
    expect(traces).toContain('invoke_agent dsh')
    expect(traces).toContain('chat deepseek-chat')
    expect(traces).toContain('execute_tool bash')
    expect(traces).toContain('gen_ai.usage.input_tokens')
  })

  it('withholds payloads at content: none across every signal', () => {
    const everything = captures.map(capture => capture.body.toString('utf8')).join('\n')
    expect(everything).not.toContain(PROMPT_SENTINEL)
    expect(everything).not.toContain(TOOL_ARG_SENTINEL)
    // Structure still travels.
    expect(bodiesFor('logs')).toContain('event_type')
  })
})
