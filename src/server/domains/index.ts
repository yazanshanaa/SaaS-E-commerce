/**
 * Phase 4 — custom domains.
 *
 * CNAME ONLY IN V1 (Q7). Apex is documented in `docs/DOMAINS.md` as advanced instructions and is
 * deliberately not a supported path: most providers cannot hold a CNAME at the apex, the ALIAS /
 * ANAME substitutes behave differently at every one of them, and an A record at the apex means a
 * server IP change breaks every apex domain on the platform at the same moment — silently, on a
 * day nobody is looking at DNS.
 *
 * Everything here is a primitive: hostname rules, the DNS probe, the ownership proof, the cap and
 * the on-demand-TLS decision. The merchant-facing orchestration (audit rows, cache invalidation,
 * Arabic messages) lives in `src/app/dashboard/_lib/domains.ts`, which is where a
 * `MerchantContext` exists.
 */

export { decideDomainAsk, type AskDecision } from './ask';
export { systemDnsLookup, stripTrailingDot, type DnsLookup } from './dns';
export {
  EXAMPLE_HOSTNAME,
  EXAMPLE_HOSTNAME_LABEL,
  VERIFICATION_TXT_LABEL,
  VERIFICATION_TXT_PREFIX,
  cnameTarget,
  customHostnameSchema,
  isPlatformHostname,
  normaliseDomainInput,
  verificationTxtNames,
  verificationTxtValue,
} from './hostname';
export { resolveDomainCap, type DomainCap } from './limits';
export {
  checkDomainOwnership,
  type CheckDomainInput,
  type VerificationFailure,
  type VerificationMethod,
  type VerificationResult,
} from './verify';
