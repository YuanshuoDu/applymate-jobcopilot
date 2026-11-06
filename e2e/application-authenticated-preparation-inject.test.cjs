const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createRequire } = require('node:module')
const path = require('node:path')
const { fixtureChecks, renderConfig } = require('./application-authenticated-preparation-inject.cjs')
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
const originalConfig = fs.readFileSync(path.resolve('apps/web/next.config.ts'), 'utf8')
const rendered = renderConfig(originalConfig)
const exactAlias = `config.resolve.alias['@jobcopilot/shared/pinned-outbound$'] = "/workspace/e2e/application-authenticated-preparation-adapter.cjs"`
assert.equal(rendered.split(exactAlias).length, 2)
assert.equal(rendered.split('serverExternalPackages:').length, 2)
assert.throws(() => renderConfig(rendered), /Unexpected Next configuration/)
const typescript = createRequire(path.resolve('apps/web/package.json'))('typescript')
const parsed = typescript.createSourceFile('next.config.ts', rendered, typescript.ScriptTarget.Latest, true, typescript.ScriptKind.TS)
assert.deepEqual(parsed.parseDiagnostics.map(diagnostic => diagnostic.messageText), [])
console.log('Synthetic build guard: fixture and refusal checks passed')
