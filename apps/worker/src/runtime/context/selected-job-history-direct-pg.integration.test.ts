import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool } from "pg"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId,
  taskGraphFingerprint, taskGraphLifecycleKey, taskGraphProposalKey, taskGraphState } from "../subagents/task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION, taskGraphResultDigest, verifyTaskGraphNodeEvidence } from "../subagents/task-graph-pg-verification.js"
import { prepareTaskGraphFinish } from "../subagents/pg-store-lifecycle.js"
import { persistGraphTransition } from "../subagents/task-graph-pg-lifecycle.js"
import { loadTaskGraph } from "../subagents/task-graph-pg-state.js"
import { appendTaskGraphReceiptWithIdentity, writePlanReceiptWithIdentity } from "../subagents/task-graph-pg-events.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import { createPgDirectSelectedJobHistoryStore, type DirectSelectedJobHistoryLoadInput } from "./selected-job-history-direct-store.js"
import { projectSelectedJobHistoryOutcomes } from "./selected-job-history.js"
import { checkTaskGraphTerminalVerification } from "../turns/turn-execution-completion-gate.js"
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

type Source = Readonly<{ turnId: string; rootTaskId: string; childId: string; finalItemId: string; sessionId: string; userId: string; jobId: string; startSequence: number; stepId?: string; status?: "completed" | "failed" | "interrupted"; verification?: TaskGraphVerificationContract; unresolvedRepair?: boolean }>
const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip, suffix = randomUUID()
const userId = `direct-history-user-${suffix}`, otherUserId = `direct-history-other-user-${suffix}`
const sessionId = `direct-history-session-${suffix}`, otherSessionId = `direct-history-other-session-${suffix}`
const foreignSessionId = `direct-history-foreign-session-${suffix}`, jobId = `job-${suffix}`, otherJobId = `other-job-${suffix}`
const currentTurnId = `direct-history-current-turn-${suffix}`, currentRootTaskId = `direct-history-current-root-${suffix}`
const currentStepId = `direct-history-current-step-${suffix}`, workerId = `worker-${suffix}`
let unresolvedRepairTerminalSequence = 0n
const unresolvedRepairStructuredResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [
    { jobId, source: "greenhouse", url: null, evidenceIds: [`read:job:${jobId}`] },
    { jobId: `repair-secondary-${suffix}`, source: "lever", url: null, evidenceIds: [`read:job:repair-secondary-${suffix}`] },
  ],
  evidence: [
    { id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "greenhouse" },
    { id: `read:job:repair-secondary-${suffix}`, kind: "job", ref: `repair-secondary-${suffix}`, source: "lever" },
  ],
  summary: "Found two candidate roles",
}
const unresolvedRepairAttemptVerification: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }],
}
const matchingSources: Source[] = Array.from({ length: 10 }, (_, index) => ({
  turnId: `direct-history-source-turn-${index}-${suffix}`, rootTaskId: `direct-history-source-root-${index}-${suffix}`,
  childId: `direct-history-source-child-${index}-${suffix}`, finalItemId: `direct-history-source-final-${index}-${suffix}`,
  sessionId, userId, jobId, stepId: `direct-history-source-step-${index}-${suffix}`, startSequence: index * 3 + 1,
}))
const otherJobSource: Source = { turnId: `direct-history-other-job-turn-${suffix}`, rootTaskId: `direct-history-other-job-root-${suffix}`,
  childId: `direct-history-other-job-child-${suffix}`, finalItemId: `direct-history-other-job-final-${suffix}`,
  sessionId, userId, jobId: otherJobId, stepId: `direct-history-other-job-step-${suffix}`, startSequence: 37 }
const failedSource: Source = { turnId: `direct-history-failed-turn-${suffix}`, rootTaskId: `direct-history-failed-root-${suffix}`,
  childId: `direct-history-failed-child-${suffix}`, finalItemId: `direct-history-failed-final-${suffix}`,
  sessionId, userId, jobId, startSequence: 31, status: "failed", verification: {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
    criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } }],
  } }
