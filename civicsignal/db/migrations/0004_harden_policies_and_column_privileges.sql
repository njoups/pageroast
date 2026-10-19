-- 0004: foundation-audit hardening (see docs/IMPLEMENTATION_STATUS.md).

-- 1. The "caller's own rows" branches of memberships/tenants applied even inside a tenant context, so tenant-scoped
--    queries by a user who belongs to several organizations returned rows from their *other* organizations
--    (e.g. duplicated team lists). Restrict those branches to user-only context (no tenant set).
DROP POLICY memberships_select ON memberships;
CREATE POLICY memberships_select ON memberships FOR SELECT USING (
  tenant_id = app_current_tenant()
  OR (app_current_tenant() IS NULL AND user_id = app_current_user())
  OR app_is_system());

DROP POLICY tenants_select ON tenants;
CREATE POLICY tenants_select ON tenants FOR SELECT USING (
  id = app_current_tenant() OR app_is_system()
  OR (app_current_tenant() IS NULL AND EXISTS (
        SELECT 1 FROM memberships m WHERE m.tenant_id = tenants.id AND m.user_id = app_current_user())));

-- 2. Column-level privileges: the app role could previously set users.is_platform_admin on its own row (or on insert in
--    system context) and rewrite membership tenant/user ids. Only the columns the API legitimately writes are granted.
REVOKE INSERT, UPDATE ON users FROM civicsignal_app;
GRANT INSERT (email, display_name, password_hash) ON users TO civicsignal_app;
GRANT UPDATE (display_name, password_hash) ON users TO civicsignal_app;

REVOKE UPDATE ON memberships FROM civicsignal_app;
GRANT UPDATE (role) ON memberships TO civicsignal_app;

REVOKE UPDATE ON sessions FROM civicsignal_app;
GRANT UPDATE (revoked_at) ON sessions TO civicsignal_app;

REVOKE UPDATE ON invitations FROM civicsignal_app;
GRANT UPDATE (accepted_at, revoked_at) ON invitations TO civicsignal_app;

REVOKE UPDATE ON tenants FROM civicsignal_app;
GRANT UPDATE (name, settings, archived_at) ON tenants TO civicsignal_app;
