/**
 * A DeepSeek Harness plugin that exports the agent loop to GreptimeDB as
 * OpenTelemetry traces, metrics, and logs.
 *
 * Everything is derived from the session event stream, so the plugin adds no
 * extension point to the loop and mounts on any composition that has sessions.
 * Every listener is synchronous and self-contained: it updates local state,
 * hands records to the SDK's queue, and contains its own failures, because
 * cordis dispatches these listeners on the loop's own path and a throw would
 * reach the agent.
 *
 * @module dsh-plugin-greptimedb
 */

import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent'
import { Config, resolveConfig, signalUrl } from './config.js'
import { createPipeline } from './lifecycle.js'
import { emitEvent } from './logs.js'
import { SessionRecorder } from './recorder.js'

const { version } = createRequire(import.meta.url)('../package.json') as { version: string }

export { Config, resolveConfig, signalUrl }
export type { Signal, ContentMode, ResolvedConfig } from './config.js'
export { billedInputTokens, usageAttributes, SessionRecorder } from './recorder.js'
export { projectEvent, type ProjectedEvent } from './projection.js'
export { emitEvent } from './logs.js'
export { EXTRACTED_LOG_KEYS, TRACE_PIPELINE_NAME, exporterOptions, headersFor } from './otlp.js'
export { createPipeline, SCOPE_NAME, type Pipeline } from './lifecycle.js'

/** Cordis plugin name. */
export const name = 'greptimedb-otel'

/** The session store is this plugin's whole input; without it the fiber stays pending. */
export const inject = ['sessions']

/**
 * Mount the exporter on a context.
 * @param ctx - the registrant context carrying the session store.
 * @param config - the plugin configuration from `cordis.yml`.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const pipeline = createPipeline(resolved, version, (error: unknown) => {
    ctx.logger.warn('greptimedb-otel: telemetry shutdown failed: %o', error)
  })
  const recorders = new WeakMap<Session, SessionRecorder>()

  const contain = (work: () => void): void => {
    try {
      work()
    } catch (error) {
      // Telemetry is best-effort. cordis dispatches these listeners
      // stop-on-throw, so an escape here would both starve the remaining
      // observers and surface inside the agent loop.
      ctx.logger.warn('greptimedb-otel: dropped a telemetry record: %o', error)
    }
  }

  const recorderFor = (session: Session): SessionRecorder | undefined => {
    if (pipeline.tracer === undefined || pipeline.instruments === undefined) return undefined
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new SessionRecorder(session.id, pipeline.tracer, pipeline.instruments, session.header.createdAt)
      recorders.set(session, recorder)
    }
    return recorder
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    contain(() => {
      recorderFor(session)?.handle(event)
      if (pipeline.logger !== undefined) emitEvent(pipeline.logger, session.id, event, resolved.content)
    })
  })

  ctx.on('session/disposed', (session: Session) => {
    contain(() => {
      recorders.get(session)?.closeAll()
      recorders.delete(session)
    })
  })

  ctx.on('agent/error', ({ agent, step, error }) => {
    contain(() => {
      recorders.get(agent.session)?.fail(step, error)
    })
  })

  // `session/flush` is deliberately not observed. Forcing a flush per turn
  // would be this pipeline's only source of concurrent flushes, whose
  // interaction with the batch processors' shutdown drain drops tail records.
  ctx.effect(() => async () => {
    for (const session of ctx.sessions.list()) {
      contain(() => {
        recorders.get(session)?.closeAll()
        recorders.delete(session)
      })
    }
    await pipeline.shutdown()
  })
}
