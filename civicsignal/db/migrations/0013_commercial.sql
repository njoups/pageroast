-- 0013: commercialization (Prompt 08): plans and immutable plan versions, subscription lifecycle and history, quota
-- overrides, an idempotent usage ledger (extends usage_records) with daily and usage-period aggregates, usage notices,
-- contracts, manual invoices and payments, billing webhook log, sales requests, onboarding progress and provider costs.
-- Extends the existing subscriptions and usage_records tables (0002) instead of creating parallel ones.

-- ── Plans (platform-level reference data) ──────────────────────────────────────────────────────────
CREATE TABLE plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE CHECK (code ~ '^[a-z][a-z0-9_]{1,40}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 2 AND 80),
  category text NOT NULL CHECK (category IN ('trial', 'self_service', 'sales_assisted', 'public_sector', 'internal')),
  description text CHECK (length(description) <= 2000),
  is_public boolean NOT NULL DEFAULT false,      -- offered on the customer billing page
  is_active boolean NOT NULL DEFAULT true,       -- assignable to new subscriptions
  sort_order integer NOT NULL DEFAULT 100,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER plans_updated BEFORE UPDATE ON plans FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- A plan version is immutable once created (only effective_to may be set). Subscriptions and invoices reference a version,
-- so later price or entitlement changes never rewrite what a customer bought.
CREATE TABLE plan_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id uuid NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  price_amount numeric(14, 2) CHECK (price_amount >= 0),   -- NULL = no list price (contact sales / contract)
  billing_interval text NOT NULL CHECK (billing_interval IN ('month', 'year', 'custom')),
  trial_days integer NOT NULL DEFAULT 0 CHECK (trial_days BETWEEN 0 AND 365),
  features jsonb NOT NULL DEFAULT '{}'::jsonb,              -- feature entitlements (boolean)
  quotas jsonb NOT NULL DEFAULT '{}'::jsonb,                -- metric → {limit, enforcement, overage}
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,              -- retention maxima, support level, notice thresholds, grace days
  notes text CHECK (length(notes) <= 2000),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plan_id, version),
  CHECK ((price_amount IS NULL) OR (currency IS NOT NULL)),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE INDEX plan_versions_plan_idx ON plan_versions (plan_id, effective_from DESC);

-- ── Subscriptions (extends 0002) ───────────────────────────────────────────────────────────────────
ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_status_check;
ALTER TABLE subscriptions
  ADD COLUMN plan_version_id uuid REFERENCES plan_versions(id),
  ADD COLUMN billing_mode text NOT NULL DEFAULT 'self_service' CHECK (billing_mode IN ('self_service', 'contract', 'manual')),
  ADD COLUMN trial_ends_at timestamptz,
  ADD COLUMN usage_anchor timestamptz NOT NULL DEFAULT now(),   -- monthly usage periods start on this local day/time
  ADD COLUMN cancel_at_period_end boolean NOT NULL DEFAULT false,
  ADD COLUMN canceled_at timestamptz,
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN past_due_since timestamptz,
  ADD COLUMN suspended_reason text CHECK (length(suspended_reason) <= 500),
  ADD COLUMN scheduled_plan_version_id uuid REFERENCES plan_versions(id),
  ADD COLUMN scheduled_change_at timestamptz,
  ADD COLUMN contract_id uuid,
  ADD COLUMN provider_customer_ref text CHECK (length(provider_customer_ref) <= 200),
  ADD CONSTRAINT subscriptions_status_check CHECK (status IN ('trialing', 'pending_activation', 'active', 'pending_renewal', 'past_due', 'suspended', 'canceled', 'expired')),
  ADD CONSTRAINT subscriptions_trial_has_end CHECK (status <> 'trialing' OR trial_ends_at IS NOT NULL),
  ADD CONSTRAINT subscriptions_schedule_pair CHECK ((scheduled_plan_version_id IS NULL) = (scheduled_change_at IS NULL));
-- One current subscription per tenant (history lives in subscription_events; ended subscriptions keep ended_at).
CREATE UNIQUE INDEX subscriptions_current_uidx ON subscriptions (tenant_id) WHERE ended_at IS NULL;
CREATE INDEX subscriptions_status_idx ON subscriptions (status, current_period_end);
CREATE TRIGGER subscriptions_updated BEFORE UPDATE ON subscriptions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
COMMENT ON COLUMN subscriptions.limits IS 'Legacy (0002), unused: quotas come from plan_versions plus quota_overrides';
COMMENT ON COLUMN subscriptions.feature_flags IS 'Legacy (0002), unused: features come from plan_versions';

