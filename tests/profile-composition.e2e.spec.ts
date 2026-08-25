/**
 * Compose the packed package as a real DSH profile bundle.
 *
 * `dsh plugin --profile <name> add` resolves a bundle through
 * `dsh.bundle.patch`, parses that patch file, and folds it into the entry tree.
 * Checking the manifest fields by hand proves none of that: only running
 * DSH's own `loadProfile` + `composeEntries` over an installed tarball shows
 * that the patch resolves, parses, and produces a mountable entry.
 *
 * @module tests/profile-composition.e2e
 */

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { composeEntries, loadProfile, writeProfileManifest, type Profile } from '@deepseek-ai/dsh-app-boot'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { TARBALL_ENV } from './global-setup.js'

const PACKAGE_NAME = 'dsh-plugin-greptimedb'
const PROFILE_NAME = 'e2e'

let home: string
let profile: Profile
let entries: EntryOptions[]

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
}

describe('profile composition through DSH app-boot', () => {
  beforeAll(() => {
    const tarball = process.env[TARBALL_ENV]
    if (tarball === undefined) throw new Error(`${TARBALL_ENV} is unset; the global setup must run first`)

    home = mkdtempSync(join(tmpdir(), 'dsh-otel-home-'))
    const profileDir = join(home, 'profiles', PROFILE_NAME)
    mkdirSync(profileDir, { recursive: true })
    // The profile's own package.json is both the dependency manifest and the
    // `dsh.profile.bundles` layer list — exactly what `dsh plugin add` writes.
    writeProfileManifest(profileDir, {
      name: `dsh-profile-${PROFILE_NAME}`,
      dsh: { profile: { bundles: [PACKAGE_NAME] } },
    })
    writeFileSync(join(profileDir, '.npmrc'), 'auto-install-peers=false\nstrict-peer-dependencies=false\n')
    run('pnpm', ['add', tarball], profileDir)

    // The install anchor is the launcher's own package.json. Pointing it at a
    // directory without the bundle exercises the second anchor — the profile
    // directory — which is how an out-of-tree plugin actually resolves.
    const installAnchor = join(home, 'fake-dsh-app', 'package.json')
    mkdirSync(dirname(installAnchor), { recursive: true })
    writeFileSync(installAnchor, JSON.stringify({ name: 'dsh', version: '0.0.0' }))

    profile = loadProfile('dsh', PROFILE_NAME, installAnchor, home)
    entries = composeEntries([...profile.layers.map(layer => layer.patches), profile.patches])
  }, 300_000)

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it('resolves the bundle from the profile directory', () => {
    expect(profile.layers.map(layer => layer.packageName)).toEqual([PACKAGE_NAME])
    expect(profile.layers[0]?.patchPath).toMatch(/cordis\.patch\.yml$/)
  })

  it('composes one mountable entry naming the published package', () => {
    const entry = entries.find(candidate => candidate.id === 'greptimedb-otel')
    expect(entry).toBeDefined()
    expect(entry?.name).toBe(PACKAGE_NAME)
  })

  it('carries a usable default configuration', () => {
    const entry = entries.find(candidate => candidate.id === 'greptimedb-otel')
    const config = entry?.config as Record<string, unknown> | undefined
    expect(config?.['content']).toBe('none')
    expect(config?.['logTable']).toBe('dsh_logs')
  })

  it('keeps environment-driven fields as Loader expressions', () => {
    // `!!js` scalars stay unevaluated through composition; the Loader
    // interpolates them at mount. A backtick-led scalar would have failed to
    // parse in loadProfile above, before reaching this assertion.
    const config = entries.find(entry => entry.id === 'greptimedb-otel')?.config as Record<string, unknown>
    const endpoint = config['endpoint'] as { __jsExpr?: string }
    expect(endpoint.__jsExpr).toContain('GREPTIMEDB_OTLP_ENDPOINT')
    expect(endpoint.__jsExpr).toContain('http://localhost:4000/v1/otlp')
  })

  it('lets a user patch layer replace the whole config', () => {
    // A profile patch replaces rather than merges, which is why the plugin's
    // own defaults must be restated by anyone overriding the row.
    const overridden = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      [{ id: 'greptimedb-otel', config: { endpoint: 'https://db.example.com/v1/otlp', content: 'full' } }],
    ])
    const config = overridden.find(entry => entry.id === 'greptimedb-otel')?.config as Record<string, unknown>
    expect(config['endpoint']).toBe('https://db.example.com/v1/otlp')
    expect(config['content']).toBe('full')
    expect(config['logTable']).toBeUndefined()
  })
})
