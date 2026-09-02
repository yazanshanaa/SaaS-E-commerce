/**
 * Enforce the folder ownership and the forbidden-shared-files list from docs/PHASES.md.
 *
 * Ownership is the only thing keeping three parallel worktrees from silently overwriting each
 * other, and a violation is invisible at exactly the moment it is cheap to fix: the track's own
 * gate stays green, because a track that edits `src/shared/site-contract` to suit itself has a
 * perfectly consistent tree. The damage lands at the merge, on someone else's branch, as a
 * conflict nobody has the context to resolve — or worse, as a clean auto-merge that quietly
 * reverts a contract two other tracks were coding against.
 *
 * So this is run per track BEFORE requesting a merge, and again by the main session at each
 * merge step. It is deliberately a script and not a vitest case: it needs `main` to diff
 * against, which a CI checkout of a single branch may not have, and a gate that cannot run is
 * worse than one that is invoked explicitly.
 *
 *   npx tsx scripts/check-track-ownership.ts a1 "e:/path/to/sb-a1"
 *   npx tsx scripts/check-track-ownership.ts a2          # defaults to cwd
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

// -----------------------------------------------------------------------------
// The rules, transcribed from docs/PHASES.md
// -----------------------------------------------------------------------------

/**
 * Touched by no worktree, ever. The two documented exceptions (B1 fills in `billing` and the
 * images half of `export` during Group B) are expressed as ownership entries for B1 rather than
 * holes here, so the default stays "forbidden" for everyone else.
 */
const FORBIDDEN = [
  'prisma/schema.prisma',
  'prisma/migrations/**',
  'prisma/GLOBAL_TABLES.md',
  'src/proxy.ts',
  'proxy.ts',
  'src/server/db/**',
  'src/server/auth/**',
  'src/server/entitlements/**',
  'src/server/events/**',
  'src/server/billing/**',
  'src/server/export/**',
  'src/server/http/**',
  'src/server/queues.ts',
  'src/server/jobs/**',
  // The StorageAdapter contract. NOT in the original list, and that was a gap: the interface
  // lives outside A3's folder precisely so src/server/export can depend on it, so A3 registering
  // its R2 driver by editing this folder would rewrite a contract Phase 1 already shipped.
  // A3 implements in src/server/media/storage and calls setStorageAdapter().
  'src/server/storage/**',
  // Added for Group B. `requestStorefrontRevalidation()` is the one door between the worker
  // container and Next's data cache, and B1's jobs, B2's screens and B3's demo builder all
  // reach for it. A track that "fixed" it for its own case would be rewriting the contract the
  // other two are coding against — the same shape as the storage adapter above.
  'src/server/revalidation/**',
  'src/shared/site-contract/**',
  'src/shared/features.ts',
  'src/shared/i18n/**',
  'src/env.ts',
  'src/server/demo/types.ts',
  'src/server/demo/placeholder.ts',
  'src/server/demo/packs/**',
  'package.json',
  'pnpm-lock.yaml',
  '.gitignore',
  'tsconfig.json',
  'next.config.ts',
  'eslint.config.mjs',
  'vitest.config.ts',
  'playwright.config.ts',
  'src/app/layout.tsx',
  'src/app/globals.css',
  'src/app/demo-gate/**',
  'src/app/unknown-host/**',
  'src/app/not-found.tsx',
  'src/app/export/**',
  'src/app/api/auth/**',
  'src/app/internal/**',
  'tests/e2e/hostname-resolution.spec.ts',
  'tests/e2e/auth.spec.ts',
  'tests/e2e/support/**',
  'tests/unit/language-gate.test.ts',
  'tests/unit/guardrails.test.ts',
  'tests/setup/**',
  'tests/helpers/**',
  'messages/ar/common.json',
  '.env.example',
  'docker-compose*.yml',
  'docker/**',
  'Dockerfile',
  'Caddyfile',
  'CLAUDE.md',
  'docs/BUILD-KIT.md',
  'docs/PHASES.md',
  'docs/DECISIONS.md',
  // Three tracks appending to one checklist is a conflict per track per commit. The main session
  // ticks it at merge, from the branches it just reviewed.
  'TODO.md',
  'scripts/**',
  /**
   * Added in Phase 11, and it had been missing since Group A rather than being newly relevant.
   *
   * `src/server/tenancy` owns `SURFACE_ROOT`, `UNPREFIXED_PATHS` and `surfacePath()` — the map from a
   * hostname to a route subtree, which every surface depends on and no track owns. A worktree adding
   * one entry to `UNPREFIXED_PATHS` makes that path resolve on the storefront and the admin panel too,
   * so a merchant-only route becomes reachable on every merchant's own domain. Nothing in the list
   * below is more shared than this, and it was the one piece of shared routing the check could not see.
   */
  'src/server/tenancy/**',
];