-- Append-only lifecycle history.
CREATE TABLE subscription_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  event text NOT NULL CHECK (event ~ '^[a-z_]{3,40}$'),
  from_status text, to_status text,
  from_plan_version_id uuid REFERENCES plan_versions(id), to_plan_version_id uuid REFERENCES plan_versions(id),
  actor_type text NOT NULL CHECK (actor_type IN ('user', 'platform_admin', 'system', 'billing_provider')),
  actor_user_id uuid REFERENCES users(id),
  reason text CHECK (length(reason) <= 1000),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX subscription_events_idx ON subscription_events (tenant_id, created_at DESC);

-- Documented per-tenant quota overrides (platform operators only; reason required).
CREATE TABLE quota_overrides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric text NOT NULL CHECK (metric ~ '^[a-z_]{2,40}$'),
  quota_limit numeric CHECK (quota_limit >= 0),       -- NULL = unlimited
  enforcement text NOT NULL CHECK (enforcement IN ('hard', 'soft')),
  reason text NOT NULL CHECK (length(reason) BETWEEN 5 AND 1000),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX quota_overrides_active_uidx ON quota_overrides (tenant_id, metric) WHERE revoked_at IS NULL;

-- ── Usage ledger (extends usage_records from 0002) ─────────────────────────────────────────────────
ALTER TABLE usage_records DROP CONSTRAINT usage_records_quantity_check;
ALTER TABLE usage_records
  ADD COLUMN idempotency_key text,
  ADD COLUMN source text NOT NULL DEFAULT 'legacy' CHECK (source ~ '^[a-z_]{2,40}$'),
  ADD COLUMN kind text NOT NULL DEFAULT 'usage' CHECK (kind IN ('usage', 'correction')),
  ADD COLUMN measurement text NOT NULL DEFAULT 'estimated' CHECK (measurement IN ('estimated', 'confirmed')),
  ADD COLUMN occurred_at timestamptz,
  ADD COLUMN usage_period_start timestamptz,
  ADD COLUMN project_id uuid,
  ADD COLUMN subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  ADD COLUMN corrects_id bigint REFERENCES usage_records(id),
  ADD COLUMN reason text CHECK (length(reason) <= 1000),
  ADD COLUMN recorded_by uuid REFERENCES users(id);
UPDATE usage_records SET idempotency_key = 'legacy:' || id, occurred_at = recorded_at;
ALTER TABLE usage_records ALTER COLUMN idempotency_key SET NOT NULL, ALTER COLUMN occurred_at SET NOT NULL, ALTER COLUMN occurred_at SET DEFAULT now();
ALTER TABLE usage_records ADD CONSTRAINT usage_records_quantity_sign CHECK (kind = 'correction' OR quantity >= 0),
  ADD CONSTRAINT usage_records_correction_ref CHECK (kind = 'correction' OR corrects_id IS NULL),
  ADD CONSTRAINT usage_records_correction_reason CHECK (kind = 'usage' OR reason IS NOT NULL);
-- One ledger row per (tenant, metric, idempotency key): retries, duplicate jobs and webhook replays count once.
CREATE UNIQUE INDEX usage_records_idem_uidx ON usage_records (tenant_id, metric, idempotency_key);
CREATE INDEX usage_records_period_idx ON usage_records (tenant_id, metric, usage_period_start);
COMMENT ON COLUMN usage_records.period_start IS 'Tenant-local day of the event (name kept from 0002)';
-- The ledger is append-only for the application: corrections are new rows that reference the corrected one.
REVOKE UPDATE, DELETE ON usage_records FROM civicsignal_app;

-- Aggregates maintained in the same transaction as the ledger insert; reconciliation recomputes them from the ledger.
CREATE TABLE usage_daily (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric text NOT NULL,
  day date NOT NULL,                                   -- tenant-local calendar day
  quantity numeric NOT NULL DEFAULT 0,
  events integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, day)
);
CREATE TABLE usage_period_totals (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric text NOT NULL,
  period_start timestamptz NOT NULL,
  period_end timestamptz NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, metric, period_start),
  CHECK (period_end > period_start)
);

