-- 0014: fixes from the full-system QA audit (docs/FULL_SYSTEM_QA_REPORT.md). Additive and non-destructive.

-- AI cost: cache writes are reported and priced separately from uncached input (QA-AI-05).
ALTER TABLE ai_pricing ADD COLUMN cache_write_per_mtok numeric CHECK (cache_write_per_mtok >= 0);
ALTER TABLE ai_usage_records ADD COLUMN tokens_cache_write integer NOT NULL DEFAULT 0 CHECK (tokens_cache_write >= 0);

-- Payments are append-only for the application (0013 revoked UPDATE, then a later GRANT loop re-granted it) (QA-AZ-06).
REVOKE UPDATE, DELETE ON payments FROM civicsignal_app;
-- Issued invoices and their lines are immutable except for status/payment bookkeeping (defence in depth for QA-AZ-06).
CREATE FUNCTION invoice_lines_draft_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT status FROM invoices WHERE id = coalesce(OLD.invoice_id, NEW.invoice_id)) <> 'draft' THEN
    RAISE EXCEPTION 'invoice lines can only change while the invoice is a draft';
  END IF;
  RETURN coalesce(NEW, OLD);
END $$;
CREATE TRIGGER invoice_lines_draft_only BEFORE UPDATE OR DELETE ON invoice_lines FOR EACH ROW EXECUTE FUNCTION invoice_lines_draft_only();
CREATE FUNCTION invoices_issued_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (NEW.currency, NEW.subtotal, NEW.tax_amount, NEW.total, NEW.number, NEW.tenant_id, NEW.bill_to)
       IS DISTINCT FROM (OLD.currency, OLD.subtotal, OLD.tax_amount, OLD.total, OLD.number, OLD.tenant_id, OLD.bill_to)
     AND OLD.source = 'manual' THEN
    RAISE EXCEPTION 'issued invoices cannot be edited; void and re-issue instead';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invoices_issued_immutable BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION invoices_issued_immutable();

-- Tenant hard-delete: RESTRICT fired before the payments cascade and blocked it (QA-DB-15). NO ACTION is checked at
-- statement end, after the tenant cascade has removed the payments too.
ALTER TABLE payments DROP CONSTRAINT payments_invoice_id_fkey,
  ADD CONSTRAINT payments_invoice_id_fkey FOREIGN KEY (invoice_id) REFERENCES invoices(id) ON DELETE NO ACTION;

-- Retention / deletion purges cascade over these tables by mention_id; without an index each mention scans them (QA-DB-16).
CREATE INDEX IF NOT EXISTS alert_evidence_mention_idx ON alert_evidence (tenant_id, mention_id);
CREATE INDEX IF NOT EXISTS report_run_sources_mention_idx ON report_run_sources (tenant_id, mention_id);
CREATE INDEX IF NOT EXISTS cluster_members_mention_all_idx ON cluster_members (tenant_id, mention_id);
CREATE INDEX IF NOT EXISTS ai_summaries_mention_all_idx ON ai_summaries (tenant_id, mention_id);

-- Provider references: one provider subscription belongs to one organization (QA-BL-P3).
CREATE INDEX subscriptions_provider_ref_idx ON subscriptions (billing_provider, billing_reference) WHERE billing_reference IS NOT NULL;

-- Checkout sessions are recorded before the provider is called and do not depend on a live subscription, so a paid
-- checkout can (re)activate an organization whose subscription had ended (QA-BL-01, QA-BL-13).
CREATE TABLE checkout_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider text NOT NULL,
  session_ref text,
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  requested_by uuid REFERENCES users(id),
  status text NOT NULL DEFAULT 'created' CHECK (status IN ('created', 'open', 'completed', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE UNIQUE INDEX checkout_sessions_ref_uidx ON checkout_sessions (provider, session_ref) WHERE session_ref IS NOT NULL;
ALTER TABLE checkout_sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE checkout_sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON checkout_sessions USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY platform_read ON checkout_sessions FOR SELECT USING (app_is_system());
GRANT SELECT, INSERT, UPDATE ON checkout_sessions TO civicsignal_app;
-- Existing sessions recorded as subscription events are carried over.
INSERT INTO checkout_sessions (tenant_id, provider, session_ref, plan_version_id, requested_by, status, created_at)
SELECT e.tenant_id, e.metadata->>'provider', e.metadata->>'sessionRef', (e.metadata->>'planVersionId')::uuid, e.actor_user_id, 'open', e.created_at
FROM subscription_events e WHERE e.event = 'checkout_started' AND e.metadata ? 'sessionRef'
ON CONFLICT DO NOTHING;

-- Usage periods are computed in the time zone in force when the anchor was set; changing the organization's time zone
-- no longer moves (and resets) the current period (QA-BL-10).
ALTER TABLE subscriptions ADD COLUMN usage_timezone text;
UPDATE subscriptions s SET usage_timezone = coalesce(t.settings->>'timezone', 'Asia/Jakarta') FROM tenants t WHERE t.id = s.tenant_id;

-- Usage-notice emails are claimed before sending so two workers never send the same notice (QA-BL-12).
ALTER TABLE usage_notices DROP CONSTRAINT usage_notices_email_status_check,
  ADD CONSTRAINT usage_notices_email_status_check CHECK (email_status IN ('pending', 'sending', 'sent', 'failed', 'not_configured'));
ALTER TABLE usage_notices ADD COLUMN email_claimed_at timestamptz;

-- Notification deliveries are claimed atomically; a stale claim is measured from claimed_at, not created_at (QA-AL-01).
ALTER TABLE notification_deliveries ADD COLUMN claimed_at timestamptz;
ALTER TABLE webhook_deliveries ADD COLUMN claimed_at timestamptz;
CREATE FUNCTION subscriptions_freeze_usage_timezone() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.usage_anchor IS DISTINCT FROM OLD.usage_anchor OR NEW.usage_timezone IS NULL THEN
    NEW.usage_timezone := coalesce((SELECT settings->>'timezone' FROM tenants WHERE id = NEW.tenant_id), 'Asia/Jakarta');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER subscriptions_freeze_usage_timezone BEFORE INSERT OR UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION subscriptions_freeze_usage_timezone();
ALTER TABLE webhook_deliveries DROP CONSTRAINT IF EXISTS webhook_deliveries_status_check,
  ADD CONSTRAINT webhook_deliveries_status_check CHECK (status IN ('pending', 'sending', 'delivered', 'failed', 'dead', 'skipped'));
