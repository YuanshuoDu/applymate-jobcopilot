import type pg from "pg"
import { parseTurnQuestionGateChoiceBinding, parseTurnScheduledGateChoiceItemState,
  turnScheduledGateChoiceWaitId, type TurnQuestionGateChoiceAnswer, type TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"
import { scheduledSnapshotMatches } from "./scheduled-taskgraph-continuation-receipt.js"
import { loadTaskGraph, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { SCHEDULED_GATE_OUTPUT_SCHEMA, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE,
  SCHEDULED_GATE_TEMPLATE_ID, scheduledGateCheckpointEvidence, type ScheduledGateChoiceId, type ScheduledGateQuestionKind } from "./scheduled-gate-contract.js"
import type { SubagentLease } from "./types.js"

const MAX_CHOICES = 51
type Row = Record<string, unknown>
export type ScheduledGateChoice = Readonly<{ kind: ScheduledGateQuestionKind; jobIds: readonly string[]; choiceId: ScheduledGateChoiceId }>
export type ScheduledGateChoiceHistory = Readonly<{ validatedChoice: ScheduledGateChoice | null; priorChoices: readonly ScheduledGateChoice[] }>
export type ScheduledGateChoiceProofScope = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; rootAttemptCount: number
  executionId: string; executionAttemptCount: number; gateTaskId: string; attemptCount: number
  continuationKey: string; snapshotDigest: string; evidenceDigest: string; checkpointDigest: string
  analyzeGraphRevision: number; gateStartRevisions: ReadonlyMap<number, number>
}>

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}
function same(left: unknown, right: unknown): boolean { try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false } }
function fixedTask(row: Row): boolean {
  const schema = record(row.expectedOutputSchema)
  return row.role === SCHEDULED_GATE_ROLE && row.taskType === SCHEDULED_GATE_TASK_TYPE
    && !!schema && same(schema, SCHEDULED_GATE_OUTPUT_SCHEMA)
    && Array.isArray(row.allowedActions) && row.allowedActions.length === 0
}
function bindingMatches(binding: TurnQuestionGateChoiceBinding, scope: ScheduledGateChoiceProofScope): boolean {
  const owner = binding.owner
  return owner.userId === scope.userId && owner.sessionId === scope.sessionId && owner.turnId === scope.turnId
    && owner.rootTaskId === scope.rootTaskId && owner.rootAttemptCount === scope.rootAttemptCount
    && owner.executionId === scope.executionId && owner.executionAttemptCount === scope.executionAttemptCount
    && binding.gateTaskId === scope.gateTaskId && binding.gateAttempt < scope.attemptCount
    && binding.continuationKey === scope.continuationKey && binding.snapshotDigest === scope.snapshotDigest
    && binding.evidenceDigest === scope.evidenceDigest && binding.checkpointDigest === scope.checkpointDigest
    && (binding as TurnQuestionGateChoiceBinding & { analyzeGraphRevision?: unknown }).analyzeGraphRevision === scope.analyzeGraphRevision
    && scope.gateStartRevisions.get(binding.gateAttempt) === binding.graphRevision
}

/** Parses only completed, acknowledged Gate choices from this exact scheduled execution lineage. */
export function parseScheduledGateChoiceHistory(rows: readonly Row[], scope: ScheduledGateChoiceProofScope): ScheduledGateChoiceHistory | null {
  if (rows.length > MAX_CHOICES) return null
  const parsed: Array<{ resumedAttempt: number; subject: string; choice: ScheduledGateChoice }> = []
  const decisions = new Set<string>()
  for (const row of rows) {
    const binding = parseTurnQuestionGateChoiceBinding(row.content && record(row.content)?.scheduledGateChoiceBinding)
    if (!binding || !bindingMatches(binding, scope) || row.type !== "question" || row.status !== "completed"
      || row.taskId !== scope.rootTaskId || typeof row.stepId !== "string" || !row.stepId.trim()
      || row.stepStatus !== "waiting_for_user") return null
    const waitId = turnScheduledGateChoiceWaitId(binding)
    if (!waitId || row.id !== `agent-wait:question:${waitId}`) return null
    const state = parseTurnScheduledGateChoiceItemState(row.content, row.status, binding)
    const ack = state?.resumeAcknowledgement
    if (!state || state.answer === null || !ack || ack.itemId !== row.id || ack.gateTaskId !== scope.gateTaskId
      || ack.requestAttemptCount !== binding.gateAttempt || ack.resumedAttemptCount !== binding.gateAttempt + 1
      || ack.resumedAttemptCount > scope.attemptCount) return null
    const subject = JSON.stringify([binding.kind, binding.jobIds])
    if (decisions.has(subject)) return null
    decisions.add(subject)
    parsed.push({ resumedAttempt: ack.resumedAttemptCount, subject, choice: { kind: binding.kind, jobIds: binding.jobIds, choiceId: state.answer } })
  }
  const current = parsed.filter(value => value.resumedAttempt === scope.attemptCount)
  if (current.length > 1) return null
  const latest = current[0]
  const priorChoices: ScheduledGateChoice[] = []
  for (const entry of parsed.sort((left, right) => left.resumedAttempt - right.resumedAttempt)) {
    if (entry === latest) continue
    priorChoices.push(entry.choice)
  }
  return { validatedChoice: latest?.choice ?? null, priorChoices }
}

