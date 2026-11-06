const assert = require('node:assert/strict')
const { fixtureChecks } = require('./application-authenticated-preparation-inject.cjs')
const db = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
const fixtureEnv = { CI: 'true', APPLICATION_AUTH_PREPARATION_BUILD: 'true', DATABASE_URL: db }
const paths = new Set(['/workspace/apps/web/next.config.ts', '/workspace/e2e/application-authenticated-preparation-adapter.cjs'])
const filesystem = {
  existsSync: filename => filename === '/workspace/.git' ? false : paths.has(filename),
  lstatSync: filename => ({ isFile: () => paths.has(filename), isSymbolicLink: () => false }),
  realpathSync: filename => filename,
}
const check = (cwd = '/workspace', env = fixtureEnv, fs = filesystem) => fixtureChecks(cwd, env, fs)
assert.ok(Object.values(check()).every(Boolean))
assert.equal(check('/production').workspace, false)
assert.equal(check('/workspace', { ...fixtureEnv, CI: 'false' }).ci, false)
assert.equal(check('/workspace', { ...fixtureEnv, APPLICATION_AUTH_PREPARATION_BUILD: '' }).buildMarker, false)
assert.equal(check('/workspace', { ...fixtureEnv, DATABASE_URL: 'non-fixture' }).fixtureDatabase, false)
assert.equal(check('/workspace', { ...fixtureEnv, NODE_ENV: 'production' }).nonProduction, false)
assert.equal(check('/workspace', { ...fixtureEnv, OTHER_API_KEY: 'do-not-use' }).noProviderCredentials, false)
assert.equal(check('/workspace', fixtureEnv, { ...filesystem, existsSync: () => true }).noGitCheckout, false)
assert.equal(check('/workspace', fixtureEnv, { ...filesystem, realpathSync: () => '/outside' }).expectedRegularFiles, false)
assert.equal(check('/workspace', fixtureEnv, { ...filesystem, lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }) }).expectedRegularFiles, false)
console.log('Synthetic build guard: fixture and refusal checks passed')
