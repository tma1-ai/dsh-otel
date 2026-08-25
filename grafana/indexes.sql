-- Indexes for the columns these dashboards filter on.
--
-- GreptimeDB creates both tables on first write. What it creates is already
-- reasonable: the trace table gets `service_name` (low cardinality) as its
-- primary key, skipping indexes on `trace_id` and `parent_span_id`, and
-- append-only mode. What it cannot know is which *attribute* columns you will
-- filter on, so those arrive unindexed.
--
-- Index type follows the cardinality of the column, per GreptimeDB's table
-- design guide: an inverted index for low-cardinality equality and range
-- filters, a skipping index for point lookups on high-cardinality columns.
--
-- Run this after the first writes have created the columns. A column that does
-- not exist yet cannot be altered, and an attribute only becomes a column once
-- something has written it.
--
--   mysql -h 127.0.0.1 -P 4002 public < grafana/indexes.sql
--
-- Adding an index only affects SST files flushed afterwards; existing files
-- keep their current indexes until compaction rewrites them.

-- Low cardinality: a handful of distinct values, filtered on constantly.
ALTER TABLE opentelemetry_traces MODIFY COLUMN span_name SET INVERTED INDEX;
ALTER TABLE opentelemetry_traces MODIFY COLUMN "span_attributes.gen_ai.system" SET INVERTED INDEX;
ALTER TABLE opentelemetry_traces MODIFY COLUMN "span_attributes.gen_ai.provider.name" SET INVERTED INDEX;
ALTER TABLE opentelemetry_traces MODIFY COLUMN "span_attributes.gen_ai.request.model" SET INVERTED INDEX;
ALTER TABLE opentelemetry_traces MODIFY COLUMN "span_attributes.gen_ai.tool.name" SET INVERTED INDEX;
ALTER TABLE opentelemetry_traces MODIFY COLUMN "span_attributes.dsh.tool.outcome" SET INVERTED INDEX;
ALTER TABLE opentelemetry_traces MODIFY COLUMN "span_attributes.dsh.turn.end_reason" SET INVERTED INDEX;

-- High cardinality: one value per session or per tool call. A skipping index
-- costs far less than adding these to the primary key and targets the same
-- equality filters.
ALTER TABLE opentelemetry_traces MODIFY COLUMN "span_attributes.dsh.session.id"
  SET SKIPPING INDEX WITH(granularity = 10240, type = 'BLOOM');
ALTER TABLE opentelemetry_traces MODIFY COLUMN "span_attributes.gen_ai.tool.call.id"
  SET SKIPPING INDEX WITH(granularity = 10240, type = 'BLOOM');

-- The log table needs no ALTER for its filter columns.
--
-- `X-Greptime-Log-Extract-Keys` promotes an attribute to a top-level column
-- *as a tag*, which puts it in the primary key. That is why `session_id` ends
-- up in the primary key of `dsh_logs` even though its cardinality argues for a
-- skipping index instead: the extract-keys mechanism has no way to express
-- "column, but not a tag". Pre-creating the table does not help — OTLP log
-- ingestion rejects the write outright if an extracted key is not a tag
-- (`column session_id has semantic type Field, given: TAG(0)`).
--
-- Escaping that requires a custom pipeline, whose `transform` block can set a
-- field's index without making it a tag. Until then the primary key ordering
-- is what serves session filtering, which is adequate at the volumes a single
-- agent produces.
