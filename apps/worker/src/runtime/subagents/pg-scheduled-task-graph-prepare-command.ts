import { BudgetExceededError } from "../budget.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { enforceRootStepBudget } from "../turns/turn-engine-root-budget.js"
import { loadScheduledChoiceBinding } from "../turns/turn-question-store-events.js"
import { parseTurnScheduledPrepareChoiceItem } from "../turns/turn-question-contract.js"
import { questionItemId } from "../turns/turn-question-store-guards.js"
import { appendTaskGraphReceipt, writePlanReceipt } from "./task-graph-pg-events.js"
import { createGraphTasks, enqueueGraphTask } from "./task-graph-pg-create.js"
import { currentTaskGraph, loadTaskGraph, lockTaskGraphScope } from "./task-graph-pg-state.js"
import { parseTaskGraphSnapshot, taskGraphProposalKey } from "./task-graph-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import type { Queryable } from "./pg-store-persistence.js"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { TaskGraphCommandError, parseScheduledPrepareProposal, type TaskGraphScheduleInput, type TaskGraphScheduledPrepareReceipt, type TaskGraphScheduledPrepareInput } from "./task-graph-command-port.js"
import type { SubagentTaskRecord } from "./types.js"
import { createScheduledTaskGraphContinuationContract, readScheduledPrepareReceipt, scheduledAnalyzeGraphMatches,
  scheduledPrepareReplayReceipt, scheduledSnapshotMatches, scheduledTaskGraphClaimMatches,
  scheduledTaskGraphContinuationReceiptMatches, SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT } from "./scheduled-taskgraph-continuation-receipt.js"

