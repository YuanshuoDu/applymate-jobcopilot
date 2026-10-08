import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "../subagents/task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION, verifyTaskGraphNodeEvidence } from "../subagents/task-graph-pg-verification.js"
import { createPgDirectSelectedJobHistoryStore, type DirectSelectedJobHistoryLoadInput } from "./selected-job-history-direct-store.js"
import { projectSelectedJobHistoryOutcomes } from "./selected-job-history.js"
import type { TurnLease } from "../turns/lease.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Direct selected-job history needs the disposable PostgreSQL CI service")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Direct selected-job history requires the dedicated disposable PostgreSQL URL")
  }
  return value
}

type Source = Readonly<{ turnId: string; rootTaskId: string; childId: string; finalItemId: string; sessionId: string; userId: string; jobId: string; startSequence: number; stepId?: string; status?: "completed" | "failed" | "interrupted"; verification?: TaskGraphVerificationContract }>
const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip, suffix = randomUUID()
const userId = `direct-history-user-${suffix}`, otherUserId = `direct-history-other-user-${suffix}`
const sessionId = `direct-history-session-${suffix}`, otherSessionId = `direct-history-other-session-${suffix}`
const foreignSessionId = `direct-history-foreign-session-${suffix}`, jobId = `job-${suffix}`, otherJobId = `other-job-${suffix}`
const currentTurnId = `direct-history-current-turn-${suffix}`, currentRootTaskId = `direct-history-current-root-${suffix}`
const currentStepId = `direct-history-current-step-${suffix}`, workerId = `worker-${suffix}`
const matchingSources: Source[] = Array.from({ length: 10 }, (_, index) => ({
  turnId: `direct-history-source-turn-${index}-${suffix}`, rootTaskId: `direct-history-source-root-${index}-${suffix}`,
  childId: `direct-history-source-child-${index}-${suffix}`, finalItemId: `direct-history-source-final-${index}-${suffix}`,
  sessionId, userId, jobId, stepId: `direct-history-source-step-${index}-${suffix}`, startSequence: index * 2 + 1,
}))
const otherJobSource: Source = { turnId: `direct-history-other-job-turn-${suffix}`, rootTaskId: `direct-history-other-job-root-${suffix}`,
  childId: `direct-history-other-job-child-${suffix}`, finalItemId: `direct-history-other-job-final-${suffix}`,
  sessionId, userId, jobId: otherJobId, stepId: `direct-history-other-job-step-${suffix}`, startSequence: 25 }
const failedSource: Source = { turnId: `direct-history-failed-turn-${suffix}`, rootTaskId: `direct-history-failed-root-${suffix}`,
  childId: `direct-history-failed-child-${suffix}`, finalItemId: `direct-history-failed-final-${suffix}`,
  sessionId, userId, jobId, startSequence: 21, status: "failed", verification: {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
    criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }],
  } }
const interruptedSource: Source = { turnId: `direct-history-interrupted-turn-${suffix}`, rootTaskId: `direct-history-interrupted-root-${suffix}`,
  childId: `direct-history-interrupted-child-${suffix}`, finalItemId: `direct-history-interrupted-final-${suffix}`,
  sessionId, userId, jobId, startSequence: 23, status: "interrupted" }
const otherSessionSource: Source = { turnId: `direct-history-other-session-turn-${suffix}`, rootTaskId: `direct-history-other-session-root-${suffix}`,
  childId: `direct-history-other-session-child-${suffix}`, finalItemId: `direct-history-other-session-final-${suffix}`,
  sessionId: otherSessionId, userId, jobId, stepId: `direct-history-other-session-step-${suffix}`, startSequence: 1 }
const otherUserSource: Source = { turnId: `direct-history-other-user-turn-${suffix}`, rootTaskId: `direct-history-other-user-root-${suffix}`,
  childId: `direct-history-other-user-child-${suffix}`, finalItemId: `direct-history-other-user-final-${suffix}`,
  sessionId: foreignSessionId, userId: otherUserId, jobId, stepId: `direct-history-other-user-step-${suffix}`, startSequence: 1 }
let pool: PgPool | undefined
let lease: TurnLease

async function insertUser(id: string): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [id, `${id}@example.invalid`])
}

