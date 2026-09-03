/**
 * A DeepSeek Harness plugin that exports the agent loop to GreptimeDB as
 * OpenTelemetry traces, metrics, and logs.
 *
 * Everything derives from the session event stream, so the plugin adds no
 * extension point and mounts on any composition with sessions. Listeners stay
 * synchronous and contain their own failures because cordis dispatches them on
 * the loop's path, where a throw would reach the agent.
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
    // GreptimeDB puts the reason in `data`, so it is logged rather than left
    // to inspection depth.
    const detail = error instanceof Error && 'data' in error ? ` ${String(error.data)}` : ''
    ctx.logger.warn('greptimedb-otel: telemetry %s failed: %s%s', stage, String(error), detail)
  })
  const recorders = new WeakMap<Session, SessionRecorder>()

  const contain = (work: () => void): void => {
    try {
      work()
    } catch (error) {
      // cordis dispatches stop-on-throw, so an escape would starve the
      // remaining observers and surface inside the agent loop.
      ctx.logger.warn('greptimedb-otel: dropped a telemetry record: %o', error)
    }
  }

  const recorderFor = (session: Session): SessionRecorder => {
    let recorder = recorders.get(session)
    if (recorder === undefined) {
      recorder = new SessionRecorder(session.id, pipeline.tracer, pipeline.instruments, session.header.createdAt)
      // Replaying more than the route would re-emit spans for past work, and
      // the session already folds `request/context` down to exactly that.
      const route = session.requestContext()
      if (route !== undefined) recorder.seedRoute(route.provider, route.model)
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
      // The turn's context is what stamps trace and span ids onto the record.
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

  // `session/flush` is deliberately not observed: a per-turn flush would be the
  // only source of concurrent flushes, which drops tail records at shutdown.
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
