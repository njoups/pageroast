-- 0007: AI intelligence (Milestone 3). Extends the analysis tables created (unused) in 0002 and adds the AI pipeline,
-- entity registry, summaries, clustering history, usage and pricing. All analysis tables are empty before this migration.

-- ── Global reference data (no tenant content) ──────────────────────────────────────────────────────
CREATE TABLE ai_prompt_versions (
  id text PRIMARY KEY,                       -- e.g. 'article-analysis@1'
  task text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  sha256 text NOT NULL,                      -- hash of the exact template text; detects silent edits
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (task, version)
);

CREATE TABLE ai_pricing (
  provider text NOT NULL,
  model text NOT NULL,
  input_per_mtok numeric(12,6) NOT NULL CHECK (input_per_mtok >= 0),
  output_per_mtok numeric(12,6) NOT NULL CHECK (output_per_mtok >= 0),
  cache_read_per_mtok numeric(12,6) CHECK (cache_read_per_mtok >= 0),
  currency text NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  source text NOT NULL,                      -- where the operator took the price from
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, model)
);

-- ── Per-tenant settings and quotas ───────────────────────────────────────────────────────────────
CREATE TABLE ai_tenant_settings (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  auto_analyze boolean NOT NULL DEFAULT true,
  daily_mention_limit integer NOT NULL DEFAULT 500 CHECK (daily_mention_limit > 0),
  monthly_token_limit bigint NOT NULL DEFAULT 2000000 CHECK (monthly_token_limit > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ── Processing ledger: one row per analysis attempt-set of a mention ───────────────────────────────
CREATE TABLE mention_analyses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('ingestion','manual','backfill','reprocess')),
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','retrying','succeeded','partial','failed','skipped','quota_exceeded')),
  provider text, model text, method text,          -- method: 'llm' | 'baseline'
  pipeline_version text NOT NULL,
  prompt_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  language text, language_confidence numeric(4,3), language_method text,
  content_status text CHECK (content_status IN ('ok','headline_only','insufficient','unsupported_language','empty')),
  stages jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb,
  attempt integer NOT NULL DEFAULT 0,
  tokens_in integer NOT NULL DEFAULT 0, tokens_out integer NOT NULL DEFAULT 0, tokens_cache_read integer NOT NULL DEFAULT 0,
  cost_estimate numeric(14,6), cost_currency text,
  is_current boolean NOT NULL DEFAULT false,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  queued_at timestamptz NOT NULL DEFAULT now(), started_at timestamptz, finished_at timestamptz,
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, mention_id, idempotency_key),
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX mention_analyses_current_idx ON mention_analyses (mention_id) WHERE is_current;
CREATE INDEX mention_analyses_status_idx ON mention_analyses (tenant_id, status, queued_at DESC);

ALTER TABLE mentions DROP CONSTRAINT mentions_processing_status_check;
ALTER TABLE mentions
  ADD CONSTRAINT mentions_processing_status_check
    CHECK (processing_status IN ('pending','queued','running','analyzed','partial','failed','skipped','quota_exceeded')),
  ADD COLUMN detected_language text,
  ADD COLUMN language_confidence numeric(4,3),
  ADD COLUMN language_method text,
  ADD COLUMN analysis_id uuid,
  ADD COLUMN analyzed_at timestamptz;

