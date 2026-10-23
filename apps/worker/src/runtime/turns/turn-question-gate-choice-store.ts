import { Buffer } from "node:buffer"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { TurnQuestionStoreError, type TurnQuestionWaitInput,
  type TurnQuestionWaitReceipt } from "./turn-question-contract.js"
import { createTurnScheduledGateChoiceContent, createTurnScheduledGateChoiceResumeAcknowledgement,
  parseTurnQuestionGateChoiceBinding, parseTurnScheduledGateChoiceItemState,
  turnScheduledGateChoiceWaitId, type TurnQuestionGateChoiceAnswer, type TurnQuestionGateChoiceBinding,
  type TurnQuestionGateChoiceRecovery,
  type TurnQuestionGateChoiceResumeAcknowledgement } from "./turn-question-gate-choice-contract.js"
import { appendScheduledGateChoiceWaitEvents } from "./turn-question-gate-choice-events.js"
import { admitQuestionWork, lockQuestionStep, questionConflict, questionItemId, withQuestionTransaction,
  type TurnQuestionPool, type TurnQuestionQueryClient } from "./turn-question-store-guards.js"
import { scheduledSnapshotMatches } from "../subagents/scheduled-taskgraph-continuation-receipt.js"
import { loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import { taskGraphLifecycleKey } from "../subagents/task-graph-snapshot.js"
import { parseScheduledGateTaskEnvelope, SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE,
  scheduledGateCheckpointEvidence, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from "../subagents/scheduled-gate-contract.js"

type Row = Record<string, unknown>
type GateQuestion = Readonly<{ kind: TurnQuestionGateChoiceBinding["kind"]; jobIds: readonly string[]; candidateSetDigest: string }>
type GateTask = Readonly<{ status: string; attempt: number }>

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Row : null
}
function exact(value: Row, keys: readonly string[]): boolean { return Object.keys(value).sort().join(",") === [...keys].sort().join(",") }
function same(left: unknown, right: unknown): boolean { try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false } }
function questionResult(value: unknown, binding: TurnQuestionGateChoiceBinding): GateQuestion | null {
  const envelope = parseScheduledGateTaskEnvelope(value, "waiting_for_user", binding.jobIds)
  const question = envelope?.structuredResult
  if (!question || question.status !== "question_required" || question.kind !== binding.kind
    || !same([...question.jobIds].sort(), binding.jobIds) || !same(question.allowedChoiceIds, binding.allowedChoiceIds)) return null
  return { kind: question.kind, jobIds: [...question.jobIds].sort(), candidateSetDigest: question.candidateSetDigest }
}

function fixedGateTask(row: Row): boolean {
  const schema = record(row.expectedOutputSchema)
  return row.role === SCHEDULED_GATE_ROLE && row.taskType === SCHEDULED_GATE_TASK_TYPE
    && !!schema && exact(schema, Object.keys(SCHEDULED_GATE_OUTPUT_SCHEMA))
    && schema.schemaVersion === SCHEDULED_GATE_OUTPUT_SCHEMA.schemaVersion
    && schema.role === SCHEDULED_GATE_OUTPUT_SCHEMA.role && schema.taskType === SCHEDULED_GATE_OUTPUT_SCHEMA.taskType
    && Array.isArray(row.allowedActions) && row.allowedActions.length === 0
}

