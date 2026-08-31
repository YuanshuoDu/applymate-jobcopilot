const { spawnSync } = require('node:child_process')

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(args, env = process.env) {
  const result = spawnSync(pnpm, args, { stdio: 'inherit', env })
  return result.status === 0
}

function migrationEnvironment(env = process.env) {
  const directUrl = env.DIRECT_DATABASE_URL?.trim()
  return directUrl ? { ...env, DATABASE_URL: directUrl } : env
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
    const migrationEnv = migrationEnvironment(env)
    let migrated = false
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (run(migrationArgs, migrationEnv)) {
        migrated = true
        break
      }
      if (attempt < 3) {
        console.log(`Prisma migration attempt ${attempt} failed; retrying in 10 seconds.`)
        waitForRetry()
      }
    }
    if (!migrated) process.exit(1)
  }

  if (!run(['--filter', '@jobcopilot/web', 'exec', 'prisma', 'generate'], env)) process.exit(1)
  if (!run(['--filter', '@jobcopilot/web', 'build'], env)) process.exit(1)
}

module.exports = { migrationEnvironment }

if (require.main === module) main()
