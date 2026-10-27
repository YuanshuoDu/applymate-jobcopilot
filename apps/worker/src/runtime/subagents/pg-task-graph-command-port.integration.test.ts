import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"

import { createAgentArtifactRepository } from "../../db/agent-artifact-repo.js"
import { createCanonicalScheduledDraftRuntime } from "../scheduled-draft-runtime.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION, type TaskGraphCurrentNode, type TaskGraphNativeCommandInput, type TaskGraphReadScope, type TaskGraphScheduleInput, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphFingerprint, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey, type StoredTaskGraphNode } from "./task-graph-snapshot.js"
import { TASK_GRAPH_LIMITS } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, type TaskGraphVerificationEvidenceProjection, type TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import { assertNoUnresolvedSteering } from "./steering-reconciliation-ledger.js"
import { transaction } from "./pg-store-persistence.js"
import { PgSubagentTaskStore } from "./pg-store.js"
import { loadSelectedJobPreparation, type SelectedJobPreparation } from "../selected-job-preparation.js"
import type { TurnLease } from "../turns/lease.js"
import { TASK_GRAPH_TEMPLATES, taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { verifyTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { readScheduledDraftCandidateBinding, validateScheduledDraftCandidateWitness } from "./scheduled-draft-candidate.js"
import type { TaskGraphVerificationDependencyBinding } from "./task-graph-verification-report.js"
import { createChildDiscoveryObservers } from "./child-discovery-observers.js"
import { INTERACTIVE_DISCOVERY_ROOT_TOOLS, rootTaskAllowedActions, rootToolSurface } from "../interactive-discovery-contract.js"
import { isSelectedJobRootTool } from "../canonical-turn-task-graph-context.js"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, COGNITIVE_AGENDA_EVENT_TYPE } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"
import { steeringReconciliationIdempotencyKey, STEERING_RECONCILIATION_EVENT_TYPE } from "./steering-reconciliation-contract.js"
import type { SteeringReconciliationOperation } from "./steering-reconciliation-contract.js"
import type { TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import { loadSelectedJobArtifactContext } from "./selected-job-artifact-context.js"
import { taskGraphSupersessionFingerprint, taskGraphSupersessionProposalKey } from "./task-graph-pg-supersession.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
const ROOT_TASK_GOAL = "P3 TaskGraph command-port integration test"
const ANALYST_VERIFICATION = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const

function dedicatedDisposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  if (process.env.CI !== "true" && !required) return null
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) {
      throw new Error("Required TaskGraph PostgreSQL integration tests need AGENT_RUNTIME_PG_TEST_URL and AGENT_RUNTIME_PG_TEST_DISPOSABLE=true")
    }
    return null
  }

  const url = new URL(value)
  if (
    url.protocol !== "postgresql:"
    || url.hostname !== "127.0.0.1"
    || url.port !== "5432"
    || url.username !== "postgres"
    || url.password !== "postgres"
    || url.pathname !== `/${DATABASE_NAME}`
    || url.search !== ""
    || url.hash !== ""
  ) {
    throw new Error("TaskGraph PostgreSQL integration tests require the dedicated disposable CI service URL")
  }
  return value
}

const databaseUrl = dedicatedDisposableUrl()
const describeWithPostgres = databaseUrl ? describe : describe.skip

type Fixture = {
  readonly userId: string
  readonly foreignUserId: string
  readonly foreignSessionId: string
  readonly foreignTurnId: string
  readonly foreignRootTaskId: string
  readonly foreignStepId: string
  readonly foreignItemId: string
  readonly foreignEventId: string
  readonly foreignOutboxId: string
  readonly foreignInputId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly stepId: string
  readonly originStepId: string
  readonly keepStepId: string
  readonly branchStepId: string
  readonly laterStepId: string
  readonly originalInputId: string
  readonly originalClientMessageId: string
  readonly firstSteerInputId: string
  readonly firstSteerClientMessageId: string
  readonly secondSteerInputId: string
  readonly secondSteerClientMessageId: string
  readonly planCallId: string
  readonly keepCallId: string
  readonly turnLeaseOwner: string
  readonly parentLeaseOwner: string
}

function fixture(): Fixture {
  const suffix = randomUUID()
  return {
    userId: `p3-task-graph-user-${suffix}`,
    foreignUserId: `p3-task-graph-foreign-user-${suffix}`,
    foreignSessionId: `p3-task-graph-foreign-session-${suffix}`,
    foreignTurnId: `p3-task-graph-foreign-turn-${suffix}`,
    foreignRootTaskId: `p3-task-graph-foreign-root-${suffix}`,
    foreignStepId: `p3-task-graph-foreign-step-${suffix}`,
    foreignItemId: `p3-task-graph-foreign-item-${suffix}`,
    foreignEventId: `p3-task-graph-foreign-event-${suffix}`,
    foreignOutboxId: `p3-task-graph-foreign-outbox-${suffix}`,
    foreignInputId: `p3-task-graph-foreign-input-${suffix}`,
    sessionId: `p3-task-graph-session-${suffix}`,
    turnId: `p3-task-graph-turn-${suffix}`,
    rootTaskId: `p3-task-graph-root-${suffix}`,
    stepId: `p3-task-graph-step-${suffix}`,
    originStepId: `p3-task-graph-origin-step-${suffix}`,
    keepStepId: `p3-task-graph-keep-step-${suffix}`,
    branchStepId: `p3-task-graph-branch-step-${suffix}`,
    laterStepId: `p3-task-graph-later-step-${suffix}`,
    originalInputId: `p3-task-graph-original-input-${suffix}`,
    originalClientMessageId: `p3-task-graph-original-client-${suffix}`,
    firstSteerInputId: `p3-task-graph-first-steer-${suffix}`,
    firstSteerClientMessageId: `p3-task-graph-first-steer-client-${suffix}`,
    secondSteerInputId: `p3-task-graph-second-steer-${suffix}`,
    secondSteerClientMessageId: `p3-task-graph-second-steer-client-${suffix}`,
    planCallId: `p3-task-graph-plan-call-${suffix}`,
    keepCallId: `p3-task-graph-keep-call-${suffix}`,
    turnLeaseOwner: `p3-turn-owner-${suffix}`,
    parentLeaseOwner: `p3-parent-owner-${suffix}`,
  }
}

function selectedJobId(value: Fixture): string { return `p3-task-graph-selected-job-${value.sessionId}` }
function scheduledDraftJobId(value: Fixture, label: string): string { return `draft-${label}-${value.rootTaskId.slice(-36)}` }

function completedReviewerResultEnvelope() {
  const digest = `sha256:${"a".repeat(64)}`
  return {
    status: "completed",
    stepCount: 1,
    toolCallCount: 1,
    finalItemId: null,
    finalText: "Review passed",
    structuredResult: {
      schemaVersion: ROLE_RESULT_SCHEMA,
      role: "reviewer",
      status: "completed",
      artifactRef: { artifactId: "fixture-cover-letter", version: 1, contentHash: digest, sourceDigest: digest },
      reviewStatus: "passed",
      reviewHash: digest,
    },
  }
}

function selectedJobRootAllowedActions(templates: TaskGraphScheduleInput["templates"]): string[] {
  const rootTools = rootToolSurface(
    INTERACTIVE_DISCOVERY_ROOT_TOOLS.map(name => ({ name })), true, false, isSelectedJobRootTool,
  )
  return rootTaskAllowedActions(rootTools, templates, true)
}

function scheduleInput(value: Fixture, nodeCount = 8, typed = true, preparation?: SelectedJobPreparation): TaskGraphScheduleInput {
  const templateId = typed ? "analyst" : "cover_letter_writer"
  return {
    scope: {
      userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
      rootTaskId: value.rootTaskId, parentTaskId: value.rootTaskId, stepId: value.stepId,
      turnLeaseOwner: value.turnLeaseOwner, turnLeaseVersion: 1,
      parentLeaseOwner: value.parentLeaseOwner, parentAttemptCount: 1,
    },
    proposal: {
      expectedRevision: 0,
      nodes: Array.from({ length: nodeCount }, (_, index) => ({
        key: `task-${index + 1}`,
        templateId,
        goal: `Complete graph task ${index + 1}`,
        successCriteria: [`Task ${index + 1} completed`],
        ...(typed ? { verification: ANALYST_VERIFICATION } : {}),
        dependsOn: index === 0 ? [] : [`task-${index}`],
      })),
    },
    templates: typed
      ? { analyst: { role: "analyst", taskType: "research", allowedActions: [] } }
      : taskGraphTemplatesForSelectedJob(preparation),
  }
}

async function seed(
  pool: PgPool,
  value: Fixture,
  ownedTurnObjective?: Readonly<{ goal: string; successCriteria: readonly string[] }>,
): Promise<void> {
  await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES
    ($1, $2, CURRENT_TIMESTAMP), ($3, $4, CURRENT_TIMESTAMP)`, [
    value.userId, `${value.userId}@example.invalid`, value.foreignUserId, `${value.foreignUserId}@example.invalid`,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'P3 TaskGraph command-port integration test', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.sessionId, value.userId,
  ])
  await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Foreign tenant visibility probe', 'running', 'test', CURRENT_TIMESTAMP)`, [
    value.foreignSessionId, value.foreignUserId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', $5::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [
    value.turnId, value.sessionId, value.userId, value.turnLeaseOwner,
    JSON.stringify(ownedTurnObjective
      ? { input: { goal: ownedTurnObjective.goal, successCriteria: [...ownedTurnObjective.successCriteria] } }
      : {}),
  ])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
     "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', $5,
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [
    value.rootTaskId, value.sessionId, value.turnId, value.parentLeaseOwner, ROOT_TASK_GOAL,
  ])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [value.rootTaskId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [value.rootTaskId, value.turnId])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [
      value.stepId, value.sessionId, value.turnId, value.rootTaskId,
  ])
  await pool.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, 'in_progress', 'user', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`, [
    value.foreignTurnId, value.foreignSessionId, value.foreignUserId, `foreign-${value.turnLeaseOwner}`,
  ])
  await pool.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot",
     "toolPolicySnapshot", "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Foreign tenant visibility probe',
      '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":4,"maxDepth":4,"maxFanOut":4,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [
    value.foreignRootTaskId, value.foreignSessionId, value.foreignTurnId, `foreign-${value.parentLeaseOwner}`,
  ])
  await pool.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [value.foreignRootTaskId])
  await pool.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [value.foreignRootTaskId, value.foreignTurnId])
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [
    value.foreignStepId, value.foreignSessionId, value.foreignTurnId, value.foreignRootTaskId,
  ])
  await pool.query(`INSERT INTO "agent_items"
    ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'task_graph', 'started', '{}'::jsonb, CURRENT_TIMESTAMP)`, [
    value.foreignItemId, value.foreignSessionId, value.foreignTurnId, value.foreignStepId, value.foreignRootTaskId,
  ])
  await pool.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "payload")
    VALUES ($1, $2, $3, $4, $5, 1, 'task_graph.fixture', 'system', $6, '{}'::jsonb)`, [
    value.foreignEventId, value.foreignSessionId, value.foreignTurnId, value.foreignItemId,
    value.foreignRootTaskId, value.foreignTurnId,
  ])
  await pool.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload")
    VALUES ($1, 'task_graph.fixture', $2, $3, '{}'::jsonb)`, [
    value.foreignOutboxId, value.foreignSessionId, value.foreignOutboxId,
  ])
  await pool.query(`INSERT INTO "agent_inputs" ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
    VALUES ($1, $2, $3, $4, $5, 'steer', 'accepted', '[]'::jsonb, 1)`, [
    value.foreignInputId, value.foreignSessionId, value.foreignTurnId, value.foreignUserId, `${value.foreignInputId}-client`,
  ])
}

async function graphRows(pool: PgPool, value: Fixture): Promise<Record<string, unknown>> {
  const [children, item, events, outbox] = await Promise.all([
    pool.query(`SELECT "id", "status" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`, [value.sessionId, value.rootTaskId]),
    pool.query(`SELECT "id", "revision" FROM "agent_items" WHERE "sessionId" = $1 AND "taskId" = $2 AND "type" = 'task_graph'`, [value.sessionId, value.rootTaskId]),
    pool.query(`SELECT "id", "idempotencyKey" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [value.sessionId, taskGraphProposalKey(value.rootTaskId, 0)]),
    pool.query(`SELECT "topic", "idempotencyKey" FROM "agent_outbox" WHERE "aggregateId" = $1 ORDER BY "idempotencyKey"`, [value.sessionId]),
  ])
  return { children: children.rows, item: item.rows, events: events.rows, outbox: outbox.rows }
}

async function durableGraphRows(pool: PgPool, value: Fixture): Promise<Record<string, unknown>> {
  const graphItemId = taskGraphItemId(value.rootTaskId)
  const [children, item, events, outbox] = await Promise.all([
    pool.query(`SELECT "id", "status", "role", "taskType", "goal", "allowedActions" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`, [value.sessionId, value.rootTaskId]),
    pool.query(`SELECT "id", "revision", "content", "status" FROM "agent_items"
      WHERE "id" = $1 AND "sessionId" = $2 AND "type" = 'task_graph'`, [graphItemId, value.sessionId]),
    pool.query(`SELECT "id", "itemId", "taskId", "sequence", "type", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 ORDER BY "sequence"`, [value.sessionId, value.turnId, graphItemId]),
    pool.query(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload", "attemptCount", "publishedAt", "lastError"
      FROM "agent_outbox" WHERE "aggregateId" = $1 ORDER BY "idempotencyKey"`, [value.sessionId]),
  ])
  return { children: children.rows, item: item.rows, events: events.rows, outbox: outbox.rows }
}

function repairNode(value: Fixture, targetTaskId: string, key: string): TaskGraphScheduleInput["proposal"]["nodes"][number] {
  return {
    key, templateId: "analyst", goal: `Repair finding-count for ${targetTaskId}`,
    successCriteria: ["Return one finding"], verification: ANALYST_VERIFICATION, dependsOn: [],
    repairOf: { graphRootTaskId: value.rootTaskId, nodeKey: "task-1", taskId: targetTaskId, criterionIds: ["finding-count"] },
  }
}

function repairScheduleInput(
  value: Fixture, expectedRevision: number, targetTaskId: string, repairKeys: readonly string[], includeOrdinary = false,
): TaskGraphScheduleInput {
  const registered = scheduleInput(value, 1, true)
  const nodes: TaskGraphScheduleInput["proposal"]["nodes"][number][] = repairKeys.map(key => repairNode(value, targetTaskId, key))
  if (includeOrdinary) nodes.push({
    key: "ordinary-overlap-batch", templateId: "analyst", goal: "Record a separate finding",
    successCriteria: ["Return one finding"], verification: ANALYST_VERIFICATION, dependsOn: [],
  })
  return { scope: registered.scope, templates: registered.templates, proposal: { expectedRevision, nodes } }
}

async function seedCanonicalFailedTarget(pool: PgPool, value: Fixture, taskId: string): Promise<void> {
  // This persisted canonical report isolates admission behavior; the resume PG suite covers worker-produced failures.
  const report = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    status: "failed",
    reasonCode: "criterion_not_met",
    criteria: [{ criterionId: "finding-count", status: "failed", reasonCode: "criterion_not_met" }],
    evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
  }
  const updated = await pool.query(`UPDATE "sub_agent_tasks" AS task SET "status" = 'failed',
      "failureReason" = 'task_graph_verification_failed', "result" = $6::jsonb, "updatedAt" = CURRENT_TIMESTAMP
    FROM "agent_sessions" AS session
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND task."status" = 'queued'
      AND session."id" = task."sessionId" AND session."userId" = $5`,
  [taskId, value.sessionId, value.turnId, value.rootTaskId, value.userId, JSON.stringify({
    summary: "Fixture-seeded canonical verifier failure", taskGraphVerificationReport: report,
  })])
  if (updated.rowCount !== 1) throw new Error("TaskGraph PG fixture could not seed the canonical failed target")
}

async function repairDurableRows(pool: PgPool, value: Fixture): Promise<Readonly<{
  children: readonly unknown[]
  item: readonly Readonly<{ revision: number }>[]
  events: readonly Readonly<{
    id: string; itemId: string | null; taskId: string | null; sequence: string | bigint
    type: string; idempotencyKey: string; payload: unknown
  }>[]
  outbox: readonly Readonly<{
    topic: string; aggregateId: string; idempotencyKey: string; payload: unknown
  }>[]
  sequence: readonly Readonly<{ eventSequence: string | bigint }>[]
}>> {
  const [children, item, events, outbox, sequence] = await Promise.all([
    pool.query(`SELECT "id", "status", "attemptCount", "role", "taskType", "goal", "failureReason", "result", "updatedAt"
      FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`, [value.sessionId, value.rootTaskId]),
    pool.query<{ revision: number }>(`SELECT "id", "revision", "content", "updatedAt" FROM "agent_items"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "type" = 'task_graph'`,
    [taskGraphItemId(value.rootTaskId), value.sessionId, value.turnId, value.rootTaskId]),
    pool.query<{ id: string; itemId: string | null; taskId: string | null; sequence: string | bigint; type: string; idempotencyKey: string; payload: unknown }>(`SELECT "id", "itemId", "taskId", "sequence", "type", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 ORDER BY "sequence"`,
    [value.sessionId, value.turnId, taskGraphItemId(value.rootTaskId)]),
    pool.query<{ topic: string; aggregateId: string; idempotencyKey: string; payload: unknown }>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"
      WHERE "aggregateId" = $1 ORDER BY "idempotencyKey"`, [value.sessionId]),
    pool.query<{ eventSequence: string | bigint }>(`SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [value.sessionId]),
  ])
  return { children: children.rows, item: item.rows, events: events.rows, outbox: outbox.rows, sequence: sequence.rows }
}

function readScope(value: Fixture): TaskGraphReadScope {
  return {
    userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    rootTaskId: value.rootTaskId, parentTaskId: value.rootTaskId,
    turnLeaseOwner: value.turnLeaseOwner, turnLeaseVersion: 1,
    parentLeaseOwner: value.parentLeaseOwner, parentAttemptCount: 1,
  }
}

const SCHEDULED_DRAFT_SCOUT_VERIFICATION = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout",
  criteria: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
    { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
  ],
} as const

function scheduledDraftAnalystVerification(hasFinding: boolean, scoutKeys: readonly string[], unionCheck?: "membership" | "coverage-only"): TaskGraphVerificationContract {
  if (unionCheck === "coverage-only") return {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
    criteria: [{ id: "scout-union-coverage", check: { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: [...scoutKeys], minimumPercent: 100 } }],
  }
  const membership = unionCheck === "membership"
    ? { kind: "findings_from_scout_union" as const, dependencyNodeKeys: [...scoutKeys] }
    : { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: scoutKeys[0]! }
  return {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
    role: "analyst",
    criteria: [
      { id: "scout-membership", check: membership },
      hasFinding
        ? { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }
        : { id: "evidence-count", check: { kind: "evidence_count_gte", minimum: 1 } },
    ],
  } as const
}

function scheduledDraftInput(
  value: Fixture,
  expectedRevision: number,
  nodes: TaskGraphScheduleInput["proposal"]["nodes"],
): TaskGraphScheduleInput {
  const base = scheduleInput(value, 0, true)
  return {
    scope: base.scope,
    proposal: { expectedRevision, nodes },
    templates: {
      ...TASK_GRAPH_TEMPLATES,
      cover_letter_writer: {
        role: "writer", taskType: "cover_letter_draft", allowedActions: ["artifact.version.read", "cover_letter.draft"],
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" }, context: { scheduledDraftMode: true },
      },
      cover_letter_reviewer: {
        role: "reviewer", taskType: "cover_letter_review", allowedActions: ["artifact.version.read", "artifact.review"],
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer" }, context: { scheduledDraftMode: true },
      },
    },
  }
}

function scheduledDraftGraphScope(value: Fixture) {
  return { userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
    rootTaskId: value.rootTaskId, parentTaskId: value.rootTaskId }
}

function scheduledDraftRoleResult(role: "scout" | "analyst", jobId: string, hasFinding = true, score = 8): unknown {
  const evidence = [{ id: `model-job-${role}`, kind: "job", ref: jobId, source: "fixture" }]
  if (role === "scout") return {
    schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed",
    candidates: [{ jobId, source: "fixture", url: null, evidenceIds: [evidence[0]!.id] }], evidence, summary: "Fixture candidate",
  }
  return {
    schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed",
    findings: hasFinding ? [{ jobId, score, evidenceIds: [evidence[0]!.id] }] : [], evidence,
    summary: hasFinding ? "Fixture finding" : "No fixture finding",
  }
}

async function persistVerifiedScheduledDraftRole(pool: PgPool, value: Fixture, snapshot: ReturnType<typeof parseTaskGraphSnapshot>, node: StoredTaskGraphNode,
  structuredResult: unknown, dependencies?: ReadonlyMap<string, TaskGraphVerificationEvidenceProjection>,
  dependencyBindings?: readonly TaskGraphVerificationDependencyBinding[]) {
  const attemptCount = 1, stepId = `scheduled-draft-step-${randomUUID()}`, callId = `scheduled-draft-call-${randomUUID()}`
  const callItemId = `${callId}-item`, resultItemId = `${callId}-result`
  const task = await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'running', "attemptCount" = $4,
      "leaseOwner" = $5, "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes',
      "startedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "status" IN ('queued', 'waiting')`,
  [node.taskId, value.sessionId, value.turnId, attemptCount, `scheduled-draft-owner-${callId}`])
  if (task.rowCount !== 1) throw new Error("Scheduled-draft PostgreSQL fixture could not lease its typed task")
  const ordinalResult = await pool.query<{ ordinal: number }>(`SELECT COALESCE(MAX("ordinal"), 0) + 1 AS "ordinal"
    FROM "agent_steps" WHERE "turnId" = $1 AND "attempt" = $2`, [value.turnId, attemptCount])
  const ordinal = Number(ordinalResult.rows[0]?.ordinal)
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) throw new Error("Scheduled-draft PostgreSQL fixture could not allocate a step ordinal")
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt", "completedAt")
    VALUES ($1, $2, $3, $4, $5, $6, 'completed', 0, '[]'::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [stepId, value.sessionId, value.turnId, node.taskId, ordinal, attemptCount])
  const job = (structuredResult as { evidence?: Array<{ ref?: string }> }).evidence?.[0]?.ref
  if (typeof job !== "string") throw new Error("Scheduled-draft PostgreSQL fixture has no job evidence")
  const output = { job: { id: job, source: "fixture" } }
  const callContent = { toolCallId: callId, toolName: "jobs.get", toolVersion: "1", input: { jobId: job }, status: "completed", errorCode: null }
  const resultContent = { toolCallId: callId, output, errorCode: null }
  await pool.query(`INSERT INTO "agent_items"
    ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "completedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
      ($7, $2, $3, $4, $5, 'tool_result', 'completed', $8::jsonb, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  [callItemId, value.sessionId, value.turnId, stepId, node.taskId, JSON.stringify(callContent), resultItemId, JSON.stringify(resultContent)])
  await insertReconciliationEvent(pool, value, {
    id: randomUUID(), sequence: await nextEventSequence(pool, value), type: "tool_call.started", actor: "subagent",
    itemId: callItemId, taskId: node.taskId, correlationId: callId, idempotencyKey: `scheduled-draft:${callId}:started`,
    payload: { taskId: node.taskId, toolCallId: callId, toolName: "jobs.get" },
  })
  await insertReconciliationEvent(pool, value, {
    id: randomUUID(), sequence: await nextEventSequence(pool, value), type: "tool_call.completed", actor: "subagent",
    itemId: callItemId, taskId: node.taskId, correlationId: callId, idempotencyKey: `scheduled-draft:${callId}:completed`,
    payload: { taskId: node.taskId, toolCallId: callId, toolName: "jobs.get", toolVersion: "1", status: "completed", errorCode: null, output },
  })
  const verified = await verifyTaskGraphNodeEvidence(pool, {
    scope: { ...scheduledDraftGraphScope(value), taskId: node.taskId, attemptCount }, snapshot, node, structuredResult,
    ...(dependencies ? { dependencies } : {}),
  })
  if (!verified.verified || verified.structuredResult === undefined) throw new Error(`Scheduled-draft PostgreSQL fixture evidence did not verify: ${verified.evaluation.reasonCode}`)
  const report = { ...verified.report, ...(dependencyBindings ? { dependencyBindings } : {}) }
  const result = {
    status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: null,
    finalText: "Fixture result verified from PostgreSQL evidence", structuredResult: verified.structuredResult,
    taskGraphVerificationReport: report,
  }
  const completed = await pool.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "failureReason" = NULL,
      "result" = $4::jsonb, "leaseOwner" = NULL, "leaseExpiresAt" = NULL,
      "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "status" = 'running' AND "attemptCount" = $5`,
  [node.taskId, value.sessionId, value.turnId, JSON.stringify(result), attemptCount])
  if (completed.rowCount !== 1) throw new Error("Scheduled-draft PostgreSQL fixture could not persist its verified task")
  return verified
}

async function seedVerifiedScheduledDraftSources(pool: PgPool, value: Fixture, command: ReturnType<typeof createPgTaskGraphCommandPort>, sources: readonly {
  readonly scoutKey: string; readonly extraScouts?: readonly Readonly<{ key: string; jobId: string }>[]
  readonly analystKey: string; readonly jobId: string; readonly score: number; readonly hasFinding: boolean
  readonly unionCheck?: "membership" | "coverage-only"
}[]) {
  const nodes: TaskGraphScheduleInput["proposal"]["nodes"][number][] = []
  for (const source of sources) {
    const scoutSources = [{ key: source.scoutKey, jobId: source.jobId }, ...(source.extraScouts ?? [])]
    const scoutKeys = scoutSources.map(scout => scout.key)
    for (const scout of scoutSources) nodes.push({ key: scout.key, templateId: "scout", goal: `Find ${scout.jobId}`, successCriteria: ["Return an evidenced job candidate"],
      verification: SCHEDULED_DRAFT_SCOUT_VERIFICATION, dependsOn: [] })
    nodes.push({ key: source.analystKey, templateId: "analyst", goal: `Verify ${source.jobId}`, successCriteria: ["Return a dependency-bound analysis"],
      verification: scheduledDraftAnalystVerification(source.hasFinding, scoutKeys, source.unionCheck), dependsOn: scoutKeys })
  }
  const input = scheduledDraftInput(value, 0, nodes)
  const rootAllowedActions = selectedJobRootAllowedActions(input.templates)
  const requiredActions = Object.values(input.templates).flatMap(template => template.allowedActions)
  expect(requiredActions.every(action => rootAllowedActions.includes(action))).toBe(true)
  const actionGrant = await pool.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $5::jsonb
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1
      AND "parentTaskId" IS NULL AND "leaseOwner" = $4 AND "attemptCount" = 1
      AND "status" = 'running' AND "leaseExpiresAt" > CURRENT_TIMESTAMP`,
  [value.rootTaskId, value.sessionId, value.turnId, value.parentLeaseOwner, JSON.stringify(rootAllowedActions)])
  if (actionGrant.rowCount !== 1) throw new Error("Scheduled-draft PostgreSQL fixture could not seed the root permission snapshot")
  await expect(scheduledDraftRootAllowedActions(pool, value)).resolves.toEqual(rootAllowedActions)
  await seedReconciliationAgenda(pool, value, {
    id: value.stepId, sequence: await nextEventSequence(pool, value), cursor: 0n, planRevision: 0, consumedInputIds: [],
  })
  const receipt = await command.appendAndSchedule(input)
  if (receipt.status !== "accepted" || receipt.revision !== 1) throw new Error("Scheduled-draft PostgreSQL fixture could not create its Scout and Analyst graph")
  await expect(scheduledDraftRootAllowedActions(pool, value)).resolves.toEqual(rootAllowedActions)
  const row = await pool.query<{ content: unknown }>(`SELECT "content" FROM "agent_items"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = 'task_graph'`,
  [taskGraphItemId(value.rootTaskId), value.sessionId, value.turnId])
  const snapshot = parseTaskGraphSnapshot(row.rows[0]?.content)
  const analysts: StoredTaskGraphNode[] = []
  for (const source of sources) {
    const scoutSources = [{ key: source.scoutKey, jobId: source.jobId }, ...(source.extraScouts ?? [])]
    const scouts = scoutSources.map(scout => snapshot.nodes.find(node => node.key === scout.key))
    const analyst = snapshot.nodes.find(node => node.key === source.analystKey)
    if (scouts.some(scout => !scout) || !analyst) throw new Error("Scheduled-draft PostgreSQL fixture could not read its Scout and Analyst nodes")
    for (const [index, scout] of scouts.entries()) await persistVerifiedScheduledDraftRole(pool, value, snapshot, scout!,
      scheduledDraftRoleResult("scout", scoutSources[index]!.jobId))
    const scoutDependencies = await verifyCompletedScoutDependencies(pool, scheduledDraftGraphScope(value), snapshot, analyst)
    if (!scoutDependencies) throw new Error("Scheduled-draft PostgreSQL fixture could not reconstruct its completed Scout proof")
    await persistVerifiedScheduledDraftRole(pool, value, snapshot, analyst,
      scheduledDraftRoleResult("analyst", source.jobId, source.hasFinding, source.score), scoutDependencies.projections, scoutDependencies.bindings)
    analysts.push(analyst)
  }
  return { snapshot, analysts, rootAllowedActions }
}

async function scheduledDraftRootAllowedActions(pool: PgPool | PoolClient, value: Fixture): Promise<unknown> {
  const result = await pool.query<{ allowedActions: unknown }>(`SELECT "allowedActions" FROM "sub_agent_tasks"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1
      AND "parentTaskId" IS NULL AND "role" = 'orchestrator' AND "taskType" = 'root'`,
  [value.rootTaskId, value.sessionId, value.turnId])
  if (result.rows.length !== 1) throw new Error("Scheduled-draft PostgreSQL fixture could not read the root permission snapshot")
  return result.rows[0]!.allowedActions
}

async function scheduledDraftDurableRows(pool: PgPool, value: Fixture): Promise<Record<string, unknown>> {
  const [tasks, graph, events, outbox, sequence] = await Promise.all([
    pool.query(`SELECT "id", "status", "role", "context", "result" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`, [value.sessionId, value.rootTaskId]),
    pool.query(`SELECT "id", "revision", "content" FROM "agent_items"
      WHERE "id" = $1 AND "sessionId" = $2 AND "type" = 'task_graph'`, [taskGraphItemId(value.rootTaskId), value.sessionId]),
    pool.query(`SELECT "id", "itemId", "taskId", "sequence", "type", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "sequence"`, [value.sessionId, value.turnId]),
    pool.query(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox"
      WHERE "aggregateId" = $1 ORDER BY "idempotencyKey"`, [value.sessionId]),
    pool.query(`SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [value.sessionId]),
  ])
  return { tasks: tasks.rows, graph: graph.rows, events: events.rows, outbox: outbox.rows, sequence: sequence.rows }
}

async function nextEventSequence(pool: PgPool, value: Fixture): Promise<bigint> {
  const result = await pool.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1
    WHERE "id" = $1 RETURNING "eventSequence"`, [value.sessionId])
  const sequence = result.rows[0]?.eventSequence
  if (sequence === undefined) throw new Error("TaskGraph reconciliation fixture could not allocate an event sequence")
  return BigInt(sequence)
}

async function syncEventSequenceToPersistedEvents(pool: PgPool, value: Fixture): Promise<void> {
  const result = await pool.query<{ eventSequence: string | bigint }>(`UPDATE "agent_sessions"
    SET "eventSequence" = GREATEST("eventSequence", COALESCE((
      SELECT MAX("sequence") FROM "agent_events" WHERE "sessionId" = $1
    ), 0)) WHERE "id" = $1 RETURNING "eventSequence"`, [value.sessionId])
  if (result.rows.length !== 1) throw new Error("TaskGraph reconciliation fixture could not synchronize its event sequence")
}

type TypedSupersessionOptions = Readonly<{
  includeIndependentPrerequisite?: boolean
  includeWaitingLegacyDependency?: boolean
  includeTypedWaitingAncestor?: boolean
  replacementDependsOn?: readonly string[]
  initialScheduledScoutCount?: number
}>

