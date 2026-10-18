import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "../subagents/role-results.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-verification-report.js"
import { TASK_GRAPH_TEMPLATES } from "../subagents/task-graph-templates.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "../subagents/task-graph-snapshot.js"
import { taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA } from "../subagents/task-graph-historical-discovery-page-contract.js"
import { createPgRootTaskHistoryResultPageStore } from "./root-task-history-result-page-store.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Historical discovery paging requires the disposable PostgreSQL CI service")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Historical discovery paging requires the dedicated disposable PostgreSQL URL")
  }
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip, suffix = randomUUID()
const userId = `history-page-user-${suffix}`, sessionId = `history-page-session-${suffix}`
const currentTurnId = `history-page-current-turn-${suffix}`, currentRootId = `history-page-current-root-${suffix}`
const currentStepId = `history-page-current-step-${suffix}`, sourceTurnId = `history-page-source-turn-${suffix}`
const sourceRootId = `history-page-source-root-${suffix}`, sourceScoutId = `history-page-source-scout-${suffix}`
const sourceScoutAId = `history-page-source-scout-a-${suffix}`
const olderSourceTurnId = `history-page-older-turn-${suffix}`, olderSourceRootId = `history-page-older-root-${suffix}`
const olderSourceScoutId = `history-page-older-scout-${suffix}`
const workerId = `history-page-worker-${suffix}`, objective = "Find software engineering roles"
const foreignUserId = `history-page-foreign-user-${suffix}`, foreignSessionId = `history-page-foreign-session-${suffix}`
const foreignTurnId = `history-page-foreign-turn-${suffix}`, foreignRootId = `history-page-foreign-root-${suffix}`
const foreignScoutId = `history-page-foreign-scout-${suffix}`
const criteria = ["Search only the saved locations"]
const candidateIds = Array.from({ length: 5 }, (_, index) => `c${String(index + 1).padStart(24, "0")}`)
const olderCandidateIds = [`c${String(8).padStart(24, "0")}`, `c${String(9).padStart(24, "0")}`]
const newerCandidateIds = [`c${String(7).padStart(24, "0")}`]
const verification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
}
function structuredScoutResult(ids: readonly string[] = candidateIds) {
  const evidence = ids.map((jobId, index) => ({ id: `job-${index}`, kind: "job", ref: jobId, source: "greenhouse" }))
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", summary: "completed source results",
    evidence, candidates: ids.map((jobId, index) => ({ jobId, source: "greenhouse", url: null, evidenceIds: [`job-${index}`] })),
  }
}
function verificationReport(result: unknown) {
  return {
  verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
  criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }],
  evidenceDigest: "a".repeat(64), resultDigest: taskGraphResultDigest(validateRoleResult(result, "scout")),
  }
}
const report = verificationReport(structuredScoutResult())
const newerResult = structuredScoutResult(newerCandidateIds), newerReport = verificationReport(newerResult)
const graph = {
  schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
  nodes: ["scout-z", "scout-a"].map((key, index) => ({
    key, templateId: "scout", goal: "Search the approved sources", successCriteria: ["Return candidate IDs"],
    dependsOn: [], depth: 1, taskId: index === 0 ? sourceScoutId : sourceScoutAId, verificationDisposition: "typed", verification,
    registeredScoutEnvelope: {
      role: TASK_GRAPH_TEMPLATES.scout.role, taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
      expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema,
      allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions],
    },
  })),
}
function workerResult(result: unknown = structuredScoutResult(), resultReport: unknown = report) {
  return {
    finalItemId: "final-scout", finalText: "", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: result,
    taskGraphVerificationReport: resultReport,
  }
}

