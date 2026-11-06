// Runs only in the disposable image's archived source copy, never in the checkout.
const fs = require('node:fs')
const path = require('node:path')
if (process.cwd() !== '/workspace' || !fs.existsSync('/.dockerenv') || process.env.CI !== 'true'
  || process.env.APPLICATION_AUTH_PREPARATION_BUILD !== 'true'
  || process.env.DATABASE_URL !== 'postgresql://fixture:fixture@db:5432/application_flow_fixture') {
  throw new Error('Refusing to inject outside the disposable build context')
}
for (const [key, value] of Object.entries(process.env)) {
  if (value && /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)/i.test(key)) throw new Error('Refusing build with provider credentials')
}
const configPath = '/workspace/apps/web/next.config.ts'
const adapter = '/workspace/e2e/application-authenticated-preparation-adapter.cjs'
if (!fs.existsSync(adapter)) throw new Error('Synthetic transport is missing')
const config = fs.readFileSync(configPath, 'utf8')
const marker = '  reactStrictMode: true,'
if (config.split(marker).length !== 2 || config.includes('APPLICATION_PREPARATION_TEST_ALIAS')) throw new Error('Unexpected Next configuration')
const replacement = `${marker}\n  // APPLICATION_PREPARATION_TEST_ALIAS: disposable test image only.\n  webpack: (config) => {\n    config.resolve.alias['@jobcopilot/shared/pinned-outbound$'] = ${JSON.stringify(adapter)}\n    return config\n  },`
fs.writeFileSync(configPath, config.replace(marker, replacement))
