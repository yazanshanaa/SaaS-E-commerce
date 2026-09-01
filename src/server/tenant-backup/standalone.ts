// `FeatureSet` lives in the entitlements module, not in `@/shared/features` — the shared file
// declares the KEYS and their value types, and the resolved SET is a server concern.
import type { FeatureSet } from '@/server/entitlements';
import type { ZipEntry } from '@/server/export/zip';
import type { BackupContents } from './types';

/**
 * Everything in a standalone bundle that is not code and not data (Q25).
 *
 * Generated as STRINGS in one file rather than kept as template files on disk, for a reason worth
 * stating: these five documents have to agree with each other exactly — the compose's service names
 * are what the bootstrap waits for, the env template's variable names are what the compose passes,
 * and the README's instructions are what the bootstrap actually does. Split across five files that
 * nothing type-checks, they drift, and the first person to discover it is a merchant's web person
 * on a server we have never seen. Here a rename is one edit.
 *
 * NOTHING SECRET IS EVER WRITTEN. The env template ships every credential blank and the bootstrap
 * generates the ones it can. A bundle is handed to a third party; a bundle carrying this platform's
 * keys would be a breach with a delivery mechanism.
 */

export interface StandaloneInput {
  tenantId: string;
  /** Read by the README's title. The SLUG is deliberately absent: a standalone deployment has no
   *  subdomain, and carrying it would invite a generated file to reference a hostname that only
   *  ever existed on the platform the merchant just left. */
  tenantName: string;
  /** Exactly what `resolveFeatures()` answered at export time — see `entitlements()` below. */
  features: FeatureSet;
  schemaVersion: string;
  contents: BackupContents;
}

export function standaloneFiles(input: StandaloneInput): ZipEntry[] {
  return [
    { name: 'standalone/entitlements.json', body: entitlements(input) },
    { name: 'standalone/docker-compose.yml', body: compose() },
    { name: 'standalone/.env.template', body: envTemplate(input) },
    { name: 'standalone/Caddyfile', body: caddyfile() },
    { name: 'bootstrap.sh', body: bootstrap() },
    { name: 'README.ar.md', body: readme(input) },
  ];
}

/**
 * The frozen answer to `can()`.
 *
 * A standalone deployment has no plans and no super admin, so there is nothing to resolve against
 * at runtime. What it has is this: the features the shop actually had on the day it was exported.
 * `takenAt` is in the file because the first question anyone asks about a stale-looking feature set
 * is when it was taken.
 */
function entitlements(input: StandaloneInput): string {
  return `${JSON.stringify(
    {
      tenantId: input.tenantId,
      takenAt: new Date().toISOString(),
      note: 'Frozen at export. A standalone deployment has no plans to resolve against.',
      features: input.features,
    },
    null,
    2,
  )}\n`;
}

/**
 * Five services, and the four that are missing are the point.
 *
 * No n8n (the automations belong to the platform's own workflows), no Umami (first-party analytics
 * ships in the app), no Uptime Kuma (one shop does not need a monitoring stack), and no backup
 * sidecar — a standalone owner backs up their own server, and shipping a sidecar configured for
 * nothing would be worse than shipping none.
 */
function compose(): string {
  return `# سوق برطعة — نسخة متجر واحد.
#
# Five services. The platform's n8n, Umami, Uptime Kuma and backup sidecar are deliberately absent:
# they are the platform's infrastructure, not one shop's.
#
#   docker compose up -d --build
#
# Only caddy publishes a port. Everything else talks over the internal network, exactly as the
# platform's own compose does.

services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: \${POSTGRES_DB:-shop}
      POSTGRES_USER: \${POSTGRES_USER:-shop}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U \${POSTGRES_USER:-shop} -d \${POSTGRES_DB:-shop}']
      interval: 10s
      timeout: 5s
      retries: 10
    networks: [internal]

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    command: ['redis-server', '--save', '60', '1']
    volumes:
      - redis_data:/data
    networks: [internal]

  web:
    build:
      context: ..
      target: web
    restart: unless-stopped
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_started }
    networks: [internal]

  worker:
    build:
      context: ..
      target: worker
    restart: unless-stopped
    env_file: [.env]
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_started }
    networks: [internal]

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports: ['80:80', '443:443']
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy_data:/data
      - caddy_config:/config
    environment:
      DOMAIN: \${DOMAIN:?DOMAIN is required}
    depends_on: [web]
    networks: [internal]

networks:
  internal:
    driver: bridge

volumes:
  postgres_data:
  redis_data:
  caddy_data:
  caddy_config:
`;
}

