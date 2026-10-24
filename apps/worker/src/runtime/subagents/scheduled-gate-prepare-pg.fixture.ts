import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import type { TurnLease } from "../turns/lease.js"
import { DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION } from "./child-discovery-attempt.js"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import type { ScheduledAutomationPipelineOwner } from "./scheduled-automation-pipeline-bridge.js"
import { SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION, type ScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"

const SCOUT_VERIFICATION: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
  ],
}
const JOB_DESCRIPTION = "Build reliable TypeScript services for European customers."

export type ScheduledGatePrepareFixtureJobRecord = Readonly<{ id: string; userId: string; company: string; role: string; location: string;
  status: "saved"; score: null; url: string; source: "fixture"; salary: null; description: string; keywords: string }>
export type ScheduledGatePrepareFixtureScoredJob = Readonly<{ job: ScheduledGatePrepareFixtureJobRecord & { coverLetter: null };
  score: number; matchedKeywords: string[]; missingKeywords: string[]; recommendation: string; analysisFenceAt: string }>
export type ScheduledGatePrepareSeedFixture = Readonly<{
  ids: Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; scoutTaskId: string; analystTaskId: string;
    leaseOwnerId: string; executionId: string }>
  jobIds: readonly string[]; jobRecords: readonly ScheduledGatePrepareFixtureJobRecord[]; scoredJobs: readonly ScheduledGatePrepareFixtureScoredJob[]
  jobId: string; jobRecord: ScheduledGatePrepareFixtureJobRecord; snapshot: TaskGraphSnapshot; scheduleSnapshot: ScheduledAutomationSnapshot
  graphScopeV1: GraphIdentityScope; ownerV1: ScheduledAutomationPipelineOwner; turnLeaseV1: TurnLease
  executionOwner: Readonly<{ executionId: string; executionAttemptCount: 1 }>
}>