async function insertSession(id: string, owner: string, sequence: number): Promise<void> {
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt")
    VALUES ($1, $2, 'Find a role', 'running', 'test', $3, CURRENT_TIMESTAMP)`, [id, owner, sequence])
}

async function insertSource(source: Source): Promise<void> {
  const status = source.status ?? "completed"
  const input = JSON.stringify({ selectedJobPreparation: { jobId: source.jobId } })
  const graph = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: "scout", templateId: "scout",
    goal: "Find a suitable role", successCriteria: ["Find one role"], dependsOn: [], depth: 1, taskId: source.childId,
    ...(source.verification ? { verificationDisposition: "typed", verification: source.verification } : {}) }] })
  await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
    "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, $6, 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
  [source.turnId, source.sessionId, source.userId, input, source.rootTaskId, status])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $1, NULL, '/source', 0, 'orchestrator', 'root', $4, 'Find a role', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [source.rootTaskId, source.sessionId, source.turnId, status])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, '/source/scout', 1, 'scout', 'scout', $5, 'Find a suitable role', '[]'::jsonb, '["Find one role"]'::jsonb,
      '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP)`,
  [source.childId, source.sessionId, source.turnId, source.rootTaskId, source.verification ? "running" : "completed"])
  if (status === "completed") {
    if (!source.stepId) throw new Error("Completed history source needs its canonical Step ID")
    await pool!.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`,
    [source.stepId, source.sessionId, source.turnId, source.rootTaskId])
  }
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ($6, $2, $3, $4, 'agent_message', 'completed', 0, '{"text":"done"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [taskGraphItemId(source.rootTaskId), source.sessionId, source.turnId, source.rootTaskId, JSON.stringify(graph), source.finalItemId])
  const start = source.startSequence, terminal = start + 1
  const terminalType = status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.interrupted"
  const terminalItemId = status === "completed" ? source.finalItemId : null
  const correlationId = status === "completed" ? source.stepId : source.turnId
  const errorCode = status === "failed" ? "task_failed" : status === "interrupted" ? "interrupted" : undefined
  const terminalKey = status === "completed" ? `turn:${source.turnId}:event:turn-completed`
    : status === "failed" ? `turn:${source.turnId}:event:turn-failed:${errorCode}` : `turn:${source.turnId}:event:turn-interrupted`
  const terminalPayload = status === "completed" ? { turnId: source.turnId, taskId: source.rootTaskId, finalItemId: source.finalItemId }
    : status === "failed" ? { turnId: source.turnId, taskId: source.rootTaskId, errorCode, finalItemId: null }
      : { turnId: source.turnId, taskId: source.rootTaskId, errorCode }
  await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, NULL, $4, $5, 'turn.started', 'orchestrator', $3, $6, $7::jsonb),
      ($8, $2, $3, $9, $4, $10, $11, 'orchestrator', $12, $13, $14::jsonb)`,
  [`direct-history-start-${source.turnId}`, source.sessionId, source.turnId, source.rootTaskId, start,
    `turn:${source.turnId}:event:turn-started`, JSON.stringify({ taskId: source.rootTaskId, rootTaskId: source.rootTaskId }),
    `direct-history-terminal-${source.turnId}`, terminalItemId, terminal, terminalType, correlationId, terminalKey,
    JSON.stringify(terminalPayload)])
  if (source.verification) await persistUnverifiedVerificationReport(source, graph)
}

