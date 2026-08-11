import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SERVICE_WORKER_VERSION, buildManifest, serviceWorkerSource, shortName } from '@/server/pwa';
import { PUSH_BODY_MAX, PUSH_TITLE_MAX, pushMessageSchema, pushPayload } from '@/server/push';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * Phase 4 — the PWA and push logic that has no database in it.
 *
 * The two things worth pinning here are both cases where "it works" and "it is correct" come
 * apart: a manifest with an absolute `start_url` works perfectly until the merchant connects a
 * custom domain, and a notification target that accepts an absolute URL works perfectly until
 * somebody uses it as an open redirect wearing a shop's name.
 */

describe('the web app manifest', () => {
  const manifest = buildManifest({
    name: 'سوبر ماركت الوادي',
    tagline: 'طازة كل يوم',
    themeColor: '#c2410c',
    backgroundColor: '#faf3e7',
  });

  it('is Arabic and RTL, so a launcher renders the name the right way round', () => {
    expect(manifest.lang).toBe('ar');
    expect(manifest.dir).toBe('rtl');
    expect(manifest.name).toBe('سوبر ماركت الوادي');
  });

  it('keeps start_url and scope RELATIVE', () => {
    /**
     * The same tenant answers on `{slug}.{DOMAIN}` and on their custom domain. An absolute
     * `start_url` baked from either would install an app that opens the OTHER hostname — so a
     * merchant who connects a domain later would have every already-installed customer still
     * landing on the platform subdomain, forever, with no way to notice.
     */
    expect(manifest.start_url).toBe('/');
    expect(manifest.scope).toBe('/');
  });

  it('carries the tenant’s own colours, not the platform’s', () => {
    expect(manifest.theme_color).toBe('#c2410c');
    expect(manifest.background_color).toBe('#faf3e7');
  });

  it('declares maskable separately from any', () => {
    // The two are genuinely different pictures (the maskable one is inset for a circular crop),
    // so a combined `purpose: 'any maskable'` would let a launcher crop the un-inset artwork.
    const purposes = manifest.icons.map((icon) => icon.purpose);
    expect(purposes).toContain('any');
    expect(purposes).toContain('maskable');
    expect(manifest.icons.every((icon) => icon.type === 'image/png')).toBe(true);
    // No file extension: proxy.ts excludes `.png` from its matcher, so an icon at `/icon-192.png`
    // would arrive with no tenant context and could not know whose shop it belongs to.
    expect(manifest.icons.every((icon) => icon.src.startsWith('/icons/'))).toBe(true);
  });

  it('shortens a long shop name at a word boundary, not mid-word', () => {
    expect(shortName('بقالة')).toBe('بقالة');
    // Android truncates a launcher label at roughly a dozen characters; a name cut mid-word looks
    // like a bug rather than a limit.
    expect(shortName('سوبر ماركت الوادي والجبل')).toBe('سوبر ماركت');
    expect(shortName('سوبر ماركت الوادي والجبل').length).toBeLessThanOrEqual(12);
  });

  it('omits description entirely when the shop has no tagline', () => {
    const bare = buildManifest({
      name: 'ورشة الشمال',
      tagline: null,
      themeColor: '#000000',
      backgroundColor: '#ffffff',
    });

    expect('description' in bare).toBe(false);
  });
});

describe('the service worker source', () => {
  const source = serviceWorkerSource({
    version: SERVICE_WORKER_VERSION,
    offlineUrl: '/offline',
    iconUrl: '/icons/192',
    badgeUrl: '/icons/192',
    fallbackTitle: 'إشعار جديد',
    fallbackBody: 'في إشي جديد بالمتجر.',
  });

  it('handles push and notification clicks', () => {
    expect(source).toContain("addEventListener('push'");
    expect(source).toContain("addEventListener('notificationclick'");
    // Without this a rotated endpoint silently leaves the audience: the push service stops
    // answering and never returns 410, so the delivery job's own cleanup never fires either.
    expect(source).toContain("addEventListener('pushsubscriptionchange'");
  });

  it('refuses to navigate off its own origin, whatever the payload said', () => {
    /**
     * The target is composed by a merchant and travels through a third-party push service. A
     * notification that can open any address is a redirect this platform did not intend to offer,
     * and the shop's name is on it.
     */
    expect(source).toContain('target.origin !== self.location.origin');
  });

  it('caches only the offline document, never a merchant’s pages', () => {
    // Prices change hourly and an offer that ended is worse than a page that is slow.
    expect(source).toContain("request.mode !== 'navigate'");
    expect(source).toContain('caches.match(OFFLINE_URL)');
  });

  it('embeds Arabic copy as JSON rather than interpolating it raw', () => {
    expect(source).toContain('const FALLBACK_TITLE = "إشعار جديد";');
  });
});