/**
 * One hostname, one certificate, no on-demand TLS.
 *
 * The platform's Caddyfile is complicated because it serves an unbounded set of merchant domains
 * whose certificates must be issued on demand. A standalone shop has exactly one name, so Caddy's
 * default automatic HTTPS is the whole configuration — and the `/internal/*` block the platform
 * needs has nothing to protect here, because there is no ask endpoint.
 */
function caddyfile(): string {
  return `{$DOMAIN} {
	encode zstd gzip

	# HSTS, matching the platform's own. A shop that has been served over HTTPS once should never
	# be talked out of it.
	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		-Server
	}

	reverse_proxy web:3000
}
`;
}

function envTemplate(input: StandaloneInput): string {
  return `# سوق برطعة — إعدادات نسخة المتجر المستقلة.
#
# املأ القيم الفاضية قبل ما تشغّل. سكربت bootstrap.sh بيولّد المفاتيح السرية تلقائياً إذا تركتها فاضية.
# ما في ولا مفتاح من مفاتيح المنصة الأصلية بهذا الملف — عن قصد.

# --- The shop -----------------------------------------------------------------
# The single tenant this deployment serves. Do not change it: the data was exported for this id.
SINGLE_TENANT_MODE=1
SINGLE_TENANT_ID=${input.tenantId}

# Your own domain. The storefront is served at the root, the dashboard at /dashboard.
DOMAIN=
PUBLIC_SCHEME=https

# --- Database and cache -------------------------------------------------------
POSTGRES_DB=shop
POSTGRES_USER=shop
POSTGRES_PASSWORD=
DATABASE_URL=postgresql://shop:CHANGE_ME@postgres:5432/shop
DATABASE_URL_MIGRATE=postgresql://shop:CHANGE_ME@postgres:5432/shop
DATABASE_URL_SYSTEM=postgresql://shop:CHANGE_ME@postgres:5432/shop
REDIS_URL=redis://redis:6379/0

# --- Secrets (bootstrap.sh generates these when left empty) --------------------
AUTH_SECRET=
ENCRYPTION_KEY=
WEBHOOK_HMAC_SECRET=

# --- Storage ------------------------------------------------------------------
# Local disk by default, which is what makes a one-server deployment work with no cloud account at
# all. Point it at S3-compatible storage later by setting STORAGE_DRIVER=r2 and the R2_* keys.
STORAGE_DRIVER=local
CDN_PUBLIC_BASE_URL=/dev-media
# R2_ACCOUNT_ID=
# R2_ACCESS_KEY_ID=
# R2_SECRET_ACCESS_KEY=
# R2_BUCKET=

# --- Mail ---------------------------------------------------------------------
# Needed for password resets and staff invitations. Any SMTP provider works.
MAIL_DRIVER=smtp
MAIL_FROM=
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=true
SMTP_USER=
SMTP_PASSWORD=

# --- Optional -----------------------------------------------------------------
# Web push. Generate a pair with: npx web-push generate-vapid-keys
# VAPID_PUBLIC_KEY=
# VAPID_PRIVATE_KEY=
# VAPID_SUBJECT=mailto:you@example.com
SENTRY_DSN=
`;
}

/**
 * Empty machine to serving shop, in one command.
 *
 * IDEMPOTENT ENOUGH TO RE-RUN. Every step checks whether it has already happened, because the
 * realistic failure is a missing SMTP password discovered at step six — and a script that could
 * only be run once would leave the operator hand-editing a half-built database.
 *
 * The owner password is printed ONCE and never stored. It is a first-login credential on a machine
 * the operator controls; writing it to a file would leave it there forever.
 */