-- Threshold notices: one per tenant, metric, usage period and threshold.
CREATE TABLE usage_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  metric text NOT NULL,
  period_start timestamptz NOT NULL,
  threshold integer NOT NULL CHECK (threshold BETWEEN 1 AND 1000),
  used numeric NOT NULL, quota_limit numeric NOT NULL,
  message text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz, acknowledged_by uuid REFERENCES users(id),
  email_status text NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sent', 'failed', 'not_configured')),
  emailed_at timestamptz,
  UNIQUE (tenant_id, metric, period_start, threshold)
);

-- ── Contracts, invoices, payments (manual / procurement workflow; provider invoices mirror here) ────
CREATE TABLE contracts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 2 AND 300),
  contract_reference text NOT NULL CHECK (length(contract_reference) BETWEEN 1 AND 200),
  po_reference text CHECK (length(po_reference) <= 200),
  plan_version_id uuid NOT NULL REFERENCES plan_versions(id),
  start_date date NOT NULL, end_date date NOT NULL,
  billing_frequency text NOT NULL CHECK (billing_frequency IN ('monthly', 'quarterly', 'semiannual', 'annual', 'one_time')),
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  contract_value numeric(16, 2) CHECK (contract_value >= 0),
  currency text CHECK (currency ~ '^[A-Z]{3}$'),
  renewal_date date,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'expired', 'terminated')),
  contact_name text CHECK (length(contact_name) <= 200), contact_email text CHECK (length(contact_email) <= 320), contact_phone text CHECK (length(contact_phone) <= 50),
  document_refs text[] NOT NULL DEFAULT '{}',
  notes text CHECK (length(notes) <= 4000),
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date), CHECK ((contract_value IS NULL) OR (currency IS NOT NULL)),
  UNIQUE (tenant_id, contract_reference)
);
CREATE TRIGGER contracts_updated BEFORE UPDATE ON contracts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_contract_fk FOREIGN KEY (contract_id) REFERENCES contracts(id) ON DELETE SET NULL;

CREATE SEQUENCE invoice_number_seq;
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  subscription_id uuid REFERENCES subscriptions(id) ON DELETE SET NULL,
  contract_id uuid REFERENCES contracts(id) ON DELETE SET NULL,
  number text UNIQUE,                                   -- assigned when issued; never reused
  source text NOT NULL CHECK (source IN ('manual', 'provider')),
  provider text, provider_invoice_ref text,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'issued', 'partially_paid', 'paid', 'overdue', 'void', 'canceled')),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  subtotal numeric(16, 2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax_amount numeric(16, 2) NOT NULL DEFAULT 0 CHECK (tax_amount >= 0),
  total numeric(16, 2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  amount_paid numeric(16, 2) NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
  period_start date, period_end date,
  issued_at timestamptz, due_at timestamptz, paid_at timestamptz, voided_at timestamptz,
  po_reference text CHECK (length(po_reference) <= 200),
  tax_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,      -- e.g. buyer tax id; NOT a Faktur Pajak
  bill_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes text CHECK (length(notes) <= 4000),
  document_refs text[] NOT NULL DEFAULT '{}',
  idempotency_key text,
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (total = subtotal + tax_amount),
  CHECK (amount_paid <= total),
  CHECK (status = 'draft' OR number IS NOT NULL),
  CHECK (source = 'manual' OR provider_invoice_ref IS NOT NULL)
);
CREATE UNIQUE INDEX invoices_provider_uidx ON invoices (provider, provider_invoice_ref) WHERE provider_invoice_ref IS NOT NULL;
CREATE UNIQUE INDEX invoices_idem_uidx ON invoices (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX invoices_tenant_idx ON invoices (tenant_id, created_at DESC);
CREATE INDEX invoices_due_idx ON invoices (status, due_at);
CREATE TRIGGER invoices_updated BEFORE UPDATE ON invoices FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE invoice_lines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description text NOT NULL CHECK (length(description) BETWEEN 1 AND 500),
  quantity numeric(14, 4) NOT NULL CHECK (quantity > 0),
  unit_amount numeric(16, 2) NOT NULL CHECK (unit_amount >= 0),
  amount numeric(16, 2) NOT NULL CHECK (amount >= 0),
  sort_order integer NOT NULL DEFAULT 0
);
CREATE INDEX invoice_lines_idx ON invoice_lines (invoice_id, sort_order);

CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount numeric(16, 2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  method text NOT NULL CHECK (method IN ('bank_transfer', 'government_treasury', 'provider', 'other')),
  reference text NOT NULL CHECK (length(reference) BETWEEN 1 AND 200),   -- bank reference, SP2D number, provider payment id
  received_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('manual', 'provider_webhook')),
  note text CHECK (length(note) <= 1000),
  recorded_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, reference)                          -- the same remittance cannot be reconciled twice
);
REVOKE UPDATE, DELETE ON payments FROM civicsignal_app;

