# dsh-plugin-greptimedb

[![npm](https://img.shields.io/npm/v/dsh-plugin-greptimedb.svg)](https://www.npmjs.com/package/dsh-plugin-greptimedb)
[![CI](https://github.com/tma1-ai/dsh-otel/actions/workflows/ci.yml/badge.svg)](https://github.com/tma1-ai/dsh-otel/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/dsh-plugin-greptimedb.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/dsh-plugin-greptimedb.svg)](LICENSE)

[English](README.md) | 中文

把 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的运行数据以 OpenTelemetry traces、metrics、logs 写入 [GreptimeDB](https://github.com/GreptimeTeam/greptimedb)。

不需要 collector，不需要 sidecar，不用 fork DSH。它就是个普通插件，装上之后每一次 turn、模型调用和工具执行都变成一行可查的数据：

```sql
-- 最慢的工具调用，以及是哪个模型发起的
SELECT span_name,
       "span_attributes.gen_ai.request.model" AS model,
       duration_nano / 1000000 AS ms
FROM opentelemetry_traces
WHERE span_name LIKE 'execute_tool%'
ORDER BY duration_nano DESC
LIMIT 10;
```

```sql
-- 各模型的缓存命中情况
SELECT "span_attributes.gen_ai.request.model" AS model,
       SUM("span_attributes.dsh.usage.cache_read_tokens") AS cached,
       SUM("span_attributes.gen_ai.usage.input_tokens") AS billed
FROM opentelemetry_traces
WHERE span_name LIKE 'chat%'
GROUP BY model;
```

## 安装

```sh
dsh plugin --profile headless add dsh-plugin-greptimedb
```

包自带 bundle patch，这一条命令就把它接进 profile。要指向自己的数据库，在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里覆盖这一行：

```yaml
- id: greptimedb-otel
  name: 'dsh-plugin-greptimedb'
  config:
    endpoint: https://<host>/v1/otlp
    database: <dbname>
    username: <user>
    password: <password>
```

profile patch 是整体替换目标行的 `config`，不是深合并，所以要保留的字段必须全部重述。

默认配置直接指向本地 GreptimeDB：

```sh
docker run -p 127.0.0.1:4000-4003:4000-4003 \
  -v "$(pwd)/greptimedb_data:/greptimedb_data" \
  --name greptime --rm greptime/greptimedb:v1.0.0 standalone start \
  --http-addr 0.0.0.0:4000 --rpc-bind-addr 0.0.0.0:4001 \
  --mysql-addr 0.0.0.0:4002 --postgres-addr 0.0.0.0:4003
```

## 配置

| 键 | 默认值 | 说明 |
|---|---|---|
| `endpoint` | *（必填）* | OTLP **base** URL，如 `http://localhost:4000/v1/otlp`。三个信号各自的 `/v1/{traces,metrics,logs}` 后缀由插件拼接，写成单信号路径会在加载时拒绝。 |
| `database` | `public` | 作为 `X-Greptime-DB-Name` 发送。 |
| `username` / `password` | *（无）* | Basic 认证，要么都填，要么都不填。 |
| `signals` | 三个全开 | `traces`、`metrics`、`logs` 的任意子集。关掉的信号不构造 exporter。 |
| `content` | `none` | 允许多少 payload 离开进程，见 [导出内容](#导出内容)。 |
| `serviceName` | `dsh` | OTel `service.name`。 |
| `logTable` / `traceTable` | GreptimeDB 默认 | 覆盖目标表名。 |
| `shutdownTimeoutMillis` | `3000` | 整个退出流程的截止时间。 |
| `metricIntervalMillis` | `30000` | metric 采集周期，不得小于 `exportTimeoutMillis`。 |
| `maxExportBatchSize` / `maxQueueSize` | `512` / `2048` | 批量与缓冲上限。 |
| `scheduledDelayMillis` / `exportTimeoutMillis` | `5000` / `30000` | 导出节奏与单次请求超时。 |

配置写错会在插件加载时就报错并指明字段，不会拖到第一次导出。

## Traces

turn span 是根，chat 和 tool span 作为它的同级子节点挂在下面，用 `dsh.step` 关联：

```
invoke_agent dsh              turn/start → turn/end
├── chat deepseek-chat        step/start → assistant/message
├── execute_tool bash         tool/call  → tool/result
└── chat deepseek-chat
```

是同级，不是嵌套。DSH 先写 `assistant/message`，之后才执行这条消息请求的工具，所以 tool span 若挂在 chat span 下，起始时间会晚于父节点的结束时间，waterfall 和延迟视图都会失真。

时间戳取自触发它的那个 session 事件，不取处理时刻的时钟。

chat span 有四条闭合路径，每条都有确定的结束时间：

| 情况 | 结束时间 | 状态 |
|---|---|---|
| 模型正常返回 | `assistant/message` | OK |
| 流式过程被中断 | `assistant/message` | OK，加 `dsh.response.interrupted` |
| 请求失败 | 该 step 的 `step/end` | ERROR，并记录异常 |
| 没有结束事件（崩溃、退出） | 最后一个事件的时间 | UNSET，加 `dsh.span.unclosed` |

最后一行只覆盖真正缺失边界的情况。失败的请求是被测量的，不是被打包丢掉。

### Token 口径

DSH 的计数是不相交的。`inputTokens` 只含未命中缓存的输入，缓存读写是独立字段。而 GenAI 规范里的 `gen_ai.usage.input_tokens` 是计费总量，所以插件导出：

```
gen_ai.usage.input_tokens  = inputTokens + cacheReadTokens + cacheWriteTokens
gen_ai.usage.output_tokens = outputTokens          （已含 reasoning tokens）
```

只导出 `inputTokens` 会低估每一个命中缓存的请求，常常差一个数量级。明细仍可查：`dsh.usage.uncached_input_tokens`、`dsh.usage.cache_read_tokens`、`dsh.usage.cache_write_tokens`、`dsh.usage.reasoning_tokens`。

## Metrics

| 指标 | 类型 | 维度 |
|---|---|---|
| `gen_ai.client.token.usage` | Histogram | `gen_ai.token.type`（只有 `input`/`output`）、model、provider |
| `gen_ai.client.operation.duration` | Histogram | `gen_ai.operation.name`、model |
| `dsh.token.detail` | Histogram | `dsh.token.detail_kind`（`cache_read`/`cache_write`/`reasoning`） |
| `dsh.tool.invocations` | Counter | `gen_ai.tool.name`、`dsh.tool.outcome` |
| `dsh.turns` / `dsh.steps` | Counter | |

缓存和推理明细不放进标准 token histogram，这样直接 `SUM()` 不会重复计数。

## Logs

每个 session 事件一条记录。四个属性通过 `X-Greptime-Log-Extract-Keys` 变成真实列：

```sql
SELECT session_id, event_type, turn, step, body
FROM dsh_logs
WHERE session_id = '...' AND event_type = 'tool/result'
ORDER BY timestamp;
```

所有属性用下划线命名是有原因的。GreptimeDB 把未提取的属性放在 JSON 列里，用 `json_get_string()` 读取，而它会把 `session.id` 这种带点的键当成嵌套路径，取不出来。

`assistant/chunk` 永不导出。一个 session 里有几万条 token 增量，而它们承载的事实汇总后的 `assistant/message` 里都有。

## 导出内容

由 `content` 决定，默认不导出任何 payload。

| 模式 | 导出内容 |
|---|---|
| `none`（默认） | 结构和计量：事件类型、turn 和 step 编号、token 数、工具名、耗时、成败、错误的 `name` 和 `code`。 |
| `full` | 增加用户与助手的消息正文、工具参数、工具结果。 |
| `full+prompt` | 增加 `request/header`：完整 system prompt 和全部工具 schema。 |

有两样东西在任何模式下都不会离开进程。工具私有的 `meta` 载荷，设计上就是不透明且任意的。失败 turn 的内部 `error.message`，是可能回显 prompt 的 provider 文本。

投影层是正向白名单。插件不认识的事件类型，包括未来某个 DSH 插件声明的，只导出身份标识。如果用通用的 `event.data` 克隆，这类事件携带的任何内容都会被悄悄带出去。

作为对比，DSH 自带的 `session-telemetry-otel` 默认方向相反：它的 `FULL` 模式发送完整 `event.data`，含 system prompt，且自身不带任何脱敏规则。

## 配合 TMA1

[TMA1](https://github.com/tma1-ai/tma1) 会把 OTLP 反代进它自己管理的 GreptimeDB。把 `endpoint` 指过去，DSH 就出现在 OTel GenAI 视图里：

```yaml
endpoint: http://localhost:14318/v1/otlp
```

TMA1 的 `tma1_token_usage_1m`、`cost_1m`、`latency_1m`、`status_1m` 四张 Flow 表由 `span_attributes.gen_ai.*` 派生，本插件按规范填充这些字段。

## 开发

```sh
pnpm test     # 单测、profile 组装、Loader 启动
pnpm smoke    # 针对新打包 tarball 的打包检查
GREPTIMEDB_OTLP_ENDPOINT=http://localhost:4000/v1/otlp pnpm test   # 追加真实数据库往返
```

四层测试，每层抓的是下面几层抓不到的问题：

| 层次 | 只有它能抓到的 |
|---|---|
| 单测 | span 状态机、token 口径、投影白名单 |
| Profile 组装 | bundle patch 无法解析、无法 parse、组装不出 entry |
| Loader 启动 | 裸包名解析、`!!js` 求值、`inject` 满足、真实 OTLP 字节与 header |
| 真实 GreptimeDB | trace pipeline 接受、提取列生效、SQL 可见的数值 |

## 已知限制

**DSH 处于 pre-release。** 官方声明首个正式版本之前会自由重命名和重组包结构。本插件只读 session 事件流和已文档化的 payload 字段，peer 版本锁定在实际测试过的版本（`0.1.1-rc.2`）。

**GenAI 语义规范仍是 experimental。** 属性名取自 `@opentelemetry/semantic-conventions/incubating`，会随它变动。`gen_ai.system` 不发送，它已被 `gen_ai.provider.name` 取代。

**不做逐 turn flush。** 导出遵循 batch processor 自身的节奏。逐 turn 强制 flush 会成为这条管线唯一的并发 flush 来源，它与关闭时的 drain 交互会丢失尾部记录。

**关闭有时限，但时限无法取消传输。** `shutdownTimeoutMillis` 到期时仍在途的记录可能在进程退出时丢失。另一种选择是无限等待，那会把 CLI 挂死。

**Subagent session 有自己独立的 trace。** 每个 session 的 span 自成一棵树，不会拼接进父 session 的 trace。

## License

Apache-2.0
