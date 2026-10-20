-- 0010: production hardening (Milestone 6 / Prompt 06): session idle timeout, password reset, tamper-evident audit log,
-- data retention ledger, legal hold and the deletion workflow.

-- ── Sessions: idle timeout ─────────────────────────────────────────────────────────────────────────
ALTER TABLE sessions ADD COLUMN last_seen_at timestamptz NOT NULL DEFAULT now();
REVOKE UPDATE ON sessions FROM civicsignal_app;
GRANT UPDATE (revoked_at, last_seen_at) ON sessions TO civicsignal_app;
CREATE INDEX sessions_active_idx ON sessions (user_id) WHERE revoked_at IS NULL;

-- ── Password reset (local identity adapter; single-use, hashed, short-lived) ──────────────────────
CREATE TABLE password_reset_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,                 -- SHA-256 of the emailed token; the token itself is never stored
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_tokens_user_idx ON password_reset_tokens (user_id, created_at DESC);
ALTER TABLE password_reset_tokens ENABLE ROW LEVEL SECURITY; ALTER TABLE password_reset_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY password_reset_system ON password_reset_tokens USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON password_reset_tokens TO civicsignal_app;
GRANT UPDATE (used_at) ON password_reset_tokens TO civicsignal_app;

-- ── Audit log: event id, outcome, hash chain ──────────────────────────────────────────────────────
-- Each row's hash covers the previous row's hash in the same chain (one chain per tenant, plus 'platform' for rows
-- without a tenant), so deleting, editing or reordering rows is detectable with audit_verify_chain(). The chain head
-- lives in a table the application role cannot read or write; the trigger runs as the table owner.
ALTER TABLE audit_events
  ADD COLUMN event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN outcome text NOT NULL DEFAULT 'success' CHECK (outcome IN ('success','failure','denied')),
  ADD COLUMN prev_hash bytea,
  ADD COLUMN row_hash bytea;
CREATE UNIQUE INDEX audit_events_event_id_key ON audit_events (event_id);

