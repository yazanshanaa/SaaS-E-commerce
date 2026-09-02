#!/usr/bin/env bash
# =============================================================================
# Souq Bartaa — Hostinger VPS provisioning, stage 1
#
# Runs as root, once, right after the VM is recreated on the Hostinger template
# "Ubuntu 24.04 with Docker" (id 1121).
#
# CONTAINS NO CREDENTIALS. Hostinger stores post-install scripts in the account
# and they are readable through the API, so every secret this platform needs is
# GENERATED HERE and never leaves the machine. The credentials that cannot be
# generated — Cloudflare, R2, Resend, the age recipient — are filled in stage 2,
# by hand, on the box. See /root/SOUQ-READY.txt when this finishes.
#
# What it does NOT do, deliberately:
#   - clone the repository (private; the deploy key it generates has to be added
#     to GitHub first — that is the whole point of the two stages)
#   - generate the age backup identity (docs/DEPLOY.md §2: the identity must not
#     live on this server, or a stolen box is fourteen days of every tenant)
#   - start anything. Nothing listens on 80/443 until stage 2 boots the stack.
# =============================================================================

set -euo pipefail
exec > >(tee -a /var/log/souq-provision.log) 2>&1
echo "=== souq-bartaa provisioning started $(date -Is) ==="

APP_DIR=/srv/souq-bartaa
APP_USER=souq
REPO_SSH=git@github.com:yazanshanaa/SaaS-E-commerce.git
export DEBIAN_FRONTEND=noninteractive

# --- 1. Base packages -------------------------------------------------------
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl git ufw fail2ban age openssl jq python3 \
  unattended-upgrades apt-transport-https gnupg

# --- 2. Docker Engine + Compose V2 ------------------------------------------
# The template ships Docker. Verify rather than trust, and repair if it did not.
if ! command -v docker >/dev/null 2>&1; then
  echo "--- docker missing, installing from Docker's own repo ---"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
# The stack uses `docker compose` (V2). V1's `docker-compose` is not a fallback.
docker compose version

# --- 3. Swap ----------------------------------------------------------------
# 8 GB of RAM is comfortable, but `next build` and Sharp both spike and the OOM
# killer picks by RSS — which is the web container. docs/DEPLOY.md §1.
if ! swapon --show=NAME --noheadings | grep -q '^/swapfile$'; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
sysctl -w vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.conf || echo 'vm.swappiness=10' >> /etc/sysctl.conf

# --- 4. Firewall ------------------------------------------------------------
# 22, 80, 443 and nothing else. Postgres and Redis are internal to the compose
# network and are never published. A Hostinger firewall group is applied on top
# of this from the API — two layers, one intent.
ufw --force reset
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose

# --- 5. fail2ban on sshd ----------------------------------------------------
cat > /etc/fail2ban/jail.d/sshd.local <<'JAIL'
[sshd]
enabled  = true
maxretry = 5
findtime = 10m
bantime  = 1h
JAIL
systemctl enable --now fail2ban

# --- 6. Unattended security upgrades ----------------------------------------
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'AUTO'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
AUTO

# --- 7. The application user and its directory ------------------------------
id -u "$APP_USER" >/dev/null 2>&1 || adduser --disabled-password --gecos '' "$APP_USER"
usermod -aG docker "$APP_USER"
mkdir -p "$APP_DIR"
chown "$APP_USER:$APP_USER" "$APP_DIR"

# --- 8. GitHub deploy key ---------------------------------------------------
# Generated on the box so the private half never exists anywhere else. The
# public half goes into /root/SOUQ-READY.txt for you to paste into the repo's
# Deploy keys (read-only is enough).
SSH_DIR="/home/$APP_USER/.ssh"
install -d -m 0700 -o "$APP_USER" -g "$APP_USER" "$SSH_DIR"
if [ ! -f "$SSH_DIR/github_deploy" ]; then
  sudo -u "$APP_USER" ssh-keygen -t ed25519 -N '' -C "souq-bartaa-vps-$(hostname)" -f "$SSH_DIR/github_deploy"
