-- 0008: issue detection and alerting (Milestone 4).
-- Replaces the placeholder alert_rules / alert_events tables from 0002, which no application code ever used.
-- Guard: refuse to run if either holds data, so this can never silently discard rules or alerts.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM alert_rules) OR EXISTS (SELECT 1 FROM alert_events) THEN
    RAISE EXCEPTION '0008: alert_rules/alert_events contain data; migrate it manually before applying';
  END IF;
END $$;
DROP TABLE alert_events;
DROP TABLE alert_rules;

-- ── Rules and immutable versions ───────────────────────────────────────────────────────────────────
CREATE TABLE alert_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  project_id uuid NOT NULL,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  rule_type text NOT NULL CHECK (rule_type IN ('volume_spike','negative_shift','emerging_topic','keyword','story_velocity','source_concentration')),
  is_active boolean NOT NULL DEFAULT true,
  current_version integer NOT NULL DEFAULT 1 CHECK (current_version > 0),
  owner_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,                         -- soft delete: issues keep pointing at the rule and its versions
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX alert_rules_active_idx ON alert_rules (tenant_id, project_id) WHERE is_active AND deleted_at IS NULL;

CREATE TABLE alert_rule_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  config jsonb NOT NULL,                          -- validated server-side (alerts/rule-config.ts); never executed as code
  config_sha256 text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_id, version),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (rule_id, tenant_id) REFERENCES alert_rules (id, tenant_id) ON DELETE CASCADE
);

