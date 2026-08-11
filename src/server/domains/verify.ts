import { stripTrailingDot, systemDnsLookup, type DnsLookup } from './dns';
import { verificationTxtValue, verificationTxtNames } from './hostname';

/**
 * Does the merchant actually control this hostname, and have they pointed it at us?
 *
 * Two accepted proofs, checked in this order:
 *
 *   CNAME — `shop.example.com` is a CNAME for `{slug}.{DOMAIN}`. This is the one that also makes
 *           the site WORK, so it is tried first and is what the instructions lead with.
 *   TXT   — `souq-verify={token}` on the hostname itself or on `_souq-verify.{hostname}`. This
 *           exists because a provider will refuse a TXT beside a CNAME on the same name (a CNAME
 *           must be alone in its record set), and because a merchant may want to prove control
 *           before cutting live traffic over.
 *
 * A TXT proof means "you own this name"; it does NOT mean traffic reaches us. Both are recorded
 * as `verified`, because that is the state the ask endpoint needs before Caddy may mint a
 * certificate — and a certificate for a name that does not resolve to us is simply never
 * requested. The merchant is told, in the UI, which proof landed.
 */

export type VerificationMethod = 'cname' | 'txt';

export type VerificationFailure =
  /** A CNAME exists and points somewhere else. The likeliest cause is a typo. */
  | 'cnameMismatch'
  /**
   * No CNAME, but the name resolves to addresses. Almost always Cloudflare's orange cloud: a
   * proxied record is flattened, so the CNAME becomes invisible to every resolver on earth AND
   * the certificate challenge never reaches us. This is THE failure this platform sees most, and
   * it has its own message telling the merchant to switch the record to DNS-only.
   */
  | 'proxied'
  /** Nothing at that name at all — not added yet, or not propagated. */
  | 'missing';

export interface VerificationResult {
  verified: boolean;
  method?: VerificationMethod;
  failure?: VerificationFailure;
  /** What we actually saw, for the "we looked and found this" line in the UI. Never a secret. */
  observedCnames: string[];
}

export interface CheckDomainInput {
  hostname: string;
  /** The tenant's own platform subdomain — see `cnameTarget()` for why it is not shared. */
  cnameTarget: string;
  token: string;
  lookup?: DnsLookup;
}

export async function checkDomainOwnership(input: CheckDomainInput): Promise<VerificationResult> {
  const lookup = input.lookup ?? systemDnsLookup();
  const target = stripTrailingDot(input.cnameTarget);

  /**
   * BOTH sides are normalised here, not just ours.
   *
   * `systemDnsLookup` already strips the trailing dot a resolver returns, so this looks redundant
   * — and it is exactly the kind of redundancy that stops being redundant. `DnsLookup` is a public,
   * injectable interface; the moment a second implementation returns `shop.example.com.` verbatim,
   * a string comparison against `shop.example.com` fails, verification never succeeds for anyone,
   * and there is nothing in the output to say why. The comparison is the right place to own the
   * shape of what it compares.
   */
  const cnames = (await lookup.cname(input.hostname)).map(stripTrailingDot);
  if (cnames.includes(target)) {
    return { verified: true, method: 'cname', observedCnames: cnames };
  }

  const expected = verificationTxtValue(input.token);
  const names = verificationTxtNames(input.hostname);
  const txtRecords = (await Promise.all(names.map((name) => lookup.txt(name)))).flat();

  if (txtRecords.some((value) => value.trim() === expected)) {
    return { verified: true, method: 'txt', observedCnames: cnames };
  }

  if (cnames.length > 0) {
    return { verified: false, failure: 'cnameMismatch', observedCnames: cnames };
  }

  const addresses = await lookup.addresses(input.hostname);
  return {
    verified: false,
    failure: addresses.length > 0 ? 'proxied' : 'missing',
    observedCnames: cnames,
  };
}