async function seedForeignMatchingSource(database: PgPool): Promise<void> {
  const foreignJobIds = [`c${String(99).padStart(24, "0")}`], result = structuredScoutResult(foreignJobIds)
  const foreignReport = verificationReport(result), node = { ...graph.nodes[1]!, key: "scout-foreign", taskId: foreignScoutId }
  await database.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [foreignUserId, `${foreignUserId}@example.invalid`])
  await database.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt")
    VALUES ($1, $2, $3, 'running', 'test', 1000, CURRENT_TIMESTAMP)`, [foreignSessionId, foreignUserId, objective])
  await database.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
    "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'failed', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
  [foreignTurnId, foreignSessionId, foreignUserId, JSON.stringify({ goal: objective, successCriteria: criteria }), foreignRootId])
  await database.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $1, NULL, '/foreign', 0, 'orchestrator', 'root', 'failed', $4, '[]'::jsonb, $5::jsonb,
      '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [foreignRootId, foreignSessionId, foreignTurnId, objective, JSON.stringify(criteria)])
  await database.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "failureReason", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, '/foreign/scout', 1, 'scout', 'job_discovery', 'completed', 'Search roles', '[]'::jsonb, '[]'::jsonb,
      $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [foreignScoutId, foreignSessionId, foreignTurnId, foreignRootId, JSON.stringify(TASK_GRAPH_TEMPLATES.scout.allowedActions),
    JSON.stringify(TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema), JSON.stringify(workerResult(result, foreignReport))])
  await database.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [taskGraphItemId(foreignRootId), foreignSessionId, foreignTurnId, foreignRootId, JSON.stringify({
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [node],
  })])
  await database.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload", "createdAt")
    VALUES ($1, $2, $3, NULL, $4, 1, 'turn.started', 'orchestrator', $3, $5, $6::jsonb, CURRENT_TIMESTAMP),
      ($7, $2, $3, NULL, $4, 999, 'turn.failed', 'orchestrator', $3, $8, $9::jsonb, CURRENT_TIMESTAMP)`,
  [`history-page-foreign-start-${foreignTurnId}`, foreignSessionId, foreignTurnId, foreignRootId, `turn:${foreignTurnId}:event:turn-started`,
    JSON.stringify({ goal: objective, taskId: foreignRootId, rootTaskId: foreignRootId }), `history-page-foreign-terminal-${foreignTurnId}`,
    `turn:${foreignTurnId}:event:turn-failed:task_failed`, JSON.stringify({ turnId: foreignTurnId, taskId: foreignRootId, errorCode: "task_failed", finalItemId: null })])
}

let pool: PgPool | undefined
const scope = {
  userId, sessionId, turnId: currentTurnId, rootTaskId: currentRootId, parentTaskId: currentRootId,
  stepId: currentStepId, turnLeaseOwner: workerId, turnLeaseVersion: 3,
  parentLeaseOwner: workerId, parentAttemptCount: 2,
}

