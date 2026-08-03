import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs['recommended-latest'],
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', caughtErrorsIgnorePattern: '^_', argsIgnorePattern: '^_' }],
    },
  },
  {
    // Node-context scripts (build tooling, seed/setup scripts, API routes) —
    // these run under Node, not the browser, so `process`/`__dirname`/etc.
    // are real globals here rather than typos.
    files: ['api/**/*.js', 'scripts/**/*.js', '*.config.js', 'checkModels.js', '*.cjs'],
    languageOptions: {
      globals: globals.node,
    },
  },
])