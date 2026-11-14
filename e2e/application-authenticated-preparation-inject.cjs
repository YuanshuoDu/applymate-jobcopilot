// Runs only in the disposable image's archived source copy, never in the checkout.
const fs = require('node:fs')
const configPath = '/workspace/apps/web/next.config.ts'
const adapterPath = '/workspace/e2e/application-authenticated-preparation-adapter.cjs'
const fixtureDb = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'

function isExpectedRegularFile(filesystem, filename) {
  try {
    const entry = filesystem.lstatSync(filename)
    return entry.isFile() && !entry.isSymbolicLink() && filesystem.realpathSync(filename) === filename
  } catch { return false }
}

// Checks are deliberately independent booleans: the diagnostic reveals no
// environment values, paths outside the fixed fixture, or credential names.
function fixtureChecks(cwd, env, filesystem) {
  return {
    workspace: cwd === '/workspace',
    ci: env.CI === 'true',
    buildMarker: env.APPLICATION_AUTH_PREPARATION_BUILD === 'true',
    fixtureDatabase: env.DATABASE_URL === fixtureDb,
    nonProduction: env.NODE_ENV !== 'production',
    noProviderCredentials: !Object.entries(env).some(([key, value]) => value && /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)/i.test(key)),
    noGitCheckout: !filesystem.existsSync('/workspace/.git'),
    expectedRegularFiles: isExpectedRegularFile(filesystem, configPath) && isExpectedRegularFile(filesystem, adapterPath),
  }
}

function renderConfig(config) {
  const marker = '  reactStrictMode: true,'
  if (config.split(marker).length !== 2 || config.includes('APPLICATION_PREPARATION_TEST_ALIAS')) throw new Error('Unexpected Next configuration')
  const replacement = `${marker}\n  // APPLICATION_PREPARATION_TEST_ALIAS: disposable test image only.\n  webpack: (config) => {\n    config.resolve.alias['@jobcopilot/shared/pinned-outbound$'] = ${JSON.stringify(adapterPath)}\n    return config\n  },`
  // Replacement text contains "$'", which String.replace treats specially.
  return config.replace(marker, () => replacement)
}

function inject() {
  const checks = fixtureChecks(process.cwd(), process.env, fs)
  if (!Object.values(checks).every(Boolean)) {
    console.error(`Synthetic build guard: ${JSON.stringify(checks)}`)
    throw new Error('Refusing to inject outside the disposable build context')
  }
  fs.writeFileSync(configPath, renderConfig(fs.readFileSync(configPath, 'utf8')))
}

if (require.main === module) inject()
module.exports = { fixtureChecks, renderConfig }
