import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The invariants that are architecture, not behaviour — enforced by reading the source.
 *
 * Every rule here exists because "we agreed not to" is not an enforcement mechanism, and
 * because each of these mistakes is invisible in a passing test suite: a raw Prisma import
 * works perfectly right up until it reads the wrong tenant.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const srcRoot = path.join(repoRoot, 'src');

function walk(dir: string, extensions = ['.ts', '.tsx']): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      out.push(...walk(full, extensions));
    } else if (extensions.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

const sources = walk(srcRoot).map((file) => ({
  file,
  rel: path.relative(repoRoot, file).split(path.sep).join('/'),
  source: readFileSync(file, 'utf8'),
}));

describe('invariant 1 — nothing reaches Prisma except through src/server/db', () => {
  it('has no raw @prisma/client import outside the isolation boundary', () => {
    const offenders = sources
      .filter(({ rel }) => !rel.startsWith('src/server/db/'))
      .filter(({ source }) => /from '@prisma\/client'/.test(source))
      // Type-only imports of generated enums are harmless: they carry no client.
      .filter(({ source }) => !/^import type .* from '@prisma\/client';$/m.test(source.trim()))
      .filter(({ source }) => /^import \{[^}]*PrismaClient/m.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('constructs a PrismaClient in exactly one file', () => {
    const constructors = sources.filter(({ source }) => /new PrismaClient\(/.test(source));
    expect(constructors.map((c) => c.rel)).toEqual(['src/server/db/client.ts']);
  });
});

describe('the GUCs are always transaction-local', () => {
  it('never calls set_config with a session-scoped flag', () => {
    // set_config(..., false) is SESSION scoped. On a pooled connection that leaks one
    // request's tenant into the next — the single worst bug this platform could ship.
    const offenders = sources
      .filter(({ source }) => /set_config\([^)]*,\s*(false|FALSE)\s*\)/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('sets app.actor_role only inside the database layer', () => {
    const offenders = sources
      .filter(({ rel }) => !rel.startsWith('src/server/db/'))
      .filter(({ source }) => /set_config\('app\.actor_role'/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('never derives an actor role from request input', () => {
    // The role must come from a verified session. Reading it from a header would make
    // `x-actor-role: super_admin` a working privilege escalation.
    const offenders = sources
      .filter(({ source }) =>
        /(headers|searchParams|cookies)[^\n]*\.get\(\s*['"][^'"]*actor[_-]?role/i.test(source),
      )
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});

describe('invariant 5 — billing state lives in src/server/billing', () => {
  const LIFECYCLE_FIELDS = /(status|currentPeriodEnd|suspendedAt|retentionUntil|exportDownloadToken)\s*:/;

  it('mutates subscription lifecycle fields nowhere else', () => {
    const offenders = sources
      .filter(({ rel }) => !rel.startsWith('src/server/billing/'))
      .filter(({ source }) => /\.subscription\.(update|updateMany|create|upsert)\s*\(/.test(source))
      .filter(({ source }) => {
        // src/server/export legitimately stamps exportKey / exportGeneratedAt /
        // exportFirstDownloadedAt — export metadata, not lifecycle state. Anything touching a
        // lifecycle field is a violation regardless of which folder it is in.
        const writes = source.match(/\.subscription\.(?:update|updateMany|create|upsert)\s*\(([\s\S]{0,400})/g) ?? [];
        return writes.some((chunk) => LIFECYCLE_FIELDS.test(chunk));
      })
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('flips Tenant.state nowhere else — it is the serving read model billing owns', () => {
    const offenders = sources
      .filter(({ rel }) => !rel.startsWith('src/server/billing/'))
      .filter(({ source }) => /state:\s*'(suspended|purging)'/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});

/**
 * Phase 5 adds a SECOND writer's worth of temptation to the Payment table, and two new PII
 * surfaces. All three rules below are invisible in a passing suite: an order payment written
 * outside billing works perfectly until someone asks why the revenue report disagrees with the
 * bank, and a customer's phone number in an event payload works perfectly until it turns up in a
 * backup of n8n's execution history.
 */
describe('invariant 5, Phase 5 — the Payment table still has ONE writer', () => {
  it('creates a Payment row only from src/server/billing', () => {
    const offenders = sources
      .filter(({ rel }) => !rel.startsWith('src/server/billing/'))
      .filter(({ source }) => /\.payment\.(create|createMany|upsert)\s*\(/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });

  it('keeps the orders service out of subscription lifecycle state', () => {
    // `src/server/orders` calls INTO billing (`recordPaymentInTx`); it must never reach around it.
    const offenders = sources
      .filter(({ rel }) => rel.startsWith('src/server/orders/'))
      .filter(({ source }) =>
        /\.subscription\.(update|updateMany|create|upsert)\s*\(/.test(source),
      )
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});

describe('Phase 5 — customer PII stays out of the places that outlive the tenant', () => {
  /**
   * An event payload is copied into `WebhookDelivery`, which is GLOBAL and survives the purge, and
   * POSTed to n8n, whose execution history Q9 puts in the backup set. A storefront customer never
   * had an account here and has no route to ask us to stop, so their name and number may not enter
   * either. Asserted against the payload TABLE rather than an emit site, because the type is what a
   * future event has to be declared in.
   */
  it('declares no order event payload carrying a customer identifier', () => {
    const eventTypes = readFileSync(path.join(srcRoot, 'server/events/types.ts'), 'utf8');
    const orderPayloads = eventTypes
      .split('\n')
      .filter((line) => /^\s*'order\.\w+':/.test(line) || /^\s*'order\.\w+':\s*\{/.test(line));

    expect(orderPayloads.length).toBeGreaterThan(0);
    for (const line of orderPayloads) {
      for (const field of ['customerName', 'customerPhone', 'customerNote', 'providerRef']) {
        expect(line, `an order event payload carries ${field}: ${line.trim()}`).not.toContain(field);
      }
    }
  });

  it('redacts the new PII and secret-shaped fields in the logger', () => {
    const logger = readFileSync(path.join(srcRoot, 'server/logger.ts'), 'utf8');
    for (const field of ['customerName', 'customerPhone', 'customerNote', 'rawPayload']) {
      expect(logger, `logger does not redact ${field}`).toContain(`'${field}'`);
    }
  });

  /**
   * Decision (a). The suspension artifact is fetched with a bearer token pasted into a WhatsApp
   * message; the identifiers ride only on the authenticated channel. The rule is enforced inside
   * `exportTenantData` so it cannot be forgotten by a caller — this checks the enforcement exists.
   */
  it('refuses customer identifiers in any mode but self_serve, inside the export itself', () => {
    const exportIndex = readFileSync(path.join(srcRoot, 'server/export/index.ts'), 'utf8');
    expect(exportIndex).toMatch(/includeCustomerIdentifiers && mode !== 'self_serve'/);
    expect(exportIndex).toMatch(/throw new ExportModeError/);
  });

  /**
   * Every registered job name must have something that ENQUEUES it.
   *
   * `cleanup-self-serve` had a processor and a registry entry and no producer for four phases, so
   * the 24-hour life promised in `src/server/export/types.ts` was never real. Nothing noticed,
   * because every test that matters drives processors directly — and orphan cleanup skips
   * `_exports/` by design, so nothing else was ever going to collect the objects.
   *
   * It became worth catching mechanically when decision (a) put customer names and phone numbers
   * into that one artifact. This asserts the shape rather than the schedule: a job name that
   * appears only in the registry is a job that never runs.
   */
  it('has a producer for every job name the registry can run', () => {
    /**
     * ONE documented exception, and it is an exception in the strong sense: `demo/build-demo` is
     * registered and deliberately never enqueued, because a demo must be built INSIDE the
     * transaction that creates it (a queued build hands back a shareable link to an empty shop).
     * Its processor THROWS, loudly, precisely so a hand-enqueued or stale payload is visible
     * rather than silently successful — and the registry entry cannot be removed because
     * `src/server/queues.ts` is a frozen shared file.
     *
     * The distinction this test draws is therefore not "is it enqueued" but "is its absence
     * deliberate": a stub that throws is a decision, a processor that quietly does real work and
     * is never called is a promise nobody keeps.
     */
    const DELIBERATELY_NEVER_ENQUEUED = new Set(['build-demo']);

    const registry = readFileSync(path.join(srcRoot, 'server/queues.ts'), 'utf8');
    const jobNames = [...registry.matchAll(/'([a-z-]+)':\s*\(\)\s*=>\s*import\(/g)]
      .map((match) => match[1]!)
      .filter((name) => !DELIBERATELY_NEVER_ENQUEUED.has(name));

    expect(jobNames.length).toBeGreaterThan(5);

    const producers = sources
      .filter(({ rel }) => rel !== 'src/server/queues.ts')
      .map(({ source }) => source)
      .join('\n');

    const orphans = jobNames.filter((name) => {
      // Either enqueued by its literal name, or through the `LIFECYCLE_JOBS` / `EXPORT_JOBS`
      // constant vocabulary that exists so a typo is a compile error.
      const constantName = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
      return !producers.includes(`'${name}'`) && !producers.includes(`.${constantName}`);
    });

    expect(orphans).toEqual([]);
  });
});

describe('Phase 5 — a gateway credential never leaves its folder', () => {
  it('unseals credentials in exactly one file', () => {
    const readers = sources
      .filter(({ source }) => /\bunseal\s*\(/.test(source))
      .filter(({ rel }) => rel !== 'src/server/crypto.ts')
      .map(({ rel }) => rel);

    expect(readers).toEqual(['src/server/payments/config.ts']);
  });

  it('reads the credential columns in exactly one file', () => {
    const readers = sources
      .filter(({ source }) => /credentialsCipher/.test(source))
      .map(({ rel }) => rel);

    expect(readers).toEqual(['src/server/payments/config.ts']);
  });
});

describe('invariant 4 — the S3 client is reachable from one folder only', () => {
  it('has no @aws-sdk import outside src/server/media/storage', () => {
    const offenders = sources
      .filter(({ rel }) => !rel.startsWith('src/server/media/storage/'))
      .filter(({ source }) => /from '@aws-sdk\//.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});

describe('invariant 9 — one getClientIp()', () => {
  it('reads CF-Connecting-IP in exactly one file', () => {
    const readers = sources
      .filter(({ source }) => /cf-connecting-ip/i.test(source))
      .map(({ rel }) => rel);

    expect(readers).toEqual(['src/server/http/get-client-ip.ts']);
  });

  it('never reads X-Forwarded-For anywhere', () => {
    // It is trivially spoofable, and behind Cloudflare it is client-controlled: Cloudflare
    // APPENDS to whatever the client sent.
    const readers = sources
      .filter(({ rel }) => rel !== 'src/server/http/get-client-ip.ts')
      .filter(({ source }) => /x-forwarded-for/i.test(source))
      .map(({ rel }) => rel);

    expect(readers).toEqual([]);
  });
});

describe('the domain is a placeholder everywhere', () => {
  it('is never hardcoded in source', () => {
    // Comments may NAME the placeholder domain — that is documentation, not a hardcoded
    // hostname. Only code counts.
    const stripComments = (source: string) =>
      source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    const offenders = sources
      .filter(({ source }) => /souqbartaa\.com/.test(stripComments(source)))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});

describe('Q1 — no self-registration exists anywhere', () => {
  it('disables sign-up in the auth configuration', () => {
    const config = readFileSync(path.join(srcRoot, 'server/auth/config.ts'), 'utf8');
    expect(config).toMatch(/disableSignUp:\s*true/);
    expect(config).toMatch(/allowUserToCreateOrganization:\s*false/);
  });

  it('exposes no sign-up route', () => {
    const routes = walk(path.join(srcRoot, 'app')).map((f) =>
      path.relative(srcRoot, f).split(path.sep).join('/'),
    );

    const signUpRoutes = routes.filter((r) => /sign-?up|register/i.test(r));
    expect(signUpRoutes).toEqual([]);
  });

  it('declares explicit rate limits on the credential endpoints', () => {
    // Not a library default: credential stuffing hits /sign-in/email, and account enumeration
    // and mail-bombing both hit the reset endpoints. The numbers come from env so a load test
    // can raise them without editing the auth configuration.
    const config = readFileSync(path.join(srcRoot, 'server/auth/config.ts'), 'utf8');
    expect(config).toMatch(/rateLimit:\s*\{/);
    for (const route of ['/sign-in/email', '/request-password-reset', '/reset-password']) {
      expect(config, `no rate limit declared for ${route}`).toContain(route);
    }
    expect(config).toContain('RATE_LIMIT_LOGIN_PER_15MIN');
  });

  it('creates a tenant only from the billing service', () => {
    // A1 is the only surface that creates accounts, and it must go through billing.
    const offenders = sources
      .filter(({ rel }) => !rel.startsWith('src/server/billing/'))
      .filter(({ rel }) => !rel.startsWith('src/server/demo/'))
      .filter(({ source }) => /\.tenant\.create\s*\(/.test(source))
      .map(({ rel }) => rel);

    expect(offenders).toEqual([]);
  });
});

describe('the event payload rule (item 13)', () => {
  it('redacts payloads and credentials in the logger', () => {
    const logger = readFileSync(path.join(srcRoot, 'server/logger.ts'), 'utf8');
    for (const field of ['payload', 'token', 'password', 'secret', 'signedUrl', 'ip']) {
      expect(logger, `logger does not redact ${field}`).toContain(`'${field}'`);
    }
  });

  it('never puts a signed storage URL in an event payload', () => {
    // Q18's whole design: the event carries a revocable platform link, because a presigned URL
    // in an n8n execution record is a working key to a merchant's catalogue sitting in a backup.
    const eventTypes = readFileSync(path.join(srcRoot, 'server/events/types.ts'), 'utf8');
    expect(eventTypes).toMatch(/exportUrl/);
    expect(eventTypes).not.toMatch(/signedUrl\s*:/);
  });

  /**
   * The same rule, one size down, found by B3 (docs/decisions/b3.md §11).
   *
   * `demo.created` carried `demoUrl`, which is `{scheme}://{slug}.{DOMAIN}/?token=…` — the demo's
   * bearer token. Emitting an event materialises `WebhookDelivery` rows, and those are GLOBAL: they
   * survive `closeDemo`, the operation whose confirmation dialog tells the operator the prospect's
   * data is gone. The payload is POSTed to n8n as well and lives in its execution history.
   *
   * Asserted against the payload TABLE rather than the emit site, because the type is what a future
   * event has to be declared in — a new `demo.*` event that wanted a shareable link would be
   * written here first, and this is where it gets stopped.
   */
  it('never puts a demo bearer token in an event payload either', () => {
    const eventTypes = readFileSync(path.join(srcRoot, 'server/events/types.ts'), 'utf8');
    const demoPayloads = eventTypes
      .split('\n')
      .filter((line) => /^\s*'demo[._]/.test(line) || /'demo\.\w+':/.test(line));

    expect(demoPayloads.length).toBeGreaterThan(0);
    for (const line of demoPayloads) {
      expect(line, `a demo event payload carries a URL: ${line.trim()}`).not.toMatch(/Url\s*:/);
      expect(line, `a demo event payload carries a token: ${line.trim()}`).not.toMatch(/token\s*:/i);
    }
  });
});

describe('the storage contract', () => {
  it('documents and enforces the 7-day presign ceiling', () => {
    const types = readFileSync(path.join(srcRoot, 'server/storage/types.ts'), 'utf8');
    expect(types).toContain('MAX_SIGNED_URL_TTL_SECONDS');
    expect(types).toMatch(/7 days/);
  });

  it('declares delete(), deleteByPrefix() and signedUrl() up front', () => {
    // Later tracks are forbidden from touching the S3 client and cannot add methods to a
    // merged folder, so the surface has to be complete now.
    const types = readFileSync(path.join(srcRoot, 'server/storage/types.ts'), 'utf8');
    expect(types).toMatch(/delete\(key: string\)/);
    expect(types).toMatch(/deleteByPrefix\(prefix: string\)/);
    expect(types).toMatch(/signedUrl\(key: string, ttlSeconds: number\)/);
  });
});
