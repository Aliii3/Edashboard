import globals from 'globals';
/* no-undef catches a missing import in the browser code before it reaches users. */
export default [
  { files: ['web/src/**/*.js'], languageOptions: { sourceType: 'module', globals: globals.browser }, rules: { 'no-undef': 'error' } },
  { files: ['packages/domain/src/**/*.js'], languageOptions: { sourceType: 'module', globals: { ...globals.browser, ...globals.node } }, rules: { 'no-undef': 'error' } },
];