/** Seeds and verifies only the two-node Scout→Analyst Analyze prefix; Prepare is appended by the runner. */
export async function seedScheduledGatePrepareFixture(
  pool: Pool, options: Readonly<{ minScore?: number; jobCount?: number }> = {},
): Promise<ScheduledGatePrepareSeedFixture> {
  const { minScore, jobCount } = seedOptions(options)
  const suffix = randomUUID()
  const ids = {
    userId: `scheduled-gate-user-${suffix}`, sessionId: `scheduled-gate-session-${suffix}`,
    turnId: `scheduled-gate-turn-${suffix}`, rootTaskId: `scheduled-gate-root-${suffix}`,
    scoutTaskId: `scheduled-gate-scout-${suffix}`, analystTaskId: `scheduled-gate-analyst-${suffix}`,
    leaseOwnerId: `scheduled-gate-turn-owner-${suffix}`, executionId: `scheduled-gate-execution-${suffix}`,
  }
  const jobIds = Array.from({ length: jobCount }, () => `c${randomUUID().replaceAll("-", "").slice(0, 24)}`)
  const jobRecords = jobIds.map((id, index) => fixtureJob(ids.userId, id, index))
  const scheduleSnapshot = scheduledSnapshot(minScore)
  const scoredJobs = analyzeProjection(jobRecords, minScore)
  const snapshot = graphSnapshot(ids)
  const graphScopeV1: GraphIdentityScope = {
    userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, rootTaskId: ids.rootTaskId, parentTaskId: ids.rootTaskId,
  }
  const client = await pool.connect()
  try {
    await client.query("BEGIN")
    await seedOwnerRows(client, ids, snapshot, scheduleSnapshot, jobIds)
    await seedJobs(client, jobRecords)
    await seedReceipts(client, ids, jobIds)
    await verifyAndPersistPrefix(client, ids, graphScopeV1, snapshot, jobIds, Math.max(82, minScore))
    await client.query(`UPDATE "agent_items" SET "revision" = 2 WHERE "id" = $1`, [taskGraphItemId(ids.rootTaskId)])
    const loaded = await loadTaskGraph(client, graphScopeV1, false)
    const graph = currentTaskGraph(loaded)
    if (loaded.item?.revision !== 2 || graph.nodes.length !== 2
      || graph.nodes.some(node => node.status !== "completed" || node.verificationReport?.status !== "passed")) {
      throw new Error("scheduled_gate_prepare_analyze_prefix_invalid")
    }
    const turn = await client.query<{ userId: string; leaseOwnerId: string; leaseVersion: number; leaseStartedAt: Date | string; leaseExpiresAt: Date | string }>(
      `SELECT "userId", "leaseOwnerId", "leaseVersion", "leaseStartedAt", "leaseExpiresAt" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`,
      [ids.turnId, ids.sessionId],
    )
    const lease = turn.rows[0]
    if (!lease) throw new Error("scheduled_gate_prepare_turn_lease_missing")
    const ownerV1: ScheduledAutomationPipelineOwner = {
      userId: ids.userId, sessionId: ids.sessionId, turnId: ids.turnId, rootTaskId: ids.rootTaskId,
      rootAttemptCount: 1, turnLeaseOwnerId: lease.leaseOwnerId, turnLeaseVersion: Number(lease.leaseVersion),
    }
    const turnLeaseV1: TurnLease = {
      turnId: ids.turnId, sessionId: ids.sessionId, userId: lease.userId, ownerId: lease.leaseOwnerId,
      leaseVersion: Number(lease.leaseVersion), leaseStartedAt: new Date(lease.leaseStartedAt), leaseExpiresAt: new Date(lease.leaseExpiresAt),
    }
    await client.query("COMMIT")
    return {
      ids, jobIds, jobRecords, scoredJobs, jobId: jobIds[0]!, jobRecord: jobRecords[0]!, snapshot, scheduleSnapshot,
      graphScopeV1, ownerV1, turnLeaseV1, executionOwner: { executionId: ids.executionId, executionAttemptCount: 1 },
    }
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
function seedOptions(value: Readonly<{ minScore?: number; jobCount?: number }>): { minScore: number; jobCount: number } {
  if (!value || typeof value !== "object" || Reflect.ownKeys(value).some(key => key !== "minScore" && key !== "jobCount")) {
    throw new TypeError("scheduled_gate_prepare_fixture_options_invalid")
  }
  const minScore = value.minScore ?? 70, jobCount = value.jobCount ?? 1
  if (!Number.isSafeInteger(minScore) || minScore < 0 || minScore > 100
    || !Number.isSafeInteger(jobCount) || jobCount < 1 || jobCount > 10) {
    throw new TypeError("scheduled_gate_prepare_fixture_options_invalid")
  }
  return { minScore, jobCount }
}
function fixtureJob(userId: string, id: string, index: number): ScheduledGatePrepareFixtureJobRecord {
  return { id, userId, company: `Fixture Systems ${index + 1}`, role: "Software Engineer", location: "Dublin",
    status: "saved", score: null, url: `https://jobs.example.invalid/${id}`, source: "fixture", salary: null,
    description: JOB_DESCRIPTION, keywords: "TypeScript, PostgreSQL" }
}

function analyzeProjection(jobs: readonly ScheduledGatePrepareFixtureJobRecord[], minScore: number): ScheduledGatePrepareFixtureScoredJob[] {
  const analysisFenceAt = new Date().toISOString(), score = Math.max(82, minScore)
  return jobs.map(job => ({ job: { ...job, coverLetter: null }, score, matchedKeywords: ["TypeScript"], missingKeywords: ["PostgreSQL"],
    recommendation: "Review this match after tailoring.", analysisFenceAt }))
}

function scheduledSnapshot(minScore: number): ScheduledAutomationSnapshot {
  return { schemaVersion: SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION, targetRoles: ["Software Engineer"],
    targetLocations: ["Dublin"], minScore, dailyCap: 10, requireApproval: true, autoApply: false }
}

function graphSnapshot(ids: ScheduledGatePrepareSeedFixture["ids"]): TaskGraphSnapshot {
  return parseTaskGraphSnapshot({
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [
      { key: "scheduled-scout", templateId: "scout", goal: "Discover matching roles",
        successCriteria: ["Return evidenced matching roles"], dependsOn: [], depth: 1, taskId: ids.scoutTaskId,
        verificationDisposition: "typed", verification: SCOUT_VERIFICATION },
      { key: "scheduled-analyst", templateId: "analyst", goal: "Analyze discovered roles",
        successCriteria: ["Return dependency-bound analysis for each discovered role"],
        dependsOn: ["scheduled-scout"], depth: 2, taskId: ids.analystTaskId, verificationDisposition: "typed",
        verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
          { id: "scout-membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scheduled-scout" } },
          { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
        ] } },
    ],
  })
}

