const { createRequire } = require('node:module')
const path = require('node:path')
const expected = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
  || process.env.APPLICATION_AUTH_PREPARATION_FIXTURE !== 'true' || process.env.DATABASE_URL !== expected
  || process.env.DIRECT_URL !== expected || process.env.RLS_RUNTIME_MODE !== 'off') throw new Error('Refusing non-fixture seed')
const { PrismaClient } = createRequire(path.resolve('apps/web/package.json'))('@prisma/client')
const db = new PrismaClient()
async function main() {
  const identity = await db.$queryRaw`SELECT current_database() AS name`
  const users = await db.user.findMany({ orderBy: { email: 'asc' } })
  if (identity[0]?.name !== 'application_flow_fixture' || users.length !== 2
    || users[0].email !== 'candidate-a@example.invalid' || users[1].email !== 'candidate-b@example.invalid'
    || await db.job.count() !== 0 || await db.resume.count() !== 0) throw new Error('Unexpected fixture database')
  await db.user.update({ where: { id: users[0].id }, data: { plan: 'pro' } })
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1 })
