// Test-only database fixture. This does not run an AI audit or prove its result.
const { createRequire } = require('node:module')
const { execFileSync } = require('node:child_process')
const path = require('node:path')
const requireWeb = createRequire(path.resolve('apps/web/package.json'))
const { PrismaClient } = requireWeb('@prisma/client')
const expected = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true' ||
    process.env.DATABASE_URL !== expected || process.env.DIRECT_URL !== expected ||
    process.env.RLS_RUNTIME_MODE !== 'off' || process.env.AGENT_PREVIEW_FIXTURE ||
    process.env.AUTH_SECRET !== 'fixture-only-secret-at-least-32-bytes') {
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
  const audit = { verdict: 'pass', summary: 'Synthetic fixture audit; no AI auditor was run.', findings: [{ area: 'resume', severity: 'pass', title: 'Synthetic fixture', evidence: 'Test data only', action: 'No action' }], source: 'previous_version', auditedAt: new Date().toISOString(), matchScore: 80 }
  // Seed a signed, job-bound synthetic control record through the same short
  // transaction helpers. This is fixture data, not a real AI audit.
  const script = `
    const path = require('node:path')
    const { createRequire } = require('node:module')
    const web = createRequire(path.resolve('apps/web/package.json'))
    web('tsx/cjs/api').register()
    const { withApplicationAuditLock } = require(path.resolve('apps/web/src/lib/application-audit-transaction.ts'))
    const { registerAuditOperation, completeAuditOperation, readAuditOperation, auditJobBasisHash } = require(path.resolve('apps/web/src/lib/application-audit-operation.ts'))
    const { db } = require(path.resolve('apps/web/src/lib/db.ts'))
    const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'))
    ;(async () => {
      const result = await withApplicationAuditLock(input.scope, async tx => {
        const job = await tx.job.findFirst({ where: { id: input.scope.jobId, userId: input.scope.userId } })
        const resume = await tx.resume.findFirst({ where: { id: input.resumeId, userId: input.scope.userId } })
        if (!job || !resume || resume.updatedAt.toISOString() !== input.resumeUpdatedAt || job.role !== input.jobBasis.role || job.company !== input.jobBasis.company || job.description !== input.jobBasis.description) throw new Error('Fixture material changed')
        const operationId = await registerAuditOperation(tx, input.scope)
        if (!await completeAuditOperation(tx, input.scope, operationId, { resumeId: input.resumeId, coverLetterId: null, audit: input.audit, jobBasis: input.jobBasis, materialBasis: { resume, coverLetter: null }, versions: { resumeUpdatedAt: input.resumeUpdatedAt } })) throw new Error('Fixture audit could not be recorded')
        const current = await readAuditOperation(tx, input.scope)
        if (current.kind !== 'completed' || current.jobBasisHash !== auditJobBasisHash(input.jobBasis)) throw new Error('Fixture audit verification failed')
        return true
      })
      if (!result) throw new Error('Fixture job not found')
      await db.$disconnect()
    })().catch(async error => { await db.$disconnect(); console.error(error); process.exitCode = 1 })
  `
  execFileSync(process.execPath, ['-e', script], {
    input: JSON.stringify({ scope: { userId: user.id, jobId }, resumeId, audit, resumeUpdatedAt: resume.updatedAt.toISOString(), jobBasis: { role: job.role, company: job.company, description: job.description } }),
    encoding: 'utf8', timeout: 30_000,
    env: { ...process.env, TSX_TSCONFIG_PATH: path.resolve('apps/web/tsconfig.json') },
  })
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
