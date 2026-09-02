/**
 * Fetch the Rubik Arabic-subset woff2 pair into `public/fonts/rubik/` (Phase 11, Q32).
 *
 * Same provenance as the three faces already on disk (google-webfonts-helper's static gstatic
 * files, versioned in the filename). Run ONCE per checkout on a machine with network access:
 *
 *     node scripts/fetch-rubik.mjs        (or double-click scripts/fetch-rubik.cmd)
 *
 * The two files are design assets, not build artefacts — commit them. `pnpm test` fails loudly
 * while they are absent (`tests/unit/phase9-templates.test.ts` asserts every `fontUrl()` resolves
 * to a file on disk, and `a2-templates.test.ts` caps each at 120,000 bytes), so a checkout that
 * skipped this step cannot pass the gate by accident.
 */
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'public', 'fonts', 'rubik');

/** gwfh.mranftl.com/api/fonts/rubik?subsets=arabic — static per-weight arabic subsets, v31. */
const FILES = [
  {
    name: 'rubik-v31-arabic-regular.woff2',
    url: 'https://fonts.gstatic.com/s/rubik/v31/iJWZBXyIfDnIV5PNhY1KTN7Z-Yh-B4iFUkU1.woff2',
  },
  {
    name: 'rubik-v31-arabic-700.woff2',
    url: 'https://fonts.gstatic.com/s/rubik/v31/iJWZBXyIfDnIV5PNhY1KTN7Z-Yh-4I-FUkU1.woff2',
  },
];

const CAP = 120_000; // the a2-templates ceiling: anything larger is not a real Arabic subset.

mkdirSync(dir, { recursive: true });

for (const file of FILES) {
  const response = await fetch(file.url);
  if (!response.ok) {
    console.error(`FAILED ${file.name}: HTTP ${response.status} from ${file.url}`);
    process.exitCode = 1;
    continue;
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength >= CAP) {
    console.error(`FAILED ${file.name}: ${bytes.byteLength} bytes — not an Arabic subset, refusing to write`);
    process.exitCode = 1;
    continue;
  }
  const target = path.join(dir, file.name);
  writeFileSync(target, bytes);
  console.log(`ok  ${file.name}  ${statSync(target).size} bytes`);
}