function bootstrap(): string {
  return `#!/bin/sh
# سوق برطعة — تنصيب نسخة المتجر المستقلة.
#
#   ./bootstrap.sh
#
# Safe to run again after a failure: every step checks whether it has already been done.

set -eu

here=$(cd "$(dirname "$0")" && pwd)
cd "$here/standalone"

say()  { echo "==> $*"; }
die()  { echo "!!! $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker is not installed."
docker compose version >/dev/null 2>&1 || die "docker compose (v2) is not available."

[ -f .env ] || cp .env.template .env

# --- 1. secrets ---------------------------------------------------------------
# Generated locally and only when empty, so a re-run never rotates a key the database is already
# encrypted with — which would make every stored gateway credential unreadable.
fill_secret() {
  name="$1"
  current=$(grep "^\${name}=" .env | cut -d= -f2-)
  if [ -z "$current" ]; then
    value=$(openssl rand -base64 32)
    # A literal | cannot appear in base64, so it is a safe sed delimiter here.
    sed -i.bak "s|^\${name}=.*|\${name}=\${value}|" .env && rm -f .env.bak
    say "generated \${name}"
  fi
}

fill_secret AUTH_SECRET
fill_secret ENCRYPTION_KEY
fill_secret WEBHOOK_HMAC_SECRET

db_password=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)
if [ -z "$db_password" ]; then
  db_password=$(openssl rand -hex 24)
  sed -i.bak "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=\${db_password}|" .env
  for key in DATABASE_URL DATABASE_URL_MIGRATE DATABASE_URL_SYSTEM; do
    sed -i.bak "s|^\${key}=.*|\${key}=postgresql://shop:\${db_password}@postgres:5432/shop|" .env
  done
  rm -f .env.bak
  say "generated the database password"
fi

grep -q '^DOMAIN=.\\+' .env || die "Set DOMAIN in standalone/.env before running this again."

# --- 2. bring up the data services --------------------------------------------
say "starting postgres and redis"
docker compose up -d postgres redis

say "waiting for postgres"
tries=0
until docker compose exec -T postgres pg_isready -U shop -d shop >/dev/null 2>&1; do
  tries=$((tries + 1))
  [ "$tries" -lt 60 ] || die "postgres did not become ready."
  sleep 2
done

# --- 3. schema ----------------------------------------------------------------
say "applying the database schema"
docker compose run --rm --no-deps -T web pnpm db:migrate

# --- 4. the shop's data -------------------------------------------------------
if docker compose run --rm --no-deps -T web node -e "process.exit(0)" >/dev/null 2>&1; then :; fi

if [ ! -f .imported ]; then
  say "importing the shop's data and images"
  docker compose run --rm --no-deps \\
    -v "$here/tenant-backup.zip:/tmp/tenant-backup.zip:ro" \\
    -T web pnpm standalone:import /tmp/tenant-backup.zip
  touch .imported
else
  say "data already imported; skipping"
fi

# --- 5. the owner account -----------------------------------------------------
if [ ! -f .owner-created ]; then
  say "creating the owner account"
  docker compose run --rm --no-deps -T web pnpm standalone:owner
  touch .owner-created
else
  say "owner already created; skipping"
fi

# --- 6. up ---------------------------------------------------------------------
say "starting the shop"
docker compose up -d --build

say ""
say "Done. The storefront is at https://$(grep '^DOMAIN=' .env | cut -d= -f2-)"
say "The dashboard is at the same address, under /dashboard"
say ""
say "خلص التنصيب. الموقع شغّال، ولوحة التحكم على نفس العنوان + /dashboard"
`;
}

