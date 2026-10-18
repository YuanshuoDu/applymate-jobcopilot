import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool } from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT } from "../subagents/task-graph-result-page-contract.js"
import { TASK_GRAPH_TEMPLATES } from "../subagents/task-graph-templates.js"
import { taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey, TASK_GRAPH_SNAPSHOT_VERSION } from "../subagents/task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { createPgRootTaskHistoryResultPageStore } from "./root-task-history-result-page-store.js"
import type { TaskGraphReadScope } from "../subagents/task-graph-command-port.js"

const DATABASE_NAME = "applymate_agent_brain_ci", objective = "Plan an engineering search"
const criteria = ["Keep the search within the saved locations"]
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true", value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Historical Scout pages need the disposable PostgreSQL CI service")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}` || url.search || url.hash) {
    throw new Error("Historical Scout pages require the dedicated disposable PostgreSQL URL")
  }
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip, suffix = randomUUID()
const userId = `historical-scout-user-${suffix}`, sessionId = `historical-scout-session-${suffix}`
const currentTurnId = `historical-scout-current-turn-${suffix}`, currentRootId = `historical-scout-current-root-${suffix}`
const currentStepId = `historical-scout-current-step-${suffix}`, nextStepId = `historical-scout-next-step-${suffix}`
const workerId = `historical-scout-worker-${suffix}`
const sourceA = { turnId: `historical-scout-empty-turn-${suffix}`, rootId: `historical-scout-empty-root-${suffix}`, childId: `historical-scout-empty-child-${suffix}`, extraChildId: `historical-scout-empty-analyst-${suffix}`, start: 21, terminal: 30 }
const sourceB = { turnId: `historical-scout-valid-turn-${suffix}`, rootId: `historical-scout-valid-root-${suffix}`, childId: `historical-scout-valid-child-${suffix}`, extraChildId: `historical-scout-valid-analyst-${suffix}`, start: 1, terminal: 20 }
const jobIds = Array.from({ length: 5 }, (_, index) => `c${String(index + 1).padStart(24, "0")}`)
let pool: Pool | undefined

function scoutResultEnvelope(turnId: string, candidates: readonly string[]) {
  const evidence = candidates.map(jobId => ({ id: `e-${jobId}`, kind: "job", ref: jobId, source: "greenhouse" }))
  return { finalItemId: `result-${turnId}`, finalText: "private Scout prose", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", summary: "private summary",
      candidates: candidates.map(jobId => ({ jobId, source: "greenhouse", url: "https://private.invalid", evidenceIds: [`e-${jobId}`] })), evidence } }
}

function eventPayloadItem(input: { itemId: string; sourceTurnId: string; rootId: string; stepId: string; revision: number; content: unknown }) {
  const now = new Date("2020-01-01T00:00:00.000Z").toISOString()
  return { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: input.itemId, sessionId, turnId: input.sourceTurnId,
    stepId: input.stepId, taskId: input.rootId, type: "task_graph", status: "streaming", phase: null,
    revision: input.revision, content: input.content, startedAt: now, completedAt: null, createdAt: now, updatedAt: now }
}

async function insertEvent(input: { id: string; turnId: string; taskId: string; itemId: string | null; sequence: number;
  type: string; actor: string; correlationId: string; idempotencyKey: string; payload: unknown }) {
  await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload", "createdAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, CURRENT_TIMESTAMP)`,
  [input.id, sessionId, input.turnId, input.itemId, input.taskId, input.sequence, input.type, input.actor,
    input.correlationId, input.idempotencyKey, JSON.stringify(input.payload)])
}