/** Reads immutable private choices for a live Gate child without borrowing the Root Turn lease. */
export async function loadScheduledGateChoiceHistory(pool: Pick<pg.Pool, "connect">, lease: SubagentLease, now = new Date()): Promise<ScheduledGateChoiceHistory> {
  const client = await pool.connect()
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY")
    const live = (await client.query<Row>(`SELECT gate."id", gate."sessionId", gate."turnId", gate."rootTaskId", gate."parentTaskId", gate."role", gate."taskType",
        gate."status", gate."depth", gate."attemptCount", gate."leaseOwner", gate."leaseExpiresAt", gate."interruptRequestedAt", gate."expectedOutputSchema", gate."allowedActions",
        root."attemptCount" AS "rootAttemptCount", root."status" AS "rootStatus", root."taskType" AS "rootTaskType", root."interruptRequestedAt" AS "rootInterruptRequestedAt",
        turn."rootTaskId" AS "turnRootTaskId", turn."status" AS "turnStatus", turn."source", turn."executionMode", turn."input",
        session."userId", session."status" AS "sessionStatus", execution."id" AS "executionId", execution."attemptCount" AS "executionAttemptCount",
        execution."status" AS "executionStatus", execution."state"
      FROM "sub_agent_tasks" AS gate
      JOIN "sub_agent_tasks" AS root ON root."id" = gate."rootTaskId" AND root."sessionId" = gate."sessionId" AND root."turnId" = gate."turnId"
      JOIN "agent_sessions" AS session ON session."id" = gate."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = gate."turnId" AND turn."sessionId" = gate."sessionId"
      JOIN "agent_executions" AS execution ON execution."sessionId" = turn."sessionId" AND execution."userId" = session."userId"
      WHERE gate."id" = $1 AND gate."sessionId" = $2 AND gate."turnId" = $3 AND gate."rootTaskId" = $4 AND gate."parentTaskId" = $4
        AND gate."role" = $5 AND gate."taskType" = $6 AND gate."status" = 'running' AND gate."leaseOwner" = $7
        AND gate."attemptCount" = $8 AND gate."leaseExpiresAt" > $9 AND gate."interruptRequestedAt" IS NULL
        AND root."taskType" = 'root' AND root."status" NOT IN ('completed','failed','interrupted','cancelled','closed')
        AND root."interruptRequestedAt" IS NULL AND session."userId" = $10 AND session."status" NOT IN ('aborted','archived')
        AND turn."userId" = $10 AND turn."status" NOT IN ('completed','failed','interrupted','cancelled','closed')`,
    [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE,
      lease.ownerId, lease.attemptCount, now, lease.userId])).rows[0]
    if (!live || !sameLiveLease(live, lease, now) || !fixedTask(live) || !activeStatus(live.rootStatus)
      || !activeStatus(live.turnStatus) || !["running", "waiting_for_user"].includes(String(live.executionStatus))) throw new Error("scheduled_gate_choice_scope_invalid")
    const evidence = scheduledGateCheckpointEvidence(live.state)
    const owner = record(record(live.state)?.scheduledTaskGraphContinuation) && record(record(record(live.state)?.scheduledTaskGraphContinuation)?.owner)
    if (!evidence || !owner || owner.executionId !== live.executionId || owner.executionAttemptCount !== Number(live.executionAttemptCount)
      || owner.userId !== lease.userId || owner.sessionId !== lease.sessionId || owner.turnId !== lease.turnId
      || owner.rootTaskId !== lease.rootTaskId || owner.rootAttemptCount !== Number(live.rootAttemptCount)
      || !scheduledSnapshotMatches({ source: live.source, executionMode: live.executionMode, input: live.input }, evidence.snapshotDigest)) {
      throw new Error("scheduled_gate_choice_checkpoint_invalid")
    }
    const graphScope: GraphIdentityScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId, parentTaskId: lease.rootTaskId }
    const graph = await loadTaskGraph(client, graphScope, false)
    const gateNode = graph.snapshot?.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
    const prepareNode = graph.snapshot?.nodes.find(node => node.key === "prepare")
    const gateState = graph.state?.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
    const gateTask = gateNode && graph.tasks.get(gateNode.taskId)
    const prepareTask = prepareNode && graph.tasks.get(prepareNode.taskId)
    if (!graph.snapshot || !graph.state || !gateNode || gateNode.taskId !== lease.id || gateNode.templateId !== SCHEDULED_GATE_TEMPLATE_ID
      || gateNode.verificationDisposition !== "specialized" || gateNode.depth !== 4 || !same(gateNode.dependsOn, ["prepare"])
      || !prepareNode || prepareNode.templateId !== "prepare" || prepareNode.depth !== 3 || !gateState || gateState.status !== "running"
      || !gateTask || gateTask.status !== "running" || !fixedTask({ role: gateTask.role, taskType: gateTask.taskType,
        expectedOutputSchema: gateTask.expectedOutputSchema, allowedActions: gateTask.allowedActions })
      || !prepareTask || prepareTask.role !== "prepare" || prepareTask.taskType !== "scheduled_application_prepare" || prepareTask.status !== "completed") {
      throw new Error("scheduled_gate_choice_graph_invalid")
    }
    const gateStartRevisions = new Map<number, number>()
    for (let attempt = 1; attempt <= lease.attemptCount; attempt += 1) {
      const key = taskGraphLifecycleKey(lease.rootTaskId, SCHEDULED_GATE_TEMPLATE_ID, attempt, "task.started")
      const event = graph.state.appliedEvents.find(value => value.nodeKey === SCHEDULED_GATE_TEMPLATE_ID
        && value.type === "task.started" && value.idempotencyKey === key)
      if (event) gateStartRevisions.set(attempt, event.expectedRevision + 1)
    }
    const scope: ScheduledGateChoiceProofScope = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, rootTaskId: lease.rootTaskId,
      rootAttemptCount: Number(live.rootAttemptCount), executionId: String(live.executionId), executionAttemptCount: Number(live.executionAttemptCount),
      gateTaskId: lease.id, attemptCount: lease.attemptCount, continuationKey: evidence.continuationKey,
      snapshotDigest: evidence.snapshotDigest, evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest,
      analyzeGraphRevision: evidence.analyzeGraphRevision, gateStartRevisions }
    const rows = await client.query<Row>(`SELECT item."id", item."stepId", item."taskId", item."type", item."status", item."content", step."status" AS "stepStatus"
      FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId"
      WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."type" = 'question'
        AND item."content"->>'stage' = 'scheduled_gate' AND item."content"->'scheduledGateChoiceBinding'->>'gateTaskId' = $4
      ORDER BY item."createdAt" ASC, item."id" ASC LIMIT $5`,
    [lease.sessionId, lease.turnId, lease.rootTaskId, lease.id, MAX_CHOICES + 1])
    const history = parseScheduledGateChoiceHistory(rows.rows, scope)
    if (!history) throw new Error("scheduled_gate_choice_history_invalid")
    await client.query("COMMIT")
    return history
  } catch (error: unknown) {
    try { await client.query("ROLLBACK") } catch { /* preserve the validation failure */ }
    throw error
  } finally { client.release() }
}

function sameLiveLease(row: Row, lease: SubagentLease, now: Date): boolean {
  const expiry = row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : new Date(String(row.leaseExpiresAt))
  return row.id === lease.id && row.sessionId === lease.sessionId && row.turnId === lease.turnId && row.rootTaskId === lease.rootTaskId
    && row.parentTaskId === lease.rootTaskId && row.userId === lease.userId && row.status === "running" && row.leaseOwner === lease.ownerId
    && Number(row.attemptCount) === lease.attemptCount && Number(row.depth) === 1 && row.interruptRequestedAt == null
    && lease.status === "running" && lease.leaseOwner === lease.ownerId && lease.interruptRequestedAt === null
    && lease.leaseExpiresAt.getTime() > now.getTime() && expiry.getTime() > now.getTime()
}
function activeStatus(value: unknown): boolean { return ["queued", "running", "retrying", "waiting", "waiting_for_tool", "waiting_for_user", "waiting_for_dependency", "waiting_for_approval", "in_progress"].includes(String(value)) }
