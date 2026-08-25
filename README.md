# @tma1-ai/dsh-plugin-greptimedb

[![npm](https://img.shields.io/npm/v/@tma1-ai/dsh-plugin-greptimedb.svg)](https://www.npmjs.com/package/@tma1-ai/dsh-plugin-greptimedb)
[![CI](https://github.com/tma1-ai/dsh-otel/actions/workflows/ci.yml/badge.svg)](https://github.com/tma1-ai/dsh-otel/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@tma1-ai/dsh-plugin-greptimedb.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@tma1-ai/dsh-plugin-greptimedb.svg)](LICENSE)

English | [中文](README.zh.md)

Send [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) telemetry to [GreptimeDB](https://github.com/GreptimeTeam/greptimedb) as OpenTelemetry traces, metrics, and logs.

No collector. No sidecar. No fork of DSH. It installs as an ordinary plugin, and every turn, model call, and tool execution becomes a row you can query:

```sql
-- Slowest tool calls, with the model that requested them
SELECT span_name,
       "span_attributes.gen_ai.request.model" AS model,
       duration_nano / 1000000 AS ms
FROM opentelemetry_traces
WHERE span_name LIKE 'execute_tool%'
ORDER BY duration_nano DESC
LIMIT 10;
```

## Install

```sh
dsh plugin --profile headless add @tma1-ai/dsh-plugin-greptimedb
```

The package ships a bundle patch, so that one command wires it into the profile. To point it at your own database, override the row in `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- id: greptimedb-otel
  name: '@tma1-ai/dsh-plugin-greptimedb'
  config:
    endpoint: https://<host>/v1/otlp
    database: <dbname>
    username: <user>
    password: <password>
```

A profile patch replaces the row's whole `config` instead of merging into it, so restate every field you want to keep.

The defaults already point at a local GreptimeDB:

```sh
docker run -p 127.0.0.1:4000-4003:4000-4003 \
  -v "$(pwd)/greptimedb_data:/greptimedb_data" \
  --name greptime --rm greptime/greptimedb:v1.0.0 standalone start \
  --http-addr 0.0.0.0:4000 --rpc-bind-addr 0.0.0.0:4001 \
  --mysql-addr 0.0.0.0:4002 --postgres-addr 0.0.0.0:4003
```

## Configuration

| Key | Default | Notes |
|---|---|---|
| `endpoint` | *(required)* | OTLP **base** URL, e.g. `http://localhost:4000/v1/otlp`. The plugin appends each signal's `/v1/{traces,metrics,logs}` suffix; a per-signal path is rejected at load. |
| `database` | `public` | Sent as `X-Greptime-DB-Name`. |
| `username` / `password` | *(none)* | Basic auth. Both or neither. |
| `signals` | all three | Any subset of `traces`, `metrics`, `logs`. A disabled signal builds no exporter. |
| `content` | `none` | How much payload may leave the process. See [What leaves the machine](#what-leaves-the-machine). |
| `serviceName` | `dsh` | OTel `service.name`. |
| `logTable` / `traceTable` | GreptimeDB defaults | Destination table overrides. |
| `shutdownTimeoutMillis` | `3000` | Deadline for the entire teardown sequence. |
| `metricIntervalMillis`, `maxExportBatchSize`, `maxQueueSize`, `scheduledDelayMillis`, `exportTimeoutMillis` | SDK defaults | Batching and export tuning. `metricIntervalMillis` must be at least `exportTimeoutMillis`. |

Bad configuration fails at plugin load with the offending field named, not at the first export.

## Traces

Turn spans are roots. Chat and tool spans hang off them as siblings, correlated by `dsh.step`:

```
invoke_agent dsh              turn/start → turn/end
├── chat deepseek-chat        step/start → assistant/message
├── execute_tool bash         tool/call  → tool/result
└── chat deepseek-chat
```

Siblings, not nesting. DSH appends `assistant/message` first and executes the requested tools afterwards, so a tool span nested under a chat span would start after its parent ended. That breaks waterfall and latency views.

Timestamps come from the session event that justifies them, never from a clock read while handling it.

A chat span closes on one of four paths, each with a defined end time:

| Situation | End time | Status |
|---|---|---|
| Model responded | `assistant/message` | OK |
| Stream interrupted | `assistant/message` | OK, plus `dsh.response.interrupted` |
| Request failed | that step's `step/end` | ERROR, exception recorded |
| No end event (crash, teardown) | last event seen | UNSET, plus `dsh.span.unclosed` |

The last row covers genuinely missing boundaries only. A failed request is measured, not written off.

### Token accounting

DSH reports disjoint counts. `inputTokens` is uncached input alone; cache reads and writes are separate fields. The GenAI convention's `gen_ai.usage.input_tokens` is the billed total, so the plugin exports:

```
gen_ai.usage.input_tokens  = inputTokens + cacheReadTokens + cacheWriteTokens
gen_ai.usage.output_tokens = outputTokens          (reasoning tokens included)
```

Exporting `inputTokens` alone understates every cached request, often by an order of magnitude. The breakdown stays queryable as `dsh.usage.uncached_input_tokens`, `dsh.usage.cache_read_tokens`, `dsh.usage.cache_write_tokens`, and `dsh.usage.reasoning_tokens`.

## Metrics

| Instrument | Type | Dimensions |
|---|---|---|
| `gen_ai.client.token.usage` | Histogram | `gen_ai.token.type` (`input`/`output` only), model, provider |
| `gen_ai.client.operation.duration` | Histogram | `gen_ai.operation.name`, model |
| `dsh.token.detail` | Histogram | `dsh.token.detail_kind` (`cache_read`/`cache_write`/`reasoning`) |
| `dsh.tool.invocations` | Counter | `gen_ai.tool.name`, `dsh.tool.outcome` |
| `dsh.turns` / `dsh.steps` | Counter | |

Cache and reasoning counts stay off the standard token histogram so a plain `SUM()` over it cannot double-count.

## Logs

One record per session event. Four attributes become real columns through `X-Greptime-Log-Extract-Keys`:

```sql
SELECT session_id, event_type, turn, step, body
FROM dsh_logs
WHERE session_id = '...' AND event_type = 'tool/result'
ORDER BY timestamp;
```

Attributes are underscore-named because GreptimeDB keeps unextracted ones in a JSON column read with `json_get_string()`, which reads a dotted key like `session.id` as a nested path and cannot address it.

`assistant/chunk` is never exported: tens of thousands of token deltas per session, every fact already in the assembled message.

## What leaves the machine

`content` decides this. The default withholds all payloads.

| Mode | Exported |
|---|---|
| `none` *(default)* | Structure and accounting: event types, turn and step numbers, token counts, tool names, durations, outcomes, error `name` and `code`. |
| `full` | Adds user and assistant message content, tool arguments, tool results. |
| `full+prompt` | Adds `request/header`: the complete system prompt and every tool schema. |

Two things never leave in any mode: a tool's private `meta` payload (opaque and arbitrary by design) and the internal `error.message` of a failed turn (provider text that can quote the prompt back).

The projection is a positive allowlist, so an event type the plugin does not know — including one a future DSH plugin declares — exports its identity and nothing else. DSH's own `session-telemetry-otel` defaults the other way: its `FULL` mode ships the complete `event.data`, system prompt included, with no redaction rules of its own.

## Dashboards

Four Grafana dashboards ship in [`grafana/`](grafana/), along with a compose stack that brings up GreptimeDB and Grafana together.

```sh
cd grafana && docker compose up -d && open http://localhost:3000
```

![Overview](https://raw.githubusercontent.com/tma1-ai/dsh-otel/main/grafana/screenshots/overview.png)

![Trace explorer](https://raw.githubusercontent.com/tma1-ai/dsh-otel/main/grafana/screenshots/trace-explorer.png)

| Dashboard | Answers |
|---|---|
| Overview | What did this cost, how fast was it, how much came from cache |
| Agent loop | Which tools ran, how often they failed, how many model calls a turn needed |
| Trace explorer | What happened inside one specific turn, span by span |
| Log explorer | Every session event, filterable by session, type, and full-text search |
| Metrics | The same activity through PromQL, for longer retention and sampling-proof percentiles |

Every table links onward: a trace id opens that turn's waterfall, a session id jumps between the trace and log views. Every panel query is checked against a live database by `node grafana/verify.mjs`. See [grafana/README.md](grafana/README.md) for the datasource split and [grafana/indexes.sql](grafana/indexes.sql) for the indexes these queries want.

## With TMA1

[TMA1](https://github.com/tma1-ai/tma1) proxies OTLP into a GreptimeDB it manages. Point `endpoint` at it and DSH shows up in the OTel GenAI view:

```yaml
endpoint: http://localhost:14318/v1/otlp
```

TMA1's `tma1_token_usage_1m`, `cost_1m`, `latency_1m`, and `status_1m` flow tables derive from `span_attributes.gen_ai.*`, which this plugin populates by convention.

## Development

```sh
pnpm test     # unit, profile composition, Loader boot
pnpm smoke    # packaging checks against a freshly packed tarball
GREPTIMEDB_OTLP_ENDPOINT=http://localhost:4000/v1/otlp pnpm test   # adds the live database round trip
```

Four tiers, because each catches what the ones below cannot: unit tests for the span state machine and the projection allowlist, profile composition for a bundle patch that fails to resolve or parse, Loader boot for bare-name resolution and real OTLP bytes, and a live GreptimeDB for trace-pipeline acceptance and SQL-visible values.

## Known limitations

- **DSH is pre-release** and reserves the right to rename and repackage freely before its first tagged release. This plugin reads only the session event stream and documented payload fields, and pins its peer range to the version it is tested against (`0.1.1-rc.2`).
- **The GenAI conventions are experimental.** Names come from `@opentelemetry/semantic-conventions/incubating` and move with it. Spans carry both `gen_ai.provider.name` and the deprecated `gen_ai.system`, because existing dashboards select on the old name.
- **No per-turn flush.** Export follows the batch processors' cadence. A forced flush per turn would be this pipeline's only source of concurrent flushes, and their interaction with the shutdown drain drops tail records.
- **Shutdown is bounded, and the bound cannot cancel a transport.** Records in flight when `shutdownTimeoutMillis` expires may be lost at exit. The alternative, an unbounded wait, hangs the CLI.
- **Subagent sessions get their own trace.** Each session's spans form a separate tree, not stitched into the parent's.

## License

Apache-2.0
