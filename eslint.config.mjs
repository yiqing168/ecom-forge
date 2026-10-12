import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const restrictedApplicationImports = {
  patterns: [
    {
      group: [
        'apps/*',
        '**/apps/*',
        '@ecom-forge/api',
        '@ecom-forge/api/*',
        '@ecom-forge/web',
        '@ecom-forge/web/*',
        '@ecom-forge/worker',
        '@ecom-forge/worker/*',
      ],
      message: 'Reusable packages must not depend on deployable applications.',
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
      '**/.next/**',
      '**/.next-*/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/dist/**',
      '**/node_modules/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/.tmp-*/**',
      'packages/db/drizzle/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@ecom-forge/db',
              message: 'The web app must access data through the API.',
            },
            {
              name: '@ecom-forge/credit',
              message: 'The web app must not own credit decisions.',
            },
            {
              name: '@ecom-forge/provider',
              message: 'The web app must not call providers directly.',
            },
          ],
          patterns: [
            {
              group: ['@ecom-forge/db/*', '@ecom-forge/credit/*', '@ecom-forge/provider/*'],
              message: 'The web app must use API contracts instead of domain internals.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/web/features/**/*.{ts,tsx}', 'apps/web/components/layout/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'Literal[value=/#[0-9a-fA-F]{3,8}/]',
          message: 'Use a semantic CSS variable instead of a raw hex color in product UI.',
        },
        {
          selector: 'TemplateElement[value.raw=/#[0-9a-fA-F]{3,8}/]',
          message: 'Use a semantic CSS variable instead of a raw hex color in product UI.',
        },
      ],
    },
  },
  {
    files: ['packages/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': ['error', restrictedApplicationImports],
    },
  },
  {
    files: ['packages/shared/**/*.{ts,tsx}', 'packages/types/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            ...restrictedApplicationImports.patterns,
            {
              group: [
                '@ecom-forge/agent',
                '@ecom-forge/agent/*',
                '@ecom-forge/compiler',
                '@ecom-forge/compiler/*',
                '@ecom-forge/credit',
                '@ecom-forge/credit/*',
                '@ecom-forge/db',
                '@ecom-forge/db/*',
                '@ecom-forge/provider',
                '@ecom-forge/provider/*',
                '@ecom-forge/queue',
                '@ecom-forge/queue/*',
                '@ecom-forge/skills',
                '@ecom-forge/skills/*',
              ],
              message: 'Foundation packages must not depend on stateful domain packages.',
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      'packages/agent/**/*.{ts,tsx}',
      'packages/compiler/**/*.{ts,tsx}',
      'packages/credit/**/*.{ts,tsx}',
      'packages/provider/**/*.{ts,tsx}',
    ],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
);
