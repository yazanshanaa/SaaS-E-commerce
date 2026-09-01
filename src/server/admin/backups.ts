import { getEnv } from '@/env';
import { logger } from '@/server/logger';
import {
  backupStorage,
  backupStorageConfigured,
} from '@/server/media/storage/backup-storage';
import { cacheRedis } from '@/server/redis';
import { MAX_SIGNED_URL_TTL_SECONDS, type StoredObject } from '@/server/storage';
import { auditPlatformAction } from './audit';
import type { AdminContext } from './context';

/**
 * The PLATFORM backup surface (Q23) — read, run-now, download. Super admin only, and there is no
 * merchant counterpart anywhere: `app.*` never renders a word of this.
 *
 * WHAT THIS FILE IS NOT: it does not take backups. `docker/backup/` does, in its own container,
 * because that container is the only one with `pg_dump`, `age` and the write credentials — and
 * deliberately so. Giving the web container those tools would put the ability to dump every
 * tenant's database inside the one process reachable from the internet. So the screen OBSERVES a
 * sidecar and can ASK it to run, over a two-key Redis channel:
 *
 *   {prefix}run-request  — the web container SETs it (NX, 1h TTL). The sidecar polls, DELs it and
 *                          starts a round immediately instead of waiting out its interval.
 *   {prefix}status       — the sidecar writes it after every round. The screen's "last round" card.
 *
 * NO RESTORE BUTTON, and that is a decision rather than an omission (Q23). A restore drops and
 * recreates a database; a mis-click on a page an operator visits to READ would be unrecoverable in
 * the one situation the page exists for. The runbook (`docs/DEPLOY.md` §6) stays the procedure and
 * the screen renders its steps.
 *
 * EVERY ACTION IS AUDITED to `platform_audit_logs` — a backup round and a dump download have no
 * tenant, and the global log is the one that survives whatever happens next.
 *
 * THE CHANNEL RUNS OVER `cacheRedis()`, not the queue connection, and the compose points the
 * sidecar at the same database. `queueRedis()` retries forever by design (BullMQ blocks on
 * BRPOPLPUSH), so a screen reading through it against a dead Redis would hang the request instead
 * of rendering "unavailable" — the exact hazard `billing/dispatch.ts` exists to bound. Living in a
 * flushable database costs at most one pending request (the button re-enables) and one status card
 * (the next round rewrites it); the MANIFESTS on R2 remain the source of truth for everything that
 * matters.
 */

/** What `docker/backup/backup.sh` writes to `{stamp}/manifest.json`, mirrored as a type. */
export interface BackupManifestDatabase {
  database: string;
  key: string;
  plainBytes: number;
  plainSha256: string;
  encryptedBytes: number;
}

export interface BackupManifest {
  restorePoint: string;
  stamp: string;
  retentionDays: number;
  intervalHours: number;
  failures: number;
  databases: BackupManifestDatabase[];
}

export interface BackupRound extends BackupManifest {
  /** Object key of the manifest itself — the id an action refers to a round by. */
  manifestKey: string;
  /** Whole hours since `restorePoint`, so the screen can age a round without a client clock. */
  ageHours: number;
  ok: boolean;
}

/** The sidecar's own last word, when it has written one. */
export interface BackupSidecarStatus {
  finishedAt: string;
  ok: boolean;
  failures: number;
  stamp: string;
  lifecycleOk: boolean;
  lifecycleDays: number | null;
}

export interface BackupsView {
  configured: boolean;
  rounds: BackupRound[];
  /** Newest successful round, which is the only one that answers "are we covered". */
  lastGood: BackupRound | null;
  /** True when the newest good round is older than the published interval plus an hour. */
  stale: boolean;
  status: BackupSidecarStatus | null;
  /** A run-now is queued and the sidecar has not picked it up yet. */
  runPending: boolean;
  /** Published to every tenant's privacy policy. Read-only here — see the note below. */
  intervalHours: number;
  retentionDays: number;
  prefix: string;
  /** Whether the lifecycle rule the script checks on every round agrees with the published number. */
  lifecycleWarning: string | null;
}

