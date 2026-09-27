import eslint from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';

export default [
  { ignores: ['**/out/**', '**/dist-types/**', '**/node_modules/**', '**/K_Studio/**', '**/dist/**', '**/dist-web/**', '**/release/**', '**/release-latest/**', '**/resources/tools/**', '**/.kqocr-build/**', '**/*.min.js', '**/*.d.ts'] },
  eslint.configs.recommended,
  {
    rules: {
      'no-undef': 'off',
      'no-console': 'off',
      'no-control-regex': 'off',
      'no-useless-escape': 'off',
      'no-useless-assignment': 'off',
      'no-unused-vars': 'off',
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsParser,
    },
  },
  {
    files: ['packages/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/runtime/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/desktop/src/main/**/*.ts', 'apps/desktop/src/preload/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/desktop/src/renderer/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: { 'no-empty': 'off' },
  },
  {
    files: ['**/*.config.{js,ts,mjs}', '**/scripts/**/*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
];
