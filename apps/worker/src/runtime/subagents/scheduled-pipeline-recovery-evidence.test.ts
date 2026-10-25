import { createHash } from "node:crypto"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { scheduledAuditWaitKey } from "./scheduled-audit-resume.js"
import { SCHEDULED_AUDIT_NODE_CRITERIA, SCHEDULED_AUDIT_NODE_GOAL, SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { createTurnScheduledGateChoiceContent, TURN_SCHEDULED_GATE_CHOICE_SCHEMA, turnScheduledGateChoiceWaitId } from "../turns/turn-question-gate-choice-contract.js"
import { taskGraphItemId, taskGraphProposalKey, TASK_GRAPH_ITEM_TYPE, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { readScheduledPipelineRecoveryEvidence } from "./scheduled-pipeline-recovery-evidence.js"
import { SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY, scheduledPipelineRecoveryStepMarker,
  withScheduledPipelineRecoveryStepProfile, type ScheduledPipelineRecoverySource,
  type ScheduledPipelineRecoveryStepMarker } from "./scheduled-pipeline-recovery-step.js"

const owner: TurnExecutionOwnerFence = { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1",
  taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseVersion: 3,
  leaseExpiresAt: new Date("2026-10-25T12:00:00.000Z") }
const source: ScheduledPipelineRecoverySource = { owner: { userId: owner.userId, sessionId: owner.sessionId,
  turnId: owner.turnId, rootTaskId: owner.rootTaskId }, sourceEventId: "candidate-event-1", sourceStepId: "candidate-step-4",
  sourceStepOrdinal: 4, rootAttemptCount: 2, inputThroughSequence: "10", consumedInputIds: [] }

type FixtureOptions = Readonly<{
  steps?: readonly Record<string, unknown>[]
  events?: readonly Record<string, unknown>[]
  items?: readonly Record<string, unknown>[]
  waits?: readonly Record<string, unknown>[]
  tasks?: readonly Record<string, unknown>[]
}>

function makeStep(stepId: string, ordinal: number, cursor: string, status: string, errorCode: string | null,
  recoveryCursor = ordinal - source.sourceStepOrdinal, predecessorStepId = ordinal === source.sourceStepOrdinal + 1
    ? source.sourceStepId : `recovery-step-${recoveryCursor - 1}`) {
  const marker = scheduledPipelineRecoveryStepMarker({ owner: source.owner, source, recoveryStepId: stepId,
    recoveryCursor, inputThroughSequence: cursor, ...(recoveryCursor > 1 ? { previous: makeMarker(recoveryCursor - 1, predecessorStepId) } : {}) })
  return { id: stepId, taskId: owner.rootTaskId, ordinal, attempt: 1, status, errorCode, inputThroughSequence: cursor,
    consumedInputIds: [], modelProfileSnapshot: withScheduledPipelineRecoveryStepProfile({ provider: "fixture", model: "fixture" }, marker),
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, marker }
}

function makeMarker(recoveryCursor: number, stepId: string): ScheduledPipelineRecoveryStepMarker {
  const previous: ScheduledPipelineRecoveryStepMarker | undefined = recoveryCursor > 1
    ? makeMarker(recoveryCursor - 1, `recovery-step-${recoveryCursor - 2}`) : undefined
  return scheduledPipelineRecoveryStepMarker({ owner: source.owner, source, recoveryStepId: stepId,
    recoveryCursor, inputThroughSequence: String(10 + recoveryCursor), ...(previous ? { previous } : {}) })
}

function lifecycleEvents(step: ReturnType<typeof makeStep>, result: Readonly<{ status: string; errorCode?: string; waitId?: string }> | null) {
  const started = { id: `${step.id}-started`, taskId: owner.rootTaskId, itemId: null, type: "step.started", actor: "orchestrator",
    correlationId: step.id, idempotencyKey: `turn:${owner.turnId}:event:step-started:${step.id}`,
    payload: { stepId: step.id, ordinal: step.ordinal, taskId: owner.rootTaskId,
      [SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY]: step.marker } }
  if (!result) return [started]
  const payload = { stepId: step.id, status: result.status, ...(result.errorCode ? { errorCode: result.errorCode } : {}),
    taskId: owner.rootTaskId, ...(result.waitId ? { waitId: result.waitId } : {}) }
  return [started, { id: `${step.id}-completed`, taskId: owner.rootTaskId, itemId: null, type: "step.completed", actor: "orchestrator",
    correlationId: step.id, idempotencyKey: `turn:${owner.turnId}:event:step-completed:${step.id}`, payload }]
}

function finalRejectedEvent(step: ReturnType<typeof makeStep>) {
  return { id: `${step.id}-rejected`, taskId: owner.rootTaskId, itemId: null, type: "final.rejected", actor: "orchestrator",
    correlationId: step.id, idempotencyKey: `turn:${owner.turnId}:event:final-rejected:${step.id}:evidence-recovery-once`,
    payload: { code: "evidence_missing", blocker: "candidate_evidence_missing", feedback: "Replan with the required evidence.",
      taskId: owner.rootTaskId } }
}

function auditWait(stepId: string, id = "audit-wait-1", userId = owner.userId) {
  const taskId = "audit-child-1"
  return { id, userId, sessionId: owner.sessionId, turnId: owner.turnId, parentTaskId: owner.rootTaskId,
    stepId, idempotencyKey: scheduledAuditWaitKey(taskId, stepId, 1), targetTaskIds: [taskId], mode: "all",
    status: "waiting", matchedTaskIds: [], result: { request: { targetTaskIds: [taskId], mode: "all", timeoutMs: 86_400_000 } } }
}

function gateWait(stepId: string) {
  const taskId = "gate-child-1", requestAttemptCount = 1
  const digest = createHash("sha256").update(JSON.stringify([taskId, stepId, requestAttemptCount]), "utf8").digest("hex")
  return { id: "gate-ready-1", userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    parentTaskId: owner.rootTaskId, stepId, idempotencyKey: `scheduled-gate-wait:${digest}`,
    targetTaskIds: [taskId], mode: "any", status: "ready", matchedTaskIds: [taskId],
    result: { request: { targetTaskIds: [taskId], mode: "any", timeoutMs: 86_400_000,
      scheduledGate: { gateTaskId: taskId, requestAttemptCount } } } }
}

function auditTask(attemptCount = 2) {
  return { id: "audit-child-1", parentTaskId: owner.rootTaskId, rootTaskId: owner.rootTaskId, sessionId: owner.sessionId,
    turnId: owner.turnId, depth: 1, role: "auditor", taskType: "scheduled_taskgraph_audit", maxAttempts: 3, attemptCount,
    userId: owner.userId }
}

function gateTask() {
  return { id: "gate-child-1", parentTaskId: owner.rootTaskId, rootTaskId: owner.rootTaskId, sessionId: owner.sessionId,
    turnId: owner.turnId, depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", maxAttempts: 3,
    userId: owner.userId }
}

const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [
  { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } },
  { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 1 } },
] }
const analystVerification = (scoutKey: string) => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
  { id: "scout-membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: scoutKey } },
  { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
] })
function auditGraphContent(scoutKey = "scout", analystKey = "analyst") {
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
    { key: scoutKey, templateId: "scout", goal: "Find evidence", successCriteria: ["Found evidence"], dependsOn: [], depth: 1,
      taskId: "scout-child-1", verificationDisposition: "typed", verification: scoutVerification },
    { key: analystKey, templateId: "analyst", goal: "Review evidence", successCriteria: ["Reviewed evidence"], dependsOn: [scoutKey], depth: 2,
      taskId: "analyst-child-1", verificationDisposition: "typed", verification: analystVerification(scoutKey) },
    { key: "prepare", templateId: "prepare", goal: "Prepare the application", successCriteria: ["Preparation is complete"], dependsOn: [analystKey], depth: 3,
      taskId: "prepare-child-1", verificationDisposition: "specialized" },
    { key: "gate", templateId: "gate", goal: "Review the application", successCriteria: ["Review is complete"], dependsOn: ["prepare"], depth: 4,
      taskId: "gate-child-1", verificationDisposition: "specialized" },
    { key: SCHEDULED_AUDIT_TEMPLATE_ID, templateId: SCHEDULED_AUDIT_TEMPLATE_ID, goal: SCHEDULED_AUDIT_NODE_GOAL,
      successCriteria: SCHEDULED_AUDIT_NODE_CRITERIA, dependsOn: ["gate"], depth: 5,
      taskId: "audit-child-1", verificationDisposition: "specialized" },
  ] }
}
function auditGraphItem(stepId: string, revision = 7, content = auditGraphContent()) {
  return { id: taskGraphItemId(owner.rootTaskId), sessionId: owner.sessionId, turnId: owner.turnId, stepId,
    taskId: owner.rootTaskId, type: TASK_GRAPH_ITEM_TYPE, status: "streaming", phase: null, revision, content }
}
function auditGraphProposal(stepId: string, revision = 6, content = auditGraphContent(), eventId = `${stepId}-proposal`) {
  const id = taskGraphItemId(owner.rootTaskId), now = "2026-10-25T12:10:00.000Z"
  const item = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id, sessionId: owner.sessionId, turnId: owner.turnId,
    stepId, taskId: owner.rootTaskId, type: TASK_GRAPH_ITEM_TYPE, status: "streaming", phase: null, revision,
    content, startedAt: now, completedAt: null, createdAt: now, updatedAt: now }
  const payload = { kind: "proposal", fingerprint: "f".repeat(64), revision,
    receipt: { status: "accepted", revision, nodes: [{ key: SCHEDULED_AUDIT_TEMPLATE_ID,
      taskId: "audit-child-1", status: "queued" }], readyTaskIds: ["audit-child-1"] }, item, content }
  return { id: eventId, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.rootTaskId, itemId: id,
    type: "item.delta", actor: "orchestrator", correlationId: owner.turnId, causationId: stepId,
    idempotencyKey: taskGraphProposalKey(owner.rootTaskId, revision - 1), payload }
}
function gateQuestion(stepId: string) {
  const binding = { schemaVersion: TURN_SCHEDULED_GATE_CHOICE_SCHEMA, owner: { userId: owner.userId,
    sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId, rootAttemptCount: 2,
    executionId: "execution-1", executionAttemptCount: 0 }, continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`,
    snapshotDigest: `sha256:${"b".repeat(64)}`, evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64),
    analyzeGraphRevision: 9, graphRevision: 10, gateTaskId: "gate-child-1", gateAttempt: 1, kind: "weak_cover_letter",
    jobIds: ["job-1"], allowedChoiceIds: ["continue", "review", "skip"] as const }
  const waitId = turnScheduledGateChoiceWaitId(binding)!
  return { id: `agent-wait:question:${waitId}`, stepId, taskId: owner.rootTaskId, type: "question", status: "started",
    content: createTurnScheduledGateChoiceContent(waitId, binding, "A prepared application has a weak cover letter.")! }
}

function fixture(options: FixtureOptions = {}) {
  const steps = options.steps ?? [], events = options.events ?? [], items = options.items ?? [], waits = options.waits ?? [], tasks = options.tasks ?? []
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes('FROM "agent_steps"')) return { rows: steps }
    if (sql.includes('FROM "agent_events"')) return { rows: events }
    if (sql.includes('FROM "agent_items"')) return { rows: items }
    if (sql.includes('FROM "agent_wait_conditions"')) return { rows: waits }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: tasks.filter(row => row.id === values?.[0]) }
    throw new Error(`unexpected recovery evidence query: ${sql}`)
  })
  return { query, client: { query } as never, steps, events, items, waits, tasks }
}

function validAuditAndBlockerFixture() {
  const first = makeStep("recovery-step-1", 5, "11", "waiting_for_tool", null)
  const second = makeStep("recovery-step-2", 8, "12", "waiting_for_tool", "scheduled_audit_completion_unverified", 2)
  return fixture({ steps: [first, second], events: [
    ...lifecycleEvents(first, { status: "waiting_for_dependency", waitId: "audit-wait-1" }),
    ...lifecycleEvents(second, { status: "waiting_for_dependency", errorCode: "scheduled_audit_completion_unverified" }),
  ], waits: [gateWait(first.id), auditWait(first.id)], tasks: [gateTask(), auditTask(2)] })
}

describe("scheduled pipeline recovery evidence reader", () => {
  it("selects the Audit wait by its completion receipt after a Gate-ready wait on the same Step", async () => {
    const f = validAuditAndBlockerFixture()
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: "recovery-step-2", recoveryCursor: 2, predecessorStepId: "recovery-step-1" },
      ordinal: 8, status: "waiting_for_tool", errorCode: "scheduled_audit_completion_unverified",
    })
    expect(f.query.mock.calls.slice(0, 4).map(([sql]) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining('FROM "agent_steps"'), expect.stringContaining('FROM "agent_events"'),
      expect.stringContaining('FROM "agent_items"'), expect.stringContaining('FROM "agent_wait_conditions"'),
    ]))
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('FROM "sub_agent_tasks"'),
      ["audit-child-1", owner.sessionId, owner.turnId, owner.rootTaskId, owner.userId])
    expect(f.query).toHaveBeenCalledWith(expect.stringContaining('FROM "sub_agent_tasks"'),
      ["gate-child-1", owner.sessionId, owner.turnId, owner.rootTaskId, owner.userId])
    const completed = f.events.filter(event => event.type === "step.completed" && event.correlationId === "recovery-step-1")
    expect(completed).toHaveLength(1)
    expect(completed[0]?.payload).toMatchObject({ waitId: "audit-wait-1" })
    expect(f.waits.map(wait => wait.id)).toEqual(["gate-ready-1", "audit-wait-1"])
    expect(f.waits[1]?.idempotencyKey).toBe(scheduledAuditWaitKey("audit-child-1", "recovery-step-1", 1))

    const reversed = fixture({ steps: f.steps, events: f.events, items: f.items, waits: [...f.waits].reverse(), tasks: f.tasks })
    await expect(readScheduledPipelineRecoveryEvidence(reversed.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: "recovery-step-2", predecessorStepId: "recovery-step-1" },
      status: "waiting_for_tool", errorCode: "scheduled_audit_completion_unverified",
    })
  })

  it("recovers a marker-backed streaming Step created before its start event was appended", async () => {
    const streaming = makeStep("recovery-step-1", 5, "11", "streaming", null)
    const f = fixture({ steps: [streaming] })
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: streaming.id, recoveryCursor: 1, sourceEventId: source.sourceEventId },
      ordinal: 5, status: "streaming", errorCode: null,
    })
  })

  it.each(["streaming", "completed"] as const)("rejects a %s recovery Step with an explicit final.rejected replan receipt", async status => {
    const rejected = makeStep("recovery-step-1", 5, "11", status, null)
    const completion = status === "completed" ? { status: "completed" } : null
    const f = fixture({ steps: [rejected], events: [...lifecycleEvents(rejected, completion), finalRejectedEvent(rejected)] })
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toBe(false)
  })

  it("keeps a successfully completed recovery Step recoverable when no final rejection was recorded", async () => {
    const completed = makeStep("recovery-step-1", 5, "11", "completed", null)
    const f = fixture({ steps: [completed], events: lifecycleEvents(completed, { status: "completed" }) })
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: completed.id }, ordinal: completed.ordinal, status: "completed", errorCode: null,
    })
  })

  it("rejects a wait when the closed Step names another wait or the wait belongs to another user", async () => {
    const valid = validAuditAndBlockerFixture()
    const mismatchedEvents = valid.events.map(event => event.type === "step.completed" && event.correlationId === "recovery-step-1"
      ? { ...event, payload: { ...(event.payload as Record<string, unknown>), waitId: "different-wait" } } : event)
    const mismatch = fixture({ steps: valid.steps, events: mismatchedEvents, waits: valid.waits, tasks: valid.tasks })
    await expect(readScheduledPipelineRecoveryEvidence(mismatch.client, owner, source)).resolves.toBe(false)

    const foreignWait = fixture({ steps: valid.steps, events: valid.events,
      waits: [{ ...valid.waits[0]!, userId: "foreign-user" }], tasks: valid.tasks })
    await expect(readScheduledPipelineRecoveryEvidence(foreignWait.client, owner, source)).resolves.toBe(false)
  })

  it("accepts an exact scheduled blocker receipt when no new wait was created", async () => {
    const blocked = makeStep("recovery-step-1", 5, "11", "waiting_for_tool", "scheduled_audit_completion_unverified")
    const f = fixture({ steps: [blocked], events: lifecycleEvents(blocked,
      { status: "waiting_for_dependency", errorCode: "scheduled_audit_completion_unverified" }) })
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: blocked.id }, status: "waiting_for_tool", errorCode: "scheduled_audit_completion_unverified",
    })
    expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM "agent_wait_conditions"'))).toBe(true)
    expect(f.query.mock.calls.some(([sql]) => sql.includes('FROM "sub_agent_tasks"'))).toBe(false)
  })

  it("ignores a server question event correlated to its question item, outside the recovery Step", async () => {
    const f = validAuditAndBlockerFixture()
    const questionItemId = "agent-wait:question:prior-prepare-choice"
    const questionEvent = { id: "prior-prepare-choice-started", taskId: owner.rootTaskId, itemId: questionItemId,
      type: "item.started", actor: "orchestrator", correlationId: questionItemId,
      idempotencyKey: `agent-wait:${questionItemId}:started`,
      payload: { itemId: questionItemId, waitKind: "question", questionId: "prior-prepare-choice", toolCallId: null } }
    const withQuestion = fixture({ steps: f.steps, events: [...f.events, questionEvent], items: f.items, waits: f.waits, tasks: f.tasks })
    await expect(readScheduledPipelineRecoveryEvidence(withQuestion.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: "recovery-step-2" }, status: "waiting_for_tool",
    })
  })

  it("accepts a streaming recovery Step after stripping its exact graph item", async () => {
    const step = makeStep("recovery-step-1", 5, "11", "streaming", null), content = auditGraphContent()
    const f = fixture({ steps: [step], events: [...lifecycleEvents(step, null), auditGraphProposal(step.id, 6, content)],
      items: [auditGraphItem(step.id, 7, content)] })
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: step.id }, status: "streaming",
    })
  })

  it("accepts production scheduled Scout and Analyst keys in recovery evidence", async () => {
    const step = makeStep("recovery-step-1", 5, "11", "streaming", null)
    const content = auditGraphContent("scheduled-scout", "scheduled-analyst")
    const f = fixture({ steps: [step], events: [...lifecycleEvents(step, null), auditGraphProposal(step.id, 6, content)],
      items: [auditGraphItem(step.id, 7, content)] })
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: step.id }, status: "streaming",
    })
  })

  it("keeps a moved singleton on R2 only when R2 has its own proposal receipt", async () => {
    const base = validAuditAndBlockerFixture(), r1 = "recovery-step-1", r2 = "recovery-step-2", content = auditGraphContent()
    const events = [...base.events, auditGraphProposal(r1, 6, content), auditGraphProposal(r2, 7, content)]
    const moved = fixture({ steps: base.steps, events, items: [auditGraphItem(r2, 8, content)], waits: base.waits, tasks: base.tasks })
    await expect(readScheduledPipelineRecoveryEvidence(moved.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: r2, recoveryCursor: 2, predecessorStepId: r1 },
      status: "waiting_for_tool", errorCode: "scheduled_audit_completion_unverified",
    })

    const missingR2Receipt = fixture({ steps: base.steps,
      events: [...base.events, auditGraphProposal(r1, 6, content)], items: [auditGraphItem(r2, 8, content)],
      waits: base.waits, tasks: base.tasks })
    await expect(readScheduledPipelineRecoveryEvidence(missingR2Receipt.client, owner, source)).resolves.toBe(false)
  })

  it("strips only the exact graph item while preserving the scheduled Gate question", async () => {
    const step = makeStep("recovery-step-1", 5, "11", "waiting_for_user", null), content = auditGraphContent()
    const question = gateQuestion(step.id)
    const f = fixture({ steps: [step], events: [...lifecycleEvents(step, { status: "waiting_for_user" }),
      auditGraphProposal(step.id, 6, content)], items: [auditGraphItem(step.id, 7, content), question], tasks: [gateTask()] })
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toMatchObject({
      marker: { recoveryStepId: step.id }, status: "waiting_for_user",
    })
  })

  it("still rejects an unrelated item beside the verified graph item", async () => {
    const step = makeStep("recovery-step-1", 5, "11", "streaming", null), content = auditGraphContent()
    const f = fixture({ steps: [step], events: [...lifecycleEvents(step, null), auditGraphProposal(step.id, 6, content)],
      items: [auditGraphItem(step.id, 7, content), { id: "unrelated-tool", stepId: step.id, taskId: owner.rootTaskId,
        type: "tool_call", status: "completed", content: {} }] })
    await expect(readScheduledPipelineRecoveryEvidence(f.client, owner, source)).resolves.toBe(false)
  })

  it.each(["model", "tool"] as const)("invalidates recovery evidence after %s activity", async activity => {
    const f = validAuditAndBlockerFixture()
    const events = activity === "model" ? [...f.events, { id: "model-event", correlationId: "recovery-step-1", type: "model.started" }] : f.events
    const items = activity === "tool" ? [{ id: "tool-item", stepId: "recovery-step-1", taskId: owner.rootTaskId,
      type: "tool_call", status: "completed", content: {} }] : f.items
    const changed = fixture({ steps: f.steps, events, items, waits: f.waits, tasks: f.tasks })
    await expect(readScheduledPipelineRecoveryEvidence(changed.client, owner, source)).resolves.toBe(false)
  })
})