const OWNERSHIP: Record<string, readonly string[]> = {
  a1: [
    'src/app/admin/**',
    'src/app/api/admin/**',
    'src/server/admin/**',
    'messages/ar/admin.json',
    'docs/decisions/a1.md',
    'tests/**/a1-*.test.ts',
    'tests/**/a1-*.spec.ts',
  ],
  a2: [
    'src/templates/**',
    'src/app/site/**',
    'src/app/api/storefront/**',
    'public/fonts/**',
    'messages/ar/storefront.json',
    'docs/decisions/a2.md',
    'tests/**/a2-*.test.ts',
    'tests/**/a2-*.spec.ts',
  ],
  a3: [
    'src/server/media/**',
    'src/app/api/media/**',
    'messages/ar/media.json',
    'docs/decisions/a3.md',
    'tests/**/a3-*.test.ts',
    'tests/**/a3-*.spec.ts',
  ],
  b1: [
    // The two documented exceptions live here rather than as holes in FORBIDDEN.
    'src/server/billing/**',
    'src/server/export/**',
    'src/server/jobs/**',
    'src/app/admin/lifecycle/**',
    'messages/ar/billing.json',
    'docs/decisions/b1.md',
    'tests/**/b1-*.test.ts',
    'tests/**/b1-*.spec.ts',
  ],
  b2: [
    'src/app/dashboard/**',
    'src/app/api/dashboard/**',
    'messages/ar/dashboard.json',
    'docs/decisions/b2.md',
    'tests/**/b2-*.test.ts',
    'tests/**/b2-*.spec.ts',
  ],
  b3: [
    'src/server/demo/**',
    'src/app/admin/demos/**',
    'src/app/(public)/**',
    'messages/ar/demo.json',
    'docs/decisions/b3.md',
    'tests/**/b3-*.test.ts',
    'tests/**/b3-*.spec.ts',
  ],

  /*
    PHASE 11 — templates that look designed, dashboards that feel easy (docs/PHASE-11.md).

    Track 11.0 is absent on purpose: it is main-session work by definition (shared contracts,
    forbidden files, shared test suites), and a track entry for it would be a licence to do that
    work from a worktree.

    Order: 11.A -> (11.B | 11.C | 11.D | 11.H) -> 11.E -> 11.F -> 11.G.
  */
  '11a': [
    // 11.A owns `storefront.css` OUTRIGHT so 11.C cannot collide with it — the two tracks were
    // both specced against that file before this table existed, which is precisely the collision
    // this script is for.
    'src/templates/components/**',
    'src/templates/sections/**',
    'src/templates/storefront.css',
    'src/templates/diwan/**',
    'src/templates/neon-souq/**',
    'src/templates/warsheh/**',
    'src/templates/bayt/**',
    'src/templates/raff/**',
    'docs/decisions/11a.md',
    'tests/**/11a-*.test.ts',
    'tests/**/11a-*.spec.ts',
  ],
  '11b': ['src/templates/aldar/**', 'docs/decisions/11b.md', 'tests/**/11b-*.test.ts'],
  // Palettes and ground blocks only. `tokens.ts` and `types.ts` are the CONTRACT and stayed in
  // 11.0, because 11.A needs the signature tokens they emit and merges first.
  '11c': ['docs/decisions/11c.md', 'tests/**/11c-*.test.ts', 'tests/**/11c-*.spec.ts'],
  '11d': [
    'src/app/dashboard/preview/**',
    'src/app/dashboard/appearance/**',
    'src/app/dashboard/_components/color-editor.tsx',
    'messages/ar/appearance.json',
    'docs/decisions/11d.md',
    'tests/**/11d-*.test.ts',
    'tests/**/11d-*.spec.ts',
  ],
  '11e': [
    'src/templates/matbakh/**',
    'src/templates/mawid/**',
    'src/templates/jihaz/**',
    'docs/decisions/11e.md',
    'tests/**/11e-*.test.ts',
  ],
  '11f': [
    'src/app/_components/kit/**',
    'src/app/kit.css',
    'src/app/dashboard/**',
    'messages/ar/dashboard.json',
    'docs/decisions/11f.md',
    'tests/**/11f-*.test.ts',
    'tests/**/11f-*.spec.ts',
  ],
  '11g': [
    'src/app/admin/**',
    'messages/ar/admin.json',
    'docs/decisions/11g.md',
    'tests/**/11g-*.test.ts',
    'tests/**/11g-*.spec.ts',
  ],
  '11h': [
    'src/app/dashboard/billing/**',
    'docs/decisions/11h.md',
    'tests/**/11h-*.test.ts',
    'tests/**/11h-*.spec.ts',
  ],
};

