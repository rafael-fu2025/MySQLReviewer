import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'data/**',
      'coverage/**',
      '**/*.d.ts',
      'scripts/mock-ai.cjs',
    ],
  },
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': 'warn',
      // Downgraded to warn: pre-existing patterns in the tree, not blockers.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/no-empty-object-type': 'warn',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-namespace': 'warn',
      'no-empty': 'warn',
      'no-useless-escape': 'warn',
      'no-control-regex': 'warn',
      'no-case-declarations': 'warn',
      'prefer-const': 'warn',
      'no-useless-assignment': 'warn',
      // React Compiler rules from eslint-plugin-react-hooks v7: noisy on this
      // tree, kept visible as warnings rather than blocking CI.
      'react-hooks/refs': 'warn',
      'react-hooks/set-state-in-effect': 'warn',
      'react-hooks/purity': 'warn',
    },
  },
);
