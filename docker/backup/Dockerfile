# The backup sidecar.
#
# Based on the postgres image rather than a bare Alpine so that `pg_dump` and `pg_restore` are
# EXACTLY the server's version. A dump taken by a newer client against an older server is a
# support case waiting to happen, and a restore attempted with an older client against a newer
# dump simply refuses — which is the failure you discover on the worst day.
#
# Three tools on top:
#   age     — authenticated encryption (X25519 + ChaCha20-Poly1305). Chosen over `openssl enc`
#             because `openssl enc` is unauthenticated: a truncated or tampered dump decrypts to
#             garbage and pg_restore tells you about it halfway through. age also lets the backup
#             host hold only the RECIPIENT (public) key, so compromising this server does not hand
#             the attacker its own history — the identity lives off the box (docs/DEPLOY.md).
#   aws-cli — R2 is the S3 API. `aws s3 --endpoint-url` is the path every runbook reader knows.
#   tini    — the container's job is a supervision loop; PID 1 must reap and forward signals or
#             `docker compose down` waits out its timeout on every deploy.
#   redis   — Phase 10 (Q23): the owner's "run now" button. The web container cannot take a backup
#             (no client tools, no age, no write credentials — deliberately, because it is the one
#             process reachable from the internet), so it leaves a key in Redis and this container
#             picks it up. Optional at runtime: with no REDIS_URL the loop is exactly what it was.

ARG POSTGRES_VERSION=16
FROM postgres:${POSTGRES_VERSION}-alpine

RUN apk add --no-cache \
      age \
      aws-cli \
      coreutils \
      redis \
      tini

COPY backup.sh /usr/local/bin/backup.sh
COPY restore.sh /usr/local/bin/restore.sh
RUN chmod +x /usr/local/bin/backup.sh /usr/local/bin/restore.sh

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/usr/local/bin/backup.sh", "loop"]
