// Only use with fresh disposable containers on an independently verified internal network.
// The seeded Turn is synthetic; no queue or external application is executed.
import { createRequire } from 'node:module'
import path from 'node:path'

const expected = 'postgresql://fixture:fixture@db:5432/application_flow_fixture'
if (process.env.CI !== 'true' || process.env.APPLICATION_AUTH_DISPOSABLE !== 'true'
  || process.env.APPLICATION_AUTH_APPROVAL_FIXTURE !== 'true' || process.env.DATABASE_URL !== expected
  || process.env.DIRECT_URL !== expected || process.env.RLS_RUNTIME_MODE !== 'off'
  || process.env.AGENT_PREVIEW_FIXTURE || process.env.ENABLE_AGENT_CANONICAL_AUTOMATION === '1') {
  throw new Error('Refusing to seed outside the isolated approval fixture')
}
for (const [key, value] of Object.entries(process.env)) {
  if (value && /(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|PRIVATE_KEY)/i.test(key)) throw new Error('Provider credentials are forbidden')
}

const requireWeb = createRequire(path.resolve('apps/web/package.json'))
const requireWorker = createRequire(path.resolve('apps/worker/package.json'))
const { PrismaClient } = requireWeb('@prisma/client')
const { Pool } = requireWorker('pg')
const prisma = new PrismaClient()
const pool = new Pool({ connectionString: expected, max: 2 })

try {
  const database = await pool.query('SELECT current_database() AS name')
  const users = await prisma.user.findMany({ select: { id: true, email: true }, orderBy: { email: 'asc' } })
  const counts = await pool.query(`SELECT
    (SELECT count(*)::int FROM "Job") AS jobs,
    (SELECT count(*)::int FROM "application_tasks") AS applications,
    (SELECT count(*)::int FROM "agent_sessions") AS sessions,
    (SELECT count(*)::int FROM "agent_turns") AS turns,
    (SELECT count(*)::int FROM "agent_approvals") AS approvals,
    (SELECT count(*)::int FROM "agent_items") AS items,
    (SELECT count(*)::int FROM "agent_events") AS events,
    (SELECT count(*)::int FROM "agent_outbox") AS outbox`)
  if (database.rows[0]?.name !== 'application_flow_fixture' || users.length !== 2
    || users[0].email !== 'candidate-a@example.invalid' || users[1].email !== 'candidate-b@example.invalid'
    || Object.values(counts.rows[0]).some(count => count !== 0)) throw new Error('Expected empty fixture and only synthetic identities')
  const userId = users[0].id
  await prisma.$transaction(async tx => {
    await tx.agentSession.create({ data: { id: 'fixture-approval-session', userId, source: 'chat', status: 'running', goal: 'Review synthetic application fixture' } })
    await tx.agentTurn.create({ data: { id: 'fixture-approval-turn', sessionId: 'fixture-approval-session', userId,
      source: 'user', status: 'in_progress', input: { goal: 'Review synthetic application fixture' },
      modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, revision: 0 } })
    await tx.job.create({ data: { id: 'fixture-approval-job', userId, company: 'Fixture Approval Company', role: 'Fixture Approval Engineer', source: 'fixture', status: 'saved' } })
    await tx.applicationTask.create({ data: { id: 'fixture-approval-task', userId, jobId: 'fixture-approval-job',
      sessionId: 'fixture-approval-session', status: 'waiting_for_authorization' } })
  })
  const { createPgApprovalStore } = await import('../apps/worker/src/runtime/approval/pg-store.ts')
  const receipt = await createPgApprovalStore(pool, { userId }).issue({
    approvalId: 'fixture-approval-receipt', taskId: 'fixture-approval-task',
    scope: { userId, sessionId: 'fixture-approval-session', turnId: 'fixture-approval-turn', jobId: 'fixture-approval-job',
      toolCallId: 'fixture-approval-call', action: 'submit_application', resourceHash: 'a'.repeat(64),
      materialHash: 'b'.repeat(64), answersHash: 'c'.repeat(64), revision: 0, expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
    title: 'Review the synthetic application', body: 'Synthetic approval fixture; no submission will run.',
    payload: { fixture: true }, nonce: 'fixture-approval-only-nonce',
  })
  if (receipt.approval.id !== 'fixture-approval-receipt' || receipt.approval.status !== 'pending') throw new Error('Fixture approval was not issued')
  process.stdout.write('SYNTHETIC_APPROVAL_FIXTURE_READY\n')
} finally {
  await prisma.$disconnect()
  await pool.end()
}
