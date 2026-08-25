/**
 * Build and pack once for the whole run.
 *
 * Both e2e tiers install the packed tarball. Letting each pack for itself makes
 * them race on `lib/` and on the tarball path when vitest runs the files in
 * parallel.
 *
 * @module tests/global-setup
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Environment variable carrying the packed tarball path to the e2e specs. */
export const TARBALL_ENV = 'DSH_OTEL_TARBALL'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Build the package and pack it into a scratch directory.
 * @returns the teardown removing that directory.
 */
export default function setup(): () => void {
  const packDir = mkdtempSync(join(tmpdir(), 'dsh-otel-pack-'))
  execFileSync('pnpm', ['run', 'build'], { cwd: root, stdio: ['ignore', 'pipe', 'inherit'] })
  const name = execFileSync('npm', ['pack', '--silent', '--pack-destination', packDir], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  }).trim().split('\n').at(-1)
  if (name === undefined) throw new Error('npm pack produced no tarball name')
  process.env[TARBALL_ENV] = join(packDir, name)
  return () => { rmSync(packDir, { recursive: true, force: true }) }
}
