/**
 * The shapes the artifact and its callers agree on.
 *
 * Separate from `index.ts` so the restore path, the build path and the standalone bootstrap script
 * can all import them without pulling in the admin-facing service — the bootstrap in particular
 * runs inside an exported bundle where `src/server/admin` has no meaning at all.
 */

export interface BackupContents {
  /** Table name -> row count, in the artifact. */
  tables: Record<string, number>;
  mediaFiles: number;
  mediaBytes: number;
  /** Images left out — over budget or unreadable. Counted so completeness is never implied. */
  mediaOmitted: number;
}

export interface BackupManifestFile {
  /**
   * The migration directory the artifact was taken at. A restore demands an EXACT match rather
   * than a "compatible enough" comparison, because the failure it prevents is silent: loading a
   * row shape from a different schema drops whatever column has since been added, and the shop
   * comes back looking fine and missing a field nobody checks until it matters.
   */
  schemaVersion: string;
  appCommit: string | null;
  tenantId: string;
  createdAt: string;
  contents: BackupContents;
  /** sha256 per data file, so a truncated archive is caught before it is loaded, not during. */
  checksums: Record<string, string>;
}

export class BackupError extends Error {
  constructor(
    readonly reason:
      | 'notFound'
      | 'notReady'
      | 'schemaMismatch'
      | 'corruptArchive'
      | 'sourceMissing'
      | 'busy'
      | 'demoTenant'
      | 'noSourceArchive',
    message: string,
  ) {
    super(message);
    this.name = 'BackupError';
  }
}
