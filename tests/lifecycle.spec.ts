import { describe, expect, it } from 'vitest'
import { createPipeline } from '../src/lifecycle.js'
import { resolveConfig } from '../src/config.js'
import { emitEvent } from '../src/logs.js'
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

    // Without the reporting wrapper the batch processor hands the failure to
    // the global diag and the caller sees a clean shutdown, so the data is gone
    // with nothing to indicate it.
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