-- ── Issues (an alert is an issue that crossed a rule's thresholds) ─────────────────────────────────
CREATE TABLE detected_issues (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  rule_id uuid NOT NULL,
  rule_version integer NOT NULL,
  scope text NOT NULL CHECK (scope IN ('article','story','issue')),  -- single record / related-story cluster / broader issue
  signal text NOT NULL,
  subject_type text NOT NULL CHECK (subject_type IN ('project','topic','entity','keyword','cluster','publisher')),
  subject_key text NOT NULL,
  dedup_key text NOT NULL,
  group_key text NOT NULL,                        -- related issues share project + subject
  title text NOT NULL,
  status text NOT NULL DEFAULT 'detected'
    CHECK (status IN ('detected','pending_review','acknowledged','investigating','resolved','closed')),
  severity text NOT NULL CHECK (severity IN ('informational','low','medium','high','critical')),
  severity_points integer NOT NULL,
  severity_breakdown jsonb NOT NULL,
  detection jsonb NOT NULL,                       -- method, baseline, observed, thresholds, limitations
  first_detected_at timestamptz NOT NULL,
  last_detected_at timestamptz NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1,
  acknowledged_by uuid REFERENCES users(id) ON DELETE SET NULL,
  acknowledged_at timestamptz,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  resolution_reason text,
  resolved_at timestamptz,
  closed_at timestamptz,
  escalation_level integer NOT NULL DEFAULT 0,
  last_notified_severity text,
  last_notified_at timestamptz,
  ai_summary jsonb,                               -- {method, claims[{text, kind, supportingMentionIds}], ...} or null
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE,
  -- Rules are only soft-deleted by the application (DELETE is revoked below); a cascade here only happens when the whole
  -- project is deleted.
  FOREIGN KEY (rule_id, tenant_id) REFERENCES alert_rules (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (rule_id, rule_version) REFERENCES alert_rule_versions (rule_id, version) ON DELETE CASCADE
);
-- One non-closed issue per rule + subject: re-detection updates it instead of creating duplicates.
CREATE UNIQUE INDEX detected_issues_dedup_idx ON detected_issues (tenant_id, dedup_key) WHERE status <> 'closed';
CREATE INDEX detected_issues_list_idx ON detected_issues (tenant_id, status, severity, last_detected_at DESC);
CREATE INDEX detected_issues_group_idx ON detected_issues (tenant_id, group_key);

CREATE TABLE alert_events (                       -- append-only lifecycle history
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  event text NOT NULL CHECK (event IN ('detected','redetected','severity_changed','status_changed','assigned','unassigned',
    'note_added','escalated','reopened','notified','summary_generated')),
  from_status text,
  to_status text,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (issue_id, tenant_id) REFERENCES detected_issues (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX alert_events_issue_idx ON alert_events (tenant_id, issue_id, at);

CREATE TABLE alert_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  mention_id uuid NOT NULL,
  cluster_id uuid,
  role text NOT NULL DEFAULT 'trigger' CHECK (role IN ('trigger','context')),
  is_syndicated boolean NOT NULL DEFAULT false,
  added_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, mention_id),
  FOREIGN KEY (issue_id, tenant_id) REFERENCES detected_issues (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (mention_id, tenant_id) REFERENCES mentions (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX alert_evidence_issue_idx ON alert_evidence (tenant_id, issue_id);

CREATE TABLE alert_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  assigned_to uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_by uuid REFERENCES users(id) ON DELETE SET NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  unassigned_at timestamptz,
  FOREIGN KEY (issue_id, tenant_id) REFERENCES detected_issues (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE alert_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  issue_id uuid NOT NULL,
  author_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body text NOT NULL CHECK (length(body) BETWEEN 1 AND 5000),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (issue_id, tenant_id) REFERENCES detected_issues (id, tenant_id) ON DELETE CASCADE
);

-- ── Notifications ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE notification_preferences (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app','email','whatsapp')),
  enabled boolean NOT NULL DEFAULT true,
  min_severity text NOT NULL DEFAULT 'low' CHECK (min_severity IN ('informational','low','medium','high','critical')),
  destination text,                               -- WhatsApp: E.164 number the user opted in with
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id, channel)
);

CREATE TABLE notification_deliveries (            -- one row per (issue event, recipient, channel); also the in-app inbox
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  issue_id uuid,
  user_id uuid REFERENCES users(id) ON DELETE CASCADE,
  channel text NOT NULL CHECK (channel IN ('in_app','email','whatsapp')),
  kind text NOT NULL CHECK (kind IN ('detected','severity_changed','escalated','reopened','resolved','test')),
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','sending','delivered','failed','dead','deferred','suppressed','unconfigured')),
  payload jsonb NOT NULL,                         -- title, body, severity, link, rationale, source links
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  not_before timestamptz,                         -- quiet hours
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (issue_id, tenant_id) REFERENCES detected_issues (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX notification_inbox_idx ON notification_deliveries (tenant_id, user_id, created_at DESC) WHERE channel = 'in_app';

CREATE TABLE webhook_endpoints (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  url text NOT NULL CHECK (length(url) <= 2000),
  secret_ciphertext text NOT NULL,
  previous_secret_ciphertext text,                -- still signed with during a rotation grace period
  previous_secret_expires_at timestamptz,
  key_id text NOT NULL,
  is_active boolean NOT NULL DEFAULT true,
  verified_at timestamptz,                        -- only verified endpoints receive alert payloads
  min_severity text NOT NULL DEFAULT 'medium' CHECK (min_severity IN ('informational','low','medium','high','critical')),
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, tenant_id)
);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  endpoint_id uuid NOT NULL,
  issue_id uuid,
  event text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed','dead','skipped')),
  attempts integer NOT NULL DEFAULT 0,
  response_status integer,
  duration_ms integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz,
  UNIQUE (tenant_id, idempotency_key),
  FOREIGN KEY (endpoint_id, tenant_id) REFERENCES webhook_endpoints (id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (issue_id, tenant_id) REFERENCES detected_issues (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX webhook_deliveries_endpoint_idx ON webhook_deliveries (tenant_id, endpoint_id, created_at DESC);

-- ── Pre-computed activity (dashboards and baselines never scan raw history per request) ───────────
CREATE TABLE activity_hourly (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  hour timestamptz NOT NULL,                      -- UTC hour of coalesce(published_at, discovered_at)
  mentions integer NOT NULL,                      -- original records (duplicates excluded)
  publishers integer NOT NULL,
  analysed integer NOT NULL,
  positive integer NOT NULL, negative integer NOT NULL, neutral integer NOT NULL, mixed integer NOT NULL,
  uncertain integer NOT NULL,                     -- low-confidence classifications (any label)
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, hour),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE topic_activity_daily (
  tenant_id uuid NOT NULL,
  project_id uuid NOT NULL,
  day date NOT NULL,
  topic_key text NOT NULL,
  mentions integer NOT NULL,
  publishers integer NOT NULL,
  refreshed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, project_id, day, topic_key),
  FOREIGN KEY (project_id, tenant_id) REFERENCES projects (id, tenant_id) ON DELETE CASCADE
);

CREATE TABLE alert_evaluations (                  -- run ledger: what was evaluated, when, with what outcome
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  idempotency_key text NOT NULL,
  trigger text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  rules_evaluated integer NOT NULL DEFAULT 0,
  issues_created integer NOT NULL DEFAULT 0,
  issues_updated integer NOT NULL DEFAULT 0,
  suppressed jsonb NOT NULL DEFAULT '[]'::jsonb,  -- rule results suppressed (low sample, uncertain data, cooldown...)
  error text,
  UNIQUE (tenant_id, idempotency_key)
);

-- ── RLS and grants ─────────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['alert_rules','alert_rule_versions','detected_issues','alert_events','alert_evidence','alert_assignments',
                           'alert_notes','notification_preferences','notification_deliveries','webhook_endpoints','webhook_deliveries',
                           'activity_hourly','topic_activity_daily','alert_evaluations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO civicsignal_app', t);
  END LOOP;
END $$;
-- The worker's scheduler (system context, no tenant) finds tenants with active rules and due deliveries; read-only.
CREATE POLICY system_scan ON alert_rules FOR SELECT USING (app_is_system());
CREATE POLICY system_scan ON notification_deliveries FOR SELECT USING (app_is_system());
CREATE POLICY system_scan ON webhook_deliveries FOR SELECT USING (app_is_system());
-- History is append-only: versions, lifecycle events, notes and assignments cannot be rewritten by the application.
REVOKE UPDATE, DELETE ON alert_rule_versions, alert_events, alert_notes FROM civicsignal_app;
REVOKE DELETE ON alert_rules, alert_assignments, detected_issues FROM civicsignal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO civicsignal_app;
