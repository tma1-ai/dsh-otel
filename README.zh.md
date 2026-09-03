# @tma1-ai/dsh-plugin-greptimedb

[![npm](https://img.shields.io/npm/v/@tma1-ai/dsh-plugin-greptimedb.svg)](https://www.npmjs.com/package/@tma1-ai/dsh-plugin-greptimedb)
[![CI](https://github.com/tma1-ai/dsh-otel/actions/workflows/ci.yml/badge.svg)](https://github.com/tma1-ai/dsh-otel/actions/workflows/ci.yml)
[![node](https://img.shields.io/node/v/@tma1-ai/dsh-plugin-greptimedb.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@tma1-ai/dsh-plugin-greptimedb.svg)](LICENSE)

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 跑一次花了多少 token、多少钱、多少时间，以 OpenTelemetry traces、metrics、logs 写进 [GreptimeDB](https://github.com/GreptimeTeam/greptimedb)。

七个 Grafana dashboard 直接读这些数据。不需要 collector，不需要 sidecar，不用 fork DSH。它就是个普通插件，装上之后每一次 turn、模型调用和工具执行都变成一行可查的数据：

```sql
-- 最慢的工具调用，以及是哪个模型发起的。
SELECT span_name, model, duration_nano / 1000000 AS ms
FROM (
  SELECT span_name, duration_nano,
         MAX("span_attributes.gen_ai.request.model")
           OVER (PARTITION BY trace_id, "span_attributes.dsh.step") AS model
  FROM opentelemetry_traces
  WHERE "span_attributes.dsh.step" IS NOT NULL
)
WHERE span_name LIKE 'execute_tool%'
ORDER BY duration_nano DESC
LIMIT 10;
```

![Overview](https://raw.githubusercontent.com/tma1-ai/dsh-otel/main/grafana/screenshots/overview.png)

## 快速开始

需要 pnpm 10 或更高版本。`dsh plugin` 会转发给 PATH 上的 `pnpm`，而 dsh 的 profile 目录本身就是一个 pnpm workspace root，pnpm 9 会拒绝在那里安装，也会忽略 dsh 写下的 linker 设置。

**启动数据库和 Grafana。**[`grafana/`](grafana/) 下的 compose 栈会启动 GreptimeDB，并配好七个 [dashboard](#dashboard)。Grafana 的 provisioning 要从磁盘读这些 dashboard，因此只需获取该目录，无需 clone 整个仓库：

```sh
curl -fsSL https://github.com/tma1-ai/dsh-otel/archive/main.tar.gz \
  | tar -xz --strip-components=1 dsh-otel-main/grafana
cd grafana && docker compose up -d
```

**安装插件。**默认配置已指向上述数据库，无需额外配置：

```sh
dsh plugin --profile web add @tma1-ai/dsh-plugin-greptimedb
```

包自带 bundle patch，这一条命令就把它接进 profile。

**运行并查看数据。**trace 和 log 在 `scheduledDelayMillis`（默认 5 秒）内写入，metric 在下一个采集周期（默认 30 秒）写入。DSH 空闲时不产生数据，需先执行一次任务：

```sh
dsh web
```

Grafana 地址为 <http://localhost:3000>，已启用匿名 admin 访问，无需登录。建议从 Overview 开始。

如果只需要数据库，GreptimeDB 自带的控制台在 <http://localhost:4000/dashboard/>，看表和跑临时 SQL 够用：

```sh
docker run -p 127.0.0.1:4000-4003:4000-4003 \
  -v "$(pwd)/greptimedb_data:/greptimedb_data" \
  --name greptime --rm greptime/greptimedb:v1.2.0-beta.2 standalone start \
  --http-addr 0.0.0.0:4000 --rpc-bind-addr 0.0.0.0:4001 \
  --mysql-addr 0.0.0.0:4002 --postgres-addr 0.0.0.0:4003
```

两者都占 4000 端口，起一个就行。

## 版本兼容

DSH 的包 API 在预发布版之间会变，因此每个插件版本对应一个 DSH 版本：

| 插件 | DSH |
|---|---|
| `0.1.0-beta.5` | `0.1.2-alpha.5` |
| `0.1.0-beta.4` 及更早 | `0.1.1-rc.2` |

`dsh plugin add` 装的是最新版。DSH 版本较旧时指定版本号即可，参数会原样转给 `pnpm add`：

```sh
dsh plugin --profile web add @tma1-ai/dsh-plugin-greptimedb@0.1.0-beta.4
```

版本不匹配不会导致加载失败。插件照常挂载，然后逐条丢弃记录并打出 `greptimedb-otel: dropped a telemetry record` 告警，表里始终没有数据。

## 配置

要指向自己的数据库，在 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 里覆盖这一行：

```yaml
- id: greptimedb-otel
  name: '@tma1-ai/dsh-plugin-greptimedb'
  config:
    endpoint: https://<host>/v1/otlp
    database: <dbname>
    username: <user>
    password: <password>
```

profile patch 是整体替换目标行的 `config`，不是深合并，所以要保留的字段必须全部重述。

| 键 | 默认值 | 说明 |
|---|---|---|
| `endpoint` | *（必填）* | OTLP **base** URL，如 `http://localhost:4000/v1/otlp`。三个信号各自的 `/v1/{traces,metrics,logs}` 后缀由插件拼接，写成单信号路径会在加载时拒绝。 |
| `database` | `public` | 作为 `X-Greptime-DB-Name` 发送。 |
| `username` / `password` | *（无）* | Basic 认证，要么都填，要么都不填。 |
| `signals` | 三个全开 | `traces`、`metrics`、`logs` 的任意子集。关掉的信号不构造 exporter。 |
| `content` | `none` | 允许多少 payload 离开进程，见 [导出内容](#导出内容)。 |
| `serviceName` | `dsh` | OTel `service.name`。 |
| `logTable` / `traceTable` | GreptimeDB 默认 | 覆盖目标表名。 |
| `ttl` | `180d` | 本插件建 log 和 trace 表时的保留期，通过 `x-greptime-hints` 发送，也接受 `forever`。GreptimeDB 只在自动建表时应用，已存在的表保持原设置，除非 `ALTER TABLE`。metric 表不在覆盖范围内，见[已知限制](#已知限制)。留空则不发这个 hint，沿用数据库默认值。 |
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

时间戳取自触发它的那个 session 事件，不取处理时刻的时钟。

chat span 有四条闭合路径，每条都有确定的结束时间：

| 情况 | 结束时间 | 状态 |
|---|---|---|
| 模型正常返回 | `assistant/message` | OK |
| 流式过程被中断 | `assistant/message` | OK，加 `dsh.response.interrupted` |
| 请求失败 | 该 step 的 `step/end` | ERROR，带错误类型 |
| 没有结束事件（崩溃、退出） | 最后一个事件的时间 | UNSET，加 `dsh.span.unclosed` |

### Token 口径

DSH 的计数是不相交的：`inputTokens` 只含未命中缓存的输入，缓存读写是独立字段。而 `gen_ai.usage.input_tokens` 是计费总量，所以插件导出：

```
gen_ai.usage.input_tokens  = inputTokens + cacheReadTokens + cacheWriteTokens
gen_ai.usage.output_tokens = outputTokens          （已含 reasoning tokens）
```

明细仍可查：`dsh.usage.uncached_input_tokens`、`dsh.usage.cache_read_tokens`、`dsh.usage.cache_write_tokens`、`dsh.usage.reasoning_tokens`。

## Metrics

| 指标 | 类型 | 维度 |
|---|---|---|
| `gen_ai.client.token.usage` | Histogram | `gen_ai.token.type`（只有 `input`/`output`）、model、provider |
| `gen_ai.client.operation.duration` | Histogram | `gen_ai.operation.name`、model、provider |
| `gen_ai.invoke_agent.duration` | Histogram | `gen_ai.operation.name` |
| `gen_ai.execute_tool.duration` | Histogram | `gen_ai.operation.name`、`gen_ai.tool.name` |
| `dsh.token.detail` | Histogram | `dsh.token.detail_kind`（`cache_read`/`cache_write`/`reasoning`）、model、provider |
| `dsh.tool.invocations` | Counter | `gen_ai.tool.name`、`dsh.tool.outcome` |
| `dsh.turns` / `dsh.steps` | Counter | |

## Logs

每个 session 事件一条记录。四个属性通过 `X-Greptime-Log-Extract-Keys` 变成真实列：

```sql
SELECT session_id, event_type, turn, step, body
FROM dsh_logs
WHERE session_id = '...' AND event_type = 'tool/result'
ORDER BY timestamp;
```

`assistant/chunk` 永不导出，同样的内容在汇总后的 `assistant/message` 里。

## 导出内容

由 `content` 决定，默认不导出任何 payload。

| 模式 | 导出内容 |
|---|---|
| `none`（默认） | 结构和计量：事件类型、turn 和 step 编号、token 数、工具名、耗时、成败、错误的 `name` 和 `code`。 |
| `full` | 增加用户与助手的消息正文、工具参数、工具结果。 |
| `full+prompt` | 增加 `request/header`：完整 system prompt 和全部工具 schema。 |

有三样东西在任何模式下都不离开进程：工具私有的 `meta` 载荷、失败 turn 的内部 `error.message`，以及请求失败时的异常消息和堆栈。

投影层是正向白名单。插件不认识的事件类型只导出身份标识，未来某个 DSH 插件声明的新类型也一样。

## Dashboard

[`grafana/`](grafana/) 下有七个 Grafana dashboard，[快速开始](#快速开始)里的 compose 栈会把它们全部配好。

![Cost](https://raw.githubusercontent.com/tma1-ai/dsh-otel/main/grafana/screenshots/cost.png)

![Trace explorer](https://raw.githubusercontent.com/tma1-ai/dsh-otel/main/grafana/screenshots/trace-explorer.png)

| Dashboard | 回答什么问题 |
|---|---|
| Overview | 用了多少 token、多快、多少来自缓存 |
| Cost | 花了多少钱、钱花在哪一档、账单为什么在涨 |
| Sessions | 一次对话跑了多久、用了几个 turn、在哪里失败 |
| Agent loop | 哪些工具在跑、失败率多少、一个 turn 用了几次模型调用、时间花在哪 |
| Trace explorer | 某一个 turn 内部到底发生了什么，逐 span 看 |
| Log explorer | 全部 session 事件，可按 session、类型和全文检索过滤 |
| Metrics | 同样的活动，通过 PromQL 读取，用于更长保留期和不受采样影响的分位数 |

Cost 用 dashboard 自己的四个变量给 token 计价，按每百万 token 计：未命中缓存的输入、缓存读、缓存写、输出。默认值是 DeepSeek 公布的 `deepseek-v4-flash` 高峰价（人民币）：`3.0`、`0.10`、`3.0`、`9.0`。同一组费率的美元值是 `0.44`、`0.014`、`0.44`、`1.32`。

Currency 只切换各面板的货币符号，不换算费率，所以切过去要顺手把四个数字改掉。它的取值是 Grafana 的单位串，`currencyUSD` 和 `prefix:¥`；要加别的货币，就在这个变量上多加一个选项。

一套费率作用于选中的全部模型，所以同时跑不同价位的模型时，用 Model 过滤器逐个看。算出来是估算，你的合同价和 provider 的时段折扣它都不知道。

每个表格都能继续下钻：trace id 打开该 turn 的 waterfall，session id 在 trace 和 log 视图之间跳转。每个 panel 的查询都由 `node grafana/verify.mjs` 对着真实数据库验证过。数据源的分工见 [grafana/README.md](grafana/README.md)，这些查询需要的索引见 [grafana/indexes.sql](grafana/indexes.sql)。

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

## 已知限制

- **DSH 处于 pre-release**，首个正式版本前会自由重命名和重组包结构。插件只用它的类型，所以不声明 peer 版本：DSH 每个版本都是预发布版，而 semver 不匹配 range 里没写明的预发布版，锁哪个 range 都会在下一个预发布版上失效。代价是 DSH 的重命名不会在安装时暴露，只能由 CI 发现；CI 运行的版本见[版本兼容](#版本兼容)。
- **发布出去的 `.d.ts` 会 import DSH 的类型。** 在没有 DSH 的环境中对本包做类型检查，需启用 `skipLibCheck`，或同时安装对应的 DSH 包。
- **GenAI 语义规范仍是 experimental。** 名字取自 `@opentelemetry/semantic-conventions/incubating`，会随它变动。span 同时带 `gen_ai.provider.name` 和已废弃的 `gen_ai.system`。
- **`ttl` 覆盖不到 metric 表。** metric 走 metric engine，保留期是 physical table 的属性。hint 只到得了逻辑表，逻辑表会存下并显示它，但不会执行（[greptimedb#8951](https://github.com/GreptimeTeam/greptimedb/issues/8951)）。请自行 `ALTER TABLE greptime_physical_table SET 'ttl' = '180d'`。
- **不做逐 turn flush。** 导出遵循 batch processor 自身节奏。
- **关闭有时限。** `shutdownTimeoutMillis` 到期时仍在途的记录可能在退出时丢失。
- **Subagent session 有独立 trace**，不拼接进父 session。

## License

Apache-2.0
