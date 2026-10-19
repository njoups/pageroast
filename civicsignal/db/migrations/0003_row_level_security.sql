-- 0003: RLS + grants. Everything is FORCEd so even the owner role (when not a superuser) is subject to it.

-- Plain tenant-scoped tables
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'projects','project_members','monitoring_queries','sources','connectors','connector_runs',
    'story_clusters','mentions','mention_entities','mention_topics','sentiment_results',
    'alert_rules','alert_events','reports','report_sources','subscriptions','usage_records','retention_policies'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant())$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO civicsignal_app', t);
  END LOOP;
END $$;

-- invitations: tenant-scoped, plus system context for token redemption.
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY; ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
CREATE POLICY invitations_access ON invitations
  USING (tenant_id = app_current_tenant() OR app_is_system())
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO civicsignal_app;

-- memberships: visible within the active tenant, or the caller's own rows (to list "my organisations").
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY; ALTER TABLE memberships FORCE ROW LEVEL SECURITY;
CREATE POLICY memberships_select ON memberships FOR SELECT
  USING (tenant_id = app_current_tenant() OR user_id = app_current_user() OR app_is_system());
CREATE POLICY memberships_write ON memberships FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant() OR app_is_system());
CREATE POLICY memberships_update ON memberships FOR UPDATE
  USING (tenant_id = app_current_tenant()) WITH CHECK (tenant_id = app_current_tenant());
CREATE POLICY memberships_delete ON memberships FOR DELETE USING (tenant_id = app_current_tenant());
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships TO civicsignal_app;

-- tenants: the active tenant, or any tenant the caller belongs to; creation only in system context.
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY; ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenants_select ON tenants FOR SELECT USING (
  id = app_current_tenant() OR app_is_system()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = tenants.id AND m.user_id = app_current_user()));
CREATE POLICY tenants_insert ON tenants FOR INSERT WITH CHECK (app_is_system());
CREATE POLICY tenants_update ON tenants FOR UPDATE USING (id = app_current_tenant()) WITH CHECK (id = app_current_tenant());
CREATE POLICY tenants_delete ON tenants FOR DELETE USING (app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON tenants TO civicsignal_app;

-- users: self, co-members of the active tenant, or system context (login / registration).
ALTER TABLE users ENABLE ROW LEVEL SECURITY; ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY users_select ON users FOR SELECT USING (
  id = app_current_user() OR app_is_system()
  OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.tenant_id = app_current_tenant()));
CREATE POLICY users_insert ON users FOR INSERT WITH CHECK (app_is_system());
CREATE POLICY users_update ON users FOR UPDATE USING (id = app_current_user() OR app_is_system())
  WITH CHECK (id = app_current_user() OR app_is_system());
GRANT SELECT, INSERT, UPDATE ON users TO civicsignal_app;

-- sessions: owner or system only.
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY; ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
CREATE POLICY sessions_access ON sessions USING (user_id = app_current_user() OR app_is_system())
  WITH CHECK (user_id = app_current_user() OR app_is_system());
GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO civicsignal_app;

-- audit_events: append-only. Readable within the tenant; insertable in tenant or system context.
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY; ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_select ON audit_events FOR SELECT USING (tenant_id = app_current_tenant());
CREATE POLICY audit_insert ON audit_events FOR INSERT
  WITH CHECK (tenant_id = app_current_tenant() OR (tenant_id IS NULL AND app_is_system()));
GRANT SELECT, INSERT ON audit_events TO civicsignal_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO civicsignal_app;
GRANT EXECUTE ON FUNCTION app_current_tenant(), app_current_user(), app_is_system() TO civicsignal_app;
