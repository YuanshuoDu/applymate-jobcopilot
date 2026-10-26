import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { parseTurnQuestionGateChoiceBinding, parseTurnScheduledGateChoiceItemState,
  turnScheduledGateChoiceWaitId } from "../turns/turn-question-gate-choice-contract.js"
import { acknowledgeScheduledGateChoiceResume } from "../turns/turn-question-gate-choice-store.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { enqueueReadyGraphTask } from "./task-graph-pg-dispatch.js"
import { persistGraphTransition, prepareGraphTransition } from "./task-graph-pg-lifecycle.js"
import { matchScheduledGateWaitTarget, readScheduledGateQuestionCandidate } from "./scheduled-gate-wait-match.js"
import { scheduledGateAttemptLineageMatches } from "./scheduled-gate-attempt-lineage.js"
import { SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID, parseScheduledGateTaskEnvelope } from "./scheduled-gate-contract.js"
import { TaskGraphCommandError, type TaskGraphScheduledGateResumeInput,
  type TaskGraphScheduledGateResumeReceipt } from "./task-graph-command-port.js"
import type { Queryable } from "./pg-store-persistence.js"
import { taskGraphDeadlineLive } from "./pg-store-claim.js"

type Row = Record<string, unknown>
type GateQuestionCandidate = NonNullable<Awaited<ReturnType<typeof readScheduledGateQuestionCandidate>>>
const GATE_GRAPH_SCOPE = (scope: TaskGraphScheduledGateResumeInput["scope"]) => ({ userId: scope.userId,
  sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId })

/** A one-shot private answer acknowledges, requeues, and dispatches the exact registered Gate atomically. */
export async function resumeScheduledGateChoice(client: Queryable,
  input: TaskGraphScheduledGateResumeInput): Promise<TaskGraphScheduledGateResumeReceipt> {
  if (!validInput(input)) throw invalid("binding")
  const { scope, gateTaskId, requestAttemptCount, waitId, now } = input
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [scope.userId])
  const turn = await lockResumeOwner(client, scope)
  const gateResult = await client.query<Row>(`SELECT task."id", task."absoluteDeadlineAt", task."status", task."attemptCount", task."maxAttempts", task."role",
      task."taskType", task."expectedOutputSchema", task."allowedActions", task."result", task."failureReason", task."leaseOwner",
      task."leaseExpiresAt", task."interruptRequestedAt", task."rootTaskId", task."parentTaskId", task."turnId", task."sessionId"
    FROM "sub_agent_tasks" AS task WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 FOR UPDATE`,
  [gateTaskId, scope.sessionId, scope.turnId, scope.rootTaskId])
  if (gateResult.rows.length !== 1) throw invalid("task")
  const gate = gateResult.rows[0]!
  const executionResult = await client.query<Row>(`SELECT "id", "status", "attemptCount", "state" FROM "agent_executions"
    WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 FOR UPDATE`,
  [input.executionOwner.executionId, scope.userId, scope.sessionId])
  if (executionResult.rows.length !== 1) throw invalid("execution")
  const graph = await loadTaskGraph(client, GATE_GRAPH_SCOPE(scope), true)
  if (!fixedGate(gate, scope, gateTaskId) || !sameGraphGate(graph, gateTaskId, gate.status)
    || Number(gate.maxAttempts) < 1 || !Number.isSafeInteger(Number(gate.attemptCount))) throw invalid("graph")
  if (!await taskGraphDeadlineLive(client, gateTaskId, scope.sessionId)) throw invalid("deadline")
  const rowBinding = await readQuestion(client, scope, gateTaskId, waitId)
  const binding = rowBinding?.binding
  if (!rowBinding || !binding || binding.gateAttempt !== requestAttemptCount || binding.gateTaskId !== gateTaskId
    || !sameStableOwner(binding.owner, { ...scopeOwner(scope), executionId: input.executionOwner.executionId,
      executionAttemptCount: input.executionOwner.executionAttemptCount })) throw invalid("answer")

  if (gate.status === "waiting_for_user" && Number(gate.attemptCount) === requestAttemptCount) {
    const candidate = await readScheduledGateQuestionCandidate(client, { ...waitScope(scope, gateTaskId),
      requestAttemptCount: requestAttemptCount - 1 })
    if (!candidate || !sameCandidate(candidate, rowBinding, gate.result)) throw invalid("question")
    if (rowBinding.stepStatus !== "waiting_for_user") throw invalid("question_step")
    const owner = executionOwner(scope, turn)
    const choice = await acknowledgeScheduledGateChoiceResume(client as Parameters<typeof acknowledgeScheduledGateChoiceResume>[0], {
      owner, binding, gateTaskId, requestAttemptCount, waitId, itemId: rowBinding.id,
      resumedAttemptCount: requestAttemptCount + 1, now,
    })
    const transition = await prepareGraphTransition(client, { taskId: gateTaskId, sessionId: scope.sessionId,
      type: "task.gate_choice_resumed", attemptCount: requestAttemptCount,
      gateChoiceResume: { gateTaskId, requestAttemptCount, resumedAttemptCount: requestAttemptCount + 1 } })
    if (!transition || "blocked" in transition || transition.duplicate) throw invalid("transition")
    const updated = await client.query(`UPDATE "sub_agent_tasks" SET "status" = 'queued', "result" = NULL, "failureReason" = NULL,
      "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "nextAttemptAt" = NULL, "completedAt" = NULL, "updatedAt" = $5
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "rootTaskId" = $4 AND "parentTaskId" = $4
        AND "role" = $6 AND "taskType" = $7 AND "status" = 'waiting_for_user' AND "attemptCount" = $8
        AND "interruptRequestedAt" IS NULL AND ("absoluteDeadlineAt" IS NULL OR "absoluteDeadlineAt" > clock_timestamp())`,
    [gateTaskId, scope.sessionId, scope.turnId, scope.rootTaskId, now, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, requestAttemptCount])
    if (updated.rowCount !== 1) throw invalid("task_update")
    const state = await persistGraphTransition(client, transition, now)
    await enqueueReadyGraphTask(client, GATE_GRAPH_SCOPE(scope), gateTaskId)
    if (!await taskGraphDeadlineLive(client, gateTaskId, scope.sessionId)) throw invalid("deadline")
    return { status: "accepted", taskId: gateTaskId, requestAttemptCount, resumedAttemptCount: requestAttemptCount + 1,
      revision: state.revision, readyTaskIds: [gateTaskId] }
  }

  if ((gate.status !== "queued" && gate.status !== "running") || gate.result != null
    || Number(gate.attemptCount) !== requestAttemptCount && Number(gate.attemptCount) !== requestAttemptCount + 1
    || await matchScheduledGateWaitTarget(client, { ...waitScope(scope, gateTaskId), requestAttemptCount }) !== "pending") {
    throw invalid("stale_resume")
  }
  const acknowledgement = await acknowledgeScheduledGateChoiceResume(client as Parameters<typeof acknowledgeScheduledGateChoiceResume>[0], {
    owner: executionOwner(scope, turn), binding, gateTaskId, requestAttemptCount, waitId, itemId: rowBinding.id,
    resumedAttemptCount: requestAttemptCount + 1, now,
  })
  if (!acknowledgement || !scheduledGateAttemptLineageMatches({ rootTaskId: scope.rootTaskId, gateTaskId,
    maxAttempts: Number(gate.maxAttempts), requestAttemptCount, currentAttemptCount: Number(gate.attemptCount),
    currentStatus: String(gate.status), events: graph.state!.appliedEvents })) throw invalid("stale_resume")
  if (!await taskGraphDeadlineLive(client, gateTaskId, scope.sessionId)) throw invalid("deadline")
  return { status: "duplicate", taskId: gateTaskId, requestAttemptCount, resumedAttemptCount: requestAttemptCount + 1,
    revision: graph.state!.revision, readyTaskIds: [gateTaskId] }
}

