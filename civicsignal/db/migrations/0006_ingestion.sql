-- 0006: news ingestion (Milestone 2). Builds on the empty tables from 0002; no data exists in them yet.

-- ── Source registry ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE sources DROP CONSTRAINT sources_tenant_id_domain_collection_method_key; -- blocked >1 feed per publisher
ALTER TABLE sources
  ADD COLUMN feed_url text,                                   -- RSS/Atom URL or provider endpoint; never holds secrets
  ADD COLUMN enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN verification_status text NOT NULL DEFAULT 'unverified' CHECK (verification_status IN ('unverified','verified')),
  ADD COLUMN redistribution_restrictions text,
  ADD COLUMN quota_per_day integer CHECK (quota_per_day > 0),
  ADD COLUMN last_attempt_at timestamptz,
  ADD COLUMN last_error jsonb,
  ADD COLUMN records_collected bigint NOT NULL DEFAULT 0,
  ADD COLUMN consecutive_failures integer NOT NULL DEFAULT 0,
  ADD COLUMN created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT sources_enabled_requires_authorization CHECK (NOT enabled OR authorization_status = 'authorized'),
  ADD CONSTRAINT sources_authorized_requires_basis CHECK (authorization_status <> 'authorized' OR coalesce(btrim(authorization_basis), '') <> '');
CREATE UNIQUE INDEX sources_tenant_feed_url_key ON sources (tenant_id, feed_url) WHERE feed_url IS NOT NULL;
CREATE TRIGGER sources_updated BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One connector per source. HTTP cache state lives here so conditional requests survive restarts.
ALTER TABLE connectors
  ADD CONSTRAINT connectors_kind_check CHECK (kind IN ('feed','gdelt')),
  ADD COLUMN http_etag text,
  ADD COLUMN http_last_modified text,
  ADD COLUMN cache_valid_until timestamptz,
  ADD COLUMN cursor text;
CREATE UNIQUE INDEX connectors_source_key ON connectors (source_id);
CREATE TRIGGER connectors_updated BEFORE UPDATE ON connectors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Credentials: AES-256-GCM ciphertext only; the key lives outside the database (CREDENTIALS_KEY).
CREATE TABLE connector_credentials (
  connector_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  ciphertext text NOT NULL,
  key_id text NOT NULL,
  hint text,                                                  -- e.g. last 4 characters, for display
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (connector_id, tenant_id) REFERENCES connectors (id, tenant_id) ON DELETE CASCADE
);

-- ── Run ledger ────────────────────────────────────────────────────────────────────────────────────
ALTER TABLE connector_runs DROP CONSTRAINT connector_runs_status_check;
ALTER TABLE connector_runs
  ADD CONSTRAINT connector_runs_status_check CHECK (status IN ('queued','running','retrying','succeeded','failed','dead_lettered')),
  ADD COLUMN source_id uuid,
  ADD COLUMN trigger text NOT NULL DEFAULT 'schedule' CHECK (trigger IN ('schedule','manual','retry')),
  ADD COLUMN records_rejected integer NOT NULL DEFAULT 0,
  ADD COLUMN records_known integer NOT NULL DEFAULT 0,
  ADD COLUMN records_duplicate integer NOT NULL DEFAULT 0,
  ADD COLUMN matches integer NOT NULL DEFAULT 0,
  ADD COLUMN http_status integer,
  ADD COLUMN not_modified boolean NOT NULL DEFAULT false,
  ADD COLUMN rate_limited boolean NOT NULL DEFAULT false,
  ADD COLUMN duration_ms integer,
  ADD COLUMN stages jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN rejections jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD CONSTRAINT connector_runs_source_fk FOREIGN KEY (source_id, tenant_id) REFERENCES sources (id, tenant_id) ON DELETE CASCADE;
CREATE INDEX connector_runs_source_time_idx ON connector_runs (tenant_id, source_id, created_at DESC);