const interruptedSource: Source = { turnId: `direct-history-interrupted-turn-${suffix}`, rootTaskId: `direct-history-interrupted-root-${suffix}`,
  childId: `direct-history-interrupted-child-${suffix}`, finalItemId: `direct-history-interrupted-final-${suffix}`,
  sessionId, userId, jobId, startSequence: 33, status: "interrupted" }
const unresolvedRepairSource: Source = { turnId: `direct-history-repair-turn-${suffix}`, rootTaskId: `direct-history-repair-root-${suffix}`,
  childId: `direct-history-repair-target-${suffix}`, finalItemId: `direct-history-repair-final-${suffix}`,
  sessionId, userId, jobId, startSequence: 35, status: "failed", unresolvedRepair: true, verification: {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
    criteria: [
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
      { id: "evidence-count", check: { kind: "evidence_count_gte", minimum: 3 } },
    ],
  } }
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

async function insertStartEvent(source: Source, sequence = source.startSequence): Promise<void> {
  await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, NULL, $4, $5, 'turn.started', 'orchestrator', $3, $6, $7::jsonb)`,
  [`direct-history-start-${source.turnId}`, source.sessionId, source.turnId, source.rootTaskId, sequence,
    `turn:${source.turnId}:event:turn-started`, JSON.stringify({ taskId: source.rootTaskId, rootTaskId: source.rootTaskId })])
}

async function insertStepCompletedEvent(source: Source): Promise<void> {
  if (!source.stepId) throw new Error("Completed source Step ID is missing")
  await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, NULL, $4, $5, 'step.completed', 'orchestrator', $6, $7, $8::jsonb)`,
  [`direct-history-step-completed-${source.turnId}`, source.sessionId, source.turnId, source.rootTaskId, source.startSequence + 1,
    source.stepId, `turn:${source.turnId}:event:step-completed:${source.stepId}`,
    JSON.stringify({ stepId: source.stepId, status: "completed", taskId: source.rootTaskId })])
}

