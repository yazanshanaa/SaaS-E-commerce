import { Resolver } from 'node:dns/promises';
import { getEnv } from '@/env';

/**
 * The DNS probe behind the verify button.
 *
 * It asks PUBLIC resolvers rather than the container's, and that is the difference between a
 * verify button that works and one that lies. A merchant adds the CNAME and clicks verify a
 * minute later; a caching resolver that has already answered NXDOMAIN for that name goes on
 * answering it for the whole negative TTL — up to an hour on many zones — so the person who did
 * everything correctly is told their DNS is wrong. Asking 1.1.1.1 and 8.8.8.8 directly is the
 * closest we get to what Let's Encrypt will see when Caddy asks it for a certificate.
 *
 * Every lookup is injectable, because a test suite must not depend on the internet — and because
 * "did the merchant point the record at us" is exactly the logic worth testing without it.
 */

export interface DnsLookup {
  cname(hostname: string): Promise<string[]>;
  txt(hostname: string): Promise<string[]>;
  /** A record. Only used to tell "no CNAME at all" from "a CNAME your provider is flattening". */
  addresses(hostname: string): Promise<string[]>;
}

/** A lookup that answered nothing, for whatever reason. Never an exception at the call site. */
const EMPTY: string[] = [];

function stripTrailingDot(value: string): string {
  return value.replace(/\.+$/, '').toLowerCase();
}

function buildResolver(): Resolver {
  const env = getEnv();
  const resolver = new Resolver({ timeout: env.DNS_TIMEOUT_MS, tries: 2 });

  const servers = env.DNS_RESOLVERS.split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  if (servers.length > 0) {
    try {
      resolver.setServers(servers);
    } catch {
      // A malformed DNS_RESOLVERS must not take the verify button down; the system resolver is
      // a worse answer than 1.1.1.1 but a far better one than a 500.
    }
  }

  return resolver;
}

export function systemDnsLookup(): DnsLookup {
  return {
    async cname(hostname) {
      try {
        return (await buildResolver().resolveCname(hostname)).map(stripTrailingDot);
      } catch {
        return EMPTY;
      }
    },
    async txt(hostname) {
      try {
        // A TXT record is an array of strings that a resolver may have split at 255 bytes;
        // joining them is what the RFC says the value actually is.
        return (await buildResolver().resolveTxt(hostname)).map((chunks) => chunks.join('').trim());
      } catch {
        return EMPTY;
      }
    },
    async addresses(hostname) {
      try {
        return await buildResolver().resolve4(hostname);
      } catch {
        return EMPTY;
      }
    },
  };
}

export { stripTrailingDot };
