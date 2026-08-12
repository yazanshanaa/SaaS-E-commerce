#!/bin/sh
#
# The other half of Q10. A backup you have never restored does not exist, so this is not a
# convenience script — it is the thing the monthly staging test runs, and the thing an operator
# runs on the worst day of the year without reading first.
#
#   restore.sh list                          — what is in the bucket, newest first
#   restore.sh show   <stamp>                — the manifest for one round (incl. the restore point)
#   restore.sh fetch  <stamp> <database>     — download and DECRYPT to BACKUP_WORKDIR, verify, stop
#   restore.sh into   <stamp> <database> <target-database>
#                                            — the whole path: fetch, verify, drop-and-recreate the
#                                              target, pg_restore into it
#
# Decryption needs the age IDENTITY, which is deliberately NOT on the production host: pass it in
# for the duration of the restore (AGE_IDENTITY_FILE), from wherever it is actually kept. If this
# script could decrypt on its own, compromising the server would hand over every historical backup
# as well as the live database, and the encryption would be protecting the bucket from Cloudflare
# rather than the data from an attacker.
#
# `into` REFUSES to write to the live application database. Restoring over production is a real
# operation, but it is not this one, and the version of it that is safe to automate does not exist.
# Restore to a new name, verify it, then swap — the procedure is in docs/DEPLOY.md.
#
# BEFORE YOU RESTORE ANYTHING, CAPTURE THE TOMBSTONES. `TenantTombstone` is global and survives the
# tenant cascade, but it lives in the same DATABASE — so a dump taken at t0 carries the tombstones
# as they were at t0, and every tenant purged after t0 comes back with no record that it was ever
# deleted. The list has to come from a database NEWER than the dump, which means capturing it from
# the live one first. It cannot be done afterwards. `docs/DEPLOY.md` -> 'Purge replay'.

set -eu

log()  { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [restore] $*" >&2; }
fail() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [restore] ERROR $*" >&2; }

require() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    fail "$1 is not set. $2"
    exit 78
  fi
}

require R2_BACKUP_BUCKET   'The bucket the backups are in.'
require R2_BACKUP_ENDPOINT 'The R2 S3 endpoint.'
require AWS_ACCESS_KEY_ID     'R2 credentials for the backup bucket.'
require AWS_SECRET_ACCESS_KEY 'R2 credentials for the backup bucket.'

: "${BACKUP_PREFIX:=souq-bartaa}"
: "${BACKUP_WORKDIR:=/var/tmp/backup}"
: "${AGE_IDENTITY_FILE:=/run/secrets/age-identity}"
: "${PGPORT:=5432}"
: "${AWS_DEFAULT_REGION:=auto}"
export AWS_DEFAULT_REGION

s3() { aws --endpoint-url "$R2_BACKUP_ENDPOINT" "$@"; }

cmd_list() {
  s3 s3 ls "s3://${R2_BACKUP_BUCKET}/${BACKUP_PREFIX}/" --recursive \
    | grep 'manifest.json$' \
    | sort -r
}

# The manifest is the only thing this script prints on STDOUT, because `show` is the one
# subcommand whose output an operator pipes somewhere. Everything else is a diagnostic on stderr.
cmd_show() {
  stamp="$1"
  s3 s3 cp "s3://${R2_BACKUP_BUCKET}/${BACKUP_PREFIX}/${stamp}/manifest.json" - 2>/dev/null \
    || { fail "no manifest at ${stamp}. Run 'restore.sh list'."; exit 1; }
}

# The plaintext dump for a database always lands at the same path, so callers compute it rather
# than capturing it from stdout. The version that echoed the path and was read back through
# `$(cmd_fetch … | tail -1)` swallowed every failure inside it: `tail` exits 0 whatever it is fed,
# so `into` went on to DROP the target database on the strength of a download that never happened.
dump_path() {
  echo "${BACKUP_WORKDIR}/$1.dump"
}