async function lockResumeOwner(client: Queryable, scope: TaskGraphScheduledGateResumeInput["scope"]): Promise<Row> {
  const session = await client.query<Row>(`SELECT "id", "status" FROM "agent_sessions"
    WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted','archived') FOR UPDATE`, [scope.sessionId, scope.userId])
  const turn = await client.query<Row>(`SELECT "id", "status", "leaseOwnerId", "leaseVersion", "leaseExpiresAt",
      "leaseExpiresAt" > clock_timestamp() AS "leaseValid" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 AND "rootTaskId" = $4 FOR UPDATE`,
  [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId])
  const root = await client.query<Row>(`SELECT task."id", task."status", task."leaseOwner", task."attemptCount",
      task."interruptRequestedAt", task."leaseExpiresAt" > clock_timestamp() AS "leaseValid"
    FROM "sub_agent_tasks" AS task WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $1 AND task."parentTaskId" IS NULL FOR UPDATE`, [scope.rootTaskId, scope.sessionId, scope.turnId])
  const t = turn.rows[0], r = root.rows[0]
  if (session.rows.length !== 1 || turn.rows.length !== 1 || root.rows.length !== 1 || !t || !r
    || t.status !== "in_progress" || t.leaseOwnerId !== scope.turnLeaseOwner || Number(t.leaseVersion) !== scope.turnLeaseVersion
    || t.leaseValid !== true || r.status !== "running" || r.leaseOwner !== scope.parentLeaseOwner
    || Number(r.attemptCount) !== scope.parentAttemptCount || r.interruptRequestedAt != null || r.leaseValid !== true) throw invalid("owner")
  return t
}