async function persistUnverifiedVerificationReport(
  source: Source,
  snapshot: ReturnType<typeof parseTaskGraphSnapshot>,
): Promise<void> {
  if (source.status !== "failed" || !source.verification) throw new Error("typed history fixture must be a failed source")
  const client = await pool!.connect()
  try {
    await client.query("BEGIN")
    const verification = await verifyTaskGraphNodeEvidence(client, {
      scope: { userId: source.userId, sessionId: source.sessionId, turnId: source.turnId,
        rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId, taskId: source.childId, attemptCount: 1 },
      snapshot, node: snapshot.nodes[0]!, structuredResult: {},
    })
    if (verification.report.verifierVersion !== TASK_GRAPH_VERIFIER_VERSION || verification.report.status !== "unverified"
      || verification.report.reasonCode !== "canonical_evidence_invalid" || verification.report.evidenceDigest !== null
      || verification.report.resultDigest !== null) throw new Error("typed history fixture did not produce the expected verifier report")
    const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'failed', "failureReason" = 'task_graph_verification_unverified',
      "result" = $1::jsonb, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "rootTaskId" = $5 AND "parentTaskId" = $5 AND "status" = 'running' AND "attemptCount" = 1`,
    [JSON.stringify({ taskGraphVerificationReport: verification.report }), source.childId, source.sessionId, source.turnId, source.rootTaskId])
    if (updated.rowCount !== 1) throw new Error("typed history fixture child update lost its source fence")
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

describePg("direct selected-job history PostgreSQL source validation", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    lease = { turnId: currentTurnId, sessionId, userId, ownerId: workerId, leaseVersion: 1,
      leaseStartedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 5 * 60_000) }
    await insertUser(userId)
    await insertUser(otherUserId)
    await insertSession(sessionId, userId, 28)
    await insertSession(otherSessionId, userId, 4)
    await insertSession(foreignSessionId, otherUserId, 4)
    for (const source of matchingSources) await insertSource(source)
    await insertSource(failedSource)
    await insertSource(interruptedSource)
    await insertSource(otherJobSource)
    await insertSource(otherSessionSource)
    await insertSource(otherUserSource)

    const input = JSON.stringify({ selectedJobPreparation: { jobId } })
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
      "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6,
        CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
    [currentTurnId, sessionId, userId, input, currentRootTaskId, workerId])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $1, NULL, '/current', 0, 'orchestrator', 'root', 'running', 'Find a role', '[]'::jsonb, '[]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 3, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', NULL, CURRENT_TIMESTAMP)`,
    [currentRootTaskId, sessionId, currentTurnId, workerId])
    await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [currentStepId, sessionId, currentTurnId, currentRootTaskId])
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, NULL, $4, 28, 'turn.started', 'orchestrator', $3, $5, $6::jsonb)`,
    [`direct-history-current-start-${suffix}`, sessionId, currentTurnId, currentRootTaskId,
      `turn:${currentTurnId}:event:turn-started`, JSON.stringify({ taskId: currentRootTaskId, rootTaskId: currentRootTaskId })])
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [[userId, otherUserId]]).catch(() => undefined)
      await pool.end()
    }
  })

  it("finds same-job terminal roots directly without compaction records and bounds history to the newest eight", async () => {
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    const history = await createPgDirectSelectedJobHistoryStore(pool!).load(input)

    expect(history.map(item => item.terminalSequence)).toEqual([24n, 22n, 20n, 18n, 16n, 14n, 12n, 10n])
    expect(history.map(item => item.sourceTurnId)).toEqual([interruptedSource, failedSource, ...matchingSources.slice(4).reverse()].map(source => source.turnId))
    expect(history.every(item => item.jobId === jobId && item.nodes.length === 1 && !JSON.stringify(item.nodes).includes("Find a suitable role"))).toBe(true)
    expect(history.some(item => item.sourceTurnId === otherJobSource.turnId || item.sourceTurnId === otherSessionSource.turnId
      || item.sourceTurnId === otherUserSource.turnId)).toBe(false)
  })

  it("projects a validated stored unverified report as bounded reason hints", async () => {
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    const outcomes = await createPgDirectSelectedJobHistoryStore(pool!).load(input)
    const outcome = outcomes.find(item => item.sourceTurnId === failedSource.turnId)
    if (!outcome) throw new Error("typed failed source was not returned by the direct reader")
    expect(outcome.nodes[0]).toMatchObject({ status: "failed", verification: { status: "unverified",
      criteria: [{ status: "unverified", reasonCode: "canonical_evidence_invalid" }] } })

    const block = projectSelectedJobHistoryOutcomes([outcome])
    expect(block?.id).toBe("selected-job-history")
    const encoded = JSON.stringify(block?.content ?? null)
    expect(JSON.parse(encoded)).toMatchObject({ kind: "selected_job_history", informationalOnly: true,
      turns: [{ nodes: [{ role: "scout", status: "failed", reasonHints: ["canonical_evidence_invalid"] }] }] })
    for (const privateValue of [failedSource.turnId, failedSource.rootTaskId, "candidate-count", TASK_GRAPH_VERIFIER_VERSION,
      "verificationStatus", "taskGraphVerificationReport", "evidenceDigest", "resultDigest", "task_graph_verification_unverified"]) {
      expect(encoded).not.toContain(privateValue)
    }
  })

  it("counts a malformed wrong-actor duplicate Root terminal event as ambiguous", async () => {
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    const store = createPgDirectSelectedJobHistoryStore(pool!)
    const source = interruptedSource
    const baseline = await store.load(input)
    expect(baseline.some(item => item.sourceTurnId === source.turnId)).toBe(true)
    const duplicateId = `direct-history-malformed-duplicate-${suffix}`
    try {
      await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, NULL, $4, 27, 'turn.interrupted', 'system', $3, $5, $6::jsonb)`,
      [duplicateId, source.sessionId, source.turnId, source.rootTaskId, `malformed-duplicate:${suffix}`,
        JSON.stringify({ turnId: source.turnId, taskId: "wrong-root", errorCode: "interrupted" })])

      const history = await store.load(input)

      expect(history.some(item => item.sourceTurnId === source.turnId)).toBe(false)
    } finally {
      await pool!.query(`DELETE FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2`, [duplicateId, source.sessionId])
    }
  })

  it("omits completed history when the terminal correlation Step is missing or belongs to another source", async () => {
    const missingStepSource = matchingSources[9], foreignStepSource = matchingSources[8]
    const foreignStepId = otherSessionSource.stepId
    if (!missingStepSource.stepId || !foreignStepSource.stepId || !foreignStepId) throw new Error("completed source Step fixtures are missing")
    const missingEventId = `direct-history-terminal-${missingStepSource.turnId}`
    const foreignEventId = `direct-history-terminal-${foreignStepSource.turnId}`
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    try {
      await pool!.query(`UPDATE "agent_events" SET "correlationId" = $1 WHERE "id" = $2 AND "sessionId" = $3`,
        [`missing-step-${suffix}`, missingEventId, sessionId])
      await pool!.query(`UPDATE "agent_events" SET "correlationId" = $1 WHERE "id" = $2 AND "sessionId" = $3`,
        [foreignStepId, foreignEventId, sessionId])

      const history = await createPgDirectSelectedJobHistoryStore(pool!).load(input)

      expect(history.some(item => item.sourceTurnId === missingStepSource.turnId)).toBe(false)
      expect(history.some(item => item.sourceTurnId === foreignStepSource.turnId)).toBe(false)
      expect(history.some(item => item.sourceTurnId === matchingSources[7].turnId)).toBe(true)
    } finally {
      await pool!.query(`UPDATE "agent_events" SET "correlationId" = $1 WHERE "id" = $2 AND "sessionId" = $3`,
        [missingStepSource.stepId, missingEventId, sessionId])
      await pool!.query(`UPDATE "agent_events" SET "correlationId" = $1 WHERE "id" = $2 AND "sessionId" = $3`,
        [foreignStepSource.stepId, foreignEventId, sessionId])
    }
  })

  it("rejects an expired current Turn lease using the database clock and restores the fixture lease", async () => {
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    const current = await pool!.query<{ leaseExpiresAt: Date }>(`SELECT "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [currentTurnId, sessionId, userId])
    const originalLeaseExpiresAt = current.rows[0]?.leaseExpiresAt
    if (!originalLeaseExpiresAt) throw new Error("current fixture Turn lease is missing")
    try {
      await pool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [currentTurnId, sessionId, userId])
      await expect(createPgDirectSelectedJobHistoryStore(pool!).load(input)).rejects.toThrow("task_graph_turn_fenced")
    } finally {
      await pool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = $1 WHERE "id" = $2 AND "sessionId" = $3 AND "userId" = $4`,
        [originalLeaseExpiresAt, currentTurnId, sessionId, userId])
    }
    const restored = await pool!.query<{ leaseExpiresAt: Date }>(`SELECT "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`,
      [currentTurnId, sessionId, userId])
    expect(restored.rows[0]?.leaseExpiresAt).toEqual(originalLeaseExpiresAt)
  })

  it("excludes a wrong Root terminal actor and omits a corrupt historical graph", async () => {
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    const newest = interruptedSource, next = failedSource
    await pool!.query(`UPDATE "agent_events" SET "actor" = 'system' WHERE "id" = $1`, [`direct-history-terminal-${newest.turnId}`])
    let history = await createPgDirectSelectedJobHistoryStore(pool!).load(input)
    expect(history.some(item => item.sourceTurnId === newest.turnId)).toBe(false)

    await pool!.query(`UPDATE "agent_items" SET "content" = '{"schemaVersion":"bad","nodes":[]}'::jsonb WHERE "id" = $1`,
      [taskGraphItemId(next.rootTaskId)])
    history = await createPgDirectSelectedJobHistoryStore(pool!).load(input)
    expect(history.some(item => item.sourceTurnId === next.turnId)).toBe(false)
  })
})
