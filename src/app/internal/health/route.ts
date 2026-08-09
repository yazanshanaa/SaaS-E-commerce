import { NextResponse } from 'next/server';

/**
 * Liveness. Internal to the docker network (Uptime Kuma and the container healthcheck use it),
 * and deliberately hostname-agnostic: proxy.ts passes `/internal/*` through without resolving
 * a tenant, so a health check never depends on DNS being right.
 *
 * It reports that the PROCESS is up and nothing more — no database round trip. A readiness
 * probe that fails when Postgres blinks would restart a web server that was about to recover.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return NextResponse.json({ status: 'ok' }, { headers: { 'cache-control': 'no-store' } });
}
