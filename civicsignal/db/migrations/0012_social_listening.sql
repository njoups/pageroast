-- 0012: authorized social listening (Prompt 07). Social connectors are sources + connectors of a social kind; their
-- records are mentions with platform fields. This migration adds the platform fields, provider rights and approvals,
-- per-provider usage and quota accounting, budgets, pricing metadata and the provider-lifecycle ledger.

-- ── Connector kinds ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE connectors DROP CONSTRAINT connectors_kind_check;
ALTER TABLE connectors ADD CONSTRAINT connectors_kind_check CHECK (kind IN ('feed', 'gdelt', 'youtube'));

-- Provider rights snapshot (copied from the connector's descriptor at creation, see docs/SOCIAL_CONNECTORS.md) and the
-- operator's recorded approval for derived analysis where the provider requires one (YouTube: Developer Policies
-- III.E.4.h and the derived-metrics amendment). Quota pause state lives here so every worker sees it.
ALTER TABLE connectors
  ADD COLUMN rights jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN derived_analysis_approved_at timestamptz,
  ADD COLUMN derived_analysis_approved_by uuid REFERENCES users(id),
  ADD COLUMN derived_analysis_reference text CHECK (length(derived_analysis_reference) <= 500),
  ADD COLUMN paused_until timestamptz,
  ADD COLUMN paused_reason text CHECK (paused_reason IN ('provider_quota', 'budget_soft_limit', 'budget_hard_limit'));

-- ── Social fields on mentions (null for news records) ─────────────────────────────────────────────
ALTER TABLE mentions
  ADD COLUMN platform text CHECK (platform ~ '^[a-z][a-z0-9_]{1,30}$'),
  ADD COLUMN content_type text CHECK (content_type IN ('article', 'video', 'short_video', 'live_stream', 'post', 'comment')),
  ADD COLUMN external_id text CHECK (length(external_id) <= 200),             -- provider content id (for refresh and deletion)
  ADD COLUMN parent_external_id text CHECK (length(parent_external_id) <= 200), -- e.g. the video a comment belongs to
  ADD COLUMN author_ref text CHECK (length(author_ref) <= 200),               -- provider account/channel id, only when permitted
  ADD COLUMN hashtags text[] NOT NULL DEFAULT '{}',
  ADD COLUMN engagement jsonb NOT NULL DEFAULT '{}'::jsonb,                  -- only metrics the provider returned, by provider name
  ADD COLUMN engagement_observed_at timestamptz,
  ADD COLUMN refresh_due_at timestamptz,                                    -- provider requires refresh by then
  ADD COLUMN provider_delete_by timestamptz,                                 -- provider requires deletion by then unless refreshed
  ADD CONSTRAINT mentions_social_ids CHECK ((platform IS NULL) = (external_id IS NULL));