-- ── Scheduling ────────────────────────────────────────────────────────────────────────────────────
-- Holds no content: only what the scheduler needs to enqueue work across tenants (read in system context).
CREATE TABLE ingestion_schedule (
  source_id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  active boolean NOT NULL,
  interval_seconds integer NOT NULL,
  next_due_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (source_id, tenant_id) REFERENCES sources (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX ingestion_schedule_due_idx ON ingestion_schedule (next_due_at) WHERE active;

CREATE FUNCTION sources_sync_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO ingestion_schedule (source_id, tenant_id, active, interval_seconds, next_due_at)
  VALUES (NEW.id, NEW.tenant_id, NEW.enabled AND NEW.authorization_status = 'authorized', NEW.refresh_interval_seconds, now())
  ON CONFLICT (source_id) DO UPDATE SET
    active = EXCLUDED.active,
    interval_seconds = EXCLUDED.interval_seconds,
    -- re-enabling or shortening the interval makes the source due promptly
    next_due_at = CASE WHEN EXCLUDED.active AND NOT ingestion_schedule.active THEN now()
                       ELSE least(ingestion_schedule.next_due_at, now() + make_interval(secs => EXCLUDED.interval_seconds)) END;
  RETURN NEW;
END $$;
CREATE TRIGGER sources_schedule AFTER INSERT OR UPDATE OF enabled, authorization_status, refresh_interval_seconds ON sources
  FOR EACH ROW EXECUTE FUNCTION sources_sync_schedule();

-- ── Mentions: one row per tenant + canonical URL; project association via mention_matches ────────────
DROP INDEX mentions_project_published_idx;
ALTER TABLE mentions DROP CONSTRAINT mentions_tenant_id_project_id_canonical_url_key;
ALTER TABLE mentions DROP COLUMN project_id;
ALTER TABLE mentions
  ADD COLUMN guid text,
  ADD COLUMN author text,
  ADD COLUMN categories text[] NOT NULL DEFAULT '{}',
  ADD COLUMN publisher_domain text NOT NULL DEFAULT '',
  ADD COLUMN normalized_title text NOT NULL DEFAULT '',
  ADD COLUMN source_type text NOT NULL DEFAULT 'feed',
  ADD COLUMN processing_status text NOT NULL DEFAULT 'pending' CHECK (processing_status IN ('pending','analyzed','failed')),
  ADD COLUMN duplicate_status text NOT NULL DEFAULT 'original' CHECK (duplicate_status IN ('original','duplicate','near_duplicate')),
  ADD COLUMN duplicate_of uuid,
  ADD COLUMN duplicate_reason text,
  ADD COLUMN retention_expires_at timestamptz,
  ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN last_verified_at timestamptz,
  ADD COLUMN first_run_id uuid,
  ADD CONSTRAINT mentions_duplicate_fk FOREIGN KEY (duplicate_of, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE SET NULL (duplicate_of);
ALTER TABLE mentions ADD CONSTRAINT mentions_tenant_canonical_key UNIQUE (tenant_id, canonical_url);
CREATE INDEX mentions_published_idx ON mentions (tenant_id, published_at DESC NULLS LAST);
CREATE INDEX mentions_discovered_idx ON mentions (tenant_id, discovered_at DESC);
CREATE INDEX mentions_publisher_title_idx ON mentions (tenant_id, publisher_domain, normalized_title);
CREATE INDEX mentions_source_idx ON mentions (tenant_id, source_id);

CREATE TABLE mention_matches (
  tenant_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  project_id uuid NOT NULL,
  query_id uuid NOT NULL,
  matched_terms text[] NOT NULL DEFAULT '{}',
  matched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (mention_id, query_id),
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (query_id, tenant_id) REFERENCES monitoring_queries (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX mention_matches_project_idx ON mention_matches (tenant_id, project_id, matched_at DESC);

ALTER TABLE monitoring_queries ADD CONSTRAINT monitoring_queries_has_criteria
  CHECK (cardinality(keywords) + cardinality(aliases) > 0 OR coalesce(btrim(boolean_expression), '') <> '');
CREATE TRIGGER monitoring_queries_updated BEFORE UPDATE ON monitoring_queries FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── RLS and grants for new tables ─────────────────────────────────────────────────────────────────
ALTER TABLE connector_credentials ENABLE ROW LEVEL SECURITY; ALTER TABLE connector_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON connector_credentials USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON connector_credentials TO civicsignal_app;

ALTER TABLE mention_matches ENABLE ROW LEVEL SECURITY; ALTER TABLE mention_matches FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mention_matches USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON mention_matches TO civicsignal_app;

-- The scheduler reads/advances due rows across tenants in system context; tenants maintain their own rows via trigger.
ALTER TABLE ingestion_schedule ENABLE ROW LEVEL SECURITY; ALTER TABLE ingestion_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY schedule_access ON ingestion_schedule
  USING (tenant_id = app_current_tenant() OR app_is_system())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_system());
GRANT SELECT, INSERT, DELETE ON ingestion_schedule TO civicsignal_app;
GRANT UPDATE (active, interval_seconds, next_due_at) ON ingestion_schedule TO civicsignal_app;