async function insertSource(source: Source): Promise<void> {
  const status = source.status ?? "completed"
  const persistedTurnStatus = source.unresolvedRepair ? "in_progress" : status
  const persistedRootStatus = source.unresolvedRepair ? "running" : status
  if (source.unresolvedRepair && !source.verification) throw new Error("unresolved repair source needs its typed verification contract")
  const repairChildId = `${source.childId}-repair`
  const nodes = source.unresolvedRepair ? [
    { key: "repair-target", templateId: "scout", goal: "Find a suitable role", successCriteria: ["Find one role"], dependsOn: [], depth: 1,
      taskId: source.childId, verificationDisposition: "typed", verification: source.verification! },
    { key: "repair-attempt", templateId: "scout", goal: "Find a suitable role", successCriteria: ["Find one role"], dependsOn: [], depth: 1,
      taskId: repairChildId, verificationDisposition: "typed", verification: unresolvedRepairAttemptVerification, repairOf: {
        graphRootTaskId: source.rootTaskId, nodeKey: "repair-target", taskId: source.childId, criterionIds: ["candidate-count"],
      } },
  ] : [{ key: "scout", templateId: "scout", goal: "Find a suitable role", successCriteria: ["Find one role"], dependsOn: [], depth: 1, taskId: source.childId,
    ...(source.verification ? { verificationDisposition: "typed", verification: source.verification } : {}) }]
  const input = JSON.stringify({ selectedJobPreparation: { jobId: source.jobId } })
  const graph = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes })
  await pool!.query(`INSERT INTO "agent_turns" ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot",
    "toolPolicySnapshot", "budgetSnapshot", "rootTaskId", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, $6, 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, $5, NULL, NULL, NULL, 1, CURRENT_TIMESTAMP)`,
  [source.turnId, source.sessionId, source.userId, input, source.rootTaskId, persistedTurnStatus])
  await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
    "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "completedAt", "updatedAt")
    VALUES ($1, $2, $3, $1, NULL, '/source', 0, 'orchestrator', 'root', $4, 'Find a role', '[]'::jsonb, '[]'::jsonb, '[]'::jsonb,
      '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 3,
      CASE WHEN $4 = 'running' THEN NULL ELSE CURRENT_TIMESTAMP END, CURRENT_TIMESTAMP)`,
  [source.rootTaskId, source.sessionId, source.turnId, persistedRootStatus])
  const childRows = source.unresolvedRepair ? [
    { id: source.childId, path: "/source/scout-target", status: "running", failureReason: null, result: null },
    { id: repairChildId, path: "/source/scout-repair", status: "running", failureReason: null, result: null },
  ] : [{ id: source.childId, path: "/source/scout", status: source.verification ? "running" : "completed", failureReason: null, result: null }]
  for (const child of childRows) {
    await pool!.query(`INSERT INTO "sub_agent_tasks" ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
      "attemptCount", "maxAttempts", "completedAt", "failureReason", "result", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, $5, 1, 'scout', 'scout', $6, 'Find a suitable role', '[]'::jsonb, '["Find one role"]'::jsonb,
        '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 1,
        CASE WHEN $6 = 'running' THEN NULL ELSE CURRENT_TIMESTAMP END, $7, $8::jsonb, CURRENT_TIMESTAMP)`,
    [child.id, source.sessionId, source.turnId, source.rootTaskId, child.path, child.status, child.failureReason,
      child.result ? JSON.stringify(child.result) : null])
  }
  if (status === "completed") {
    if (!source.stepId) throw new Error("Completed history source needs its canonical Step ID")
    await pool!.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 1, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`,
    [source.stepId, source.sessionId, source.turnId, source.rootTaskId])
  }
  if (source.unresolvedRepair) {
    await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 'agent_message', 'completed', 0, '{"text":"Repair attempt fixture"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [source.finalItemId, source.sessionId, source.turnId, source.rootTaskId])
  } else {
    await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
        ($6, $2, $3, $4, 'agent_message', 'completed', 0, '{"text":"done"}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [taskGraphItemId(source.rootTaskId), source.sessionId, source.turnId, source.rootTaskId, JSON.stringify(graph), source.finalItemId])
  }
  const start = source.startSequence, terminal = start + (status === "completed" ? 2 : 1)
  const terminalType = status === "completed" ? "turn.completed" : status === "failed" ? "turn.failed" : "turn.interrupted"
  const terminalItemId = status === "completed" ? source.finalItemId : null
  const correlationId = status === "completed" ? source.stepId : source.turnId
  const errorCode = status === "failed" ? "task_failed" : status === "interrupted" ? "interrupted" : undefined
  const terminalKey = status === "completed" ? `turn:${source.turnId}:event:turn-completed`
    : status === "failed" ? `turn:${source.turnId}:event:turn-failed:${errorCode}` : `turn:${source.turnId}:event:turn-interrupted`
  const terminalPayload = status === "completed" ? { turnId: source.turnId, taskId: source.rootTaskId, finalItemId: source.finalItemId }
    : status === "failed" ? { turnId: source.turnId, taskId: source.rootTaskId, errorCode, finalItemId: null }
      : { turnId: source.turnId, taskId: source.rootTaskId, errorCode }
  if (source.unresolvedRepair) {
    await insertStartEvent(source)
  } else {
    await pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
      VALUES ($1, $2, $3, NULL, $4, $5, 'turn.started', 'orchestrator', $3, $6, $7::jsonb),
        ($8, $2, $3, $9, $4, $10, $11, 'orchestrator', $12, $13, $14::jsonb)`,
    [`direct-history-start-${source.turnId}`, source.sessionId, source.turnId, source.rootTaskId, start,
      `turn:${source.turnId}:event:turn-started`, JSON.stringify({ taskId: source.rootTaskId, rootTaskId: source.rootTaskId }),
      `direct-history-terminal-${source.turnId}`, terminalItemId, terminal, terminalType, correlationId, terminalKey,
      JSON.stringify(terminalPayload)])
  }
  if (status === "completed") {
    await insertStepCompletedEvent(source)
  }
  if (source.verification && !source.unresolvedRepair) await persistUnverifiedVerificationReport(source, graph)
}

async function materializeUnresolvedRepairSource(): Promise<void> {
  const source = unresolvedRepairSource, repairTaskId = `${source.childId}-repair`
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
    { key: "repair-target", templateId: "scout", goal: "Find a suitable role", successCriteria: ["Find one role"], dependsOn: [], depth: 1,
      taskId: source.childId, verificationDisposition: "typed", verification: source.verification! },
    { key: "repair-attempt", templateId: "scout", goal: "Find a suitable role", successCriteria: ["Find one role"], dependsOn: [], depth: 1,
      taskId: repairTaskId, verificationDisposition: "typed", verification: unresolvedRepairAttemptVerification, repairOf: {
        graphRootTaskId: source.rootTaskId, nodeKey: "repair-target", taskId: source.childId, criterionIds: ["candidate-count"],
      } },
  ] })
  const scope = { userId: source.userId, sessionId: source.sessionId, turnId: source.turnId,
    rootTaskId: source.rootTaskId, parentTaskId: source.rootTaskId }
  const client = await pool!.connect()
  try {
    await client.query("BEGIN")
    await client.query(`UPDATE "agent_sessions" SET "eventSequence" = 39 WHERE "id" = $1 AND "userId" = $2`, [sessionId, userId])
    const state = taskGraphState(snapshot, 1, new Map(snapshot.nodes.map(node => [node.taskId, { status: "queued" as const, failureReason: null }] as const)), [])
    const planIdentity = await writePlanReceiptWithIdentity(client, { scope, state, snapshot, expectedRevision: 0, now: new Date(),
      idempotencyKey: taskGraphProposalKey(scope.parentTaskId, 0), fingerprint: taskGraphFingerprint(snapshot),
      receipt: { status: "accepted", revision: 1,
        nodes: snapshot.nodes.map(node => ({ key: node.key, taskId: node.taskId, status: "queued" as const })),
        readyTaskIds: snapshot.nodes.map(node => node.taskId) } })

    const output = { jobs: [{ id: jobId, source: "greenhouse" }, { id: `repair-secondary-${suffix}`, source: "lever" }] }
    const insertSearchReceipt = async (taskId: string, label: string, ordinal: number, startedSequence: number): Promise<void> => {
      const stepId = `direct-history-${label}-step-${suffix}`, callId = `direct-history-${label}-call-${suffix}`
      const callItemId = `direct-history-${label}-call-item-${suffix}`, resultItemId = `direct-history-${label}-result-item-${suffix}`
      await client.query(`INSERT INTO "agent_steps" ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
        VALUES ($1, $2, $3, $4, $5, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`, [stepId, sessionId, source.turnId, taskId, ordinal])
      await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "completedAt", "updatedAt")
        VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
          ($7, $2, $3, $4, $5, 'tool_result', 'completed', 1, $8::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [callItemId, sessionId, source.turnId, stepId, taskId,
        JSON.stringify({ toolCallId: callId, toolName: "jobs.search", toolVersion: "1", input: {}, status: "completed", errorCode: null }),
        resultItemId, JSON.stringify({ toolCallId: callId, output, errorCode: null })])
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, $4, $5, $6, 'tool_call.started', 'orchestrator', $7, $8, $9::jsonb),
          ($10, $2, $3, $4, $5, $11, 'tool_call.completed', 'orchestrator', $7, $12, $13::jsonb)`,
      [`direct-history-${label}-call-started-${suffix}`, sessionId, source.turnId, callItemId, taskId, startedSequence, callId,
        `direct-history-${label}:${callId}:started`, JSON.stringify({ taskId, toolCallId: callId, toolName: "jobs.search" }),
        `direct-history-${label}-call-completed-${suffix}`, startedSequence + 1, `direct-history-${label}:${callId}:completed`,
        JSON.stringify({ taskId, toolCallId: callId, toolName: "jobs.search", status: "completed", errorCode: null })])
    }
    await insertSearchReceipt(source.childId, "repair-target", 0, 41)
    await insertSearchReceipt(repairTaskId, "repair-attempt", 1, 43)
    await client.query(`UPDATE "agent_sessions" SET "eventSequence" = 44 WHERE "id" = $1 AND "userId" = $2`, [sessionId, userId])

    const initial = await loadTaskGraph(client, scope, true)
    if (!initial.snapshot || !initial.item || !initial.state) throw new Error("unresolved repair graph was not loaded")
    const targetNode = initial.snapshot.nodes.find(node => node.taskId === source.childId)
    if (!targetNode) throw new Error("unresolved repair target node was not loaded")
    const targetVerification = await verifyTaskGraphNodeEvidence(client, { scope: { ...scope, taskId: source.childId, attemptCount: 1 },
      snapshot: initial.snapshot, node: targetNode, structuredResult: unresolvedRepairStructuredResult })
    expect(targetVerification.verified).toBe(false)
    expect(targetVerification.report).toMatchObject({ status: "failed", reasonCode: "criterion_not_met",
      criteria: [
        { criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" },
        { criterionId: "evidence-count", status: "failed", reasonCode: "criterion_not_met" },
      ] })
    expect(targetVerification.report.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(targetVerification.report.resultDigest).toBe(taskGraphResultDigest(unresolvedRepairStructuredResult))
    const targetFinish = await prepareTaskGraphFinish(client, { taskId: source.childId, sessionId, attemptCount: 1,
      status: "completed", retry: false, result: { structuredResult: unresolvedRepairStructuredResult },
      ownerId: workerId, taskRole: "scout", taskType: "scout" })
    expect(targetFinish.status).toBe("failed")
    expect(targetFinish.failureReason).toBe("task_graph_verification_failed")
    if (!targetFinish.graph || "blocked" in targetFinish.graph) throw new Error("repair target finish did not prepare a lifecycle transition")
    const updatedTarget = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $6, "failureReason" = $7, "result" = $8::jsonb,
      "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
        AND "status" = 'running' AND "attemptCount" = $5`,
    [source.childId, sessionId, source.turnId, source.rootTaskId, 1, targetFinish.status, targetFinish.failureReason, JSON.stringify(targetFinish.result)])
    if (updatedTarget.rowCount !== 1) throw new Error("repair target fixture lost its running attempt fence")
    await persistGraphTransition(client, targetFinish.graph, new Date())

    const loaded = await loadTaskGraph(client, scope, true)
    if (!loaded.snapshot || !loaded.item || !loaded.state) throw new Error("unresolved repair graph was not loaded after target failure")
    const repairNode = loaded.snapshot.nodes.find(node => node.taskId === repairTaskId)
    if (!repairNode) throw new Error("unresolved repair node was not loaded")
    const verification = await verifyTaskGraphNodeEvidence(client, { scope: { ...scope, taskId: repairTaskId, attemptCount: 1 },
      snapshot: loaded.snapshot, node: repairNode, structuredResult: unresolvedRepairStructuredResult })
    expect(verification.verified).toBe(true)
    expect(verification.report).toMatchObject({ status: "passed", criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }] })
    expect(verification.report.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)

    const targetBefore = await client.query(`SELECT "id", "status", "failureReason", "result" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4`,
    [source.childId, sessionId, source.turnId, source.rootTaskId])
    const planBefore = await client.query(`SELECT "id", "sequence", "taskId", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [planIdentity.id, sessionId, source.turnId])
    const graphBefore = await client.query(`SELECT "revision", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2`,
      [taskGraphItemId(source.rootTaskId), sessionId])
    const targetRow = targetBefore.rows[0] as Record<string, unknown> | undefined
    if (!targetRow || targetRow.failureReason !== "task_graph_verification_failed") throw new Error("repair target did not persist its canonical typed failure")
    const targetReport = (targetRow.result as Record<string, unknown>).taskGraphVerificationReport as Record<string, unknown>
    expect(targetReport).toMatchObject({ status: "failed", reasonCode: "criterion_not_met",
      evidenceDigest: targetVerification.report.evidenceDigest, resultDigest: targetVerification.report.resultDigest,
      criteria: [
        { criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" },
        { criterionId: "evidence-count", status: "failed", reasonCode: "criterion_not_met" },
      ] })

    const finish = await prepareTaskGraphFinish(client, { taskId: repairTaskId, sessionId, attemptCount: 1,
      status: "completed", retry: false, result: { structuredResult: unresolvedRepairStructuredResult },
      ownerId: workerId, taskRole: "scout", taskType: "scout" })
    expect(finish.status).toBe("failed")
    expect(finish.failureReason).toBe("task_graph_repair_target_unresolved")
    expect(finish.result).toMatchObject({ structuredResult: unresolvedRepairStructuredResult,
      taskGraphVerificationReport: { status: "unverified", reasonCode: "repair_target_unresolved", evidenceDigest: null,
        resultDigest: taskGraphResultDigest(unresolvedRepairStructuredResult),
        criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }] } })
    if (!finish.graph || "blocked" in finish.graph) throw new Error("unresolved repair finish did not prepare a lifecycle transition")
    const updatedRepair = await client.query(`UPDATE "sub_agent_tasks" SET "status" = $6, "failureReason" = $7, "result" = $8::jsonb,
      "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
        AND "status" = 'running' AND "attemptCount" = $5`,
    [repairTaskId, sessionId, source.turnId, source.rootTaskId, 1, finish.status, finish.failureReason, JSON.stringify(finish.result)])
    if (updatedRepair.rowCount !== 1) throw new Error("repair fixture lost its running attempt fence")
    await persistGraphTransition(client, finish.graph, new Date())
    await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'failed', "failureReason" = 'task_failed',
      "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "status" = 'running'`,
    [source.rootTaskId, sessionId, source.turnId])
    await client.query(`UPDATE "agent_turns" SET "status" = 'failed', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "status" = 'in_progress'`, [source.turnId, sessionId, userId])
    const terminal = await appendTaskGraphReceiptWithIdentity(client, { scope, itemId: null, taskId: source.rootTaskId,
      type: "turn.failed", idempotencyKey: `turn:${source.turnId}:event:turn-failed:task_failed`,
      payload: { turnId: source.turnId, taskId: source.rootTaskId, errorCode: "task_failed", finalItemId: null } })
    unresolvedRepairTerminalSequence = BigInt(terminal.sequence)

    const targetAfter = await client.query(`SELECT "id", "status", "failureReason", "result" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4`,
    [source.childId, sessionId, source.turnId, source.rootTaskId])
    const planAfter = await client.query(`SELECT "id", "sequence", "taskId", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [planIdentity.id, sessionId, source.turnId])
    const graphAfter = await client.query(`SELECT "revision", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2`,
      [taskGraphItemId(source.rootTaskId), sessionId])
    const repairAfter = await client.query(`SELECT "status", "failureReason", "result" FROM "sub_agent_tasks"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4`,
    [repairTaskId, sessionId, source.turnId, source.rootTaskId])
    expect(targetAfter.rows[0]).toEqual(targetBefore.rows[0])
    expect(planAfter.rows[0]).toEqual(planBefore.rows[0])
    expect(canonicalTaskGraphJson(graphAfter.rows[0]?.content)).toBe(canonicalTaskGraphJson(graphBefore.rows[0]?.content))
    expect(Number(graphAfter.rows[0]?.revision)).toBe(Number(graphBefore.rows[0]?.revision) + 1)
    expect(repairAfter.rows[0]).toMatchObject({ status: "failed", failureReason: "task_graph_repair_target_unresolved" })
    expect(repairAfter.rows[0]?.result).toEqual(finish.result)
    const lifecycle = await client.query(`SELECT event."type", event."idempotencyKey", event."payload" FROM "agent_events" event
      WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4
        AND event."type" = 'item.delta' AND event."idempotencyKey" = $5`,
    [sessionId, source.turnId, taskGraphItemId(source.rootTaskId), repairTaskId,
      taskGraphLifecycleKey(source.rootTaskId, "repair-attempt", 1, "task.failed")])
    expect(lifecycle.rows).toHaveLength(1)
    expect((lifecycle.rows[0]?.payload as Record<string, unknown>).event).toMatchObject({ type: "task.failed",
      nodeKey: "repair-attempt", expectedRevision: Number(graphBefore.rows[0]?.revision), failureReason: "task_graph_repair_target_unresolved" })
    await client.query("COMMIT")
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
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
    await insertSession(sessionId, userId, 39)
    await insertSession(otherSessionId, userId, 4)
    await insertSession(foreignSessionId, otherUserId, 4)
    for (const source of matchingSources) await insertSource(source)
    await insertSource(failedSource)
    await insertSource(interruptedSource)
    await insertSource(unresolvedRepairSource)
    await insertSource(otherJobSource)
    await insertSource(otherSessionSource)
    await insertSource(otherUserSource)
    await materializeUnresolvedRepairSource()
    await pool.query(`UPDATE "agent_sessions" SET "eventSequence" = 60 WHERE "id" = $1 AND "userId" = $2`, [sessionId, userId])

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
      VALUES ($1, $2, $3, NULL, $4, 60, 'turn.started', 'orchestrator', $3, $5, $6::jsonb)`,
    [`direct-history-current-start-${suffix}`, sessionId, currentTurnId, currentRootTaskId,
      `turn:${currentTurnId}:event:turn-started`, JSON.stringify({ taskId: currentRootTaskId, rootTaskId: currentRootTaskId })])
  })

  afterAll(async () => {
    if (pool) {
      await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [[sessionId, otherSessionId, foreignSessionId]]).catch(() => undefined)
      await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [[userId, otherUserId]]).catch(() => undefined)
      await pool.end()
    }
  })

  it("finds same-job terminal roots directly without compaction records and bounds history to the newest eight", async () => {
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    const history = await createPgDirectSelectedJobHistoryStore(pool!).load(input)

    expect(history.map(item => item.terminalSequence)).toEqual([unresolvedRepairTerminalSequence, 34n, 32n, 30n, 27n, 24n, 21n, 18n])
    expect(history.map(item => item.sourceTurnId)).toEqual([unresolvedRepairSource, interruptedSource, failedSource, ...matchingSources.slice(5).reverse()].map(source => source.turnId))
    expect(history.every(item => item.jobId === jobId && item.nodes.length === (item.sourceTurnId === unresolvedRepairSource.turnId ? 2 : 1)
      && !JSON.stringify(item.nodes).includes("Find a suitable role"))).toBe(true)
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

  it("projects the producer's unresolved-repair result when a repair targets an already-passed criterion", async () => {
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    const client = await pool!.connect()
    try {
      const stored = await client.query(`SELECT "result" FROM "sub_agent_tasks"
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4`,
      [`${unresolvedRepairSource.childId}-repair`, sessionId, unresolvedRepairSource.turnId, unresolvedRepairSource.rootTaskId])
      const result = stored.rows[0]?.result as { structuredResult?: unknown; taskGraphVerificationReport?: { resultDigest?: unknown } } | undefined
      expect(result?.structuredResult).toEqual(unresolvedRepairStructuredResult)
      expect(result?.taskGraphVerificationReport?.resultDigest).toBe(taskGraphResultDigest(unresolvedRepairStructuredResult))
      const sourceLease: TurnLease = { ...lease, turnId: unresolvedRepairSource.turnId, sessionId: unresolvedRepairSource.sessionId,
        userId: unresolvedRepairSource.userId }
      const decision = await checkTaskGraphTerminalVerification(client, sourceLease, unresolvedRepairSource.rootTaskId)
      expect(decision).toMatchObject({ ok: false, blocker: "task_graph_verification_unverified" })
      if (decision.ok) throw new Error("an unresolved repair source must not pass terminal TaskGraph verification")
      expect(decision.feedback).toContain("issue=repair_receipt")
      expect(decision.feedback).toContain("reasonCode=repair_target_unresolved")
      expect(decision.feedback).toContain("repair=rejected")
    } finally {
      client.release()
    }
    const outcomes = await createPgDirectSelectedJobHistoryStore(pool!).load(input)
    const outcome = outcomes.find(item => item.sourceTurnId === unresolvedRepairSource.turnId)
    if (!outcome) throw new Error("canonical unresolved-repair source was not returned by the direct reader")
    expect(outcome.nodes).toHaveLength(2)
    expect(outcome.nodes.find(node => node.historicalRepairReasonHint)).toMatchObject({
      status: "failed", historicalRepairReasonHint: "repair_target_unresolved",
    })
    const block = projectSelectedJobHistoryOutcomes([outcome])
    const turns = (block?.content as { turns: Array<{ nodes: Array<{ role: string; status: string; result: unknown; reasonHints?: string[] }> }> }).turns
    const repair = turns[0]?.nodes.find(node => node.reasonHints?.includes("repair_target_unresolved"))
    expect(repair).toEqual({
      role: "scout", status: "failed", result: { availability: "unavailable" }, reasonHints: ["repair_target_unresolved"],
    })
    const encoded = JSON.stringify(block?.content ?? null)
    for (const privateValue of [unresolvedRepairSource.turnId, unresolvedRepairSource.rootTaskId, unresolvedRepairSource.childId,
      `${unresolvedRepairSource.childId}-repair`, "repair-target", "repair-attempt", "candidate-count", "evidence-count", TASK_GRAPH_VERIFIER_VERSION,
      jobId, `repair-secondary-${suffix}`, `read:job:${jobId}`, `read:job:repair-secondary-${suffix}`,
      "verification", "criteria", "criteria_met", "evidenceDigest", "resultDigest", "structuredResult", "Found two candidate roles",
      "task_graph_repair_target_unresolved", "historicalRepairReasonHint"]) {
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
        VALUES ($1, $2, $3, NULL, $4, 61, 'turn.interrupted', 'system', $3, $5, $6::jsonb)`,
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

  it("requires an ordered unique source start and a completed correlated Step event", async () => {
    const source = matchingSources[9]
    if (!source.stepId) throw new Error("completed source Step ID is missing")
    const input: DirectSelectedJobHistoryLoadInput = { lease, rootTaskId: currentRootTaskId,
      rootAttemptCount: 2, stepId: currentStepId, jobId, now: new Date() }
    const store = createPgDirectSelectedJobHistoryStore(pool!)
    const includesSource = async () => (await store.load(input)).some(item => item.sourceTurnId === source.turnId)
    expect(await includesSource()).toBe(true)

    const startId = `direct-history-start-${source.turnId}`
    const stepEventId = `direct-history-step-completed-${source.turnId}`
    const duplicateStartId = `direct-history-duplicate-start-${source.turnId}`
    const sourceStepId = source.stepId
    const checkMutation = async (mutate: () => Promise<unknown>, restore: () => Promise<unknown>) => {
      let mutated = false
      try { await mutate(); mutated = true; expect(await includesSource()).toBe(false) }
      finally { if (mutated) await restore() }
    }
    await checkMutation(
      () => pool!.query(`DELETE FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2`, [startId, source.sessionId]),
      () => insertStartEvent(source),
    )
    await checkMutation(
      () => pool!.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
        VALUES ($1, $2, $3, NULL, $4, 62, 'turn.started', 'system', $3, $5, $6::jsonb)`,
      [duplicateStartId, source.sessionId, source.turnId, source.rootTaskId, `duplicate-start:${source.turnId}`, JSON.stringify({ taskId: source.rootTaskId, rootTaskId: source.rootTaskId })]),
      () => pool!.query(`DELETE FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2`, [duplicateStartId, source.sessionId]),
    )
    await checkMutation(
      () => pool!.query(`UPDATE "agent_events" SET "sequence" = 63 WHERE "id" = $1 AND "sessionId" = $2`, [startId, source.sessionId]),
      () => pool!.query(`UPDATE "agent_events" SET "sequence" = $1 WHERE "id" = $2 AND "sessionId" = $3`, [source.startSequence, startId, source.sessionId]),
    )
    await checkMutation(
      () => pool!.query(`DELETE FROM "agent_events" WHERE "id" = $1 AND "sessionId" = $2`, [stepEventId, source.sessionId]),
      () => insertStepCompletedEvent(source),
    )
    await checkMutation(
      () => pool!.query(`UPDATE "agent_steps" SET "status" = 'failed' WHERE "id" = $1 AND "sessionId" = $2`, [sourceStepId, source.sessionId]),
      () => pool!.query(`UPDATE "agent_steps" SET "status" = 'completed' WHERE "id" = $1 AND "sessionId" = $2`, [sourceStepId, source.sessionId]),
    )
    await checkMutation(
      () => pool!.query(`UPDATE "agent_events" SET "payload" = jsonb_build_object('stepId', $1::text, 'status', 'completed', 'taskId', 'wrong-root') WHERE "id" = $2 AND "sessionId" = $3`,
        [sourceStepId, stepEventId, source.sessionId]),
      () => pool!.query(`UPDATE "agent_events" SET "payload" = $1::jsonb WHERE "id" = $2 AND "sessionId" = $3`,
        [JSON.stringify({ stepId: sourceStepId, status: "completed", taskId: source.rootTaskId }), stepEventId, source.sessionId]),
    )
    expect(await includesSource()).toBe(true)
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