async function loadGateTask(client: TurnQuestionQueryClient, owner: TurnExecutionOwnerFence, binding: TurnQuestionGateChoiceBinding): Promise<GateTask> {
  const result = await client.query<Row>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId", task."role", task."taskType",
      task."status", task."attemptCount", task."result", task."expectedOutputSchema", task."allowedActions",
      root."attemptCount" AS "rootAttemptCount", turn."rootTaskId" AS "turnRootTaskId",
      turn."source", turn."executionMode", turn."input", session."userId", execution."id" AS "executionId",
      execution."attemptCount" AS "executionAttemptCount", execution."status" AS "executionStatus", execution."state"
    FROM "sub_agent_tasks" AS task
    JOIN "sub_agent_tasks" AS root ON root."id" = task."rootTaskId" AND root."sessionId" = task."sessionId" AND root."turnId" = task."turnId"
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    JOIN "agent_executions" AS execution ON execution."id" = $6 AND execution."sessionId" = turn."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND session."userId" = $5
      AND execution."userId" = $5 FOR SHARE OF task, root, execution`,
  [binding.gateTaskId, owner.sessionId, owner.turnId, owner.rootTaskId, owner.userId, binding.owner.executionId])
  const row = result.rows[0], evidence = scheduledGateCheckpointEvidence(row?.state)
  if (result.rows.length !== 1 || !row || row.id !== binding.gateTaskId || row.sessionId !== owner.sessionId || row.turnId !== owner.turnId
    || row.rootTaskId !== owner.rootTaskId || row.turnRootTaskId !== owner.rootTaskId || row.userId !== owner.userId
    || Number(row.rootAttemptCount) !== binding.owner.rootAttemptCount || row.executionId !== binding.owner.executionId
    || Number(row.executionAttemptCount) !== binding.owner.executionAttemptCount || !["running", "waiting_for_user"].includes(String(row.executionStatus))
    || row.source !== "automation" || row.executionMode !== "canonical_task_graph"
    || !scheduledSnapshotMatches({ source: row.source, executionMode: row.executionMode, input: row.input }, binding.snapshotDigest)
    || !evidence || evidence.owner.userId !== binding.owner.userId || evidence.owner.sessionId !== binding.owner.sessionId
    || evidence.owner.turnId !== binding.owner.turnId || evidence.owner.rootTaskId !== binding.owner.rootTaskId
    || evidence.owner.rootAttemptCount !== binding.owner.rootAttemptCount || evidence.owner.executionId !== binding.owner.executionId
    || evidence.owner.executionAttemptCount !== binding.owner.executionAttemptCount || evidence.continuationKey !== binding.continuationKey
    || evidence.snapshotDigest !== binding.snapshotDigest || evidence.evidenceDigest !== binding.evidenceDigest
    || evidence.checkpointDigest !== binding.checkpointDigest || evidence.analyzeGraphRevision !== binding.analyzeGraphRevision) {
    throw questionConflict("scheduled Gate owner/checkpoint binding")
  }
  if (!fixedGateTask(row) || row.parentTaskId !== owner.rootTaskId) throw questionConflict("scheduled Gate task result/template")
  const scope: GraphIdentityScope = { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.rootTaskId, parentTaskId: owner.rootTaskId }
  let graph
  try { graph = await loadTaskGraph(client, scope, false) } catch { throw questionConflict("scheduled Gate TaskGraph readback") }
  const gateNode = graph.snapshot?.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  const prepareNode = graph.snapshot?.nodes.find(node => node.key === "prepare")
  const gateState = graph.state?.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  const prepareState = graph.state?.nodes.find(node => node.key === "prepare")
  const gateGraphTask = gateNode && graph.tasks.get(gateNode.taskId)
  const prepareGraphTask = prepareNode && graph.tasks.get(prepareNode.taskId)
  if (!graph.item || !graph.snapshot || !graph.state || !gateNode || gateNode.taskId !== binding.gateTaskId
    || gateNode.templateId !== SCHEDULED_GATE_TEMPLATE_ID || gateNode.verificationDisposition !== "specialized"
    || gateNode.depth !== 4 || gateNode.dependsOn.length !== 1 || gateNode.dependsOn[0] !== "prepare"
    || !prepareNode || prepareNode.templateId !== "prepare" || prepareNode.depth !== gateNode.depth - 1
    || !gateGraphTask || gateGraphTask.id !== binding.gateTaskId || gateGraphTask.status !== row.status
    || !fixedGateTask({ role: gateGraphTask.role, taskType: gateGraphTask.taskType,
      expectedOutputSchema: gateGraphTask.expectedOutputSchema, allowedActions: gateGraphTask.allowedActions })
    || !gateState || gateState.taskId !== binding.gateTaskId || gateState.status !== row.status
    || !prepareGraphTask || prepareGraphTask.id !== prepareNode.taskId || prepareGraphTask.role !== "prepare"
    || prepareGraphTask.taskType !== "scheduled_application_prepare" || prepareGraphTask.status !== "completed"
    || !prepareState || prepareState.taskId !== prepareNode.taskId || prepareState.status !== "completed") {
    throw questionConflict("scheduled Gate TaskGraph admission")
  }
  const startKey = taskGraphLifecycleKey(owner.rootTaskId, SCHEDULED_GATE_TEMPLATE_ID, binding.gateAttempt, "task.started")
  const startEvents = graph.state.appliedEvents.filter(event => event.nodeKey === SCHEDULED_GATE_TEMPLATE_ID
    && event.type === "task.started" && event.idempotencyKey === startKey)
  const startRevision = startEvents.length === 1 ? startEvents[0].expectedRevision + 1 : null
  if (startRevision !== binding.graphRevision) throw questionConflict("scheduled Gate start revision binding")
  const status = String(row.status), attempt = Number(row.attemptCount)
  if (status === "waiting_for_user" && attempt === binding.gateAttempt) {
    if (!questionResult(row.result, binding)) throw questionConflict("scheduled Gate task result/template")
  } else if (!((status === "queued" && attempt === binding.gateAttempt) || (status === "running" && attempt === binding.gateAttempt + 1))
    || row.result !== null && row.result !== undefined) {
    throw questionConflict("scheduled Gate task result/template")
  }
  return { status, attempt }
}

function itemRead(row: Row | undefined, binding: TurnQuestionGateChoiceBinding, itemId: string, stepId: string, taskId: string): {
  status: "waiting" | "answered"; choice: TurnQuestionGateChoiceAnswer | null
  acknowledgement: TurnQuestionGateChoiceResumeAcknowledgement | null; question: string
} | null {
  if (!row) return null
  const state = parseTurnScheduledGateChoiceItemState(row.content, row.status, binding)
  if (row.id !== itemId || row.stepId !== stepId || row.taskId !== taskId || row.type !== "question" || state === undefined) throw questionConflict("scheduled Gate question " + itemId)
  const content = record(row.content)
  if (!content || typeof content.question !== "string") throw questionConflict("scheduled Gate question " + itemId + " content")
  if (state.answer === null && row.status === "started") return { status: "waiting", choice: null, acknowledgement: null, question: content.question }
  if (state.answer !== null && row.status === "completed") return { status: "answered", choice: state.answer, acknowledgement: state.resumeAcknowledgement, question: content.question }
  throw questionConflict("scheduled Gate question " + itemId + " state")
}

function validGateAttemptState(gate: GateTask, item: NonNullable<ReturnType<typeof itemRead>>, binding: TurnQuestionGateChoiceBinding): boolean {
  if (item.acknowledgement === null) return gate.status === "waiting_for_user" && gate.attempt === binding.gateAttempt
  const ack = item.acknowledgement
  return ack.gateTaskId === binding.gateTaskId && ack.requestAttemptCount === binding.gateAttempt
    && ack.resumedAttemptCount === binding.gateAttempt + 1
    && ((gate.status === "queued" && gate.attempt === binding.gateAttempt)
      || (gate.status === "running" && gate.attempt === binding.gateAttempt + 1))
}
function itemSelect(): string {
  return `SELECT "id", "stepId", "taskId", "type", "status", "content" FROM "agent_items"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`
}

export async function waitForScheduledGateChoice(pool: TurnQuestionPool, input: TurnQuestionWaitInput): Promise<TurnQuestionWaitReceipt> {
  const gateQuestion = input.gateChoiceQuestion, finishReason = input.finishReason, usage = input.usage
  if (input.toolCallId !== null || !input.gateChoiceBinding || !gateQuestion?.trim()
    || !input.expectedWaitId?.trim() || !input.stepId.trim() || !input.finishReason?.trim()
    || !finishReason || finishReason.length > 128 || !usage || !Number.isFinite(input.now.getTime())) {
    throw new TurnQuestionStoreError("question_not_current", "Scheduled Gate question scope is invalid")
  }
  const binding = parseTurnQuestionGateChoiceBinding(input.gateChoiceBinding), waitId = turnScheduledGateChoiceWaitId(binding)
  if (!binding || !waitId || waitId !== input.expectedWaitId || !questionText(gateQuestion)) throw questionConflict("scheduled Gate wait identity")
  return withQuestionTransaction(pool, input.owner, async (client, turn) => {
    const gate = await loadGateTask(client, input.owner, binding), itemId = questionItemId(waitId)
    const found = await client.query<Row>(itemSelect(), [itemId, input.owner.sessionId, input.owner.turnId])
    const item = itemRead(found.rows[0], binding, itemId, input.stepId, input.owner.taskId)
    if (found.rows.length > 1) throw questionConflict(`scheduled Gate question ${itemId}`)
    if (item) {
      if (item.question !== input.gateChoiceQuestion) throw questionConflict(`scheduled Gate question ${waitId} prompt identity`)
      if (item.status === "waiting") {
        const step = await lockQuestionStep(client, input.owner, input.stepId)
        if (turn.status !== "waiting_for_user" || step.status !== "waiting_for_user"
          || !validGateAttemptState(gate, item, binding)) throw questionConflict(`scheduled Gate waiting state ${waitId}`)
        return receipt("waiting_for_user", "replayed", input, waitId, Number(turn.revision))
      }
      if (turn.status !== "in_progress" || !validGateAttemptState(gate, item, binding)) throw questionConflict(`scheduled Gate answered state ${waitId}`)
      return receipt("answered", "replayed", input, waitId, Number(turn.revision))
    }
    if (turn.status !== "in_progress" || gate.status !== "waiting_for_user" || gate.attempt !== binding.gateAttempt) throw questionConflict(`scheduled Gate admission ${waitId}`)
    const step = await lockQuestionStep(client, input.owner, input.stepId)
    if (step.status !== "streaming" || step.finishReason !== null && (step.finishReason !== finishReason
      || Number(step.inputTokens) !== usage.inputTokens || Number(step.outputTokens) !== usage.outputTokens
      || Number(step.estimatedCostUsd) !== usage.estimatedCostUsd)) throw questionConflict(`scheduled Gate root step ${input.stepId}`)
    await admitQuestionWork(client, input.owner)
    const content = createTurnScheduledGateChoiceContent(waitId, binding, gateQuestion)
    if (!content) throw questionConflict("scheduled Gate question content")
    await client.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'question', 'started', 'commentary', $6::jsonb, $7, $7)`,
    [itemId, input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, JSON.stringify(content), input.now])
    const closed = await client.query(`UPDATE "agent_steps" SET "status" = 'waiting_for_user', "finishReason" = $1, "errorCode" = NULL,
      "inputTokens" = $2, "outputTokens" = $3, "estimatedCostUsd" = $4, "completedAt" = $5 WHERE "id" = $6 AND "sessionId" = $7
        AND "turnId" = $8 AND "taskId" = $9 AND "attempt" = 1 AND "status" = 'streaming'`,
    [finishReason, usage.inputTokens, usage.outputTokens, usage.estimatedCostUsd, input.now, input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
    if (closed.rowCount !== 1) throw questionConflict(`scheduled Gate root step ${input.stepId} close`)
    const updated = await client.query<{ revision: number | string }>(`UPDATE "agent_turns" SET "status" = 'waiting_for_user', "revision" = "revision" + 1,
      "completedAt" = NULL, "updatedAt" = $1 WHERE "id" = $2 AND "sessionId" = $3 AND "userId" = $4 AND "leaseOwnerId" = $5
        AND "leaseVersion" = $6 AND "leaseExpiresAt" > CURRENT_TIMESTAMP AND "status" = 'in_progress' RETURNING "revision"`,
    [input.now, input.owner.turnId, input.owner.sessionId, input.owner.userId, input.owner.ownerId, input.owner.leaseVersion])
    if (updated.rowCount !== 1 || !updated.rows[0]) throw questionConflict(`scheduled Gate Turn ${input.owner.turnId}`)
    await appendScheduledGateChoiceWaitEvents(client, { owner: input.owner, stepId: input.stepId, itemId, waitId })
    return receipt("waiting_for_user", "created", input, waitId, Number(updated.rows[0].revision))
  })
}

