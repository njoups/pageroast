-- 0009: analytics engine and executive reporting (Milestone 5).
-- Replaces the placeholder reports / report_sources tables from 0002 (never used by application code).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM reports) OR EXISTS (SELECT 1 FROM report_sources) THEN
    RAISE EXCEPTION '0009: reports/report_sources contain data; migrate it manually before applying';
  END IF;
END $$;
DROP TABLE report_sources;
DROP TABLE reports;

-- ── Analytics aggregates ───────────────────────────────────────────────────────────────────────────
-- Summable counts per hour and dimension. Distinct counts (publishers, entities) are computed from base tables with
-- indexed queries and cached, because distinct values cannot be summed across buckets.
CREATE TABLE analytics_hourly (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  hour timestamptz NOT NULL,                       -- UTC hour of coalesce(published_at, discovered_at)
  source_id uuid NOT NULL,
  language text NOT NULL,                          -- detected language, else feed-declared, else 'und'
  sentiment text NOT NULL CHECK (sentiment IN ('positive','negative','neutral','mixed','unknown','unanalysed')),
  uncertain boolean NOT NULL,
  articles integer NOT NULL,                       -- original records
  records integer NOT NULL,                        -- all collected records, duplicates included
  PRIMARY KEY (tenant_id, project_id, hour, source_id, language, sentiment, uncertain),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX analytics_hourly_time_idx ON analytics_hourly (tenant_id, hour);

-- Data version per tenant: bumped whenever aggregates change, so cached analytics are never served for older data.
CREATE TABLE analytics_state (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  data_version bigint NOT NULL DEFAULT 0,
  watermark_discovered timestamptz,                -- newest discovered_at already aggregated
  watermark_analysed timestamptz,                  -- newest analysis finish already aggregated
  watermark_matched timestamptz,                   -- newest project match already aggregated
  refreshed_at timestamptz,
  last_refresh_hours integer NOT NULL DEFAULT 0,
  full_rebuild_at timestamptz                      -- daily full rebuild catches removed matches and deletions
);

CREATE TABLE analytics_cache (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  cache_key text NOT NULL,                         -- sha256 of (metric, normalized params, viewer scope)
  metric text NOT NULL,
  data_version bigint NOT NULL,
  payload jsonb NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, cache_key)
);
CREATE INDEX analytics_cache_expiry_idx ON analytics_cache (expires_at);

-- Indexes for period queries over the analytics time column and current-analysis joins.
CREATE INDEX mentions_analytics_time_idx ON mentions (tenant_id, (coalesce(published_at, discovered_at)));
CREATE INDEX mention_entities_analysis_idx ON mention_entities (tenant_id, analysis_id, entity_id);
CREATE INDEX mention_topics_analysis_idx ON mention_topics (tenant_id, analysis_id, topic_key);
CREATE INDEX mention_analyses_finished_idx ON mention_analyses (tenant_id, finished_at);
CREATE INDEX mention_matches_time_idx ON mention_matches (tenant_id, matched_at);

-- ── Reports ─────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE report_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  template text NOT NULL CHECK (template IN ('daily_briefing','weekly_intelligence','monthly_performance','issue_report','policy_monitoring')),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,       -- validated server-side (reports/report-config.ts)
  language text NOT NULL DEFAULT 'id' CHECK (language IN ('id','en')),
  ai_commentary boolean NOT NULL DEFAULT false,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE report_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly','custom')),
  time_of_day text NOT NULL CHECK (time_of_day ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  day_of_week integer CHECK (day_of_week BETWEEN 1 AND 7),     -- ISO: 1 = Monday (weekly)
  day_of_month integer CHECK (day_of_month BETWEEN 1 AND 28),  -- monthly
  period_days integer CHECK (period_days BETWEEN 1 AND 92),   -- custom: report covers the last N days, runs every N days
  timezone text NOT NULL,
  recipient_user_ids uuid[] NOT NULL DEFAULT '{}',
  channels text[] NOT NULL DEFAULT '{in_app}',
  is_active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  UNIQUE (id, tenant_id),
  FOREIGN KEY (definition_id, tenant_id) REFERENCES report_definitions (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX report_schedules_due_idx ON report_schedules (next_run_at) WHERE is_active;

CREATE TABLE report_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  schedule_id uuid,
  template text NOT NULL,
  template_version text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  timezone text NOT NULL,
  idempotency_key text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('manual','schedule')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  attempts integer NOT NULL DEFAULT 0,
  error text,
  model jsonb,                                     -- rendered report content (sections, metrics, claims) for preview and audit
  metrics jsonb,                                   -- deterministic metrics snapshot
  freshness jsonb,
  limitations text[] NOT NULL DEFAULT '{}',
  ai_method text,                                  -- llm | none | unavailable
  ai_tokens_in integer NOT NULL DEFAULT 0,
  ai_tokens_out integer NOT NULL DEFAULT 0,
  queued_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  heartbeat_at timestamptz,
  finished_at timestamptz,
  CHECK (period_end > period_start),
  UNIQUE (tenant_id, idempotency_key),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (definition_id, tenant_id) REFERENCES report_definitions (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (schedule_id, tenant_id) REFERENCES report_schedules (id, tenant_id) ON DELETE SET NULL (schedule_id)
);
CREATE INDEX report_runs_list_idx ON report_runs (tenant_id, definition_id, queued_at DESC);
CREATE INDEX report_runs_status_idx ON report_runs (status, queued_at);

CREATE TABLE report_run_sources (                 -- every record a report cites, per section
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  section text NOT NULL,
  PRIMARY KEY (run_id, mention_id, section),
  FOREIGN KEY (run_id, tenant_id) REFERENCES report_runs (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE report_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  format text NOT NULL CHECK (format IN ('pdf','csv')),
  filename text NOT NULL CHECK (filename ~ '^[a-z0-9._-]{1,120}$'),
  content_type text NOT NULL,
  size_bytes integer NOT NULL,
  sha256 text NOT NULL,
  data bytea,                                      -- NULL once expired (metadata kept for history)
  row_count integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  expired_at timestamptz,
  UNIQUE (run_id, format),
  FOREIGN KEY (run_id, tenant_id) REFERENCES report_runs (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX report_artifacts_expiry_idx ON report_artifacts (expires_at) WHERE data IS NOT NULL;

CREATE TABLE report_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app','email')),
  kind text NOT NULL CHECK (kind IN ('ready','failed')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','unconfigured','suppressed')),
  error text,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (run_id, user_id, channel, kind),
  FOREIGN KEY (run_id, tenant_id) REFERENCES report_runs (id, tenant_id) ON DELETE CASCADE
);

-- ── RLS and grants ─────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['analytics_hourly','analytics_state','analytics_cache','report_definitions','report_schedules','report_runs',
                           'report_run_sources','report_artifacts','report_deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO civicsignal_app', t);
  END LOOP;
END $$;
-- Worker scheduling (system context, read-only): due schedules, stuck runs, expiring artifacts, tenants needing aggregation.
CREATE POLICY system_scan ON report_schedules FOR SELECT USING (app_is_system());
CREATE POLICY system_scan ON report_runs FOR SELECT USING (app_is_system());
CREATE POLICY system_scan ON report_artifacts FOR SELECT USING (app_is_system());
CREATE POLICY system_scan ON analytics_state FOR SELECT USING (app_is_system());
-- Cited sources are history; runs are never deleted by the application (only cancelled/expired).
REVOKE UPDATE, DELETE ON report_run_sources FROM civicsignal_app;
REVOKE DELETE ON report_runs FROM civicsignal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO civicsignal_app;
