'use strict';

const js = require('@eslint/js');
const globals = require('globals');
const security = require('eslint-plugin-security');

module.exports = [
  js.configs.recommended,
  security.configs.recommended,
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.commonjs,
        ...globals.es2015,
        ...globals.node,
        ...globals.mocha,
        ...globals.jquery,
        // ES2021 built-in, present in every Node the engines field admits;
        // ecmaVersion 2020 does not declare it.
        WeakRef: 'readonly'
      }
    },
    rules: {
      'security/detect-object-injection': 'off',
      // ESLint 10 exempts while(true) by default; retain the prior check.
      'no-constant-condition': ['error', {checkLoops: 'all'}],
      'no-unused-vars': ['error', {varsIgnorePattern: 'should|expect'}]
    }
  }
];