async function seedHistoricalLegacyNode(pool: PgPool, value: Fixture, nodeKey: string,
  proposal: TaskGraphScheduleInput["proposal"]): Promise<void> {
  const graphResult = await pool.query<{ content: unknown }>(`SELECT "content" FROM "agent_items"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = 'task_graph'`,
  [taskGraphItemId(value.rootTaskId), value.sessionId, value.turnId])
  const current = parseTaskGraphSnapshot(graphResult.rows[0]?.content)
  const sourceNode = current.nodes.find(node => node.key === nodeKey)
  if (!sourceNode || sourceNode.verificationDisposition !== "typed" || !sourceNode.verification) {
    throw new Error("TaskGraph legacy fixture did not find its typed historical node")
  }
  const historicalSnapshot = parseTaskGraphSnapshot({
    ...current,
    nodes: current.nodes.map(node => {
      if (node.key !== nodeKey) return node
      const legacy = { ...node } as Record<string, unknown>
      delete legacy.verification
      delete legacy.verificationDisposition
      return legacy
    }),
  })
  const legacyProposal = {
    ...proposal,
    nodes: proposal.nodes.map(node => {
      if (node.key !== nodeKey) return node
      const legacy = { ...node }
      delete legacy.verification
      return legacy
    }),
  }
  const eventResult = await pool.query<{ id: string; payload: unknown }>(`SELECT "id", "payload" FROM "agent_events"
    WHERE "sessionId" = $1 AND "turnId" = $2 AND "itemId" = $3 AND "type" = 'item.started'
      AND "payload"->>'kind' = 'proposal'`, [value.sessionId, value.turnId, taskGraphItemId(value.rootTaskId)])
  if (eventResult.rows.length !== 1) throw new Error("TaskGraph legacy fixture did not find its original plan receipt")
  const event = eventResult.rows[0]!
  const payload = event.payload as Record<string, unknown>
  const item = payload.item as Record<string, unknown> | undefined
  if (!item) throw new Error("TaskGraph legacy fixture plan receipt omitted its stream item")
  const historicalPayload = {
    ...payload,
    fingerprint: taskGraphFingerprint(legacyProposal),
    item: { ...item, content: historicalSnapshot },
  }
  const updatedItem = await pool.query(`UPDATE "agent_items" SET "content" = $4::jsonb
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "revision" = 1`,
  [taskGraphItemId(value.rootTaskId), value.sessionId, value.turnId, JSON.stringify(historicalSnapshot)])
  if (updatedItem.rowCount !== 1) throw new Error("TaskGraph legacy fixture could not persist its historical snapshot")
  const updatedEvent = await pool.query(`UPDATE "agent_events" SET "payload" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4`,
  [event.id, JSON.stringify(historicalPayload), value.sessionId, value.turnId])
  if (updatedEvent.rowCount !== 1) throw new Error("TaskGraph legacy fixture could not update its original plan receipt")
  const outboxPayload = await pool.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_outbox"
    WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [value.sessionId, `agent-event:${event.id}`])
  const outbox = outboxPayload.rows[0]?.payload as Record<string, unknown> | undefined
  if (!outbox) throw new Error("TaskGraph legacy fixture did not find its original event outbox row")
  const updatedOutbox = await pool.query(`UPDATE "agent_outbox" SET "payload" = $3::jsonb
    WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [value.sessionId, `agent-event:${event.id}`, JSON.stringify({ ...outbox, payload: historicalPayload })])
  if (updatedOutbox.rowCount !== 1) throw new Error("TaskGraph legacy fixture could not update its original event outbox row")
}

async function prepareTypedSupersession(pool: PgPool, commandPool: PgPool, roleName: string, value: Fixture,
  rootSuccessCriteria?: readonly string[], options: TypedSupersessionOptions = {}) {
  await seed(pool, value, rootSuccessCriteria ? { goal: "Find roles", successCriteria: [] } : undefined)
  if (rootSuccessCriteria) await pool.query(`UPDATE "sub_agent_tasks" SET "goal" = 'Find roles' WHERE "id" = $1`, [value.rootTaskId])
  const analystTemplate = TASK_GRAPH_TEMPLATES.analyst
  const rootActions = ["agent.plan", ...analystTemplate.allowedActions]
  await pool.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $2::jsonb WHERE "id" = $1`, [value.rootTaskId, JSON.stringify(rootActions)])

  const originalSequence = await nextEventSequence(pool, value)
  await seedReconciliationStep(pool, value, {
    id: value.originStepId, ordinal: 0, status: "streaming", cursor: originalSequence, consumedInputIds: [value.originalInputId],
  })
  await seedReconciliationInput(pool, value, {
    id: value.originalInputId, clientMessageId: value.originalClientMessageId, delivery: "follow_up",
    sequence: originalSequence, consumedByStepId: value.originStepId,
    text: "Complete original user task reference", disposition: "submitted",
  })
  const turnInput = { input: { goal: "Find roles", clientMessageId: value.originalClientMessageId } }
  if (options.initialScheduledScoutCount !== undefined) {
    const scheduledAutomationSnapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
      targetRoles: ["Software Engineer"], targetLocations: ["Dublin"], minScore: 70, dailyCap: 10, requireApproval: true, autoApply: false }
    await pool.query(`UPDATE "agent_turns" SET "source" = 'automation', "executionMode" = 'canonical_task_graph', "input" = $2::jsonb WHERE "id" = $1`,
      [value.turnId, JSON.stringify({ ...turnInput, automationRunMode: "scheduled", scheduledAutomationSnapshot })])
  } else {
    await pool.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [value.turnId, JSON.stringify(turnInput)])
  }
  await seedReconciliationAgenda(pool, value, {
    id: value.originStepId, sequence: await nextEventSequence(pool, value), cursor: originalSequence, planRevision: 0,
    consumedInputIds: [value.originalInputId],
  })

  const legacyFixtureNodeCount = options.includeWaitingLegacyDependency ? (options.includeTypedWaitingAncestor ? 4 : 3) : 0
  const scheduledInput = scheduleInput(value, options.initialScheduledScoutCount
    ?? (legacyFixtureNodeCount || (options.includeIndependentPrerequisite ? 2 : 1)), true)
  const initialNodes = options.initialScheduledScoutCount !== undefined
    ? Array.from({ length: options.initialScheduledScoutCount }, (_, index) => ({ key: `task-${index + 1}`, templateId: "scout",
      goal: `Discover scheduled candidates ${index + 1}`, successCriteria: ["Return candidates for the frozen schedule"],
      verification: SCHEDULED_DRAFT_SCOUT_VERIFICATION, dependsOn: [] }))
    : options.includeWaitingLegacyDependency
      ? scheduledInput.proposal.nodes.map((node, index) => ({ ...node, dependsOn: index === 2 ? ["task-2"] : index === 3 ? ["task-3"] : [] }))
      : options.includeIndependentPrerequisite
        ? scheduledInput.proposal.nodes.map(node => ({ ...node, dependsOn: [] }))
        : scheduledInput.proposal.nodes
  const initialInput: TaskGraphScheduleInput = { ...scheduledInput, proposal: { ...scheduledInput.proposal, nodes: initialNodes },
    ...(rootSuccessCriteria ? { rootSuccessCriteria } : {}), templates: {
    ...scheduledInput.templates, analyst: analystTemplate,
    ...(options.initialScheduledScoutCount !== undefined ? { scout: { ...TASK_GRAPH_TEMPLATES.scout, allowedActions: [] } } : {}),
  } }
  const initialPlanInput: TaskGraphScheduleInput = { ...initialInput, scope: { ...initialInput.scope, stepId: value.originStepId } }
  const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, value.userId))
  const initial = await command.appendAndSchedule(initialPlanInput)
  if (initial.revision !== 1) throw new Error("TaskGraph supersession fixture did not create revision one")
  if (options.includeWaitingLegacyDependency) await seedHistoricalLegacyNode(pool, value, "task-3", initialInput.proposal)
  await pool.query(`UPDATE "agent_steps" SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [value.originStepId])
  const source = (await command.readCurrent(readScope(value))).nodes[0]
  const originalNode = initialInput.proposal.nodes[0]
  if (!source || !originalNode) throw new Error("TaskGraph supersession fixture lost its typed source")
  const persistedSource = await pool.query<{ role: string; taskType: string; allowedActions: unknown; constraints: unknown; expectedOutputSchema: unknown }>(
    `SELECT "role", "taskType", "allowedActions", "constraints", "expectedOutputSchema" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
    [source.taskId, value.sessionId],
  )
  const sourceTemplate = initialInput.templates[originalNode.templateId]
  if (!sourceTemplate) throw new Error("TaskGraph supersession fixture lost its source template")
  expect(persistedSource.rows).toEqual([{
    role: sourceTemplate.role, taskType: sourceTemplate.taskType, allowedActions: sourceTemplate.allowedActions,
    constraints: sourceTemplate.constraints ?? [], expectedOutputSchema: sourceTemplate.expectedOutputSchema ?? {},
  }])
  const replacement = { ...originalNode, key: "replacement-1", goal: "Complete the revised graph task", successCriteria: ["Revised task completed"],
    ...(options.replacementDependsOn === undefined ? {} : { dependsOn: [...options.replacementDependsOn] }) }
  const replaceUnstarted = { nodeKey: source.key }
  const rawCallInput = { expectedRevision: 1, replaceUnstarted, nodes: [replacement], ...(rootSuccessCriteria ? { rootSuccessCriteria } : {}) }
  const input: TaskGraphScheduleInput = {
    scope: initialInput.scope,
    proposal: { expectedRevision: 1, nodes: [replacement] },
    templates: initialInput.templates,
    ...(rootSuccessCriteria ? { rootSuccessCriteria } : {}),
    replaceUnstarted,
  }
  const replacementFingerprint = taskGraphSupersessionFingerprint({ nodeKey: source.key, taskId: source.taskId, dependsOn: source.dependsOn }, {
    expectedRevision: 1, replaceUnstartedNodeKey: source.key, nodes: [replacement], rootSuccessCriteria,
  })

  const steerSequence = await nextEventSequence(pool, value)
  await pool.query(`UPDATE "agent_steps" SET "inputThroughSequence" = $2, "consumedInputIds" = $3::jsonb WHERE "id" = $1`, [
    value.stepId, steerSequence.toString(), JSON.stringify([value.originalInputId, value.firstSteerInputId]),
  ])
  await seedReconciliationInput(pool, value, {
    id: value.firstSteerInputId, clientMessageId: value.firstSteerClientMessageId, delivery: "steer",
    sequence: steerSequence, consumedByStepId: value.stepId, text: "Replace the queued stale task", disposition: "steered",
  })
  const agendaSequence = await nextEventSequence(pool, value)
  await seedReconciliationAgenda(pool, value, {
    id: value.stepId, sequence: agendaSequence, cursor: steerSequence, planRevision: 1,
    consumedInputIds: [value.originalInputId, value.firstSteerInputId],
  })
  const callSequence = await nextEventSequence(pool, value)
  await seedReconciliationToolCall(pool, value, {
    id: value.planCallId, stepId: value.stepId, toolName: "agent.plan", input: rawCallInput, sequence: callSequence,
  })
  const operation = {
    scope: input.scope, decision: "revise" as const, expectedRevision: 1, callId: value.planCallId,
    rootInputId: value.originalInputId, replaceUnstartedNodeKey: source.key,
  }
  return { command, input, operation, source, replacement, rawCallInput, replacementFingerprint,
    incompletePrerequisite: options.includeIndependentPrerequisite || options.includeWaitingLegacyDependency ? initialInput.proposal.nodes[1] : undefined,
    legacyDependency: options.includeWaitingLegacyDependency ? initialInput.proposal.nodes[2] : undefined,
    typedWaitingAncestor: options.includeTypedWaitingAncestor ? initialInput.proposal.nodes[3] : undefined }
}

const BRANCH_SCOUT_VERIFICATION = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
} as const
function branchAnalystVerification(scoutKey: string) {
  return {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
    role: "analyst" as const,
    criteria: [
      { id: "from-scout", check: { kind: "findings_from_scout_dependency" as const, dependencyNodeKey: scoutKey } },
      { id: "coverage", check: { kind: "findings_cover_scout_candidates_gte" as const, dependencyNodeKey: scoutKey, minimumPercent: 75 } },
      { id: "finding-count", check: { kind: "finding_count_gte" as const, minimum: 1 } },
    ],
  }
}

function branchPlanRequest(scope: TaskGraphScheduleInput["scope"], templates: TaskGraphScheduleInput["templates"],
  sourceNodes: readonly TaskGraphCurrentNode[], expectedRevision: number, callId: string, replacementPrefix: string) {
  const scout = sourceNodes.find(node => node.templateId === "scout")
  const analyst = scout && sourceNodes.find(node => node.templateId === "analyst" && node.dependsOn.includes(scout.key))
  if (!scout || !analyst || !scout.verification || !analyst.verification) throw new Error("Typed branch fixture requires Scout and Analyst sources")
  const replacementKeys = new Map([
    [scout.key, `${replacementPrefix}-scout`],
    [analyst.key, `${replacementPrefix}-analyst`],
  ])
  const replaceBranch = {
    root: { nodeKey: scout.key, taskId: scout.taskId },
    sources: [scout, analyst].map(node => ({ nodeKey: node.key, taskId: node.taskId, replacementKey: replacementKeys.get(node.key)! })),
  }
  const nodes: TaskGraphScheduleInput["proposal"]["nodes"] = [
    { key: replacementKeys.get(scout.key)!, templateId: "scout", goal: `Refresh evidence for ${replacementPrefix}`,
      successCriteria: ["Find one refreshed candidate"], dependsOn: scout.dependsOn.map(key => replacementKeys.get(key) ?? key),
      verification: scout.verification },
    { key: replacementKeys.get(analyst.key)!, templateId: "analyst", goal: `Reassess evidence for ${replacementPrefix}`,
      successCriteria: ["Score one refreshed candidate"], dependsOn: analyst.dependsOn.map(key => replacementKeys.get(key) ?? key),
      verification: branchAnalystVerification(replacementKeys.get(scout.key)!) },
  ]
  const proposal = { expectedRevision, nodes }
  const input: TaskGraphScheduleInput = { scope, proposal, templates, replaceBranch }
  const rawCallInput = { expectedRevision, nodes, replaceBranch }
  const operation = { scope, decision: "revise" as const, expectedRevision, callId, replaceBranch }
  return { input, operation, rawCallInput, replaceBranch, replacementKeys, nodes }
}

async function prepareTypedBranchReplan(pool: PgPool, commandPool: PgPool, roleName: string, value: Fixture, replacementPrefix = "first") {
  await seed(pool, value)
  const templates = { scout: TASK_GRAPH_TEMPLATES.scout, analyst: TASK_GRAPH_TEMPLATES.analyst }
  const allowedActions = [...new Set(["agent.plan", ...Object.values(templates).flatMap(template => template.allowedActions)])]
  await pool.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $2::jsonb WHERE "id" = $1`, [value.rootTaskId, JSON.stringify(allowedActions)])
  const scope: TaskGraphScheduleInput["scope"] = { ...readScope(value), stepId: value.stepId }
  await seedReconciliationAgenda(pool, value, { id: value.stepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: 0, consumedInputIds: [] })
  const initialNodes: TaskGraphScheduleInput["proposal"]["nodes"] = [
    { key: "source-scout", templateId: "scout", goal: "Find initial candidates", successCriteria: ["Find one candidate"],
      dependsOn: [], verification: BRANCH_SCOUT_VERIFICATION },
    { key: "source-analyst", templateId: "analyst", goal: "Score initial candidates", successCriteria: ["Score one candidate"],
      dependsOn: ["source-scout"], verification: branchAnalystVerification("source-scout") },
  ]
  const initialInput: TaskGraphScheduleInput = { scope, proposal: { expectedRevision: 0, nodes: initialNodes }, templates }
  const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, value.userId))
  const initial = await command.appendAndSchedule(initialInput)
  if (initial.revision !== 1) throw new Error("Typed branch fixture did not create revision one")
  const current = await command.readCurrent(readScope(value))
  if (current.nodes.length !== 2 || current.nodes[0]?.status !== "queued" || current.nodes[1]?.status !== "waiting") {
    throw new Error("Typed branch fixture did not retain its queued Scout and waiting Analyst")
  }
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 2, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
  [value.branchStepId, value.sessionId, value.turnId, value.rootTaskId])
  const branchScope: TaskGraphScheduleInput["scope"] = { ...readScope(value), stepId: value.branchStepId }
  await seedReconciliationAgenda(pool, value, { id: value.branchStepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: current.revision, consumedInputIds: [] })
  const request = branchPlanRequest(branchScope, templates, current.nodes, current.revision, value.planCallId, replacementPrefix)
  await seedReconciliationToolCall(pool, value, { id: value.planCallId, stepId: value.branchStepId, toolName: "agent.plan",
    input: request.rawCallInput, sequence: await nextEventSequence(pool, value) })
  return { pool, command, value, templates, scope: branchScope, sourceNodes: current.nodes, ...request }
}

async function failQueuedTypedTask(pool: PgPool, value: Fixture, taskId: string, ownerId: string): Promise<void> {
  const store = new PgSubagentTaskStore(pool)
  const claimed = await store.claim({ taskId, sessionId: value.sessionId, ownerId,
    policy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }, now: new Date() })
  if (!claimed || claimed.status !== "running") throw new Error("Failed-branch fixture could not claim its typed task")
  const result = await store.finish({ taskId, sessionId: value.sessionId, ownerId, attemptCount: claimed.attemptCount,
    status: "failed", retryDisposition: "terminal", failureReason: "private executor detail",
    result: { summary: "The executor returned no verifiable result" }, now: new Date() })
  if (result !== "failed") throw new Error("Failed-branch fixture did not terminalize through Worker finish")
}

type OperationalResumeFailureReason = "child_resume_unavailable" | "child_resume_evidence_unavailable"

async function failQueuedOperationalTask(pool: PgPool, value: Fixture, taskId: string, ownerId: string,
  failureReason: OperationalResumeFailureReason = "child_resume_unavailable"): Promise<void> {
  const store = new PgSubagentTaskStore(pool)
  const claimed = await store.claim({ taskId, sessionId: value.sessionId, ownerId,
    policy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }, now: new Date() })
  if (!claimed || claimed.status !== "running") throw new Error("Operational-failure fixture could not claim its typed task")
  const result = await store.finish({ taskId, sessionId: value.sessionId, ownerId, attemptCount: claimed.attemptCount,
    status: "failed", retryDisposition: "terminal", failureReason, result: null, now: new Date() })
  if (result !== "failed") throw new Error("Operational-failure fixture did not persist the canonical failure")
}

async function prepareOperationalFailureReplan(pool: PgPool, commandPool: PgPool, roleName: string, value: Fixture,
  shape: "scout_leaf" | "analyst_leaf" | "scout_analyst_closure",
  options: Readonly<{ leaveDependentWaiting?: boolean; failureReason?: OperationalResumeFailureReason }> = {}) {
  await seed(pool, value)
  const templates = { scout: TASK_GRAPH_TEMPLATES.scout, analyst: TASK_GRAPH_TEMPLATES.analyst }
  const allowedActions = [...new Set(["agent.plan", ...Object.values(templates).flatMap(template => template.allowedActions)])]
  await pool.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $2::jsonb WHERE "id" = $1`, [value.rootTaskId, JSON.stringify(allowedActions)])
  const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, value.userId))
  const initialScope: TaskGraphScheduleInput["scope"] = { ...readScope(value), stepId: value.stepId }
  await seedReconciliationAgenda(pool, value, { id: value.stepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: 0, consumedInputIds: [] })
  const scout = { key: "resume-scout", templateId: "scout", goal: "Find candidates", successCriteria: ["Find one candidate"],
    dependsOn: [], verification: BRANCH_SCOUT_VERIFICATION }
  const failureReason = options.failureReason ?? "child_resume_unavailable"
  const analyst = (key: string, dependsOn: string[]) => ({ key, templateId: "analyst", goal: "Score candidates",
    successCriteria: ["Score one candidate"], dependsOn, verification: dependsOn.length ? branchAnalystVerification(dependsOn[0]!) : ANALYST_VERIFICATION })
  const sourceDefinitions = shape === "scout_leaf" ? [scout] : shape === "analyst_leaf" ? [analyst("resume-analyst", [])] : [scout, analyst("resume-analyst", [scout.key])]
  const repairTarget = analyst("repair-target", [])
  const retained = Array.from({ length: 6 - sourceDefinitions.length }, (_, index) => analyst(`retained-${index + 1}`, []))
  const initialNodes: TaskGraphScheduleInput["proposal"]["nodes"] = [...sourceDefinitions, repairTarget, ...retained]
  const initialInput: TaskGraphScheduleInput = { scope: initialScope, proposal: { expectedRevision: 0, nodes: initialNodes }, templates }
  const initial = await command.appendAndSchedule(initialInput)
  if (initial.revision !== 1 || initial.nodes.length !== 7) throw new Error("Operational-failure fixture did not create seven typed nodes")
  const target = initial.nodes.find(node => node.key === repairTarget.key)
  if (!target) throw new Error("Operational-failure fixture lost its repair target")
  await failQueuedTypedTask(commandPool, value, target.taskId, `worker-fail-operational-target-${randomUUID()}`)
  const afterTargetFailure = await command.readCurrent(readScope(value))
  if (afterTargetFailure.revision !== 3 || afterTargetFailure.nodes.find(node => node.key === target.key)?.status !== "failed") {
    throw new Error("Operational-failure fixture did not persist the repair target failure")
  }

  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 2, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
  [value.branchStepId, value.sessionId, value.turnId, value.rootTaskId])
  const repairScope: TaskGraphScheduleInput["scope"] = { ...readScope(value), stepId: value.branchStepId }
  await seedReconciliationAgenda(pool, value, { id: value.branchStepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: afterTargetFailure.revision, consumedInputIds: [] })
  const repairInput: TaskGraphScheduleInput = { scope: repairScope, templates, proposal: { expectedRevision: afterTargetFailure.revision, nodes: [{
    key: "retained-repair", templateId: "analyst", goal: "Repair the retained finding", successCriteria: ["Score one candidate"],
    dependsOn: [], verification: ANALYST_VERIFICATION,
    repairOf: { graphRootTaskId: value.rootTaskId, nodeKey: target.key, taskId: target.taskId, criterionIds: ["finding-count"] },
  }] } }
  const repaired = await command.appendAndSchedule(repairInput)
  if (repaired.revision !== 4 || repaired.nodes[0]?.status !== "queued") throw new Error("Operational-failure fixture could not create its typed repair reserve")
  let current = await command.readCurrent(readScope(value))
  if (current.nodes.length !== 8) throw new Error("Operational-failure fixture did not fill the eight-node capacity")

  const failedRootDefinition = shape === "analyst_leaf" ? sourceDefinitions[0]! : scout
  const failedRoot = current.nodes.find(node => node.key === failedRootDefinition.key)
  if (!failedRoot) throw new Error("Operational-failure fixture lost its failure root")
  const heldDependent = options.leaveDependentWaiting && shape === "scout_analyst_closure"
    ? current.nodes.find(node => node.key === "resume-analyst") : undefined
  if (options.leaveDependentWaiting && !heldDependent) throw new Error("Operational-failure fixture lost its held descendant")
  const triggerName = heldDependent ? `op_wait_cancel_${randomUUID().replaceAll("-", "")}` : null
  const functionName = triggerName ? `${triggerName}_fn` : null
  if (triggerName && functionName) {
    await pool.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $operational_wait_test$
      BEGIN
        IF NEW."id" = TG_ARGV[0] AND NEW."status" = 'cancelled'
          AND NEW."failureReason" = 'A prerequisite task did not complete.' THEN
          RETURN NULL;
        END IF;
        RETURN NEW;
      END
      $operational_wait_test$`)
    await pool.query(`CREATE TRIGGER "${triggerName}" BEFORE UPDATE ON public."sub_agent_tasks"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"('${heldDependent!.taskId}')`)
  }
  try {
    await failQueuedOperationalTask(commandPool, value, failedRoot.taskId, `worker-fail-operational-source-${randomUUID()}`, failureReason)
  } finally {
    if (triggerName && functionName) {
      await pool.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."sub_agent_tasks"`)
      await pool.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`)
    }
  }
  current = await command.readCurrent(readScope(value))
  const sourceNodes = sourceDefinitions.map(definition => current.nodes.find(node => node.key === definition.key))
    .filter((node): node is TaskGraphCurrentNode => node !== undefined)
  if (sourceNodes.length !== sourceDefinitions.length || current.nodes.find(node => node.key === failedRoot.key)?.status !== "failed") {
    throw new Error("Operational-failure fixture did not persist its exact typed source failure")
  }
  if (shape === "scout_analyst_closure") {
    const dependent = current.nodes.find(node => node.key === "resume-analyst")
    const row = dependent && await pool.query<{ status: string; attemptCount: number; failureReason: string | null }>(
      `SELECT "status", "attemptCount", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1`, [dependent.taskId])
    const persisted = row?.rows[0]
    const expectedStatus = options.leaveDependentWaiting ? "waiting" : "cancelled"
    const expectedReason = options.leaveDependentWaiting ? null : "A prerequisite task did not complete."
    if (dependent?.status !== expectedStatus || !persisted || persisted.status !== expectedStatus || persisted.attemptCount !== 0
      || persisted.failureReason !== expectedReason) {
      throw new Error("Operational-failure fixture lost its expected dependent lifecycle state")
    }
  }

  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 3, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
  [value.laterStepId, value.sessionId, value.turnId, value.rootTaskId])
  const scope: TaskGraphScheduleInput["scope"] = { ...readScope(value), stepId: value.laterStepId }
  await seedReconciliationAgenda(pool, value, { id: value.laterStepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: current.revision, consumedInputIds: [] })
  const keyMap = new Map(sourceNodes.map(node => [node.key, `replacement-${node.key}`] as const))
  const mode: TaskGraphOperationalFailureReplacement = { root: { nodeKey: failedRoot.key, taskId: failedRoot.taskId },
    sources: sourceNodes.map(node => ({ nodeKey: node.key, taskId: node.taskId, replacementKey: keyMap.get(node.key)! })) }
  const proposalNodes: TaskGraphScheduleInput["proposal"]["nodes"] = sourceNodes.map(node => ({ key: keyMap.get(node.key)!,
    templateId: node.templateId, goal: `Retry ${node.goal}`, successCriteria: node.successCriteria,
    dependsOn: node.dependsOn.map(key => keyMap.get(key) ?? key),
    verification: node.templateId === "analyst" && node.dependsOn.length ? branchAnalystVerification(keyMap.get(node.dependsOn[0]!) ?? node.dependsOn[0]!) : node.verification }))
  const rawCallInput = { expectedRevision: current.revision, nodes: proposalNodes, replaceOperationalFailure: mode }
  const input: TaskGraphScheduleInput = { scope, templates, proposal: { expectedRevision: current.revision, nodes: proposalNodes }, replaceOperationalFailure: mode }
  const operation: SteeringReconciliationOperation = { scope, decision: "revise", expectedRevision: current.revision,
    callId: value.planCallId, replaceOperationalFailure: mode }
  await seedReconciliationToolCall(pool, value, { id: value.planCallId, stepId: scope.stepId!, toolName: "agent.plan",
    input: rawCallInput, sequence: await nextEventSequence(pool, value) })
  await pool.query(`UPDATE "agent_turns" SET "inputTokens" = 47, "outputTokens" = 13, "estimatedCostUsd" = 0.0042 WHERE "id" = $1 AND "sessionId" = $2`,
  [value.turnId, value.sessionId])
  await pool.query(`UPDATE "agent_steps" SET "inputTokens" = 47, "outputTokens" = 13, "estimatedCostUsd" = 0.0042 WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3`,
  [value.laterStepId, value.turnId, value.sessionId])
  return { pool, command, value, templates, scope, current, sourceNodes, sourceTaskIds: sourceNodes.map(node => node.taskId),
    failedRoot, failureReason, input, operation, rawCallInput }
}

async function prepareFailedBranchReplan(pool: PgPool, commandPool: PgPool, roleName: string, value: Fixture,
  replacementPrefix = "failed-replacement", options: Readonly<{ retainedNodeCount?: number; addNativeSnapshot?: boolean }> = {}) {
  await seed(pool, value)
  const templates = { scout: TASK_GRAPH_TEMPLATES.scout, analyst: TASK_GRAPH_TEMPLATES.analyst }
  const retainedKeys = ["retained-a", "retained-b", "retained-c", "retained-d"].slice(0, options.retainedNodeCount ?? 4)
  const allowedActions = [...new Set(["agent.plan", ...Object.values(templates).flatMap(template => template.allowedActions)])]
  await pool.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $2::jsonb WHERE "id" = $1`, [value.rootTaskId, JSON.stringify(allowedActions)])
  const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, value.userId))
  const initialScope: TaskGraphScheduleInput["scope"] = { ...readScope(value), stepId: value.stepId }
  await seedReconciliationAgenda(pool, value, { id: value.stepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: 0, consumedInputIds: [] })
  const initialNodes: TaskGraphScheduleInput["proposal"]["nodes"] = [
    // Keep the Analyst definition ahead of its Scout in stored graph order to prove retirement keys off branch identity.
    { key: "source-analyst", templateId: "analyst", goal: "Score initial candidates", successCriteria: ["Score one candidate"],
      dependsOn: ["source-scout"], verification: branchAnalystVerification("source-scout") },
    { key: "source-scout", templateId: "scout", goal: "Find initial candidates", successCriteria: ["Find one candidate"],
      dependsOn: [], verification: BRANCH_SCOUT_VERIFICATION },
    { key: "reserve-target", templateId: "analyst", goal: "Score repair target", successCriteria: ["Return one finding"],
      dependsOn: [], verification: ANALYST_VERIFICATION },
    ...retainedKeys.map(key => ({ key, templateId: "analyst" as const,
      goal: `Retain ${key}`, successCriteria: ["Return one finding"], dependsOn: [], verification: ANALYST_VERIFICATION })),
  ]
  const initial = await command.appendAndSchedule({ scope: initialScope, proposal: { expectedRevision: 0, nodes: initialNodes }, templates })
  if (initial.revision !== 1 || initial.nodes.length !== 3 + retainedKeys.length) throw new Error("Failed-branch fixture did not create its initial graph")
  const target = initial.nodes.find(node => node.key === "reserve-target")
  if (!target) throw new Error("Failed-branch fixture lost its retained repair target")
  await failQueuedTypedTask(commandPool, value, target.taskId, `worker-fail-repair-target-${randomUUID()}`)
  const afterTargetFailure = await command.readCurrent(readScope(value))
  const targetStatus = afterTargetFailure.nodes.find(node => node.key === "reserve-target")?.status
  // The real claim and terminal finish persist task.started and task.failed lifecycle revisions.
  if (afterTargetFailure.revision !== initial.revision + 2 || targetStatus !== "failed") {
    throw new Error(`Failed-branch fixture did not persist its retained target failure (revision ${afterTargetFailure.revision}, status ${targetStatus ?? "missing"})`)
  }

  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 2, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
  [value.branchStepId, value.sessionId, value.turnId, value.rootTaskId])
  const repairScope: TaskGraphScheduleInput["scope"] = { ...readScope(value), stepId: value.branchStepId }
  await seedReconciliationAgenda(pool, value, { id: value.branchStepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: afterTargetFailure.revision, consumedInputIds: [] })
  const repair = await command.appendAndSchedule({ scope: repairScope, templates, proposal: { expectedRevision: afterTargetFailure.revision, nodes: [{
    key: "retained-repair", templateId: "analyst", goal: "Repair the retained finding", successCriteria: ["Return one finding"],
    dependsOn: [], verification: ANALYST_VERIFICATION,
    repairOf: { graphRootTaskId: value.rootTaskId, nodeKey: "reserve-target", taskId: target.taskId, criterionIds: ["finding-count"] },
  }] } })
  if (repair.revision !== afterTargetFailure.revision + 1 || repair.nodes[0]?.status !== "queued") throw new Error("Failed-branch fixture could not use the real repair reserve")

  const sourceScout = initial.nodes.find(node => node.key === "source-scout"), sourceAnalyst = initial.nodes.find(node => node.key === "source-analyst")
  if (!sourceScout || !sourceAnalyst) throw new Error("Failed-branch fixture lost the Scout source")
  await failQueuedTypedTask(commandPool, value, sourceScout.taskId, `worker-fail-source-scout-${randomUUID()}`)
  let current = await command.readCurrent(readScope(value))
  if (current.nodes.length !== 4 + retainedKeys.length || current.nodes.find(node => node.key === "source-scout")?.status !== "failed"
    || current.nodes.find(node => node.key === "source-analyst")?.status !== "waiting"
    || !current.nodes.some(node => node.key === "retained-repair" && node.repairOf)) {
    const safeReason = (reason: string | null | undefined) => reason == null ? null
      : /^task_graph_[a-z_]+$/.test(reason) ? reason : "non-machine-reason"
    const outerRoot = await pool.query<{ status: string; failureReason: string | null }>(
      `SELECT "status", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1`, [value.rootTaskId])
    const nodes = current.nodes.map(node => ({ key: node.key, status: node.status, dependsOn: node.dependsOn,
      failureReason: safeReason(node.failureReason), repairOf: Boolean(node.repairOf) }))
    throw new Error(`Failed-branch fixture state mismatch: ${JSON.stringify({ revision: current.revision, nodes,
      outerRoot: outerRoot.rows[0] ? { status: outerRoot.rows[0].status,
        failureReason: safeReason(outerRoot.rows[0].failureReason) } : null })}`)
  }
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 3, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
  [value.laterStepId, value.sessionId, value.turnId, value.rootTaskId])
  let planStepId = value.laterStepId
  if (options.addNativeSnapshot) {
    await seedReconciliationAgenda(pool, value, { id: value.laterStepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
      planRevision: current.revision, consumedInputIds: [] })
    const native = await command.appendNativeCoordination!({
      scope: { ...readScope(value), stepId: value.laterStepId },
      request: { kind: "spawn", idempotencyKey: `failed-branch-native-${value.sessionId}`, role: "auditor", taskType: "audit",
        goal: "Retain an independently authorized audit task", constraints: ["read only"],
        successCriteria: ["Record findings"], context: { fixture: "current native snapshot" } },
    })
    if (native.status !== "accepted" || native.graphRevision !== current.revision + 1 || native.child.status !== "queued") {
      throw new Error("Failed-branch fixture could not append its native graph snapshot")
    }
    await syncEventSequenceToPersistedEvents(pool, value)
    current = await command.readCurrent(readScope(value))
    if (current.nodes.length !== 8 || !current.nodes.some(node => node.taskId === native.child.taskId)) {
      throw new Error("Failed-branch fixture did not retain its native task at the graph limit")
    }
    const completedNativeStep = await pool.query(`UPDATE "agent_steps" SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "status" = 'streaming'`,
    [value.laterStepId, value.sessionId, value.turnId])
    if (completedNativeStep.rowCount !== 1) throw new Error("Failed-branch fixture could not complete its native command Step")
    await pool.query(`INSERT INTO "agent_steps"
      ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
      VALUES ($1, $2, $3, $4, 4, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`,
    [value.keepStepId, value.sessionId, value.turnId, value.rootTaskId])
    planStepId = value.keepStepId
  }
  const turnUsage = await pool.query(`UPDATE "agent_turns" SET "inputTokens" = 47, "outputTokens" = 13,
    "estimatedCostUsd" = 0.0042 WHERE "id" = $1 AND "sessionId" = $2`, [value.turnId, value.sessionId])
  const stepUsage = await pool.query(`UPDATE "agent_steps" SET "inputTokens" = 47, "outputTokens" = 13,
    "estimatedCostUsd" = 0.0042 WHERE "id" = $1 AND "turnId" = $2 AND "sessionId" = $3`,
  [planStepId, value.turnId, value.sessionId])
  if (turnUsage.rowCount !== 1 || stepUsage.rowCount !== 1) throw new Error("Failed-branch fixture could not seed cumulative usage")
  const scope: TaskGraphScheduleInput["scope"] = { ...readScope(value), stepId: planStepId }
  await seedReconciliationAgenda(pool, value, { id: planStepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: current.revision, consumedInputIds: [] })
  const request = branchPlanRequest(scope, templates, current.nodes, current.revision, value.planCallId, replacementPrefix)
  await seedReconciliationToolCall(pool, value, { id: value.planCallId, stepId: planStepId, toolName: "agent.plan",
    input: request.rawCallInput, sequence: await nextEventSequence(pool, value) })
  return { pool, command, value, templates, sourceTaskIds: [sourceScout.taskId, sourceAnalyst.taskId],
    repairTargetId: target.taskId, scope, current, ...request }
}

async function prepareFollowingFailedBranchReplan(prepared: Awaited<ReturnType<typeof prepareFailedBranchReplan>>, expectedRevision: number) {
  const { pool, value, command, templates } = prepared
  const scope: TaskGraphScheduleInput["scope"] = { ...prepared.scope, stepId: value.originStepId }
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 4, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [value.originStepId, value.sessionId, value.turnId, value.rootTaskId])
  const current = await command.readCurrent(readScope(value))
  if (current.revision !== expectedRevision) throw new Error("Failed-branch fixture revision changed before next replan")
  await seedReconciliationAgenda(pool, value, { id: value.originStepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: current.revision, consumedInputIds: [] })
  const request = branchPlanRequest(scope, templates, current.nodes, current.revision, value.keepCallId, "after-failure")
  await seedReconciliationToolCall(pool, value, { id: value.keepCallId, stepId: value.originStepId, toolName: "agent.plan",
    input: request.rawCallInput, sequence: await nextEventSequence(pool, value) })
  return { ...prepared, scope, current, ...request }
}

async function failedBranchImmutableRows(pool: PgPool, value: Fixture, taskIds: readonly string[]): Promise<Record<string, unknown>> {
  const [tasks, events, outbox, reservations, rootBudget, turnUsage, stepUsage] = await Promise.all([
    pool.query(`SELECT * FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`, [taskIds]),
    pool.query(`SELECT * FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = ANY($3::text[]) ORDER BY "sequence", "id"`,
      [value.sessionId, value.turnId, taskIds]),
    pool.query(`SELECT * FROM "agent_outbox" WHERE "aggregateId" = $1
      AND ("payload"->>'taskId' = ANY($2::text[]) OR "payload"->'payload'->>'taskId' = ANY($2::text[])) ORDER BY "idempotencyKey"`,
      [value.sessionId, taskIds]),
    pool.query(`SELECT * FROM "agent_tree_budget_reservations" WHERE "sessionId" = $1 AND "taskId" = ANY($2::text[]) ORDER BY "id"`,
      [value.sessionId, taskIds]),
    pool.query(`SELECT "budgetSnapshot" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`, [value.rootTaskId, value.sessionId]),
    pool.query(`SELECT "id", "inputTokens", "outputTokens", "estimatedCostUsd"::text AS "estimatedCostUsd"
      FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2`, [value.turnId, value.sessionId]),
    pool.query(`SELECT "id", "inputTokens", "outputTokens", "estimatedCostUsd"::text AS "estimatedCostUsd"
      FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "id"`, [value.sessionId, value.turnId]),
  ])
  return { tasks: tasks.rows, events: events.rows, outbox: outbox.rows, reservations: reservations.rows, rootBudget: rootBudget.rows,
    usage: { turn: turnUsage.rows, steps: stepUsage.rows } }
}

async function prepareNextTypedBranchReplan(prepared: Awaited<ReturnType<typeof prepareTypedBranchReplan>>, expectedRevision: number) {
  const { pool, value, command, templates } = prepared
  const scope: TaskGraphScheduleInput["scope"] = { ...prepared.scope, stepId: value.laterStepId }
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 3, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [value.laterStepId, value.sessionId, value.turnId, value.rootTaskId])
  const current = await command.readCurrent(readScope(value))
  if (current.revision !== expectedRevision) throw new Error("Typed branch fixture revision changed before repeated replan")
  await seedReconciliationAgenda(pool, value, { id: value.laterStepId, sequence: await nextEventSequence(pool, value), cursor: 0n,
    planRevision: current.revision, consumedInputIds: [] })
  const request = branchPlanRequest(scope, templates, current.nodes, current.revision, value.keepCallId, "second")
  await seedReconciliationToolCall(pool, value, { id: value.keepCallId, stepId: value.laterStepId, toolName: "agent.plan",
    input: request.rawCallInput, sequence: await nextEventSequence(pool, value) })
  return { ...prepared, scope, sourceNodes: current.nodes, ...request }
}

async function supersessionDurableRows(pool: PgPool, value: Fixture): Promise<Record<string, unknown>> {
  const [tasks, items, events, outbox, session, steps, inputs, waits] = await Promise.all([
    pool.query(`SELECT * FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`, [value.sessionId, value.rootTaskId]),
    pool.query(`SELECT * FROM "agent_items" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "id"`, [value.sessionId, value.turnId]),
    pool.query(`SELECT * FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "sequence", "id"`, [value.sessionId, value.turnId]),
    pool.query(`SELECT * FROM "agent_outbox" WHERE "aggregateId" = $1 ORDER BY "idempotencyKey"`, [value.sessionId]),
    pool.query(`SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [value.sessionId]),
    pool.query(`SELECT * FROM "agent_steps" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "id"`, [value.sessionId, value.turnId]),
    pool.query(`SELECT * FROM "agent_inputs" WHERE "sessionId" = $1 AND "targetTurnId" = $2 ORDER BY "id"`, [value.sessionId, value.turnId]),
    pool.query(`SELECT * FROM "agent_wait_conditions" WHERE "sessionId" = $1 AND "turnId" = $2 ORDER BY "id"`, [value.sessionId, value.turnId]),
  ])
  return { tasks: tasks.rows, items: items.rows, events: events.rows, outbox: outbox.rows, session: session.rows, steps: steps.rows, inputs: inputs.rows, waits: waits.rows }
}