const MANIFEST_SUFFIX = '/manifest.json';
/** Enough to cover the retention window at any sane interval; the list is newest-first anyway. */
const MAX_MANIFESTS = 400;

function controlKey(name: 'run-request' | 'status'): string {
  return `${getEnv().BACKUP_CONTROL_PREFIX}${name}`;
}

function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 3_600_000));
}

/**
 * Parse one manifest. A round whose manifest does not parse is REPORTED, never dropped.
 *
 * A dump that uploaded and whose manifest is truncated is exactly the round an operator most needs
 * to see, and silently skipping it would render a gap in the timeline as no gap at all — the shape
 * of "we thought we had backups".
 */
function toRound(manifestKey: string, raw: string, now: Date): BackupRound | null {
  let parsed: BackupManifest;
  try {
    parsed = JSON.parse(raw) as BackupManifest;
  } catch {
    return null;
  }

  if (!parsed?.restorePoint || !Array.isArray(parsed.databases)) return null;

  const restorePoint = new Date(parsed.restorePoint);
  if (Number.isNaN(restorePoint.getTime())) return null;

  return {
    ...parsed,
    manifestKey,
    ageHours: hoursBetween(restorePoint, now),
    ok: (parsed.failures ?? 0) === 0 && parsed.databases.length > 0,
  };
}

async function readStatus(): Promise<BackupSidecarStatus | null> {
  try {
    const raw = await cacheRedis().get(controlKey('status'));
    return raw ? (JSON.parse(raw) as BackupSidecarStatus) : null;
  } catch {
    // The screen is still useful without it — the manifests are the source of truth and Redis is
    // only how the sidecar volunteers its own view.
    return null;
  }
}

async function readRunPending(): Promise<boolean> {
  try {
    return (await cacheRedis().exists(controlKey('run-request'))) === 1;
  } catch {
    return false;
  }
}

/**
 * The screen's whole data load.
 *
 * `list()` returns manifest objects newest-last (S3 lists lexicographically and the stamp is
 * `YYYY/MM/DD/HHMMSSZ`, so lexical order IS chronological order — which is why the stamp was
 * written that way). They are reversed here rather than sorted by a parsed date, because a
 * malformed manifest still has a key and still belongs in position.
 */
export async function loadBackups(limit = 30): Promise<BackupsView> {
  const env = getEnv();
  const configured = backupStorageConfigured();
  const base = {
    configured,
    intervalHours: env.BACKUP_INTERVAL_HOURS,
    retentionDays: env.BACKUP_RETENTION_DAYS,
    prefix: env.BACKUP_PREFIX,
  };

  if (!configured) {
    return {
      ...base,
      rounds: [],
      lastGood: null,
      stale: false,
      status: null,
      runPending: false,
      lifecycleWarning: null,
    };
  }

  const now = new Date();
  const [objects, status, runPending] = await Promise.all([
    backupStorage()
      .list(`${env.BACKUP_PREFIX}/`, MAX_MANIFESTS)
      .catch((error: unknown) => {
        logger().error({ error: (error as Error).message }, 'backup bucket could not be listed');
        return [] as StoredObject[];
      }),
    readStatus(),
    readRunPending(),
  ]);

  const manifestKeys = objects
    .map((object) => object.key)
    .filter((key) => key.endsWith(MANIFEST_SUFFIX))
    .reverse()
    .slice(0, limit);

  const rounds: BackupRound[] = [];
  for (const key of manifestKeys) {
    try {
      const body = await backupStorage().get(key);
      const round = toRound(key, body.toString('utf8'), now);
      if (round) rounds.push(round);
      else {
        // Present, unreadable, and said so — see `toRound`'s comment.
        rounds.push({
          manifestKey: key,
          restorePoint: '',
          stamp: key.slice(env.BACKUP_PREFIX.length + 1, -MANIFEST_SUFFIX.length),
          retentionDays: env.BACKUP_RETENTION_DAYS,
          intervalHours: env.BACKUP_INTERVAL_HOURS,
          failures: 1,
          databases: [],
          ageHours: 0,
          ok: false,
        });
      }
    } catch (error) {
      logger().error({ key, error: (error as Error).message }, 'a backup manifest could not be read');
    }
  }

  const lastGood = rounds.find((round) => round.ok) ?? null;

  /**
   * Stale means "older than the schedule we publish, plus an hour" — the same bound
   * `docs/DEPLOY.md` §7 gives the Uptime Kuma push monitor, so the screen and the pager agree
   * about what late means instead of each having an opinion.
   */
  const stale = !lastGood || lastGood.ageHours > env.BACKUP_INTERVAL_HOURS + 1;

  /**
   * The script CHECKS the R2 lifecycle rule on every round and cannot install one. That check is
   * the only thing standing between "retained 14 days" as a published legal claim and an
   * ever-growing bucket, so its answer is surfaced here rather than left in container logs nobody
   * reads.
   */
  let lifecycleWarning: string | null = null;
  if (status && !status.lifecycleOk) lifecycleWarning = 'missing';
  else if (status && status.lifecycleDays !== null && status.lifecycleDays !== env.BACKUP_RETENTION_DAYS) {
    lifecycleWarning = 'mismatch';
  }

  return { ...base, rounds, lastGood, stale, status, runPending, lifecycleWarning };
}

