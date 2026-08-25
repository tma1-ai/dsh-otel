#!/usr/bin/env node
/**
 * Pack the package, install it into a scratch project, and exercise it the way
 * a consumer does.
 *
 * Running against `src/` cannot catch a missing `files` entry, an export left
 * out of `index.ts`, or a bundle declaration that does not ship — every one of
 * which only breaks after publish.
 *
 * @module scripts/smoke-tarball
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const run = (command, args, cwd) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })

run('pnpm', ['run', 'build'], root)
const tarball = join(root, run('npm', ['pack', '--silent'], root).trim().split('\n').at(-1))

const scratch = mkdtempSync(join(tmpdir(), 'dsh-otel-smoke-'))
try {
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ name: 'smoke', private: true, type: 'module', version: '1.0.0' }))
  // Peers belong to the host harness, not to a packaging smoke test.
  writeFileSync(join(scratch, '.npmrc'), 'auto-install-peers=false\nstrict-peer-dependencies=false\n')
  run('pnpm', ['add', tarball], scratch)

  const installed = join(scratch, 'node_modules', pkg.name)
  const plugin = await import(pathToFileURL(join(installed, 'lib', 'index.js')).href)
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  const resolved = plugin.resolveConfig({ endpoint: 'http://localhost:4000/v1/otlp' })

  const checks = [
    ['plugin name', plugin.name === 'greptimedb-otel'],
    ['injects sessions', Array.isArray(plugin.inject) && plugin.inject.includes('sessions')],
    ['apply exported', typeof plugin.apply === 'function'],
    ['resolveConfig exported', typeof plugin.resolveConfig === 'function'],
    ['createPipeline exported', typeof plugin.createPipeline === 'function'],
    ['defaults to content: none', resolved.content === 'none'],
    ['trace pipeline header', plugin.headersFor(resolved, 'traces')['X-Greptime-Pipeline-Name'] === plugin.TRACE_PIPELINE_NAME],
    ['log extract keys header', plugin.headersFor(resolved, 'logs')['X-Greptime-Log-Extract-Keys'] === plugin.EXTRACTED_LOG_KEYS.join(',')],
    ['bundle patch declared', manifest.dsh?.bundle?.patch === './cordis.patch.yml'],
    ['bundle patch shipped', readFileSync(join(installed, 'cordis.patch.yml'), 'utf8').includes('greptimedb-otel')],
  ]

  let failed = 0
  for (const [label, ok] of checks) {
    if (!ok) failed += 1
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`)
  }
  if (failed > 0) {
    console.error(`${String(failed)} packaging check(s) failed`)
    process.exit(1)
  }
  console.log(`\n${String(checks.length)} packaging checks passed`)
} finally {
  rmSync(scratch, { recursive: true, force: true })
  rmSync(tarball, { force: true })
}
