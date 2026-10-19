-- 0002: remaining domain tables. All tenant-owned, composite FKs prevent cross-tenant references.
-- Only the structure exists in M1; application code for these arrives in later milestones.

CREATE TABLE monitoring_queries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  keywords text[] NOT NULL DEFAULT '{}',
  aliases text[] NOT NULL DEFAULT '{}',
  exclusions text[] NOT NULL DEFAULT '{}',
  boolean_expression text,
  languages text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL,
  domain text NOT NULL,
  category text NOT NULL DEFAULT 'news',
  collection_method text NOT NULL CHECK (collection_method IN ('rss','atom','publisher_api','licensed_provider','social_api','manual')),
  authorization_status text NOT NULL DEFAULT 'unverified'
    CHECK (authorization_status IN ('unverified','authorized','restricted','revoked')),
  authorization_basis text,
  permitted_fields text[] NOT NULL DEFAULT '{title,url,published_at}',
  permits_full_text boolean NOT NULL DEFAULT false,
  refresh_interval_seconds integer NOT NULL DEFAULT 3600 CHECK (refresh_interval_seconds >= 60),
  rate_limit_per_minute integer CHECK (rate_limit_per_minute > 0),
  license_terms text,
  usage_restrictions text,
  retention_days integer CHECK (retention_days > 0),
  attribution_requirement text,
  last_success_at timestamptz,
  health_status text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown','healthy','degraded','failing','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, domain, collection_method)
);

CREATE TABLE connectors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  source_id uuid NOT NULL,
  kind text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,        -- never holds secrets
  secret_ref text,                                  -- pointer into the secret manager
  status text NOT NULL DEFAULT 'unconfigured'
    CHECK (status IN ('unconfigured','configured','verified','failing','disabled')),
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (source_id, tenant_id) REFERENCES sources (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE connector_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  connector_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','dead_lettered')),
  attempt integer NOT NULL DEFAULT 1,
  records_seen integer NOT NULL DEFAULT 0,
  records_new integer NOT NULL DEFAULT 0,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, connector_id, idempotency_key),
  FOREIGN KEY (connector_id, tenant_id) REFERENCES connectors (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE story_clusters (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  label text NOT NULL,
  summary text,
  method_version text,
  first_seen_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE mentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  source_id uuid NOT NULL,
  cluster_id uuid,
  url text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  excerpt text,
  body text,                                         -- only when source.permits_full_text
  content_hash text NOT NULL,
  language text,
  publisher text,
  published_at timestamptz,                          -- publisher-reported
  discovered_at timestamptz NOT NULL DEFAULT now(),  -- our collection time (kept separate)
  availability text NOT NULL DEFAULT 'available' CHECK (availability IN ('available','unavailable','deleted','inaccessible')),
  license_ref text,
  provenance jsonb NOT NULL DEFAULT '{}'::jsonb,
  search_tsv tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(excerpt,'') || ' ' || coalesce(publisher,''))
  ) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  UNIQUE (tenant_id, project_id, canonical_url),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (source_id, tenant_id) REFERENCES sources (id, tenant_id) ON DELETE RESTRICT,
  FOREIGN KEY (cluster_id, tenant_id) REFERENCES story_clusters (id, tenant_id) ON DELETE SET NULL (cluster_id)
);
CREATE INDEX mentions_search_idx ON mentions USING gin (search_tsv);
CREATE INDEX mentions_project_published_idx ON mentions (tenant_id, project_id, published_at DESC);
CREATE INDEX mentions_hash_idx ON mentions (tenant_id, project_id, content_hash);

CREATE TABLE mention_entities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('organization','person','location','topic','product','other')),
  name text NOT NULL,
  confidence numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version text,
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX mention_entities_idx ON mention_entities (tenant_id, name);

CREATE TABLE mention_topics (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  topic text NOT NULL,
  confidence numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  model_version text,
  prompt_version text,
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE sentiment_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  label text NOT NULL CHECK (label IN ('positive','negative','neutral','mixed','unknown')),
  confidence numeric(4,3) CHECK (confidence BETWEEN 0 AND 1),
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version text NOT NULL,
  prompt_version text,
  tokens_in integer,
  tokens_out integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  name text NOT NULL,
  rule_type text NOT NULL CHECK (rule_type IN ('volume_spike','negative_trend','emerging_topic','keyword')),
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  cooldown_minutes integer NOT NULL DEFAULT 60 CHECK (cooldown_minutes >= 0),
  channels text[] NOT NULL DEFAULT '{email}',
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE alert_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  severity text NOT NULL CHECK (severity IN ('info','low','medium','high','critical')),
  rationale text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedup_key text NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','acknowledged','escalated','resolved')),
  requires_human_review boolean NOT NULL DEFAULT false,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  triggered_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (rule_id, tenant_id) REFERENCES alert_rules (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX alert_events_dedup_idx ON alert_events (tenant_id, rule_id, dedup_key);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  report_type text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','generating','ready','failed')),
  search_criteria jsonb NOT NULL DEFAULT '{}'::jsonb,
  data_collected_at timestamptz,
  generated_at timestamptz,
  storage_key text,
  limitations text[] NOT NULL DEFAULT '{}',
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE report_sources (
  tenant_id uuid NOT NULL,
  report_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  PRIMARY KEY (report_id, mention_id),
  FOREIGN KEY (report_id, tenant_id) REFERENCES reports (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  plan_code text NOT NULL,
  status text NOT NULL DEFAULT 'trialing' CHECK (status IN ('trialing','active','past_due','canceled')),
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  feature_flags jsonb NOT NULL DEFAULT '{}'::jsonb,
  billing_provider text,
  billing_reference text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage_records (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric text NOT NULL,
  quantity numeric NOT NULL CHECK (quantity >= 0),
  period_start date NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX usage_records_idx ON usage_records (tenant_id, metric, period_start);

CREATE TABLE retention_policies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  data_class text NOT NULL CHECK (data_class IN ('mention_body','mention_metadata','derived_analysis','reports','audit_events')),
  retention_days integer NOT NULL CHECK (retention_days > 0),
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, data_class),
  CHECK (data_class <> 'audit_events' OR retention_days >= 365)
);
