import { describe, expect, it } from 'vitest'
import { createPipeline, shutdownAll } from '../src/lifecycle.js'
import { resolveConfig } from '../src/config.js'
import { emitEvent } from '../src/logs.js'
import { SessionRecorder } from '../src/recorder.js'
import { event, resetSeq, T0 } from './fixtures.js'

/** A port nothing listens on, so every export is refused immediately. */
const DEAD_ENDPOINT = 'http://127.0.0.1:1/v1/otlp'

describe('export failures are reported', () => {
  it('surfaces a refused export instead of dropping it silently', async () => {
    resetSeq()
    const failures: { stage: string; error: unknown }[] = []
    const pipeline = createPipeline(
      resolveConfig({
        endpoint: DEAD_ENDPOINT,
        signals: ['logs'],
        scheduledDelayMillis: 50,
        exportTimeoutMillis: 1_000,
        metricIntervalMillis: 1_000,
        shutdownTimeoutMillis: 5_000,
      }),
      '0.0.0-test',
      (stage, error) => failures.push({ stage, error }),
    )
    if (pipeline.logger === undefined) throw new Error('logs must be enabled')

    emitEvent(pipeline.logger, 'sess-1', event('turn/start', { turn: 1 }, T0), 'none')
    await pipeline.shutdown()

    // Without the wrapper this looks like a clean shutdown with the data gone.
    const exportFailures = failures.filter(failure => failure.stage === 'export')
    expect(exportFailures.length).toBeGreaterThan(0)
  }, 30_000)

  it('reports nothing when there is nothing to export', async () => {
    const failures: { stage: string; error: unknown }[] = []
    const pipeline = createPipeline(
      resolveConfig({ endpoint: DEAD_ENDPOINT, signals: ['logs'], shutdownTimeoutMillis: 5_000 }),
      '0.0.0-test',
      (stage, error) => failures.push({ stage, error }),
    )
    await pipeline.shutdown()
    expect(failures).toEqual([])
  }, 30_000)
})

describe('signals are independently selectable', () => {
  it('records spans when only traces are enabled', async () => {
    resetSeq()
    const failures: string[] = []
    const pipeline = createPipeline(
      resolveConfig({ endpoint: DEAD_ENDPOINT, signals: ['traces'], scheduledDelayMillis: 50, exportTimeoutMillis: 1_000, shutdownTimeoutMillis: 5_000 }),
      '0.0.0-test',
      stage => failures.push(stage),
    )
    const recorder = new SessionRecorder('sess-1', pipeline.tracer, pipeline.instruments, T0)
    recorder.handle(event('turn/start', { turn: 1 }, T0))
    recorder.handle(event('turn/end', { turn: 1, reason: { kind: 'completed' } }, T0 + 100))
    await pipeline.shutdown()

    // A refused export proves a span reached the exporter; a no-op tracer
    // would have had nothing to send.
    expect(failures).toContain('export')
  }, 30_000)
})

describe('shutdown reaches every provider', () => {
  it('starts all shutdowns even when the first never resolves', async () => {
    // Sequential awaits let a hung first provider keep the rest from starting.
    const started: string[] = []
    const shutdowns = [
      () => { started.push('first'); return new Promise<void>(() => {}) },
      () => { started.push('second'); return Promise.resolve() },
      () => { started.push('third'); return Promise.resolve() },
    ]
    const failures: string[] = []
    await shutdownAll(shutdowns, 300, stage => failures.push(stage))

    expect(started).toEqual(['first', 'second', 'third'])
    expect(failures).toEqual(['shutdown'])
  }, 30_000)
})
