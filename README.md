# dsh-plugin-greptimedb

English | [中文](README.zh.md)

OpenTelemetry traces, metrics, and logs for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), written straight into [GreptimeDB](https://github.com/GreptimeTeam/greptimedb).

No collector, no sidecar, no patch to DSH. It is an ordinary DSH plugin: install it, name it in your profile, and every turn, model call, and tool execution lands in one database you can query with SQL.

```sql
SELECT span_name,
       "span_attributes.gen_ai.request.model" AS model,
       "span_attributes.gen_ai.usage.input_tokens" AS input_tokens,
       duration_nano / 1000000 AS ms
FROM opentelemetry_traces
WHERE span_name LIKE 'execute_tool%'
ORDER BY duration_nano DESC
LIMIT 10;
```

## Install

```sh
dsh plugin --profile headless add dsh-plugin-greptimedb
```

The package ships a bundle patch, so that command wires it into the profile. Point it at your database by overriding the row in `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

```yaml
- id: greptimedb-otel
  name: 'dsh-plugin-greptimedb'
  config:
    endpoint: https://<host>/v1/otlp
    database: <dbname>
    username: <user>
    password: <password>
```

A profile patch **replaces** the row's whole `config` rather than merging into it, so restate every field you keep.

For a local GreptimeDB the defaults already work:

```sh
docker run -p 127.0.0.1:4000-4003:4000-4003 \
  -v "$(pwd)/greptimedb_data:/greptimedb_data" \
  --name greptime --rm greptime/greptimedb:v1.0.0 standalone start \
  --http-addr 0.0.0.0:4000 --rpc-bind-addr 0.0.0.0:4001 \
  --mysql-addr 0.0.0.0:4002 --postgres-addr 0.0.0.0:4003
```

## Config

| Key | Default | Notes |
|---|---|---|
| `endpoint` | *(required)* | OTLP **base** URL, e.g. `http://localhost:4000/v1/otlp`. Each signal's `/v1/{traces,metrics,logs}` suffix is appended for you; a per-signal path here is rejected at load. |
| `database` | `public` | Sent as `X-Greptime-DB-Name`. |
| `username` / `password` | *(none)* | Basic auth. Must be set together. |
| `signals` | all three | Any subset of `traces`, `metrics`, `logs`. A disabled signal builds no exporter at all. |
| `content` | `none` | How much payload may leave the process. See [What leaves the machine](#what-leaves-the-machine). |
| `serviceName` | `dsh` | OTel `service.name`. |
| `logTable` / `traceTable` | GreptimeDB defaults | Override the destination tables. |
| `shutdownTimeoutMillis` | `3000` | Outer deadline for the **whole** teardown sequence. |
| `metricIntervalMillis` | `30000` | Metric collection period. Must be ≥ `exportTimeoutMillis`. |
| `maxExportBatchSize` / `maxQueueSize` | `512` / `2048` | Batch and buffer bounds. |
| `scheduledDelayMillis` / `exportTimeoutMillis` | `5000` / `30000` | Export cadence and per-request deadline. |

Misconfiguration fails at plugin load with the field named, not later at the first export.

## Traces

Turn spans are roots; chat and tool spans are their **siblings**, correlated by `dsh.step`.

```
invoke_agent dsh              turn/start → turn/end
├── chat deepseek-chat        step/start → assistant/message
├── execute_tool bash         tool/call  → tool/result
└── chat deepseek-chat
```

They are siblings, not nested, because DSH appends `assistant/message` and only *then* executes the tools that message requested. A tool span nested under a chat span would begin entirely after its parent ended, breaking every waterfall and latency view.

Every timestamp comes from the session event that justifies it, never from a clock read at handling time.

A chat span closes on one of four paths, each with a defined end time:

| Situation | End time | Status |
|---|---|---|
| Model responded | `assistant/message` | OK |
| Response interrupted mid-stream | `assistant/message` | OK, plus `dsh.response.interrupted` |
| Request failed | that step's `step/end` | ERROR, with the exception recorded |
| No end event at all (crash, teardown) | last event seen | UNSET, plus `dsh.span.unclosed` |

The last row is only for genuinely missing boundaries — a failed request is measured, not written off as unclosed.

### Token accounting

DSH reports **disjoint** counts: `inputTokens` is uncached input only, with cache reads and writes accounted separately. The GenAI convention's `gen_ai.usage.input_tokens` is the *billed* total, so this plugin exports:

```
gen_ai.usage.input_tokens  = inputTokens + cacheReadTokens + cacheWriteTokens
gen_ai.usage.output_tokens = outputTokens          (already includes reasoning tokens)
```

Exporting `inputTokens` alone would understate every cached request — often by an order of magnitude. The breakdown stays queryable as `dsh.usage.uncached_input_tokens`, `dsh.usage.cache_read_tokens`, `dsh.usage.cache_write_tokens`, and `dsh.usage.reasoning_tokens`.

## Metrics

| Instrument | Type | Dimensions |
|---|---|---|
| `gen_ai.client.token.usage` | Histogram | `gen_ai.token.type` (`input`/`output` only), model, provider |
| `gen_ai.client.operation.duration` | Histogram | `gen_ai.operation.name`, model |
| `dsh.token.detail` | Histogram | `dsh.token.detail_kind` (`cache_read`/`cache_write`/`reasoning`) |
| `dsh.tool.invocations` | Counter | `gen_ai.tool.name`, `dsh.tool.outcome` |
| `dsh.turns` / `dsh.steps` | Counter | — |

Cache and reasoning counts stay off the standard token histogram so a naive `SUM()` over it cannot double-count.

## Logs

One record per session event. Four attributes are promoted to real columns via `X-Greptime-Log-Extract-Keys`:

```sql
SELECT session_id, event_type, turn, step, body
FROM dsh_logs
WHERE session_id = '...' AND event_type = 'tool/result'
ORDER BY timestamp;
```

This is why every attribute here is underscore-named. GreptimeDB stores unextracted attributes in a JSON column read with `json_get_string()`, which interprets a dotted key like `session.id` as a nested path and cannot address it.

`assistant/chunk` is never exported — tens of thousands of token deltas per session, every fact already present in the assembled message.

## What leaves the machine

`content` controls this, and the default withholds all payloads.

| Mode | Exported |
|---|---|
| `none` *(default)* | Structure and accounting only: event types, turn/step numbers, token counts, tool names, durations, outcomes, error `name`/`code`. |
| `full` | Adds user and assistant message content, tool arguments, and tool results. |
| `full+prompt` | Adds `request/header` — the complete system prompt and every tool schema. |

Two things are withheld in **every** mode: a tool's private `meta` payload (opaque and arbitrary by design), and the internal `error.message` of a failed turn (provider text that can quote the prompt back).

The projection is a positive allowlist. An event type this plugin does not know — including one a future DSH plugin declares — exports its identity and nothing else. A generic clone of `event.data` would have silently started leaking whatever that type happens to carry.

DSH's own `session-telemetry-otel` takes the opposite default: its `FULL` mode ships the complete `event.data`, system prompt included, with no redaction rules of its own.

## Using it with TMA1

[TMA1](https://github.com/tma1-ai/tma1) proxies OTLP to a GreptimeDB it manages. Point `endpoint` at it and DSH appears in the OTel GenAI view with no further setup:

```yaml
endpoint: http://localhost:14318/v1/otlp
```

TMA1's `tma1_token_usage_1m` / `cost_1m` / `latency_1m` / `status_1m` flow tables derive from `span_attributes.gen_ai.*`, which this plugin populates by convention.

## Known limitations

- **DSH is pre-release.** It reserves the right to rename and repackage freely before its first tagged release. This plugin reads only the session event stream and the documented payload fields, and its peer range is pinned to the version it is tested against (`0.1.1-rc.2`).
- **The GenAI conventions are experimental.** Attribute names come from `@opentelemetry/semantic-conventions/incubating` and move with it. `gen_ai.system` is deliberately not emitted — it is deprecated in favour of `gen_ai.provider.name`.
- **No per-turn flush.** Export follows the batch processors' own cadence. Forcing a flush per turn would be this pipeline's only source of concurrent flushes, whose interaction with the shutdown drain drops tail records.
- **Shutdown is bounded, and the bound cannot cancel a transport.** Records still in flight when `shutdownTimeoutMillis` expires may be lost at process exit. The alternative — an unbounded wait — hangs the CLI.
- **Subagent sessions get their own trace.** Each session's spans form a separate tree; they are not stitched into the parent session's trace.

## License

Apache-2.0