async function readQuestion(client: Queryable, scope: TaskGraphScheduledGateResumeInput["scope"], gateTaskId: string, waitId: string) {
  const id = `agent-wait:question:${waitId}`
  const result = await client.query<Row>(`SELECT item."id", item."stepId", item."taskId", item."type", item."status", item."content",
      step."status" AS "stepStatus" FROM "agent_items" AS item
    JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = 'question' AND item."status" = 'completed'`, [id, scope.sessionId, scope.turnId, scope.rootTaskId])
  if (result.rows.length !== 1) return null
  const row = result.rows[0]!, binding = parseTurnQuestionGateChoiceBinding(record(row.content)?.scheduledGateChoiceBinding)
  const state = binding && parseTurnScheduledGateChoiceItemState(row.content, row.status, binding)
  return row.id === id && row.type === "question" && row.taskId === scope.rootTaskId && typeof row.stepId === "string"
    && state?.answer !== undefined && state.answer !== null && turnScheduledGateChoiceWaitId(binding) === waitId
    ? { id, stepId: row.stepId, stepStatus: row.stepStatus, binding, state } : null
}

function sameCandidate(candidate: GateQuestionCandidate, row: NonNullable<Awaited<ReturnType<typeof readQuestion>>>, result: unknown): boolean {
  const envelope = parseScheduledGateTaskEnvelope(result, "waiting_for_user", candidate.binding.jobIds)
  return candidate.binding.gateAttempt > 0 && canonicalTaskGraphJson(candidate.binding) === canonicalTaskGraphJson(row.binding)
    && row.state.answer !== null && !!envelope && envelope.structuredResult.status === "question_required"
    && canonicalTaskGraphJson(envelope.structuredResult) === canonicalTaskGraphJson(candidate.question)
}

function fixedGate(row: Row, scope: TaskGraphScheduledGateResumeInput["scope"], taskId: string): boolean {
  return row.id === taskId && row.sessionId === scope.sessionId && row.turnId === scope.turnId
    && row.rootTaskId === scope.rootTaskId && row.parentTaskId === scope.rootTaskId
    && row.role === SCHEDULED_GATE_ROLE && row.taskType === SCHEDULED_GATE_TASK_TYPE
    && same(row.expectedOutputSchema, SCHEDULED_GATE_OUTPUT_SCHEMA) && same(row.allowedActions, [])
    && row.interruptRequestedAt == null
}
function sameGraphGate(graph: Awaited<ReturnType<typeof loadTaskGraph>>, taskId: string, status: unknown): boolean {
  const node = graph.snapshot?.nodes.find(value => value.key === SCHEDULED_GATE_TEMPLATE_ID)
  const current = graph.state?.nodes.find(value => value.key === SCHEDULED_GATE_TEMPLATE_ID)
  return graph.snapshot?.nodes.length === 4 && graph.state?.nodes.length === 4 && !!node && !!current
    && node.taskId === taskId && node.templateId === SCHEDULED_GATE_TEMPLATE_ID && node.depth === 4
    && node.verificationDisposition === "specialized" && node.verification === undefined
    && same(node.dependsOn, ["prepare"]) && node.goal === SCHEDULED_GATE_NODE_GOAL && same(node.successCriteria, SCHEDULED_GATE_NODE_CRITERIA)
    && current.taskId === taskId && current.status === status
}
function waitScope(scope: TaskGraphScheduledGateResumeInput["scope"], gateTaskId: string) {
  return { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    stepId: scope.stepId, gateTaskId }
}
function scopeOwner(scope: TaskGraphScheduledGateResumeInput["scope"]) {
  return { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: scope.parentAttemptCount }
}
function executionOwner(scope: TaskGraphScheduledGateResumeInput["scope"], turn: Row): TurnExecutionOwnerFence {
  return { kind: "turn", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, rootTaskId: scope.rootTaskId, ownerId: scope.turnLeaseOwner,
    leaseVersion: scope.turnLeaseVersion, leaseExpiresAt: date(turn.leaseExpiresAt) }
}
function sameStableOwner(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return ["userId", "sessionId", "turnId", "rootTaskId", "rootAttemptCount", "executionId", "executionAttemptCount"]
    .every(key => left[key] === right[key])
}
function validInput(input: TaskGraphScheduledGateResumeInput): boolean {
  const scope = input.scope
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.stepId, scope.turnLeaseOwner,
    scope.parentLeaseOwner, input.gateTaskId, input.waitId, input.executionOwner.executionId].every(validId)
    && scope.parentTaskId === scope.rootTaskId && scope.rootTaskId === scope.parentTaskId
    && Number.isSafeInteger(scope.turnLeaseVersion) && scope.turnLeaseVersion > 0
    && Number.isSafeInteger(scope.parentAttemptCount) && scope.parentAttemptCount > 0
    && Number.isSafeInteger(input.executionOwner.executionAttemptCount) && input.executionOwner.executionAttemptCount >= 0
    && Number.isSafeInteger(input.requestAttemptCount) && input.requestAttemptCount > 0
    && input.requestAttemptCount < Number.MAX_SAFE_INTEGER && Number.isFinite(input.now.getTime())
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function same(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function date(value: unknown): Date { return value instanceof Date ? value : new Date(String(value)) }
function invalid(reason: string): TaskGraphCommandError { return new TaskGraphCommandError(`scheduled_gate_resume_${reason}`, "Scheduled Gate answer or transition is invalid") }
