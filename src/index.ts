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
 * @module @tma1-ai/dsh-plugin-greptimedb
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
  const pipeline = createPipeline(resolved, version, (stage, error) => {
    // A rejected export means the data is simply absent. GreptimeDB puts the
    // reason (schema mismatch, unknown table, auth) in the error's `data`, so
    // it is logged alongside the message rather than left to inspection depth.
    const detail = error instanceof Error && 'data' in error ? ` ${String(error.data)}` : ''
    ctx.logger.warn('greptimedb-otel: telemetry %s failed: %s%s', stage, String(error), detail)
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

  const recorderFor = (session: Session): SessionRecorder => {
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new SessionRecorder(session.id, pipeline.tracer, pipeline.instruments, session.header.createdAt)
      // The log already holds the route; the newest `request/context` is the
      // one in effect. Replaying more than this would re-emit spans for work
      // that already happened.
      for (let index = session.events.length - 1; index >= 0; index -= 1) {
        const event = session.events[index]
        if (event?.type !== 'request/context') continue
        recorder.seedRoute(event.data.provider, event.data.model)
        break
      }
      recorders.set(session, recorder)
    }
    return recorder
  }

  // A hot reload mounts a fresh fiber over sessions that are already live and
  // will not replay `session/created`, so they are adopted here.
  for (const session of ctx.sessions.list()) {
    contain(() => { recorderFor(session) })
  }

  ctx.on('session/event', (session: Session, event: SessionEvent) => {
    contain(() => {
      const recorder = recorderFor(session)
      recorder.handle(event)
      // Emitting inside the turn's context stamps the record with the trace
      // and span ids, which is what makes a log line navigable to its turn.
      emitEvent(pipeline.logger, session.id, event, resolved.content, recorder.activeContext())
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
