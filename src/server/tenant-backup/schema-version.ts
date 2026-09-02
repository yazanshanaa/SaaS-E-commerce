/**
 * WHICH SCHEMA an artifact was taken at, and what a restore demands.
 *
 * A single hand-maintained constant rather than a directory listing at runtime, deliberately:
 *
 *   - the worker container ships `prisma/` but a standalone bundle's bootstrap runs before any of
 *     it is guaranteed present, so a filesystem read would work in one of the two places this
 *     value is needed;
 *   - and it must change when the SHAPE changes, which is a human judgement. A directory listing
 *     would also move for a migration that only adds an index, silently invalidating every backup
 *     an operator holds for no reason at all.
 *
 * THE RULE, so the next migration knows what to do: bump this to the new migration's directory
 * name when a migration adds, removes or retypes a COLUMN on any table in `tables.ts`. Leave it
 * alone for indexes, constraints, and changes to tables the backup does not carry. Then say which
 * you did in `docs/DECISIONS.md`, because an operator holding a backup that just stopped being
 * restorable deserves a sentence explaining it.
 */
export const CURRENT_SCHEMA_VERSION = '20260821000000_phase10_backups';

/**
 * Exact match. Not a range, not "newer is fine".
 *
 * The tempting version — accept an older artifact because "the new columns will just be null" — is
 * exactly the silent data loss this guards against: `NOT NULL DEFAULT` columns added since would
 * take their defaults, and a shop would come back with, say, every product's stock policy reset to
 * the platform default and nothing anywhere saying so.
 */
export function isRestorableSchema(version: string): boolean {
  return version === CURRENT_SCHEMA_VERSION;
}