async function seedOwnerRows(client: PoolClient, ids: ScheduledGatePrepareSeedFixture["ids"],
  snapshot: TaskGraphSnapshot, schedule: ScheduledAutomationSnapshot, jobIds: readonly string[]): Promise<void> {
  await client.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.userId, `${ids.userId}@example.invalid`])
  await client.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Scheduled Gate Prepare integration', 'running', 'automation', CURRENT_TIMESTAMP)`, [ids.sessionId, ids.userId])
  await client.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
      "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "executionMode", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'automation', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 4, 'canonical_task_graph', CURRENT_TIMESTAMP)`,
  [ids.turnId, ids.sessionId, ids.userId, JSON.stringify({ automationRunMode: "scheduled", scheduledAutomationSnapshot: schedule }), ids.leaseOwnerId])
  const rootActions = [...new Set([...TASK_GRAPH_TEMPLATES.scout.allowedActions, ...TASK_GRAPH_TEMPLATES.analyst.allowedActions,
    ...TASK_GRAPH_TEMPLATES.prepare.allowedActions])]
  await client.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
      "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
      "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, $4, 0, 'orchestrator', 'root', 'running', 'Scheduled Gate Prepare integration',
      '[]'::jsonb, '[]'::jsonb, $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":4,"maxDepth":4,"maxFanOut":4,"maxAttempts":3}}'::jsonb,
      1, 3, $6, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
  [ids.rootTaskId, ids.sessionId, ids.turnId, `/${ids.rootTaskId}`, JSON.stringify(rootActions), ids.leaseOwnerId])
  await client.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.rootTaskId])
  await client.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.rootTaskId, ids.turnId])
  for (const node of snapshot.nodes) {
    const template = TASK_GRAPH_TEMPLATES[node.templateId as "scout" | "analyst"]
    const role = node.templateId as "scout" | "analyst"
    const score = Math.max(82, schedule.minScore)
    const result = { status: "completed", stepCount: 1, toolCallCount: role === "scout" ? jobIds.length + 1 : jobIds.length,
      finalItemId: null, finalText: "Verified fixture task completed", structuredResult: roleResult(role, jobIds, score),
      ...(role === "scout" ? { discoveryAttempt: completeDiscoverySidecar(0) } : {}) }
    await client.query(`INSERT INTO "sub_agent_tasks"
      ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
        "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
        "budgetSnapshot", "attemptCount", "maxAttempts", "result", "startedAt", "completedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $4, $5, $6, $7, $8, 'completed', $9,
        '[]'::jsonb, $10::jsonb, $11::jsonb, '{}'::jsonb, $12::jsonb, '{}'::jsonb, '{}'::jsonb,
        '{}'::jsonb, 1, 2, $13::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
      node.taskId, ids.sessionId, ids.turnId, ids.rootTaskId, `/${ids.rootTaskId}/${node.taskId}`, node.depth,
      template.role, template.taskType, node.goal, JSON.stringify(node.successCriteria), JSON.stringify(template.allowedActions),
      JSON.stringify(template.expectedOutputSchema), JSON.stringify(result),
    ])
  }
  await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'started', 1, $5::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [taskGraphItemId(ids.rootTaskId), ids.sessionId, ids.turnId, ids.rootTaskId, JSON.stringify(snapshot)])
}

async function seedJobs(client: PoolClient, jobs: readonly ScheduledGatePrepareFixtureJobRecord[]): Promise<void> {
  for (const job of jobs) await client.query(`INSERT INTO "Job"
    ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "keywords", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CURRENT_TIMESTAMP)`,
  [job.id, job.userId, job.company, job.role, job.location, job.status, job.url, job.description, job.source, job.keywords])
}

async function seedReceipts(client: PoolClient, ids: ScheduledGatePrepareSeedFixture["ids"], jobIds: readonly string[]): Promise<void> {
  await persistToolReceipt(client, ids, ids.scoutTaskId, "scout-step", "jobs.discover", "discover", { query: "Software Engineer Dublin" },
    discoveryOutput(ids, jobIds), 1)
  for (const [index, jobId] of jobIds.entries()) {
    await persistToolReceipt(client, ids, ids.scoutTaskId, "scout-step", "jobs.get", `scout-read-${index}`, { jobId }, { job: { id: jobId, source: "fixture" } }, index + 2)
    await persistToolReceipt(client, ids, ids.analystTaskId, "analyst-step", "jobs.get", `analyst-read-${index}`, { jobId }, { job: { id: jobId, source: "fixture" } }, jobIds.length + index + 2)
  }
}

async function persistToolReceipt(client: PoolClient, ids: ScheduledGatePrepareSeedFixture["ids"], taskId: string,
  stepSuffix: string, toolName: string, callSuffix: string, input: unknown, output: unknown, ordinal: number): Promise<void> {
  const stepId = `${stepSuffix}-${callSuffix}-${ids.turnId}`, callId = `${callSuffix}-${ids.turnId}`
  const callItemId = `${callId}-item`, resultItemId = `${callId}-result`
  await client.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt", "completedAt")
    VALUES ($1, $2, $3, $4, $5, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [stepId, ids.sessionId, ids.turnId, taskId, ordinal])
  const call = { toolCallId: callId, toolName, toolVersion: "1", input, status: "completed", errorCode: null }
  const result = { toolCallId: callId, output, errorCode: null }
  await client.query(`INSERT INTO "agent_items"
    ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "completedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ($7, $2, $3, $4, $5, 'tool_result', 'completed', $8::jsonb, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [callItemId, ids.sessionId, ids.turnId, stepId, taskId, JSON.stringify(call), resultItemId, JSON.stringify(result)])
  await persistToolEvent(client, ids, taskId, callItemId, callId, toolName, "tool_call.started", { taskId, toolCallId: callId, toolName, toolVersion: "1" })
  await persistToolEvent(client, ids, taskId, callItemId, callId, toolName, "tool_call.completed", {
    taskId, toolCallId: callId, toolName, toolVersion: "1", status: "completed", errorCode: null, output,
  })
}