fi
ssh-keyscan -t rsa,ecdsa,ed25519 github.com > "$SSH_DIR/known_hosts" 2>/dev/null
cat > "$SSH_DIR/config" <<'SSHCFG'
Host github.com
  IdentityFile ~/.ssh/github_deploy
  IdentitiesOnly yes
  StrictHostKeyChecking yes
SSHCFG
chown -R "$APP_USER:$APP_USER" "$SSH_DIR"
chmod 600 "$SSH_DIR/config" "$SSH_DIR/github_deploy"
chmod 644 "$SSH_DIR/config" 2>/dev/null || true
chmod 600 "$SSH_DIR/config"

# --- 9. Generated secrets ---------------------------------------------------
# Two shapes on purpose:
#   b64  — opaque 32-byte secrets (auth, encryption, HMAC). base64 never
#          contains '$', so compose interpolation cannot mangle them.
#   hex  — anything that ends up inside a URL (postgres://, redis://). base64's
#          '/' and '+' would need percent-encoding and one day would not get it.
b64() { openssl rand -base64 32 | tr -d '\n'; }
hex() { openssl rand -hex 24 | tr -d '\n'; }

ENV_GEN="$APP_DIR/.env.generated"
umask 077

SUPER_ADMIN_PW="Sb$(openssl rand -hex 16)!9Aa"
N8N_PROXY_PW="$(openssl rand -hex 12)"

# Caddy basic-auth hash for n8n / Umami / Uptime Kuma, with every '$' doubled
# because compose interpolates '$' inside .env values (.env.example, §n8n).
N8N_PROXY_HASH_RAW="$(docker run --rm caddy:2 caddy hash-password --plaintext "$N8N_PROXY_PW" 2>/dev/null | tr -d '\n' || true)"
if [ -n "$N8N_PROXY_HASH_RAW" ]; then
  N8N_PROXY_HASH_ESCAPED="$(printf '%s' "$N8N_PROXY_HASH_RAW" | sed 's/\$/$$/g')"
else
  N8N_PROXY_HASH_ESCAPED=""
fi

cat > "$ENV_GEN" <<GEN
# Generated on $(date -Is) by hostinger-post-install.sh. Merged into .env by
# /root/souq-stage2.sh. Every value below was created on this machine.
BETTER_AUTH_SECRET=$(b64)
ENCRYPTION_KEY=$(b64)
WEBHOOK_HMAC_SECRET=$(b64)
INTERNAL_API_SECRET=$(b64)
N8N_ENCRYPTION_KEY=$(b64)
UMAMI_APP_SECRET=$(b64)
POSTGRES_SUPERUSER_PASSWORD=$(hex)
APP_WEB_PASSWORD=$(hex)
APP_SYSTEM_PASSWORD=$(hex)
APP_MIGRATE_PASSWORD=$(hex)
REDIS_PASSWORD=$(hex)
N8N_DB_PASSWORD=$(hex)
UMAMI_DB_PASSWORD=$(hex)
SEED_SUPER_ADMIN_PASSWORD=$SUPER_ADMIN_PW
N8N_PROXY_AUTH_USER=souq
N8N_PROXY_AUTH_HASH=$N8N_PROXY_HASH_ESCAPED
GEN
chown "$APP_USER:$APP_USER" "$ENV_GEN"
chmod 600 "$ENV_GEN"

# --- 10. Stage 2: clone + env merge ----------------------------------------
cat > /root/souq-stage2.sh <<'STAGE2'
#!/usr/bin/env bash
# Stage 2 — run this AFTER the deploy key from /root/SOUQ-READY.txt is added to
# the GitHub repository. Clones the platform and builds .env from .env.example
# plus the values generated during provisioning. Does not start anything.
set -euo pipefail
APP_DIR=/srv/souq-bartaa
APP_USER=souq

