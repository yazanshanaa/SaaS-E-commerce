import 'dotenv/config';
import { readFileSync, writeFileSync } from 'node:fs';
import { superAdminDb, verifiedActor, disconnectAll } from '../src/server/db';
import { purgeTenant } from '../src/server/billing';

/**
 * Purge replay — the step that makes a restore honest.
 *
 * A restore reconstitutes every tenant that was purged AFTER the dump was taken. Those are not
 * ordinary rows: each one is a deletion this platform certified as complete, to a merchant, in
 * writing, in the Arabic copy Phase 6 generates. Bringing them back and leaving them there turns
 * "destroyed from live systems" into a false statement, and the merchant has no way to know.
 *
 * ── THE PART THAT IS NOT OBVIOUS, AND THAT THE FIRST VERSION OF THIS SCRIPT GOT WRONG ──────────
 *
 * `TenantTombstone` is global and survives the tenant cascade — which is what `docs/PHASES.md`
 * means by "the tombstone survives precisely so this list exists". But global is not the same as
 * external: the table lives in the SAME database, so a dump taken at t0 carries the tombstones as
 * they were at t0, and a purge performed at t1 > t0 leaves no trace in it at all.
 *
 * Which means the restored database contains, by construction:
 *   - the resurrected tenants (alive at t0, purged after it), and
 *   - no tombstones for any of them.
 *
 * So the list CANNOT come from the database being repaired. It has to be captured from a database
 * that is newer than the dump — production, while it is still up — and carried across. Hence two
 * modes:
 *
 *   --capture <file>    read the tombstones from the CURRENT database and write them out.
 *                       Run this BEFORE the restore, against the newest database you have. For the
 *                       monthly staging test that is production, which is alive the whole time.
 *
 *   --restore-point <t> --tombstones <file>
 *                       run against the RESTORED database, re-purging every captured tenant whose
 *                       purge happened after <t> and which is present again.
 *
 * `docs/PHASES.md` phrases the selection as tombstones "whose purgedAt precedes the restore point".
 * Read with "restore point" meaning the instant of the dump, that is the wrong way round — it
 * selects the tenants the dump had already lost, every one of which is a no-op, and misses every
 * tenant the restore actually brought back. The comparison here is `purgedAt > restorePoint`, and
 * the discrepancy is recorded in `docs/DECISIONS.md` rather than silently reconciled.
 *
 * The honest limit, stated because a runbook that hides it is worse than none: purges performed
 * inside the RPO window of a true disaster — after the last dump, before the failure — are not
 * recoverable from the restore at all. Their tombstones died with the database. Six hours of
 * purges is a handful of merchants; `docs/DEPLOY.md` says where else to look for them.
 *
 *   pnpm purge:replay --capture tombstones.json
 *   pnpm purge:replay --restore-point 2026-08-12T03:00:00Z --tombstones tombstones.json --dry-run
 *   pnpm purge:replay --restore-point 2026-08-12T03:00:00Z --tombstones tombstones.json
 */

interface CapturedTombstone {
  tenantId: string;
  purgedAt: string;
  purgedById: string | null;
  reason: string;
}

interface CaptureOptions {
  mode: 'capture';
  file: string;
}

interface ReplayOptions {
  mode: 'replay';
  restorePoint: Date;
  file: string;
  dryRun: boolean;
}

function usage(message?: string): never {
  if (message) console.error(`\nERROR: ${message}\n`);
  console.error(
    [
      'usage:',
      '  pnpm purge:replay --capture <file.json>',
      '      Read every TenantTombstone from the CURRENT database and write it out.',
      '      Run this BEFORE a restore, against the newest database you have — for the monthly',
      '      staging test that is production. The restored database will not contain these rows.',
      '',
      '  pnpm purge:replay --restore-point <ISO-8601> --tombstones <file.json> [--dry-run]',
      '      Run against the RESTORED database. Re-purges every captured tenant whose purge',
      '      happened after the restore point and which the restore has brought back.',
      '',
      '  <ISO-8601> is `restorePoint` from the backup manifest: `restore.sh show <stamp>`.',
    ].join('\n'),
  );
  process.exit(2);
}

function parseArguments(argv: string[]): CaptureOptions | ReplayOptions {
  let capture: string | undefined;
  let tombstones: string | undefined;
  let restorePoint: string | undefined;
  let dryRun = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? '';
    const value = (): string => {
      const next = argv[index + 1];
      if (!next) usage(`${argument} needs a value.`);
      index += 1;
      return next;
    };

    if (argument === '--dry-run') dryRun = true;
    else if (argument === '--capture') capture = value();
    else if (argument === '--tombstones') tombstones = value();
    else if (argument === '--restore-point') restorePoint = value();
    else usage(`unrecognised argument: ${argument}`);
  }

  if (capture) return { mode: 'capture', file: capture };

  if (!restorePoint) usage('--restore-point is required (or use --capture).');
  if (!tombstones) {
    usage(
      '--tombstones is required. The restored database does not contain the tombstones for the ' +
        'tenants it resurrected — capture them from the live database first with --capture.',
    );
  }

  const parsed = new Date(restorePoint);
  if (Number.isNaN(parsed.getTime())) usage(`--restore-point is not a date: ${restorePoint}`);

  // A restore point in the future selects nothing and would report a clean run over a database
  // full of resurrected merchants. Refusing is cheap; a false all-clear here is not.
  if (parsed.getTime() > Date.now()) {
    usage(`--restore-point is in the future (${parsed.toISOString()}).`);
  }

  return { mode: 'replay', restorePoint: parsed, file: tombstones, dryRun };
}

