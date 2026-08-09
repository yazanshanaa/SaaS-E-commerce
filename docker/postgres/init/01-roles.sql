-- Runs once, as superuser, when the dev postgres volume is first created.
--
-- The three roles exist OUTSIDE the migrations because a role is a cluster-level object,
-- not a schema object: migrations must be replayable against a database whose roles were
-- provisioned by the deployment (docs/BUILD-KIT.md Part 6). Migration 0001 creates them
-- NOLOGIN if they are missing, so a fresh clone still migrates — this file is what gives
-- them a password so the app can actually connect.
--
-- No BYPASSRLS on any of them. Migration 0001 refuses to run if that ever changes.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_web') THEN
    CREATE ROLE app_web LOGIN PASSWORD 'app_web';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_system') THEN
    CREATE ROLE app_system LOGIN PASSWORD 'app_system';
  END IF;

  -- Owns the schema. Used by `prisma migrate` only — never by the running application.
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrate') THEN
    CREATE ROLE app_migrate LOGIN PASSWORD 'app_migrate' CREATEDB;
  END IF;
END
$$;

GRANT ALL ON DATABASE souq_bartaa TO app_migrate;
ALTER DATABASE souq_bartaa OWNER TO app_migrate;

-- `prisma migrate dev` needs a shadow database it may drop and recreate.
CREATE DATABASE souq_bartaa_shadow OWNER app_migrate;

\connect souq_bartaa
GRANT ALL ON SCHEMA public TO app_migrate;
ALTER SCHEMA public OWNER TO app_migrate;
GRANT USAGE ON SCHEMA public TO app_web, app_system;