// -----------------------------------------------------------------------------
// Actions
// -----------------------------------------------------------------------------

export type BackupActionResult = { ok: true } | { ok: false; reason: string };

/**
 * Ask the sidecar for a round now.
 *
 * `SET NX` with a one-hour TTL, which gives three properties for free: a second press while one is
 * pending is a no-op rather than a queue of rounds; a sidecar that is down does not accumulate
 * requests forever; and the key's mere existence is the "waiting" state the screen renders.
 *
 * The request carries WHO asked, so the audit row and the sidecar's own log agree.
 */
export async function requestBackupRun(ctx: AdminContext): Promise<BackupActionResult> {
  if (!backupStorageConfigured()) return { ok: false, reason: 'notConfigured' };

  let created: string | null = null;
  try {
    created = await cacheRedis().set(
      controlKey('run-request'),
      JSON.stringify({ requestedById: ctx.userId, requestedAt: new Date().toISOString() }),
      'EX',
      3_600,
      'NX',
    );
  } catch (error) {
    logger().error({ error: (error as Error).message }, 'backup run request could not be queued');
    return { ok: false, reason: 'unavailable' };
  }

  if (created === null) return { ok: false, reason: 'alreadyPending' };

  await auditPlatformAction(ctx, {
    action: 'backup.run_requested',
    entityType: 'platform_backup',
  });

  return { ok: true };
}

export interface BackupDownload {
  url: string;
  key: string;
}

/**
 * A short-lived signed URL for ONE dump, audited before it is minted.
 *
 * The key is validated against the configured prefix rather than trusted: this is a super-admin
 * screen, but the parameter still arrives from a form, and "any key in the backup bucket" is a
 * wider grant than "a dump this round produced" for no benefit at all.
 *
 * The file stays age-encrypted. The identity is deliberately NOT on the server (docs/DEPLOY.md §2),
 * so what this hands over is a ciphertext the operator can decrypt with the key in their password
 * manager — which is the property that makes offering the download safe in the first place.
 */
export async function downloadBackupObject(
  ctx: AdminContext,
  key: string,
): Promise<BackupDownload | { ok: false; reason: string }> {
  if (!backupStorageConfigured()) return { ok: false, reason: 'notConfigured' };

  const env = getEnv();
  const trimmed = key.trim();
  if (!trimmed.startsWith(`${env.BACKUP_PREFIX}/`) || trimmed.includes('..')) {
    return { ok: false, reason: 'invalidKey' };
  }

  const head = await backupStorage()
    .head(trimmed)
    .catch(() => null);
  if (!head) return { ok: false, reason: 'notFound' };

  // BEFORE the URL is minted, so a download that then fails still leaves the intent recorded.
  await auditPlatformAction(ctx, {
    action: 'backup.artifact_downloaded',
    entityType: 'platform_backup',
    entityId: trimmed,
    after: { sizeBytes: head.size },
  });

  const url = await backupStorage().signedUrl(
    trimmed,
    Math.min(env.EXPORT_SIGNED_URL_TTL_SECONDS, MAX_SIGNED_URL_TTL_SECONDS),
  );

  return { url, key: trimmed };
}