/**
 * Carve-outs INSIDE a track's own folder that belong to a later track. Checked before ownership,
 * because `src/app/admin/**` would otherwise happily swallow `src/app/admin/demos`.
 */
const RESERVED_WITHIN: Record<string, readonly string[]> = {
  a1: ['src/app/admin/demos/**', 'src/app/admin/lifecycle/**'],
  // The B1/B3 seam. B1 implements the demo LIFECYCLE (it creates a Tenant and writes
  // subscription state, which guardrails.test.ts allows in src/server/billing and nowhere
  // else) and B3 implements the CONTENT. The interface between them is frozen in the main
  // session for the same reason src/server/demo/types.ts is: both tracks code to it literally.
  b1: ['src/server/billing/demo-content.ts'],
  b3: ['src/server/demo/types.ts', 'src/server/demo/placeholder.ts', 'src/server/demo/packs/**'],

  /*
    PHASE 11. The 11.D / 11.F seam, and it is the reason 11.D merges first: 11.F owns
    `src/app/dashboard/**` wholesale, but three of those paths are the live preview, and a chrome
    refresh restyling a `<select>` that 11.D is about to delete is wasted work in both directions.
  */
  '11f': [
    'src/app/dashboard/preview/**',
    'src/app/dashboard/appearance/**',
    'src/app/dashboard/_components/color-editor.tsx',
    'src/app/dashboard/billing/**',
  ],
  // 11.G inherits A1's surface, and the same two carve-outs inside it still belong to B1 and B3.
  '11g': ['src/app/admin/demos/**', 'src/app/admin/lifecycle/**'],
};

// -----------------------------------------------------------------------------

/**
 * Minimal glob -> RegExp. Supports `**` (any depth) and `*` (one segment). No dependency.
 *
 * Scanned character by character rather than by a chain of .replace() calls: the naive chain
 * turns `src/app/admin/**` into a pattern anchored right after the trailing slash, so it matches
 * the DIRECTORY and nothing inside it — every real file then reads as a violation. A wall of
 * false positives is worse than no check at all: it is what teaches people to ignore one.
 */
function toRegExp(pattern: string): RegExp {
  const needsEscape = /[.+^${}()|[\]\\]/;
  let out = '';

  for (let i = 0; i < pattern.length; i += 1) {
    // charAt, not [i]: noUncheckedIndexedAccess types the index access as possibly undefined,
    // and the lookaheads below compare against undefined perfectly happily anyway.
    const char = pattern.charAt(i);

    if (char === '*' && pattern[i + 1] === '*') {
      if (pattern[i + 2] === '/') {
        // `a/**/b` — zero or more whole segments in between.
        out += '(?:[^/]+/)*';
        i += 2;
      } else {
        // `a/**` — everything beneath it.
        out += '.*';
        i += 1;
      }
    } else if (char === '*') {
      out += '[^/]*';
    } else {
      out += needsEscape.test(char) ? '\\' + char : char;
    }
  }

  return new RegExp('^' + out + '$');
}

/**
 * Self-test, run on every invocation.
 *
 * The matcher IS the check. If it silently stops matching, this script prints "clean" for a
 * branch that rewrote the schema. Six assertions cost nothing and make that failure loud.
 */
function assertMatcherWorks(): void {
  const cases: Array<[string, string, boolean]> = [
    ['src/app/admin/**', 'src/app/admin/_components/nav.tsx', true],
    ['src/app/admin/**', 'src/app/dashboard/page.tsx', false],
    ['tests/**/a1-*.test.ts', 'tests/integration/a1-admin.test.ts', true],
    ['tests/**/a1-*.test.ts', 'tests/integration/a2-storefront.test.ts', false],
    ['src/app/(public)/**', 'src/app/(public)/demo-request/page.tsx', true],
    ['prisma/schema.prisma', 'prisma/schema.prisma', true],
  ];

  for (const [pattern, file, expected] of cases) {
    if (toRegExp(pattern).test(file) !== expected) {
      throw new Error(`glob matcher is broken: ${pattern} vs ${file} should be ${expected}`);
    }
  }
}

const compile = (patterns: readonly string[]): RegExp[] => patterns.map(toRegExp);
const matches = (regexps: readonly RegExp[], file: string): boolean =>
  regexps.some((re) => re.test(file));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/**
 * Everything the branch has changed, committed or not.
 *
 * Uncommitted work counts: the point is to catch a violation while the author still remembers
 * why they made it, not after it is buried three commits deep.
 */
function changedFiles(cwd: string, base: string): string[] {
  const out = new Set<string>();

  for (const line of git(cwd, ['diff', '--name-only', `${base}...HEAD`]).split('\n')) {
    if (line.trim()) out.add(line.trim());
  }

  for (const line of git(cwd, ['status', '--porcelain', '--untracked-files=all']).split('\n')) {
    const file = line.slice(3).trim();
    if (file) out.add(file.replace(/^"|"$/g, ''));
  }

  return [...out].sort();
}

