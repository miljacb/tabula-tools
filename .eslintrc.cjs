/* ESLint 8 config (npm run lint). Type safety is enforced by tsc; this catches the rest. */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  plugins: ['@typescript-eslint'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { es2022: true, browser: true, node: true },
  rules: {
    '@typescript-eslint/no-non-null-assertion': 'off', // indexed typed-array access under noUncheckedIndexedAccess
  },
};
