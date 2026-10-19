-- 0005: the app role inherited TEMP from PUBLIC. A temporary table named like a real one (e.g. "users") shadows it,
-- because pg_temp is searched first, and it would persist on a pooled connection. Revoke TEMP from PUBLIC.
DO $$ BEGIN
  EXECUTE format('REVOKE TEMPORARY ON DATABASE %I FROM PUBLIC', current_database());
END $$;