if [ ! -d "$APP_DIR/.git" ]; then
  echo "--- cloning ---"
  sudo -u "$APP_USER" git clone git@github.com:yazanshanaa/SaaS-E-commerce.git "$APP_DIR/repo"
  shopt -s dotglob
  mv "$APP_DIR/repo"/* "$APP_DIR"/
  rmdir "$APP_DIR/repo"
  chown -R "$APP_USER:$APP_USER" "$APP_DIR"
fi

cd "$APP_DIR"
[ -f .env ] || sudo -u "$APP_USER" cp .env.example .env

python3 - <<'PY'
import re
env_path = '/srv/souq-bartaa/.env'
gen_path = '/srv/souq-bartaa/.env.generated'

generated = {}
for line in open(gen_path, encoding='utf-8'):
    line = line.strip()
    if not line or line.startswith('#') or '=' not in line:
        continue
    k, v = line.split('=', 1)
    generated[k.strip()] = v

# Values that follow from this being a production box rather than a laptop.
fixed = {
    'NODE_ENV': 'production',
    'PUBLIC_SCHEME': 'https',
    'LOG_LEVEL': 'info',
    'STORAGE_DRIVER': 'r2',
    'MAIL_DRIVER': 'resend',
    'SENTRY_ENVIRONMENT': 'production',
    'INTERNAL_BASE_URL': 'http://web:3000',
    'TRUST_CLOUDFLARE': 'true',
}
generated.update(fixed)

lines = open(env_path, encoding='utf-8').read().split('\n')
seen = set()
out = []
for line in lines:
    m = re.match(r'^\s*#?\s*([A-Z0-9_]+)=', line)
    if m and m.group(1) in generated and m.group(1) not in seen:
        key = m.group(1)
        out.append(f'{key}={generated[key]}')
        seen.add(key)
    else:
        out.append(line)
for key, value in generated.items():
    if key not in seen:
        out.append(f'{key}={value}')
open(env_path, 'w', encoding='utf-8').write('\n'.join(out))
print(f'merged {len(seen)} generated keys into .env')
PY

chown "$APP_USER:$APP_USER" .env
chmod 600 .env

echo
echo "=== .env keys still EMPTY — nothing boots until these are filled ==="
grep -nE '^[A-Z0-9_]+=$' .env || echo '(none)'
echo
echo "The ones that actually block a boot:"
cat <<'BLOCKERS'
  DOMAIN                          your real domain, no scheme
  BETTER_AUTH_URL                 https://app.<DOMAIN>
  MAIL_FROM / MAIL_REPLY_TO       on <DOMAIN>, SPF+DKIM+DMARC per docs/EMAIL.md
  SEED_SUPER_ADMIN_EMAIL          your address (the example default must never ship)
  ACME_EMAIL / VAPID_SUBJECT      your address
  CLOUDFLARE_API_TOKEN            scoped Zone:DNS:Edit — the wildcard cert
  CLOUDFLARE_ZONE_ID
  R2_ACCOUNT_ID / R2_ENDPOINT
  R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY          media pair
  R2_BACKUP_ACCESS_KEY_ID / R2_BACKUP_SECRET_ACCESS_KEY    write pair
  R2_BACKUP_READ_ACCESS_KEY_ID / R2_BACKUP_READ_SECRET_ACCESS_KEY   read-only
  CDN_PUBLIC_BASE_URL             the CDN in front of R2, origin limited to media/
  BACKUP_AGE_RECIPIENT            age1... PUBLIC key. The identity stays OFF this box
  RESEND_API_KEY
  VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY   npx web-push generate-vapid-keys
BLOCKERS
echo
echo "Then: /root/souq-boot.sh"
STAGE2
chmod 700 /root/souq-stage2.sh

# --- 11. Boot ---------------------------------------------------------------
cat > /root/souq-boot.sh <<'BOOT'
#!/usr/bin/env bash
# docs/DEPLOY.md §4. CDN_PUBLIC_BASE_URL and PUBLIC_SCHEME are BUILD-time args,
# so a change to either needs a rebuild, not a restart.
set -euo pipefail
cd /srv/souq-bartaa
COMPOSE="docker compose -f docker-compose.prod.yml"

$COMPOSE build
$COMPOSE up -d
echo "--- migrate (one-shot; web and worker wait on it) ---"
$COMPOSE logs migrate
echo "--- seed: super admin, three plans, hidden demo plan, nine templates ---"
$COMPOSE exec -T web pnpm db:seed
$COMPOSE ps
BOOT
chmod 700 /root/souq-boot.sh

# --- 12. Gates --------------------------------------------------------------
# The reason this box matters beyond hosting: the checkout has had no toolchain
# since 2026-08-24, so nothing in Phase 11 has ever been typechecked or built.
cat > /root/souq-gates.sh <<'GATES'
#!/usr/bin/env bash
# First real run of the project's own gates. Continues past each failure so one
# pass produces the whole list rather than the first line of it.
set -uo pipefail
cd /srv/souq-bartaa
LOG=/root/souq-gates.log
: > "$LOG"
run() { echo -e "\n\n##### $* #####" | tee -a "$LOG"; "$@" 2>&1 | tee -a "$LOG"; echo "-> exit $?" | tee -a "$LOG"; }

run corepack enable
run pnpm install --frozen-lockfile
run node scripts/fetch-rubik.mjs        # public/fonts/rubik/ is empty by design
run pnpm exec prisma migrate status
run pnpm typecheck
run pnpm lint
run pnpm test
run pnpm build
echo -e "\nfull log: $LOG"
GATES
chmod 700 /root/souq-gates.sh

# --- 13. The handover note --------------------------------------------------
cat > /root/SOUQ-READY.txt <<READY
Souq Bartaa — VPS provisioned $(date -Is)
=============================================================================

DONE
  Docker $(docker --version | awk '{print $3}' | tr -d ,) + compose $(docker compose version --short)
  ufw: 22, 80, 443 only        fail2ban on sshd        2 GB swap
  user 'souq' in the docker group, owning /srv/souq-bartaa
  every self-generated secret written to /srv/souq-bartaa/.env.generated (0600)

WRITE THESE DOWN NOW — they are not recoverable from anywhere else
-----------------------------------------------------------------------------
  Super admin password (seeded):   $SUPER_ADMIN_PW
  n8n / Umami / Kuma basic auth:   souq  /  $N8N_PROXY_PW

STEP 1 — add this as a read-only Deploy key on the repository
  https://github.com/yazanshanaa/SaaS-E-commerce/settings/keys

$(cat "$SSH_DIR/github_deploy.pub")

STEP 2 — clone and build .env
  /root/souq-stage2.sh
  Then edit /srv/souq-bartaa/.env and fill the keys it lists.

STEP 3 — the gates BEFORE the boot
  /root/souq-gates.sh
  Phase 11 has never been typechecked, linted, tested or built. Expect
  failures; that is the point of running it here rather than discovering it
  during 'docker compose build'.

STEP 4 — boot
  /root/souq-boot.sh

STILL YOURS, AND NOT AUTOMATABLE (docs/DEPLOY.md §9)
  - age-keygen on YOUR machine, not this one. Put age1... in
    BACKUP_AGE_RECIPIENT; keep AGE-SECRET-KEY-... in a password manager.
  - R2 lifecycle rule at BACKUP_RETENTION_DAYS.
  - CDN origin restricted to the media/ segment.
  - First-run setup on n8n, Umami and Uptime Kuma IMMEDIATELY after the boot:
    whoever arrives first owns them, and basic auth in front is not a reason
    to leave that window open.
  - One real restore drill before any merchant is onboarded.
READY
chmod 600 /root/SOUQ-READY.txt

echo "=== provisioning finished $(date -Is) — read /root/SOUQ-READY.txt ==="
