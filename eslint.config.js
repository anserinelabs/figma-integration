import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import importPlugin from 'eslint-plugin-import';
import noRelativeImportPaths from 'eslint-plugin-no-relative-import-paths';
import prettierRecommended from 'eslint-plugin-prettier/recommended';

export default [
  ...tseslint.config(
    { ignores: ['dist'] },
    {
      extends: [
        js.configs.recommended,
        ...tseslint.configs.recommendedTypeChecked,
      ],
      files: ['**/*.{ts,tsx}'],
      languageOptions: {
        ecmaVersion: 2020,
        globals: globals.nodeBuiltin,
        parserOptions: {
          project: ['./tsconfig.json'],
          tsconfigRootDir: import.meta.dirname,
        },
      },
      plugins: {
        import: importPlugin,
        'no-relative-import-paths': noRelativeImportPaths,
      },
      rules: {
        'import/consistent-type-specifier-style': ['error', 'prefer-top-level'],
        'import/first': 'error',
        'import/no-duplicates': 'error',
        'import/order': [
          'error',
          {
            'newlines-between': 'always',
            groups: ['builtin', 'external', 'internal'],
            pathGroups: [{ pattern: '@common/**', group: 'internal' }],
            pathGroupsExcludedImportTypes: [],
            alphabetize: {
              order: 'asc',
              orderImportKind: 'asc',
            },
          },
        ],
        'no-relative-import-paths/no-relative-import-paths': [
          'error',
          { rootDir: 'src', prefix: '@' },
        ],
        'sort-imports': ['error', { ignoreDeclarationSort: true }],
        '@typescript-eslint/consistent-type-imports': 'error',
        '@typescript-eslint/no-explicit-any': 'off',
        '@typescript-eslint/no-unused-vars': [
          'error',
          {
            argsIgnorePattern: '^_',
            caughtErrorsIgnorePattern: '^_',
            varsIgnorePattern: '^_',
          },
        ],
        '@typescript-eslint/require-await': 'off',
      },
    },
  ),
  prettierRecommended,
  // This is disabled by prettier because some modes don't work with it;
  // re-enable since the default mode is fine.
  // https://github.com/prettier/eslint-config-prettier?tab=readme-ov-file#curly
  { rules: { curly: 'error' } },
];
