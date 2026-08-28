#!/usr/bin/env node
/**
 * Run every dashboard panel's query through Grafana and report the ones that
 * fail or come back empty.
 *
 * A dashboard is only "works out of the box" if its queries actually parse
 * against the live schema. GreptimeDB creates a column per attribute it has
 * seen, so a panel reading an attribute nothing has written yet fails at plan
 * time rather than showing zero.
 *
 *
 *   node grafana/verify.mjs [--grafana http://localhost:3000] [--range 24h]
 *
 * @module grafana/verify
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = new Map()
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1])
const grafana = args.get('--grafana') ?? 'http://localhost:3000'
const range = args.get('--range') ?? '24h'

const dashboardDir = join(dirname(fileURLToPath(import.meta.url)), 'dashboards')

/**
 * Execute one panel query through Grafana's datasource proxy.
 * @param target - the panel target carrying `rawSql`/`expr` and `format`.
 * @param datasource - the target's datasource, or the panel's when the target omits it.
 * @param variables - dashboard template variables to substitute.
 * @returns the error message, or the row count on success.
 */
async function runTarget(target, datasource, variables) {
  // Grafana expands template variables in the browser. Both spellings occur in
  // these dashboards, and `${name}` must be handled first: replacing `$name`
  // first would leave a stray brace behind.
  const expand = (text) => {
    let out = text
    for (const [name, replacement] of variables) {
      out = out.replaceAll(`\${${name}}`, replacement).replaceAll(`$${name}`, replacement)
    }
    return out
  }
  const query = target.expr === undefined
    ? { refId: 'A', datasource, rawSql: expand(target.rawSql), format: target.format ?? 'table' }
    // A PromQL target needs the range flag and an interval. The datasource
    // derives `$__rate_interval` from it, and a large interval widens the rate
    // window past the data, so this mirrors what a real panel width produces.
    : { refId: 'A', datasource, expr: target.expr, range: true, intervalMs: 15_000, maxDataPoints: 400 }
  const response = await fetch(`${grafana}/api/ds/query`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ queries: [query], from: `now-${range}`, to: 'now' }),
  })
  const body = await response.json()
  const result = body.results?.A
  if (result === undefined) return { error: JSON.stringify(body).slice(0, 200) }
  if (result.error !== undefined) return { error: String(result.error) }
  const frame = result.frames?.[0]
  return { rows: frame?.data?.values?.[0]?.length ?? 0 }
}

/**
 * Build the substitution table for a dashboard's template variables.
 * @param dashboard - the parsed dashboard JSON.
 * @returns name-to-SQL-literal pairs.
 */
function variablesOf(dashboard) {
  const pairs = []
  for (const variable of dashboard.templating?.list ?? []) {
    // Check the query each panel actually issues on a fresh load, which is the
    // variable's own default — not a placeholder that no user will ever send.
    const current = variable.current?.value
    const value = Array.isArray(current) ? (current[0] ?? '') : (current ?? '')
    pairs.push([variable.name, String(value)])
  }
  return pairs
}

let failures = 0
let empty = 0
let checked = 0

for (const file of readdirSync(dashboardDir).filter(name => name.endsWith('.json'))) {
  const dashboard = JSON.parse(readFileSync(join(dashboardDir, file), 'utf8'))
  const variables = variablesOf(dashboard)
  console.log(`\n${file}  (${dashboard.title})`)
  for (const panel of dashboard.panels ?? []) {
    for (const target of panel.targets ?? []) {
      if (target.rawSql === undefined && target.expr === undefined) continue
      checked += 1
      // "All" expands to every value in the browser. `IS NOT NULL` is the same
      // row set here, wherever the panel puts the filter.
      const withoutFilter = target.rawSql !== undefined && target.rawSql.includes('IN ($model)')
      // A target may omit its datasource and inherit the panel's.
      const datasource = target.datasource ?? panel.datasource
      const result = await runTarget(
        withoutFilter ? { ...target, rawSql: target.rawSql.replaceAll('IN ($model)', 'IS NOT NULL') } : target,
        datasource,
        variables,
      )
      if (result.error !== undefined) {
        failures += 1
        console.log(`  FAIL  ${panel.title}\n        ${result.error.slice(0, 220)}`)
      } else if (result.rows === 0) {
        empty += 1
        console.log(`  EMPTY ${panel.title}`)
      } else {
        console.log(`  ok    ${panel.title}  (${String(result.rows)} rows)`)
      }
    }
  }
}

console.log(`\n${String(checked)} panel queries: ${String(checked - failures - empty)} ok, ${String(empty)} empty, ${String(failures)} failed`)
if (failures > 0) process.exit(1)