-- ── Billing provider webhooks (platform-level log; processed idempotently) ─────────────────────────
CREATE TABLE billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,
  signature_valid boolean NOT NULL,
  status text NOT NULL CHECK (status IN ('received', 'processed', 'ignored', 'failed', 'rejected')),
  error text CHECK (length(error) <= 1000),
  payload jsonb,                                         -- stored without secrets; NULL for rejected (unsigned) requests
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (provider, event_id)
);
CREATE INDEX billing_webhook_events_idx ON billing_webhook_events (status, received_at DESC);

-- ── Sales requests, onboarding, provider costs ────────────────────────────────────────────────────
CREATE TABLE sales_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('quote', 'plan_change', 'contract', 'other')),
  plan_code text,
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4000),
  contact_phone text CHECK (length(contact_phone) <= 50),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'closed')),
  handled_by uuid REFERENCES users(id), handled_note text CHECK (length(handled_note) <= 2000),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER sales_requests_updated BEFORE UPDATE ON sales_requests FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE onboarding_progress (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  path text NOT NULL DEFAULT 'self_service' CHECK (path IN ('self_service', 'sales_assisted')),
  steps jsonb NOT NULL DEFAULT '{}'::jsonb,              -- step → {status: done|skipped, at, by}
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Actual provider-reported costs entered by operators (e.g. from a provider's invoice). Estimates are computed from
-- ai_usage_records / provider_usage with configured pricing and are never stored here as actual.
CREATE TABLE provider_cost_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid REFERENCES tenants(id) ON DELETE SET NULL,   -- NULL = platform-wide cost (not attributed)
  provider text NOT NULL CHECK (length(provider) BETWEEN 2 AND 60),
  service text NOT NULL CHECK (length(service) BETWEEN 2 AND 120),
  period_start date NOT NULL, period_end date NOT NULL,
  units numeric, unit text CHECK (length(unit) <= 40),
  amount numeric(16, 4) NOT NULL CHECK (amount >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  source_reference text NOT NULL CHECK (length(source_reference) BETWEEN 3 AND 500),  -- provider invoice number / export
  recorded_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);

-- ── Row-level security ─────────────────────────────────────────────────────────────────────────────
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['subscription_events', 'quota_overrides', 'usage_daily', 'usage_period_totals', 'usage_notices', 'contracts',
                           'invoices', 'invoice_lines', 'payments', 'sales_requests', 'onboarding_progress'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO civicsignal_app', t);
  END LOOP;
  -- Platform operators and the commercial scheduler read commercial records across tenants (never tenant content).
  FOREACH t IN ARRAY ARRAY['subscriptions', 'subscription_events', 'quota_overrides', 'usage_daily', 'usage_period_totals', 'usage_notices',
                           'contracts', 'invoices', 'invoice_lines', 'payments', 'sales_requests', 'onboarding_progress'] LOOP
    EXECUTE format('CREATE POLICY platform_read ON %I FOR SELECT USING (app_is_system())', t);
  END LOOP;
END $$;
REVOKE UPDATE ON subscription_events FROM civicsignal_app;
REVOKE UPDATE ON quota_overrides FROM civicsignal_app;
GRANT UPDATE (revoked_at) ON quota_overrides TO civicsignal_app;
GRANT DELETE ON invoice_lines TO civicsignal_app;                -- draft invoices only (enforced in the service)
CREATE POLICY platform_read ON usage_records FOR SELECT USING (app_is_system());
-- Usage and cost metadata (token counts, provider units; no content) for the platform cost view.
CREATE POLICY platform_read ON ai_usage_records FOR SELECT USING (app_is_system());
CREATE POLICY platform_read ON provider_usage FOR SELECT USING (app_is_system());
-- Commercial audit events are visible to platform operators; other audit events stay tenant-only.
CREATE POLICY audit_platform_commercial ON audit_events FOR SELECT USING (app_is_system() AND action LIKE 'commercial.%');

-- Platform-level tables: readable by the application, written only in system context (platform operators, webhooks).
ALTER TABLE plans ENABLE ROW LEVEL SECURITY; ALTER TABLE plans FORCE ROW LEVEL SECURITY;
ALTER TABLE plan_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE plan_versions FORCE ROW LEVEL SECURITY;
CREATE POLICY plans_read ON plans FOR SELECT USING (true);
CREATE POLICY plans_write ON plans FOR INSERT WITH CHECK (app_is_system());
CREATE POLICY plans_update ON plans FOR UPDATE USING (app_is_system()) WITH CHECK (app_is_system());
CREATE POLICY plan_versions_read ON plan_versions FOR SELECT USING (true);
CREATE POLICY plan_versions_write ON plan_versions FOR INSERT WITH CHECK (app_is_system());
CREATE POLICY plan_versions_close ON plan_versions FOR UPDATE USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON plans, plan_versions TO civicsignal_app;
GRANT UPDATE (name, description, is_public, is_active, sort_order, category) ON plans TO civicsignal_app;
GRANT UPDATE (effective_to) ON plan_versions TO civicsignal_app;   -- versions are otherwise immutable

ALTER TABLE billing_webhook_events ENABLE ROW LEVEL SECURITY; ALTER TABLE billing_webhook_events FORCE ROW LEVEL SECURITY;
CREATE POLICY webhook_system ON billing_webhook_events USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON billing_webhook_events TO civicsignal_app;
GRANT UPDATE (status, error, processed_at, tenant_id) ON billing_webhook_events TO civicsignal_app;

ALTER TABLE provider_cost_entries ENABLE ROW LEVEL SECURITY; ALTER TABLE provider_cost_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY costs_system ON provider_cost_entries USING (app_is_system()) WITH CHECK (app_is_system());
GRANT SELECT, INSERT ON provider_cost_entries TO civicsignal_app;
GRANT USAGE ON SEQUENCE invoice_number_seq TO civicsignal_app;

-- ── Seed: plan catalogue WITHOUT prices (operators set prices; NULL = contact sales) ─────────────────
-- Quotas below are starting configurations for evaluation, not commercial commitments; edit them as new versions.
INSERT INTO plans (code, name, category, description, is_public, is_active, sort_order) VALUES
  ('trial', 'Trial', 'trial', 'Evaluation period for new organizations.', false, true, 0),
  ('pilot', 'Pilot (legacy, unlimited)', 'internal', 'Assigned to organizations that existed before plans were introduced. No quotas; operator assigns a real plan.', false, true, 1),
  ('starter', 'Starter', 'self_service', 'Example plan; price to be set by the operator.', true, true, 10),
  ('professional', 'Professional', 'self_service', 'Example plan; price to be set by the operator.', true, true, 20),
  ('agency', 'Agency', 'sales_assisted', 'Example plan for agencies managing several clients.', true, true, 30),
  ('enterprise', 'Enterprise', 'sales_assisted', 'Contract-based; price by agreement.', true, true, 40),
  ('government', 'Government / Public Sector', 'public_sector', 'Contract and purchase-order based procurement; manual invoicing.', true, true, 50);

INSERT INTO plan_versions (plan_id, version, currency, price_amount, billing_interval, trial_days, features, quotas, settings, notes)
SELECT p.id, 1, NULL, NULL, v.interval, v.trial, v.features::jsonb, v.quotas::jsonb, v.settings::jsonb, 'Seeded by migration 0013 without a price.'
FROM plans p JOIN (VALUES
  ('trial', 'custom', 14,
   '{"executive_analytics":true,"social_listening":true,"ai_analysis":true,"scheduled_reports":true,"webhooks":true,"whatsapp":false,"white_label_reports":false,"api_access":false}',
   '{"seats":{"limit":5,"enforcement":"hard"},"projects":{"limit":3,"enforcement":"hard"},"monitoring_queries":{"limit":20,"enforcement":"hard"},"active_connectors":{"limit":5,"enforcement":"hard"},"mentions_ingested":{"limit":20000,"enforcement":"hard"},"ai_analyses":{"limit":5000,"enforcement":"hard"},"ai_tokens":{"limit":2000000,"enforcement":"hard"},"reports_generated":{"limit":30,"enforcement":"hard"},"report_schedules":{"limit":3,"enforcement":"hard"},"exports":{"limit":100,"enforcement":"soft"},"social_api_units":{"limit":10000,"enforcement":"hard"},"alert_rules":{"limit":10,"enforcement":"hard"},"notification_channels":{"limit":2,"enforcement":"hard"},"storage_mb":{"limit":1024,"enforcement":"soft"},"api_requests":{"limit":0,"enforcement":"hard"}}',
   '{"max_retention_days":90,"audit_retention_days":365,"support_level":"community","notice_thresholds":[70,85,95,100],"past_due_grace_days":14}'),
  ('pilot', 'custom', 0,
   '{"executive_analytics":true,"social_listening":true,"ai_analysis":true,"scheduled_reports":true,"webhooks":true,"whatsapp":true,"white_label_reports":true,"api_access":false}',
   '{}', '{"max_retention_days":3650,"audit_retention_days":3650,"support_level":"pilot","notice_thresholds":[70,85,95,100],"past_due_grace_days":30}'),
  ('starter', 'month', 14,
   '{"executive_analytics":false,"social_listening":false,"ai_analysis":true,"scheduled_reports":true,"webhooks":false,"whatsapp":false,"white_label_reports":false,"api_access":false}',
   '{"seats":{"limit":3,"enforcement":"hard"},"projects":{"limit":2,"enforcement":"hard"},"monitoring_queries":{"limit":10,"enforcement":"hard"},"active_connectors":{"limit":5,"enforcement":"hard"},"mentions_ingested":{"limit":10000,"enforcement":"hard"},"ai_analyses":{"limit":3000,"enforcement":"hard"},"ai_tokens":{"limit":1500000,"enforcement":"hard"},"reports_generated":{"limit":20,"enforcement":"hard"},"report_schedules":{"limit":2,"enforcement":"hard"},"exports":{"limit":50,"enforcement":"soft"},"social_api_units":{"limit":0,"enforcement":"hard"},"alert_rules":{"limit":5,"enforcement":"hard"},"notification_channels":{"limit":0,"enforcement":"hard"},"storage_mb":{"limit":1024,"enforcement":"soft"},"api_requests":{"limit":0,"enforcement":"hard"}}',
   '{"max_retention_days":90,"audit_retention_days":365,"support_level":"email","notice_thresholds":[70,85,95,100],"past_due_grace_days":7}'),
  ('professional', 'month', 14,
   '{"executive_analytics":true,"social_listening":true,"ai_analysis":true,"scheduled_reports":true,"webhooks":true,"whatsapp":false,"white_label_reports":false,"api_access":false}',
   '{"seats":{"limit":10,"enforcement":"hard"},"projects":{"limit":10,"enforcement":"hard"},"monitoring_queries":{"limit":50,"enforcement":"hard"},"active_connectors":{"limit":20,"enforcement":"hard"},"mentions_ingested":{"limit":100000,"enforcement":"hard"},"ai_analyses":{"limit":30000,"enforcement":"hard"},"ai_tokens":{"limit":15000000,"enforcement":"hard"},"reports_generated":{"limit":200,"enforcement":"hard"},"report_schedules":{"limit":20,"enforcement":"hard"},"exports":{"limit":500,"enforcement":"soft"},"social_api_units":{"limit":50000,"enforcement":"hard"},"alert_rules":{"limit":50,"enforcement":"hard"},"notification_channels":{"limit":5,"enforcement":"hard"},"storage_mb":{"limit":10240,"enforcement":"soft"},"api_requests":{"limit":0,"enforcement":"hard"}}',
   '{"max_retention_days":365,"audit_retention_days":730,"support_level":"business_hours","notice_thresholds":[70,85,95,100],"past_due_grace_days":7}'),
  ('agency', 'month', 0,
   '{"executive_analytics":true,"social_listening":true,"ai_analysis":true,"scheduled_reports":true,"webhooks":true,"whatsapp":true,"white_label_reports":true,"api_access":false}',
   '{"seats":{"limit":25,"enforcement":"hard"},"projects":{"limit":50,"enforcement":"hard"},"monitoring_queries":{"limit":250,"enforcement":"hard"},"active_connectors":{"limit":50,"enforcement":"hard"},"mentions_ingested":{"limit":500000,"enforcement":"soft"},"ai_analyses":{"limit":150000,"enforcement":"hard"},"ai_tokens":{"limit":75000000,"enforcement":"hard"},"reports_generated":{"limit":1000,"enforcement":"soft"},"report_schedules":{"limit":100,"enforcement":"hard"},"exports":{"limit":2000,"enforcement":"soft"},"social_api_units":{"limit":200000,"enforcement":"hard"},"alert_rules":{"limit":200,"enforcement":"hard"},"notification_channels":{"limit":20,"enforcement":"hard"},"storage_mb":{"limit":51200,"enforcement":"soft"},"api_requests":{"limit":0,"enforcement":"hard"}}',
   '{"max_retention_days":730,"audit_retention_days":1095,"support_level":"priority","notice_thresholds":[70,85,95,100],"past_due_grace_days":14}'),
  ('enterprise', 'custom', 0,
   '{"executive_analytics":true,"social_listening":true,"ai_analysis":true,"scheduled_reports":true,"webhooks":true,"whatsapp":true,"white_label_reports":true,"api_access":false}',
   '{"seats":{"limit":100,"enforcement":"soft"},"projects":{"limit":200,"enforcement":"soft"},"mentions_ingested":{"limit":2000000,"enforcement":"soft"},"ai_analyses":{"limit":600000,"enforcement":"soft"},"ai_tokens":{"limit":300000000,"enforcement":"soft"},"social_api_units":{"limit":1000000,"enforcement":"soft"},"storage_mb":{"limit":204800,"enforcement":"soft"},"api_requests":{"limit":0,"enforcement":"hard"}}',
   '{"max_retention_days":1825,"audit_retention_days":2555,"support_level":"dedicated","notice_thresholds":[70,85,95,100],"past_due_grace_days":30}'),
  ('government', 'custom', 0,
   '{"executive_analytics":true,"social_listening":true,"ai_analysis":true,"scheduled_reports":true,"webhooks":true,"whatsapp":true,"white_label_reports":true,"api_access":false}',
   '{"seats":{"limit":50,"enforcement":"soft"},"projects":{"limit":100,"enforcement":"soft"},"mentions_ingested":{"limit":1000000,"enforcement":"soft"},"ai_analyses":{"limit":300000,"enforcement":"soft"},"ai_tokens":{"limit":150000000,"enforcement":"soft"},"social_api_units":{"limit":500000,"enforcement":"soft"},"storage_mb":{"limit":102400,"enforcement":"soft"},"api_requests":{"limit":0,"enforcement":"hard"}}',
   '{"max_retention_days":1825,"audit_retention_days":3650,"support_level":"contracted","notice_thresholds":[70,85,95,100],"past_due_grace_days":60}')
) AS v(code, interval, trial, features, quotas, settings) ON v.code = p.code;

-- Existing organizations keep working: they move to the unlimited pilot plan, billed manually, until an operator assigns a plan.
INSERT INTO subscriptions (tenant_id, plan_code, status, plan_version_id, billing_mode, current_period_start, current_period_end, usage_anchor)
SELECT t.id, 'pilot', 'active', pv.id, 'manual', now(), now() + interval '1 month', now()
FROM tenants t CROSS JOIN plan_versions pv JOIN plans p ON p.id = pv.plan_id AND p.code = 'pilot'
WHERE NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id);
INSERT INTO subscription_events (tenant_id, subscription_id, event, to_status, to_plan_version_id, actor_type, reason)
SELECT s.tenant_id, s.id, 'migrated', s.status, s.plan_version_id, 'system', 'Migration 0013: existing organization assigned to the pilot plan'
FROM subscriptions s WHERE s.plan_code = 'pilot' AND NOT EXISTS (SELECT 1 FROM subscription_events e WHERE e.subscription_id = s.id);