CREATE TABLE audit_chain_heads (
  chain text PRIMARY KEY,
  last_id bigint NOT NULL,
  last_hash bytea NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON audit_chain_heads FROM civicsignal_app;
ALTER TABLE audit_chain_heads ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_chain_heads FORCE ROW LEVEL SECURITY;
-- Only the owner (via the SECURITY DEFINER trigger) and operators; never the application role (which also has no grants).
CREATE POLICY chain_heads_not_app ON audit_chain_heads USING (NOT pg_has_role(current_user, 'civicsignal_app', 'MEMBER'))
  WITH CHECK (NOT pg_has_role(current_user, 'civicsignal_app', 'MEMBER'));

CREATE FUNCTION audit_row_digest(e audit_events, prev bytea) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$
  SELECT sha256(coalesce(prev, '\x'::bytea) || convert_to(concat_ws('|',
    e.id::text, e.event_id::text, coalesce(e.tenant_id::text, ''), coalesce(e.actor_user_id::text, ''), e.action, e.outcome,
    coalesce(e.target_type, ''), coalesce(e.target_id, ''), e.metadata::text, coalesce(host(e.ip), ''), coalesce(e.request_id, ''),
    to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US')), 'UTF8'))
$$;

CREATE FUNCTION audit_events_chain() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE k text := coalesce(NEW.tenant_id::text, 'platform'); h audit_chain_heads;
BEGIN
  -- Row lock on the chain head serialises inserts per chain (concurrent tenants do not block each other).
  INSERT INTO audit_chain_heads (chain, last_id, last_hash) VALUES (k, 0, '\x'::bytea) ON CONFLICT (chain) DO NOTHING;
  SELECT * INTO h FROM audit_chain_heads WHERE chain = k FOR UPDATE;
  NEW.prev_hash := nullif(h.last_hash, '\x'::bytea);
  NEW.row_hash := audit_row_digest(NEW, NEW.prev_hash);
  UPDATE audit_chain_heads SET last_id = NEW.id, last_hash = NEW.row_hash, updated_at = now() WHERE chain = k;
  RETURN NEW;
END $$;

-- Backfill the chain over existing rows (oldest first), with the immutability trigger suspended and FORCE RLS lifted for
-- the owner during this migration only (a non-superuser owner is otherwise subject to the tenant policies).
ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update;
DO $$
DECLARE r audit_events; prev bytea; k text; cur text := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_events ORDER BY coalesce(tenant_id::text, 'platform'), id LOOP
    k := coalesce(r.tenant_id::text, 'platform');
    IF cur IS DISTINCT FROM k THEN prev := NULL; cur := k; END IF;
    UPDATE audit_events SET prev_hash = prev, row_hash = audit_row_digest(r, prev) WHERE id = r.id RETURNING row_hash INTO prev;
    INSERT INTO audit_chain_heads (chain, last_id, last_hash) VALUES (k, r.id, prev)
      ON CONFLICT (chain) DO UPDATE SET last_id = EXCLUDED.last_id, last_hash = EXCLUDED.last_hash;
  END LOOP;
END $$;
ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update;
ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE TRIGGER audit_events_chain BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION audit_events_chain();

-- Verification (invoker rights: a tenant session verifies its own chain under RLS; database operators with BYPASSRLS
-- verify every chain including 'platform'). Returns the number of rows checked and the first row that does not verify.
CREATE FUNCTION audit_verify_chain(p_chain text) RETURNS TABLE (checked bigint, first_bad_id bigint)
LANGUAGE plpgsql STABLE AS $$
DECLARE r audit_events; prev bytea := NULL; n bigint := 0; bad bigint := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_events WHERE coalesce(tenant_id::text, 'platform') = p_chain ORDER BY id LOOP
    n := n + 1;
    IF r.row_hash IS NULL OR r.prev_hash IS DISTINCT FROM prev OR r.row_hash <> audit_row_digest(r, prev) THEN
      bad := r.id; EXIT;
    END IF;
    prev := r.row_hash;
  END LOOP;
  checked := n; first_bad_id := bad;
  RETURN NEXT;
END $$;
GRANT EXECUTE ON FUNCTION audit_verify_chain(text) TO civicsignal_app;

-- Operators (BYPASSRLS) can also compare the stored head with the last row, which detects truncation of the newest rows.
CREATE FUNCTION audit_verify_head(p_chain text) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT h.last_hash = (SELECT row_hash FROM audit_events WHERE coalesce(tenant_id::text, 'platform') = p_chain ORDER BY id DESC LIMIT 1)
  FROM audit_chain_heads h WHERE h.chain = p_chain
$$;

-- ── Data controls: legal hold ─────────────────────────────────────────────────────────────────────
CREATE TABLE tenant_data_controls (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  legal_hold boolean NOT NULL DEFAULT false,      -- suspends retention deletion and deletion requests
  legal_hold_reason text CHECK (legal_hold_reason IS NULL OR char_length(legal_hold_reason) <= 500),
  retention_enabled boolean NOT NULL DEFAULT false,  -- retention deletion runs only after an administrator enables it
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE retention_runs (                    -- ledger of every retention pass (dry run or applied)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  trigger text NOT NULL CHECK (trigger IN ('schedule','manual')),
  dry_run boolean NOT NULL,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','skipped')),
  counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  policies jsonb NOT NULL DEFAULT '{}'::jsonb,     -- the effective policy snapshot used
  error text,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX retention_runs_tenant_idx ON retention_runs (tenant_id, started_at DESC);

CREATE TABLE deletion_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('mentions','source','search')),
  criteria jsonb NOT NULL,                         -- {mentionIds} | {sourceId} | {query}
  reason text NOT NULL CHECK (char_length(reason) BETWEEN 5 AND 1000),
  status text NOT NULL DEFAULT 'pending_review'
    CHECK (status IN ('pending_review','approved','running','completed','rejected','cancelled','failed')),
  preview jsonb,                                   -- identified records per table at request time
  result jsonb,                                    -- deleted rows per table
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by uuid REFERENCES users(id) ON DELETE SET NULL,
  review_note text CHECK (review_note IS NULL OR char_length(review_note) <= 1000),
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  reviewed_at timestamptz,
  completed_at timestamptz,
  UNIQUE (id, tenant_id)
);
CREATE INDEX deletion_requests_tenant_idx ON deletion_requests (tenant_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_data_controls','retention_runs','deletion_requests'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO civicsignal_app', t);
  END LOOP;
END $$;
-- The retention scheduler finds tenants with retention enabled; the deletion worker finds approved requests.
CREATE POLICY system_scan ON tenant_data_controls FOR SELECT USING (app_is_system());
CREATE POLICY system_scan ON deletion_requests FOR SELECT USING (app_is_system());
-- Ledgers are history: no deletion by the application.
REVOKE DELETE ON retention_runs, deletion_requests FROM civicsignal_app;
-- Report runs older than the 'reports' retention period are deleted by the retention job (cited sources cascade).
GRANT DELETE ON report_runs TO civicsignal_app;

-- ── Readiness: applied migration versions (names only) for the health check; the table itself stays revoked. ──
CREATE FUNCTION app_schema_versions() RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS
$$ SELECT version FROM schema_migrations ORDER BY version $$;
REVOKE ALL ON FUNCTION app_schema_versions() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_schema_versions() TO civicsignal_app;