/** Atomically appends one registered Prepare child and its private continuation receipt. */
export async function appendScheduledPrepare(client: Queryable, input: TaskGraphScheduledPrepareInput): Promise<TaskGraphScheduledPrepareReceipt> {
  const contract = createScheduledTaskGraphContinuationContract(input)
  if (!contract) throw new TaskGraphCommandError("scheduled_prepare_binding_invalid", "Scheduled Prepare proof is invalid")
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [input.scope.userId])
  const parent = await lockScheduledPrepareScope(client, input, contract.receipt), owner = contract.binding.owner
  const execution = await client.query(`SELECT "id", "userId", "sessionId", "status", "attemptCount", "state", clock_timestamp() AS "now"
    FROM "agent_executions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 FOR UPDATE`, [owner.executionId, input.scope.userId, input.scope.sessionId])
  const row = execution.rows[0] as Record<string, unknown> | undefined
  if (!row || row.status !== "running" || Number(row.attemptCount) !== owner.executionAttemptCount
    || !scheduledTaskGraphClaimMatches(row.state, contract.binding, contract.claimTokenDigest, row.now)) throw new TaskGraphCommandError(
    "scheduled_prepare_claim_stale", "Scheduled Prepare claim is stale")
  const turn = await client.query(`SELECT "source", "executionMode", "input", "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3`, [input.scope.turnId, input.scope.sessionId, input.scope.userId])
  const turnRow = turn.rows[0] as Record<string, unknown> | undefined
  if (!turnRow || !scheduledSnapshotMatches(turnRow, contract.binding.snapshotDigest)) throw new TaskGraphCommandError(
    "scheduled_prepare_snapshot_mismatch", "Scheduled Prepare snapshot is stale")
  const turnInput = turnRow.input && typeof turnRow.input === "object" && !Array.isArray(turnRow.input)
    ? turnRow.input as Record<string, unknown> : undefined
  const scheduleSnapshot = parseScheduledAutomationSnapshot(turnInput?.scheduledAutomationSnapshot)
  if (!scheduleSnapshot) throw new TaskGraphCommandError("scheduled_prepare_snapshot_mismatch", "Scheduled Prepare snapshot is malformed")
  const loaded = await loadTaskGraph(client, input.scope, true)
  if (!loaded.item || !loaded.state || !loaded.snapshot) throw new TaskGraphCommandError("scheduled_prepare_graph_missing", "Scheduled Analyze graph is unavailable")
  const current = currentTaskGraph(loaded), key = `scheduled-prepare:${contract.proposalFingerprint}`, prior = await readScheduledPrepareReceipt(client, input.scope, key)
  if (prior) {
    const replay = scheduledPrepareReplayReceipt(loaded.snapshot, current, contract.binding.prepareScheduleRevision)
    if (!scheduledTaskGraphContinuationReceiptMatches(prior, contract.receipt)
      || !scheduledAnalyzeGraphMatches(input, loaded.snapshot, current, loaded.tasks, true) || !replay) throw new TaskGraphCommandError(
      "scheduled_prepare_receipt_conflict", "Scheduled Prepare receipt is mismatched")
    if (!scheduleSnapshot.requireApproval) return { ...replay, choice: { required: false } }
    const inspectedChoice = await readScheduledChoice(client, input.scope, contract.receipt, turnRow), choice = inspectedChoice.choice
    if (choice.status !== "answered") throw new TaskGraphCommandError(
      "scheduled_prepare_receipt_conflict", "Prepare exists before its scheduled choice was answered")
    const prepare = replay.nodes.find(node => node.key === "prepare")
    if (!prepare) throw new TaskGraphCommandError("scheduled_prepare_receipt_conflict", "Scheduled Prepare task is missing")
    if (choice.status === "answered" && replay.readyTaskIds.includes(prepare.taskId)) {
      await enqueueReadyPrepareTask(client, input.scope.sessionId, input.scope.rootTaskId, prepare.taskId)
    }
    return { ...replay, choice: { required: true, status: "answered", waitId: choice.waitId } }
  }
  const analystKey = scheduledAnalyzeGraphMatches(input, loaded.snapshot, current, loaded.tasks, false)
  const proposal = analystKey && parseScheduledPrepareProposal(input.proposal, analystKey, contract.binding.analyzeGraphRevision)
  if (!analystKey || !proposal) throw new TaskGraphCommandError("scheduled_prepare_graph_mismatch", "Scheduled Analyze graph does not match its proof")
  const inspectedChoice = scheduleSnapshot.requireApproval
    ? await readScheduledChoice(client, input.scope, contract.receipt, turnRow) : undefined
  if (inspectedChoice?.choice.status === "waiting") return { status: "waiting_for_choice", revision: current.revision,
    nodes: [], readyTaskIds: [], choice: { required: true, status: "waiting", waitId: inspectedChoice.choice.waitId } }
  try {
    await enforceRootStepBudget(client, { kind: "turn", taskId: input.scope.rootTaskId, rootTaskId: input.scope.rootTaskId,
      userId: input.scope.userId, sessionId: input.scope.sessionId, turnId: input.scope.turnId }, 2)
  } catch (error) {
    if (error instanceof BudgetExceededError && error.metric === "steps") throw new TaskGraphCommandError(
      "task_graph_continuation_budget_required", "The Turn needs two remaining steps to supervise Prepare")
    throw error
  }
  const scheduleInput: TaskGraphScheduleInput = { scope: input.scope, proposal, templates: { prepare: TASK_GRAPH_TEMPLATES.prepare } }
  const created = await createGraphTasks(client, scheduleInput, parent, loaded.state,
    new Map(loaded.snapshot.nodes.map(node => [node.key, node.taskId])), loaded)
  if (created.state.revision !== contract.binding.prepareScheduleRevision || created.created.length !== 1 || created.created[0]?.key !== "prepare") throw new TaskGraphCommandError(
    "scheduled_prepare_schedule_mismatch", "Scheduled Prepare schedule is invalid")
  if (scheduleSnapshot.requireApproval) await suppressScheduledPrepareDispatch(client, input.scope.sessionId, created.created[0].taskId)
  const snapshot = loaded.snapshot.rootSuccessCriteria
    ? parseTaskGraphSnapshot({ ...created.snapshot, rootSuccessCriteria: loaded.snapshot.rootSuccessCriteria }) : created.snapshot
  const scheduleReceipt = { status: "accepted" as const, revision: created.state.revision, nodes: created.created, readyTaskIds: created.readyTaskIds }
  await writePlanReceipt(client, { scope: input.scope, state: created.state, snapshot,
    expectedRevision: contract.binding.analyzeGraphRevision, now: new Date(),
    idempotencyKey: taskGraphProposalKey(input.scope.parentTaskId, contract.binding.analyzeGraphRevision),
    fingerprint: contract.proposalFingerprint, receipt: scheduleReceipt })
  await appendTaskGraphReceipt(client, { scope: input.scope, itemId: null, taskId: null,
    type: SCHEDULED_TASKGRAPH_CONTINUATION_RECEIPT_EVENT, idempotencyKey: key, payload: contract.receipt, actor: "system", outbox: false })
  if (!scheduleSnapshot.requireApproval) return { ...scheduleReceipt, choice: { required: false } }
  const choice = inspectedChoice?.choice
  if (choice?.status === "answered" && created.readyTaskIds.includes(created.created[0].taskId)) {
    await enqueueReadyPrepareTask(client, input.scope.sessionId, input.scope.rootTaskId, created.created[0].taskId)
  }
  if (scheduleSnapshot.requireApproval && choice?.status !== "answered") throw new TaskGraphCommandError(
    "scheduled_prepare_choice_invalid", "Scheduled Prepare has no exact persisted answer")
  return scheduleSnapshot.requireApproval
    ? { ...scheduleReceipt, choice: { required: true, status: "answered", waitId: choice!.waitId } }
    : { ...scheduleReceipt, choice: { required: false } }
}

