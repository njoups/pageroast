-- Fingerprint of the application role's privileges (grantor-independent), one line per object:
--   acl <table> <privs> · acl-col <table>.<column> <privs> · acl-fn <function> <privs>
-- Used by backup.sh (manifest) and verify-restore.sh (comparison after restore).
SELECT format('acl %s %s', c.relname, coalesce((SELECT string_agg(x.privilege_type, ',' ORDER BY x.privilege_type)
         FROM aclexplode(c.relacl) x WHERE x.grantee = 'civicsignal_app'::regrole), '-'))
FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'v', 'S') ORDER BY c.relname;
SELECT format('acl-col %s.%s %s', c.relname, a.attname, string_agg(x.privilege_type, ',' ORDER BY x.privilege_type))
FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attacl IS NOT NULL, aclexplode(a.attacl) x
WHERE c.relnamespace = 'public'::regnamespace AND x.grantee = 'civicsignal_app'::regrole
GROUP BY c.relname, a.attname ORDER BY c.relname, a.attname;
SELECT format('acl-fn %s %s', p.oid::regprocedure, coalesce((SELECT string_agg(CASE WHEN x.grantee = 0 THEN 'PUBLIC:' ELSE 'app:' END || x.privilege_type, ',' ORDER BY 1)
         FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x WHERE x.grantee IN ('civicsignal_app'::regrole, 0)), '-'))
FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace ORDER BY 1;
SELECT format('acl-schema public %s', coalesce((SELECT string_agg(x.privilege_type, ',' ORDER BY x.privilege_type)
         FROM aclexplode(n.nspacl) x WHERE x.grantee = 'civicsignal_app'::regrole), '-')) FROM pg_namespace n WHERE n.nspname = 'public';