async function capture(options: CaptureOptions): Promise<void> {
  const db = superAdminDb(verifiedActor('super_admin', null));

  const rows = await db.tenantTombstone.findMany({
    orderBy: { purgedAt: 'asc' },
    select: { tenantId: true, purgedAt: true, purgedById: true, reason: true },
  });

  const captured: CapturedTombstone[] = rows.map((row) => ({
    tenantId: row.tenantId,
    purgedAt: row.purgedAt.toISOString(),
    purgedById: row.purgedById,
    reason: row.reason,
  }));

  writeFileSync(options.file, JSON.stringify(captured, null, 2), 'utf8');
  console.log(`captured ${captured.length} tombstone(s) to ${options.file}`);
  console.log('Keep this file with the restore. The restored database will not contain these rows.');
}

async function replay(options: ReplayOptions): Promise<void> {
  let captured: CapturedTombstone[];
  try {
    captured = JSON.parse(readFileSync(options.file, 'utf8')) as CapturedTombstone[];
  } catch (error) {
    usage(`cannot read ${options.file}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const resurrectable = captured.filter(
    (row) => new Date(row.purgedAt).getTime() > options.restorePoint.getTime(),
  );

  console.log(
    `${captured.length} captured tombstone(s); ${resurrectable.length} postdate the restore point ` +
      `${options.restorePoint.toISOString()} and could have been brought back.`,
  );

  if (resurrectable.length === 0) {
    // Worth spelling out, because it is also what a wrongly-pointed run looks like.
    console.log('Nothing to replay. If you expected otherwise, check that the capture was taken');
    console.log('from a database NEWER than the dump — one taken from the restored database');
    console.log('contains only tombstones that predate it, and would print exactly this line.');
    return;
  }

  const db = superAdminDb(verifiedActor('super_admin', null));
  const present = await db.tenant.findMany({
    where: { id: { in: resurrectable.map((row) => row.tenantId) } },
    select: { id: true, slug: true, subscription: { select: { status: true } } },
  });
  const byId = new Map(present.map((tenant) => [tenant.id, tenant]));

  console.log(`${present.length} of them exist in this database and must be re-purged.\n`);

  if (options.dryRun) {
    for (const row of resurrectable) {
      const tenant = byId.get(row.tenantId);
      console.log(
        tenant
          ? `WOULD PURGE   ${row.tenantId}  (${tenant.slug}, ${tenant.subscription?.status ?? 'no subscription'})  originally purged ${row.purgedAt}`
          : `already absent ${row.tenantId}  purged ${row.purgedAt}`,
      );
    }
    console.log('\n--dry-run: nothing was changed.');
    return;
  }

  let purged = 0;
  let absent = 0;
  const blocked: Array<{ tenantId: string; slug: string; status: string }> = [];
  const failures: Array<{ tenantId: string; error: string }> = [];

  for (const row of resurrectable) {
    const tenant = byId.get(row.tenantId);
    if (!tenant) {
      absent += 1;
      continue;
    }

    /**
     * `purgeTenant` refuses anything but a suspended subscription (`state-machine.ts`, ALLOWED),
     * and that guard is right — it is what stops an admin deleting a paying shop. It can be hit
     * here: a tenant that was still ACTIVE when the dump was taken, then suspended and purged
     * before the failure, comes back active.
     *
     * The script does not suspend it to get past the guard. `suspend()` generates an export and
     * sends the merchant a WhatsApp message offering them their data — to a merchant who was
     * deleted, possibly at their own request. Reporting it and stopping is the only correct move;
     * a human decides what a resurrected active shop deserves.
     */
    const status = tenant.subscription?.status;
    if (status !== 'suspended') {
      blocked.push({ tenantId: row.tenantId, slug: tenant.slug, status: status ?? 'none' });
      continue;
    }

    try {
      // Through the billing service, never inline (invariant 5). It is also the only thing that
      // sweeps the R2 prefix — a database restore rebuilt the rows, and the objects of a deleted
      // shop are being served by the CDN right now.
      const result = await purgeTenant({
        tenantId: row.tenantId,
        // The reason names the replay, so the second tombstone is not mistaken for a second
        // decision. `purgedById` is carried through: the person who ordered the deletion is still
        // the person who ordered it.
        reason: `purge replay after restore to ${options.restorePoint.toISOString()} (originally: ${row.reason})`,
        purgedById: row.purgedById,
      });
      purged += 1;
      console.log(
        `purged ${row.tenantId} (${tenant.slug}) — ${result.objectsDeleted} object(s), ${result.usersDeleted} identity(ies)`,
      );
    } catch (error) {
      failures.push({
        tenantId: row.tenantId,
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(`FAILED ${row.tenantId}: ${error instanceof Error ? error.message : error}`);
    }
  }

  console.log(
    `\nreplayed ${purged}, already absent ${absent}, blocked ${blocked.length}, failed ${failures.length}`,
  );

  for (const entry of blocked) {
    console.error(
      `BLOCKED ${entry.tenantId} (${entry.slug}): subscription is "${entry.status}", not "suspended".`,
    );
    console.error('        It was purged after the dump but was not yet suspended when the dump was');
    console.error('        taken. purgeTenant refuses an unsuspended tenant and this script will not');
    console.error('        suspend it — that would send the merchant an export offer. Decide by hand.');
  }

  if (blocked.length > 0 || failures.length > 0) {
    // Non-zero, because this gets wired into a deploy script and a green exit code is what tells
    // the operator the restore is finished. It is not finished while a tenant certified as deleted
    // is live.
    console.error('\nThe restore is NOT complete. Every line above is a tenant that was certified as');
    console.error('deleted and is currently live. Resolve each one before serving traffic.');
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.mode === 'capture') await capture(options);
  else await replay(options);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => {
    void disconnectAll();
  });
