const { createRequire } = require('node:module')
const path = require('node:path')
const requireWeb = createRequire(path.resolve('apps/web/package.json'))
const { PrismaClient } = requireWeb('@prisma/client')
const bcrypt = requireWeb('bcryptjs')

const expected = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true' ||
    process.env.DATABASE_URL !== expected || process.env.DIRECT_URL !== expected ||
    process.env.RLS_RUNTIME_MODE !== 'off' || process.env.AGENT_PREVIEW_FIXTURE) {
  throw new Error('Refusing to seed outside the dedicated disposable fixture')
}
const db = new PrismaClient()
async function main() {
  const identity = await db.$queryRaw`SELECT current_database() AS name`
  if (identity[0]?.name !== 'application_flow_fixture' || await db.user.count() !== 0 || await db.job.count() !== 0) {
    throw new Error('Expected a freshly migrated, empty fixture database')
  }
  const password = await bcrypt.hash('Fixture-only-password-123', 12)
  for (const email of ['candidate-a@example.invalid', 'candidate-b@example.invalid']) {
    await db.user.create({ data: { email, password, name: 'Fixture Candidate', onboardedAt: new Date() } })
  }
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1 })
