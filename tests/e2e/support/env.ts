import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Fixed coordinates for the end-to-end environment.
 *
 * They are constants rather than discovered values because Playwright resolves `webServer.env`
 * when the CONFIG loads, before globalSetup has run — so the ports have to be agreed in
 * advance rather than reported afterwards.
 */
export const E2E = {
  webPort: Number(process.env.E2E_PORT ?? 3100),
  pgPort: Number(process.env.E2E_PG_PORT ?? 55433),
  smtpPort: Number(process.env.E2E_SMTP_PORT ?? 1026),
  database: 'souq_bartaa_e2e',
  domain: 'souqbartaa.test',
  adminEmail: 'e2e-admin@souqbartaa.test',
  adminPassword: 'E2ePassword!2026',
} as const;

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const mailFile = path.join(repoRoot, '.tmp', 'e2e-mail.json');
/**
 * Where the suite's media lands. Under `.tmp/` with the rest of the e2e artefacts rather than in
 * `./storage`, which is a developer's own dev-driver disk — a suite that writes fifteen images per
 * demo has no business mixing its output into that.
 */
export const storageDir = path.join(repoRoot, '.tmp', 'e2e-storage');
export const pgDataDir = path.join(repoRoot, '.pgdata-e2e');

export function pgUrl(user: string, password: string, database: string = E2E.database): string {
  return `postgresql://${user}:${password}@127.0.0.1:${E2E.pgPort}/${database}?schema=public`;
}

export function origin(host: string): string {
  return `http://${host}.${E2E.domain}:${E2E.webPort}`;
}
