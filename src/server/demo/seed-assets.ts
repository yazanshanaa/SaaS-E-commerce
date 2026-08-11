import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PackKey } from './types';

/**
 * The optional real-photo lookup: `seed-assets/{pack}/{sku}.(jpg|png|webp)`.
 *
 * WHY THE DIRECTORY LIVES UNDER `src/server/demo/` AND NOT AT THE REPOSITORY ROOT.
 * `src/server/demo/README.md` writes the path as a bare `seed-assets/`, but a top-level folder is
 * outside every track's ownership in `scripts/check-track-ownership.ts` — B3 creating one would be
 * a violation on the branch that adds the first photo. Keeping it inside the folder B3 owns costs
 * nothing: the packs address a file by `{pack}/{sku}.{ext}` either way.
 *
 * WHY IT IS ALLOWED TO BE ABSENT. It is absent today — no photos have been taken — and the pack
 * contract already says so: "if a real file exists, use it; otherwise generate an SVG". So every
 * failure here (no directory, no file, an unreadable file, a bundle that did not ship the folder)
 * resolves to `null` and the caller draws the placeholder. A demo is never blocked on a photo.
 *
 * WHY THE CANDIDATE ROOTS. A runtime path lookup is exactly what `billing/demo-packs.ts` warns
 * about for the packs themselves — but binary images cannot be `import`ed into a bundle the way
 * JSON can, so a path lookup is the only mechanism available. Two roots are tried because the two
 * processes that can build a demo resolve differently: the Next server runs from the project root
 * (`process.cwd()`), while the worker container may run from a compiled `dist/`, where the module's
 * own URL is the honest anchor. If neither hits — a standalone Next build that traced no photos —
 * the placeholder path takes over, and `docs/decisions/b3.md` records the
 * `outputFileTracingIncludes` entry the day real photos are added.
 */

const EXTENSIONS = ['jpg', 'jpeg', 'png', 'webp'] as const;

export const SEED_ASSET_DIRNAME = 'seed-assets';

function candidateRoots(): string[] {
  const roots = [path.join(process.cwd(), 'src', 'server', 'demo', SEED_ASSET_DIRNAME)];

  try {
    roots.push(path.join(path.dirname(fileURLToPath(import.meta.url)), SEED_ASSET_DIRNAME));
  } catch {
    // `import.meta.url` is not a file URL under some bundlers. The cwd root above still stands.
  }

  return roots;
}

export interface SeedAsset {
  bytes: Buffer;
  /** For diagnostics and for `Media.originalName` — never for deciding the type. */
  fileName: string;
}

/**
 * The pack and the sku both come from frozen JSON, but they are still checked before they are
 * joined into a path: a `..` in either would read outside the folder, and "the input is ours" is
 * an argument about today's file rather than about the code.
 */
const SAFE_SEGMENT = /^[a-z0-9][a-z0-9-]*$/i;

export async function findSeedAsset(pack: PackKey, sku: string): Promise<SeedAsset | null> {
  if (!SAFE_SEGMENT.test(pack) || !SAFE_SEGMENT.test(sku)) return null;

  for (const root of candidateRoots()) {
    for (const extension of EXTENSIONS) {
      const fileName = `${sku}.${extension}`;
      try {
        const bytes = await readFile(path.join(root, pack, fileName));
        if (bytes.byteLength > 0) return { bytes, fileName };
      } catch {
        // Missing file, missing directory, unreadable file — all the same answer.
      }
    }
  }

  return null;
}
