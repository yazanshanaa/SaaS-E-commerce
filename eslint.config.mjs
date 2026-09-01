// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import next from 'eslint-config-next/core-web-vitals';
import globals from 'globals';

/**
 * Souq Bartaa lint rules.
 *
 * Beyond style, this config mechanically enforces three of the platform invariants:
 *   - invariant 1: no raw Prisma client outside src/server/db (everything goes through the
 *     tenant-scoped extension or withTenantTxn),
 *   - the S3 client is reachable only from src/server/media/storage (A3's storage adapter),
 *   - client IP is resolved in exactly one place (invariant 9).
 * The billing-boundary rule (invariant 5) is a source scan in tests/unit/guardrails.test.ts,
 * because "no state mutation outside this folder" is not expressible as an import rule.
 */

const RESTRICTED_IMPORT_PATTERNS = [
  {
    group: ['@prisma/client', '@prisma/client/*'],
    message:
      'Import the tenant-scoped client from @/server/db instead. Raw Prisma access is only allowed inside src/server/db.',
  },
  {
    group: ['@aws-sdk/client-s3', '@aws-sdk/s3-request-presigner'],
    message:
      'The S3/R2 client lives only in src/server/media/storage. Use the StorageAdapter interface.',
  },
];

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'dist/**',
      'coverage/**',
      'next-env.d.ts',
      'prisma/generated/**',
      'test-results/**',
      'playwright-report/**',
      /**
       * `.tmp/` is the repository's scratch directory — `.gitignore` has listed it since Phase 1,
       * the integration harness writes its database handoff there, and the e2e stack its storage.
       * It was not in this list, so an operator's throwaway `.ts` file in it failed `pnpm lint`
       * for the whole repository. A gate that goes red for something outside the tracked tree
       * teaches people to ignore the gate.
       */
      '.tmp/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,

  {
    files: ['**/*.ts', '**/*.tsx', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
      // Deliberately NOT enabling type-aware rules: they require a full program per lint run,
      // which turns `pnpm lint` from seconds into minutes on every parallel worktree, and the
      // typecheck gate already has the type information.
      //
      // The import restriction uses the TS-aware variant only so that
      // `import type { BillingPeriod } from '@prisma/client'` stays legal: a generated enum
      // type carries no client and cannot read a row.
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: RESTRICTED_IMPORT_PATTERNS.map((p) => ({ ...p, allowTypeImports: true })) },
      ],
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
    },
  },

  // src/server/db owns the raw Prisma client — it is the thing everyone else imports.
  {
    files: ['src/server/db/**/*.ts', 'prisma/**/*.ts'],
    rules: { 'no-restricted-imports': 'off', '@typescript-eslint/no-restricted-imports': 'off', 'no-console': 'off' },
  },

  // A3's storage adapter is the only place allowed to talk to R2 directly.
  {
    files: ['src/server/media/storage/**/*.ts'],
    rules: {
      '@typescript-eslint/no-restricted-imports': [
        'error',
        { patterns: [{ ...RESTRICTED_IMPORT_PATTERNS[0], allowTypeImports: true }] },
      ],
    },
  },

  // Scripts, seeds, tests and the local test harness legitimately reach for raw clients.
  {
    // `scripts/**/*.mjs` is listed beside the .ts form on purpose: a one-shot asset fetcher
    // (scripts/fetch-rubik.mjs) reports its progress on stdout, which is the whole point of an
    // operator running it by hand. Without this it is the one script file the relaxation missed.
    files: [
      'scripts/**/*.ts',
      'scripts/**/*.mjs',
      'tests/**/*.ts',
      'tests/**/*.tsx',
      '*.config.ts',
      '*.config.mjs',
    ],
    rules: {
      'no-restricted-imports': 'off',
      '@typescript-eslint/no-restricted-imports': 'off',
      'no-console': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
);
