import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { Prisma, PrismaClient } from "@prisma/client"
import { startMaterialDriftRecovery } from "./material-drift-recovery"

const EXPECTED_DATABASE_URL = "postgresql://postgres:postgres@material-drift-pg:5432/applymate_1213_material_drift_ci"
const EXPECTED_CI_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci"
const TEST_TIMEOUT_MS = 30_000

type Fixture = {
  userId: string; sessionId: string; automationId: string; sourceTurnId: string
  rootTaskId: string; gateTaskId: string; executionId: string; sourceMarker: Prisma.InputJsonValue
}

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  const requested = value !== undefined || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== undefined
    || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== undefined
  if (!value) {
    if (requested) throw new Error("Material drift recovery tests require the private disposable PostgreSQL URL")
    return null
  }
  let url: URL
  try { url = new URL(value) } catch { throw new Error("Material drift recovery tests require the private disposable PostgreSQL URL") }
  if (![EXPECTED_DATABASE_URL, EXPECTED_CI_DATABASE_URL].includes(value) || process.env.DATABASE_URL !== value
    || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true" || process.env.AGENT_RUNTIME_PG_TEST_REQUIRED !== "true"
    || process.env.CI !== "true" || url.protocol !== "postgresql:" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.search || url.hash) {
    throw new Error("Material drift recovery tests require the private disposable PostgreSQL URL")
  }
  return value
}

const databaseUrl = disposableDatabaseUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip
const fixtures: Fixture[] = []
let prisma: PrismaClient | undefined

function markerFor(fixture: Pick<Fixture, "userId" | "sessionId" | "sourceTurnId" | "rootTaskId" | "gateTaskId" | "executionId">) {
  const owner = { userId: fixture.userId, sessionId: fixture.sessionId, turnId: fixture.sourceTurnId,
    rootTaskId: fixture.rootTaskId, rootAttemptCount: 2, turnLeaseOwnerId: `lease-${fixture.sourceTurnId}`,
    turnLeaseVersion: 3, executionId: fixture.executionId, executionAttemptCount: 4 }
  const gate = { taskId: fixture.gateTaskId, leaseOwnerId: `gate-lease-${fixture.gateTaskId}`, attemptCount: 5 }
  return {
    schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1",
    reason: "scheduled_prepare_material_source_changed", owner, gate,
    analyzeFingerprintDigest: `sha256:${"a".repeat(64)}`, prepareProofDigest: `sha256:${"b".repeat(64)}`,
    artifactDigest: `sha256:${"c".repeat(64)}`, currentMaterialDigest: `sha256:${"d".repeat(64)}`,
    proofDigest: `sha256:${"e".repeat(64)}`,
  }
}

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID()
  const fixture: Fixture = {
    userId: `mdr-user-${suffix}`, sessionId: `mdr-session-${suffix}`, automationId: `mdr-automation-${suffix}`,
    sourceTurnId: `mdr-source-turn-${suffix}`, rootTaskId: `mdr-root-${suffix}`, gateTaskId: `mdr-gate-${suffix}`,
    executionId: `mdr-execution-${suffix}`, sourceMarker: {},
  }
  fixture.sourceMarker = markerFor(fixture)
  fixtures.push(fixture)
  const client = prisma!
  await client.user.create({ data: { id: fixture.userId, email: `${fixture.userId}@example.invalid`, onboardingGoals: [] } })
  await client.agentSession.create({ data: { id: fixture.sessionId, userId: fixture.userId, goal: "Run the Berlin role scout",
    status: "running", source: "automation", memorySummary: "Before recovery." } })
  await client.agentAutomation.create({ data: { id: fixture.automationId, userId: fixture.userId, name: "Berlin role scout",
    enabled: true, triggerType: "weekdays", cron: "0 9 * * 1-5", timezone: "Europe/Dublin", targetRoles: ["SWE"],
    targetLocations: ["Berlin"], minScore: 85, dailyCap: 8, requireApproval: true, autoApply: false, sessionId: fixture.sessionId } })
  await client.agentTurn.create({ data: { id: fixture.sourceTurnId, sessionId: fixture.sessionId, userId: fixture.userId,
    source: "automation", status: "interrupted", executionMode: "canonical_task_graph", input: { automationRunMode: "scheduled" },
    rootTaskId: fixture.rootTaskId, leaseOwnerId: `lease-${fixture.sourceTurnId}`, leaseVersion: 3,
    modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, createdAt: new Date("2020-01-01T00:00:00.000Z") } })
  await client.subAgentTask.create({ data: { id: fixture.rootTaskId, sessionId: fixture.sessionId, turnId: fixture.sourceTurnId,
    rootTaskId: null, parentTaskId: null, depth: 0, role: "orchestrator", taskType: "root", status: "failed", goal: "Scout roles",
    constraints: {}, successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, attemptCount: 2 } })
  await client.subAgentTask.update({ where: { id: fixture.rootTaskId }, data: { rootTaskId: fixture.rootTaskId } })
  await client.subAgentTask.create({ data: { id: fixture.gateTaskId, sessionId: fixture.sessionId, turnId: fixture.sourceTurnId,
    rootTaskId: fixture.rootTaskId, parentTaskId: fixture.rootTaskId, depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate",
    status: "failed", goal: "Prepare the scheduled task graph", constraints: {}, successCriteria: [], allowedActions: [], context: {},
    expectedOutputSchema: {}, attemptCount: 5 } })
  await client.agentExecution.create({ data: { id: fixture.executionId, userId: fixture.userId, sessionId: fixture.sessionId,
    status: "failed", checkpoint: "gate", error: "scheduled_prepare_material_source_changed", attemptCount: 4,
    state: { scheduledTaskGraphMaterialDriftTerminal: fixture.sourceMarker } } })
  return fixture
}

