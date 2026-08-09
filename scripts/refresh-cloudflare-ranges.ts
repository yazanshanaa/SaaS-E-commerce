/**
 * Refreshes the pinned Cloudflare range file (invariant 9).
 *
 * The ranges are PINNED rather than fetched at request time on purpose: getClientIp() runs on
 * every request, and a network call in that path would either add latency to everything or
 * fail open — and failing open here means trusting a forged CF-Connecting-IP header.
 *
 * Run it in CI or from the daily cron (CLOUDFLARE_RANGES_REFRESH_CRON). The diff it produces
 * is reviewable, which is the other reason not to do this at runtime.
 *
 *   pnpm cf:refresh-ranges
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TARGET = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/server/http/cloudflare-ranges.json',
);

async function fetchList(url: string): Promise<string[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`${url} responded ${res.status}`);
  }
  return (await res.text())
    .split(/\s+/)
    .map((line) => line.trim())
    .filter(Boolean);
}

const [v4, v6] = await Promise.all([
  fetchList('https://www.cloudflare.com/ips-v4'),
  fetchList('https://www.cloudflare.com/ips-v6'),
]);

if (v4.length === 0 || v6.length === 0) {
  throw new Error('Refusing to write an empty range file — that would trust every peer.');
}

writeFileSync(
  TARGET,
  `${JSON.stringify(
    {
      fetchedAt: new Date().toISOString(),
      source: 'https://www.cloudflare.com/ips-v4 + ips-v6',
      v4,
      v6,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

console.log(`Wrote ${v4.length} IPv4 and ${v6.length} IPv6 ranges to ${TARGET}`);
