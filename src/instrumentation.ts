/**
 * Web-server bootstrap. Next runs `register()` once per server start, before the first request.
 *
 * A3 sync point 3, the web half. `src/server/media/storage` is the ONLY module allowed to build
 * an R2 client — `eslint.config.mjs` and `tests/unit/a3-s3-containment.test.ts` both enforce it —
 * so no other folder's bootstrap can install the adapter, whoever owns that folder.
 *
 * Without this, only `/api/media/upload` pulled `@/server/media` into its bundle. Every other
 * consumer (`src/server/export/download.ts`, `src/server/export/index.ts`,
 * `src/server/export/processors/cleanup-self-serve.ts`, `src/server/billing`) calls the bare
 * `storage()`, which THROWS under STORAGE_DRIVER=r2 when no adapter has been registered. So on a
 * fresh web container a suspended merchant opening `app.{DOMAIN}/export/{token}` from their
 * WhatsApp message got a 500 instead of their catalogue — unless someone had happened to upload a
 * photo through that same process first. Intermittent, which is worse than a clean failure: Q18's
 * promise dies for the one person it was written for, on the day their site went dark.
 *
 * `registerMediaStorage()` is idempotent and does nothing unless STORAGE_DRIVER=r2, so a
 * development checkout on the local-disk driver is unaffected.
 */
export async function register(): Promise<void> {
  // Node-only: the media storage module reaches for the S3 client and Node built-ins, neither of
  // which exists in the edge runtime Next also evaluates this file under.
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;

  const { registerMediaStorage } = await import('@/server/media/storage');
  registerMediaStorage();
}