/**
 * The blind spot in every `main...HEAD` diff: commits made TO main.
 *
 * A track that edits a forbidden file inside its worktree is caught by the check above. A track
 * that walks into the main checkout and commits there is not — the commit becomes the baseline
 * every other diff is measured against, so it vanishes from all of them. That is the failure
 * mode with the worst blast radius, because the whole point of the forbidden list is that these
 * files change only under main-session review.
 *
 * This cannot be decided automatically: the main session commits to main legitimately all the
 * time, and it shares a git identity with every agent. So the check reports rather than judges —
 * it prints what main has accumulated since the group started, and the reviewer confirms each
 * one was theirs. Set the baseline with a tag (`group-a-base`) or OWNERSHIP_GROUP_BASE.
 */
function reportMainHistory(cwd: string): void {
  const baseline = process.env.OWNERSHIP_GROUP_BASE ?? 'group-a-base';

  let log: string;
  try {
    log = git(cwd, ['log', '--oneline', '--no-decorate', `${baseline}..main`]);
  } catch {
    console.log(`main history: baseline '${baseline}' not found — skipping`);
    console.log("  create it when a parallel group starts: git tag group-a-base main");
    return;
  }

  const commits = log.split('\n').filter((line) => line.trim());

  console.log(`main history since ${baseline}: ${commits.length} commit(s)`);
  if (commits.length === 0) return;

  for (const commit of commits) {
    console.log(`    ${commit}`);
  }
  console.log('  ^ every one of these must be main-session work that was reviewed.');
  console.log('    A commit here from a track agent is a forbidden-file edit that no diff shows.');
}

function main(): void {
  assertMatcherWorks();

  const [track, dirArg] = process.argv.slice(2);

  if (!track || !OWNERSHIP[track]) {
    console.error(`usage: npx tsx scripts/check-track-ownership.ts <${Object.keys(OWNERSHIP).join('|')}> [worktree-dir]`);
    process.exit(2);
  }

  const cwd = path.resolve(dirArg ?? process.cwd());
  const base = process.env.OWNERSHIP_BASE ?? 'main';

  const forbidden = compile(FORBIDDEN);
  const owned = compile(OWNERSHIP[track]);
  const reserved = compile(RESERVED_WITHIN[track] ?? []);

  const violations: Array<[string, string]> = [];

  const files = changedFiles(cwd, base);

  for (const file of files) {
    if (matches(reserved, file)) {
      violations.push([file, 'reserved for another track inside your own folder']);
    } else if (matches(owned, file)) {
      // OWNERSHIP BEATS FORBIDDEN, and the order is what makes the FORBIDDEN comment true.
      //
      // The two documented Group B exceptions (B1 fills in `src/server/billing` and the images
      // half of `src/server/export`, and owns `src/server/jobs`) are expressed as ownership
      // entries rather than as holes in FORBIDDEN, precisely so the default stays "forbidden"
      // for every other track. Checking FORBIDDEN first threw that away: B1's own folders came
      // back as sixteen violations, and a wall of false positives on the one branch that is
      // supposed to touch them is how a reviewer learns to run this check and ignore it.
      //
      // Safe for the other five tracks: RESERVED_WITHIN is still evaluated first, so B3 still
      // cannot touch `src/server/demo/types.ts` and B1 still cannot touch
      // `src/server/billing/demo-content.ts`; and no other track lists a forbidden path in its
      // ownership, so `src/server/queues.ts`, `src/server/storage/**` and
      // `src/server/revalidation/**` remain forbidden to everyone — nobody owns them.
      continue;
    } else if (matches(forbidden, file)) {
      violations.push([file, 'FORBIDDEN shared file — this is a sync point, not an edit']);
    } else {
      violations.push([file, `outside ${track}'s ownership`]);
    }
  }

  console.log(`ownership check: ${track}  (${cwd})  base=${base}  files=${files.length}`);
  reportMainHistory(cwd);

  if (files.length === 0) {
    // Reported distinctly from "clean". A branch with no changes passes every rule trivially,
    // and printing the same green line for both is how an empty track gets merged as done.
    console.log('  NOTHING CHANGED — this branch has done no work yet');
    return;
  }

  if (violations.length === 0) {
    console.log(`  clean — all ${files.length} changed paths are inside this track's ownership`);
    return;
  }

  console.log(`  ${violations.length} violation(s):`);
  for (const [file, reason] of violations) {
    console.log(`    ${file}\n      -> ${reason}`);
  }
  process.exitCode = 1;
}

main();