async function persistToolEvent(client: PoolClient, ids: ScheduledGatePrepareSeedFixture["ids"], taskId: string,
  itemId: string, callId: string, toolName: string, type: string, payload: unknown): Promise<void> {
  const updated = await client.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 RETURNING "eventSequence"`, [ids.sessionId])
  const sequence = updated.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("scheduled_gate_prepare_event_sequence_missing")
  await client.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'subagent', $8, $9, $10::jsonb)`, [randomUUID(), ids.sessionId, ids.turnId,
    itemId, taskId, String(sequence), type, callId, `scheduled-gate:${callId}:${type}`, JSON.stringify(payload)])
}

async function verifyAndPersistPrefix(client: PoolClient, ids: ScheduledGatePrepareSeedFixture["ids"],
  scope: GraphIdentityScope, snapshot: TaskGraphSnapshot, jobIds: readonly string[], score: number): Promise<void> {
  const scout = snapshot.nodes.find(node => node.key === "scheduled-scout")!
  const scoutProof = await verifyCompletedTaskGraphNodeEvidence(client, {
    scope: { ...scope, taskId: ids.scoutTaskId, attemptCount: 1 }, snapshot, node: scout, structuredResult: roleResult("scout", jobIds, score),
  })
  assertVerified(scoutProof, "scout")
  await persistVerification(client, ids.scoutTaskId, scoutProof, { discoveryAttempt: completeDiscoverySidecar(jobIds.length), toolCallCount: jobIds.length + 1 })
  const analyst = snapshot.nodes.find(node => node.key === "scheduled-analyst")!
  const dependencies = await verifyCompletedScoutDependencies(client, scope, snapshot, analyst)
  if (!dependencies) throw new Error("scheduled_gate_prepare_scout_dependency_unverified")
  const analystProof = await verifyCompletedTaskGraphNodeEvidence(client, {
    scope: { ...scope, taskId: ids.analystTaskId, attemptCount: 1 }, snapshot, node: analyst,
    structuredResult: roleResult("analyst", jobIds, score), dependencies: dependencies.projections,
  })
  assertVerified(analystProof, "analyst")
  await persistVerification(client, ids.analystTaskId, analystProof, { dependencyBindings: dependencies.bindings, toolCallCount: jobIds.length })
}

