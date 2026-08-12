#!/bin/sh
#
# Encrypted off-site backups (Q10).
#
#   backup.sh once   — take one round of backups and exit (what CI, a pre-deploy step, or an
#                      operator debugging the pipeline wants)
#   backup.sh loop   — take one round immediately, then every BACKUP_INTERVAL_HOURS forever
#                      (what the compose runs)
#
# THE SCHEDULE IS BACKUP_INTERVAL_HOURS AND NOTHING ELSE. It is not a cron expression here and a
# number over there. `src/server/legal/facts.ts` interpolates that same variable into every
# tenant's generated Arabic privacy policy as a statement of fact, so a second place to configure
# the period is a second place for the published claim and the running schedule to diverge —
# silently, across every tenant, with no code path that notices. A sleep loop reads the number the
# policy publishes. That is the whole reason it is a loop and not crond.
#
# WHAT THIS SCRIPT DELIBERATELY DOES NOT DO: delete old backups. Retention is an R2 lifecycle rule
# (BACKUP_RETENTION_DAYS), because a client-side delete loop stops deleting the moment the client
# is broken — and then every purged tenant stays restorable forever and Phase 6's deletion copy
# becomes untrue with nothing raising a hand. The rule is server-side and outlives this container.
# What the script does instead is CHECK on every run that the rule is there and says what we
# published, and complain in a way an operator cannot miss.
#
# EVERY DIAGNOSTIC GOES TO STDERR, and that is load-bearing rather than stylistic. An earlier
# version had `dump_database` return its manifest fragment on stdout while `log()` also wrote
# there, and the caller captured the lot in a command substitution: the manifest came out as log
# lines with JSON glued on the end — invalid, at exactly the place the restore runbook reads the
# restore point — and no per-database progress ever reached the container log. Results move
# through files; stdout is not a channel here.

set -eu

log()  { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [backup] $*" >&2; }
fail() { echo "$(date -u '+%Y-%m-%dT%H:%M:%SZ') [backup] ERROR $*" >&2; }

require() {
  eval "value=\${$1:-}"
  if [ -z "$value" ]; then
    fail "$1 is not set. $2"
    exit 78
  fi
}

require PGHOST                'The database host to dump from.'
require PGUSER                'The role to dump as. It must be able to read every database in BACKUP_DATABASES.'
require PGPASSWORD            'The password for PGUSER.'
require BACKUP_DATABASES      'Comma-separated list of databases. Q9/Q10 require the application database AND the n8n database.'
require BACKUP_AGE_RECIPIENT  'The age PUBLIC key backups are encrypted to. The matching identity must NOT live on this server.'
require R2_BACKUP_BUCKET      'The R2 bucket backups are pushed to. Never leave a backup only on the server.'
require R2_BACKUP_ENDPOINT    'The R2 S3 endpoint, https://<account-id>.r2.cloudflarestorage.com.'
require AWS_ACCESS_KEY_ID     'R2 credentials for the backup bucket.'
require AWS_SECRET_ACCESS_KEY 'R2 credentials for the backup bucket.'

: "${PGPORT:=5432}"
: "${BACKUP_INTERVAL_HOURS:=6}"
: "${BACKUP_RETENTION_DAYS:=14}"
: "${BACKUP_PREFIX:=souq-bartaa}"
: "${BACKUP_WORKDIR:=/var/tmp/backup}"
: "${BACKUP_HEARTBEAT_URL:=}"
: "${AWS_DEFAULT_REGION:=auto}"
export AWS_DEFAULT_REGION

s3() { aws --endpoint-url "$R2_BACKUP_ENDPOINT" "$@"; }

# The age recipient is a public key by construction. Refusing an identity here is not pedantry:
# an operator who pastes `AGE-SECRET-KEY-...` into this variable has put the decryption key on the
# machine whose compromise the encryption exists to survive, and everything downstream would still
# appear to work.
case "$BACKUP_AGE_RECIPIENT" in
  AGE-SECRET-KEY-*)
    fail 'BACKUP_AGE_RECIPIENT holds an age IDENTITY (secret key), not a recipient (public key).'
    fail 'Putting the private key on the backup host defeats the encryption. Use the age1... public key.'
    exit 78
    ;;
esac

