-- 0011: indexes found missing by the load test (docs/LOAD_TESTING.md).
-- Mention search and detail look up the current analysis's sentiment by analysis_id; without this index every listed
-- row ran a sequential scan of sentiment_results. tenant_id leads so the RLS predicate and the lookup share the index.
-- Plain CREATE INDEX (migrations run in a transaction): it blocks writes to sentiment_results while it builds, which on
-- a large table should be scheduled in a maintenance window or pre-built with CREATE INDEX CONCURRENTLY under this name.
CREATE INDEX IF NOT EXISTS sentiment_results_analysis_idx ON sentiment_results (tenant_id, analysis_id, target_type);