async function insertPriorSource(source: typeof sourceA, candidates: readonly string[]): Promise<void> {
  const stepId = `step-${source.turnId}`, graphId = taskGraphItemId(source.rootId), nodeKey = "ordinary-scout"
  const analystNodeKey = "legacy-analyst"
  const registeredScoutEnvelope = { role: TASK_GRAPH_TEMPLATES.scout.role, taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
    expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions] }
  const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{ key: nodeKey, templateId: "scout", goal: "Find relevant jobs",
    successCriteria: ["Find jobs for this search"], dependsOn: [], depth: 1, taskId: source.childId, verificationDisposition: "typed",
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] }, registeredScoutEnvelope },
    { key: analystNodeKey, templateId: "analyst", goal: "Review candidates", successCriteria: ["Keep a safe fallback"],
      dependsOn: [nodeKey], depth: 2, taskId: source.extraChildId, verificationDisposition: "legacy_unverified" }] }
  const result = scoutResultEnvelope(source.turnId, candidates)
  await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'completed', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
  [source.turnId, sessionId, userId, JSON.stringify({ goal: objective, successCriteria: criteria }), source.rootId])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $1, NULL, '/historical-root', 0, 'orchestrator', 'root', 'completed', $4, '[]'::jsonb, $5::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, NULL, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [source.rootId, sessionId, source.turnId, objective, JSON.stringify(criteria)])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, '/historical-root/scout', 1, 'scout', 'job_discovery', 'completed', 'Find relevant jobs', '[]'::jsonb, '["Find jobs for this search"]'::jsonb, $5::jsonb, '{}'::jsonb, $6::jsonb, $7::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [source.childId, sessionId, source.turnId, source.rootId, JSON.stringify(registeredScoutEnvelope.allowedActions),
    JSON.stringify(registeredScoutEnvelope.expectedOutputSchema), JSON.stringify(result)])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, '/historical-root/analyst', 2, 'analyst', 'job_analysis', 'completed', 'Review candidates', '[]'::jsonb, '["Keep a safe fallback"]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [source.extraChildId, sessionId, source.turnId, source.rootId])
  await pool!.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`, [stepId, sessionId, source.turnId, source.rootId])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'task_graph', 'completed', 5, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ($7, $2, $3, $4, $5, 'agent_message', 'completed', 0, '{"text":"done"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [graphId, sessionId, source.turnId, stepId, source.rootId, JSON.stringify(snapshot), result.finalItemId])
  const proposalItem = eventPayloadItem({ itemId: graphId, sourceTurnId: source.turnId, rootId: source.rootId, stepId, revision: 1, content: snapshot })
  await insertEvent({ id: `plan-${source.turnId}`, turnId: source.turnId, taskId: source.rootId, itemId: graphId, sequence: source.start + 1,
    type: "item.started", actor: "orchestrator", correlationId: stepId, idempotencyKey: taskGraphProposalKey(source.rootId, 0),
    payload: { kind: "proposal", fingerprint: "a".repeat(64), revision: 1, item: proposalItem,
      receipt: { status: "accepted", revision: 1,
        nodes: [{ key: nodeKey, taskId: source.childId, status: "queued" }, { key: analystNodeKey, taskId: source.extraChildId, status: "queued" }],
        readyTaskIds: [source.childId, source.extraChildId] } } })
  const lifecycleEvents = [
    { nodeKey, type: "task.started" }, { nodeKey, type: "task.completed" },
    { nodeKey: analystNodeKey, type: "task.started" }, { nodeKey: analystNodeKey, type: "task.completed" },
  ] as const
  for (const [offset, { nodeKey: lifecycleNode, type }] of lifecycleEvents.entries()) {
    const revision = offset + 2, expectedRevision = revision - 1
    const event = { nodeKey: lifecycleNode, type, idempotencyKey: taskGraphLifecycleKey(source.rootId, lifecycleNode, 1, type), expectedRevision }
    const item = eventPayloadItem({ itemId: graphId, sourceTurnId: source.turnId, rootId: source.rootId, stepId, revision, content: snapshot })
    await insertEvent({ id: `${type}-${lifecycleNode}-${source.turnId}`, turnId: source.turnId, taskId: source.rootId, itemId: graphId,
      sequence: source.start + revision, type: "task_graph.lifecycle", actor: "system", correlationId: stepId, idempotencyKey: event.idempotencyKey,
      payload: { kind: "lifecycle", event, revision, item } })
  }
  await insertEvent({ id: `start-${source.turnId}`, turnId: source.turnId, taskId: source.rootId, itemId: null, sequence: source.start,
    type: "turn.started", actor: "orchestrator", correlationId: source.turnId, idempotencyKey: `turn:${source.turnId}:event:turn-started`,
    payload: { taskId: source.rootId, rootTaskId: source.rootId } })
  await insertEvent({ id: `step-done-${source.turnId}`, turnId: source.turnId, taskId: source.rootId, itemId: null, sequence: source.terminal - 1,
    type: "step.completed", actor: "orchestrator", correlationId: stepId, idempotencyKey: `turn:${source.turnId}:event:step-completed:${stepId}`,
    payload: { stepId, status: "completed", taskId: source.rootId } })
  await insertEvent({ id: `terminal-${source.turnId}`, turnId: source.turnId, taskId: source.rootId, itemId: result.finalItemId, sequence: source.terminal,
    type: "turn.completed", actor: "orchestrator", correlationId: stepId, idempotencyKey: `turn:${source.turnId}:event:turn-completed`,
    payload: { turnId: source.turnId, taskId: source.rootId, finalItemId: result.finalItemId } })
}

describePg("historical Scout page PostgreSQL read", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 2 })
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [userId, `${userId}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "eventSequence", "updatedAt") VALUES ($1, $2, $3, 'running', 'test', 2000, CURRENT_TIMESTAMP)`, [sessionId, userId, objective])
    await pool.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
      VALUES ($1, $2, $3, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, $6, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
    [currentTurnId, sessionId, userId, JSON.stringify({ goal: objective, successCriteria: criteria }), currentRootId, workerId])
    await pool.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal", "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
      VALUES ($1, $2, $3, $1, NULL, '/current-root', 0, 'orchestrator', 'root', 'running', $4, '[]'::jsonb, $5::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 2, 3, $6, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
    [currentRootId, sessionId, currentTurnId, objective, JSON.stringify(criteria), workerId])
    for (const [index, stepId] of [currentStepId, nextStepId].entries()) await pool.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, $5, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [stepId, sessionId, currentTurnId, currentRootId, index + 1])
    await insertEvent({ id: `current-start-${suffix}`, turnId: currentTurnId, taskId: currentRootId, itemId: null, sequence: 1000,
      type: "turn.started", actor: "orchestrator", correlationId: currentTurnId, idempotencyKey: `turn:${currentTurnId}:event:turn-started`,
      payload: { taskId: currentRootId, rootTaskId: currentRootId } })
    await insertPriorSource(sourceA, [])
    await insertPriorSource(sourceB, jobIds)
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [userId]).catch(() => undefined)
      await pool.end()
    }
  })

  it("selects an older nonempty same-objective source and keeps its token across fresh live Steps", async () => {
    const store = createPgRootTaskHistoryResultPageStore(pool!)
    const scope: TaskGraphReadScope & Readonly<{ stepId: string }> = { userId, sessionId, turnId: currentTurnId,
      rootTaskId: currentRootId, parentTaskId: currentRootId, stepId: currentStepId, turnLeaseOwner: workerId,
      turnLeaseVersion: 1, parentLeaseOwner: workerId, parentAttemptCount: 2 }
    const first = await store.read(scope, { mode: "historical_discovery", offset: 0 })
    expect(first).toMatchObject({ availability: "available", observation: "historical_discovery", verificationStatus: "unverified",
      sourceResultStatus: "completed", totalCount: 5, truncated: false, offset: 0, nextOffset: 3,
      items: jobIds.slice(0, 3).map(jobId => ({ jobId })) })
    if (first.availability !== "available") throw new Error("historical_page_unavailable")
    const second = await store.read({ ...scope, stepId: nextStepId }, { mode: "historical_discovery", offset: 3, sourceToken: first.sourceToken })
    expect(second).toMatchObject({ availability: "available", sourceToken: first.sourceToken, offset: 3, nextOffset: null,
      totalCount: 5, items: jobIds.slice(3).map(jobId => ({ jobId })) })
    expect(JSON.stringify(first)).not.toMatch(/historical-scout-valid-root|historical-scout-valid-turn|private|greenhouse|https:/)
  })

  it("rejects changed candidate IDs and out-of-range offsets without exposing old source identity", async () => {
    const store = createPgRootTaskHistoryResultPageStore(pool!)
    const scope: TaskGraphReadScope & Readonly<{ stepId: string }> = { userId, sessionId, turnId: currentTurnId,
      rootTaskId: currentRootId, parentTaskId: currentRootId, stepId: currentStepId, turnLeaseOwner: workerId,
      turnLeaseVersion: 1, parentLeaseOwner: workerId, parentAttemptCount: 2 }
    const first = await store.read(scope, { mode: "historical_discovery", offset: 0 })
    if (first.availability !== "available") throw new Error("historical_page_unavailable")
    const oversized = { finalText: "x".repeat(TASK_GRAPH_RESULT_SOURCE_BYTE_LIMIT + 1) }
    await pool!.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb WHERE "id" = $1`,
      [sourceB.extraChildId, JSON.stringify(oversized)])
    await expect(store.read(scope, { mode: "historical_discovery", offset: 0 })).resolves.toMatchObject({
      availability: "unavailable", reason: "no_source",
    })
    await pool!.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb WHERE "id" = $1`,
      [sourceB.extraChildId, JSON.stringify({})])
    await pool!.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb WHERE "id" = $1`,
      [sourceB.childId, JSON.stringify(scoutResultEnvelope(sourceB.turnId, [`c${"z".repeat(24)}`, ...jobIds.slice(1)]))])
    await expect(store.read(scope, { mode: "historical_discovery", offset: 3, sourceToken: first.sourceToken })).resolves.toMatchObject({
      availability: "unavailable", reason: "source_changed",
    })
    await pool!.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb WHERE "id" = $1`,
      [sourceB.childId, JSON.stringify(scoutResultEnvelope(sourceB.turnId, jobIds))])
    await expect(store.read(scope, { mode: "historical_discovery", offset: 6, sourceToken: first.sourceToken })).resolves.toMatchObject({
      availability: "unavailable", reason: "offset_out_of_range",
    })
  })

  it("rejects a divergent parent scope and a current root row owned by another worker", async () => {
    const store = createPgRootTaskHistoryResultPageStore(pool!)
    const scope: TaskGraphReadScope & Readonly<{ stepId: string }> = { userId, sessionId, turnId: currentTurnId,
      rootTaskId: currentRootId, parentTaskId: currentRootId, stepId: currentStepId, turnLeaseOwner: workerId,
      turnLeaseVersion: 1, parentLeaseOwner: workerId, parentAttemptCount: 2 }
    await expect(store.read({ ...scope, parentLeaseOwner: `${workerId}-other` }, { mode: "historical_discovery", offset: 0 }))
      .resolves.toMatchObject({ availability: "unavailable", reason: "no_source" })
    await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $2 WHERE "id" = $1`, [currentRootId, `${workerId}-other`])
    try {
      await expect(store.read(scope, { mode: "historical_discovery", offset: 0 }))
        .rejects.toMatchObject({ name: "Error", message: "task_graph_parent_fenced" })
    } finally {
      await pool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $2 WHERE "id" = $1`, [currentRootId, workerId])
    }
  })
})