describePg("historical discovery result-page PostgreSQL store", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl! })
    await pool.query("SELECT 1")
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [userId, `${userId}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt")
      VALUES ($1, $2, $3, 'running', 'test', 100, CURRENT_TIMESTAMP)`, [sessionId, userId, objective])
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
      "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'failed', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
    [sourceTurnId, sessionId, userId, JSON.stringify({ goal: objective, successCriteria: criteria }), sourceRootId])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $1, NULL, '/source', 0, 'orchestrator', 'root', 'failed', $4, '[]'::jsonb, $5::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [sourceRootId, sessionId, sourceTurnId, objective, JSON.stringify(criteria)])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "failureReason", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/source/scout', 1, 'scout', 'job_discovery', 'completed', 'Search roles', '[]'::jsonb, '[]'::jsonb,
        $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [sourceScoutId, sessionId, sourceTurnId, sourceRootId, JSON.stringify(TASK_GRAPH_TEMPLATES.scout.allowedActions),
      JSON.stringify(TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema), JSON.stringify(workerResult(newerResult, newerReport))])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "failureReason", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/source/scout-a', 1, 'scout', 'job_discovery', 'completed', 'Search roles', '[]'::jsonb, '[]'::jsonb,
        $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [sourceScoutAId, sessionId, sourceTurnId, sourceRootId, JSON.stringify(TASK_GRAPH_TEMPLATES.scout.allowedActions),
      JSON.stringify(TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema), JSON.stringify(workerResult())])
    await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [taskGraphItemId(sourceRootId), sessionId, sourceTurnId, sourceRootId, JSON.stringify(graph)])
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload", "createdAt")
      VALUES ($1, $2, $3, NULL, $4, 1, 'turn.started', 'orchestrator', $3, $5, $6::jsonb, CURRENT_TIMESTAMP),
        ($7, $2, $3, NULL, $4, 3, 'turn.failed', 'orchestrator', $3, $8, $9::jsonb, CURRENT_TIMESTAMP)`,
    [`history-page-start-${sourceTurnId}`, sessionId, sourceTurnId, sourceRootId, `turn:${sourceTurnId}:event:turn-started`,
      JSON.stringify({ goal: objective, taskId: sourceRootId, rootTaskId: sourceRootId }), `history-page-terminal-${sourceTurnId}`,
      `turn:${sourceTurnId}:event:turn-failed:task_failed`, JSON.stringify({ turnId: sourceTurnId, taskId: sourceRootId, errorCode: "task_failed", finalItemId: null })])
    const olderResult = structuredScoutResult(olderCandidateIds), olderReport = verificationReport(olderResult)
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
      "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'failed', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
    [olderSourceTurnId, sessionId, userId, JSON.stringify({ goal: objective, successCriteria: criteria }), olderSourceRootId])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $1, NULL, '/older-source', 0, 'orchestrator', 'root', 'failed', $4, '[]'::jsonb, $5::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [olderSourceRootId, sessionId, olderSourceTurnId, objective, JSON.stringify(criteria)])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "failureReason", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, '/older-source/scout', 1, 'scout', 'job_discovery', 'completed', 'Search roles', '[]'::jsonb, '[]'::jsonb,
        $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [olderSourceScoutId, sessionId, olderSourceTurnId, olderSourceRootId, JSON.stringify(TASK_GRAPH_TEMPLATES.scout.allowedActions),
      JSON.stringify(TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema), JSON.stringify(workerResult(olderResult, olderReport))])
    const olderGraph = { ...graph, nodes: [{ ...graph.nodes[1]!, key: "scout-older", taskId: olderSourceScoutId }] }
    await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [taskGraphItemId(olderSourceRootId), sessionId, olderSourceTurnId, olderSourceRootId, JSON.stringify(olderGraph)])
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload", "createdAt")
      VALUES ($1, $2, $3, NULL, $4, 1, 'turn.started', 'orchestrator', $3, $5, $6::jsonb, CURRENT_TIMESTAMP),
        ($7, $2, $3, NULL, $4, 2, 'turn.failed', 'orchestrator', $3, $8, $9::jsonb, CURRENT_TIMESTAMP)`,
    [`history-page-start-${olderSourceTurnId}`, sessionId, olderSourceTurnId, olderSourceRootId, `turn:${olderSourceTurnId}:event:turn-started`,
      JSON.stringify({ goal: objective, taskId: olderSourceRootId, rootTaskId: olderSourceRootId }), `history-page-terminal-${olderSourceTurnId}`,
      `turn:${olderSourceTurnId}:event:turn-failed:task_failed`, JSON.stringify({ turnId: olderSourceTurnId, taskId: olderSourceRootId, errorCode: "task_failed", finalItemId: null })])
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
      "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6,
        CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 3, CURRENT_TIMESTAMP)`,
    [currentTurnId, sessionId, userId, JSON.stringify({ goal: objective, successCriteria: criteria }), currentRootId, workerId])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, $1, NULL, '/current', 0, 'orchestrator', 'root', 'running', $4, '[]'::jsonb, $5::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 3, $6, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
    [currentRootId, sessionId, currentTurnId, objective, JSON.stringify(criteria), workerId])
    await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [currentStepId, sessionId, currentTurnId, currentRootId])
    await pool.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload", "createdAt")
      VALUES ($1, $2, $3, NULL, $4, 100, 'turn.started', 'orchestrator', $3, $5, $6::jsonb, CURRENT_TIMESTAMP)`,
    [`history-page-current-start-${currentTurnId}`, sessionId, currentTurnId, currentRootId, `turn:${currentTurnId}:event:turn-started`,
      JSON.stringify({ goal: objective, taskId: currentRootId, rootTaskId: currentRootId })])
  }, 30_000)

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [userId]).catch(() => undefined)
      await pool.end()
    }
  })

  it("reselects a prior same-session typed Scout, pages canonical IDs, and invalidates a changed graph token", async () => {
    const store = createPgRootTaskHistoryResultPageStore(pool!)
    const first = await store.read(scope, { offset: 0 })
    expect(first).toMatchObject({ schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, availability: "available",
      trust: "untrusted", observation: "historical_discovery", verificationStatus: "unverified", sourceResultStatus: "completed",
      totalCount: 5, offset: 0, nextOffset: 3, items: candidateIds.slice(0, 3).map(jobId => ({ jobId })) })
    if (first.availability !== "available") throw new Error("expected an available historical discovery page")
    const next = await store.read(scope, { offset: 3, sourceToken: first.sourceToken })
    expect(next).toMatchObject({ availability: "available", offset: 3, nextOffset: null,
      items: candidateIds.slice(3).map(jobId => ({ jobId })) })

    await pool!.query(`UPDATE "agent_items" SET "revision" = 2 WHERE "id" = $1`, [taskGraphItemId(sourceRootId)])
    const changed = await store.read(scope, { offset: 3, sourceToken: first.sourceToken })
    expect(changed).toEqual({ schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted",
      availability: "unavailable", observation: "historical_discovery", verificationStatus: "unverified", reason: "source_changed" })
  })

  it("returns only current-session and current-user IDs when foreign history otherwise matches", async () => {
    await seedForeignMatchingSource(pool!)
    try {
      const page = await createPgRootTaskHistoryResultPageStore(pool!).read(scope, { offset: 0 })

      expect(page).toMatchObject({ availability: "available", totalCount: candidateIds.length,
        items: candidateIds.slice(0, 3).map(jobId => ({ jobId })) })
      if (page.availability === "available") {
        expect(page.items.map(item => item.jobId)).not.toContain(`c${String(99).padStart(24, "0")}`)
      }
    } finally {
      await pool!.query(`DELETE FROM "User" WHERE "id" = $1`, [foreignUserId])
    }
  })

  it("skips a newest terminal source with empty Scout results and selects the older valid root", async () => {
    const emptyResult = structuredScoutResult([]), emptyReport = verificationReport(emptyResult)
    const store = createPgRootTaskHistoryResultPageStore(pool!)
    await pool!.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb WHERE "id" = ANY($1::text[])`,
      [[sourceScoutId, sourceScoutAId], JSON.stringify(workerResult(emptyResult, emptyReport))])

    const page = await store.read(scope, { offset: 0 })

    expect(page).toMatchObject({ availability: "available", totalCount: olderCandidateIds.length,
      items: olderCandidateIds.map(jobId => ({ jobId })) })
    await pool!.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb WHERE "id" = $1`, [sourceScoutId, JSON.stringify(workerResult(newerResult, newerReport))])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb WHERE "id" = $1`, [sourceScoutAId, JSON.stringify(workerResult())])
  })

  it("rejects a changed terminal receipt and invalidates the prior source token", async () => {
    const store = createPgRootTaskHistoryResultPageStore(pool!)
    const first = await store.read(scope, { offset: 0 })
    if (first.availability !== "available") throw new Error("expected an available historical discovery page")
    await pool!.query(`UPDATE "agent_events" SET "payload" = $2::jsonb WHERE "id" = $1`,
      [`history-page-terminal-${sourceTurnId}`, JSON.stringify({ turnId: sourceTurnId, taskId: sourceRootId, errorCode: "altered", finalItemId: null })])

    const changed = await store.read(scope, { offset: 3, sourceToken: first.sourceToken })

    expect(changed).toEqual({ schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted",
      availability: "unavailable", observation: "historical_discovery", verificationStatus: "unverified", reason: "source_changed" })
    await pool!.query(`UPDATE "agent_events" SET "payload" = $2::jsonb WHERE "id" = $1`,
      [`history-page-terminal-${sourceTurnId}`, JSON.stringify({ turnId: sourceTurnId, taskId: sourceRootId, errorCode: "task_failed", finalItemId: null })])
  })

  it("excludes every prior Scout carrying persisted private selection context", async () => {
    const scoutIds = [sourceScoutId, sourceScoutAId, olderSourceScoutId]
    await pool!.query(`UPDATE "sub_agent_tasks" SET "context" = '{"selectedJobPreparation":{}}'::jsonb WHERE "id" = ANY($1::text[])`, [scoutIds])
    const page = await createPgRootTaskHistoryResultPageStore(pool!).read(scope, { offset: 0 })
    expect(page).toEqual({ schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted",
      availability: "unavailable", observation: "historical_discovery", verificationStatus: "unverified", reason: "no_source" })
    await pool!.query(`UPDATE "sub_agent_tasks" SET "context" = '{}'::jsonb WHERE "id" = ANY($1::text[])`, [scoutIds])
  })
})