function pausingSessionLockPool(basePool: PgSubagentPool): {
  pool: PgSubagentPool
  acquired: Promise<void>
  release: () => void
} {
  let acquired!: () => void
  let release!: () => void
  let paused = false
  const acquiredPromise = new Promise<void>(resolve => { acquired = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  return {
    acquired: acquiredPromise,
    release: () => release(),
    pool: {
      async connect() {
        const client = await basePool.connect()
        return new Proxy(client, {
          get(target, property) {
            if (property === "query") return (...args: unknown[]) => {
              const sql = typeof args[0] === "string" ? args[0].toUpperCase() : ""
              const result: unknown = Reflect.apply(target.query, target, args)
              if (!paused && sql.includes("FROM \"AGENT_SESSIONS\"") && sql.includes("FOR UPDATE")) {
                return Promise.resolve(result).then(async value => {
                  paused = true
                  acquired()
                  await gate
                  return value
                })
              }
              return result
            }
            const result: unknown = Reflect.get(target, property, target)
            return typeof result === "function" ? result.bind(target) : result
          },
        })
      },
    },
  }
}

async function waitForLockWait(pool: PgPool, applicationName: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const result = await pool.query<{ waitEventType: string | null }>(`SELECT "wait_event_type" AS "waitEventType"
      FROM pg_stat_activity WHERE "application_name" = $1`, [applicationName])
    if (result.rows.some(row => row.waitEventType === "Lock")) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  throw new Error(`PostgreSQL worker race did not observe lock wait for ${applicationName}`)
}

async function waitForSignal(signal: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { await Promise.race([signal, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PostgreSQL race lock was not acquired")), 10_000) })]) }
  finally { if (timer) clearTimeout(timer) }
}

async function insertReconciliationEvent(pool: PgPool, value: Fixture, event: {
  readonly id: string; readonly sequence: bigint; readonly type: string; readonly actor: string
  readonly itemId: string | null; readonly taskId: string | null; readonly correlationId: string
  readonly idempotencyKey: string; readonly payload: unknown; readonly causationId?: string | null
}): Promise<void> {
  await pool.query(`INSERT INTO "agent_events"
    ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload")
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`, [
    event.id, value.sessionId, value.turnId, event.itemId, event.taskId, event.sequence.toString(), event.type, event.actor,
    event.correlationId, event.causationId ?? null, event.idempotencyKey, JSON.stringify(event.payload),
  ])
}

async function seedReconciliationStep(pool: PgPool, value: Fixture, step: {
  readonly id: string; readonly ordinal: number; readonly status: "streaming" | "completed"
  readonly cursor: bigint; readonly consumedInputIds: readonly string[]
}): Promise<void> {
  await pool.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8::jsonb, '{}'::jsonb)`, [
    step.id, value.sessionId, value.turnId, value.rootTaskId, step.ordinal, step.status, step.cursor.toString(), JSON.stringify(step.consumedInputIds),
  ])
}

async function seedReconciliationInput(pool: PgPool, value: Fixture, input: {
  readonly id: string; readonly clientMessageId: string; readonly delivery: "follow_up" | "steer"
  readonly sequence: bigint; readonly consumedByStepId: string; readonly text: string; readonly disposition: string
}): Promise<void> {
  const content = { parts: [{ type: "text", text: input.text }], clientMessageId: input.clientMessageId, source: "user", disposition: input.disposition }
  const itemId = `${input.id}-message`
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, 'user_message', 'completed', $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    itemId, value.sessionId, value.turnId, JSON.stringify(content),
  ])
  await pool.query(`INSERT INTO "agent_inputs"
    ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence", "consumedByStepId", "consumedAt")
    VALUES ($1, $2, $3, $4, $5, $6, 'consumed', $7::jsonb, $8, $9, CURRENT_TIMESTAMP)`, [
    input.id, value.sessionId, value.turnId, value.userId, input.clientMessageId, input.delivery,
    JSON.stringify([{ type: "text", text: input.text }]), input.sequence.toString(), input.consumedByStepId,
  ])
  await insertReconciliationEvent(pool, value, {
    id: `${input.id}-accepted`, sequence: input.sequence, type: "input.accepted", actor: "user", itemId, taskId: null,
    correlationId: value.turnId, idempotencyKey: `input.accepted:${input.clientMessageId}`,
    payload: { inputId: input.id, clientMessageId: input.clientMessageId, delivery: input.delivery, source: "user", disposition: input.disposition },
  })
}

async function seedAcceptedReconciliationSteer(pool: PgPool, value: Fixture, input: {
  readonly id: string; readonly clientMessageId: string; readonly sequence: bigint; readonly text: string
}): Promise<void> {
  const disposition = "steered", itemId = `${input.id}-message`
  const content = { parts: [{ type: "text", text: input.text }], clientMessageId: input.clientMessageId, source: "user", disposition }
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, 'user_message', 'completed', $4::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    itemId, value.sessionId, value.turnId, JSON.stringify(content),
  ])
  await pool.query(`INSERT INTO "agent_inputs" ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
    VALUES ($1, $2, $3, $4, $5, 'steer', 'accepted', $6::jsonb, $7)`, [
    input.id, value.sessionId, value.turnId, value.userId, input.clientMessageId,
    JSON.stringify([{ type: "text", text: input.text }]), input.sequence.toString(),
  ])
  await insertReconciliationEvent(pool, value, {
    id: `${input.id}-accepted`, sequence: input.sequence, type: "input.accepted", actor: "user", itemId, taskId: null,
    correlationId: value.turnId, idempotencyKey: `input.accepted:${input.clientMessageId}`,
    payload: { inputId: input.id, clientMessageId: input.clientMessageId, delivery: "steer", source: "user", disposition },
  })
}

async function seedReconciliationAgenda(pool: PgPool, value: Fixture, step: {
  readonly id: string; readonly sequence: bigint; readonly cursor: bigint; readonly planRevision: number
  readonly consumedInputIds: readonly string[]
}): Promise<void> {
  const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: value.sessionId, turnId: value.turnId,
    stepId: step.id, inputThroughSequence: step.cursor, consumedInputIds: step.consumedInputIds, blocks: [], canonicalJson: "{}",
    taskGraphRevision: step.planRevision }
  const receipt = buildCognitiveAgendaReceipt({ sessionId: value.sessionId, turnId: value.turnId, taskId: value.rootTaskId,
    stepId: step.id, inputThroughSequence: step.cursor, consumedInputIds: step.consumedInputIds,
    agenda: buildCognitiveActionAgenda(context) })
  if (!receipt) throw new Error("TaskGraph reconciliation fixture agenda was invalid")
  await insertReconciliationEvent(pool, value, {
    id: `${step.id}-agenda`, sequence: step.sequence, type: COGNITIVE_AGENDA_EVENT_TYPE, actor: "orchestrator",
    itemId: null, taskId: value.rootTaskId, correlationId: step.id, idempotencyKey: `cognitive.agenda:${step.id}`, payload: receipt,
  })
}

async function seedReconciliationToolCall(pool: PgPool, value: Fixture, call: {
  readonly id: string; readonly stepId: string; readonly toolName: "agent.plan" | "agent.reconcile"
  readonly input: unknown; readonly sequence: bigint
}): Promise<void> {
  const itemId = `${call.id}-item`
  const content = { toolCallId: call.id, toolName: call.toolName, toolVersion: "1", input: call.input }
  await pool.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "content", "startedAt", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'started', $6::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`, [
    itemId, value.sessionId, value.turnId, call.stepId, value.rootTaskId, JSON.stringify(content),
  ])
  await insertReconciliationEvent(pool, value, {
    id: `${call.id}-started`, sequence: call.sequence, type: "tool_call.started", actor: "orchestrator", itemId,
    taskId: value.rootTaskId, correlationId: call.id, idempotencyKey: `turn:${value.turnId}:event:tool-started:${call.id}`,
    // Root Turn lifecycle receipts intentionally omit toolVersion from this event; it remains on the item.
    payload: { toolCallId: call.id, toolName: call.toolName, taskId: value.rootTaskId },
  })
}

const TENANT_TABLES = ["agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events", "agent_outbox", "agent_inputs"] as const
const TENANT_POLICIES: ReadonlyArray<readonly [string, string, string]> = [
  ["agent_sessions", "session", `"userId" = public.app_current_user_id()`],
  ["agent_turns", "turn", `"userId" = public.app_current_user_id() AND EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["sub_agent_tasks", "task", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_steps", "step", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_items", "item", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_events", "event", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
  ["agent_outbox", "outbox", `EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "aggregateId" AND session."userId" = public.app_current_user_id())`],
  ["agent_inputs", "input", `"userId" = public.app_current_user_id() AND EXISTS (
    SELECT 1 FROM public."agent_sessions" AS session WHERE session."id" = "sessionId" AND session."userId" = public.app_current_user_id())`],
]

type SetupState = {
  readonly originalRls: Map<string, boolean>
  readonly policies: Array<{ table: string; name: string; existedBefore: boolean }>
  shouldDropUserIdFunction: boolean
  shouldDropRole: boolean
}

async function installTaskGraphTenantRls(pool: PgPool, policyPrefix: string, setup: SetupState): Promise<void> {
  const prior = await pool.query<{ tableName: string; enabled: boolean }>(`SELECT relation.relname AS "tableName", relation.relrowsecurity AS enabled
    FROM pg_class AS relation WHERE relation.oid = ANY(ARRAY[
      'public."agent_sessions"'::regclass, 'public."agent_turns"'::regclass, 'public."sub_agent_tasks"'::regclass,
      'public."agent_steps"'::regclass, 'public."agent_items"'::regclass, 'public."agent_events"'::regclass,
      'public."agent_outbox"'::regclass, 'public."agent_inputs"'::regclass
    ])`)
  for (const table of TENANT_TABLES) {
    const row = prior.rows.find(candidate => candidate.tableName === table)
    if (!row) throw new Error(`TaskGraph RLS setup could not observe prior state for ${table}`)
    setup.originalRls.set(table, row.enabled)
  }
  const currentUserFunction = await pool.query<{ exists: boolean }>(`SELECT to_regprocedure('public.app_current_user_id()') IS NOT NULL AS exists`)
  const functionExists = currentUserFunction.rows[0]?.exists
  if (functionExists === undefined) throw new Error("TaskGraph RLS setup could not observe app_current_user_id()")
  setup.shouldDropUserIdFunction = !functionExists
  if (setup.shouldDropUserIdFunction) {
    await pool.query(`CREATE FUNCTION public.app_current_user_id() RETURNS text LANGUAGE sql STABLE
      AS $$ SELECT NULLIF(current_setting('app.user_id', true), '') $$`)
  }
  for (const table of TENANT_TABLES) await pool.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`)

  for (const [table, suffix, predicate] of TENANT_POLICIES) {
    const name = `${policyPrefix}_${suffix}`
    const existingPolicy = await pool.query<{ exists: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM pg_policy WHERE polrelid = to_regclass($1) AND polname = $2
    ) AS exists`, [`public."${table}"`, name])
    const existedBefore = existingPolicy.rows[0]?.exists
    if (existedBefore === undefined) throw new Error(`TaskGraph RLS setup could not observe policy ${name}`)
    setup.policies.push({ table, name, existedBefore })
    await pool.query(`CREATE POLICY "${name}" ON public."${table}" USING (${predicate}) WITH CHECK (${predicate})`)
  }
}

function restrictedTransactionPool(basePool: PgPool, roleName: string, userId: string, failOutboxForSession?: string): PgSubagentPool {
  return {
    async connect() {
      const client = await basePool.connect()
      const transactionScopedClient = new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return (...args: unknown[]) => {
              const query = args[0]
              const sql = typeof query === "string" ? query.trim().toUpperCase() : ""
              const result: unknown = Reflect.apply(target.query, target, args)
              return Promise.resolve(result).then(async value => {
                if (sql === "BEGIN") {
                  await Reflect.apply(target.query, target, [`SET LOCAL ROLE "${roleName}"`])
                  await Reflect.apply(target.query, target, ["SELECT set_config('app.user_id', $1, true)", [userId]])
                  if (failOutboxForSession) {
                    await Reflect.apply(target.query, target, [
                      "SELECT set_config('applymate.task_graph_fail_session', $1, true)", [failOutboxForSession],
                    ])
                  }
                }
                return value
              })
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      return transactionScopedClient
    },
  }
}

function restrictedRolePool(basePool: PgPool, roleName: string): PgSubagentPool {
  return {
    async connect() {
      const client = await basePool.connect()
      const scopedClient = new Proxy(client, {
        get(target, property) {
          if (property === "query") {
            return (...args: unknown[]) => {
              const result: unknown = Reflect.apply(target.query, target, args)
              const sql = typeof args[0] === "string" ? args[0].trim().toUpperCase() : ""
              if (sql !== "BEGIN") return result
              return Promise.resolve(result).then(async value => {
                await Reflect.apply(target.query, target, [`SET LOCAL ROLE "${roleName}"`])
                return value
              })
            }
          }
          const value: unknown = Reflect.get(target, property, target)
          return typeof value === "function" ? value.bind(target) : value
        },
      })
      return scopedClient
    },
  }
}

describeWithPostgres("PostgreSQL TaskGraph command port (P3 acceptance slice)", () => {
  const owner = fixture()
  const additionalFixtures: Fixture[] = []
  const roleName = `applymate_task_graph_${randomUUID().replaceAll("-", "")}`
  const policyPrefix = `tg_${randomUUID().replaceAll("-", "").slice(0, 16)}`
  let adminPool: PgPool | undefined
  let commandPool: PgPool | undefined
  const setup: SetupState = {
    originalRls: new Map<string, boolean>(),
    policies: [],
    shouldDropUserIdFunction: false,
    shouldDropRole: false,
  }

  beforeAll(async () => {
    adminPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    const roleState = await adminPool.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`, [roleName])
    const roleExisted = roleState.rows[0]?.exists
    if (roleExisted === undefined) throw new Error("TaskGraph RLS setup could not observe the test role")
    setup.shouldDropRole = !roleExisted
    await adminPool.query(`CREATE ROLE "${roleName}" NOLOGIN NOINHERIT NOSUPERUSER NOBYPASSRLS`)
    await adminPool.query(`GRANT USAGE ON SCHEMA public TO "${roleName}"`)
    await installTaskGraphTenantRls(adminPool, policyPrefix, setup)
    await adminPool.query(`GRANT EXECUTE ON FUNCTION public.app_current_user_id() TO "${roleName}"`)
    await adminPool.query(`GRANT SELECT ON "agent_sessions", "agent_turns", "sub_agent_tasks", "agent_steps", "agent_items", "agent_events", "agent_outbox", "agent_inputs" TO "${roleName}"`)
    await adminPool.query(`GRANT SELECT ON "agent_tree_budget_reservations", "agent_native_semantic_rejections", "agent_mailbox_messages",
      "agent_mailbox_hydration_checkpoints", "agent_tool_result_references", "agent_wait_conditions", "agent_transcript_events",
      "agent_approvals", "agent_artifact_version", "agent_artifact_review", "application_tasks" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("id") ON "agent_turns" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("id") ON "agent_steps" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("eventSequence") ON "agent_sessions" TO "${roleName}"`)
    await adminPool.query(`GRANT INSERT ON "sub_agent_tasks" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("status", "nextAttemptAt", "completedAt", "updatedAt") ON "sub_agent_tasks" TO "${roleName}"`)
    await adminPool.query(`GRANT INSERT ON "agent_items" TO "${roleName}"`)
    await adminPool.query(`GRANT UPDATE ("stepId", "revision", "content", "status", "completedAt", "updatedAt") ON "agent_items" TO "${roleName}"`)
    await adminPool.query(`GRANT INSERT ON "agent_events", "agent_outbox" TO "${roleName}"`)
    await adminPool.query(`GRANT DELETE ON "agent_outbox" TO "${roleName}"`)
    await seed(adminPool, owner)
    commandPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
  })

  afterAll(async () => {
    const failures: Error[] = []
    const attempt = async (label: string, action: () => Promise<unknown>): Promise<void> => {
      try {
        await action()
      } catch (cause) {
        failures.push(new Error(`TaskGraph integration cleanup failed to ${label}: ${String(cause)}`))
      }
    }

    if (commandPool) await attempt("close command pool", () => commandPool!.end())
    if (adminPool) {
      const fixtures = [owner, ...additionalFixtures]
      const sessionIds = fixtures.flatMap(value => [value.sessionId, value.foreignSessionId])
      const userIds = fixtures.flatMap(value => [value.userId, value.foreignUserId])
      await attempt("delete fixture outbox rows", () => adminPool!.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [sessionIds]))
      await attempt("delete fixture users and cascaded rows", () => adminPool!.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [userIds]))
      for (const policy of setup.policies) {
        if (!policy.existedBefore) {
          await attempt(`drop policy ${policy.name}`, () => adminPool!.query(`DROP POLICY IF EXISTS "${policy.name}" ON public."${policy.table}"`))
        }
      }
      for (const table of TENANT_TABLES) {
        const previouslyEnabled = setup.originalRls.get(table)
        if (previouslyEnabled !== undefined) {
          const action = previouslyEnabled ? "ENABLE" : "DISABLE"
          await attempt(`restore RLS state for ${table}`, () => adminPool!.query(`ALTER TABLE public."${table}" ${action} ROW LEVEL SECURITY`))
        }
      }
      if (setup.shouldDropRole) {
        let roleExists = false
        await attempt("check for test role", async () => {
          const result = await adminPool!.query<{ exists: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists`, [roleName])
          roleExists = result.rows[0]?.exists === true
        })
        if (roleExists) await attempt("drop test role privileges", () => adminPool!.query(`DROP OWNED BY "${roleName}"`))
        await attempt("drop test role", () => adminPool!.query(`DROP ROLE IF EXISTS "${roleName}"`))
      }
      if (setup.shouldDropUserIdFunction) {
        await attempt("drop test helper function", () => adminPool!.query(`DROP FUNCTION IF EXISTS public.app_current_user_id()`))
      }
      await attempt("close admin pool", () => adminPool!.end())
    }
    if (failures.length > 0) throw new AggregateError(failures, "TaskGraph PostgreSQL integration cleanup was incomplete")
  })

  it("persists and freshly reads an 8-node untyped depth-8 graph, replays once, and fences foreign scope", async () => {
    const selectedId = selectedJobId(owner)
    await adminPool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [owner.turnId,
      JSON.stringify({ selectedJobPreparation: { jobId: selectedId } })])
    const lease: TurnLease = {
      turnId: owner.turnId, sessionId: owner.sessionId, userId: owner.userId, ownerId: owner.turnLeaseOwner,
      leaseVersion: 1, leaseStartedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000),
    }
    const preparation = await loadSelectedJobPreparation(commandPool!, lease)
    if (!preparation || preparation.jobId !== selectedId) throw new Error("selected-job preparation was not owner-validated")
    const input = scheduleInput(owner, 8, false, preparation)
    const rootAllowedActions = selectedJobRootAllowedActions(input.templates)
    const templateActions = Object.values(input.templates).flatMap(template => template.allowedActions)
    expect(templateActions.every(action => rootAllowedActions.includes(action))).toBe(true)
    const actionGrant = await adminPool!.query(
      `UPDATE "sub_agent_tasks" SET "allowedActions" = $4::jsonb
       WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1
         AND "parentTaskId" IS NULL AND "leaseOwner" = $5 AND "attemptCount" = 1
         AND "status" = 'running' AND "leaseExpiresAt" > CURRENT_TIMESTAMP`,
      [owner.rootTaskId, owner.sessionId, owner.turnId, JSON.stringify(rootAllowedActions), owner.parentLeaseOwner],
    )
    expect(actionGrant.rowCount).toBe(1)
    await seedReconciliationAgenda(adminPool!, owner, {
      id: owner.stepId, sequence: await nextEventSequence(adminPool!, owner), cursor: 0n, planRevision: 0,
      consumedInputIds: [],
    })
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, owner.userId))
    const emptyRows = await graphRows(adminPool!, owner)

    const roleProbe = await commandPool!.connect()
    try {
      await roleProbe.query("BEGIN")
      await roleProbe.query(`SET LOCAL ROLE "${roleName}"`)
      await roleProbe.query("SELECT set_config('app.user_id', $1, true)", [owner.userId])
      const roleState = await roleProbe.query<{ tenantScope: string; roleName: string; isSuperuser: boolean; bypassesRls: boolean; tableName: string; ownsTable: boolean; tableRlsEnabled: boolean; rowSecurityActive: boolean }>(`SELECT current_setting('app.user_id', true) AS "tenantScope", role.rolname AS "roleName", role.rolsuper AS "isSuperuser", role.rolbypassrls AS "bypassesRls",
          relation.relname AS "tableName", pg_get_userbyid(relation.relowner) = current_user AS "ownsTable",
          relation.relrowsecurity AS "tableRlsEnabled", row_security_active(relation.oid) AS "rowSecurityActive"
        FROM pg_roles AS role CROSS JOIN pg_class AS relation
        WHERE role.rolname = current_user AND relation.oid = ANY(ARRAY[
          'public."agent_sessions"'::regclass, 'public."agent_turns"'::regclass, 'public."sub_agent_tasks"'::regclass,
          'public."agent_steps"'::regclass, 'public."agent_items"'::regclass, 'public."agent_events"'::regclass,
          'public."agent_outbox"'::regclass, 'public."agent_inputs"'::regclass
        ]) ORDER BY relation.relname`)
      expect(roleState.rows).toEqual([...TENANT_TABLES].sort().map(tableName => ({
        tenantScope: owner.userId, roleName, isSuperuser: false, bypassesRls: false, tableName, ownsTable: false,
        tableRlsEnabled: true, rowSecurityActive: true,
      })))
      const turnLockPrivileges = await roleProbe.query<{ canLockTurn: boolean; canRewriteLease: boolean }>(`SELECT
          has_column_privilege(current_user, 'public."agent_turns"', 'id', 'UPDATE') AS "canLockTurn",
          has_column_privilege(current_user, 'public."agent_turns"', 'leaseOwnerId', 'UPDATE') AS "canRewriteLease"`)
      expect(turnLockPrivileges.rows).toEqual([{ canLockTurn: true, canRewriteLease: false }])
      const stepLockPrivileges = await roleProbe.query<{
        canLockStep: boolean
        canRewriteStepStatus: boolean
        canRewriteStepSnapshot: boolean
      }>(`SELECT
          has_column_privilege(current_user, 'public."agent_steps"', 'id', 'UPDATE') AS "canLockStep",
          has_column_privilege(current_user, 'public."agent_steps"', 'status', 'UPDATE') AS "canRewriteStepStatus",
          has_column_privilege(current_user, 'public."agent_steps"', 'modelProfileSnapshot', 'UPDATE') AS "canRewriteStepSnapshot"`)
      expect(stepLockPrivileges.rows).toEqual([{
        canLockStep: true, canRewriteStepStatus: false, canRewriteStepSnapshot: false,
      }])
      const foreignRows: ReadonlyArray<{ table: typeof TENANT_TABLES[number]; id: string }> = [
        { table: "agent_sessions", id: owner.foreignSessionId },
        { table: "agent_turns", id: owner.foreignTurnId },
        { table: "sub_agent_tasks", id: owner.foreignRootTaskId },
        { table: "agent_steps", id: owner.foreignStepId },
        { table: "agent_items", id: owner.foreignItemId },
        { table: "agent_events", id: owner.foreignEventId },
        { table: "agent_outbox", id: owner.foreignOutboxId },
        { table: "agent_inputs", id: owner.foreignInputId },
      ]
      for (const { table, id } of foreignRows) {
        const seeded = await adminPool!.query(`SELECT "id" FROM public."${table}" WHERE "id" = $1`, [id])
        expect(seeded.rows, `${table} foreign fixture is present`).toEqual([{ id }])
        const hidden = await roleProbe.query(`SELECT "id" FROM public."${table}" WHERE "id" = $1`, [id])
        expect(hidden.rows, `${table} foreign fixture is hidden from the owner scope`).toEqual([])
      }
    } finally {
      await roleProbe.query("ROLLBACK")
      roleProbe.release()
    }

    const foreignUser = { ...input, scope: { ...input.scope, userId: owner.foreignUserId } }
    await expect(command.appendAndSchedule(foreignUser)).rejects.toThrow("task_graph_session_fenced")
    const wrongSession = { ...input, scope: { ...input.scope, sessionId: owner.foreignSessionId } }
    await expect(command.appendAndSchedule(wrongSession)).rejects.toThrow("task_graph_session_fenced")
    const wrongTurn = { ...input, scope: { ...input.scope, turnId: `foreign-${owner.turnId}` } }
    await expect(command.appendAndSchedule(wrongTurn)).rejects.toThrow("task_graph_turn_fenced")
    const wrongRoot = {
      ...input,
      scope: { ...input.scope, rootTaskId: `foreign-${owner.rootTaskId}`, parentTaskId: `foreign-${owner.rootTaskId}` },
    }
    await expect(command.appendAndSchedule(wrongRoot)).rejects.toThrow("task_graph_turn_fenced")
    const staleTurnLease = { ...input, scope: { ...input.scope, turnLeaseOwner: "stale-turn-owner" } }
    await expect(command.appendAndSchedule(staleTurnLease)).rejects.toThrow("task_graph_turn_fenced")
    const staleTurnVersion = { ...input, scope: { ...input.scope, turnLeaseVersion: 2 } }
    await expect(command.appendAndSchedule(staleTurnVersion)).rejects.toThrow("task_graph_turn_fenced")
    await adminPool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`, [owner.turnId])
    try {
      await expect(command.appendAndSchedule(input)).rejects.toThrow("task_graph_turn_fenced")
    } finally {
      await adminPool!.query(`UPDATE "agent_turns" SET "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "id" = $1`, [owner.turnId])
    }
    const staleParentLease = { ...input, scope: { ...input.scope, parentLeaseOwner: "stale-parent-owner" } }
    await expect(command.appendAndSchedule(staleParentLease)).rejects.toThrow("task_graph_parent_fenced")
    const staleParentAttempt = { ...input, scope: { ...input.scope, parentAttemptCount: 2 } }
    await expect(command.appendAndSchedule(staleParentAttempt)).rejects.toThrow("task_graph_parent_fenced")
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = $1`, [owner.rootTaskId])
    try {
      await expect(command.appendAndSchedule(input)).rejects.toThrow("task_graph_parent_fenced")
    } finally {
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes' WHERE "id" = $1`, [owner.rootTaskId])
    }
    expect(await graphRows(adminPool!, owner)).toEqual(emptyRows)

    const accepted = await command.appendAndSchedule(input)
    expect(accepted).toMatchObject({
      status: "accepted", revision: 1,
      nodes: [{ key: "task-1", status: "queued" }, ...Array.from({ length: 7 }, (_, index) => ({ key: `task-${index + 2}`, status: "waiting" }))],
    })
    expect(Buffer.byteLength(JSON.stringify(input.proposal), "utf8")).toBeLessThanOrEqual(TASK_GRAPH_LIMITS.maxProposalBytes)
    expect(accepted.nodes).toHaveLength(8)
    expect(accepted.readyTaskIds).toEqual([accepted.nodes[0]!.taskId])
    expect(accepted.nodes[7]!.taskId).not.toBe(accepted.nodes[0]!.taskId)

    const childRows = await adminPool!.query<{ goal: string; status: string }>(
      `SELECT "goal", "status" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "goal"`,
      [owner.sessionId, owner.rootTaskId],
    )
    expect(childRows.rows).toEqual(Array.from({ length: 8 }, (_, index) => ({
      goal: `Complete graph task ${index + 1}`,
      status: index === 0 ? "queued" : "waiting",
    })))
    const dispatchRows = await adminPool!.query<{ payload: unknown }>(
      `SELECT "payload" FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1`,
      [owner.sessionId],
    )
    expect(dispatchRows.rows).toHaveLength(1)
    expect(dispatchRows.rows[0]!.payload).toMatchObject({ taskId: accepted.readyTaskIds[0], sessionId: owner.sessionId, rootTaskId: owner.rootTaskId })

    const beforeReplay = await graphRows(adminPool!, owner)
    await commandPool!.end()
    commandPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const reopened = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, owner.userId))
    const freshlyRead = await reopened.readCurrent(readScope(owner))
    expect(freshlyRead.revision).toBe(1)
    expect(freshlyRead.nodes).toHaveLength(8)
    expect(freshlyRead.nodes.every(node => node.verificationCriterionIds === undefined)).toBe(true)
    expect(freshlyRead.nodes[0]).toMatchObject({ key: "task-1", taskId: accepted.nodes[0]!.taskId, status: "queued", readiness: "ready" })
    expect(freshlyRead.nodes[7]).toMatchObject({ key: "task-8", taskId: accepted.nodes[7]!.taskId, dependsOn: ["task-7"], status: "waiting", readiness: "waiting_for_dependencies" })
    const snapshotRow = await adminPool!.query<{ content: unknown }>(
      `SELECT "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "type" = 'task_graph'`,
      [taskGraphItemId(owner.rootTaskId), owner.sessionId],
    )
    const persistedSnapshot = snapshotRow.rows[0]?.content as { nodes?: Array<{ depth: number }> } | undefined
    expect(persistedSnapshot?.nodes?.map(node => node.depth)).toEqual(Array.from({ length: 8 }, (_, index) => index + 1))
    expect(Buffer.byteLength(canonicalTaskGraphJson(persistedSnapshot), "utf8")).toBeLessThanOrEqual(TASK_GRAPH_LIMITS.maxSnapshotBytes)

    const duplicate = await reopened.appendAndSchedule(input)
    expect(duplicate).toEqual({ ...accepted, status: "duplicate" })
    expect(await graphRows(adminPool!, owner)).toEqual(beforeReplay)
    const planEvents = await adminPool!.query(
      `SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`,
      [owner.sessionId, taskGraphProposalKey(owner.rootTaskId, 0)],
    )
    expect(planEvents.rows).toHaveLength(1)
    expect(beforeReplay.item).toEqual([{ id: taskGraphItemId(owner.rootTaskId), revision: 1 }])
  }, 60_000)

  it("reconstructs source freshness from the persisted proposal Step after a Worker restart", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const analyst = TASK_GRAPH_TEMPLATES.analyst
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $2::jsonb WHERE "id" = $1`, [
      value.rootTaskId, JSON.stringify(["agent.plan", ...analyst.allowedActions]),
    ])
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.stepId, sequence: await nextEventSequence(adminPool!, value), cursor: 0n, planRevision: 0,
      consumedInputIds: [],
    })
    const firstWorker = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const input = scheduleInput(value, 1, true)
    const accepted = await firstWorker.appendAndSchedule(input)
    expect(accepted.revision).toBe(1)

    await adminPool!.query(`UPDATE "agent_steps" SET "status" = 'completed', "completedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [value.stepId])
    const priorFollowUpInputId = `p3-task-graph-follow-up-${value.turnId}`
    const priorFollowUpStepId = `${value.originStepId}-prior`
    const priorFollowUpSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationStep(adminPool!, value, {
      id: priorFollowUpStepId, ordinal: 2, status: "completed", cursor: priorFollowUpSequence,
      consumedInputIds: [priorFollowUpInputId],
    })
    await seedReconciliationInput(adminPool!, value, {
      id: priorFollowUpInputId, clientMessageId: `${priorFollowUpInputId}-client`, delivery: "follow_up",
      sequence: priorFollowUpSequence, consumedByStepId: priorFollowUpStepId, text: "Keep the original user direction", disposition: "submitted",
    })
    await seedReconciliationAgenda(adminPool!, value, {
      id: priorFollowUpStepId, sequence: await nextEventSequence(adminPool!, value), cursor: priorFollowUpSequence,
      planRevision: 1, consumedInputIds: [priorFollowUpInputId],
    })
    const currentSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationStep(adminPool!, value, {
      id: value.originStepId, ordinal: 3, status: "streaming", cursor: currentSequence,
      consumedInputIds: [priorFollowUpInputId, value.firstSteerInputId],
    })
    await seedReconciliationInput(adminPool!, value, {
      id: value.firstSteerInputId, clientMessageId: value.firstSteerClientMessageId, delivery: "steer",
      sequence: currentSequence, consumedByStepId: value.originStepId, text: "Use the newer accepted direction", disposition: "steered",
    })
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.originStepId, sequence: await nextEventSequence(adminPool!, value), cursor: currentSequence,
      planRevision: 1, consumedInputIds: [priorFollowUpInputId, value.firstSteerInputId],
    })

    // A new command-port instance models reconstruction by a restarted Worker.
    const restartedWorker = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const planning = await restartedWorker.readCurrentForPlanning!(readScope(value))
    expect(planning.current.sourceIntent).toEqual([{
      nodeKey: "task-1", goal: "Complete graph task 1", successCriteria: ["Task 1 completed"],
      inputRelation: "predates_current_inputs",
    }])
    expect(planning.currentInputCheckpoint).toEqual({ inputThroughSequence: currentSequence })
    expect(JSON.stringify(planning.current)).not.toMatch(/inputThroughSequence|consumedInputIds|firstSteer|originStepId/)
    expect(await restartedWorker.readCurrent(readScope(value))).not.toHaveProperty("sourceIntent")

    const malformedCheckpoint = await adminPool!.query(`UPDATE "agent_steps" SET "consumedInputIds" = '[]'::jsonb
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "status" = 'completed'`,
    [priorFollowUpStepId, value.sessionId, value.turnId, value.rootTaskId])
    expect(malformedCheckpoint.rowCount).toBe(1)
    const malformedPlanning = await restartedWorker.readCurrentForPlanning!(readScope(value))
    expect(malformedPlanning.currentInputCheckpoint).toBeNull()
    expect(malformedPlanning.current.sourceIntent).toEqual([{
      nodeKey: "task-1", goal: "Complete graph task 1", successCriteria: ["Task 1 completed"], inputRelation: "unknown",
    }])
  }, 60_000)

  it("serializes competing Writers for one completed Reviewer and leaves rejected reuse without durable writes", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const selectedId = selectedJobId(value)
    await adminPool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [value.turnId,
      JSON.stringify({ selectedJobPreparation: { jobId: selectedId } })])
    const lease: TurnLease = {
      turnId: value.turnId, sessionId: value.sessionId, userId: value.userId, ownerId: value.turnLeaseOwner,
      leaseVersion: 1, leaseStartedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000),
    }
    const preparation = await loadSelectedJobPreparation(commandPool!, lease)
    if (!preparation || preparation.jobId !== selectedId) throw new Error("selected-job preparation was not owner-validated")
    const baseInput = scheduleInput(value, 1, false, preparation)
    const rootAllowedActions = selectedJobRootAllowedActions(baseInput.templates)
    const templateActions = Object.values(baseInput.templates).flatMap(template => template.allowedActions)
    expect(templateActions.every(action => rootAllowedActions.includes(action))).toBe(true)
    const actionGrant = await adminPool!.query(
      `UPDATE "sub_agent_tasks" SET "allowedActions" = $4::jsonb
       WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $1
         AND "parentTaskId" IS NULL AND "leaseOwner" = $5 AND "attemptCount" = 1
         AND "status" = 'running' AND "leaseExpiresAt" > CURRENT_TIMESTAMP`,
      [value.rootTaskId, value.sessionId, value.turnId, JSON.stringify(rootAllowedActions), value.parentLeaseOwner],
    )
    expect(actionGrant.rowCount).toBe(1)
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.stepId, sequence: await nextEventSequence(adminPool!, value), cursor: 0n, planRevision: 0,
      consumedInputIds: [],
    })

    const racingPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    try {
      const command = createPgTaskGraphCommandPort(restrictedTransactionPool(racingPool, roleName, value.userId))
      const initialReviewer = await command.appendAndSchedule({
        ...baseInput,
        proposal: { expectedRevision: 0, nodes: [{
          key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft",
          successCriteria: ["Persist a review receipt"], dependsOn: [],
        }] },
      })
      expect(initialReviewer).toMatchObject({ status: "accepted", revision: 1, nodes: [{ key: "reviewer", status: "queued" }] })
      const completedReviewer = await adminPool!.query(
        `UPDATE "sub_agent_tasks" SET "status" = 'completed', "result" = $4::jsonb, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 AND "status" = 'queued'`,
        [initialReviewer.nodes[0]!.taskId, value.sessionId, value.rootTaskId, JSON.stringify(completedReviewerResultEnvelope())],
      )
      expect(completedReviewer.rowCount).toBe(1)

      const writerPlan = (key: string): TaskGraphScheduleInput => ({
        ...baseInput,
        proposal: { expectedRevision: 1, nodes: [{
          key, templateId: "cover_letter_writer", goal: `Draft using completed Reviewer ${key}`,
          successCriteria: ["Persist the selected-job draft"], dependsOn: ["reviewer"],
        }] },
      })
      const competingPlans = [writerPlan("writer-a"), writerPlan("writer-b")]
      const results = await Promise.allSettled(competingPlans.map(plan => command.appendAndSchedule(plan)))
      const accepted = results.filter((result): result is PromiseFulfilledResult<TaskGraphScheduleReceipt> => result.status === "fulfilled")
      const rejected = results.filter((result): result is PromiseRejectedResult => result.status === "rejected")
      expect(accepted).toHaveLength(1)
      expect(accepted[0]!.value).toMatchObject({ status: "accepted", revision: 2 })
      expect(rejected).toHaveLength(1)
      // Different proposals at the same expected revision share an idempotency key, so the competing loser is rejected as an idempotency conflict.
      expect(rejected[0]!.reason).toMatchObject({ code: "idempotency_conflict" })

      const afterRace = await durableGraphRows(adminPool!, value)
      expect(afterRace.children).toHaveLength(2)
      expect(afterRace.item).toMatchObject([{ id: taskGraphItemId(value.rootTaskId), revision: 2 }])
      expect(afterRace.events).toHaveLength(2)
      expect(afterRace.outbox).toHaveLength(4)
      const persistedWriters = await adminPool!.query<{ id: string; status: string; allowedActions: string[] }>(
        `SELECT "id", "status", "allowedActions" FROM "sub_agent_tasks"
         WHERE "sessionId" = $1 AND "parentTaskId" = $2 AND "role" = 'writer' ORDER BY "id"`,
        [value.sessionId, value.rootTaskId],
      )
      expect(persistedWriters.rows).toHaveLength(1)
      expect(persistedWriters.rows[0]!.status).toBe("queued")
      expect(persistedWriters.rows[0]!.allowedActions).toEqual(baseInput.templates.cover_letter_writer!.allowedActions)
      expect(persistedWriters.rows[0]!.allowedActions.every(action => rootAllowedActions.includes(action))).toBe(true)
      const graphAfterRace = await command.readCurrent(readScope(value))
      const writerAfterRace = graphAfterRace.nodes.filter(node => node.templateId === "cover_letter_writer")
      expect(writerAfterRace).toHaveLength(1)
      expect(writerAfterRace[0]!.dependsOn).toEqual(["reviewer"])

      const beforeReuse = await durableGraphRows(adminPool!, value)
      await expect(command.appendAndSchedule({
        ...baseInput,
        proposal: { expectedRevision: 2, nodes: [{
          key: "writer-reuse", templateId: "cover_letter_writer", goal: "Reuse the completed Reviewer",
          successCriteria: ["Persist another selected-job draft"], dependsOn: ["reviewer"],
        }] },
      })).rejects.toMatchObject({ code: "task_graph_writer_review_conflict" })
      expect(await durableGraphRows(adminPool!, value)).toEqual(beforeReuse)

      const freshReviewer = await command.appendAndSchedule({
        ...baseInput,
        proposal: { expectedRevision: 2, nodes: [{
          key: "reviewer-fresh", templateId: "cover_letter_reviewer", goal: "Review a fresh selected-job draft",
          successCriteria: ["Persist the fresh review receipt"], dependsOn: [],
        }] },
      })
      expect(freshReviewer).toMatchObject({ status: "accepted", revision: 3 })
      const completedFreshReviewer = await adminPool!.query(
        `UPDATE "sub_agent_tasks" SET "status" = 'completed', "result" = $4::jsonb, "updatedAt" = CURRENT_TIMESTAMP
         WHERE "id" = $1 AND "sessionId" = $2 AND "parentTaskId" = $3 AND "status" = 'queued'`,
        [freshReviewer.nodes[0]!.taskId, value.sessionId, value.rootTaskId, JSON.stringify(completedReviewerResultEnvelope())],
      )
      expect(completedFreshReviewer.rowCount).toBe(1)
      const freshWriter = await command.appendAndSchedule({
        ...baseInput,
        proposal: { expectedRevision: 3, nodes: [{
          key: "writer-fresh", templateId: "cover_letter_writer", goal: "Draft after the fresh Reviewer",
          successCriteria: ["Persist the fresh selected-job draft"], dependsOn: ["reviewer-fresh"],
        }] },
      })
      expect(freshWriter).toMatchObject({ status: "accepted", revision: 4 })
      const finalGraph = await command.readCurrent(readScope(value))
      const finalWriters = finalGraph.nodes.filter(node => node.templateId === "cover_letter_writer")
      expect(finalWriters).toHaveLength(2)
      expect(finalWriters.map(node => node.dependsOn)).toEqual([["reviewer"], ["reviewer-fresh"]])
    } finally {
      await racingPool.end()
    }
  }, 60_000)

  it("reserves the first typed repair slot across ordinary appends", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const emptyRows = await graphRows(adminPool!, value)

    await expect(command.appendAndSchedule(scheduleInput(value, 8, true))).rejects.toMatchObject({ code: "node_limit" })
    expect(await graphRows(adminPool!, value)).toEqual(emptyRows)
    expect(await command.readCurrent(readScope(value))).toMatchObject({ revision: 0, nodes: [] })

    const sevenInput = scheduleInput(value, 7, true)
    const accepted = await command.appendAndSchedule(sevenInput)
    expect(accepted).toMatchObject({ status: "accepted", revision: 1 })
    expect(accepted.nodes).toHaveLength(7)
    expect(accepted.readyTaskIds).toEqual([accepted.nodes[0]!.taskId])
    const sevenRows = await graphRows(adminPool!, value)

    const ordinaryAppend: TaskGraphScheduleInput = {
      ...sevenInput,
      proposal: {
        ...sevenInput.proposal,
        expectedRevision: accepted.revision,
        nodes: [{
          key: "ordinary-eighth",
          templateId: "analyst",
          goal: "Add another ordinary typed task",
          successCriteria: ["Return one finding"],
          verification: ANALYST_VERIFICATION,
          dependsOn: [],
        }],
      },
    }
    await expect(command.appendAndSchedule(ordinaryAppend)).rejects.toMatchObject({ code: "node_limit" })
    expect(await graphRows(adminPool!, value)).toEqual(sevenRows)
  }, 60_000)

  it("caps scheduled source snapshots at four Scouts without changing ordinary TaskGraph capacity", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const scheduledSnapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["Software Engineer"],
      targetLocations: ["Dublin"], minScore: 70, dailyCap: 10, requireApproval: true, autoApply: false }
    await adminPool!.query(`UPDATE "agent_turns" SET "source" = 'automation', "executionMode" = 'canonical_task_graph', "input" = $2::jsonb WHERE "id" = $1`,
      [value.turnId, JSON.stringify({ automationRunMode: "scheduled", scheduledAutomationSnapshot: scheduledSnapshot })])
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const scope = scheduleInput(value, 1, true).scope
    const templates = {
      scout: { ...TASK_GRAPH_TEMPLATES.scout, allowedActions: [] },
      analyst: { ...TASK_GRAPH_TEMPLATES.analyst, allowedActions: [] },
    }
    const plan = (expectedRevision: number, first: number, count: number): TaskGraphScheduleInput => ({ scope, templates,
      proposal: { expectedRevision, nodes: Array.from({ length: count }, (_, index) => ({ key: `scout-${first + index}`,
        templateId: "scout", goal: "Discover candidates for the schedule", successCriteria: ["Return candidates"],
        verification: SCHEDULED_DRAFT_SCOUT_VERIFICATION, dependsOn: [] })) } })
    const accepted = await command.appendAndSchedule(plan(0, 1, 4))
    expect(accepted).toMatchObject({ status: "accepted", revision: 1 })
    expect(accepted.nodes).toHaveLength(4)
    const beforeFifth = await durableGraphRows(adminPool!, value)
    await expect(command.appendAndSchedule(plan(accepted.revision, 5, 1))).rejects.toMatchObject({ code: "node_limit" })
    expect(await durableGraphRows(adminPool!, value)).toEqual(beforeFifth)
    expect(await command.readCurrent(readScope(value))).toMatchObject({ revision: 1, nodes: expect.arrayContaining([
      expect.objectContaining({ key: "scout-1" }), expect.objectContaining({ key: "scout-2" }),
      expect.objectContaining({ key: "scout-3" }), expect.objectContaining({ key: "scout-4" }),
    ]) })

    const scoutKeys = ["scout-1", "scout-2", "scout-3", "scout-4"]
    const advanced = await command.appendAndSchedule({ scope, templates, proposal: { expectedRevision: accepted.revision, nodes: [{
      key: "analyst-after-scouts", templateId: "analyst", goal: "Analyze the scheduled Scout union",
      successCriteria: ["Return findings from the selected Scouts"], verification: scheduledDraftAnalystVerification(true, scoutKeys, "membership"),
      dependsOn: scoutKeys,
    }] } })
    expect(advanced).toMatchObject({ status: "accepted", revision: 2, nodes: [{ key: "analyst-after-scouts", status: "waiting" }] })
    const beforeReplay = await durableGraphRows(adminPool!, value)
    await expect(command.appendAndSchedule(plan(0, 1, 4))).resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await durableGraphRows(adminPool!, value)).toEqual(beforeReplay)

    const ordinary = fixture()
    additionalFixtures.push(ordinary)
    await seed(adminPool!, ordinary)
    const ordinaryCommand = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, ordinary.userId))
    const ordinaryScope = scheduleInput(ordinary, 1, true).scope
    const ordinaryReceipt = await ordinaryCommand.appendAndSchedule({ scope: ordinaryScope, templates,
      proposal: { expectedRevision: 0, nodes: Array.from({ length: 5 }, (_, index) => ({ key: `ordinary-scout-${index + 1}`,
        templateId: "scout", goal: "Discover candidates", successCriteria: ["Return candidates"],
        verification: SCHEDULED_DRAFT_SCOUT_VERIFICATION, dependsOn: [] })) } })
    expect(ordinaryReceipt).toMatchObject({ status: "accepted", revision: 1 })
    expect(ordinaryReceipt.nodes).toHaveLength(5)

    const superseded = fixture()
    additionalFixtures.push(superseded)
    const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, superseded, undefined, { initialScheduledScoutCount: 4 })
    const beforeSupersession = await prepared.command.readCurrent(readScope(superseded))
    expect(beforeSupersession.nodes).toHaveLength(4)
    expect(beforeSupersession.nodes.every(node => node.templateId === "scout")).toBe(true)
    const oldSourceTaskId = prepared.source.taskId
    const replacement = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    expect(replacement).toMatchObject({ status: "accepted", revision: 3, nodes: [{ key: "replacement-1", status: "queued" }] })
    const current = await prepared.command.readCurrent(readScope(superseded))
    expect(current.revision).toBe(3)
    expect(current.nodes).toHaveLength(4)
    expect(current.nodes.every(node => node.templateId === "scout")).toBe(true)
    expect(current.nodes.some(node => node.taskId === oldSourceTaskId || node.key === prepared.source.key)).toBe(false)
    expect(current.nodes.map(node => node.key)).toEqual(expect.arrayContaining(["task-2", "task-3", "task-4", "replacement-1"]))
    const persistedSources = await adminPool!.query<{ id: string; status: string; attemptCount: number }>(
      `SELECT "id", "status", "attemptCount" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 ORDER BY "id"`,
      [superseded.sessionId, superseded.rootTaskId])
    expect(persistedSources.rows).toHaveLength(5)
    expect(persistedSources.rows.find(row => row.id === oldSourceTaskId)).toMatchObject({ status: "cancelled", attemptCount: 0 })
  }, 60_000)

  it("rejects same-batch and active overlapping repairs before durable writes", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const target = await command.appendAndSchedule(scheduleInput(value, 1, true))
    expect(target).toMatchObject({ status: "accepted", revision: 1, nodes: [{ key: "task-1", status: "queued" }] })
    const targetTaskId = target.nodes[0]!.taskId
    await seedCanonicalFailedTarget(adminPool!, value, targetTaskId)
    const failedGraph = await command.readCurrent(readScope(value))
    expect(failedGraph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({
      key: "task-1", taskId: targetTaskId, status: "failed", verificationCriterionIds: ["finding-count"],
      verificationReport: expect.objectContaining({ status: "failed", criteria: [expect.objectContaining({
        criterionId: "finding-count", status: "failed", reasonCode: "criterion_not_met",
      })] }),
    })]))

    const beforeSameBatch = await repairDurableRows(adminPool!, value)
    const sameBatch = repairScheduleInput(value, target.revision, targetTaskId, ["same-batch-a", "same-batch-b"])
    await expect(command.appendAndSchedule(sameBatch)).rejects.toMatchObject({ code: "task_graph_repair_conflict" })
    expect(await repairDurableRows(adminPool!, value)).toEqual(beforeSameBatch)
    expect(await command.readCurrent(readScope(value))).toEqual(failedGraph)

    const activeRepair = await command.appendAndSchedule(repairScheduleInput(value, target.revision, targetTaskId, ["active-repair"]))
    expect(activeRepair).toMatchObject({ status: "accepted", revision: 2, nodes: [{ key: "active-repair", status: "queued" }] })
    const activeGraph = await command.readCurrent(readScope(value))
    expect(activeGraph.nodes.filter(node => node.repairOf !== undefined)).toHaveLength(1)
    const beforeOverlap = await repairDurableRows(adminPool!, value)
    const mixedBatch = repairScheduleInput(value, activeRepair.revision, targetTaskId, ["overlapping-repair"], true)
    expect(mixedBatch.proposal.nodes).toHaveLength(2)
    await expect(command.appendAndSchedule(mixedBatch)).rejects.toMatchObject({ code: "task_graph_repair_conflict" })
    expect(await repairDurableRows(adminPool!, value)).toEqual(beforeOverlap)
    expect(await command.readCurrent(readScope(value))).toEqual(activeGraph)
  }, 60_000)

  it("serializes distinct overlapping repair submissions to one durable attempt", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const target = await command.appendAndSchedule(scheduleInput(value, 1, true))
    expect(target).toMatchObject({ status: "accepted", revision: 1 })
    const targetTaskId = target.nodes[0]!.taskId
    await seedCanonicalFailedTarget(adminPool!, value, targetTaskId)
    expect((await command.readCurrent(readScope(value))).nodes[0]).toMatchObject({
      key: "task-1", taskId: targetTaskId, status: "failed", verificationReport: { status: "failed" },
    })
    const before = await repairDurableRows(adminPool!, value)
    const first = repairScheduleInput(value, target.revision, targetTaskId, ["race-repair-a"])
    const second = repairScheduleInput(value, target.revision, targetTaskId, ["race-repair-b"])
    const racingPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    try {
      const racingCommand = createPgTaskGraphCommandPort(restrictedTransactionPool(racingPool, roleName, value.userId))
      const results = await Promise.allSettled([
        racingCommand.appendAndSchedule(first), racingCommand.appendAndSchedule(second),
      ])
      const accepted = results.find(result => result.status === "fulfilled")
      const rejected = results.find(result => result.status === "rejected")
      if (!accepted || accepted.status !== "fulfilled" || !rejected || rejected.status !== "rejected") {
        throw new Error("TaskGraph repair race did not produce one accepted and one rejected submission")
      }
      expect(accepted.value).toMatchObject({ status: "accepted", revision: 2, nodes: [{ status: "queued" }] })
      expect(rejected.reason).toMatchObject({ code: "idempotency_conflict" })
    } finally {
      await racingPool.end()
    }

    const current = await command.readCurrent(readScope(value))
    const repairs = current.nodes.filter(node => node.repairOf !== undefined)
    expect(current.revision).toBe(2)
    expect(repairs).toHaveLength(1)
    expect(["race-repair-a", "race-repair-b"]).toContain(repairs[0]!.key)
    const after = await repairDurableRows(adminPool!, value)
    const acceptedRepair = repairs[0]!
    const acceptedPlanKey = taskGraphProposalKey(value.rootTaskId, 1)
    const addedOutbox = after.outbox.filter(row => !before.outbox.some(previous => previous.idempotencyKey === row.idempotencyKey))
    expect(after.children).toHaveLength(before.children.length + 1)
    expect(after.item[0]?.revision).toBe(2)
    expect(after.events).toHaveLength(before.events.length + 1)
    expect(after.outbox).toHaveLength(before.outbox.length + 2)
    expect(addedOutbox.map(row => row.topic).sort()).toEqual(["agent.session.event", "agent.subagent.dispatch"])
    const dispatchOutbox = addedOutbox.find(row => row.topic === "agent.subagent.dispatch")
    expect(dispatchOutbox).toMatchObject({
      aggregateId: value.sessionId,
      idempotencyKey: `subagent-dispatch:${acceptedRepair.taskId}`,
      payload: { taskId: acceptedRepair.taskId, sessionId: value.sessionId, rootTaskId: value.rootTaskId },
    })
    const acceptedPlanEvent = after.events.find(event => event.idempotencyKey === acceptedPlanKey)
    expect(acceptedPlanEvent).toMatchObject({
      itemId: taskGraphItemId(value.rootTaskId), taskId: value.rootTaskId, type: "item.delta",
      payload: { kind: "proposal", revision: 2, receipt: { status: "accepted", revision: 2, nodes: [{ key: acceptedRepair.key, taskId: acceptedRepair.taskId }] } },
    })
    const acceptedSequence = BigInt(String(acceptedPlanEvent!.sequence))
    const sequenceBefore = BigInt(String(before.sequence[0]?.eventSequence))
    expect(acceptedSequence).toBe(sequenceBefore + 1n)
    expect(addedOutbox.find(row => row.topic === "agent.session.event")).toMatchObject({
      aggregateId: value.sessionId,
      idempotencyKey: `agent-event:${acceptedPlanEvent!.id}`,
      payload: {
        eventId: acceptedPlanEvent!.id, sessionId: value.sessionId, turnId: value.turnId,
        itemId: taskGraphItemId(value.rootTaskId), taskId: value.rootTaskId, sequence: acceptedSequence.toString(), type: "item.delta",
        idempotencyKey: acceptedPlanKey,
        payload: { kind: "proposal", revision: 2, receipt: { status: "accepted", revision: 2, nodes: [{ key: acceptedRepair.key, taskId: acceptedRepair.taskId }] } },
      },
    })
    expect(BigInt(String(after.sequence[0]?.eventSequence))).toBe(acceptedSequence)
    expect(after.events.map(event => event.idempotencyKey).sort()).toEqual([
      taskGraphProposalKey(value.rootTaskId, 0), taskGraphProposalKey(value.rootTaskId, 1),
    ])
  }, 60_000)

  it("rolls back a native replacement denied by the typed graph reserve", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const nativeSource = await command.appendNativeCoordination!({
      scope: { ...readScope(value), stepId: value.stepId },
      request: {
        kind: "spawn", idempotencyKey: `reserved-native-source-${value.sessionId}`, role: "auditor", taskType: "audit",
        goal: "Create an eligible queued native source", constraints: ["read only"],
        successCriteria: ["Record findings"], context: { fixture: "reserved replacement source" },
      },
    })
    expect(nativeSource).toMatchObject({ status: "accepted", child: { role: "auditor", taskType: "audit", status: "queued" } })

    const sixInput = scheduleInput(value, 6, true)
    const typedAppend: TaskGraphScheduleInput = {
      ...sixInput, proposal: { ...sixInput.proposal, expectedRevision: nativeSource.graphRevision },
    }
    const accepted = await command.appendAndSchedule(typedAppend)
    expect(accepted).toMatchObject({ status: "accepted", revision: 2 })
    expect(accepted.nodes).toHaveLength(6)
    expect(await command.readCurrent(readScope(value))).toMatchObject({ revision: 2, nodes: expect.arrayContaining([
      expect.objectContaining({ taskId: nativeSource.child.taskId, status: "queued" }),
    ]) })
    expect((await command.readCurrent(readScope(value))).nodes.filter(node => node.verificationCriterionIds !== undefined)).toHaveLength(6)
    const beforeRows = await graphRows(adminPool!, value)
    const beforeGraph = await command.readCurrent(readScope(value))
    const beforeGraphItem = await adminPool!.query(
      `SELECT "revision", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "type" = 'task_graph'`,
      [taskGraphItemId(value.rootTaskId), value.sessionId],
    )
    const beforeNativeEvents = await adminPool!.query(
      `SELECT "id", "type", "idempotencyKey", "payload" FROM "agent_events"
        WHERE "sessionId" = $1 AND "payload"->>'kind' = 'native_command' ORDER BY "id"`,
      [value.sessionId],
    )
    const beforeSequence = await adminPool!.query(
      `SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [value.sessionId],
    )
    const beforeSource = await adminPool!.query(
      `SELECT "status", "attemptCount", "goal", "startedAt", "leaseOwner", "leaseExpiresAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [nativeSource.child.taskId, value.sessionId],
    )
    const nativeReplacement: TaskGraphNativeCommandInput = {
      scope: { ...readScope(value), stepId: value.stepId },
      request: {
        kind: "followup", idempotencyKey: `reserved-replacement-${value.sessionId}`,
        sourceTaskId: nativeSource.child.taskId, goal: "Replace the queued native source",
        mode: "replace_unstarted", expectedRevision: accepted.revision,
      },
    }
    await expect(command.appendNativeCoordination!(nativeReplacement))
      .rejects.toMatchObject({ code: "native_graph_node_invalid" })
    expect(await graphRows(adminPool!, value)).toEqual(beforeRows)
    expect(await command.readCurrent(readScope(value))).toEqual(beforeGraph)
    expect((await adminPool!.query(
      `SELECT "revision", "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "type" = 'task_graph'`,
      [taskGraphItemId(value.rootTaskId), value.sessionId],
    )).rows).toEqual(beforeGraphItem.rows)
    expect((await adminPool!.query(
      `SELECT "id", "type", "idempotencyKey", "payload" FROM "agent_events"
        WHERE "sessionId" = $1 AND "payload"->>'kind' = 'native_command' ORDER BY "id"`,
      [value.sessionId],
    )).rows).toEqual(beforeNativeEvents.rows)
    expect((await adminPool!.query(
      `SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [value.sessionId],
    )).rows).toEqual(beforeSequence.rows)
    expect((await adminPool!.query(
      `SELECT "status", "attemptCount", "goal", "startedAt", "leaseOwner", "leaseExpiresAt" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [nativeSource.child.taskId, value.sessionId],
    )).rows).toEqual(beforeSource.rows)
    const successorRows = await adminPool!.query<{ id: string }>(
      `SELECT "id" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "context"->'provenance'->>'sourceTaskId' = $2`,
      [value.sessionId, nativeSource.child.taskId],
    )
    expect(successorRows.rows).toEqual([])
  }, 60_000)

  it("replays a no-steer revise before ledger preparation and leaves later accepted steer unresolved", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = '["agent.plan"]'::jsonb WHERE "id" = $1`, [value.rootTaskId])
    await adminPool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [value.turnId, JSON.stringify({
      input: { goal: "Find roles", clientMessageId: value.originalClientMessageId },
    })])

    await seedReconciliationStep(adminPool!, value, {
      id: value.originStepId, ordinal: 0, status: "completed", cursor: 1n, consumedInputIds: [value.originalInputId],
    })
    const originalSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationInput(adminPool!, value, {
      id: value.originalInputId, clientMessageId: value.originalClientMessageId, delivery: "follow_up",
      sequence: originalSequence, consumedByStepId: value.originStepId, text: "Complete original user task reference", disposition: "submitted",
    })
    await adminPool!.query(`UPDATE "agent_steps" SET "inputThroughSequence" = $2, "consumedInputIds" = $3::jsonb WHERE "id" = $1`, [
      value.stepId, originalSequence.toString(), JSON.stringify([value.originalInputId]),
    ])
    const agendaSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.stepId, sequence: agendaSequence, cursor: originalSequence, planRevision: 0, consumedInputIds: [value.originalInputId],
    })
    const callSequence = await nextEventSequence(adminPool!, value)
    const input = scheduleInput(value, 7, true)
    const operation = { scope: input.scope, decision: "revise" as const, expectedRevision: 0, callId: value.planCallId, rootInputId: value.originalInputId }
    await seedReconciliationToolCall(adminPool!, value, {
      id: value.planCallId, stepId: value.stepId, toolName: "agent.plan", input: input.proposal, sequence: callSequence,
    })

    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const accepted = await command.appendAndScheduleWithReconciliation!(input, operation)
    expect(accepted).toMatchObject({ status: "accepted", revision: 1 })
    const graphAfterCommit = await graphRows(adminPool!, value)
    expect((await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [
      value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])).rows).toEqual([])

    const laterSequence = await nextEventSequence(adminPool!, value)
    await seedAcceptedReconciliationSteer(adminPool!, value, {
      id: value.secondSteerInputId, clientMessageId: value.secondSteerClientMessageId,
      sequence: laterSequence, text: "Keep the newly accepted requirement pending",
    })
    await expect(command.appendAndScheduleWithReconciliation!(input, operation)).resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await graphRows(adminPool!, value)).toEqual(graphAfterCommit)
    expect((await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [
      value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])).rows).toEqual([])
    expect((await adminPool!.query(`SELECT "status", "consumedByStepId" FROM "agent_inputs" WHERE "id" = $1`, [value.secondSteerInputId])).rows)
      .toEqual([{ status: "accepted", consumedByStepId: null }])
    await expect(transaction(restrictedTransactionPool(commandPool!, roleName, value.userId), client =>
      assertNoUnresolvedSteering(client, readScope(value)))).rejects.toThrow("steering_reconciliation_pending")
  }, 60_000)

  it("commits planner revise and keep receipts atomically, replaying only before a later Step consumes fresh steer", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = '["agent.plan"]'::jsonb WHERE "id" = $1`, [value.rootTaskId])
    await adminPool!.query(`UPDATE "agent_turns" SET "input" = $2::jsonb WHERE "id" = $1`, [value.turnId, JSON.stringify({
      input: { goal: "Find roles", clientMessageId: value.originalClientMessageId },
    })])

    await seedReconciliationStep(adminPool!, value, {
      id: value.originStepId, ordinal: 0, status: "completed", cursor: 1n, consumedInputIds: [value.originalInputId],
    })
    const originalSequence = await nextEventSequence(adminPool!, value)
    expect(originalSequence).toBe(1n)
    await seedReconciliationInput(adminPool!, value, {
      id: value.originalInputId, clientMessageId: value.originalClientMessageId, delivery: "follow_up",
      sequence: originalSequence, consumedByStepId: value.originStepId, text: "Complete original user task reference", disposition: "submitted",
    })
    const firstSteerSequence = await nextEventSequence(adminPool!, value)
    await adminPool!.query(`UPDATE "agent_steps" SET "inputThroughSequence" = $2, "consumedInputIds" = $3::jsonb WHERE "id" = $1`, [
      value.stepId, firstSteerSequence.toString(), JSON.stringify([value.originalInputId, value.firstSteerInputId]),
    ])
    await seedReconciliationInput(adminPool!, value, {
      id: value.firstSteerInputId, clientMessageId: value.firstSteerClientMessageId, delivery: "steer",
      sequence: firstSteerSequence, consumedByStepId: value.stepId, text: "Please also compare remote roles", disposition: "steered",
    })
    const planAgendaSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.stepId, sequence: planAgendaSequence, cursor: firstSteerSequence, planRevision: 0,
      consumedInputIds: [value.originalInputId, value.firstSteerInputId],
    })
    const planCallSequence = await nextEventSequence(adminPool!, value)
    const input = scheduleInput(value, 7, true)
    const planOperation = {
      scope: input.scope, decision: "revise" as const, expectedRevision: 0, callId: value.planCallId, rootInputId: value.originalInputId,
    }
    await seedReconciliationToolCall(adminPool!, value, {
      id: value.planCallId, stepId: value.stepId, toolName: "agent.plan", input: input.proposal, sequence: planCallSequence,
    })

    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const accepted = await command.appendAndScheduleWithReconciliation!(input, planOperation)
    expect(accepted).toMatchObject({ status: "accepted", revision: 1 })
    const firstReceipt = await adminPool!.query<{ id: string; payload: unknown }>(`SELECT "id", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "type" = $2 ORDER BY "sequence"`, [value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE])
    expect(firstReceipt.rows).toHaveLength(1)
    const receiptPayload = firstReceipt.rows[0]!.payload as { steerInputIds?: string[] }
    expect(receiptPayload.steerInputIds).toEqual([value.firstSteerInputId])
    expect(JSON.stringify(receiptPayload)).not.toContain("Please also compare remote roles")
    expect((await adminPool!.query(`SELECT "id" FROM "agent_outbox" WHERE "idempotencyKey" = $1`, [
      `agent-event:${firstReceipt.rows[0]!.id}`,
    ])).rows).toEqual([])
    const acceptedCounts = await graphRows(adminPool!, value)

    await commandPool!.end()
    commandPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const reopened = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, value.userId))
    await expect(reopened.appendAndScheduleWithReconciliation!(input, planOperation)).resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await graphRows(adminPool!, value)).toEqual(acceptedCounts)
    expect((await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [
      value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])).rows).toHaveLength(1)

    const secondSteerSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationStep(adminPool!, value, {
      id: value.keepStepId, ordinal: 2, status: "streaming", cursor: secondSteerSequence,
      consumedInputIds: [value.originalInputId, value.firstSteerInputId, value.secondSteerInputId],
    })
    await seedReconciliationInput(adminPool!, value, {
      id: value.secondSteerInputId, clientMessageId: value.secondSteerClientMessageId, delivery: "steer",
      sequence: secondSteerSequence, consumedByStepId: value.keepStepId, text: "Keep the plan and retain this requirement", disposition: "steered",
    })
    const keepAgendaSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.keepStepId, sequence: keepAgendaSequence, cursor: secondSteerSequence, planRevision: 1,
      consumedInputIds: [value.originalInputId, value.firstSteerInputId, value.secondSteerInputId],
    })
    const keepCallSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationToolCall(adminPool!, value, {
      id: value.keepCallId, stepId: value.keepStepId, toolName: "agent.reconcile",
      input: { decision: "keep", expectedRevision: 1 }, sequence: keepCallSequence,
    })

    await expect(reopened.appendAndScheduleWithReconciliation!(input, planOperation)).resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await graphRows(adminPool!, value)).toEqual(acceptedCounts)
    const receiptsAfterReplay = await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`, [
      value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])
    expect(receiptsAfterReplay.rows).toHaveLength(1)
    expect((await adminPool!.query(`SELECT "status", "consumedByStepId" FROM "agent_inputs" WHERE "id" = $1`, [value.secondSteerInputId])).rows)
      .toEqual([{ status: "consumed", consumedByStepId: value.keepStepId }])
    await expect(transaction(restrictedTransactionPool(commandPool!, roleName, value.userId), client =>
      assertNoUnresolvedSteering(client, readScope(value)))).rejects.toThrow("steering_reconciliation_pending")
    const rawRootPlan = { ...input, scope: { ...input.scope, stepId: value.keepStepId }, proposal: { ...input.proposal, expectedRevision: 1 } }
    await expect(reopened.appendAndSchedule(rawRootPlan)).rejects.toThrow("steering_reconciliation_pending")
    expect(await graphRows(adminPool!, value)).toEqual(acceptedCounts)
    const keep = await reopened.reconcileSteering!({
      scope: { ...input.scope, stepId: value.keepStepId }, decision: "keep", expectedRevision: 1,
      callId: value.keepCallId, rootInputId: value.originalInputId,
    })
    expect(keep).toEqual({ decision: "keep", revision: 1, reconciledInputCount: 1 })
    const receipts = await adminPool!.query<{ id: string; type: string; payload: unknown }>(`SELECT "id", "type", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "type" = $2 ORDER BY "sequence"`, [value.sessionId, STEERING_RECONCILIATION_EVENT_TYPE])
    expect(receipts.rows).toHaveLength(2)
    expect((receipts.rows[1]!.payload as { steerInputIds?: string[] }).steerInputIds).toEqual([value.secondSteerInputId])
    expect((await adminPool!.query(`SELECT "id" FROM "agent_outbox" WHERE "idempotencyKey" = ANY($1::text[])`, [
      receipts.rows.map(row => `agent-event:${row.id}`),
    ])).rows).toEqual([])
    expect((await reopened.readCurrent(readScope(value))).revision).toBe(1)
  }, 60_000)

  it("recovers an expired TaskGraph child lease across fresh Worker stores without losing or duplicating receipts", async () => {
    const recoveryOwner = fixture()
    additionalFixtures.push(recoveryOwner)
    await seed(adminPool!, recoveryOwner)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = jsonb_set(
      "budgetSnapshot", '{subagentPolicy,maxAttempts}', '3'::jsonb
    ) WHERE "id" = $1`, [recoveryOwner.rootTaskId])

    const input = {
      ...scheduleInput(recoveryOwner, 7, true),
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [], maxAttempts: 3 } },
    }
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, recoveryOwner.userId))
    const accepted = await command.appendAndSchedule(input)
    expect(accepted.status).toBe("accepted")
    const childTaskId = accepted.readyTaskIds[0]
    expect(childTaskId).toBeTruthy()
    const dispatchKey = `subagent-dispatch:${childTaskId}`
    const policy = { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 3 }
    const openStore = () => {
      const pool = new PgPool({ connectionString: databaseUrl!, max: 1 })
      return { pool, store: new PgSubagentTaskStore(pool) }
    }
    const activePools = new Set<PgPool>()
    const retirePool = async (pool: PgPool): Promise<void> => {
      await pool.end()
      activePools.delete(pool)
    }
    const markDispatchPublishedAndExpire = async (expectedAttemptCount: number): Promise<void> => {
      const published = await adminPool!.query<{ attemptCount: number }>(`UPDATE "agent_outbox"
        SET "publishedAt" = CURRENT_TIMESTAMP, "attemptCount" = "attemptCount" + 1,
            "lastError" = 'simulated dispatch delivery'
        WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2
          AND "publishedAt" IS NULL
        RETURNING "attemptCount"`, [recoveryOwner.sessionId, dispatchKey])
      expect(published.rows).toHaveLength(1)
      expect(Number(published.rows[0]!.attemptCount)).toBe(expectedAttemptCount)
      const expired = await adminPool!.query(`UPDATE "sub_agent_tasks"
        SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'running'`, [childTaskId, recoveryOwner.sessionId])
      expect(expired.rowCount).toBe(1)
    }

    try {
      const first = openStore()
      activePools.add(first.pool)
      const firstLease = await first.store.claim({
        taskId: childTaskId!, sessionId: recoveryOwner.sessionId, ownerId: "worker-before-restart",
        policy, now: new Date(),
      })
      expect(firstLease).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: "worker-before-restart" })
      await markDispatchPublishedAndExpire(1)
      await retirePool(first.pool)

      const second = openStore()
      activePools.add(second.pool)
      const firstRecovery = await second.store.recoverExpired({ now: new Date(), limit: 10 })
      expect(firstRecovery).toMatchObject([{ id: childTaskId, status: "queued", attemptCount: 1, leaseOwner: null, leaseExpiresAt: null }])
      const firstPersisted = await second.store.get(childTaskId!, recoveryOwner.sessionId)
      expect(firstPersisted).toMatchObject({ status: "queued", attemptCount: 1, leaseOwner: null, leaseExpiresAt: null })
      const firstDispatch = await adminPool!.query<{ attemptCount: number; publishedAt: Date | null; lastError: string | null }>(
        `SELECT "attemptCount", "publishedAt", "lastError" FROM "agent_outbox"
          WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
        [recoveryOwner.sessionId, dispatchKey],
      )
      expect(firstDispatch.rows).toMatchObject([{ attemptCount: 2, publishedAt: null, lastError: null }])
      await retirePool(second.pool)

      expect(firstRecovery[0]?.nextAttemptAt).toBeInstanceOf(Date)
      const retryAt = firstRecovery[0]!.nextAttemptAt!.getTime()
      const retryDelay = Math.max(0, retryAt - Date.now())
      if (retryDelay > 0) await new Promise(resolve => setTimeout(resolve, retryDelay + 100))

      const third = openStore()
      activePools.add(third.pool)
      const secondLease = await third.store.claim({
        taskId: childTaskId!, sessionId: recoveryOwner.sessionId, ownerId: "worker-after-restart",
        policy, now: new Date(),
      })
      expect(secondLease).toMatchObject({ status: "running", attemptCount: 2, leaseOwner: "worker-after-restart" })
      await markDispatchPublishedAndExpire(3)
      await retirePool(third.pool)

      const fourth = openStore()
      activePools.add(fourth.pool)
      const secondRecovery = await fourth.store.recoverExpired({ now: new Date(), limit: 10 })
      expect(secondRecovery).toMatchObject([{ id: childTaskId, status: "queued", attemptCount: 2, leaseOwner: null, leaseExpiresAt: null }])
      const finalPersisted = await fourth.store.get(childTaskId!, recoveryOwner.sessionId)
      expect(finalPersisted).toMatchObject({ status: "queued", attemptCount: 2, leaseOwner: null, leaseExpiresAt: null })

      const graph = await command.readCurrent(readScope(recoveryOwner))
      expect(graph.revision).toBe(5)
      expect(graph.nodes[0]).toMatchObject({ key: "task-1", taskId: childTaskId, status: "queued", readiness: "ready" })

      const timeline = await adminPool!.query<{ type: string; idempotencyKey: string | null; payload: unknown }>(
        `SELECT "type", "idempotencyKey", "payload" FROM "agent_events"
          WHERE "sessionId" = $1 AND "itemId" = $2 ORDER BY "sequence"`,
        [recoveryOwner.sessionId, taskGraphItemId(recoveryOwner.rootTaskId)],
      )
      const idempotencyKeys = timeline.rows.map(row => row.idempotencyKey)
      expect(timeline.rows).toHaveLength(5)
      expect(new Set(idempotencyKeys).size).toBe(5)
      expect(timeline.rows.map(row => {
        const payload = row.payload as { kind?: unknown; event?: { type?: unknown } }
        return payload.kind === "lifecycle" ? payload.event?.type : payload.kind
      })).toEqual(["proposal", "task.started", "task.retrying", "task.started", "task.retrying"])

      const item = await adminPool!.query<{ revision: number }>(
        `SELECT "revision" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "type" = 'task_graph'`,
        [taskGraphItemId(recoveryOwner.rootTaskId), recoveryOwner.sessionId],
      )
      expect(item.rows).toEqual([{ revision: 5 }])
      const dispatchRows = await adminPool!.query<{ idempotencyKey: string; attemptCount: number; publishedAt: Date | null; lastError: string | null }>(
        `SELECT "idempotencyKey", "attemptCount", "publishedAt", "lastError" FROM "agent_outbox"
          WHERE "topic" = 'agent.subagent.dispatch' AND "aggregateId" = $1 AND "idempotencyKey" = $2`,
        [recoveryOwner.sessionId, dispatchKey],
      )
      expect(dispatchRows.rows).toMatchObject([{ idempotencyKey: dispatchKey, attemptCount: 4, publishedAt: null, lastError: null }])
      const streamedEvents = await adminPool!.query<{ count: number; uniqueKeys: number }>(
        `SELECT COUNT(*)::int AS count, COUNT(DISTINCT "idempotencyKey")::int AS "uniqueKeys"
          FROM "agent_outbox" WHERE "topic" = 'agent.session.event' AND "aggregateId" = $1
            AND "payload"->>'itemId' = $2`,
        [recoveryOwner.sessionId, taskGraphItemId(recoveryOwner.rootTaskId)],
      )
      expect(streamedEvents.rows).toEqual([{ count: 5, uniqueKeys: 5 }])
    } finally {
      await Promise.all([...activePools].map(pool => pool.end()))
    }
  }, 60_000)

  it("pins the whole owned objective in the plan snapshot, replays it, and preserves it on later omission", async () => {
    const criteriaOwner = fixture()
    additionalFixtures.push(criteriaOwner)
    await seed(adminPool!, criteriaOwner, { goal: ROOT_TASK_GOAL, successCriteria: [] })
    const base = scheduleInput(criteriaOwner)
    const first = { ...base, proposal: { ...base.proposal, nodes: [base.proposal.nodes[0]!] }, rootSuccessCriteria: ["Include evidence for each result"] }
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, criteriaOwner.userId))

    const accepted = await command.appendAndSchedule(first)
    expect(accepted.status).toBe("accepted")
    const root = await adminPool!.query<{ goal: string; successCriteria: string[] }>(
      `SELECT "goal", "successCriteria" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [criteriaOwner.rootTaskId, criteriaOwner.sessionId],
    )
    expect(root.rows[0]?.successCriteria).toEqual([])
    const item = await adminPool!.query<{ content: { rootSuccessCriteria?: string[] } }>(
      `SELECT "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2`,
      [taskGraphItemId(criteriaOwner.rootTaskId), criteriaOwner.sessionId],
    )
    expect(item.rows[0]?.content.rootSuccessCriteria).toEqual([root.rows[0]?.goal, "Include evidence for each result"])
    const observed = await command.readCurrent(readScope(criteriaOwner))
    expect(observed.rootSuccessCriteria).toEqual(item.rows[0]?.content.rootSuccessCriteria)

    const beforeReplay = await graphRows(adminPool!, criteriaOwner)
    await expect(command.appendAndSchedule(first)).resolves.toMatchObject({ status: "duplicate" })
    await expect(command.appendAndSchedule({ ...first, rootSuccessCriteria: ["Changed same-key requirement"] })).rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(await graphRows(adminPool!, criteriaOwner)).toEqual(beforeReplay)

    const omitted = {
      ...base,
      proposal: { ...base.proposal, expectedRevision: 1, nodes: [{ ...base.proposal.nodes[1]!, dependsOn: [] }] },
    }
    await expect(command.appendAndSchedule(omitted)).resolves.toMatchObject({ status: "accepted", revision: 2 })
    expect((await adminPool!.query<{ successCriteria: string[] }>(
      `SELECT "successCriteria" FROM "sub_agent_tasks" WHERE "id" = $1`, [criteriaOwner.rootTaskId],
    )).rows[0]?.successCriteria).toEqual([])
    const afterOmission = await adminPool!.query<{ content: { rootSuccessCriteria?: string[] } }>(
      `SELECT "content" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2`,
      [taskGraphItemId(criteriaOwner.rootTaskId), criteriaOwner.sessionId],
    )
    expect(afterOmission.rows[0]?.content.rootSuccessCriteria).toEqual(item.rows[0]?.content.rootSuccessCriteria)

    const beforeConflict = await graphRows(adminPool!, criteriaOwner)
    const replacement = {
      ...base,
      proposal: { ...base.proposal, expectedRevision: 2, nodes: [{ ...base.proposal.nodes[2]!, dependsOn: [] }] },
      rootSuccessCriteria: ["Remove the failed requirement"],
    }
    await expect(command.appendAndSchedule(replacement)).rejects.toMatchObject({ code: "root_success_criteria_conflict" })
    expect(await graphRows(adminPool!, criteriaOwner)).toEqual(beforeConflict)
  }, 60_000)

  it("rejects a missing or oversized root goal before persisting a checklist or receipt", async () => {
    const invalidOwner = fixture()
    additionalFixtures.push(invalidOwner)
    await seed(adminPool!, invalidOwner)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "goal" = $1 WHERE "id" = $2`, ["x".repeat(2_001), invalidOwner.rootTaskId])
    const before = await graphRows(adminPool!, invalidOwner)
    const input = { ...scheduleInput(invalidOwner), rootSuccessCriteria: ["One extra requirement"] }
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, invalidOwner.userId))

    await expect(command.appendAndSchedule(input)).rejects.toMatchObject({ code: "root_success_criteria_invalid" })
    expect(await graphRows(adminPool!, invalidOwner)).toEqual(before)
    expect((await adminPool!.query<{ successCriteria: string[] }>(
      `SELECT "successCriteria" FROM "sub_agent_tasks" WHERE "id" = $1`, [invalidOwner.rootTaskId],
    )).rows[0]?.successCriteria).toEqual([])
  }, 60_000)

  it("rolls back every graph write when the final event-outbox insert fails", async () => {
    const rollbackOwner = fixture()
    additionalFixtures.push(rollbackOwner)
    await seed(adminPool!, rollbackOwner, { goal: ROOT_TASK_GOAL, successCriteria: [] })
    const input = { ...scheduleInput(rollbackOwner, 7, true), rootSuccessCriteria: ["No partial plan criterion may persist"] }
    const before = await graphRows(adminPool!, rollbackOwner)
    const criteriaBefore = await adminPool!.query(`SELECT "successCriteria" FROM "sub_agent_tasks" WHERE "id" = $1`, [rollbackOwner.rootTaskId])
    const sequenceBefore = await adminPool!.query<{ eventSequence: string }>(
      `SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [rollbackOwner.sessionId],
    )
    const triggerName = `tg_fail_${randomUUID().replaceAll("-", "")}`
    const functionName = `${triggerName}_fn`
    await adminPool!.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $task_graph_test$
      BEGIN
        IF NEW."topic" = 'agent.session.event'
          AND NEW."aggregateId" = current_setting('applymate.task_graph_fail_session', true) THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'injected task graph late-write failure';
        END IF;
        RETURN NEW;
      END
      $task_graph_test$`)
    await adminPool!.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."agent_outbox"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`)
    const failingPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    try {
      const command = createPgTaskGraphCommandPort(
        restrictedTransactionPool(failingPool, roleName, rollbackOwner.userId, rollbackOwner.sessionId),
      )
      await expect(command.appendAndSchedule(input)).rejects.toThrow("injected task graph late-write failure")
      expect(await graphRows(adminPool!, rollbackOwner)).toEqual(before)
      expect(await adminPool!.query(`SELECT "successCriteria" FROM "sub_agent_tasks" WHERE "id" = $1`, [rollbackOwner.rootTaskId])).toEqual(criteriaBefore)
      expect((await command.readCurrent(readScope(rollbackOwner))).revision).toBe(0)
      const sequenceAfter = await adminPool!.query<{ eventSequence: string }>(
        `SELECT "eventSequence" FROM "agent_sessions" WHERE "id" = $1`, [rollbackOwner.sessionId],
      )
      expect(sequenceAfter.rows).toEqual(sequenceBefore.rows)
    } finally {
      await failingPool.end()
      await adminPool!.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."agent_outbox"`)
      await adminPool!.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`)
    }
  }, 60_000)

  it("serializes concurrent same-revision replays and rejects conflicting content without duplicate writes", async () => {
    const concurrentOwner = fixture()
    additionalFixtures.push(concurrentOwner)
    await seed(adminPool!, concurrentOwner)
    const input = scheduleInput(concurrentOwner, 7, true)
    const racingPool = new PgPool({ connectionString: databaseUrl!, max: 2 })
    try {
      const command = createPgTaskGraphCommandPort(restrictedTransactionPool(racingPool, roleName, concurrentOwner.userId))
      const [first, second] = await Promise.all([
        command.appendAndSchedule(input),
        command.appendAndSchedule(input),
      ])
      const accepted = [first, second].filter(receipt => receipt.status === "accepted")
      const duplicates = [first, second].filter(receipt => receipt.status === "duplicate")
      expect(accepted).toHaveLength(1)
      expect(duplicates).toHaveLength(1)
      expect({ ...duplicates[0], status: "accepted" }).toEqual(accepted[0])

      const committed = await graphRows(adminPool!, concurrentOwner)
      expect(committed.children).toHaveLength(input.proposal.nodes.length)
      expect(committed.item).toEqual([{ id: taskGraphItemId(concurrentOwner.rootTaskId), revision: 1 }])
      expect(committed.events).toHaveLength(1)
      expect(committed.outbox).toHaveLength(2)

      const conflicting = {
        ...input,
        proposal: {
          ...input.proposal,
          nodes: input.proposal.nodes.map((node, index) => index === 0 ? { ...node, goal: "Conflicting same-revision proposal" } : node),
        },
      }
      await expect(command.appendAndSchedule(conflicting)).rejects.toThrow("TaskGraph proposal key was already used")
      expect(await graphRows(adminPool!, concurrentOwner)).toEqual(committed)
    } finally {
      await racingPool.end()
    }
  }, 60_000)

  it("atomically binds the verified Analyst candidate to scheduled Writer and Reviewer contexts and reuses it after restart", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const highJobId = scheduledDraftJobId(value, "high")
    const lowJobId = scheduledDraftJobId(value, "low")
    const sources = await seedVerifiedScheduledDraftSources(adminPool!, value, command, [
      { scoutKey: "scout-high", analystKey: "analyst-high", jobId: highJobId, score: 9, hasFinding: true },
      { scoutKey: "scout-low", analystKey: "analyst-low", jobId: lowJobId, score: 6, hasFinding: true },
    ])
    const scope = scheduledDraftGraphScope(value)
    await expect(readScheduledDraftCandidateBinding(adminPool!, scope)).resolves.toEqual({ status: "absent" })

    const writerReviewer = scheduledDraftInput(value, 1, [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft for the verified Analyst job", successCriteria: ["Persist the selected-job draft"], dependsOn: ["analyst-high", "analyst-low"] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist the review receipt"], dependsOn: ["writer"] },
    ])
    const accepted = await command.appendAndSchedule(writerReviewer)
    expect(accepted).toMatchObject({ status: "accepted", revision: 2, nodes: [
      { key: "writer", status: "queued" }, { key: "reviewer", status: "waiting" },
    ] })
    await expect(scheduledDraftRootAllowedActions(adminPool!, value)).resolves.toEqual(sources.rootAllowedActions)

    const taskContexts = await adminPool!.query<{ role: string; context: unknown }>(`SELECT "role", "context" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "parentTaskId" = $2 AND "role" IN ('writer', 'reviewer') ORDER BY "role"`,
    [value.sessionId, value.rootTaskId])
    expect(taskContexts.rows).toHaveLength(2)
    const writerContext = taskContexts.rows.find(row => row.role === "writer")?.context as Record<string, unknown> | undefined
    const reviewerContext = taskContexts.rows.find(row => row.role === "reviewer")?.context as Record<string, unknown> | undefined
    expect(writerContext?.selectedJobPreparation).toEqual({ jobId: highJobId })
    expect(reviewerContext?.selectedJobPreparation).toEqual({ jobId: highJobId })
    expect(writerContext?.scheduledDraftCandidateWitness).toEqual(reviewerContext?.scheduledDraftCandidateWitness)
    expect(writerContext?.scheduledDraftCandidateWitness).toMatchObject({
      candidate: { jobId: highJobId, score: 9 }, sourceAnalystKeys: ["analyst-high"],
      analysts: [{ nodeKey: "analyst-high" }, { nodeKey: "analyst-low" }],
    })

    const probe = await commandPool!.connect()
    let persistedBinding: Awaited<ReturnType<typeof readScheduledDraftCandidateBinding>> | undefined
    try {
      await probe.query("BEGIN")
      await probe.query(`SET LOCAL ROLE "${roleName}"`)
      await probe.query("SELECT set_config('app.user_id', $1, true)", [value.userId])
      persistedBinding = await readScheduledDraftCandidateBinding(probe, scope)
      expect(await readScheduledDraftCandidateBinding(probe, { ...scope, turnId: value.foreignTurnId })).toEqual({ status: "absent" })
      expect(await readScheduledDraftCandidateBinding(probe, {
        ...scope, rootTaskId: value.foreignRootTaskId, parentTaskId: value.foreignRootTaskId,
      })).toEqual({ status: "absent" })
      expect(await readScheduledDraftCandidateBinding(probe, {
        userId: value.foreignUserId, sessionId: value.foreignSessionId, turnId: value.foreignTurnId,
        rootTaskId: value.foreignRootTaskId, parentTaskId: value.foreignRootTaskId,
      })).toEqual({ status: "absent" })
    } finally {
      await probe.query("ROLLBACK").catch(() => undefined)
      probe.release()
    }
    expect(persistedBinding).toMatchObject({
      status: "bound", jobId: highJobId, graphRevision: 2,
      witness: writerContext?.scheduledDraftCandidateWitness,
    })
    if (!persistedBinding || persistedBinding.status !== "bound") throw new Error("Scheduled-draft candidate binding was not persisted")

    const restartedPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    try {
      const restarted = createPgTaskGraphCommandPort(restrictedTransactionPool(restartedPool, roleName, value.userId))
      await expect(restarted.appendAndSchedule(writerReviewer)).resolves.toEqual({ ...accepted, status: "duplicate" })
    } finally {
      await restartedPool.end()
    }
    await expect(readScheduledDraftCandidateBinding(adminPool!, scope)).resolves.toMatchObject({
      status: "bound", jobId: persistedBinding.jobId, graphRevision: persistedBinding.graphRevision, witness: persistedBinding.witness,
    })

    await expect(validateScheduledDraftCandidateWitness(adminPool!, scope, persistedBinding.snapshot, persistedBinding.graphRevision,
      persistedBinding.jobId, persistedBinding.witness)).resolves.toBe(true)
    const sourceTask = sources.analysts.find(node => node.key === "analyst-high")?.taskId
    if (!sourceTask) throw new Error("Scheduled-draft PostgreSQL fixture lost its highest-scoring Analyst")
    const changedSource = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "result" = jsonb_set("result",
      '{structuredResult,findings,0,score}', '7'::jsonb) WHERE "id" = $1 AND "sessionId" = $2`, [sourceTask, value.sessionId])
    expect(changedSource.rowCount).toBe(1)
    await expect(validateScheduledDraftCandidateWitness(adminPool!, scope, persistedBinding.snapshot, persistedBinding.graphRevision,
      persistedBinding.jobId, persistedBinding.witness)).resolves.toBe(false)
  }, 60_000)

  it("revalidates every Scout proof bound by a union-member Analyst before scheduled drafting", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const firstJobId = scheduledDraftJobId(value, "union-a"), secondJobId = scheduledDraftJobId(value, "union-b")
    const sources = await seedVerifiedScheduledDraftSources(adminPool!, value, command, [{
      scoutKey: "scout-union-a", extraScouts: [{ key: "scout-union-b", jobId: secondJobId }],
      analystKey: "analyst-union", jobId: firstJobId, score: 9, hasFinding: true, unionCheck: "membership",
    }])
    const scope = scheduledDraftGraphScope(value)
    await expect(command.appendAndSchedule(scheduledDraftInput(value, 1, [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft from the union-verified finding", successCriteria: ["Persist the selected-job draft"], dependsOn: ["analyst-union"] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist the review receipt"], dependsOn: ["writer"] },
    ]))).resolves.toMatchObject({ status: "accepted", revision: 2 })

    const binding = await readScheduledDraftCandidateBinding(adminPool!, scope)
    if (binding.status !== "bound") throw new Error("Union scheduled-draft fixture did not persist its candidate binding")
    const analystBinding = binding.witness.analysts.find(analyst => analyst.nodeKey === "analyst-union")
    expect(binding).toMatchObject({ jobId: firstJobId, witness: { candidate: { jobId: firstJobId, score: 9 }, sourceAnalystKeys: ["analyst-union"] } })
    if (!analystBinding) throw new Error("Union scheduled-draft witness omitted its Analyst proof")
    expect(analystBinding.scouts.map(scout => scout.nodeKey)).toEqual(["scout-union-a", "scout-union-b"])
    await expect(validateScheduledDraftCandidateWitness(adminPool!, scope, binding.snapshot, binding.graphRevision,
      binding.jobId, binding.witness)).resolves.toBe(true)

    for (const scoutKey of ["scout-union-a", "scout-union-b"]) {
      const scoutTaskId = sources.snapshot.nodes.find(node => node.key === scoutKey)?.taskId
      if (!scoutTaskId) throw new Error(`Union scheduled-draft fixture lost ${scoutKey}`)
      const changed = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 2
        WHERE "id" = $1 AND "sessionId" = $2 AND "attemptCount" = 1`, [scoutTaskId, value.sessionId])
      expect(changed.rowCount).toBe(1)
      await expect(validateScheduledDraftCandidateWitness(adminPool!, scope, binding.snapshot, binding.graphRevision,
        binding.jobId, binding.witness)).resolves.toBe(false)
      const restored = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 1
        WHERE "id" = $1 AND "sessionId" = $2 AND "attemptCount" = 2`, [scoutTaskId, value.sessionId])
      expect(restored.rowCount).toBe(1)
      await expect(validateScheduledDraftCandidateWitness(adminPool!, scope, binding.snapshot, binding.graphRevision,
        binding.jobId, binding.witness)).resolves.toBe(true)
    }
  }, 60_000)

  it("rejects scheduled drafting without a verified Analyst finding before any TaskGraph task, event, or outbox write", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    await seedVerifiedScheduledDraftSources(adminPool!, value, command, [
      { scoutKey: "scout-no-finding", analystKey: "analyst-no-finding", jobId: scheduledDraftJobId(value, "no-finding"), score: 8, hasFinding: false },
    ])
    await expect(readScheduledDraftCandidateBinding(adminPool!, scheduledDraftGraphScope(value))).resolves.toEqual({ status: "absent" })
    const writerReviewer = scheduledDraftInput(value, 1, [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft only from a verified Analyst finding", successCriteria: ["Persist the selected-job draft"], dependsOn: ["analyst-no-finding"] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist the review receipt"], dependsOn: ["writer"] },
    ])
    const before = await scheduledDraftDurableRows(adminPool!, value)

    await expect(command.appendAndSchedule(writerReviewer)).rejects.toMatchObject({ code: "task_graph_scheduled_draft_candidate_missing" })

    expect(await scheduledDraftDurableRows(adminPool!, value)).toEqual(before)
    expect(await readScheduledDraftCandidateBinding(adminPool!, scheduledDraftGraphScope(value))).toEqual({ status: "absent" })
  }, 60_000)

  it("does not qualify a coverage-only union Analyst for scheduled drafting", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const firstJobId = scheduledDraftJobId(value, "coverage-a")
    await seedVerifiedScheduledDraftSources(adminPool!, value, command, [{
      scoutKey: "scout-coverage-a", extraScouts: [{ key: "scout-coverage-b", jobId: firstJobId }],
      analystKey: "analyst-coverage-only", jobId: firstJobId, score: 9, hasFinding: true, unionCheck: "coverage-only",
    }])
    const scope = scheduledDraftGraphScope(value)
    await expect(readScheduledDraftCandidateBinding(adminPool!, scope)).resolves.toEqual({ status: "absent" })
    const writerReviewer = scheduledDraftInput(value, 1, [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft only from membership-verified findings", successCriteria: ["Persist the selected-job draft"], dependsOn: ["analyst-coverage-only"] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist the review receipt"], dependsOn: ["writer"] },
    ])
    const before = await scheduledDraftDurableRows(adminPool!, value)
    await expect(command.appendAndSchedule(writerReviewer)).rejects.toMatchObject({ code: "task_graph_scheduled_draft_candidate_missing" })
    expect(await scheduledDraftDurableRows(adminPool!, value)).toEqual(before)
    await expect(readScheduledDraftCandidateBinding(adminPool!, scope)).resolves.toEqual({ status: "absent" })
  }, 60_000)

  it("rejects a scheduled draft plan that omits the highest verified Analyst candidate before durable writes", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const highJobId = scheduledDraftJobId(value, "high")
    await seedVerifiedScheduledDraftSources(adminPool!, value, command, [
      { scoutKey: "scout-high", analystKey: "analyst-high", jobId: highJobId, score: 9, hasFinding: true },
      { scoutKey: "scout-low", analystKey: "analyst-low", jobId: scheduledDraftJobId(value, "low"), score: 6, hasFinding: true },
    ])
    const writerReviewer = scheduledDraftInput(value, 1, [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft for the plan-selected Analyst job", successCriteria: ["Persist the selected-job draft"], dependsOn: ["analyst-low"] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist the review receipt"], dependsOn: ["writer"] },
    ])
    const before = await scheduledDraftDurableRows(adminPool!, value)

    await expect(command.appendAndSchedule(writerReviewer)).rejects.toMatchObject({ code: "task_graph_scheduled_draft_candidate_dependency_missing" })

    expect(await scheduledDraftDurableRows(adminPool!, value)).toEqual(before)
    expect(await readScheduledDraftCandidateBinding(adminPool!, scheduledDraftGraphScope(value))).toEqual({ status: "absent" })
  }, 60_000)

  it("invalidates a persisted candidate witness when its source Analyst attempt changes", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const jobId = scheduledDraftJobId(value, "attempt")
    const sources = await seedVerifiedScheduledDraftSources(adminPool!, value, command, [
      { scoutKey: "scout-attempt", analystKey: "analyst-attempt", jobId, score: 9, hasFinding: true },
    ])
    await command.appendAndSchedule(scheduledDraftInput(value, 1, [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft from the verified finding", successCriteria: ["Persist the selected-job draft"], dependsOn: ["analyst-attempt"] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist the review receipt"], dependsOn: ["writer"] },
    ]))
    const binding = await readScheduledDraftCandidateBinding(adminPool!, scheduledDraftGraphScope(value))
    if (binding.status !== "bound") throw new Error("Scheduled-draft attempt fixture did not persist its candidate binding")
    const analystTaskId = sources.analysts[0]?.taskId
    if (!analystTaskId) throw new Error("Scheduled-draft attempt fixture lost its Analyst task")

    const bumped = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 2
      WHERE "id" = $1 AND "sessionId" = $2 AND "attemptCount" = 1`, [analystTaskId, value.sessionId])
    expect(bumped.rowCount).toBe(1)
    await expect(validateScheduledDraftCandidateWitness(adminPool!, scheduledDraftGraphScope(value), binding.snapshot,
      binding.graphRevision, binding.jobId, binding.witness)).resolves.toBe(false)

    const restored = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 1
      WHERE "id" = $1 AND "sessionId" = $2 AND "attemptCount" = 2`, [analystTaskId, value.sessionId])
    expect(restored.rowCount).toBe(1)
    await expect(validateScheduledDraftCandidateWitness(adminPool!, scheduledDraftGraphScope(value), binding.snapshot,
      binding.graphRevision, binding.jobId, binding.witness)).resolves.toBe(true)
  }, 60_000)

  it("rejects validation of a persisted candidate witness after a structural graph append", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const jobId = scheduledDraftJobId(value, "revision")
    await seedVerifiedScheduledDraftSources(adminPool!, value, command, [
      { scoutKey: "scout-revision", analystKey: "analyst-revision", jobId, score: 9, hasFinding: true },
    ])
    await command.appendAndSchedule(scheduledDraftInput(value, 1, [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft from the verified finding", successCriteria: ["Persist the selected-job draft"], dependsOn: ["analyst-revision"] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist the review receipt"], dependsOn: ["writer"] },
    ]))
    const binding = await readScheduledDraftCandidateBinding(adminPool!, scheduledDraftGraphScope(value))
    if (binding.status !== "bound") throw new Error("Scheduled-draft revision fixture did not persist its candidate binding")

    await expect(command.appendAndSchedule(scheduledDraftInput(value, 2, [
      { key: "analyst-after-binding", templateId: "analyst", goal: "Append an unrelated graph node", successCriteria: ["Persist the follow-up node"],
        verification: ANALYST_VERIFICATION, dependsOn: [] },
    ]))).resolves.toMatchObject({ status: "accepted", revision: 3 })
    const graph = await adminPool!.query<{ revision: number; content: unknown }>(`SELECT "revision", "content" FROM "agent_items"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = 'task_graph'`,
    [taskGraphItemId(value.rootTaskId), value.sessionId, value.turnId])
    const currentSnapshot = parseTaskGraphSnapshot(graph.rows[0]?.content)
    expect(graph.rows[0]?.revision).toBe(3)
    await expect(validateScheduledDraftCandidateWitness(adminPool!, scheduledDraftGraphScope(value), currentSnapshot,
      3, binding.jobId, binding.witness)).resolves.toBe(false)
    await expect(readScheduledDraftCandidateBinding(adminPool!, scheduledDraftGraphScope(value)))
      .rejects.toThrow("scheduled_draft_candidate_binding_invalid")
  }, 60_000)

  it("replays a typed supersession after a later plan advances the graph beyond R+2", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const additionalCriteria = ["Preserve the original root checklist"]
    const pinnedCriteria = ["Find roles", ...additionalCriteria]
    const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, value, additionalCriteria)
    const rootBefore = await adminPool!.query<{ goal: string; successCriteria: unknown }>(`SELECT "goal", "successCriteria"
      FROM "sub_agent_tasks" WHERE "id" = $1`, [value.rootTaskId])
    expect(rootBefore.rows).toHaveLength(1)
    const accepted = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    expect(accepted).toMatchObject({ status: "accepted", revision: 3, nodes: [{ key: "replacement-1", status: "queued" }] })
    const rootAfter = await adminPool!.query<{ goal: string; successCriteria: unknown }>(`SELECT "goal", "successCriteria"
      FROM "sub_agent_tasks" WHERE "id" = $1`, [value.rootTaskId])
    expect(rootAfter.rows).toEqual(rootBefore.rows)

    const operationKey = steeringReconciliationIdempotencyKey(prepared.input.scope, value.planCallId)
    if (!operationKey) throw new Error("TaskGraph supersession fixture could not derive its operation key")
    const receiptRows = await adminPool!.query<{ id: string; sequence: string | bigint; idempotencyKey: string; payload: unknown }>(
      `SELECT "id", "sequence", "idempotencyKey", "payload" FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = $3 ORDER BY "sequence"`,
      [value.sessionId, value.turnId, STEERING_RECONCILIATION_EVENT_TYPE],
    )
    expect(receiptRows.rows).toHaveLength(1)
    const receiptRow = receiptRows.rows[0]!
    const receiptPayload = receiptRow.payload as { supersession?: Record<string, unknown> }
    const relation = receiptPayload.supersession
    if (!relation) throw new Error("TaskGraph supersession receipt omitted its relation")
    expect(receiptRow.idempotencyKey).toBe(operationKey)
    expect(relation).toMatchObject({
      schemaVersion: "agent-harness.v2.task-graph-supersession.v2", operationKey,
      observedRevision: 1, cancellationRevision: 2, resultingRevision: 3,
      source: { nodeKey: prepared.source.key, taskId: prepared.source.taskId },
      replacement: { nodeKey: "replacement-1", taskId: accepted.nodes[0]?.taskId },
      replacementFingerprint: prepared.replacementFingerprint,
      agentPlanCall: { callId: value.planCallId, stepId: value.stepId, expectedRevision: 1, replaceUnstarted: { nodeKey: prepared.source.key } },
    })

    const cancellationIdentity = relation.cancellationEvent as { id: string; sequence: string }
    const planIdentity = relation.planEvent as { id: string; sequence: string }
    const eventRows = await adminPool!.query<{ id: string; sequence: string | bigint; itemId: string | null; taskId: string | null;
      type: string; idempotencyKey: string; payload: unknown }>(
      `SELECT "id", "sequence", "itemId", "taskId", "type", "idempotencyKey", "payload" FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "id" = ANY($3::text[]) ORDER BY "sequence"`,
      [value.sessionId, value.turnId, [cancellationIdentity.id, planIdentity.id]],
    )
    expect(eventRows.rows).toHaveLength(2)
    const cancellation = eventRows.rows.find(row => row.id === cancellationIdentity.id)!
    const plan = eventRows.rows.find(row => row.id === planIdentity.id)!
    expect(String(cancellation.sequence)).toBe(cancellationIdentity.sequence)
    expect(String(plan.sequence)).toBe(planIdentity.sequence)
    expect(BigInt(cancellation.sequence)).toBeLessThan(BigInt(plan.sequence))
    expect(cancellation).toMatchObject({ itemId: taskGraphItemId(value.rootTaskId), taskId: prepared.source.taskId, type: "item.delta",
      idempotencyKey: taskGraphLifecycleKey(value.rootTaskId, prepared.source.key, 0, "task.cancelled") })
    expect(plan).toMatchObject({ itemId: taskGraphItemId(value.rootTaskId), taskId: value.rootTaskId, type: "item.delta",
      idempotencyKey: taskGraphSupersessionProposalKey(value.rootTaskId, 1) })
    const cancellationPayload = cancellation.payload as { kind: string; event: { type: string; expectedRevision: number };
      revision: number; item: { revision: number; content: unknown } }
    const planPayload = plan.payload as { kind: string; operationKey: string; observedRevision: number; fingerprint: string;
      revision: number; receipt: { revision: number }; item: { revision: number; content: unknown }; content: unknown }
    expect(cancellationPayload).toMatchObject({ kind: "lifecycle", event: { type: "task.cancelled", expectedRevision: 1 }, revision: 2, item: { revision: 2 } })
    const cancellationSnapshot = parseTaskGraphSnapshot(cancellationPayload.item.content)
    expect(cancellationSnapshot.rootSuccessCriteria).toEqual(pinnedCriteria)
    expect(cancellationSnapshot.nodes.some(node => node.key === prepared.source.key && node.taskId === prepared.source.taskId)).toBe(true)
    expect(planPayload).toMatchObject({ kind: "proposal", operationKey, observedRevision: 1,
      fingerprint: prepared.replacementFingerprint, revision: 3, receipt: { revision: 3 }, item: { revision: 3 } })
    expect(canonicalTaskGraphJson(planPayload.content)).toBe(canonicalTaskGraphJson(planPayload.item.content))
    const finalSnapshot = parseTaskGraphSnapshot(planPayload.item.content)
    expect(finalSnapshot.rootSuccessCriteria).toEqual(pinnedCriteria)
    expect(finalSnapshot.nodes).toHaveLength(1)
    expect(finalSnapshot.nodes[0]).toMatchObject({ key: "replacement-1", taskId: accepted.nodes[0]?.taskId,
      templateId: prepared.source.templateId, verification: prepared.source.verification, dependsOn: prepared.source.dependsOn })
    expect(finalSnapshot.nodes.some(node => node.key === prepared.source.key || node.taskId === prepared.source.taskId)).toBe(false)
    const sourceTask = await adminPool!.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2`,
      [prepared.source.taskId, value.sessionId])
    expect(sourceTask.rows).toEqual([{ status: "cancelled" }])
    const outboxCopies = await adminPool!.query<{ idempotencyKey: string }>(`SELECT "idempotencyKey" FROM "agent_outbox"
      WHERE "aggregateId" = $1 AND "idempotencyKey" = ANY($2::text[]) ORDER BY "idempotencyKey"`,
      [value.sessionId, [`agent-event:${cancellation.id}`, `agent-event:${plan.id}`]])
    expect(outboxCopies.rows).toHaveLength(2)
    expect(outboxCopies.rows.map(row => row.idempotencyKey)).toEqual(expect.arrayContaining([
      `agent-event:${cancellation.id}`, `agent-event:${plan.id}`,
    ]))

    const laterInput: TaskGraphScheduleInput = {
      scope: prepared.input.scope,
      proposal: { expectedRevision: 3, nodes: [{ key: "later-plan", templateId: "analyst", goal: "Add a later task",
        successCriteria: ["Complete the later task"], verification: ANALYST_VERIFICATION, dependsOn: [] }] },
      templates: prepared.input.templates,
    }
    await expect(prepared.command.appendAndSchedule(laterInput)).resolves.toMatchObject({ status: "accepted", revision: 4 })
    const advancedGraph = await adminPool!.query<{ revision: number; content: unknown }>(`SELECT "revision", "content" FROM "agent_items"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = 'task_graph'`,
    [taskGraphItemId(value.rootTaskId), value.sessionId, value.turnId])
    expect(advancedGraph.rows[0]?.revision).toBe(4)
    expect(parseTaskGraphSnapshot(advancedGraph.rows[0]?.content).rootSuccessCriteria).toEqual(pinnedCriteria)

    const committed = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!({
      ...prepared.input, rootSuccessCriteria: ["Changed root checklist"],
    }, prepared.operation)).rejects.toMatchObject({ code: "root_success_criteria_conflict" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(committed)
    await commandPool!.end()
    commandPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const reopened = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool, roleName, value.userId))
    await expect(reopened.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(committed)
  }, 60_000)

  it("rewires a typed leaf to an incomplete prerequisite, preserves the envelope, and binds both edge sets on replay", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, value, undefined, {
      includeIndependentPrerequisite: true,
      replacementDependsOn: ["task-2"],
    })
    const prerequisite = prepared.incompletePrerequisite
    if (!prerequisite) throw new Error("TaskGraph rewiring fixture lost its independent prerequisite")
    expect(prepared.source.dependsOn).toEqual([])
    expect(prerequisite.key).toBe("task-2")

    const accepted = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    expect(accepted).toMatchObject({ status: "accepted", revision: 3, readyTaskIds: [],
      nodes: [{ key: "replacement-1", status: "waiting" }] })
    const current = await prepared.command.readCurrent(readScope(value))
    const replacement = current.nodes.find(node => node.key === "replacement-1")
    expect(replacement).toMatchObject({ key: "replacement-1", status: "waiting", readiness: "waiting_for_dependencies",
      dependsOn: [prerequisite.key], templateId: prepared.source.templateId, verification: prepared.source.verification })
    expect(replacement?.taskId).not.toBe(prepared.source.taskId)
    expect(current.nodes.find(node => node.key === prerequisite.key)?.status).toBe("queued")
    const replacementTask = await adminPool!.query<{ status: string; attemptCount: number; result: unknown; outputArtifactIds: unknown;
      contextSnapshotId: string | null; role: string; taskType: string; allowedActions: unknown; constraints: unknown; expectedOutputSchema: unknown }>(
      `SELECT "status", "attemptCount", "result", "outputArtifactIds", "contextSnapshotId", "role", "taskType", "allowedActions", "constraints", "expectedOutputSchema"
        FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4`,
      [replacement?.taskId, value.sessionId, value.turnId, value.rootTaskId],
    )
    expect(replacementTask.rows).toEqual([{
      status: "waiting", attemptCount: 0, result: null, outputArtifactIds: [], contextSnapshotId: null,
      role: prepared.input.templates.analyst?.role, taskType: prepared.input.templates.analyst?.taskType,
      allowedActions: prepared.input.templates.analyst?.allowedActions ?? [], constraints: prepared.input.templates.analyst?.constraints ?? [],
      expectedOutputSchema: prepared.input.templates.analyst?.expectedOutputSchema ?? {},
    }])

    const relationRows = await adminPool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = $3`, [value.sessionId, value.turnId, STEERING_RECONCILIATION_EVENT_TYPE])
    const relation = (relationRows.rows[0]?.payload as { supersession?: { cancellationEvent?: { id?: string }; planEvent?: { id?: string }; replacementFingerprint?: string } } | undefined)?.supersession
    if (!relation?.cancellationEvent?.id || !relation.planEvent?.id) throw new Error("TaskGraph rewiring fixture lost its persisted relation")
    expect(relation.replacementFingerprint).toBe(prepared.replacementFingerprint)
    const proofEvents = await adminPool!.query<{ id: string; payload: unknown }>(`SELECT "id", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "id" = ANY($3::text[])`, [
      value.sessionId, value.turnId, [relation.cancellationEvent.id, relation.planEvent.id],
    ])
    const cancellation = proofEvents.rows.find(row => row.id === relation.cancellationEvent!.id)
    const plan = proofEvents.rows.find(row => row.id === relation.planEvent!.id)
    const cancellationContent = (cancellation?.payload as { item?: { content?: unknown } } | undefined)?.item?.content
    const planContent = (plan?.payload as { item?: { content?: unknown } } | undefined)?.item?.content
    expect(parseTaskGraphSnapshot(cancellationContent).nodes.find(node => node.key === prepared.source.key)?.dependsOn).toEqual([])
    expect(parseTaskGraphSnapshot(planContent).nodes.find(node => node.key === "replacement-1")?.dependsOn).toEqual([prerequisite.key])

    const committed = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(committed)

    const changedEdges = { ...prepared.input, proposal: { ...prepared.input.proposal, nodes: [{ ...prepared.replacement, dependsOn: [] }] } }
    await expect(prepared.command.appendAndScheduleWithReconciliation!(changedEdges, prepared.operation)).rejects.toThrow()
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(committed)

    // Change only the old edge set in its durable cancellation snapshot. A replay must bind this owner-fenced historical source too.
    const tampered = await adminPool!.query(`UPDATE "agent_events" SET "payload" = jsonb_set("payload", '{item,content,nodes,0,dependsOn}', $2::jsonb)
      WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4`, [
      relation.cancellationEvent.id, JSON.stringify([prerequisite.key]), value.sessionId, value.turnId,
    ])
    expect(tampered.rowCount).toBe(1)
    const afterTamper = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)).rejects.toThrow()
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(afterTamper)
  }, 60_000)

  it("rejects reachable waiting legacy dependencies atomically and permits unrelated legacy work", async () => {
    for (const route of [
      { label: "direct", includeTypedWaitingAncestor: false, dependencyKey: "task-3" },
      { label: "transitive through a typed waiting ancestor", includeTypedWaitingAncestor: true, dependencyKey: "task-4" },
    ]) {
      const value = fixture()
      additionalFixtures.push(value)
      const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, value, undefined, {
        includeWaitingLegacyDependency: true,
        includeTypedWaitingAncestor: route.includeTypedWaitingAncestor,
        replacementDependsOn: [route.dependencyKey],
      })
      const prerequisite = prepared.incompletePrerequisite
      const legacy = prepared.legacyDependency
      if (!prerequisite || !legacy) throw new Error(`TaskGraph ${route.label} fixture lost its dependency nodes`)
      const snapshotRows = await adminPool!.query<{ content: unknown }>(`SELECT "content" FROM "agent_items"
        WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "type" = 'task_graph'`,
      [taskGraphItemId(value.rootTaskId), value.sessionId, value.turnId])
      const snapshot = parseTaskGraphSnapshot(snapshotRows.rows[0]?.content)
      expect(snapshot.nodes.find(node => node.key === legacy.key)?.verificationDisposition).toBe("legacy_unverified")
      const current = await prepared.command.readCurrent(readScope(value))
      expect(current.nodes.find(node => node.key === prerequisite.key)?.status).toBe("queued")
      expect(current.nodes.find(node => node.key === legacy.key)).toMatchObject({ status: "waiting", readiness: "waiting_for_dependencies" })
      if (route.includeTypedWaitingAncestor) {
        const ancestor = prepared.typedWaitingAncestor
        if (!ancestor) throw new Error("TaskGraph transitive fixture lost its typed waiting ancestor")
        expect(snapshot.nodes.find(node => node.key === ancestor.key)?.verificationDisposition).toBe("typed")
        expect(current.nodes.find(node => node.key === ancestor.key)).toMatchObject({ status: "waiting", readiness: "waiting_for_dependencies" })
      }

      const before = await supersessionDurableRows(adminPool!, value)
      await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation),
        `TaskGraph supersession with a ${route.label} path to waiting legacy work should be rejected`)
        .rejects.toMatchObject({ code: "task_graph_dependency_unverified" })
      expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
    }

    const unrelatedValue = fixture()
    additionalFixtures.push(unrelatedValue)
    const unrelated = await prepareTypedSupersession(adminPool!, commandPool!, roleName, unrelatedValue, undefined, {
      includeWaitingLegacyDependency: true,
      replacementDependsOn: [],
    })
    const legacy = unrelated.legacyDependency
    if (!legacy) throw new Error("TaskGraph unrelated legacy fixture lost its legacy node")
    const beforeAcceptance = await unrelated.command.readCurrent(readScope(unrelatedValue))
    expect(beforeAcceptance.nodes.find(node => node.key === legacy.key)).toMatchObject({ status: "waiting", readiness: "waiting_for_dependencies" })
    const accepted = await unrelated.command.appendAndScheduleWithReconciliation!(unrelated.input, unrelated.operation)
    expect(accepted).toMatchObject({ status: "accepted", revision: 3, nodes: [{ key: "replacement-1", status: "queued" }] })
    expect(accepted.readyTaskIds).toEqual([accepted.nodes[0]?.taskId])
    const afterAcceptance = await unrelated.command.readCurrent(readScope(unrelatedValue))
    expect(afterAcceptance.nodes.find(node => node.key === legacy.key)?.status).toBe("waiting")
    expect(afterAcceptance.nodes.find(node => node.key === "replacement-1")).toMatchObject({
      status: "queued", readiness: "ready", dependsOn: [],
    })
  }, 60_000)

  it("rejects missing, duplicate, self-cyclic, and superseded-source rewiring edges atomically", async () => {
    const invalidEdges = [
      { label: "missing", dependsOn: ["missing-prerequisite"] },
      { label: "duplicate", dependsOn: ["task-2", "task-2"] },
      { label: "self-cycle", dependsOn: ["replacement-1"] },
      { label: "superseded source", dependsOn: ["task-1"] },
    ] as const
    for (const invalid of invalidEdges) {
      const value = fixture()
      additionalFixtures.push(value)
      const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, value, undefined, {
        includeIndependentPrerequisite: true,
        replacementDependsOn: invalid.dependsOn,
      })
      const before = await supersessionDurableRows(adminPool!, value)
      await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation),
        `TaskGraph supersession ${invalid.label} edge should be rejected`).rejects.toThrow()
      expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
    }
  }, 60_000)

  it("rejects changed supersession fingerprint, source, and revision without durable writes", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, value)
    const accepted = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    expect(accepted).toMatchObject({ status: "accepted", revision: 3 })

    const assertRejectedWithoutWrites = async (input: TaskGraphScheduleInput, operation: typeof prepared.operation) => {
      const before = await supersessionDurableRows(adminPool!, value)
      await expect(prepared.command.appendAndScheduleWithReconciliation!(input, operation)).rejects.toThrow()
      expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
    }
    const changedReplacement = { ...prepared.replacement, goal: "Different replacement content" }
    await assertRejectedWithoutWrites({ ...prepared.input, proposal: { ...prepared.input.proposal, nodes: [changedReplacement] } }, prepared.operation)

    const foreignSourceCall = { ...prepared.rawCallInput, replaceUnstarted: { nodeKey: "foreign-source" } }
    await assertRejectedWithoutWrites({ ...prepared.input, replaceUnstarted: foreignSourceCall.replaceUnstarted },
    { ...prepared.operation, replaceUnstartedNodeKey: "foreign-source" })

    await assertRejectedWithoutWrites({ ...prepared.input, proposal: { ...prepared.input.proposal, expectedRevision: 2 } },
    { ...prepared.operation, expectedRevision: 2 })
  }, 60_000)

  it("rolls back cancellation, plan, receipt, outbox, cursor, and revision when v2 plan streaming fails", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, value)
    const before = await supersessionDurableRows(adminPool!, value)
    const triggerName = `tg_fail_${randomUUID().replaceAll("-", "")}`
    const functionName = `${triggerName}_fn`
    await adminPool!.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger
      LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $task_graph_test$
      BEGIN
        IF NEW."topic" = 'agent.session.event'
          AND NEW."aggregateId" = current_setting('applymate.task_graph_fail_session', true)
          AND NEW."payload"->'payload'->>'kind' = 'proposal' THEN
          RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = 'injected supersession plan-outbox failure';
        END IF;
        RETURN NEW;
      END
      $task_graph_test$`)
    await adminPool!.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."agent_outbox"
      FOR EACH ROW EXECUTE FUNCTION public."${functionName}"()`)
    const failingPool = new PgPool({ connectionString: databaseUrl!, max: 1 })
    try {
      const failing = createPgTaskGraphCommandPort(restrictedTransactionPool(failingPool, roleName, value.userId, value.sessionId))
      await expect(failing.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
        .rejects.toThrow("injected supersession plan-outbox failure")
      expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
    } finally {
      await failingPool.end()
      await adminPool!.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."agent_outbox"`)
      await adminPool!.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`)
    }
  }, 60_000)

  it("rejects supersession when the queued source has attempt evidence before any writes", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, value)
    const changed = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 1
      WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'queued' AND "attemptCount" = 0`, [prepared.source.taskId, value.sessionId])
    expect(changed.rowCount).toBe(1)
    const before = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .rejects.toMatchObject({ code: "task_graph_supersession_not_eligible" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
  }, 60_000)

  it("rejects supersession when a Root-owned durable wait targets the queued source", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareTypedSupersession(adminPool!, commandPool!, roleName, value)
    const now = new Date()
    await adminPool!.query(`INSERT INTO "agent_wait_conditions"
      ("id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey",
       "targetTaskIds", "mode", "status", "deadlineAt", "matchedTaskIds", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'any', 'waiting', $9, '[]'::jsonb, $10, $10)`, [
      `p3-task-graph-wait-${randomUUID()}`, value.userId, value.sessionId, value.turnId,
      value.rootTaskId, value.stepId, `supersession-target-${randomUUID()}`,
      JSON.stringify([prepared.source.taskId]), new Date(now.getTime() + 60_000), now,
    ])
    const before = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .rejects.toMatchObject({ code: "task_graph_supersession_not_eligible" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
  }, 60_000)

  it("serializes typed supersession against the real Worker claim path in both lock orders", async () => {
    const policy = { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }
    const claimedDuringSupersession = fixture()
    additionalFixtures.push(claimedDuringSupersession)
    const winnerChecklist = ["Keep the pinned checklist through supersession"]
    const commandWins = await prepareTypedSupersession(adminPool!, commandPool!, roleName, claimedDuringSupersession, winnerChecklist)
    const commandHolder = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const claimLoser = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const commandApp = `tg-command-${randomUUID()}`
    const claimApp = `tg-claim-${randomUUID()}`
    await commandHolder.query("SELECT set_config('application_name', $1, false)", [commandApp])
    await claimLoser.query("SELECT set_config('application_name', $1, false)", [claimApp])
    const commandBarrier = pausingSessionLockPool(restrictedTransactionPool(commandHolder, roleName, claimedDuringSupersession.userId))
    const commandWinnerPort = createPgTaskGraphCommandPort(commandBarrier.pool)
    try {
      const commandPromise = commandWinnerPort.appendAndScheduleWithReconciliation!(commandWins.input, commandWins.operation)
        .then(value => ({ value }), error => ({ error }))
      await waitForSignal(commandBarrier.acquired)
      const claimPromise = new PgSubagentTaskStore(claimLoser).claim({ taskId: commandWins.source.taskId,
        sessionId: claimedDuringSupersession.sessionId, ownerId: "worker-after-cancel", policy, now: new Date() })
        .then(value => ({ value }), error => ({ error }))
      await waitForLockWait(adminPool!, claimApp)
      commandBarrier.release()
      const [commandOutcome, claimOutcome] = await Promise.all([commandPromise, claimPromise])
      if (!("value" in commandOutcome)) throw commandOutcome.error
      expect(commandOutcome.value).toMatchObject({ status: "accepted", revision: 3 })
      expect("value" in claimOutcome ? claimOutcome.value : undefined).toBeNull()
    } finally {
      commandBarrier.release()
      await Promise.all([commandHolder.end(), claimLoser.end()])
    }
    const cancelledSource = await adminPool!.query<{ status: string }>(`SELECT "status" FROM "sub_agent_tasks" WHERE "id" = $1`, [commandWins.source.taskId])
    expect(cancelledSource.rows).toEqual([{ status: "cancelled" }])
    const persistedPlan = await adminPool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [
      claimedDuringSupersession.sessionId, claimedDuringSupersession.turnId,
      taskGraphSupersessionProposalKey(claimedDuringSupersession.rootTaskId, 1),
    ])
    expect(persistedPlan.rows).toHaveLength(1)
    const persistedSnapshot = (persistedPlan.rows[0]?.payload as { item?: { content?: unknown } }).item?.content
    expect(parseTaskGraphSnapshot(persistedSnapshot).rootSuccessCriteria).toEqual(["Find roles", ...winnerChecklist])
    const persistedRelation = await adminPool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = $3`, [
      claimedDuringSupersession.sessionId, claimedDuringSupersession.turnId, STEERING_RECONCILIATION_EVENT_TYPE,
    ])
    expect(persistedRelation.rows).toHaveLength(1)
    expect((persistedRelation.rows[0]?.payload as { supersession?: { replacementFingerprint?: string } }).supersession?.replacementFingerprint)
      .toBe(commandWins.replacementFingerprint)

    const claimedFirst = fixture()
    additionalFixtures.push(claimedFirst)
    const loserChecklist = ["Keep the checklist when Worker claim wins"]
    const commandLoses = await prepareTypedSupersession(adminPool!, commandPool!, roleName, claimedFirst, loserChecklist)
    const claimHolder = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const commandLoser = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const workerApp = `tg-worker-${randomUUID()}`
    const losingCommandApp = `tg-plan-${randomUUID()}`
    await claimHolder.query("SELECT set_config('application_name', $1, false)", [workerApp])
    await commandLoser.query("SELECT set_config('application_name', $1, false)", [losingCommandApp])
    const claimBarrier = pausingSessionLockPool(claimHolder)
    let claimedTask: Awaited<ReturnType<PgSubagentTaskStore["claim"]>> = null
    try {
      const claimPromise = new PgSubagentTaskStore(claimBarrier.pool).claim({ taskId: commandLoses.source.taskId,
        sessionId: claimedFirst.sessionId, ownerId: "worker-before-plan", policy, now: new Date() })
        .then(value => ({ value }), error => ({ error }))
      await waitForSignal(claimBarrier.acquired)
      const commandLosingPort = createPgTaskGraphCommandPort(restrictedTransactionPool(commandLoser, roleName, claimedFirst.userId))
      const commandPromise = commandLosingPort.appendAndScheduleWithReconciliation!(commandLoses.input, commandLoses.operation)
        .then(value => ({ value }), error => ({ error }))
      await waitForLockWait(adminPool!, losingCommandApp)
      claimBarrier.release()
      const [claimOutcome, commandOutcome] = await Promise.all([claimPromise, commandPromise])
      if (!("value" in claimOutcome)) throw claimOutcome.error
      expect(claimOutcome.value).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: "worker-before-plan" })
      expect("error" in commandOutcome).toBe(true)
      claimedTask = claimOutcome.value
    } finally {
      claimBarrier.release()
      await Promise.all([claimHolder.end(), commandLoser.end()])
    }
    expect(claimedTask).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: "worker-before-plan" })
    const graphAfterClaim = await commandLoses.command.readCurrent(readScope(claimedFirst))
    expect(graphAfterClaim.revision).toBe(2)
    expect(graphAfterClaim.rootSuccessCriteria).toEqual(["Find roles", ...loserChecklist])
    expect(graphAfterClaim.nodes).toMatchObject([{ key: commandLoses.source.key, taskId: commandLoses.source.taskId, status: "running" }])
    const replacementRows = await adminPool!.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2 AND "id" <> $3`,
      [claimedFirst.sessionId, claimedFirst.rootTaskId, commandLoses.source.taskId])
    expect(replacementRows.rows).toEqual([])
    expect((await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = $2`,
      [claimedFirst.sessionId, STEERING_RECONCILIATION_EVENT_TYPE])).rows).toEqual([])
  }, 60_000)

  it("serializes a two-source branch repair against Worker claim in both Session-lock orders", async () => {
    const policy = { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }
    const repaired = fixture()
    additionalFixtures.push(repaired)
    const repair = await prepareTypedBranchReplan(adminPool!, commandPool!, roleName, repaired)
    const commandHolder = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const claimLoser = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const commandApp = `tg-branch-command-${randomUUID()}`
    const claimApp = `tg-branch-claim-${randomUUID()}`
    await commandHolder.query("SELECT set_config('application_name', $1, false)", [commandApp])
    await claimLoser.query("SELECT set_config('application_name', $1, false)", [claimApp])
    const commandBarrier = pausingSessionLockPool(restrictedTransactionPool(commandHolder, roleName, repaired.userId))
    const branchWinner = createPgTaskGraphCommandPort(commandBarrier.pool)
    try {
      const commandPromise = branchWinner.appendAndScheduleWithReconciliation!(repair.input, repair.operation)
        .then(value => ({ value }), error => ({ error }))
      await waitForSignal(commandBarrier.acquired)
      const claimPromise = new PgSubagentTaskStore(claimLoser).claim({ taskId: repair.sourceNodes[0]!.taskId,
        sessionId: repaired.sessionId, ownerId: "worker-after-branch-repair", policy, now: new Date() })
        .then(value => ({ value }), error => ({ error }))
      await waitForLockWait(adminPool!, claimApp)
      commandBarrier.release()
      const [commandOutcome, claimOutcome] = await Promise.all([commandPromise, claimPromise])
      if (!("value" in commandOutcome)) throw commandOutcome.error
      expect(commandOutcome.value).toMatchObject({ status: "accepted" })
      expect("value" in claimOutcome ? claimOutcome.value : undefined).toBeNull()
    } finally {
      commandBarrier.release()
      await Promise.all([commandHolder.end(), claimLoser.end()])
    }
    const repairedGraph = await repair.command.readCurrent(readScope(repaired))
    expect(repairedGraph.revision).toBeGreaterThan(1)
    expect(repairedGraph.nodes.map(node => node.key)).toEqual(["first-scout", "first-analyst"])
    const replacementRows = await adminPool!.query<{ id: string; status: string; attemptCount: number; result: unknown }>(
      `SELECT "id", "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [repairedGraph.nodes.map(node => node.taskId)])
    expect(replacementRows.rows).toHaveLength(2)
    expect(replacementRows.rows.every(row => row.attemptCount === 0 && row.result === null)).toBe(true)
    expect(repairedGraph.nodes.map(node => node.status)).toEqual(["queued", "waiting"])
    const history = await adminPool!.query<{ sequence: string; payload: unknown }>(
      `SELECT "sequence", "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "type" = $3`,
      [repaired.sessionId, repaired.turnId, STEERING_RECONCILIATION_EVENT_TYPE])
    expect(history.rows).toHaveLength(1)
    const envelope = history.rows[0]!.payload as { schemaVersion?: string; steerInputIds?: unknown[]; branchRepair?: {
      schemaVersion?: string; resultingRevision?: number; root?: { nodeKey?: string; taskId?: string }
      sources?: Array<{ source?: { nodeKey?: string; taskId?: string }; replacementKey?: string; cancellationEvent?: { id?: string; sequence?: string } }>
      planEvent?: { id?: string; sequence?: string; idempotencyKey?: string }
      agentPlanCall?: { callId?: string; stepId?: string; expectedRevision?: number; replaceBranch?: unknown }
    } }
    const relation = envelope.branchRepair
    expect(envelope).toMatchObject({ schemaVersion: "agent-harness.v2.plan-reconciliation.v3", steerInputIds: [] })
    expect(relation).toMatchObject({ schemaVersion: "agent-harness.v2.task-graph-branch-repair.v1", resultingRevision: repairedGraph.revision,
      root: { nodeKey: repair.sourceNodes[0]!.key, taskId: repair.sourceNodes[0]!.taskId },
      sources: repair.replaceBranch.sources.map(source => ({ source: { nodeKey: source.nodeKey, taskId: source.taskId }, replacementKey: source.replacementKey })),
      agentPlanCall: { callId: repaired.planCallId, stepId: repair.scope.stepId, expectedRevision: 1, replaceBranch: repair.replaceBranch } })
    expect(relation?.planEvent?.idempotencyKey).toBe(taskGraphProposalKey(repaired.rootTaskId, 1 + repair.replaceBranch.sources.length))
    expect(relation?.sources?.every(source => Boolean(source.cancellationEvent?.id && source.cancellationEvent.sequence))).toBe(true)
    expect(BigInt(history.rows[0]!.sequence)).toBeGreaterThan(BigInt(relation!.planEvent!.sequence!))

    const claimed = fixture()
    additionalFixtures.push(claimed)
    const losingRepair = await prepareTypedBranchReplan(adminPool!, commandPool!, roleName, claimed)
    const claimHolder = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const commandLoser = new PgPool({ connectionString: databaseUrl!, max: 1 })
    const claimFirstApp = `tg-branch-worker-${randomUUID()}`
    const losingCommandApp = `tg-branch-plan-${randomUUID()}`
    await claimHolder.query("SELECT set_config('application_name', $1, false)", [claimFirstApp])
    await commandLoser.query("SELECT set_config('application_name', $1, false)", [losingCommandApp])
    const claimBarrier = pausingSessionLockPool(claimHolder)
    const commandLoserBarrier = pausingSessionLockPool(restrictedTransactionPool(commandLoser, roleName, claimed.userId))
    try {
      const claimPromise = new PgSubagentTaskStore(claimBarrier.pool).claim({ taskId: losingRepair.sourceNodes[0]!.taskId,
        sessionId: claimed.sessionId, ownerId: "worker-before-branch-repair", policy, now: new Date() })
        .then(value => ({ value }), error => ({ error }))
      await waitForSignal(claimBarrier.acquired)
      const commandPromise = createPgTaskGraphCommandPort(commandLoserBarrier.pool)
        .appendAndScheduleWithReconciliation!(losingRepair.input, losingRepair.operation)
        .then(value => ({ value }), error => ({ error }))
      await waitForLockWait(adminPool!, losingCommandApp)
      claimBarrier.release()
      await waitForSignal(commandLoserBarrier.acquired)
      const claimOutcome = await claimPromise
      if (!("value" in claimOutcome)) throw claimOutcome.error
      expect(claimOutcome.value).toMatchObject({ status: "running", attemptCount: 1, leaseOwner: "worker-before-branch-repair" })
      const afterClaim = await supersessionDurableRows(adminPool!, claimed)
      expect(afterClaim.items).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: taskGraphItemId(claimed.rootTaskId), revision: 2 }),
      ]))
      commandLoserBarrier.release()
      const commandOutcome = await commandPromise
      expect("error" in commandOutcome ? commandOutcome.error.message : undefined).toBe("steering_reconciliation_revision_conflict")
      expect(await supersessionDurableRows(adminPool!, claimed)).toEqual(afterClaim)
    } finally {
      claimBarrier.release()
      commandLoserBarrier.release()
      await Promise.all([claimHolder.end(), commandLoser.end()])
    }
    const unchanged = await losingRepair.command.readCurrent(readScope(claimed))
    expect(unchanged.revision).toBe(2)
    expect(unchanged.nodes.map(node => node.key)).toEqual(["source-scout", "source-analyst"])
    expect(unchanged.nodes.map(node => node.status)).toEqual(["running", "waiting"])
    expect((await adminPool!.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "parentTaskId" = $2
      AND "id" <> ALL($3::text[])`, [claimed.sessionId, claimed.rootTaskId, losingRepair.sourceNodes.map(node => node.taskId)])).rows).toEqual([])
  }, 60_000)

  it("rolls back prior branch cancellations when replacement insertion fails mid-transaction", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const suffix = randomUUID().replaceAll("-", "")
    const replacementPrefix = `rollback-${suffix}`
    const prepared = await prepareTypedBranchReplan(adminPool!, commandPool!, roleName, value, replacementPrefix)
    const scout = prepared.sourceNodes.find(node => node.templateId === "scout")
    const analyst = prepared.sourceNodes.find(node => node.templateId === "analyst")
    if (!scout || !analyst) throw new Error("Typed branch fixture lost a source before rollback injection")
    const scoutGoal = `Refresh evidence for ${replacementPrefix}`
    const functionName = `branch_insert_failure_${suffix}`
    const triggerName = `branch_insert_failure_${suffix}`
    try {
      await adminPool!.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $branch_failure$
        BEGIN
          IF NEW."sessionId" = TG_ARGV[0] AND NEW."goal" = TG_ARGV[1] THEN
            IF NOT EXISTS (SELECT 1 FROM public."sub_agent_tasks" WHERE "id" = TG_ARGV[2] AND "sessionId" = NEW."sessionId" AND "status" = 'cancelled')
              OR NOT EXISTS (SELECT 1 FROM public."sub_agent_tasks" WHERE "id" = TG_ARGV[3] AND "sessionId" = NEW."sessionId" AND "status" = 'cancelled') THEN
              RAISE EXCEPTION 'branch_repair_test_failure_before_source_cancellation';
            END IF;
            RAISE EXCEPTION 'branch_repair_test_failure_after_source_cancellation';
          END IF;
          RETURN NEW;
        END
        $branch_failure$`)
      await adminPool!.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."sub_agent_tasks"
        FOR EACH ROW EXECUTE FUNCTION public."${functionName}"('${value.sessionId}', '${scoutGoal}', '${scout.taskId}', '${analyst.taskId}')`)
      const before = await supersessionDurableRows(adminPool!, value)
      await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
        .rejects.toThrow("branch_repair_test_failure_after_source_cancellation")
      expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
      const sourceRows = await adminPool!.query<{ id: string; status: string; attemptCount: number }>(
        `SELECT "id", "status", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[])`, [[scout.taskId, analyst.taskId]])
      expect(Object.fromEntries(sourceRows.rows.map(row => [row.id, { status: row.status, attemptCount: row.attemptCount }]))).toEqual({
        [scout.taskId]: { status: "queued", attemptCount: 0 },
        [analyst.taskId]: { status: "waiting", attemptCount: 0 },
      })
      await expect(prepared.command.readCurrent(readScope(value))).resolves.toMatchObject({ revision: 1,
        nodes: [{ key: "source-scout", status: "queued" }, { key: "source-analyst", status: "waiting" }] })
    } finally {
      await adminPool!.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."sub_agent_tasks"`)
      await adminPool!.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`)
    }
  }, 60_000)

  it("rolls back a branch repair when any member has prior attempt evidence", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareTypedBranchReplan(adminPool!, commandPool!, roleName, value)
    const analyst = prepared.sourceNodes.find(node => node.templateId === "analyst")
    if (!analyst) throw new Error("Typed branch fixture lost its Analyst source")
    const changed = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 1
      WHERE "id" = $1 AND "sessionId" = $2 AND "status" = 'waiting' AND "attemptCount" = 0`, [analyst.taskId, value.sessionId])
    expect(changed.rowCount).toBe(1)
    const before = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .rejects.toMatchObject({ code: "task_graph_branch_repair_not_eligible" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
  }, 60_000)

  it("rolls back a branch repair when the Root lacks its two-step continuation budget", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareTypedBranchReplan(adminPool!, commandPool!, roleName, value)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = '{"maxSteps":0}'::jsonb WHERE "id" = $1`, [value.rootTaskId])
    const before = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .rejects.toMatchObject({ code: "task_graph_continuation_budget_required" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
  }, 60_000)

  it("replans a repaired branch with fresh IDs and makes old-group replay read-only", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const first = await prepareTypedBranchReplan(adminPool!, commandPool!, roleName, value)
    const firstReceipt = await first.command.appendAndScheduleWithReconciliation!(first.input, first.operation)
    expect(firstReceipt).toMatchObject({ status: "accepted" })
    const second = await prepareNextTypedBranchReplan(first, firstReceipt.revision)
    const secondReceipt = await second.command.appendAndScheduleWithReconciliation!(second.input, second.operation)
    expect(secondReceipt).toMatchObject({ status: "accepted" })
    expect(secondReceipt.revision).toBeGreaterThan(firstReceipt.revision)
    expect(secondReceipt.nodes.map(node => node.key)).toEqual(["second-scout", "second-analyst"])
    expect(secondReceipt.nodes.map(node => node.taskId)).not.toEqual(firstReceipt.nodes.map(node => node.taskId))
    const current = await first.command.readCurrent(readScope(value))
    expect(current.revision).toBe(secondReceipt.revision)
    expect(current.nodes.map(node => node.key)).toEqual(["second-scout", "second-analyst"])
    const durableBeforeReplay = await supersessionDurableRows(adminPool!, value)
    const replay = await first.command.appendAndScheduleWithReconciliation!(first.input, first.operation)
    expect(replay).toMatchObject({ status: "duplicate", revision: firstReceipt.revision, nodes: firstReceipt.nodes,
      readyTaskIds: firstReceipt.readyTaskIds })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(durableBeforeReplay)
    const afterReplay = await first.command.readCurrent(readScope(value))
    expect(afterReplay.revision).toBe(secondReceipt.revision)
    expect(afterReplay.nodes.map(node => ({ key: node.key, taskId: node.taskId })))
      .toEqual(current.nodes.map(node => ({ key: node.key, taskId: node.taskId })))

    const changedInput: TaskGraphScheduleInput = { ...first.input, proposal: { ...first.input.proposal,
      nodes: first.input.proposal.nodes.map((node, index) => index === 0 ? { ...node, goal: "Changed request under the same call identity" } : node) } }
    const beforeConflict = await supersessionDurableRows(adminPool!, value)
    await expect(first.command.appendAndScheduleWithReconciliation!(changedInput, first.operation))
      .rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(beforeConflict)

    const replacementRows = await adminPool!.query<{ id: string; status: string; attemptCount: number; result: unknown }>(
      `SELECT "id", "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [secondReceipt.nodes.map(node => node.taskId)])
    expect(replacementRows.rows).toHaveLength(2)
    expect(replacementRows.rows.every(row => row.attemptCount === 0 && row.result === null)).toBe(true)
    expect(current.nodes.map(node => node.status)).toEqual(["queued", "waiting"])
  }, 60_000)

  it.each([
    { label: "a Scout leaf after child_resume_unavailable", shape: "scout_leaf" as const,
      failureReason: "child_resume_unavailable" as const, role: "scout", taskType: "job_discovery" },
    { label: "a Scout leaf after child_resume_evidence_unavailable", shape: "scout_leaf" as const,
      failureReason: "child_resume_evidence_unavailable" as const, role: "scout", taskType: "job_discovery" },
    { label: "an Analyst leaf after child_resume_unavailable", shape: "analyst_leaf" as const,
      failureReason: "child_resume_unavailable" as const, role: "analyst", taskType: "job_analysis" },
    { label: "an Analyst leaf after child_resume_evidence_unavailable", shape: "analyst_leaf" as const,
      failureReason: "child_resume_evidence_unavailable" as const, role: "analyst", taskType: "job_analysis" },
    { label: "the complete Scout and Analyst closure after child_resume_unavailable", shape: "scout_analyst_closure" as const,
      failureReason: "child_resume_unavailable" as const, role: "scout", taskType: "job_discovery" },
  ])("replaces $label at the eight-node limit and restores only an exact stored replay", async ({ shape, failureReason, role, taskType }) => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareOperationalFailureReplan(adminPool!, commandPool!, roleName, value, shape, { failureReason })
    expect(prepared.failedRoot.templateId).toBe(role)
    expect(prepared.current.nodes).toHaveLength(8)
    const rootBefore = await failedBranchImmutableRows(adminPool!, value, [prepared.failedRoot.taskId])
    const descendants = prepared.sourceTaskIds.filter(taskId => taskId !== prepared.failedRoot.taskId)
    const priorIds = new Set(prepared.current.nodes.filter(node => descendants.includes(node.taskId) && node.status === "cancelled")
      .map(node => node.taskId))
    const newCancellationCount = descendants.filter(taskId => !priorIds.has(taskId)).length
    const beforeRows = await adminPool!.query<{ id: string; status: string; attemptCount: number; role: string;
      taskType: string; failureReason: string | null }>(
      `SELECT "id", "status", "attemptCount", "role", "taskType", "failureReason"
       FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [prepared.sourceTaskIds])
    expect(beforeRows.rows.find(row => row.id === prepared.failedRoot.taskId)).toMatchObject({
      status: "failed", attemptCount: 1, role, taskType, failureReason,
    })
    const failureKey = taskGraphLifecycleKey(value.rootTaskId, prepared.failedRoot.key, 1, "task.failed")
    const failureEvent = await adminPool!.query<{ id: string; type: string; actor: string; taskId: string;
      idempotencyKey: string; payload: unknown }>(
      `SELECT "id", "type", "actor", "taskId", "idempotencyKey", "payload" FROM "agent_events"
       WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`,
      [value.sessionId, value.turnId, failureKey])
    expect(failureEvent.rows).toHaveLength(1)
    expect(failureEvent.rows[0]).toMatchObject({ type: "item.delta", actor: "system",
      taskId: prepared.failedRoot.taskId, idempotencyKey: failureKey,
      payload: { kind: "lifecycle", event: { type: "task.failed", failureReason } },
    })
    const failureOutbox = await adminPool!.query<{ topic: string; aggregateId: string; idempotencyKey: string }>(
      `SELECT "topic", "aggregateId", "idempotencyKey" FROM "agent_outbox" WHERE "idempotencyKey" = $1`,
      [`agent-event:${failureEvent.rows[0]!.id}`])
    expect(failureOutbox.rows).toEqual([{ topic: "agent.session.event", aggregateId: value.sessionId,
      idempotencyKey: `agent-event:${failureEvent.rows[0]!.id}` }])
    for (const taskId of descendants) expect(beforeRows.rows.find(row => row.id === taskId)).toMatchObject({ status: "cancelled", attemptCount: 0 })

    const accepted = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    expect(accepted).toMatchObject({ status: "accepted", revision: prepared.current.revision + newCancellationCount + 1 })
    expect(accepted.nodes).toHaveLength(prepared.sourceNodes.length)
    expect(accepted.nodes.every(node => !prepared.sourceTaskIds.includes(node.taskId))).toBe(true)
    expect(accepted.readyTaskIds).toEqual(accepted.nodes.filter(node => node.status === "queued").map(node => node.taskId))
    expect(await failedBranchImmutableRows(adminPool!, value, [prepared.failedRoot.taskId])).toEqual(rootBefore)
    const current = await prepared.command.readCurrent(readScope(value))
    expect(current.nodes).toHaveLength(8)
    expect(current.nodes.some(node => prepared.sourceTaskIds.includes(node.taskId))).toBe(false)
    expect(current.nodes.filter(node => node.key.startsWith("replacement-")).map(node => node.status)).toEqual(
      shape === "scout_analyst_closure" ? ["queued", "waiting"] : ["queued"])

    if (descendants.length) {
      const cancelled = await adminPool!.query<{ status: string; attemptCount: number; failureReason: string | null }>(
        `SELECT "status", "attemptCount", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1`, [descendants[0]])
      expect(cancelled.rows).toEqual([{ status: "cancelled", attemptCount: 0, failureReason: "A prerequisite task did not complete." }])
      const cancellation = await adminPool!.query<{ idempotencyKey: string; actor: string; taskId: string }>(
        `SELECT "idempotencyKey", "actor", "taskId" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`,
        [value.sessionId, value.turnId, taskGraphLifecycleKey(value.rootTaskId, "resume-analyst", 0, "task.cancelled")])
      expect(cancellation.rows).toEqual([{ idempotencyKey: taskGraphLifecycleKey(value.rootTaskId, "resume-analyst", 0, "task.cancelled"),
        actor: "system", taskId: descendants[0] }])
    } else {
      const cancellation = await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2
        AND "idempotencyKey" = $3`, [value.sessionId, value.turnId, taskGraphLifecycleKey(value.rootTaskId, "resume-analyst", 0, "task.cancelled")])
      expect(cancellation.rows).toHaveLength(0)
    }
    const newTasks = await adminPool!.query<{ id: string; status: string; attemptCount: number; result: unknown }>(
      `SELECT "id", "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [accepted.nodes.map(node => node.taskId)])
    expect(newTasks.rows).toHaveLength(prepared.sourceNodes.length)
    expect(newTasks.rows.every(row => row.attemptCount === 0 && row.result === null)).toBe(true)
    expect(new Set(newTasks.rows.map(row => row.id)).size).toBe(prepared.sourceNodes.length)

    const receiptKey = steeringReconciliationIdempotencyKey(prepared.scope, value.planCallId)
    const receiptRows = await adminPool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [value.sessionId, value.turnId, receiptKey])
    const relation = (receiptRows.rows[0]?.payload as { operationalFailure?: Record<string, unknown> } | undefined)?.operationalFailure
    const expectedPrior = prepared.sourceNodes.filter(node => priorIds.has(node.taskId)).map(node => expect.objectContaining({
      source: expect.objectContaining({ nodeKey: node.key, taskId: node.taskId }),
      event: expect.objectContaining({ id: expect.any(String), sequence: expect.any(String),
        idempotencyKey: taskGraphLifecycleKey(value.rootTaskId, node.key, 0, "task.cancelled") }),
    }))
    const expectedNewCancellations = prepared.sourceNodes.filter(node => node.taskId !== prepared.failedRoot.taskId
      && !priorIds.has(node.taskId)).map(node => expect.objectContaining({
      source: expect.objectContaining({ nodeKey: node.key, taskId: node.taskId }),
      event: expect.objectContaining({ id: expect.any(String), sequence: expect.any(String),
        idempotencyKey: taskGraphLifecycleKey(value.rootTaskId, node.key, 0, "task.cancelled") }),
    }))
    expect(relation).toMatchObject({ graphRootTaskId: value.rootTaskId, resultingRevision: accepted.revision,
      failedSource: { source: { nodeKey: prepared.failedRoot.key, taskId: prepared.failedRoot.taskId },
        attemptCount: 1, failureReason },
      sources: expect.arrayContaining(prepared.sourceNodes.map(node => expect.objectContaining({
        source: { nodeKey: node.key, taskId: node.taskId }, replacementKey: `replacement-${node.key}`,
      }))),
    })
    expect(relation?.priorCancellations).toHaveLength(expectedPrior.length)
    expect(relation?.priorCancellations).toEqual(expect.arrayContaining(expectedPrior))
    expect(relation?.cancellations).toHaveLength(expectedNewCancellations.length)
    expect(relation?.cancellations).toEqual(expect.arrayContaining(expectedNewCancellations))

    const durable = await supersessionDurableRows(adminPool!, value)
    const restored = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    await expect(restored.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(durable)
  }, 90_000)

  it("replays a replacement with a retained Root wait over its newly cancelled descendant", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareOperationalFailureReplan(adminPool!, commandPool!, roleName, value,
      "scout_analyst_closure", { leaveDependentWaiting: true })

    const dependent = prepared.sourceNodes.find(node => node.key === "resume-analyst")
    if (!dependent) throw new Error("Operational-wait fixture lost its dependent Analyst")
    expect(prepared.current.nodes.find(node => node.taskId === dependent.taskId)?.status).toBe("waiting")
    const targetTaskIds = [prepared.failedRoot.taskId, dependent.taskId].sort()
    const matchedTaskIds = [prepared.failedRoot.taskId]
    const timeoutMs = 60_000
    const createdAt = new Date()
    const waitId = `p3-operational-root-wait-${randomUUID()}`
    await adminPool!.query(`INSERT INTO "agent_wait_conditions"
      ("id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey", "targetTaskIds",
       "mode", "status", "deadlineAt", "matchedTaskIds", "result", "createdAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 'any', 'ready', $9, $10::jsonb, $11::jsonb, $12, $12)`, [
      waitId, value.userId, value.sessionId, value.turnId, value.rootTaskId, value.laterStepId,
      `operational-root-wait-${randomUUID()}`, JSON.stringify(targetTaskIds),
      new Date(createdAt.getTime() + timeoutMs), JSON.stringify(matchedTaskIds),
      JSON.stringify({ request: { targetTaskIds, mode: "any", timeoutMs } }), createdAt,
    ])
    const waitBefore = await adminPool!.query(`SELECT * FROM "agent_wait_conditions" WHERE "id" = $1`, [waitId])
    expect(waitBefore.rows).toHaveLength(1)
    expect(waitBefore.rows[0]).toMatchObject({ userId: value.userId, sessionId: value.sessionId, turnId: value.turnId,
      parentTaskId: value.rootTaskId, stepId: value.laterStepId, targetTaskIds, mode: "any", status: "ready", matchedTaskIds,
      result: { request: { targetTaskIds, mode: "any", timeoutMs } }, suspendedAt: null, resolvedAt: null, consumedAt: null })

    const accepted = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    expect(accepted.status).toBe("accepted")
    const cancelled = await adminPool!.query<{ status: string; attemptCount: number; failureReason: string | null }>(
      `SELECT "status", "attemptCount", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1`, [dependent.taskId])
    expect(cancelled.rows).toEqual([{ status: "cancelled", attemptCount: 0, failureReason: null }])
    const receiptKey = steeringReconciliationIdempotencyKey(prepared.scope, value.planCallId)
    const receipt = await adminPool!.query<{ payload: { operationalFailure?: { cancellations?: unknown[] } } }>(
      `SELECT "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`,
      [value.sessionId, value.turnId, receiptKey])
    expect(receipt.rows[0]?.payload.operationalFailure?.cancellations).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: { nodeKey: "resume-analyst", taskId: dependent.taskId } }),
    ]))
    expect(await adminPool!.query(`SELECT * FROM "agent_wait_conditions" WHERE "id" = $1`, [waitId])).toEqual(waitBefore)

    const durable = await supersessionDurableRows(adminPool!, value)
    const replay = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    await expect(replay.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .resolves.toEqual({ ...accepted, status: "duplicate" })
    expect(await adminPool!.query(`SELECT * FROM "agent_wait_conditions" WHERE "id" = $1`, [waitId])).toEqual(waitBefore)
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(durable)
  }, 90_000)

  it("rejects partial operational closures and wrong replacement counts before any durable write", async () => {
    for (const invalidKind of ["partial", "count"] as const) {
      const value = fixture()
      additionalFixtures.push(value)
      const prepared = await prepareOperationalFailureReplan(adminPool!, commandPool!, roleName, value, "scout_analyst_closure")
      const replacement = prepared.input.replaceOperationalFailure!
      const rootMapping = replacement.sources.find(source => source.taskId === prepared.failedRoot.taskId)
      const rootReplacement = prepared.input.proposal.nodes.find(node => node.key === rootMapping?.replacementKey)
      if (!rootMapping || !rootReplacement) throw new Error("Operational-failure test lost its root replacement mapping")
      const proposalNodes = [rootReplacement]
      const invalidMode = invalidKind === "partial"
        ? { ...replacement, sources: replacement.sources.filter(source => source.taskId === prepared.failedRoot.taskId) }
        : replacement
      const rawCallInput = { expectedRevision: prepared.input.proposal.expectedRevision, nodes: proposalNodes,
        replaceOperationalFailure: invalidMode }
      const callItem = await adminPool!.query<{ id: string }>(`SELECT "id" FROM "agent_items"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "id" = $3`, [value.sessionId, value.turnId, `${value.planCallId}-item`])
      expect(callItem.rows).toHaveLength(1)
      await adminPool!.query(`UPDATE "agent_items" SET "content" = $2::jsonb WHERE "id" = $1 AND "sessionId" = $3`,
        [callItem.rows[0]!.id, JSON.stringify({ toolCallId: value.planCallId, toolName: "agent.plan", toolVersion: "1", input: rawCallInput }), value.sessionId])
      const input: TaskGraphScheduleInput = { ...prepared.input, proposal: { ...prepared.input.proposal, nodes: proposalNodes },
        replaceOperationalFailure: invalidMode }
      const operation = { ...prepared.operation, replaceOperationalFailure: invalidMode }
      const before = await supersessionDurableRows(adminPool!, value)
      const attempt = prepared.command.appendAndScheduleWithReconciliation!(input, operation)
      if (invalidKind === "partial") {
        await expect(attempt).rejects.toMatchObject({ code: "task_graph_operational_failure_replacement_not_eligible" })
      } else {
        let rejection: unknown = null
        try { await attempt } catch (error) { rejection = error }
        expect(rejection).toBeInstanceOf(Error)
        if (!(rejection instanceof Error)) throw new Error("Wrong replacement count did not reject")
        expect(rejection.message).toBe("steering_reconciliation_call_invalid")
        expect(Object.hasOwn(rejection, "code")).toBe(false)
      }
      expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
    }
  }, 90_000)

  it.each(["forged_result", "stale_attempt", "foreign_outbox"] as const)("rejects a %s failure proof without changing its graph", async variant => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareOperationalFailureReplan(adminPool!, commandPool!, roleName, value, "scout_leaf")
    const failureKey = taskGraphLifecycleKey(value.rootTaskId, prepared.failedRoot.key, 1, "task.failed")
    if (variant === "forged_result") {
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "result" = jsonb_set("result", '{workerResult}',
        '{"status":"completed"}'::jsonb) WHERE "id" = $1 AND "sessionId" = $2`, [prepared.failedRoot.taskId, value.sessionId])
    } else if (variant === "stale_attempt") {
      await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = "attemptCount" + 1 WHERE "id" = $1 AND "sessionId" = $2`,
        [prepared.failedRoot.taskId, value.sessionId])
    } else {
      const event = await adminPool!.query<{ id: string }>(`SELECT "id" FROM "agent_events"
        WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [value.sessionId, value.turnId, failureKey])
      expect(event.rows).toHaveLength(1)
      await adminPool!.query(`UPDATE "agent_outbox" SET "aggregateId" = $2,
        "payload" = jsonb_set("payload", '{sessionId}', to_jsonb($2::text)) WHERE "idempotencyKey" = $1`,
        [`agent-event:${event.rows[0]!.id}`, value.foreignSessionId])
    }
    const failureEvent = await adminPool!.query<{ id: string }>(`SELECT "id" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [value.sessionId, value.turnId, failureKey])
    expect(failureEvent.rows).toHaveLength(1)
    const failureOutboxBefore = await adminPool!.query(`SELECT * FROM "agent_outbox" WHERE "idempotencyKey" = $1`,
      [`agent-event:${failureEvent.rows[0]!.id}`])
    const before = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)).rejects.toMatchObject({
      code: "task_graph_operational_failure_replacement_not_eligible",
    })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
    expect(await adminPool!.query(`SELECT * FROM "agent_outbox" WHERE "idempotencyKey" = $1`,
      [`agent-event:${failureEvent.rows[0]!.id}`])).toEqual(failureOutboxBefore)
  }, 90_000)

  it("refuses claims and serializes a forged attempted descendant before replacement", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareOperationalFailureReplan(adminPool!, commandPool!, roleName, value, "scout_analyst_closure")
    const descendant = prepared.sourceNodes.find(node => node.taskId !== prepared.failedRoot.taskId)
    if (!descendant) throw new Error("Operational-failure race fixture lost its cancelled descendant")
    const claim = await new PgSubagentTaskStore(commandPool!).claim({ taskId: descendant.taskId, sessionId: value.sessionId,
      ownerId: `worker-claim-operational-descendant-${randomUUID()}`,
      policy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }, now: new Date() })
    expect(claim).toBeNull()
    const lock = await adminPool!.connect()
    let transactionOpen = false
    try {
      await lock.query("BEGIN")
      transactionOpen = true
      await lock.query(`SELECT "id" FROM "sub_agent_tasks" WHERE "id" = $1 FOR UPDATE`, [descendant.taskId])
      let settled = false
      const replacement = prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation).then(
        () => ({ status: "fulfilled" as const }), error => ({ status: "rejected" as const, error }))
      void replacement.then(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 40))
      expect(settled).toBe(false)
      const changed = await lock.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 1
        WHERE "id" = $1 AND "status" = 'cancelled' AND "attemptCount" = 0`, [descendant.taskId])
      expect(changed.rowCount).toBe(1)
      await lock.query("COMMIT")
      transactionOpen = false
      const outcome = await replacement
      expect(outcome.status).toBe("rejected")
      if (outcome.status === "rejected") expect(outcome.error).toMatchObject({ code: "task_graph_operational_failure_replacement_not_eligible" })
      const unchanged = await prepared.command.readCurrent(readScope(value))
      expect(unchanged.revision).toBe(prepared.current.revision)
      expect(unchanged.nodes.map(node => node.taskId)).toEqual(prepared.current.nodes.map(node => node.taskId))
      const plan = await adminPool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`,
        [value.sessionId, value.turnId, taskGraphProposalKey(value.rootTaskId, prepared.input.proposal.expectedRevision)])
      expect(plan.rows).toHaveLength(0)
    } finally {
      if (transactionOpen) await lock.query("ROLLBACK").catch(() => undefined)
      lock.release()
    }
  }, 90_000)

  it("keeps automatic descendant cancellation intact and rolls back replacements after a late plan-event failure", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareOperationalFailureReplan(adminPool!, commandPool!, roleName, value, "scout_analyst_closure")
    const suffix = randomUUID().replaceAll("-", "")
    const functionName = `operational_plan_failure_${suffix}`
    const triggerName = `operational_plan_failure_${suffix}`
    const planKey = taskGraphProposalKey(value.rootTaskId, prepared.current.revision)
    try {
      await adminPool!.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $operational_failure$
        BEGIN
          IF NEW."sessionId" = TG_ARGV[0] AND NEW."idempotencyKey" = TG_ARGV[1] THEN
            RAISE EXCEPTION 'operational_failure_test_plan_receipt_failure';
          END IF;
          RETURN NEW;
        END
        $operational_failure$`)
      await adminPool!.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."agent_events"
        FOR EACH ROW EXECUTE FUNCTION public."${functionName}"('${value.sessionId}', '${planKey}')`)
      const before = await supersessionDurableRows(adminPool!, value)
      const immutable = await failedBranchImmutableRows(adminPool!, value, [prepared.failedRoot.taskId])
      await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
        .rejects.toThrow("operational_failure_test_plan_receipt_failure")
      expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
      expect(await failedBranchImmutableRows(adminPool!, value, [prepared.failedRoot.taskId])).toEqual(immutable)
      const sources = await adminPool!.query<{ id: string; status: string; attemptCount: number }>(
        `SELECT "id", "status", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
        [prepared.sourceTaskIds])
      expect(sources.rows.map(row => row.status).sort()).toEqual(["cancelled", "failed"])
    } finally {
      await adminPool!.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."agent_events"`)
      await adminPool!.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`)
    }
  }, 90_000)

  it("cancels only a failed Scout's waiting descendants while preserving failed-root proof and usage", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, value)
    expect(prepared.current.nodes.filter(node => node.key === "source-analyst" || node.key === "source-scout").map(node => node.key))
      .toEqual(["source-analyst", "source-scout"])
    const failedRootId = prepared.sourceTaskIds[0]!
    const waitingDescendantId = prepared.sourceTaskIds[1]!
    const before = await failedBranchImmutableRows(adminPool!, value, [failedRootId])
    const sourceRowsBefore = await adminPool!.query<{ id: string; status: string; attemptCount: number }>(
      `SELECT "id", "status", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [prepared.sourceTaskIds])
    expect(sourceRowsBefore.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: failedRootId, status: "failed" }),
      expect.objectContaining({ id: waitingDescendantId, status: "waiting", attemptCount: 0 }),
    ]))
    expect(before.usage).toMatchObject({
      turn: [{ id: value.turnId, inputTokens: 47, outputTokens: 13, estimatedCostUsd: "0.00420000" }],
      steps: expect.arrayContaining([
        { id: value.laterStepId, inputTokens: 47, outputTokens: 13, estimatedCostUsd: "0.00420000" },
      ]),
    })
    const receipt = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    expect(receipt).toMatchObject({ status: "accepted", revision: prepared.current.revision + prepared.sourceTaskIds.length })
    expect(receipt.nodes.map(node => node.key)).toEqual(["failed-replacement-scout", "failed-replacement-analyst"])
    expect(receipt.nodes.map(node => node.taskId).some(id => prepared.sourceTaskIds.includes(id))).toBe(false)
    expect(receipt.readyTaskIds).toEqual([receipt.nodes[0]!.taskId])
    expect(receipt.revision).toBe(prepared.current.revision + 2)
    expect(await failedBranchImmutableRows(adminPool!, value, [failedRootId])).toEqual(before)
    const cancelledDescendant = await adminPool!.query<{ id: string; status: string; attemptCount: number; failureReason: string | null }>(
      `SELECT "id", "status", "attemptCount", "failureReason" FROM "sub_agent_tasks" WHERE "id" = $1`, [waitingDescendantId])
    expect(cancelledDescendant.rows).toEqual([{ id: waitingDescendantId, status: "cancelled", attemptCount: 0, failureReason: null }])
    const cancellationKey = taskGraphLifecycleKey(value.rootTaskId, "source-analyst", 0, "task.cancelled")
    const cancellationEvent = await adminPool!.query<{ id: string; sequence: string; type: string; actor: string; taskId: string;
      causationId: string | null; idempotencyKey: string; payload: unknown }>(`SELECT "id", "sequence"::text AS "sequence", "type", "actor", "taskId",
        "causationId", "idempotencyKey", "payload" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`,
    [value.sessionId, value.turnId, cancellationKey])
    expect(cancellationEvent.rows).toHaveLength(1)
    expect(cancellationEvent.rows[0]).toMatchObject({ type: "item.delta", actor: "system", taskId: waitingDescendantId,
      causationId: prepared.scope.stepId, idempotencyKey: cancellationKey })
    const cancellationPayload = cancellationEvent.rows[0]!.payload as { event: { expectedRevision: number; nodeKey: string }; revision: number }
    expect(cancellationPayload).toMatchObject({ event: { expectedRevision: prepared.current.revision, nodeKey: "source-analyst" },
      revision: prepared.current.revision + 1 })
    const cancellationOutbox = await adminPool!.query<{ topic: string; aggregateId: string; idempotencyKey: string }>(
      `SELECT "topic", "aggregateId", "idempotencyKey" FROM "agent_outbox" WHERE "idempotencyKey" = $1`,
      [`agent-event:${cancellationEvent.rows[0]!.id}`])
    expect(cancellationOutbox.rows).toEqual([{ topic: "agent.session.event", aggregateId: value.sessionId,
      idempotencyKey: `agent-event:${cancellationEvent.rows[0]!.id}` }])

    const current = await prepared.command.readCurrent(readScope(value))
    expect(current.nodes).toHaveLength(8)
    expect(current.nodes.some(node => node.key === "source-scout" || node.key === "source-analyst")).toBe(false)
    expect(prepared.sourceTaskIds.some(taskId => current.nodes.some(node => node.taskId === taskId))).toBe(false)
    expect(current.nodes.find(node => node.key === "retained-repair")?.repairOf).toMatchObject({ nodeKey: "reserve-target" })
    expect(current.nodes.find(node => node.key === "failed-replacement-scout")?.status).toBe("queued")
    expect(current.nodes.find(node => node.key === "failed-replacement-analyst")?.status).toBe("waiting")
    const newRows = await adminPool!.query<{ id: string; status: string; attemptCount: number; result: unknown }>(
      `SELECT "id", "status", "attemptCount", "result" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
      [receipt.nodes.map(node => node.taskId)])
    expect(newRows.rows).toHaveLength(2)
    expect(newRows.rows.every(row => row.attemptCount === 0 && row.result === null)).toBe(true)

    const key = steeringReconciliationIdempotencyKey(prepared.scope, value.planCallId)
    const persisted = await adminPool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [value.sessionId, value.turnId, key])
    expect(persisted.rows).toHaveLength(1)
    const relation = (persisted.rows[0]!.payload as { failedBranch?: Record<string, unknown> }).failedBranch
    expect(relation).toMatchObject({ graphRootTaskId: value.rootTaskId, observedRevision: prepared.current.revision,
      resultingRevision: receipt.revision, requestFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      sources: [{ source: { nodeKey: "source-analyst", taskId: waitingDescendantId }, replacementKey: "failed-replacement-analyst" },
        { source: { nodeKey: "source-scout", taskId: failedRootId }, replacementKey: "failed-replacement-scout" }],
      cancellations: [expect.objectContaining({ source: { nodeKey: "source-analyst", taskId: waitingDescendantId },
        event: { id: cancellationEvent.rows[0]!.id, sequence: cancellationEvent.rows[0]!.sequence, idempotencyKey: cancellationKey } })],
      planEvent: { idempotencyKey: taskGraphProposalKey(value.rootTaskId, prepared.current.revision + 1) } })
  }, 60_000)

  it("accepts a strict native command as the latest pre-call failed-branch snapshot", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, value, "native-observed",
      { retainedNodeCount: 3, addNativeSnapshot: true })
    expect(prepared.current.nodes).toHaveLength(8)
    const eventSnapshot = await adminPool!.query<{
      nativeCount: number
      nativeEvent: null | { id: string; sequence: string; type: string; payloadKind: string; revision: number; receiptStatus: string; nodeKey: string; childTaskId: string; childTaskIdType: string }
      callCount: number
      callEvent: null | { id: string; sequence: string; type: string }
      latestBeforeCall: null | { id: string; sequence: string; type: string; itemId: string }
      preCallCandidates: Array<{ id: string; sequence: string; type: string; itemId: string }>
      filters: unknown
    }>(`WITH scoped_events AS MATERIALIZED (
        SELECT event."id", event."sequence", event."type", event."itemId", event."payload"
        FROM "agent_events" AS event
        WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3
      ), call_events AS MATERIALIZED (
        SELECT event."id", event."sequence", event."type"
        FROM "agent_events" AS event
        WHERE event."sessionId" = $1 AND event."turnId" = $2
          AND event."type" = 'tool_call.started' AND event."correlationId" = $4
      ), native_events AS MATERIALIZED (
        SELECT event."id", event."sequence", event."type", event."payload"
        FROM scoped_events AS event
        WHERE event."payload"->>'kind' = 'native_command'
      ), pre_call_candidates AS MATERIALIZED (
        SELECT event."id", event."sequence", event."type", event."itemId"
        FROM scoped_events AS event CROSS JOIN call_events AS call
        WHERE event."type" IN ('item.started', 'item.delta') AND event."sequence" < call."sequence"
      ), latest_pre_call AS (
        SELECT candidate."id", candidate."sequence", candidate."type", candidate."itemId"
        FROM pre_call_candidates AS candidate ORDER BY candidate."sequence" DESC LIMIT 1
      )
      SELECT
        (SELECT count(*)::int FROM native_events) AS "nativeCount",
        (SELECT jsonb_build_object('id', event."id", 'sequence', event."sequence"::text,
          'type', event."type", 'payloadKind', event."payload"->>'kind', 'revision', event."payload"->'revision',
          'receiptStatus', event."payload"->'receipt'->>'status',
          'nodeKey', event."payload"->'receipt'->>'nodeKey',
          'childTaskId', event."payload"->'receipt'->'child'->>'taskId',
          'childTaskIdType', jsonb_typeof(event."payload"->'receipt'->'child'->'taskId'))
         FROM native_events AS event ORDER BY event."sequence" DESC LIMIT 1) AS "nativeEvent",
        (SELECT count(*)::int FROM call_events) AS "callCount",
        (SELECT jsonb_build_object('id', event."id", 'sequence', event."sequence"::text, 'type', event."type")
         FROM call_events AS event ORDER BY event."sequence" ASC LIMIT 1) AS "callEvent",
        (SELECT jsonb_build_object('id', event."id", 'sequence', event."sequence"::text,
          'type', event."type", 'itemId', event."itemId") FROM latest_pre_call AS event) AS "latestBeforeCall",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id', event."id", 'sequence', event."sequence"::text,
          'type', event."type", 'itemId', event."itemId") ORDER BY event."sequence" DESC)
          FROM pre_call_candidates AS event), '[]'::jsonb) AS "preCallCandidates",
        jsonb_build_object('sessionId', $1::text, 'turnId', $2::text, 'itemId', $3::text,
          'callCorrelationId', $4::text, 'nativeExpectedType', 'item.delta',
          'nativePayloadKind', 'native_command', 'candidateTypes', jsonb_build_array('item.started', 'item.delta'),
          'boundary', 'event.sequence < call.sequence', 'latestOrder', 'event.sequence DESC LIMIT 1') AS "filters"`,
    [value.sessionId, value.turnId, taskGraphItemId(value.rootTaskId), value.planCallId])
    expect(eventSnapshot.rows).toHaveLength(1)
    const observed = eventSnapshot.rows[0]!
    const nativeEvent = observed.nativeEvent
    const nativeDiagnostic = nativeEvent && {
      id: nativeEvent.id, sequence: nativeEvent.sequence, type: nativeEvent.type, kind: nativeEvent.payloadKind,
    }
    const diagnostic = JSON.stringify({ filters: observed.filters, nativeExists: observed.nativeCount > 0,
      nativeCount: observed.nativeCount, native: nativeDiagnostic, callCount: observed.callCount,
      call: observed.callEvent, latestBeforeCall: observed.latestBeforeCall, preCallCandidates: observed.preCallCandidates })
    const nativeContractIsValid = nativeEvent?.type === "item.delta" && nativeEvent.payloadKind === "native_command"
      && nativeEvent.revision === prepared.current.revision && nativeEvent.receiptStatus === "accepted"
      && nativeEvent.childTaskIdType === "string" && Boolean(nativeEvent.nodeKey) && Boolean(nativeEvent.childTaskId)
    expect({ nativeCount: observed.nativeCount, nativeExists: nativeEvent !== null },
      `Same-snapshot native receipt diagnostic: ${diagnostic}`).toEqual({ nativeCount: 1, nativeExists: true })
    expect(nativeContractIsValid, `Same-snapshot native receipt diagnostic: ${diagnostic}`).toBe(true)
    expect(observed.callCount, `Same-snapshot planner-call diagnostic: ${diagnostic}`).toBe(1)
    expect(observed.callEvent, `Same-snapshot planner-call diagnostic: ${diagnostic}`).not.toBeNull()
    expect(BigInt(nativeEvent!.sequence) < BigInt(observed.callEvent!.sequence),
      `Same-snapshot native-before-call diagnostic: ${diagnostic}`).toBe(true)
    expect(observed.latestBeforeCall, `Same-snapshot native event ordering diagnostic: ${diagnostic}`)
      .toMatchObject({ id: nativeEvent!.id, sequence: nativeEvent!.sequence })

    const receipt = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    expect(receipt).toMatchObject({ status: "accepted", revision: prepared.current.revision + 2 })
    expect(receipt.nodes.map(node => node.key)).toEqual(["native-observed-scout", "native-observed-analyst"])
    const after = await prepared.command.readCurrent(readScope(value))
    expect(after.nodes).toHaveLength(8)
    const nativeNodeWasRetained = after.nodes.some(node => node.key === nativeEvent!.nodeKey && node.taskId === nativeEvent!.childTaskId)
    expect(nativeNodeWasRetained).toBe(true)
    expect(after.nodes.some(node => node.key === "source-scout" || node.key === "source-analyst")).toBe(false)
  }, 60_000)

  it("proves exact failed-branch replay after a later replan and still fences a completed original Step", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const first = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, value)
    const firstReceipt = await first.command.appendAndScheduleWithReconciliation!(first.input, first.operation)
    expect(firstReceipt).toMatchObject({ status: "accepted" })
    const later = await prepareFollowingFailedBranchReplan(first, firstReceipt.revision)
    const laterReceipt = await later.command.appendAndScheduleWithReconciliation!(later.input, later.operation)
    expect(laterReceipt).toMatchObject({ status: "accepted" })
    expect(laterReceipt.nodes.map(node => node.taskId)).not.toEqual(firstReceipt.nodes.map(node => node.taskId))
    const beforeReplay = await supersessionDurableRows(adminPool!, value)
    const replay = await first.command.appendAndScheduleWithReconciliation!(first.input, first.operation)
    expect(replay).toMatchObject({ status: "duplicate", revision: firstReceipt.revision,
      nodes: firstReceipt.nodes, readyTaskIds: firstReceipt.readyTaskIds })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(beforeReplay)

    const changedInput: TaskGraphScheduleInput = { ...first.input, proposal: { ...first.input.proposal,
      nodes: first.input.proposal.nodes.map((node, index) => index === 0 ? { ...node, goal: "Changed failed-branch call" } : node) } }
    await expect(first.command.appendAndScheduleWithReconciliation!(changedInput, first.operation))
      .rejects.toMatchObject({ code: "idempotency_conflict" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(beforeReplay)

    const completed = await adminPool!.query(`UPDATE "agent_steps" SET "status" = 'completed'
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "status" = 'streaming'`, [value.laterStepId, value.sessionId, value.turnId])
    expect(completed.rowCount).toBe(1)
    const beforeFencedReplay = await supersessionDurableRows(adminPool!, value)
    await expect(first.command.appendAndScheduleWithReconciliation!(first.input, first.operation)).rejects.toThrow("task_graph_step_fenced")
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(beforeFencedReplay)
  }, 60_000)

  it("rejects extant misbound failed-source provenance before creating replacements", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, value)
    const failedRow = await adminPool!.query<{ attemptCount: number }>(`SELECT "attemptCount" FROM "sub_agent_tasks" WHERE "id" = $1`,
      [prepared.sourceTaskIds[0]])
    expect(failedRow.rows).toHaveLength(1)
    const failureKey = taskGraphLifecycleKey(value.rootTaskId, "source-scout", failedRow.rows[0]!.attemptCount, "task.failed")
    const event = await adminPool!.query<{ id: string }>(`SELECT "id" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [value.sessionId, value.turnId, failureKey])
    expect(event.rows).toHaveLength(1)
    const tampered = await adminPool!.query(`UPDATE "agent_outbox" SET "payload" = jsonb_set("payload", '{payload,event,nodeKey}', to_jsonb('misbound-source'::text), false)
      WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [value.sessionId, `agent-event:${event.rows[0]!.id}`])
    expect(tampered.rowCount).toBe(1)
    const before = await supersessionDurableRows(adminPool!, value)
    const immutableBefore = await failedBranchImmutableRows(adminPool!, value, prepared.sourceTaskIds)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .rejects.toMatchObject({ code: "task_graph_branch_repair_not_eligible" })
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
    expect(await failedBranchImmutableRows(adminPool!, value, prepared.sourceTaskIds))
      .toEqual(immutableBefore)
  }, 60_000)

  it("rejects an extant misbound operation-created cancellation receipt on replay", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, value)
    const accepted = await prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation)
    const cancellationKey = taskGraphLifecycleKey(value.rootTaskId, "source-analyst", 0, "task.cancelled")
    const event = await adminPool!.query<{ id: string }>(`SELECT "id" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "idempotencyKey" = $3`, [value.sessionId, value.turnId, cancellationKey])
    expect(event.rows).toHaveLength(1)
    const tampered = await adminPool!.query(`UPDATE "agent_outbox" SET "payload" = jsonb_set("payload", '{payload,event,nodeKey}', to_jsonb('misbound-source'::text), false)
      WHERE "aggregateId" = $1 AND "idempotencyKey" = $2`, [value.sessionId, `agent-event:${event.rows[0]!.id}`])
    expect(tampered.rowCount).toBe(1)
    const beforeReplay = await supersessionDurableRows(adminPool!, value)
    await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
      .rejects.toThrow("steering_reconciliation_failed_branch_event_invalid")
    expect(await supersessionDurableRows(adminPool!, value)).toEqual(beforeReplay)
    expect(accepted.revision).toBe(prepared.current.revision + 2)
  }, 60_000)

  it("keeps typed repair reserve, owner and revision fences, and post-insert rollback on failed-branch replans", async () => {
    const ownerFixture = fixture()
    additionalFixtures.push(ownerFixture)
    const ownerCase = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, ownerFixture)
    const wrongOwnerInput = { ...ownerCase.input, scope: { ...ownerCase.input.scope, parentLeaseOwner: "wrong-parent-owner" } }
    const wrongOwnerOperation = { ...ownerCase.operation, scope: { ...ownerCase.operation.scope, parentLeaseOwner: "wrong-parent-owner" } }
    const beforeOwner = await supersessionDurableRows(adminPool!, ownerFixture)
    await expect(ownerCase.command.appendAndScheduleWithReconciliation!(wrongOwnerInput, wrongOwnerOperation)).rejects.toThrow("task_graph_parent_fenced")
    expect(await supersessionDurableRows(adminPool!, ownerFixture)).toEqual(beforeOwner)

    const revisionFixture = fixture()
    additionalFixtures.push(revisionFixture)
    const revisionCase = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, revisionFixture)
    const retained = revisionCase.current.nodes.find(node => node.key === "retained-a")
    if (!retained) throw new Error("Failed-branch revision fixture lost its retained task")
    const claimed = await new PgSubagentTaskStore(commandPool!).claim({ taskId: retained.taskId, sessionId: revisionFixture.sessionId,
      ownerId: `worker-advance-graph-${randomUUID()}`, policy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }, now: new Date() })
    expect(claimed).toMatchObject({ status: "running", attemptCount: 1 })
    const beforeRevisionConflict = await supersessionDurableRows(adminPool!, revisionFixture)
    await expect(revisionCase.command.appendAndScheduleWithReconciliation!(revisionCase.input, revisionCase.operation))
      .rejects.toMatchObject({ code: "revision_mismatch" })
    expect(await supersessionDurableRows(adminPool!, revisionFixture)).toEqual(beforeRevisionConflict)

    const budgetFixture = fixture()
    additionalFixtures.push(budgetFixture)
    const budgetCase = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, budgetFixture)
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "budgetSnapshot" = '{"maxSteps":0}'::jsonb WHERE "id" = $1`, [budgetFixture.rootTaskId])
    const beforeBudget = await supersessionDurableRows(adminPool!, budgetFixture)
    await expect(budgetCase.command.appendAndScheduleWithReconciliation!(budgetCase.input, budgetCase.operation))
      .rejects.toMatchObject({ code: "task_graph_continuation_budget_required" })
    expect(await supersessionDurableRows(adminPool!, budgetFixture)).toEqual(beforeBudget)
  }, 90_000)

  it("rolls back fresh task rows and dispatch when a failed-branch plan receipt fails after insertion", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    const prepared = await prepareFailedBranchReplan(adminPool!, commandPool!, roleName, value)
    const suffix = randomUUID().replaceAll("-", "")
    const functionName = `failed_branch_plan_failure_${suffix}`
    const triggerName = `failed_branch_plan_failure_${suffix}`
    const planKey = taskGraphProposalKey(value.rootTaskId, prepared.current.revision + 1)
    try {
      await adminPool!.query(`CREATE FUNCTION public."${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $branch_failure$
        BEGIN
          IF NEW."sessionId" = TG_ARGV[0] AND NEW."idempotencyKey" = TG_ARGV[1] THEN
            RAISE EXCEPTION 'failed_branch_test_plan_receipt_failure';
          END IF;
          RETURN NEW;
        END
        $branch_failure$`)
      await adminPool!.query(`CREATE TRIGGER "${triggerName}" BEFORE INSERT ON public."agent_events"
        FOR EACH ROW EXECUTE FUNCTION public."${functionName}"('${value.sessionId}', '${planKey}')`)
      const before = await supersessionDurableRows(adminPool!, value)
      const immutableBefore = await failedBranchImmutableRows(adminPool!, value, prepared.sourceTaskIds)
      await expect(prepared.command.appendAndScheduleWithReconciliation!(prepared.input, prepared.operation))
        .rejects.toThrow("failed_branch_test_plan_receipt_failure")
      expect(await supersessionDurableRows(adminPool!, value)).toEqual(before)
      expect(await failedBranchImmutableRows(adminPool!, value, prepared.sourceTaskIds))
        .toEqual(immutableBefore)
      const restored = await adminPool!.query<{ id: string; status: string; attemptCount: number }>(
        `SELECT "id", "status", "attemptCount" FROM "sub_agent_tasks" WHERE "id" = ANY($1::text[]) ORDER BY "id"`,
        [prepared.sourceTaskIds])
      expect(restored.rows).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: prepared.sourceTaskIds[0], status: "failed" }),
        expect.objectContaining({ id: prepared.sourceTaskIds[1], status: "waiting", attemptCount: 0 }),
      ]))
    } finally {
      await adminPool!.query(`DROP TRIGGER IF EXISTS "${triggerName}" ON public."agent_events"`)
      await adminPool!.query(`DROP FUNCTION IF EXISTS public."${functionName}"()`)
    }
  }, 60_000)

  it("blocks terminal finalization when a persisted Analyst attempt changes after completion was accepted", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const jobId = scheduledDraftJobId(value, "finalize")
    const sources = await seedVerifiedScheduledDraftSources(adminPool!, value, command, [
      { scoutKey: "scout-finalize", analystKey: "analyst-finalize", jobId, score: 9, hasFinding: true },
    ])
    await adminPool!.query(`INSERT INTO "Job" ("id", "userId", "company", "role", "location", "status", "url", "description", "source", "updatedAt")
      VALUES ($1, $2, 'Fixture GmbH', 'Software Engineer', 'Berlin', 'saved', 'https://jobs.example.invalid/finalization',
        'Original selected source for finalization', 'test', CURRENT_TIMESTAMP)`, [jobId, value.userId])
    await adminPool!.query(`INSERT INTO "Resume" ("id", "userId", "name", "content", "kind", "origin", "isDefault", "updatedAt")
      VALUES ($1, $2, 'Finalization fixture base', $3::jsonb, 'base', 'manual', TRUE, CURRENT_TIMESTAMP)`, [
      `scheduled-draft-resume-${value.sessionId}`, value.userId, JSON.stringify({ text: "Fixture base resume" }),
    ])
    const selectedJobContext = await loadSelectedJobArtifactContext(adminPool!, value.userId, jobId)
    await command.appendAndSchedule(scheduledDraftInput(value, 1, [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft from the verified finding", successCriteria: ["Persist the selected-job draft"], dependsOn: ["analyst-finalize"] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review the selected-job draft", successCriteria: ["Persist the review receipt"], dependsOn: ["writer"] },
    ]))
    await expect(scheduledDraftRootAllowedActions(adminPool!, value)).resolves.toEqual(sources.rootAllowedActions)
    const pair = await adminPool!.query<{ id: string; role: string }>(`SELECT "id", "role" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "parentTaskId" = $2 AND "role" IN ('writer', 'reviewer') ORDER BY "role"`,
    [value.sessionId, value.rootTaskId])
    const writer = pair.rows.find(row => row.role === "writer"), reviewer = pair.rows.find(row => row.role === "reviewer")
    if (!writer || !reviewer) throw new Error("Scheduled-draft finalization fixture did not create its Writer and Reviewer")
    const sourceDigest = selectedJobContext.preparation.sourceDigest
    const contentHash = `sha256:${"b".repeat(64)}`
    const reviewHash = `sha256:${"c".repeat(64)}`
    const constraintHash = `sha256:${"d".repeat(64)}`
    const requestHash = `sha256:${"e".repeat(64)}`
    const artifactRef = { artifactId: `scheduled-draft-artifact-${value.rootTaskId.slice(-36)}`, version: 1, contentHash, sourceDigest }
    const artifactVersionId = `scheduled-draft-version-${value.sessionId}`
    const artifactContent = { text: "Fixture draft saved" }
    await adminPool!.query(`INSERT INTO "agent_artifact"
      ("id", "userId", "jobId", "artifactType", "lifecycle", "content", "hash", "constraintHash", "version", "updatedAt")
      VALUES ($1, $2, $3, 'cover_letter', 'draft', $4::jsonb, $5, $6, 1, CURRENT_TIMESTAMP)`, [
      artifactRef.artifactId, value.userId, jobId, JSON.stringify(artifactContent), contentHash, constraintHash,
    ])
    await adminPool!.query(`INSERT INTO "agent_artifact_version"
      ("id", "artifactId", "version", "userId", "sessionId", "jobId", "artifactType", "content", "contentHash", "sourceDigest",
       "constraintHash", "provenanceRefs", "evidenceRefs", "baseId", "baseHash", "previousHash", "taskId", "toolCallId", "requestHash")
      VALUES ($1, $2, 1, $3, $4, $5, 'cover_letter', $6::jsonb, $7, $8, $9, ARRAY[]::text[], $10::text[], $11, $12, NULL, $13, $14, $15)`, [
      artifactVersionId, artifactRef.artifactId, value.userId, value.sessionId, jobId, JSON.stringify(artifactContent), contentHash,
      sourceDigest, constraintHash, [`job:${jobId}`], `scheduled-draft-base-${value.sessionId}`, `sha256:${"f".repeat(64)}`,
      writer.id, `scheduled-draft-write-${value.sessionId}`, requestHash,
    ])
    await adminPool!.query(`INSERT INTO "agent_artifact_review"
      ("id", "artifactVersionId", "userId", "sessionId", "jobId", "artifactId", "version", "contentHash", "sourceDigest",
       "currentSourceDigest", "status", "findings", "evidenceRefs", "taskId", "toolCallId", "requestHash", "reviewHash")
      VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8, $8, 'passed', '[]'::jsonb, $9::text[], $10, $11, $12, $13)`, [
      `scheduled-draft-review-row-${value.sessionId}`, artifactVersionId, value.userId, value.sessionId, jobId, artifactRef.artifactId,
      contentHash, sourceDigest, [`job:${jobId}`], reviewer.id, `scheduled-draft-review-${value.sessionId}`, requestHash, reviewHash,
    ])
    const writerResult = {
      status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: null, finalText: "Fixture draft saved",
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef },
    }
    const reviewerResult = {
      status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: null, finalText: "Fixture review passed",
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash },
    }
    for (const [taskId, result] of [[writer.id, writerResult], [reviewer.id, reviewerResult]] as const) {
      const completed = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "result" = $3::jsonb,
        "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = $1 AND "sessionId" = $2 AND "status" IN ('queued', 'waiting')`,
      [taskId, value.sessionId, JSON.stringify(result)])
      expect(completed.rowCount).toBe(1)
    }
    const artifactRepository = createAgentArtifactRepository(adminPool!)
    const lease: TurnLease = {
      turnId: value.turnId, sessionId: value.sessionId, userId: value.userId, ownerId: value.turnLeaseOwner,
      leaseVersion: 1, leaseStartedAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000),
    }
    const alignedRootLease = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "leaseOwner" = $2,
      "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '5 minutes', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "sessionId" = $3 AND "status" = 'running' AND "attemptCount" = 1`,
    [value.rootTaskId, value.turnLeaseOwner, value.sessionId])
    expect(alignedRootLease.rowCount).toBe(1)
    const runtime = createCanonicalScheduledDraftRuntime({
      pool: adminPool!, commandPort: command, lease, root: { id: value.rootTaskId, attemptCount: 1 }, artifactRepository,
    })
    await expect(runtime.complete()).resolves.toEqual({ ok: true })
    await expect(scheduledDraftRootAllowedActions(adminPool!, value)).resolves.toEqual(sources.rootAllowedActions)

    const positiveClient = await adminPool!.connect()
    try {
      await positiveClient.query("BEGIN")
      await expect(runtime.finalize(positiveClient)).resolves.toEqual({ ok: true })
      await expect(scheduledDraftRootAllowedActions(positiveClient, value)).resolves.toEqual(sources.rootAllowedActions)
    } finally {
      await positiveClient.query("ROLLBACK").catch(() => undefined)
      positiveClient.release()
    }

    const analystTaskId = sources.analysts[0]?.taskId
    if (!analystTaskId) throw new Error("Scheduled-draft finalization fixture lost its Analyst task")
    const bumped = await adminPool!.query(`UPDATE "sub_agent_tasks" SET "attemptCount" = 2
      WHERE "id" = $1 AND "sessionId" = $2 AND "attemptCount" = 1`, [analystTaskId, value.sessionId])
    expect(bumped.rowCount).toBe(1)
    const client = await adminPool!.connect()
    try {
      await client.query("BEGIN")
      await expect(runtime.finalize(client)).resolves.toMatchObject({ ok: false, blocker: "selected_job_draft_review_required" })
    } finally {
      await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }
  }, 60_000)

  it("reads ordinary Scout provenance only for the current live lease and attempt", async () => {
    const value = fixture()
    additionalFixtures.push(value)
    await seed(adminPool!, value)
    const scoutActions = [...TASK_GRAPH_TEMPLATES.scout.allowedActions]
    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "allowedActions" = $2::jsonb
      WHERE "id" = $1 AND "sessionId" = $3 AND "turnId" = $4 AND "status" = 'running'
        AND "leaseOwner" = $5 AND "attemptCount" = 1`, [
      value.rootTaskId, JSON.stringify(["agent.plan", ...scoutActions]), value.sessionId, value.turnId, value.parentLeaseOwner,
    ])
    const agendaSequence = await nextEventSequence(adminPool!, value)
    await seedReconciliationAgenda(adminPool!, value, {
      id: value.stepId, sequence: agendaSequence, cursor: 0n, planRevision: 0, consumedInputIds: [],
    })
    const input: TaskGraphScheduleInput = {
      scope: { ...readScope(value), stepId: value.stepId },
      proposal: { expectedRevision: 0, nodes: [{
        key: "ordinary-scout", templateId: "scout", goal: "Find matching jobs",
        successCriteria: ["Return candidates supported by fresh job reads"],
        verification: {
          schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
          criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
        },
        dependsOn: [],
      }] },
      templates: { scout: TASK_GRAPH_TEMPLATES.scout },
    }
    const command = createPgTaskGraphCommandPort(restrictedTransactionPool(commandPool!, roleName, value.userId))
    const accepted = await command.appendAndSchedule(input)
    expect(accepted.status).toBe("accepted")
    const taskId = accepted.readyTaskIds[0]
    expect(taskId).toBeTruthy()
    const ownerId = `provenance-worker-${randomUUID()}`
    const claimed = await new PgSubagentTaskStore(commandPool!).claim({
      taskId: taskId!, sessionId: value.sessionId, ownerId,
      policy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 }, now: new Date(),
    })
    expect(claimed).toMatchObject({ status: "running", role: "scout", taskType: "job_discovery", attemptCount: 1, leaseOwner: ownerId })
    if (!claimed?.leaseExpiresAt) throw new Error("Scout provenance fixture did not receive a live lease")
    const lease = { ...claimed, ownerId, leaseExpiresAt: claimed.leaseExpiresAt, signal: new AbortController().signal }
    const scopedPool = restrictedRolePool(commandPool!, roleName)
    const collectorFence = {
      taskId: lease.id, rootTaskId: lease.rootTaskId, sessionId: lease.sessionId,
      turnId: lease.turnId!, attemptCount: lease.attemptCount,
    }
    const observeRecovery = async (candidate: typeof lease) => {
      const observers = await createChildDiscoveryObservers(scopedPool as never, candidate, collectorFence)
      const call = {
        id: `pg-discovery-${randomUUID()}`, toolName: "jobs.discover", toolVersion: "1",
        sessionId: candidate.sessionId, turnId: candidate.turnId!, stepId: value.stepId,
        taskId: candidate.id, rootTaskId: candidate.rootTaskId,
      }
      const output = {
        jobs: [{ id: "c123456789012345678901234", title: "Engineer", company: "Example", location: "Dublin",
          url: "https://jobs.example/123", description: "Role", fullDescription: "Role", salary: null, logo: null,
          source: "greenhouse", evidenceRefs: ["evidence-1"] }],
        evidence: [{ evidenceId: "evidence-1", jobId: "c123456789012345678901234", kind: "source", source: "greenhouse",
          url: "https://jobs.example/123", summary: "Discovered from the Greenhouse source" }],
        nextCursor: null,
        usage: { ledgerKey: "ledger-1", toolName: call.toolName, toolVersion: call.toolVersion, toolCallId: call.id,
          sessionId: call.sessionId, turnId: call.turnId, stepId: call.stepId, requests: 1, jobsProcessed: 1,
          jobsSucceeded: 1, jobsFailed: 0, providerFailures: 0, aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 1 },
      }
      observers.observeLifecycleEvent({ call, phase: "started" })
      observers.observeLifecycleEvent({ call, phase: "completed", output })
      return observers.discoveryRecoverySidecar()
    }

    await expect(observeRecovery(lease)).resolves.toMatchObject({ attemptCount: lease.attemptCount, jobIds: ["c123456789012345678901234"] })

    const clearTurnLease = async (status: string) => adminPool!.query(`UPDATE "agent_turns" SET "status" = $2,
        "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL, "leaseStartedAt" = NULL
      WHERE "id" = $1 AND "sessionId" = $3`, [value.turnId, status, value.sessionId])
    for (const status of ["waiting_for_dependency", "queued"]) {
      await clearTurnLease(status)
      await expect(observeRecovery(lease)).resolves.toMatchObject({ attemptCount: lease.attemptCount, jobIds: ["c123456789012345678901234"] })
    }
    await clearTurnLease("completed")
    await expect(observeRecovery(lease)).resolves.toBeUndefined()
    await clearTurnLease("in_progress")

    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP - INTERVAL '1 second'
      WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $4`, [
      lease.id, lease.sessionId, ownerId, lease.attemptCount,
    ])
    await expect(observeRecovery(lease)).resolves.toBeUndefined()

    await adminPool!.query(`UPDATE "sub_agent_tasks" SET "leaseExpiresAt" = CURRENT_TIMESTAMP + INTERVAL '1 minute',
        "attemptCount" = "attemptCount" + 1
      WHERE "id" = $1 AND "sessionId" = $2 AND "leaseOwner" = $3 AND "attemptCount" = $4`, [
      lease.id, lease.sessionId, ownerId, lease.attemptCount,
    ])
    await expect(observeRecovery(lease)).resolves.toBeUndefined()
  }, 60_000)
})
