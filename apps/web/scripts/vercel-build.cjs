const { spawnSync } = require('node:child_process')

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function run(args) {
  const result = spawnSync(pnpm, args, { stdio: 'inherit' })
  return result.status === 0
}

function waitForRetry() {
  const signal = new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(signal, 0, 0, 10_000)
}

if (!run(['--filter', '@jobcopilot/shared', 'build'])) process.exit(1)

if (process.env.VERCEL_ENV === 'production') {
  const migrationArgs = ['--filter', '@jobcopilot/web', 'exec', 'prisma', 'migrate', 'deploy']
  let migrated = false
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (run(migrationArgs)) {
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

if (!run(['--filter', '@jobcopilot/web', 'exec', 'prisma', 'generate'])) process.exit(1)
if (!run(['--filter', '@jobcopilot/web', 'build'])) process.exit(1)
