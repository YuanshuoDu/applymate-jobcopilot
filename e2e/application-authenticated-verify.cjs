const { createRequire } = require('node:module')
const path = require('node:path')
const requireWeb = createRequire(path.resolve('apps/web/package.json'))
const { PrismaClient } = requireWeb('@prisma/client')
const expected = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true' || process.env.DATABASE_URL !== expected || process.env.DIRECT_URL !== expected) throw new Error('Refusing to inspect non-fixture database')
const db = new PrismaClient()
async function main() {
  const users = await db.user.findMany({ select: { id: true, email: true } })
  const user = users.find(item => item.email === 'candidate-a@example.invalid')
  const jobs = await db.job.findMany()
  const applied = await db.activity.count({ where: { type: 'applied' } })
  if (users.length !== 2 || !user || jobs.length !== 1 || jobs[0].userId !== user.id || jobs[0].status !== 'saved' || jobs[0].workflowState !== 'draft' || applied !== 0) throw new Error('Unexpected job owner, status, or application activity')
}
main().finally(() => db.$disconnect()).catch(error => { console.error(error); process.exitCode = 1 })