CREATE UNIQUE INDEX mentions_platform_external_uidx ON mentions (tenant_id, platform, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX mentions_refresh_due_idx ON mentions (tenant_id, refresh_due_at) WHERE refresh_due_at IS NOT NULL;
CREATE INDEX mentions_provider_delete_idx ON mentions (tenant_id, provider_delete_by) WHERE provider_delete_by IS NOT NULL;
CREATE INDEX mentions_hashtags_idx ON mentions USING gin (hashtags) WHERE platform IS NOT NULL;

-- Derived analysis records which kind of record it was computed from, so news-article and social-post results are
-- never combined without saying so.
ALTER TABLE mention_analyses
  ADD COLUMN source_category text CHECK (source_category IN ('news', 'social')),
  ADD COLUMN platform text,
  ADD COLUMN content_type text;
ALTER TABLE mention_analyses DROP CONSTRAINT mention_analyses_content_status_check;
ALTER TABLE mention_analyses ADD CONSTRAINT mention_analyses_content_status_check
  CHECK (content_status IN ('ok', 'headline_only', 'insufficient', 'unsupported_language', 'empty', 'short_text', 'not_permitted'));

-- ── Provider usage and quota accounting (one row per connector, provider day and quota bucket) ────
-- `day` is the provider's quota day (YouTube: midnight America/Los_Angeles), not the tenant's local day.
CREATE TABLE provider_usage (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  provider text NOT NULL,
  day date NOT NULL,
  bucket text NOT NULL CHECK (bucket ~ '^[a-z_]{2,40}$'),
  requests integer NOT NULL DEFAULT 0 CHECK (requests >= 0),
  units numeric NOT NULL DEFAULT 0 CHECK (units >= 0),
  records_retrieved integer NOT NULL DEFAULT 0 CHECK (records_retrieved >= 0),
  records_rejected integer NOT NULL DEFAULT 0 CHECK (records_rejected >= 0),
  rate_limited integer NOT NULL DEFAULT 0 CHECK (rate_limited >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (connector_id, day, bucket)
);
CREATE INDEX provider_usage_tenant_idx ON provider_usage (tenant_id, day);

-- Configurable pricing metadata (platform-wide reference data, maintained by operators). Never hardcoded in code:
-- every row carries where the price came from and when it was verified. No row → cost estimate is "not priced".
CREATE TABLE provider_pricing (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  item text NOT NULL CHECK (item ~ '^[a-z_]{2,60}$'),        -- what is charged, e.g. post_read
  unit_price numeric NOT NULL CHECK (unit_price >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_url text NOT NULL,
  verified_at date NOT NULL,
  notes text,
  UNIQUE (provider, item)
);

-- Per-tenant budgets. Levels: warn → notice; soft → scheduled syncs pause (manual syncs still allowed);
-- hard → all syncs stop until the period resets. connector_id NULL = all social connectors of the tenant.
CREATE TABLE social_budgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric IN ('quota_units', 'requests', 'records_retrieved', 'estimated_cost')),
  period text NOT NULL CHECK (period IN ('day', 'month')),
  warn_at numeric CHECK (warn_at > 0),
  soft_limit numeric CHECK (soft_limit > 0),
  hard_limit numeric CHECK (hard_limit > 0),
  updated_by uuid REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (warn_at IS NOT NULL OR soft_limit IS NOT NULL OR hard_limit IS NOT NULL),
  CHECK (soft_limit IS NULL OR hard_limit IS NULL OR soft_limit <= hard_limit),
  CHECK (warn_at IS NULL OR soft_limit IS NULL OR warn_at <= soft_limit)
);
CREATE UNIQUE INDEX social_budgets_scope_uidx ON social_budgets (tenant_id, coalesce(connector_id, '00000000-0000-0000-0000-000000000000'::uuid), metric, period);

-- Budget and quota notices (shown in the social workspace; one per budget, level and period).
CREATE TABLE social_budget_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE CASCADE,
  budget_id uuid REFERENCES social_budgets(id) ON DELETE SET NULL,
  level text NOT NULL CHECK (level IN ('warn', 'soft', 'hard', 'provider_quota')),
  metric text NOT NULL,
  period_key text NOT NULL,                                 -- e.g. 2026-10-20 or 2026-10
  value numeric NOT NULL,
  threshold numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid REFERENCES users(id)
);
CREATE UNIQUE INDEX social_budget_events_once_uidx ON social_budget_events (tenant_id, coalesce(budget_id, connector_id), level, period_key);

-- Provider-lifecycle ledger: refresh and deletion obligations (refresh-or-delete windows, records gone at the provider).
CREATE TABLE provider_lifecycle_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_id uuid REFERENCES connectors(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  checked integer NOT NULL DEFAULT 0,
  refreshed integer NOT NULL DEFAULT 0,
  removed_at_provider integer NOT NULL DEFAULT 0,          -- deleted or made private at the provider → purged here
  expired integer NOT NULL DEFAULT 0,                      -- refresh window passed without a refresh → purged
  blocked_by_legal_hold integer NOT NULL DEFAULT 0,        -- obligation due but a legal hold prevents deletion
  refresh_error jsonb
);
CREATE INDEX provider_lifecycle_runs_idx ON provider_lifecycle_runs (tenant_id, started_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['provider_usage', 'social_budgets', 'social_budget_events', 'provider_lifecycle_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO civicsignal_app', t);
  END LOOP;
END $$;
GRANT DELETE ON social_budgets TO civicsignal_app;
REVOKE UPDATE ON provider_lifecycle_runs FROM civicsignal_app;
GRANT UPDATE (finished_at, checked, refreshed, removed_at_provider, expired, blocked_by_legal_hold, refresh_error) ON provider_lifecycle_runs TO civicsignal_app;

ALTER TABLE provider_pricing ENABLE ROW LEVEL SECURITY; ALTER TABLE provider_pricing FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_read ON provider_pricing FOR SELECT USING (true);
GRANT SELECT ON provider_pricing TO civicsignal_app;      -- read-only for the app; operators maintain it as owner