export async function readScheduledGateChoice(pool: TurnQuestionPool, input: Readonly<{
  owner: TurnExecutionOwnerFence; binding: unknown; now: Date
}>): Promise<TurnQuestionGateChoiceRecovery> {
  const binding = parseTurnQuestionGateChoiceBinding(input.binding), waitId = turnScheduledGateChoiceWaitId(binding)
  if (!binding || !waitId || !Number.isFinite(input.now.getTime())) throw new TurnQuestionStoreError("question_not_current", "Scheduled Gate recovery scope is invalid")
  return withQuestionTransaction(pool, input.owner, async (client, turn) => {
    const gate = await loadGateTask(client, input.owner, binding), itemId = questionItemId(waitId)
    const found = await client.query<Row>(itemSelect(), [itemId, input.owner.sessionId, input.owner.turnId])
    if (!found.rows.length) {
      if (gate.status !== "waiting_for_user" || gate.attempt !== binding.gateAttempt || turn.status !== "in_progress") throw questionConflict(`scheduled Gate question ${waitId} missing`)
      return { status: "none" }
    }
    if (found.rows.length !== 1) throw questionConflict(`scheduled Gate question ${waitId}`)
    const item = itemRead(found.rows[0], binding, itemId, String(found.rows[0]?.stepId), input.owner.taskId)!
    const step = await lockQuestionStep(client, input.owner, String(found.rows[0]?.stepId))
    if (item.status === "waiting") {
      if (turn.status !== "waiting_for_user" || step.status !== "waiting_for_user" || gate.status !== "waiting_for_user" || gate.attempt !== binding.gateAttempt) throw questionConflict(`scheduled Gate waiting state ${waitId}`)
      return { status: "waiting", waitId, itemId, binding }
    }
    if (turn.status !== "in_progress" || step.status !== "waiting_for_user" || !validGateAttemptState(gate, item, binding)) throw questionConflict(`scheduled Gate answered state ${waitId}`)
    const choiceId = item.choice as string
    return { status: "answered", waitId, itemId, binding,
      validatedChoice: { kind: binding.kind, jobIds: binding.jobIds, choiceId: choiceId as TurnQuestionGateChoiceAnswer } }
  })
}