function roleResult(role: "scout" | "analyst", jobIds: readonly string[], score: number): Record<string, unknown> {
  const evidence = jobIds.map((jobId, index) => ({ id: `fixture-${role}-job-${index + 1}`, kind: "job", ref: jobId, source: "fixture" }))
  return role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", candidates: jobIds.map((jobId, index) => ({
      jobId, source: "fixture", url: null, evidenceIds: [evidence[index]!.id],
    })), evidence, summary: `Verified ${jobIds.length} discovered jobs` }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", findings: jobIds.map((jobId, index) => ({
      jobId, score: score / 10, evidenceIds: [evidence[index]!.id],
    })), evidence, summary: `Verified analysis for ${jobIds.length} jobs` }
}

function discoveryOutput(ids: ScheduledGatePrepareSeedFixture["ids"], jobIds: readonly string[]): Record<string, unknown> {
  return { jobs: jobIds.map(id => ({ id, source: "fixture" })), evidence: [], nextCursor: null, usage: {
    ledgerKey: `scheduled-gate-discovery-${ids.turnId}`, toolName: "jobs.discover", toolVersion: "1",
    toolCallId: `discover-${ids.turnId}`, sessionId: ids.sessionId, turnId: ids.turnId,
    stepId: `scout-step-discover-${ids.turnId}`, requests: 1, jobsProcessed: jobIds.length,
    jobsSucceeded: jobIds.length, jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1,
  } }
}

function completeDiscoverySidecar(candidateCount: number) {
  return { attemptCount: 1, health: { schemaVersion: DISCOVERY_ATTEMPT_HEALTH_SCHEMA_VERSION,
    attemptedCalls: 1, completedCalls: 1, failedCalls: 0, unresolvedCalls: 0, candidateCount,
    providerFailures: 0, materializationFailures: 0, hasMore: false } }
}

function assertVerified(proof: Awaited<ReturnType<typeof verifyCompletedTaskGraphNodeEvidence>>, role: string): void {
  if (!proof.verified || !proof.structuredResult) throw new Error(`scheduled_gate_prepare_${role}_verification_failed:${proof.evaluation.reasonCode}`)
}

async function persistVerification(client: PoolClient, taskId: string,
  proof: Awaited<ReturnType<typeof verifyCompletedTaskGraphNodeEvidence>>,
  options: Readonly<{ discoveryAttempt?: unknown; dependencyBindings?: readonly unknown[]; toolCallCount: number }>): Promise<void> {
  const existing = await client.query<{ result: Record<string, unknown> }>(`SELECT "result" FROM "sub_agent_tasks" WHERE "id" = $1`, [taskId])
  const previous = existing.rows[0]?.result
  if (!previous || typeof previous !== "object") throw new Error("scheduled_gate_prepare_result_missing")
  await client.query(`UPDATE "sub_agent_tasks" SET "result" = $2::jsonb, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [taskId, JSON.stringify({
    ...previous, toolCallCount: options.toolCallCount, structuredResult: proof.structuredResult,
    taskGraphVerificationReport: { ...proof.report, ...(options.dependencyBindings ? { dependencyBindings: options.dependencyBindings } : {}) },
    ...(options.discoveryAttempt ? { discoveryAttempt: options.discoveryAttempt } : {}),
  })])
}