describe('what a merchant may push', () => {
  it('accepts an ordinary Arabic notification', () => {
    const parsed = pushMessageSchema.parse({
      title: 'عرض نهاية الأسبوع',
      body: 'خصم ٢٠٪ على كل الكنب لليوم بس.',
      targetUrl: '/products/kanaba',
    });

    expect(parsed.targetUrl).toBe('/products/kanaba');
  });

  it('keeps only the PATH of an absolute URL', () => {
    /**
     * A merchant pastes a link from their own address bar — that is the ordinary input. Storing
     * the whole URL would make this an open redirect: one compromised merchant account would
     * become a phishing channel with an install base, wearing a shop's name and arriving as a
     * notification the customer already trusted.
     */
    const parsed = pushMessageSchema.parse({
      title: 'جديدنا',
      body: 'وصلت بضاعة جديدة.',
      targetUrl: 'https://evil.test/steal?a=1',
    });

    expect(parsed.targetUrl).toBe('/steal?a=1');
  });

  it('defuses a protocol-relative URL, which looks like a path and is not one', () => {
    const parsed = pushMessageSchema.parse({
      title: 'جديدنا',
      body: 'وصلت بضاعة جديدة.',
      targetUrl: '//evil.test/x',
    });

    expect(parsed.targetUrl).toBe('/evil.test/x');
  });

  it('treats an empty target as no target', () => {
    expect(pushMessageSchema.parse({ title: 'أ', body: 'ب', targetUrl: '' }).targetUrl).toBeNull();
  });

  it('refuses an empty title or body, and one longer than a phone will show', () => {
    expect(pushMessageSchema.safeParse({ title: '', body: 'ب', targetUrl: '' }).success).toBe(false);
    expect(pushMessageSchema.safeParse({ title: 'أ', body: '', targetUrl: '' }).success).toBe(false);
    expect(
      pushMessageSchema.safeParse({ title: 'أ'.repeat(PUSH_TITLE_MAX + 1), body: 'ب', targetUrl: '' })
        .success,
    ).toBe(false);
    expect(
      pushMessageSchema.safeParse({ title: 'أ', body: 'ب'.repeat(PUSH_BODY_MAX + 1), targetUrl: '' })
        .success,
    ).toBe(false);
  });
});

describe('the edge blocks the internal endpoints on EVERY hostname', () => {
  /**
   * Read out of the Caddyfile, because that is where the control actually lives.
   *
   * `/internal/domain-ask` has no shared secret — Caddy's `ask` directive sends no headers — and
   * `proxy.ts` passes `/internal/*` through without resolving a tenant or a session, because the
   * ask arrives for a hostname we may not know yet. So the edge block is not defence in depth for
   * that route: it is its only layer.
   *
   * It was written into the `:443` custom-domain block alone, and Caddy matches a host-specific
   * site block ahead of the port-only one — so on admin.{DOMAIN}, app.{DOMAIN} and every
   * storefront subdomain the endpoint answered the public internet: a status-code oracle over the
   * whole domains table, and for a row at `verified`, an unauthenticated GET that promoted it to
   * `active` with no certificate ever issued. Raised by the Phase 4 review.
   */
  const caddyfile = readFileSync(path.join(repoRoot, 'Caddyfile'), 'utf8');

  /**
   * Comments are stripped first, and that is not fussiness: the block above this one EXPLAINS the
   * directive by name, so a text search for it found three "blocks" in a file with two. A gate
   * that counts prose is a gate that goes green when someone deletes the directive and leaves the
   * paragraph describing it — which is exactly the shape this defect had.
   */
  const directives = caddyfile
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('refuses /internal/* in both site blocks, not just the custom-domain one', () => {
    const blocks = directives.match(/handle \/internal\/\*/g) ?? [];
    expect(blocks.length).toBe(2);
  });

  it('keeps the platform block behind a handle, so the refusal is reachable', () => {
    // A bare `reverse_proxy` beside a `handle` never runs; the proxy has to be inside its own
    // `handle` for Caddy to evaluate the `/internal/*` matcher first.
    const platform = directives.slice(
      directives.indexOf('*.{$DOMAIN}, {$DOMAIN} {'),
      directives.indexOf(':443 {'),
    );

    expect(platform).toContain('handle /internal/* {');
    expect(platform).toMatch(/handle \{\s*\n\s*reverse_proxy web:3000/);
  });
});

describe('the wire payload', () => {
  it('carries only what the notification displays', () => {
    /**
     * `web-push` encrypts this end to end (RFC 8291) so the vendor cannot read it — but it is
     * still the merchant's copy on someone else's infrastructure. No tenant id and no subscriber
     * identifier, so a push service cannot build a picture of who shops where.
     */
    const payload = JSON.parse(
      pushPayload({ id: 'msg_1', title: 'عرض', body: 'خصم', targetUrl: null }),
    );

    expect(payload).toEqual({ id: 'msg_1', title: 'عرض', body: 'خصم', url: '/' });
    expect(Object.keys(payload).sort()).toEqual(['body', 'id', 'title', 'url']);
  });

  it('carries the message id so a re-delivery replaces the notification', () => {
    // The service worker uses it as the `tag`; without it a re-delivery stacks a second copy of
    // the same offer on the customer's lock screen.
    const payload = JSON.parse(
      pushPayload({ id: 'msg_2', title: 'عرض', body: 'خصم', targetUrl: '/products/x' }),
    );

    expect(payload.id).toBe('msg_2');
    expect(payload.url).toBe('/products/x');
  });
});