/** Adds the one-shot Gate requeue receipt inside the caller's existing transaction. */
export async function acknowledgeScheduledGateChoiceResume(client: TurnQuestionQueryClient, input: Readonly<{
  owner: TurnExecutionOwnerFence; binding: unknown; gateTaskId: string; requestAttemptCount: number
  waitId: string; itemId: string; resumedAttemptCount: number; now: Date
}>): Promise<Readonly<{ kind: TurnQuestionGateChoiceBinding["kind"]; jobIds: readonly string[]; choiceId: TurnQuestionGateChoiceAnswer }>> {
  const binding = parseTurnQuestionGateChoiceBinding(input.binding), waitId = turnScheduledGateChoiceWaitId(binding)
  const expectedAck = createTurnScheduledGateChoiceResumeAcknowledgement({ binding, gateTaskId: input.gateTaskId,
    requestAttemptCount: input.requestAttemptCount, waitId: input.waitId, itemId: input.itemId,
    resumedAttemptCount: input.resumedAttemptCount })
  if (!binding || !waitId || !expectedAck || !Number.isFinite(input.now.getTime())
    || input.owner.userId !== binding.owner.userId || input.owner.sessionId !== binding.owner.sessionId
    || input.owner.turnId !== binding.owner.turnId || input.owner.rootTaskId !== binding.owner.rootTaskId) {
    throw new TurnQuestionStoreError("question_not_current", "Scheduled Gate resume acknowledgement scope is invalid")
  }
  const gate = await loadGateTask(client, input.owner, binding)
  const found = await client.query<Row>(itemSelect(), [input.itemId, input.owner.sessionId, input.owner.turnId])
  if (found.rows.length !== 1) throw questionConflict(`scheduled Gate answer ${input.itemId}`)
  const stepId = String(found.rows[0]?.stepId), item = itemRead(found.rows[0], binding, input.itemId, stepId, input.owner.taskId)
  const step = await lockQuestionStep(client, input.owner, stepId)
  if (!item || item.status !== "answered" || step.status !== "waiting_for_user" || !item.choice
    || !validGateAttemptState(gate, item, binding)) throw questionConflict(`scheduled Gate answer ${input.itemId} state`)
  if (item.acknowledgement) {
    if (!same(item.acknowledgement, expectedAck)) throw questionConflict(`scheduled Gate answer ${input.itemId} acknowledgement`)
    return { kind: binding.kind, jobIds: binding.jobIds, choiceId: item.choice }
  }
  if (gate.status !== "waiting_for_user" || gate.attempt !== binding.gateAttempt || item.acknowledgement !== null) {
    throw questionConflict(`scheduled Gate answer ${input.itemId} requeue state`)
  }
  const content = record(found.rows[0]?.content)
  if (!content) throw questionConflict(`scheduled Gate answer ${input.itemId} content`)
  const updated = await client.query<Row>(`UPDATE "agent_items" SET "content" = $1::jsonb, "updatedAt" = $2
    WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5 AND "taskId" = $6 AND "type" = 'question' AND "status" = 'completed'
    RETURNING "content"`, [JSON.stringify({ ...content, scheduledGateChoiceResumeAcknowledgement: expectedAck }), input.now,
    input.itemId, input.owner.sessionId, input.owner.turnId, input.owner.taskId])
  if (updated.rowCount !== 1 || updated.rows.length !== 1
    || parseTurnScheduledGateChoiceItemState(updated.rows[0]?.content, "completed", binding)?.resumeAcknowledgement === undefined
    || !same(parseTurnScheduledGateChoiceItemState(updated.rows[0]?.content, "completed", binding)?.resumeAcknowledgement, expectedAck)) {
    throw questionConflict(`scheduled Gate answer ${input.itemId} acknowledgement write`)
  }
  return { kind: binding.kind, jobIds: binding.jobIds, choiceId: item.choice }
}

function receipt(status: TurnQuestionWaitReceipt["status"], disposition: TurnQuestionWaitReceipt["disposition"], input: TurnQuestionWaitInput,
  waitId: string, revision: number): TurnQuestionWaitReceipt {
  return { status, disposition, waitId, itemId: questionItemId(waitId), turnId: input.owner.turnId, toolCallId: null, nextTurnRevision: revision }
}
function questionText(value: string): boolean { return value === value.trim() && Buffer.byteLength(value, "utf8") <= 2_000 }
