// Test-only database fixture. This does not run an AI audit or prove its result.
const { createRequire } = require('node:module')
const path = require('node:path')
const requireWeb = createRequire(path.resolve('apps/web/package.json'))
const { PrismaClient } = requireWeb('@prisma/client')
const expected = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true' ||
    process.env.DATABASE_URL !== expected || process.env.DIRECT_URL !== expected ||
    process.env.RLS_RUNTIME_MODE !== 'off' || process.env.AGENT_PREVIEW_FIXTURE) {
  throw new Error('Refusing fixture audit outside the isolated disposable database')
}

const db = new PrismaClient()
async function checkedFixture(jobId, resumeId) {
  const identity = await db.$queryRaw`SELECT current_database() AS name`
  const user = await db.user.findUnique({ where: { email: 'candidate-a@example.invalid' } })
  const job = await db.job.findUnique({ where: { id: jobId } })
  const resume = await db.resume.findUnique({ where: { id: resumeId } })
  if (identity[0]?.name !== 'application_flow_fixture' || !user || !job || !resume ||
      job.userId !== user.id || resume.userId !== user.id || resume.targetJobId !== job.id ||
      job.company !== 'Fixture Company' || job.role !== 'Fixture application engineer' ||
      job.url !== 'https://employer.example.invalid/jobs/fixture-vacancy' ||
      resume.name !== 'Synthetic fixture resume') throw new Error('Unexpected fixture identity or ownership')
  return { user, job, resume }
}

async function seedSyntheticAudit(jobId, resumeId) {
  const { user, job, resume } = await checkedFixture(jobId, resumeId)
  if (job.status !== 'saved' || job.workflowState !== 'draft' || job.appliedAt || job.finalResumeId ||
      await db.activity.count({ where: { userId: user.id, jobId, text: { startsWith: '[Auditor] application-audit ' } } })) {
    throw new Error('Unexpected state before synthetic audit')
  }
  const audit = { verdict: 'pass', summary: 'Synthetic fixture audit; no AI auditor was run.', findings: [], source: 'previous_version', auditedAt: new Date().toISOString(), matchScore: 80 }
  const text = '[Auditor] application-audit ' + JSON.stringify({ resumeId, coverLetterId: null, resumeUpdatedAt: resume.updatedAt.toISOString(), audit })
  await db.activity.create({ data: { userId: user.id, jobId, type: 'agent_action', color: '#059669', text } })
}

async function assertManualState(jobId, resumeId, expectedStatus) {
  const { user, job } = await checkedFixture(jobId, resumeId)
  const applied = await db.activity.count({ where: { userId: user.id, jobId, type: 'applied', text: { startsWith: 'You applied manually ' } } })
  const allApplied = await db.activity.count({ where: { userId: user.id, jobId, type: 'applied' } })
  const results = await db.applyResult.count({ where: { userId: user.id, jobId } })
  if (expectedStatus === 'saved') {
    if (job.status !== 'saved' || job.workflowState !== 'draft' || job.appliedAt || applied || allApplied || results) throw new Error('Unexpected pre-record state')
  } else if (expectedStatus === 'applied') {
    if (job.status !== 'applied' || job.workflowState !== 'submitted' || !job.appliedAt || applied !== 1 || allApplied !== 1 || results) throw new Error('Unexpected manual-record state')
  } else throw new Error('Unknown fixture checkpoint')
  if (job.finalResumeId !== resumeId || job.finalCoverLetterId !== null) throw new Error('Unexpected selected materials')
}

async function readManualAppliedAt(jobId, resumeId) {
  await assertManualState(jobId, resumeId, 'applied')
  const { job } = await checkedFixture(jobId, resumeId)
  return job.appliedAt.toISOString()
}

module.exports = { seedSyntheticAudit, assertManualState, readManualAppliedAt, closeFixtureDb: () => db.$disconnect() }