# --- retention: verify the ceiling exists, every run ------------------------------------------
check_lifecycle() {
  configuration=$(s3 s3api get-bucket-lifecycle-configuration --bucket "$R2_BACKUP_BUCKET" 2>/dev/null || true)

  if [ -z "$configuration" ]; then
    fail "no lifecycle configuration on bucket ${R2_BACKUP_BUCKET}."
    fail "Backups will accumulate FOREVER, which makes every purged tenant permanently restorable"
    fail "and the retention sentence in every tenant's privacy policy untrue."
    fail "Fix: docs/DEPLOY.md -> 'Backup retention'. This run continues; taking a backup is still"
    fail "better than not taking one."
    return 0
  fi

  # `aws ... --output json` renders `"Days": 14`; `--output text` renders a bare column. Accept
  # either rather than pinning the operator's AWS_DEFAULT_OUTPUT.
  if ! echo "$configuration" | grep -Eq "(\"Days\"[[:space:]]*:[[:space:]]*${BACKUP_RETENTION_DAYS}\b|[[:space:]]${BACKUP_RETENTION_DAYS}\b)"; then
    fail "the bucket lifecycle rule does not expire objects at ${BACKUP_RETENTION_DAYS} days,"
    fail "which is the number BACKUP_RETENTION_DAYS publishes in every tenant's privacy policy."
    fail "Current configuration: $(echo "$configuration" | tr -d '\n')"
  fi
}

# --- one database ------------------------------------------------------------------------------
#
# Returns 0 only when the object is on R2 at the size we sent. Every step is checked EXPLICITLY
# with `|| { ...; return 1; }` rather than left to `set -e`, because `set -e` is suspended inside
# a command substitution used as an `if` condition — which is exactly how this used to be called.
# A failing `age` or `aws s3 cp` then left the function falling through to its final statement and
# returning 0: the round reported zero failures, the manifest listed the database, the heartbeat
# fired, and the monitor stayed green over a backup that does not exist.
#
# The manifest fragment is APPENDED TO A FILE, not printed, so no diagnostic can ever end up
# inside it.
dump_database() {
  database="$1"
  stamp="$2"
  entries_file="$3"

  plain="${BACKUP_WORKDIR}/${database}.dump"
  sealed="${plain}.age"
  key="${BACKUP_PREFIX}/${stamp}/${database}.dump.age"

  log "dumping ${database}"
  # --format=custom is what makes pg_restore able to be selective and parallel later, and it is
  # already compressed. --no-owner/--no-privileges keep a restore from depending on role names
  # that a staging cluster may not have — the roles are provisioned by the deployment, not by the
  # dump (docker/postgres/production-init).
  pg_dump --format=custom --no-owner --no-privileges --dbname "$database" --file "$plain" || {
    fail "pg_dump failed for ${database}"
    rm -f "$plain"
    return 1
  }

  # Verify BEFORE encrypting. `pg_restore --list` parses the archive's table of contents, so a
  # truncated or corrupt dump fails here — on the machine that made it, while there is still a
  # healthy database to try again against — rather than on the day of the restore.
  if ! pg_restore --list "$plain" >/dev/null 2>&1; then
    fail "the dump of ${database} is not a readable archive. Not uploading it."
    rm -f "$plain"
    return 1
  fi

  plain_bytes=$(wc -c < "$plain" | tr -d ' ')
  plain_sha=$(sha256sum "$plain" | cut -d' ' -f1)

  age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$sealed" "$plain" || {
    fail "age refused to encrypt ${database}. Check BACKUP_AGE_RECIPIENT."
    rm -f "$plain" "$sealed"
    return 1
  }
  rm -f "$plain"

  local_bytes=$(wc -c < "$sealed" | tr -d ' ')
  log "uploading ${key} (${local_bytes} bytes encrypted, ${plain_bytes} plain)"

  s3 s3 cp "$sealed" "s3://${R2_BACKUP_BUCKET}/${key}" --only-show-errors || {
    fail "upload of ${key} failed"
    rm -f "$sealed"
    return 1
  }

  # Confirm the object is actually there at the size we sent. `aws s3 cp` exiting 0 means the
  # request was accepted, and this is the cheap difference between that and "the backup exists".
  remote_bytes=$(s3 s3api head-object --bucket "$R2_BACKUP_BUCKET" --key "$key" \
    --query 'ContentLength' --output text 2>/dev/null) || {
    fail "${key} is not readable back from the bucket after upload"
    rm -f "$sealed"
    return 1
  }
  rm -f "$sealed"

  if [ "$local_bytes" != "$remote_bytes" ]; then
    fail "${key} uploaded as ${remote_bytes} bytes but was ${local_bytes} locally."
    return 1
  fi

  printf '%s{"database":"%s","key":"%s","plainBytes":%s,"plainSha256":"%s","encryptedBytes":%s}' \
    "$(cat "${entries_file}.sep" 2>/dev/null || true)" \
    "$database" "$key" "$plain_bytes" "$plain_sha" "$local_bytes" >> "$entries_file"
  printf ',' > "${entries_file}.sep"
  return 0
}