cmd_fetch() {
  stamp="$1"
  database="$2"

  if [ ! -r "$AGE_IDENTITY_FILE" ]; then
    fail "cannot read the age identity at ${AGE_IDENTITY_FILE}."
    fail 'It is not kept on this host by design. Mount it for the duration of the restore:'
    fail '  docker compose -f docker-compose.prod.yml run --rm \'
    fail '    -v /path/to/identity.txt:/run/secrets/age-identity:ro \'
    fail '    backup restore.sh into <stamp> <database> <target>'
    return 78
  fi

  mkdir -p "$BACKUP_WORKDIR"
  sealed="${BACKUP_WORKDIR}/${database}.dump.age"
  plain=$(dump_path "$database")
  key="${BACKUP_PREFIX}/${stamp}/${database}.dump.age"

  log "downloading ${key}"
  rm -f "$plain" "$sealed"
  s3 s3 cp "s3://${R2_BACKUP_BUCKET}/${key}" "$sealed" --only-show-errors || {
    fail "could not download ${key}"
    return 1
  }

  log 'decrypting'
  age --decrypt --identity "$AGE_IDENTITY_FILE" --output "$plain" "$sealed" || {
    fail "could not decrypt ${key} with ${AGE_IDENTITY_FILE}."
    fail 'age is authenticated, so this is either the wrong identity or a corrupted object.'
    rm -f "$sealed" "$plain"
    return 1
  }
  rm -f "$sealed"

  # Same check the backup made on the way out, made again on the way in. age is authenticated, so
  # a tampered file would already have failed above; this catches the other half — an archive that
  # decrypts perfectly and was never a valid dump.
  if ! pg_restore --list "$plain" >/dev/null 2>&1; then
    fail "${plain} decrypted but is not a readable pg_dump archive."
    rm -f "$plain"
    return 1
  fi

  # The manifest recorded the plaintext SHA before encryption, for EVERY database in the round —
  # so the hash has to be picked out of the entry for THIS one. Splitting on `{` puts each entry
  # on its own line; grepping the whole manifest would always match the first database and quietly
  # "verify" n8n's dump against the application's hash.
  expected=$(cmd_show "$stamp" 2>/dev/null \
    | tr '{' '\n' \
    | grep "\"database\":\"${database}\"" \
    | sed -n 's/.*"plainSha256":"\([a-f0-9]*\)".*/\1/p' \
    | head -1 || true)
  actual=$(sha256sum "$plain" | cut -d' ' -f1)

  if [ -z "$expected" ]; then
    log "WARNING: the manifest has no entry for ${database}; integrity not cross-checked"
  elif [ "$expected" != "$actual" ]; then
    fail "sha256 mismatch for ${database}: manifest says ${expected}, the file is ${actual}."
    rm -f "$plain"
    return 1
  else
    log "sha256 matches the manifest"
  fi

  log "ready: ${plain}"
}

cmd_into() {
  stamp="$1"
  database="$2"
  target="$3"

  require PGHOST     'The cluster to restore INTO.'
  require PGUSER     'A role that may create and drop the target database.'
  require PGPASSWORD 'The password for PGUSER.'

  # The guard that makes this safe to have on the box at all.
  if [ "$target" = "${POSTGRES_DB:-souq_bartaa}" ]; then
    fail "refusing to restore over the live application database (${target})."
    fail 'Restore to a new name, verify it, then swap. docs/DEPLOY.md -> "Restoring".'
    exit 78
  fi

  # No pipe, no command substitution: a failure here must stop the script BEFORE the target
  # database is dropped.
  cmd_fetch "$stamp" "$database"
  plain=$(dump_path "$database")

  log "recreating ${target}"
  psql -v ON_ERROR_STOP=1 --dbname postgres -c "DROP DATABASE IF EXISTS \"${target}\""
  psql -v ON_ERROR_STOP=1 --dbname postgres -c "CREATE DATABASE \"${target}\""

  log "restoring into ${target}"
  # --no-owner because the dump was taken that way; roles belong to the deployment, not the dump.
  # Not --clean: the database was just created empty, and --clean on a fresh database emits a page
  # of errors that hide a real one.
  pg_restore --no-owner --no-privileges --dbname "$target" --jobs 4 "$plain"
  rm -f "$plain"

  log "restored ${database}@${stamp} into ${target}"
  log ''
  log 'NEXT, AND IT IS NOT OPTIONAL: this database now contains every tenant that was purged after'
  log 'the dump was taken — deletions this platform certified as complete, to merchants, in'
  log 'writing. Replay them:'
  log ''
  log "  restore.sh show ${stamp}          # read restorePoint out of the manifest"
  log '  pnpm purge:replay --restore-point <restorePoint> --tombstones <the file you captured'
  log '                     from the live database BEFORE this restore>'
  log ''
  log 'If you did not capture that file first, the tombstones for those tenants no longer exist'
  log 'anywhere — they were in this same database. docs/DEPLOY.md -> "Purge replay".'
}

case "${1:-}" in
  list)  cmd_list ;;
  show)  [ $# -eq 2 ] || { fail 'usage: restore.sh show <stamp>'; exit 2; }; cmd_show "$2" ;;
  fetch) [ $# -eq 3 ] || { fail 'usage: restore.sh fetch <stamp> <database>'; exit 2; }; cmd_fetch "$2" "$3" ;;
  into)  [ $# -eq 4 ] || { fail 'usage: restore.sh into <stamp> <database> <target-database>'; exit 2; }; cmd_into "$2" "$3" "$4" ;;
  *)
    cat >&2 <<'USAGE'
usage:
  restore.sh list
  restore.sh show  <stamp>
  restore.sh fetch <stamp> <database>
  restore.sh into  <stamp> <database> <target-database>

<stamp> is the YYYY/MM/DD/HHMMSSZ path segment printed by `list`.
Decryption needs AGE_IDENTITY_FILE, which is not kept on this host by design.

BEFORE restoring, capture the tombstone list from the LIVE database:
  pnpm purge:replay --capture tombstones.json
It cannot be recovered afterwards. docs/DEPLOY.md -> "Purge replay".
USAGE
    exit 2
    ;;
esac
