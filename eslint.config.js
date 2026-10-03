// ESLint: correctness rules only — no formatting (there is no formatter in
// this repo; see CLAUDE.md). Type-aware: each file is checked with the
// tsconfig that owns it (root for src/, src/web/tsconfig.json for the SPA,
// tests/tsconfig.json for the tests).
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig(
  {
    ignores: [
      'dist/**',
      'desktop/**',
      'docs/**',
      'packaging/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.claude/**',
      '**/*.cjs',
      '**/*.mjs',
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}', 'tests/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
      globals: { ...globals.node },
    },
    rules: {
      // A promise nobody awaits or catches fails silently, or takes the process down.
      '@typescript-eslint/no-floating-promises': 'error',
      // An async function where a callback's result is used (if, filter…) — not where it is ignored (event handlers).
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: false }],
      // `_name`: unused on purpose (a callback's place-holding argument, a destructured-away field).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
          ignoreRestSiblings: true,
        },
      ],
      // Every control character in a regex here is on purpose: terminal codes (ANSI) stripped or matched.
      'no-control-regex': 'off',
    },
  },
  {
    files: ['src/web/**/*.{ts,tsx}', 'tests/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    languageOptions: { globals: { ...globals.browser } },
    // The rules of hooks. Not the React Compiler's rules (set-state-in-effect, refs, purity…): the SPA doesn't use the compiler.
    rules: { 'react-hooks/rules-of-hooks': 'error', 'react-hooks/exhaustive-deps': 'error' },
  },
);