function readme(input: StandaloneInput): string {
  const products = input.contents.tables.products ?? 0;
  const orders = input.contents.tables.orders ?? 0;

  return `# ${input.tenantName} — نسخة مستقلة من الموقع

هذا الملف فيه موقعك كامل: الكود، البيانات، والصور. بتقدر تشغّله على أي سيرفر لحالك، بدون أي علاقة
بمنصة سوق برطعة.

**شو جوّا:**

| الملف | شو فيه |
|---|---|
| \`source.tar.gz\` | كود الموقع ولوحة التحكم |
| \`tenant-backup.zip\` | بياناتك: ${products} منتج، ${orders} طلب، و${input.contents.mediaFiles} صورة |
| \`standalone/\` | ملفات التشغيل والإعدادات |
| \`bootstrap.sh\` | سكربت التنصيب |

---

## شو بتحتاج

- سيرفر عليه **Docker** و **Docker Compose v2** (أي VPS بـ 2 جيجا رام بكفّي)
- **دومين** موجّه على IP السيرفر (سجل A)
- بيانات **SMTP** لإرسال رسائل استعادة كلمة السر (أي مزوّد بريد)

---

## خطوات التنصيب

**1. فك الملف على السيرفر**

\`\`\`sh
unzip standalone-*.zip -d shop && cd shop
tar -xzf source.tar.gz
\`\`\`

**2. عبّي الإعدادات**

افتح \`standalone/.env\` وحط:

- \`DOMAIN\` — دومينك، مثلاً \`shop.example.com\`
- بيانات \`SMTP_*\` و\`MAIL_FROM\`

باقي المفاتيح السرية بتنولّد لحالها بالخطوة الجاية. لا تغيّر \`SINGLE_TENANT_ID\` — البيانات
مُصدَّرة لهذا الرقم بالذات.

**3. شغّل التنصيب**

\`\`\`sh
./bootstrap.sh
\`\`\`

بياخد بين ٥ و١٥ دقيقة. بآخره بتطبع **كلمة سر مؤقتة لحسابك** — انسخها فوراً، ما بتنعرض مرة تانية.

**4. ادخل**

- الموقع: \`https://دومينك\`
- لوحة التحكم: \`https://دومينك/dashboard\`

غيّر كلمة السر من أول دخول.

---

## شو الفرق عن النسخة اللي على المنصة

| | على المنصة | مستقل |
|---|---|---|
| الموقع ولوحة التحكم | ✅ | ✅ |
| المنتجات، الطلبات، الزبائن، التوصيل | ✅ | ✅ |
| الباقات وحدود الاستخدام | تتحكم فيها المنصة | مثبّتة على وضعك يوم التصدير |
| النسخ الاحتياطي التلقائي | المنصة بتعمله | **مسؤوليتك** — شوف تحت |
| التحديثات والدعم | المنصة | حسب الاتفاق |

**المميزات المثبّتة** موجودة بـ \`standalone/entitlements.json\`. هي نفس المميزات اللي كان عندك يوم
التصدير، مش أكثر ولا أقل.

---

## النسخ الاحتياطي — صار مسؤوليتك

المنصة كانت بتاخد نسخة كل ٦ ساعات. هون ما في حدا بيعملها عنك. أبسط طريقة، ضيفها بـ crontab:

\`\`\`sh
0 */6 * * * cd /path/to/shop/standalone && docker compose exec -T postgres pg_dump -U shop shop | gzip > /backup/shop-$(date +\\%F-\\%H).sql.gz
\`\`\`

**والصور مش بقاعدة البيانات.** إذا خليت \`STORAGE_DRIVER=local\` لازم تاخد نسخة من مجلد التخزين
كمان، مش بس من قاعدة البيانات.

---

## أسئلة سريعة

**الموقع ما فتح؟** تأكد إن الدومين موجّه صح، وإن المنفذين 80 و443 مفتوحين، وشوف السجل:
\`docker compose logs caddy web\`

**نسيت كلمة السر؟** استعمل «نسيت كلمة السر» بصفحة الدخول — بتحتاج SMTP مضبوط.

**بدي أحدّث الكود لاحقاً؟** بدّل محتوى المجلد بنسخة أحدث وأعد \`docker compose up -d --build\`،
وشغّل \`pnpm db:migrate\` إذا كان في تغييرات بقاعدة البيانات.

**نسخة قاعدة البيانات:** \`${input.schemaVersion}\`
`;
}
