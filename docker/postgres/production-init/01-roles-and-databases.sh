#!/bin/bash
#
# Runs ONCE, as superuser, when the production postgres volume is first created.
#
# This is a separate directory from `docker/postgres/init` on purpose. The dev compose mounts
# that one wholesale, so anything added there also runs on every developer's machine — and this
# script requires five secrets a development checkout has no reason to hold, and creates two
# databases development does not use. Two directories, two audiences, no `if $NODE_ENV` in SQL.
#
# Why roles live here rather than in a migration: a role is a cluster-level object, not a schema
# object, and migrations must stay replayable against a database whose roles were provisioned by
# the deployment (docs/BUILD-KIT.md Part 6). Migration 0001 creates all three NOLOGIN if they are
# missing, so a fresh clone still migrates; this file is what gives them a password so the
# application can actually connect — and, in production, what makes those passwords secrets
# rather than the role names.
#
# NO BYPASSRLS ANYWHERE. Migration 0001 raises and refuses to run if that ever changes, which is
# the check that matters: row-level security is the second layer of tenant isolation and a role
# that bypasses it makes the first layer the only one.

set -euo pipefail

require() {
  local name="$1"
  local why="$2"
  if [ -z "${!name:-}" ]; then
    echo "FATAL: $name is not set. $why" >&2
    echo "       Refusing to initialise the cluster with a guessable password." >&2
    exit 1
  fi
}

require APP_WEB_PASSWORD    'It is the password for the role every HTTP request runs as.'
require APP_SYSTEM_PASSWORD 'It is the password for the role the sweeps and the outbox dispatcher run as.'
require APP_MIGRATE_PASSWORD 'It is the password for the schema owner.'
require N8N_DB_PASSWORD     'n8n gets its OWN database (Q9), which needs its own owner.'
require UMAMI_DB_PASSWORD   'Umami gets its own database, which needs its own owner.'

: "${N8N_DB_NAME:=n8n}"
: "${UMAMI_DB_NAME:=umami}"

psql_super() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" "$@"
}

role_exists() {
  [ "$(psql_super -tAc "SELECT 1 FROM pg_roles WHERE rolname = '$1'")" = '1' ]
}

database_exists() {
  [ "$(psql_super -tAc "SELECT 1 FROM pg_database WHERE datname = '$1'")" = '1' ]
}

# The password is passed as a psql variable and rendered with :'pw', which quotes and escapes it.
# Interpolating it into the SQL string in shell would break on the first apostrophe and would put
# the secret in the process table.
ensure_role() {
  local role="$1" password="$2" attributes="${3:-}"
  if role_exists "$role"; then
    psql_super -v pw="$password" -c "ALTER ROLE ${role} LOGIN PASSWORD :'pw' ${attributes}"
    echo "role ${role}: password set"
  else
    psql_super -v pw="$password" -c "CREATE ROLE ${role} LOGIN PASSWORD :'pw' ${attributes}"
    echo "role ${role}: created"
  fi
}

ensure_database() {
  local name="$1" owner="$2"
  if database_exists "$name"; then
    echo "database ${name}: already present"
  else
    psql_super -c "CREATE DATABASE \"${name}\" OWNER \"${owner}\""
    echo "database ${name}: created"
  fi
}

# --- the three application roles -------------------------------------------------------------
ensure_role app_web "$APP_WEB_PASSWORD"
ensure_role app_system "$APP_SYSTEM_PASSWORD"
# Owns the schema. Used by `prisma migrate deploy` only — never by the running application.
# CREATEDB is NOT granted here, unlike development: production runs `migrate deploy`, which needs
# no shadow database, and a schema owner that can create databases is authority nobody needs.
ensure_role app_migrate "$APP_MIGRATE_PASSWORD"

psql_super <<EOSQL
GRANT ALL ON DATABASE "${POSTGRES_DB}" TO app_migrate;
ALTER DATABASE "${POSTGRES_DB}" OWNER TO app_migrate;
EOSQL

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'EOSQL'
GRANT ALL ON SCHEMA public TO app_migrate;
ALTER SCHEMA public OWNER TO app_migrate;
GRANT USAGE ON SCHEMA public TO app_web, app_system;
EOSQL

# --- n8n: its OWN database, not a schema in the application database (Q9) ----------------------
#
# The reason is blast radius, not tidiness. n8n's execution history stores every node's input and
# output, which on this platform means delivered export links and merchant phone numbers. Sharing
# a database would put that under the same connection, the same roles and the same RLS surface as
# the tenant data — and n8n knows nothing about any of it. Its own database, its own owner, and a
# hard prune (N8N_EXECUTIONS_DATA_MAX_AGE) is the containment.
ensure_role n8n "$N8N_DB_PASSWORD"
ensure_database "$N8N_DB_NAME" n8n

# --- Umami: same reasoning, its own database and owner ----------------------------------------
ensure_role umami "$UMAMI_DB_PASSWORD"
ensure_database "$UMAMI_DB_NAME" umami

# Neither of those two roles may reach the application database. Postgres grants CONNECT on every
# database to PUBLIC by default, so this is a revoke rather than an omission — without it, the
# analytics container's credentials would open a session against the tenant data and only RLS
# would be standing between them and it.
psql_super <<EOSQL
REVOKE ALL ON DATABASE "${POSTGRES_DB}" FROM PUBLIC;
GRANT CONNECT ON DATABASE "${POSTGRES_DB}" TO app_web, app_system, app_migrate;
EOSQL

echo "production cluster initialised: app roles, ${N8N_DB_NAME}, ${UMAMI_DB_NAME}"
