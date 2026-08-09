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
};

/**
 * Carve-outs INSIDE a track's own folder that belong to a later track. Checked before ownership,
 * because `src/app/admin/**` would otherwise happily swallow `src/app/admin/demos`.
 */
const RESERVED_WITHIN: Record<string, readonly string[]> = {
  a1: ['src/app/admin/demos/**', 'src/app/admin/lifecycle/**'],
  b3: ['src/server/demo/types.ts', 'src/server/demo/placeholder.ts', 'src/server/demo/packs/**'],
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
    } else if (matches(forbidden, file)) {
      violations.push([file, 'FORBIDDEN shared file — this is a sync point, not an edit']);
    } else if (!matches(owned, file)) {
      violations.push([file, `outside ${track}'s ownership`]);
    }
  }

  console.log(`ownership check: ${track}  (${cwd})  base=${base}  files=${files.length}`);

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