function recoveryInput(fixture: Fixture, now = new Date()) {
  return { automationId: fixture.automationId, userId: fixture.userId, sessionId: fixture.sessionId, now }
}

describeWithPostgres("material drift recovery PostgreSQL transaction", () => {
  beforeAll(async () => {
    prisma = new PrismaClient({ datasources: { db: { url: databaseUrl! } } })
    await prisma.$connect()
  })

  afterEach(async () => {
    if (!prisma) return
    for (const fixture of fixtures.splice(0)) {
      await prisma.agentOutbox.deleteMany({ where: { aggregateId: fixture.sessionId } }).catch(() => undefined)
      await prisma.user.delete({ where: { id: fixture.userId } }).catch(() => undefined)
    }
  })

  afterAll(async () => { await prisma?.$disconnect() })

  it("commits the fresh Turn, reserved attempt, and dispatch outbox from the verified old marker", async () => {
    const fixture = await createFixture()
    const result = await startMaterialDriftRecovery(prisma!, recoveryInput(fixture))
    expect(result).toMatchObject({ kind: "created", turnStatus: "queued", executionId: fixture.executionId })
    if (!result || result.kind !== "created") throw new Error("Expected a newly committed recovery Turn")

    const [turn, execution, outbox, sourceTurn] = await Promise.all([
      prisma!.agentTurn.findUnique({ where: { id: result.turnId } }),
      prisma!.agentExecution.findUnique({ where: { id: fixture.executionId } }),
      prisma!.agentOutbox.findUnique({ where: { idempotencyKey: `turn-dispatch:${result.turnId}` } }),
      prisma!.agentTurn.findUnique({ where: { id: fixture.sourceTurnId } }),
    ])
    const turnInput = turn?.input as { automationRunMode?: string; materialDriftRecovery?: Record<string, unknown> } | undefined
    expect(turnInput).toMatchObject({ automationRunMode: "manual", materialDriftRecovery: {
      schemaVersion: "agent-harness.v2.material-drift-recovery.v2", turnId: result.turnId,
      userId: fixture.userId, sessionId: fixture.sessionId, automationId: fixture.automationId,
      previousTurnId: fixture.sourceTurnId, previousExecutionId: fixture.executionId,
      previousRecoveryTurnId: null, previousExecutionAttemptCount: 4, reservedExecutionAttemptCount: 5,
      sourceMarker: fixture.sourceMarker,
    } })
    expect(turn?.status).toBe("queued")
    expect(sourceTurn?.status).toBe("interrupted")
    expect(execution).toMatchObject({ attemptCount: 5, status: "queued", checkpoint: "scout", error: null,
      state: { nextStage: "scout", autonomous: true } })
    expect(outbox).toMatchObject({ topic: "agent.turn.dispatch", aggregateId: fixture.sessionId,
      idempotencyKey: `turn-dispatch:${result.turnId}`, payload: { turnId: result.turnId, sessionId: fixture.sessionId, ownerId: `web:${result.turnId}` } })
  }, TEST_TIMEOUT_MS)

  it("rolls back Turn, attempt reservation, automation claim, and outbox when dispatch insertion fails", async () => {
    const fixture = await createFixture()
    const constraint = `mdr_reject_dispatch_${randomUUID().replaceAll("-", "")}`
    await prisma!.$executeRawUnsafe(`ALTER TABLE "agent_outbox" ADD CONSTRAINT "${constraint}" CHECK ("topic" <> 'agent.turn.dispatch') NOT VALID`)
    try {
      await expect(startMaterialDriftRecovery(prisma!, recoveryInput(fixture))).rejects.toThrow()
    } finally {
      await prisma!.$executeRawUnsafe(`ALTER TABLE "agent_outbox" DROP CONSTRAINT "${constraint}"`)
    }

    const [turnCount, execution, automation, session, outboxCount] = await Promise.all([
      prisma!.agentTurn.count({ where: { sessionId: fixture.sessionId, userId: fixture.userId } }),
      prisma!.agentExecution.findUnique({ where: { id: fixture.executionId } }),
      prisma!.agentAutomation.findUnique({ where: { id: fixture.automationId } }),
      prisma!.agentSession.findUnique({ where: { id: fixture.sessionId } }),
      prisma!.agentOutbox.count({ where: { aggregateId: fixture.sessionId } }),
    ])
    expect(turnCount).toBe(1)
    expect(execution).toMatchObject({ attemptCount: 4, status: "failed", error: "scheduled_prepare_material_source_changed",
      state: { scheduledTaskGraphMaterialDriftTerminal: fixture.sourceMarker } })
    expect(automation?.lastRunAt).toBeNull()
    expect(session).toMatchObject({ status: "running", memorySummary: "Before recovery." })
    expect(outboxCount).toBe(0)
  }, TEST_TIMEOUT_MS)

  it("serializes duplicate requests and rejects a different owner without consuming the source marker", async () => {
    const fixture = await createFixture()
    const foreign = await createFixture()
    await expect(startMaterialDriftRecovery(prisma!, { ...recoveryInput(fixture), userId: foreign.userId })).resolves.toBeNull()
    expect(await prisma!.agentExecution.findUnique({ where: { id: fixture.executionId }, select: { attemptCount: true } }))
      .toEqual({ attemptCount: 4 })
    expect(await prisma!.agentTurn.count({ where: { sessionId: fixture.sessionId } })).toBe(1)

    const results = await Promise.all([
      startMaterialDriftRecovery(prisma!, recoveryInput(fixture)),
      startMaterialDriftRecovery(prisma!, recoveryInput(fixture)),
    ])
    expect(results.map(result => result?.kind).sort()).toEqual(["already_started", "created"])
    expect(await prisma!.agentTurn.count({ where: { sessionId: fixture.sessionId } })).toBe(2)
    expect(await prisma!.agentExecution.findUnique({ where: { id: fixture.executionId }, select: { attemptCount: true } }))
      .toEqual({ attemptCount: 5 })
    expect(await prisma!.agentOutbox.count({ where: { aggregateId: fixture.sessionId, topic: "agent.turn.dispatch" } })).toBe(1)
  }, TEST_TIMEOUT_MS)

  it("chains an interrupted recovery to the original marker with exactly one new reserved attempt", async () => {
    const fixture = await createFixture()
    const first = await startMaterialDriftRecovery(prisma!, recoveryInput(fixture))
    if (!first || first.kind !== "created") throw new Error("Expected the initial recovery Turn")
    await prisma!.agentTurn.update({ where: { id: first.turnId }, data: { status: "interrupted", createdAt: new Date(Date.now() - 60_000) } })
    await prisma!.agentExecution.update({ where: { id: fixture.executionId }, data: { status: "paused", error: null, state: {} } })

    const second = await startMaterialDriftRecovery(prisma!, recoveryInput(fixture))
    expect(second).toMatchObject({ kind: "created", turnStatus: "queued" })
    if (!second || second.kind !== "created") throw new Error("Expected a chained recovery Turn")
    const [firstTurn, secondTurn, execution, outboxCount] = await Promise.all([
      prisma!.agentTurn.findUnique({ where: { id: first.turnId } }),
      prisma!.agentTurn.findUnique({ where: { id: second.turnId } }),
      prisma!.agentExecution.findUnique({ where: { id: fixture.executionId } }),
      prisma!.agentOutbox.count({ where: { aggregateId: fixture.sessionId, topic: "agent.turn.dispatch" } }),
    ])
    const firstIntent = (firstTurn?.input as { materialDriftRecovery?: Record<string, unknown> } | undefined)?.materialDriftRecovery
    const secondIntent = (secondTurn?.input as { materialDriftRecovery?: Record<string, unknown> } | undefined)?.materialDriftRecovery
    expect(firstIntent).toMatchObject({ previousRecoveryTurnId: null, previousExecutionAttemptCount: 4, reservedExecutionAttemptCount: 5 })
    expect(secondIntent).toMatchObject({ previousRecoveryTurnId: first.turnId, previousTurnId: fixture.sourceTurnId,
      previousExecutionAttemptCount: 4, reservedExecutionAttemptCount: 6, sourceMarker: fixture.sourceMarker })
    expect(execution).toMatchObject({ attemptCount: 6, status: "queued", error: null })
    expect(outboxCount).toBe(2)
  }, TEST_TIMEOUT_MS)
})