async function lockScheduledPrepareScope(client: Queryable, input: TaskGraphScheduledPrepareInput, receipt: unknown) {
  try {
    return await lockTaskGraphScope(client, input.scope, true)
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "task_graph_step_fenced") throw error
    const { scope } = input
    const turn = await client.query(`SELECT "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt" FROM "agent_turns"
      WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4 FOR UPDATE`,
    [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
    const turnRow = turn.rows[0] as Record<string, unknown> | undefined
    if (!turnRow || turnRow.status !== "in_progress") throw error
    const inspected = await readScheduledChoice(client, scope, receipt, turnRow)
    if (inspected.choice.status !== "answered" || inspected.stepId !== scope.stepId || inspected.stepStatus !== "waiting_for_user"
      || !inspected.itemId || !inspected.answer) throw error
    await resumeAnsweredScheduledPrepareStep(client, input, inspected, turnRow)
    return lockTaskGraphScope(client, scope, true)
  }
}

async function resumeAnsweredScheduledPrepareStep(client: Queryable, input: TaskGraphScheduledPrepareInput,
  inspected: ScheduledChoiceInspection, turn: Record<string, unknown>): Promise<void> {
  const { scope } = input
  if (turn.leaseOwnerId !== scope.turnLeaseOwner || Number(turn.leaseVersion) !== scope.turnLeaseVersion
    || !(turn.leaseExpiresAt instanceof Date) || !Number.isFinite(turn.leaseExpiresAt.getTime())) {
    throw new TaskGraphCommandError("scheduled_prepare_choice_binding_stale", "Scheduled Prepare choice owner is stale")
  }
  const resumed = await client.query(`UPDATE "agent_steps" AS step SET "status" = 'streaming', "completedAt" = NULL
    FROM "agent_sessions" AS session JOIN "agent_turns" AS turn ON turn."sessionId" = session."id"
      JOIN "sub_agent_tasks" AS root ON root."sessionId" = session."id" AND root."turnId" = turn."id"
      JOIN "agent_items" AS answer ON answer."sessionId" = session."id" AND answer."turnId" = turn."id"
    WHERE session."id" = $1 AND session."userId" = $2 AND session."status" NOT IN ('aborted', 'archived')
      AND turn."id" = $3 AND turn."userId" = $2 AND turn."rootTaskId" = $4 AND turn."status" = 'in_progress'
      AND turn."leaseOwnerId" = $7 AND turn."leaseVersion" = $8 AND turn."leaseExpiresAt" = $13
      AND turn."leaseExpiresAt" > clock_timestamp()
      AND root."id" = $4 AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL AND root."status" = 'running'
      AND root."leaseOwner" = $9 AND root."attemptCount" = $10 AND root."interruptRequestedAt" IS NULL
      AND root."leaseExpiresAt" > clock_timestamp()
      AND step."id" = $5 AND step."sessionId" = $1 AND step."turnId" = $3 AND step."taskId" = $4
      AND step."ordinal" = $11 AND step."attempt" = 1 AND step."status" = 'waiting_for_user'
      AND answer."id" = $6 AND answer."stepId" = $5 AND answer."taskId" = $4 AND answer."type" = 'question'
      AND answer."status" = 'completed' AND answer."content"->>'answer' = $12
    RETURNING step."id"`, [scope.sessionId, scope.userId, scope.turnId, scope.rootTaskId, scope.stepId, inspected.itemId,
    scope.turnLeaseOwner, scope.turnLeaseVersion, scope.parentLeaseOwner, scope.parentAttemptCount,
    inspected.stepOrdinal, inspected.answer, turn.leaseExpiresAt])
  if (resumed.rowCount !== 1) throw new TaskGraphCommandError(
    "scheduled_prepare_choice_binding_stale", "Scheduled Prepare choice could not resume its candidate step")
}

type ScheduledChoiceInspection = Readonly<{
  choice: Readonly<{ required: true; status: "waiting" | "answered"; waitId: string }>
  stepId: string
  stepStatus: string
  stepOrdinal: number
  itemId: string | null
  answer: "apply_ai_changes" | "keep_resume" | null
}>

async function suppressScheduledPrepareDispatch(client: Queryable, sessionId: string, taskId: string): Promise<void> {
  const removed = await client.query(`DELETE FROM "agent_outbox" WHERE "topic" = 'agent.subagent.dispatch'
    AND "aggregateId" = $1 AND "idempotencyKey" = $2 AND "publishedAt" IS NULL RETURNING "id"`,
  [sessionId, `subagent-dispatch:${taskId}`])
  if (removed.rows.length > 1) throw new TaskGraphCommandError("scheduled_prepare_dispatch_conflict", "Scheduled Prepare dispatch is ambiguous")
}

async function enqueueReadyPrepareTask(client: Queryable, sessionId: string, rootTaskId: string, taskId: string): Promise<void> {
  // enqueueGraphTask only consumes these two validated identity fields from the task record.
  await enqueueGraphTask(client, sessionId, { id: taskId, rootTaskId } as SubagentTaskRecord)
}

async function readScheduledChoice(client: Queryable, scope: TaskGraphScheduledPrepareInput["scope"], receipt: unknown,
  turn: Record<string, unknown>): Promise<ScheduledChoiceInspection> {
  if (turn.leaseOwnerId !== scope.turnLeaseOwner || Number(turn.leaseVersion) !== scope.turnLeaseVersion
    || !(turn.leaseExpiresAt instanceof Date) || !Number.isFinite(turn.leaseExpiresAt.getTime())) {
    throw new TaskGraphCommandError("scheduled_prepare_choice_binding_stale", "Scheduled Prepare choice owner is stale")
  }
  const owner: TurnExecutionOwnerFence = { kind: "turn", userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner,
    leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: turn.leaseExpiresAt }
  const stored = await loadScheduledChoiceBinding(client, { owner, expectedReceipt: receipt })
  const itemId = questionItemId(stored.waitId)
  const found = await client.query<Record<string, unknown>>(`SELECT "id", "stepId", "taskId", "type", "status", "content"
    FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`,
  [itemId, scope.sessionId, scope.turnId])
  if (found.rows.length === 0) return { choice: { required: true, status: "waiting", waitId: stored.waitId },
    stepId: stored.stepId, stepStatus: stored.stepStatus, stepOrdinal: stored.binding.finalStepOrdinal, itemId: null, answer: null }
  const row = found.rows[0], answer = parseTurnScheduledPrepareChoiceItem(row?.content, row?.status, stored.binding)
  if (found.rows.length !== 1 || row?.id !== itemId || row.stepId !== stored.stepId || row.taskId !== scope.rootTaskId
    || row.type !== "question" || answer === undefined) {
    throw new TaskGraphCommandError("scheduled_prepare_choice_invalid", "Scheduled Prepare choice is malformed or closed")
  }
  return { choice: { required: true, status: answer === null ? "waiting" : "answered", waitId: stored.waitId },
    stepId: stored.stepId, stepStatus: stored.stepStatus, stepOrdinal: stored.binding.finalStepOrdinal,
    itemId, answer: answer === null ? null : answer }
}