-- ── Entity registry ───────────────────────────────────────────────────────────────────────────────
CREATE TABLE entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('organization','government_institution','public_figure','location','product_brand','event','policy_program','other')),
  display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 200),
  normalized_name text NOT NULL,
  origin text NOT NULL DEFAULT 'automated' CHECK (origin IN ('automated','analyst')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, entity_type, normalized_name)
);
CREATE TABLE entity_aliases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  entity_id uuid NOT NULL,
  entity_type text NOT NULL,
  alias text NOT NULL CHECK (char_length(alias) BETWEEN 1 AND 200),
  normalized_alias text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,  -- NULL = recorded automatically
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, entity_type, normalized_alias),
  FOREIGN KEY (entity_id, tenant_id) REFERENCES entities (id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE mention_entities DROP CONSTRAINT mention_entities_entity_type_check;
ALTER TABLE mention_entities
  ADD CONSTRAINT mention_entities_entity_type_check
    CHECK (entity_type IN ('organization','government_institution','public_figure','location','product_brand','event','policy_program','other')),
  ADD COLUMN entity_id uuid,
  ADD COLUMN normalized_name text,
  ADD COLUMN evidence_text text,
  ADD COLUMN evidence_start integer,
  ADD COLUMN evidence_end integer,
  ADD COLUMN method text,
  ADD COLUMN prompt_version text,
  ADD COLUMN analysis_id uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT mention_entities_entity_fk FOREIGN KEY (entity_id, tenant_id) REFERENCES entities (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT mention_entities_analysis_fk FOREIGN KEY (analysis_id, tenant_id) REFERENCES mention_analyses (id, tenant_id) ON DELETE CASCADE;
CREATE INDEX mention_entities_mention_idx ON mention_entities (tenant_id, mention_id);
CREATE INDEX mention_entities_entity_idx ON mention_entities (tenant_id, entity_id);

-- ── Topics ────────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE project_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  key text NOT NULL CHECK (key ~ '^custom:[a-z0-9_]{2,40}$'),
  label text NOT NULL CHECK (char_length(label) BETWEEN 2 AND 80),
  description text CHECK (char_length(description) <= 500),
  keywords text[] NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (project_id, key),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

ALTER TABLE mention_topics RENAME COLUMN topic TO topic_key;
ALTER TABLE mention_topics
  ADD COLUMN project_topic_id uuid,
  ADD COLUMN taxonomy_version text,
  ADD COLUMN evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN method text,
  ADD COLUMN analysis_id uuid,
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD CONSTRAINT mention_topics_project_topic_fk FOREIGN KEY (project_topic_id, tenant_id) REFERENCES project_topics (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT mention_topics_analysis_fk FOREIGN KEY (analysis_id, tenant_id) REFERENCES mention_analyses (id, tenant_id) ON DELETE CASCADE;
CREATE INDEX mention_topics_idx ON mention_topics (tenant_id, topic_key);
CREATE INDEX mention_topics_mention_idx ON mention_topics (tenant_id, mention_id);

-- ── Sentiment ─────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE sentiment_results
  ADD COLUMN target_type text NOT NULL DEFAULT 'article' CHECK (target_type IN ('article','entity','topic')),
  ADD COLUMN target_entity_id uuid,
  ADD COLUMN target_label text,
  ADD COLUMN uncertain boolean NOT NULL DEFAULT false,
  ADD COLUMN text_scope text CHECK (text_scope IN ('headline','headline_and_excerpt','full_text')),
  ADD COLUMN method text,
  ADD COLUMN analysis_id uuid,
  ADD CONSTRAINT sentiment_target_entity_fk FOREIGN KEY (target_entity_id, tenant_id) REFERENCES entities (id, tenant_id) ON DELETE CASCADE,
  ADD CONSTRAINT sentiment_analysis_fk FOREIGN KEY (analysis_id, tenant_id) REFERENCES mention_analyses (id, tenant_id) ON DELETE CASCADE;
CREATE INDEX sentiment_results_mention_idx ON sentiment_results (tenant_id, mention_id);

-- ── Related-story clusters (tenant-level; history kept) ─────────────────────────────────────────────
ALTER TABLE story_clusters ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE story_clusters
  ADD COLUMN status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','merged','dissolved')),
  ADD COLUMN merged_into uuid,
  ADD COLUMN confidence numeric(4,3),
  ADD COLUMN member_count integer NOT NULL DEFAULT 0,
  ADD COLUMN independent_count integer NOT NULL DEFAULT 0,
  ADD COLUMN publisher_count integer NOT NULL DEFAULT 0,
  ADD COLUMN representative_mention_id uuid,
  ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX story_clusters_active_idx ON story_clusters (tenant_id, last_seen_at DESC) WHERE status = 'active';

CREATE TABLE cluster_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  cluster_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  score numeric(4,3) NOT NULL CHECK (score BETWEEN 0 AND 1),
  reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_syndicated boolean NOT NULL DEFAULT false,   -- same wire copy as an earlier member: not independent corroboration
  added_at timestamptz NOT NULL DEFAULT now(),
  removed_at timestamptz,
  FOREIGN KEY (cluster_id, tenant_id) REFERENCES story_clusters (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX cluster_members_active_idx ON cluster_members (mention_id) WHERE removed_at IS NULL;
CREATE INDEX cluster_members_cluster_idx ON cluster_members (tenant_id, cluster_id) WHERE removed_at IS NULL;

CREATE TABLE cluster_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL,
  cluster_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('created','member_added','member_removed','merged_into','absorbed','relabelled')),
  mention_id uuid,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (cluster_id, tenant_id) REFERENCES story_clusters (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX cluster_events_idx ON cluster_events (tenant_id, cluster_id, at);

-- ── Summaries ─────────────────────────────────────────────────────────────────────────────────────
CREATE TABLE ai_summaries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('mention','cluster','project','period')),
  mention_id uuid, cluster_id uuid, project_id uuid,
  period_start timestamptz, period_end timestamptz,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','ready','insufficient_evidence','failed')),
  summary_text text,
  claims jsonb NOT NULL DEFAULT '[]'::jsonb,       -- [{text, kind: source_fact|interpretation, supportingMentionIds, quote?}]
  uncertainty_notes text[] NOT NULL DEFAULT '{}',
  conflicts jsonb NOT NULL DEFAULT '[]'::jsonb,
  supporting_mention_ids uuid[] NOT NULL DEFAULT '{}',
  method text CHECK (method IN ('llm','extractive')),
  provider text, model text, prompt_version text,
  tokens_in integer NOT NULL DEFAULT 0, tokens_out integer NOT NULL DEFAULT 0,
  cost_estimate numeric(14,6),
  error jsonb,
  version integer NOT NULL DEFAULT 1,
  is_current boolean NOT NULL DEFAULT true,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  generated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id, tenant_id) REFERENCES story_clusters (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE,
  CHECK ((scope = 'mention') = (mention_id IS NOT NULL)),
  CHECK ((scope = 'cluster') = (cluster_id IS NOT NULL)),
  CHECK (scope NOT IN ('project','period') OR project_id IS NOT NULL),
  CHECK (scope <> 'period' OR (period_start IS NOT NULL AND period_end IS NOT NULL AND period_end > period_start))
);
CREATE INDEX ai_summaries_lookup_idx ON ai_summaries (tenant_id, scope, mention_id, cluster_id, project_id) WHERE is_current;

-- ── Usage accounting ──────────────────────────────────────────────────────────────────────────────
CREATE TABLE ai_usage_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL, model text NOT NULL, task text NOT NULL,
  analysis_id uuid, summary_id uuid,
  tokens_in integer NOT NULL DEFAULT 0, tokens_out integer NOT NULL DEFAULT 0, tokens_cache_read integer NOT NULL DEFAULT 0,
  cost_estimate numeric(14,6),                     -- NULL when no price is configured for provider/model
  currency text,
  pricing_updated_at timestamptz,                  -- which price snapshot the estimate used
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_records_idx ON ai_usage_records (tenant_id, recorded_at DESC);

-- ── RLS and grants ────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ai_tenant_settings','mention_analyses','entities','entity_aliases','project_topics',
                           'cluster_members','cluster_events','ai_summaries','ai_usage_records'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO civicsignal_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON cluster_events, ai_usage_records FROM civicsignal_app;   -- history and accounting are append-only

-- Global reference tables: readable by everyone; written only in system context (operator / platform admin flows).
ALTER TABLE ai_prompt_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_prompt_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY prompt_versions_read ON ai_prompt_versions FOR SELECT USING (true);
CREATE POLICY prompt_versions_write ON ai_prompt_versions FOR INSERT WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON ai_prompt_versions TO civicsignal_app;

ALTER TABLE ai_pricing ENABLE ROW LEVEL SECURITY; ALTER TABLE ai_pricing FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_read ON ai_pricing FOR SELECT USING (true);
CREATE POLICY pricing_insert ON ai_pricing FOR INSERT WITH CHECK (app_is_system());
CREATE POLICY pricing_update ON ai_pricing FOR UPDATE USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY pricing_delete ON ai_pricing FOR DELETE USING (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_pricing TO civicsignal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO civicsignal_app;
