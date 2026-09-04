const { spawnSync } = require('node:child_process')

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const guestSupportMigration = '20260904170000_allow_guest_support_cases'

function run(args, env = process.env) {
  const result = spawnSync(pnpm, args, { stdio: 'inherit', env })
  return result.status === 0
}

function runWithOutput(args, env = process.env) {
  const result = spawnSync(pnpm, args, { encoding: 'utf8', env })
  const output = [result.stdout, result.stderr].filter(Boolean).join('')
  if (output) process.stdout.write(output)
  return { output, succeeded: result.status === 0 }
}

function shouldRecoverFailedGuestSupportMigration(output) {
  return output.includes(guestSupportMigration) && /\bP(?:3009|3018)\b/.test(output)
}

function migrationEnvironment(env = process.env) {
  const directUrl = env.DIRECT_DATABASE_URL?.trim()
  return directUrl ? { ...env, DATABASE_URL: directUrl } : env
}

function shouldBootstrapStagingAdmin(env = process.env) {
  return env.VERCEL_ENV === 'preview'
    && env.STAGING_ADMIN_BOOTSTRAP === 'true'
    && Boolean(env.INITIAL_SUPER_ADMIN_EMAIL?.trim())
}

function waitForRetry() {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, 10_000)
}

function main(env = process.env) {
  // agent-protocol ships pre-built types (dist) consumed by Web/Worker imports;
  // a clean Vercel build has no dist until we build it here.
  if (!run(['--filter', '@jobcopilot/agent-protocol', 'build'], env)) process.exit(1)
  if (!run(['--filter', '@jobcopilot/shared', 'build'], env)) process.exit(1)
  // agent-policy consumes the protocol package and is imported directly by Web.
  // Build it explicitly so a clean Vercel checkout never relies on stale dist.
  if (!run(['--filter', '@jobcopilot/agent-policy', 'build'], env)) process.exit(1)
  // agent-model is a workspace dependency whose package exports resolve to dist;
  // build it explicitly because Vercel invokes this script outside Turbo.
  if (!run(['--filter', '@jobcopilot/agent-model', 'build'], env)) process.exit(1)

  if (env.VERCEL_ENV === 'production') {
    const migrationArgs = ['--filter', '@jobcopilot/web', 'exec', 'prisma', 'migrate', 'deploy']
    const resolveMigrationArgs = ['--filter', '@jobcopilot/web', 'exec', 'prisma', 'migrate', 'resolve', '--rolled-back', guestSupportMigration]
    const migrationEnv = migrationEnvironment(env)
    let attempt = 1
    let migrationResult = runWithOutput(migrationArgs, migrationEnv)
    if (!migrationResult.succeeded && shouldRecoverFailedGuestSupportMigration(migrationResult.output)) {
      console.log(`Recovering failed Prisma migration ${guestSupportMigration}.`)
      if (!run(resolveMigrationArgs, migrationEnv)) process.exit(1)
      attempt += 1
      migrationResult = runWithOutput(migrationArgs, migrationEnv)
    }
    while (!migrationResult.succeeded && attempt < 3) {
      if (attempt < 3) {
        console.log(`Prisma migration attempt ${attempt} failed; retrying in 10 seconds.`)
        waitForRetry()
      }
      attempt += 1
      migrationResult = runWithOutput(migrationArgs, migrationEnv)
    }
    if (!migrationResult.succeeded) process.exit(1)
  }

  if (!run(['--filter', '@jobcopilot/web', 'exec', 'prisma', 'generate'], env)) process.exit(1)
  if (!run(['--filter', '@jobcopilot/web', 'build'], env)) process.exit(1)

  // Bootstrap the first staging admin only when explicitly enabled for a Preview build.
  // The seed script enforces that the target user already exists and applies the
  // production safety guard; temporary bootstrap variables must be removed afterward.
  if (shouldBootstrapStagingAdmin(env)) {
    const seedArgs = [
      '--filter',
      '@jobcopilot/web',
      'exec',
      'ts-node',
      '--project',
      'prisma/tsconfig.seed.json',
      'prisma/seed-admin-roles.ts',
    ]
    if (!run(seedArgs, env)) process.exit(1)
    console.log('Staging admin bootstrap completed.')
  }
}

module.exports = {
  migrationEnvironment,
  shouldBootstrapStagingAdmin,
  shouldRecoverFailedGuestSupportMigration,
}

if (require.main === module) main()
