import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/node_modules/**',
      'docs/requirements/canonical-requirements.json',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strict,
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
);
