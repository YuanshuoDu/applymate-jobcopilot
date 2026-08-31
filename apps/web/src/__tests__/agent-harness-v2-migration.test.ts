import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PrismaClient } from '@prisma/client'
import { describe, expect, it, beforeAll, afterAll } from 'vitest'

const migrationPath = fileURLToPath(new URL(
  '../../prisma/migrations/20260831030000_add_agent_turn_step_input/migration.sql',
  import.meta.url,
))
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url))
const migrationSql = readFileSync(migrationPath, 'utf8')
const schema = readFileSync(schemaPath, 'utf8')

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

describe('Harness 2.0 Turn/Step/Input migration contract', () => {
  it('adds the three durable tables and preserves existing data paths', () => {
    expect(migrationSql).toContain('CREATE TABLE "agent_turns"')
    expect(migrationSql).toContain('CREATE TABLE "agent_steps"')
    expect(migrationSql).toContain('CREATE TABLE "agent_inputs"')
    expect(migrationSql).toContain('agent_sessions"("id")')
    expect(migrationSql).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b/i)
    expect(schema).toContain('model AgentSession')
    expect(schema).toContain('model AgentTurn')
    expect(schema).toContain('model AgentStep')
    expect(schema).toContain('model AgentInput')
  })

  it('serializes active roots while retaining terminal history', () => {
    expect(migrationSql).toContain('CREATE UNIQUE INDEX "agent_turns_active_root_session_key"')
    for (const status of [
      'queued',
      'in_progress',
      'waiting_for_dependency',
      'waiting_for_approval',
      'waiting_for_user',
    ]) {
      expect(migrationSql).toContain(`'${status}'`)
    }
    for (const status of ['interrupted', 'cancelled', 'failed', 'completed']) {
      expect(migrationSql).not.toMatch(new RegExp(`WHERE[\\s\\S]*'${status}'`, 'i'))
    }
  })

  it('adds message and step retry idempotency constraints', () => {
    expect(migrationSql).toContain('agent_inputs_sessionId_clientMessageId_key')
    expect(migrationSql).toContain('agent_steps_turnId_ordinal_attempt_key')
    expect(migrationSql).toContain('agent_inputs_delivery_check')
    expect(migrationSql).toContain('agent_steps_attempt_check')
    expect(migrationSql).toContain('ON DELETE CASCADE')
  })
})

const testDatabaseUrl = process.env.AGENT_HARNESS_TEST_DATABASE_URL
const integrationEnabled = process.env.AGENT_HARNESS_MIGRATION_INTEGRATION === '1' && Boolean(testDatabaseUrl)
const integrationDescribe = integrationEnabled ? describe : describe.skip

integrationDescribe('Harness 2.0 PostgreSQL concurrency contract', () => {
  let prisma: PrismaClient
  let userId: string
  let sessionId: string

  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: testDatabaseUrl } } })
    const user = await prisma.user.create({
      data: {
        email: `ah2-005-${Date.now()}@example.invalid`,
        onboardingGoals: [],
      },
    })
    userId = user.id
    const session = await prisma.agentSession.create({
      data: { userId, goal: 'AH2-005 migration fixture', status: 'idle', source: 'chat' },
    })
    sessionId = session.id
  })

  afterAll(async () => {
    if (sessionId) await prisma.agentSession.delete({ where: { id: sessionId } })
    if (userId) await prisma.user.delete({ where: { id: userId } })
    await prisma.$disconnect()
  })

  it('enforces active-root, waiting, idempotency, and terminal follow-up rules', async () => {
    const turnData = {
      sessionId,
      userId,
      status: 'queued',
      source: 'user',
      input: { content: [{ type: 'text', text: 'Find Dublin backend roles' }] },
      modelProfileSnapshot: { provider: 'test', model: 'fixture' },
      toolPolicySnapshot: { allow: ['jobs.search'] },
      budgetSnapshot: { maxCostUsd: 1 },
    }
    const turnResults = await Promise.allSettled([
      prisma.agentTurn.create({ data: turnData }),
      prisma.agentTurn.create({ data: turnData }),
    ])
    expect(turnResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(turnResults.filter((result) => result.status === 'rejected').map((result) => errorCode(result.reason))).toEqual(['P2002'])
    const winner = turnResults.find((result) => result.status === 'fulfilled')
    if (!winner || winner.status !== 'fulfilled') throw new Error('active turn fixture did not produce a winner')

    await prisma.agentTurn.update({ where: { id: winner.value.id }, data: { status: 'waiting_for_user' } })
    await expect(prisma.agentTurn.create({ data: turnData })).rejects.toMatchObject({ code: 'P2002' })

    const inputData = {
      sessionId,
      userId,
      clientMessageId: 'duplicate-client-message',
      delivery: 'follow_up',
      status: 'queued',
      content: [{ type: 'text', text: 'Also include hybrid roles' }],
      acceptedSequence: BigInt(1),
    }
    const inputResults = await Promise.allSettled([
      prisma.agentInput.create({ data: inputData }),
      prisma.agentInput.create({ data: inputData }),
    ])
    expect(inputResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(inputResults.filter((result) => result.status === 'rejected').map((result) => errorCode(result.reason))).toEqual(['P2002'])

    const stepData = {
      sessionId,
      turnId: winner.value.id,
      ordinal: 0,
      attempt: 1,
      status: 'queued',
      inputThroughSequence: BigInt(0),
      consumedInputIds: [],
      modelProfileSnapshot: { provider: 'test', model: 'fixture' },
    }
    const stepResults = await Promise.allSettled([
      prisma.agentStep.create({ data: stepData }),
      prisma.agentStep.create({ data: stepData }),
    ])
    expect(stepResults.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(stepResults.filter((result) => result.status === 'rejected').map((result) => errorCode(result.reason))).toEqual(['P2002'])

    await prisma.agentTurn.update({ where: { id: winner.value.id }, data: { status: 'completed', completedAt: new Date() } })
    await expect(prisma.agentTurn.create({ data: turnData })).resolves.toBeDefined()
  })
})