run_once() {
  mkdir -p "$BACKUP_WORKDIR"

  # THE RESTORE POINT IS STAMPED BEFORE ANY DUMP RUNS, and the direction matters.
  #
  # `scripts/purge-replay.ts` re-purges every tenant whose tombstone POSTDATES this instant. Stamp
  # it after the dumps and a tenant purged while the round was still running falls into the gap:
  # its rows are already absent from the application dump, but its tombstone looks older than the
  # restore point, so the replay skips it. Stamping first can only ever select MORE tombstones
  # than strictly necessary, and every extra one is a no-op — the error that costs nothing.
  restore_point=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  stamp=$(date -u '+%Y/%m/%d/%H%M%SZ')

  check_lifecycle

  entries_file="${BACKUP_WORKDIR}/entries.json"
  : > "$entries_file"
  rm -f "${entries_file}.sep"

  failures=0

  # `IFS` split rather than a bashism, because this is /bin/sh in an Alpine image.
  old_ifs="$IFS"
  IFS=','
  for database in $BACKUP_DATABASES; do
    IFS="$old_ifs"
    database=$(echo "$database" | tr -d ' ')
    if [ -n "$database" ]; then
      dump_database "$database" "$stamp" "$entries_file" || {
        failures=$((failures + 1))
        fail "backup of ${database} FAILED"
      }
    fi
    IFS=','
  done
  IFS="$old_ifs"

  # The manifest is what the restore runbook reads. `restorePoint` in particular is the value the
  # purge replay needs: after any restore, every tenant whose TenantTombstone.purgedAt is LATER
  # than this instant was alive in the dump and has just been resurrected, so purgeTenant has to
  # be re-run for each of them (docs/DEPLOY.md -> 'Purge replay'). Writing it here means the
  # operator does not have to infer it from an object key at three in the morning.
  manifest="${BACKUP_WORKDIR}/manifest.json"
  printf '{"restorePoint":"%s","stamp":"%s","retentionDays":%s,"intervalHours":%s,"failures":%s,"databases":[%s]}\n' \
    "$restore_point" "$stamp" "$BACKUP_RETENTION_DAYS" "$BACKUP_INTERVAL_HOURS" \
    "$failures" "$(cat "$entries_file")" > "$manifest"

  s3 s3 cp "$manifest" "s3://${R2_BACKUP_BUCKET}/${BACKUP_PREFIX}/${stamp}/manifest.json" --only-show-errors \
    || fail 'the manifest could not be uploaded; the dumps themselves are in place'

  rm -f "$manifest" "$entries_file" "${entries_file}.sep"

  if [ "$failures" -ne 0 ]; then
    fail "${failures} database(s) failed this round"
    return 1
  fi

  log "round complete: ${stamp}"
  return 0
}

# A heartbeat that fires only on success is the point. Uptime Kuma's push monitor alerts when it
# STOPS hearing, so a backup container that is running but failing every round is indistinguishable
# from a healthy one unless the ping is conditional (docs/DEPLOY.md -> 'Monitors').
#
# Kuma is reached INSIDE the compose network — `http://uptime-kuma:3001/api/push/<token>` — not
# through Caddy. The public hostname sits behind basic auth, which would answer 401 to a ping that
# carries no credentials, and the result would be an alert that fires on every healthy backup.
heartbeat() {
  [ -n "$BACKUP_HEARTBEAT_URL" ] || return 0
  wget --quiet --timeout=10 --tries=2 -O /dev/null "$BACKUP_HEARTBEAT_URL" \
    || fail 'heartbeat ping failed (the backup itself succeeded)'
}

case "${1:-once}" in
  once)
    run_once && heartbeat
    ;;
  loop)
    interval=$((BACKUP_INTERVAL_HOURS * 3600))
    log "starting: every ${BACKUP_INTERVAL_HOURS}h, databases=${BACKUP_DATABASES}, bucket=${R2_BACKUP_BUCKET}"
    while true; do
      # A failed round must not kill the loop — the next one may well succeed, and a container
      # that exits on the first transient S3 error is a backup system that stops after its first
      # bad night and reports nothing but a restart count.
      if run_once; then
        heartbeat
      else
        fail 'round failed; continuing to the next interval'
      fi
      sleep "$interval"
    done
    ;;
  *)
    fail "usage: backup.sh [once|loop]"
    exit 2
    ;;
esac
