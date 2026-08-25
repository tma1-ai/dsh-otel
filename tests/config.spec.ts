import { describe, expect, it } from 'vitest'
import { resolveConfig, signalUrl, DEFAULT_DATABASE, DEFAULT_TTL } from '../src/config.js'
import { EXTRACTED_LOG_KEYS, TRACE_PIPELINE_NAME, headersFor } from '../src/otlp.js'

const BASE = 'http://localhost:4000/v1/otlp'

describe('resolveConfig', () => {
  it('defaults every optional field', () => {
    const resolved = resolveConfig({ endpoint: BASE })
    expect(resolved.database).toBe(DEFAULT_DATABASE)
    expect(resolved.content).toBe('none')
    expect(resolved.authorization).toBeUndefined()
    expect(resolved.ttl).toBe(DEFAULT_TTL)
    expect([...resolved.signals].sort()).toEqual(['logs', 'metrics', 'traces'])
  })

  it.each([
    ['a missing endpoint', {}, /endpoint is required/],
    ['a non-URL endpoint', { endpoint: 'not a url' }, /not a valid URL/],
    ['a non-http scheme', { endpoint: 'grpc://localhost:4001' }, /must be http/],
    ['a per-signal path', { endpoint: `${BASE}/v1/traces` }, /without a per-signal path/],
    ['an empty signal list', { endpoint: BASE, signals: [] }, /at least one of/],
    ['a lone username', { endpoint: BASE, username: 'u' }, /must be set together/],
    ['a zero timeout', { endpoint: BASE, shutdownTimeoutMillis: 0 }, /shutdownTimeoutMillis must be/],
    ['a fractional batch size', { endpoint: BASE, maxExportBatchSize: 1.5 }, /maxExportBatchSize must be/],
    // The metric reader rejects this pairing in its own constructor; catching
    // it here names both fields instead of surfacing an SDK message at mount.
    ['a metric interval below the export timeout', { endpoint: BASE, metricIntervalMillis: 1_000, exportTimeoutMillis: 5_000 }, /must be at least exportTimeoutMillis/],
    // A comma would close the ttl pair and open another hint.
    ['a ttl that carries a second hint', { endpoint: BASE, ttl: '180d,append_mode=false' }, /ttl must be a duration/],
  ])('rejects %s', (_label, config, message) => {
    // The cast models a cordis.yml author writing an invalid value; the schema
    // catches types, this step catches ranges and formats.
    expect(() => resolveConfig(config as Parameters<typeof resolveConfig>[0])).toThrow(message)
  })

  it('encodes basic auth once', () => {
    const resolved = resolveConfig({ endpoint: BASE, username: 'user', password: 'pass' })
    expect(resolved.authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`)
  })
})

describe('signalUrl', () => {
  it.each([
    [BASE, 'traces', 'http://localhost:4000/v1/otlp/v1/traces'],
    [`${BASE}/`, 'metrics', 'http://localhost:4000/v1/otlp/v1/metrics'],
    ['https://db.example.com/v1/otlp', 'logs', 'https://db.example.com/v1/otlp/v1/logs'],
    // A query string routes tenants in some deployments; appending to href
    // would push the signal path after it.
    ['https://db.example.com/v1/otlp?tenant=acme', 'traces', 'https://db.example.com/v1/otlp/v1/traces?tenant=acme'],
    ['https://db.example.com/otlp/?db=x', 'logs', 'https://db.example.com/otlp/v1/logs?db=x'],
  ] as const)('appends the %s path for %s', (endpoint, signal, expected) => {
    expect(signalUrl(resolveConfig({ endpoint }).endpoint, signal)).toBe(expected)
  })
})

describe('headersFor', () => {
  it('always sends the trace pipeline header, which GreptimeDB requires', () => {
    const headers = headersFor(resolveConfig({ endpoint: BASE }), 'traces')
    expect(headers['X-Greptime-Pipeline-Name']).toBe(TRACE_PIPELINE_NAME)
  })

  it('promotes the queryable log keys to columns', () => {
    const headers = headersFor(resolveConfig({ endpoint: BASE }), 'logs')
    expect(headers['X-Greptime-Log-Extract-Keys']).toBe(EXTRACTED_LOG_KEYS.join(','))
  })

  it('omits authorization when no credentials are configured', () => {
    const headers = headersFor(resolveConfig({ endpoint: BASE }), 'metrics')
    expect(headers['Authorization']).toBeUndefined()
    expect(headers['X-Greptime-DB-Name']).toBe(DEFAULT_DATABASE)
  })

  it('hints the retention of every signal it may auto-create', () => {
    const resolved = resolveConfig({ endpoint: BASE })
    for (const signal of ['traces', 'metrics', 'logs'] as const) {
      expect(headersFor(resolved, signal)['X-Greptime-Hints']).toBe(`ttl=${DEFAULT_TTL}`)
    }
    const inherited = resolveConfig({ endpoint: BASE, ttl: '' })
    expect(headersFor(inherited, 'traces')['X-Greptime-Hints']).toBeUndefined()
  })

  it('sends table overrides only when configured', () => {
    const withTables = resolveConfig({ endpoint: BASE, logTable: 'dsh_logs', traceTable: 'dsh_traces' })
    expect(headersFor(withTables, 'logs')['X-Greptime-Log-Table-Name']).toBe('dsh_logs')
    expect(headersFor(withTables, 'traces')['X-Greptime-Trace-Table-Name']).toBe('dsh_traces')
    const without = resolveConfig({ endpoint: BASE })
    expect(headersFor(without, 'logs')['X-Greptime-Log-Table-Name']).toBeUndefined()
    expect(headersFor(without, 'traces')['X-Greptime-Trace-Table-Name']).toBeUndefined()
  })
})
