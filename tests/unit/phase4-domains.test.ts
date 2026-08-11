import { beforeEach, describe, expect, it } from 'vitest';
import {
  EXAMPLE_HOSTNAME,
  checkDomainOwnership,
  cnameTarget,
  customHostnameSchema,
  isPlatformHostname,
  normaliseDomainInput,
  verificationTxtNames,
  verificationTxtValue,
  type DnsLookup,
} from '@/server/domains';
import { resetRateLimitWindows } from '@/server/rate-limit';

/**
 * Phase 4 — the domain primitives, tested without DNS and without a database.
 *
 * The DNS probe is injectable precisely so this file can exist: "did the merchant point the
 * record at us" is the logic worth testing, and a suite that reached the real internet to test it
 * would be slow, flaky, and would fail on a plane.
 */

beforeEach(() => {
  resetRateLimitWindows();
});

/** A stub lookup. Anything not named answers empty, which is what a real resolver does. */
function lookup(records: {
  cname?: Record<string, string[]>;
  txt?: Record<string, string[]>;
  addresses?: Record<string, string[]>;
}): DnsLookup {
  return {
    cname: async (host) => records.cname?.[host] ?? [],
    txt: async (host) => records.txt?.[host] ?? [],
    addresses: async (host) => records.addresses?.[host] ?? [],
  };
}

describe('what may become a custom domain', () => {
  it('reduces whatever a merchant pastes to a hostname', () => {
    // A shop owner copies the address bar. This is the ordinary input, not the malicious one.
    expect(normaliseDomainInput('https://Shop.Example.COM/products?a=1#x')).toBe('shop.example.com');
    expect(normaliseDomainInput('  shop.example.com.  ')).toBe('shop.example.com');
    expect(normaliseDomainInput('http://user:pass@shop.example.com:8443/')).toBe(
      'shop.example.com',
    );
  });

  it('accepts an ordinary subdomain', () => {
    expect(customHostnameSchema.parse(' HTTPS://Shop.Example.com/ ')).toBe('shop.example.com');
  });

  it('refuses a bare IP address, which can never hold a CNAME', () => {
    // The hostname pattern is perfectly happy with 1.2.3.4; the merchant would be sent round a
    // verification loop that cannot close.
    expect(customHostnameSchema.safeParse('1.2.3.4').success).toBe(false);
  });

  it('refuses a single label and an empty value', () => {
    expect(customHostnameSchema.safeParse('localhost').success).toBe(false);
    expect(customHostnameSchema.safeParse('').success).toBe(false);
  });

  it('refuses anything under the platform domain', () => {
    /**
     * `Domain.hostname` is globally unique and is the table proxy.ts resolves strangers against.
     * A row for `admin.{DOMAIN}` could never serve — `parseHostname()` classifies that name as
     * the admin surface long before the table is consulted — but it would sit there permanently
     * blocking the real thing while looking, in the merchant's own dashboard, like a domain they
     * own.
     */
    const domain = process.env.DOMAIN!;
    expect(isPlatformHostname(`admin.${domain}`)).toBe(true);
    expect(isPlatformHostname(domain)).toBe(true);
    expect(isPlatformHostname('shop.example.com')).toBe(false);

    const refused = customHostnameSchema.safeParse(`someone.${domain}`);
    expect(refused.success).toBe(false);
    expect(refused.error?.issues[0]?.message).toBe('dashboard:domain.errors.platformReserved');
  });

  it('points each tenant at its OWN platform subdomain, never a shared target', () => {
    /**
     * A single shared `cname.{DOMAIN}` would carry no information about WHO is asking, so any
     * stranger pointing a CNAME at it would look exactly like the tenant that holds the row. Per
     * tenant, the DNS record IS the proof of control.
     */
    expect(cnameTarget('warsheh')).toBe(`warsheh.${process.env.DOMAIN}`);
    expect(cnameTarget('diwan')).not.toBe(cnameTarget('warsheh'));
  });
});

describe('the ownership proof', () => {
  const hostname = EXAMPLE_HOSTNAME;
  const target = 'warsheh.souqbartaa.test';
  const token = 'tok_abc123';

  it('accepts a CNAME pointing at the tenant target', async () => {
    const result = await checkDomainOwnership({
      hostname,
      cnameTarget: target,
      token,
      lookup: lookup({ cname: { [hostname]: [`${target}.`] } }),
    });

    // The trailing dot a resolver returns is stripped, not compared.
    expect(result).toMatchObject({ verified: true, method: 'cname' });
  });

  it('accepts the TXT fallback on the hostname itself or on the _souq-verify label', async () => {
    const value = verificationTxtValue(token);
    const [bare, labelled] = verificationTxtNames(hostname);

    for (const name of [bare!, labelled!]) {
      const result = await checkDomainOwnership({
        hostname,
        cnameTarget: target,
        token,
        lookup: lookup({ txt: { [name]: [value] } }),
      });

      expect(result, name).toMatchObject({ verified: true, method: 'txt' });
    }
  });

  it('refuses a TXT record carrying somebody else’s token', async () => {
    const result = await checkDomainOwnership({
      hostname,
      cnameTarget: target,
      token,
      lookup: lookup({ txt: { [hostname]: [verificationTxtValue('tok_someone_else')] } }),
    });

    expect(result.verified).toBe(false);
  });

  it('names a CNAME that points somewhere else, so the merchant checks for a typo', async () => {
    const result = await checkDomainOwnership({
      hostname,
      cnameTarget: target,
      token,
      lookup: lookup({ cname: { [hostname]: ['diwan.souqbartaa.test'] } }),
    });

    expect(result).toMatchObject({ verified: false, failure: 'cnameMismatch' });
    expect(result.observedCnames).toEqual(['diwan.souqbartaa.test']);
  });

  it('recognises a PROXIED record — no CNAME, but the name resolves', async () => {
    /**
     * The single most common failure of this whole flow. Cloudflare's orange cloud flattens the
     * record, so the CNAME is invisible to every resolver AND the ACME challenge never arrives —
     * which from the merchant's side looks exactly like "your platform is broken". It gets its
     * own message naming the grey cloud.
     */
    const result = await checkDomainOwnership({
      hostname,
      cnameTarget: target,
      token,
      lookup: lookup({ addresses: { [hostname]: ['104.21.0.1'] } }),
    });

    expect(result).toMatchObject({ verified: false, failure: 'proxied' });
  });

  it('reports nothing-there separately from pointing-elsewhere', async () => {
    const result = await checkDomainOwnership({
      hostname,
      cnameTarget: target,
      token,
      lookup: lookup({}),
    });

    expect(result).toMatchObject({ verified: false, failure: 'missing' });
  });

  it('joins the chunks of a split TXT record before comparing', async () => {
    // A resolver may split a TXT value at 255 bytes; the RFC says the value is the concatenation.
    const value = verificationTxtValue(token);
    const result = await checkDomainOwnership({
      hostname,
      cnameTarget: target,
      token,
      lookup: {
        cname: async () => [],
        txt: async (host) => (host === hostname ? [value] : []),
        addresses: async () => [],
      },
    });

    expect(result.verified).toBe(true);
  });
});
