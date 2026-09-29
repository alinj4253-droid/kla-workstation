import eslint from '@eslint/js';
import globals from 'globals';
import tsParser from '@typescript-eslint/parser';

export default [
  { ignores: ['**/out/**', '**/dist/**', '**/dist-types/**', '**/node_modules/**', '**/release/**', '**/release-latest/**', '**/*.min.js', '**/*.d.ts'] },
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
    files: ['server/src/**/*.ts'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: { globals: { ...globals.node } },
  },
  {
    files: ['apps/desktop/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    files: ['**/*.test.ts', '**/*.test.tsx', '**/*.spec.ts', '**/*.spec.tsx'],
    rules: { 'no-empty': 'off' },
  },
  {
    files: ['**/*.config.{js,ts,mjs}'],
    languageOptions: { globals: { ...globals.node } },
  },
];
