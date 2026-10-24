import { createHash } from "node:crypto"
import type pg from "pg"
import { parseTurnQuestionGateChoiceBinding, parseTurnScheduledGateChoiceItemState, turnScheduledGateChoiceWaitId,
  type TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"
import { scheduledSnapshotMatches } from "./scheduled-taskgraph-continuation-receipt.js"
import { buildScheduledPrepareTaskGraphProof, type ScheduledPrepareTaskGraphProof } from "./scheduled-prepare-task-graph-verification.js"
import { parseScheduledGateTaskEnvelope, scheduledGateCheckpointEvidence, scheduledGatePreparedJobIds, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID,
  type ScheduledGateQuestion } from "./scheduled-gate-contract.js"
import { loadTaskGraph, type GraphIdentityScope } from "./task-graph-pg-state.js"
import { taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { scheduledGateAttemptLineageMatches } from "./scheduled-gate-attempt-lineage.js"
import { readScheduledGateRegistrationReceipt } from "./scheduled-gate-registration-receipt.js"

const OPEN_SESSION = `session."status" NOT IN ('aborted', 'archived')`
const TERMINAL = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
type Row = Record<string, unknown>
type Queryable = Pick<pg.PoolClient, "query">
export type ScheduledGateWaitMatcher = Readonly<{ gateTaskId: string; requestAttemptCount: number }>
export type ScheduledGateWaitDisposition = "pending" | "matched" | "stale"
export type ScheduledGateWaitScope = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; stepId: string; gateTaskId: string; requestAttemptCount: number
}>
export type ScheduledPrepareProofReadScope = Pick<ScheduledGateWaitScope, "userId" | "sessionId" | "turnId" | "rootTaskId">
export type ScheduledGateQuestionCandidate = Readonly<{ question: ScheduledGateQuestion; binding: TurnQuestionGateChoiceBinding }>

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return null }
}
function record(value: unknown): Row | null {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const prototype = Object.getPrototypeOf(parsed)
  return prototype === Object.prototype || prototype === null ? parsed as Row : null
}
function exactKeys(row: Row, keys: readonly string[]): boolean { return Object.keys(row).sort().join(",") === [...keys].sort().join(",") }
function id(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function positive(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonNegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function same(left: unknown, right: unknown): boolean { try { return JSON.stringify(left) === JSON.stringify(right) } catch { return false } }

/** Null means a generic wait; undefined means a malformed private marker. */
export function scheduledGateWaitMatcherFromResult(value: unknown): ScheduledGateWaitMatcher | null | undefined {
  const result = record(value), request = record(result?.request)
  if (!request || !Object.hasOwn(request, "scheduledGate")) return null
  const marker = record(request.scheduledGate)
  if (!marker || !exactKeys(marker, ["gateTaskId", "requestAttemptCount"]) || !id(marker.gateTaskId)
    || !nonNegative(marker.requestAttemptCount)) return undefined
  return { gateTaskId: marker.gateTaskId, requestAttemptCount: Number(marker.requestAttemptCount) }
}

export function scheduledGateWaitReplayMatches(value: unknown, expected?: ScheduledGateWaitMatcher): boolean {
  const actual = scheduledGateWaitMatcherFromResult(value)
  if (expected === undefined) return actual === null
  return actual !== undefined && actual !== null && actual.gateTaskId === expected.gateTaskId
    && actual.requestAttemptCount === expected.requestAttemptCount
}

function fixedTask(row: Row): boolean {
  const schema = record(row.expectedOutputSchema)
  return row.role === SCHEDULED_GATE_ROLE && row.taskType === SCHEDULED_GATE_TASK_TYPE
    && !!schema && exactKeys(schema, Object.keys(SCHEDULED_GATE_OUTPUT_SCHEMA))
    && schema.schemaVersion === SCHEDULED_GATE_OUTPUT_SCHEMA.schemaVersion && schema.role === SCHEDULED_GATE_OUTPUT_SCHEMA.role
    && schema.taskType === SCHEDULED_GATE_OUTPUT_SCHEMA.taskType && Array.isArray(row.allowedActions) && row.allowedActions.length === 0
}
function active(value: unknown, allowed: readonly string[]): boolean { return allowed.includes(String(value)) }
function startRevision(graph: Awaited<ReturnType<typeof loadTaskGraph>>, rootTaskId: string, attempt: number): number | null {
  const key = taskGraphLifecycleKey(rootTaskId, SCHEDULED_GATE_TEMPLATE_ID, attempt, "task.started")
  const events = graph.state?.appliedEvents.filter(event => event.nodeKey === SCHEDULED_GATE_TEMPLATE_ID
    && event.type === "task.started" && event.idempotencyKey === key) ?? []
  if (events.length !== 1) return null
  const revision = events[0].expectedRevision + 1
  return positive(revision) ? revision : null
}

function prepareWaitKey(continuationKey: string, stepId: string): string {
  const digest = createHash("sha256").update(`${continuationKey}\0${stepId}`, "utf8").digest("hex")
  return `scheduled-prepare-dependency:${digest}`
}

export async function loadPersistedScheduledPrepareProof(client: Queryable, scope: ScheduledPrepareProofReadScope, prepareTaskId: string,
  prepareResult: unknown, continuationKey: string, prepareWaitId: string): Promise<ScheduledPrepareTaskGraphProof | null> {
  const finalized = record(prepareResult), facts = finalized?.taskGraphScheduledPrepareProofFacts
  const rows = await client.query<Row>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId", "idempotencyKey",
      "targetTaskIds", "mode", "status", "matchedTaskIds", "result"
    FROM "agent_wait_conditions" WHERE "id" = $1 AND "userId" = $2 AND "sessionId" = $3 AND "turnId" = $4 AND "parentTaskId" = $5`,
  [prepareWaitId, scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId])
  if (rows.rows.length !== 1) return null
  const wait = rows.rows[0]!, request = record(record(wait.result)?.request)
  const targets = parseJson(wait.targetTaskIds), matched = parseJson(wait.matchedTaskIds)
  if (wait.id !== prepareWaitId || wait.parentTaskId !== scope.rootTaskId || !id(wait.stepId)
    || wait.idempotencyKey !== prepareWaitKey(continuationKey, wait.stepId) || wait.status !== "ready" || wait.mode !== "all"
    || !same(targets, [prepareTaskId]) || !same(matched, [prepareTaskId])
    || !request || !exactKeys(request, ["targetTaskIds", "mode", "timeoutMs"]) || request.mode !== "all"
    || request.timeoutMs !== 86_400_000 || !same(request.targetTaskIds, [prepareTaskId])) return null
  const step = await client.query<Row>(`SELECT "id", "taskId", "attempt" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [wait.stepId, scope.sessionId, scope.turnId])
  if (step.rows.length !== 1 || step.rows[0]?.id !== wait.stepId
    || step.rows[0]?.taskId !== null && step.rows[0]?.taskId !== scope.rootTaskId || Number(step.rows[0]?.attempt) !== 1) return null
  return buildScheduledPrepareTaskGraphProof(facts, { waitId: wait.id, status: "ready", mode: "all",
    targetTaskIds: [prepareTaskId], matchedTaskIds: [prepareTaskId] })
}

async function registeredPrepareProof(client: Queryable, scope: ScheduledPrepareProofReadScope, gateTaskId: string, gateRow: Row,
  evidence: NonNullable<ReturnType<typeof scheduledGateCheckpointEvidence>>, graph: Awaited<ReturnType<typeof loadTaskGraph>>,
  prepareTask: Readonly<{ id: string; result: unknown }>): Promise<ScheduledPrepareTaskGraphProof | null> {
  const owner = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    rootAttemptCount: Number(gateRow.rootAttemptCount), executionId: String(gateRow.executionId), executionAttemptCount: Number(gateRow.executionAttemptCount) }
  const receipt = await readScheduledGateRegistrationReceipt(client, { ...scope, owner, gateTaskId })
  const completion = record(record(record(prepareTask.result)?.taskGraphScheduledPrepareProofFacts)?.completion)
  if (!receipt || receipt.continuationKey !== evidence.continuationKey || receipt.snapshotDigest !== evidence.snapshotDigest
    || receipt.evidenceDigest !== evidence.evidenceDigest || receipt.checkpointDigest !== evidence.checkpointDigest
    || receipt.owner.rootAttemptCount !== evidence.owner.rootAttemptCount || receipt.owner.executionId !== evidence.owner.executionId
    || receipt.owner.executionAttemptCount !== evidence.owner.executionAttemptCount
    || receipt.analyzeGraphRevision !== evidence.analyzeGraphRevision || !positive(completion?.graphRevision)
    || receipt.gateAppendRevision <= completion.graphRevision
    || receipt.gateAppendRevision > Number(graph.state?.revision)) return null
  const proof = await loadPersistedScheduledPrepareProof(client, scope, String(prepareTask.id), prepareTask.result,
    evidence.prepareWaitContinuationKey, receipt.prepareWaitId)
  return proof && receipt.prepareScheduleRevision === proof.receipt.prepareScheduleRevision
    && receipt.prepareWaitId === proof.completion.wait.waitId
    && gateAppendRevisionMatches(graph, gateTaskId, gateRow, receipt.gateAppendRevision, scope.rootTaskId) ? proof : null
}

function gateAppendRevisionMatches(graph: Awaited<ReturnType<typeof loadTaskGraph>>, gateTaskId: string, row: Row, revision: number, rootTaskId: string): boolean {
  const events = graph.state?.appliedEvents.filter(event => event.nodeKey === SCHEDULED_GATE_TEMPLATE_ID && event.type === "task.started"
    && event.idempotencyKey === taskGraphLifecycleKey(rootTaskId, SCHEDULED_GATE_TEMPLATE_ID, 1, "task.started")) ?? []
  return events.length === 1 ? events[0]?.expectedRevision === revision
    : events.length === 0 && row.id === gateTaskId && row.status === "queued" && Number(row.attemptCount) === 0
      && graph.state?.revision === revision
}

function sameVerifiedPrefix(graph: Awaited<ReturnType<typeof loadTaskGraph>>, proof: ScheduledPrepareTaskGraphProof): boolean {
  const nodes = graph.snapshot?.nodes, current = graph.state?.nodes
  if (!nodes || !current || nodes.length !== 4 || current.length !== 4) return false
  for (let index = 0; index < 3; index += 1) {
    const node = nodes[index]!, certified = proof.completion.nodes[index]!, state = current.find(value => value.key === node.key)
    const task = graph.tasks.get(node.taskId)
    if (node.templateId !== certified.role || node.taskId !== certified.taskId || node.depth !== index + 1
      || (index === 0 ? node.dependsOn.length !== 0 : node.dependsOn.length !== 1 || node.dependsOn[0] !== nodes[index - 1]?.key)
      || node.verificationDisposition !== (index === 2 ? "specialized" : "typed")
      || !state || state.taskId !== node.taskId || state.status !== "completed" || state.failureReason !== null
      || !task || task.id !== certified.taskId || task.status !== "completed" || task.failureReason !== null
      || task.role !== certified.role || task.taskType !== certified.taskType || task.attemptCount !== certified.attemptCount) return false
  }
  return true
}

async function hasExactResumeAcknowledgement(client: Queryable, scope: ScheduledGateWaitScope, row: Row,
  evidence: NonNullable<ReturnType<typeof scheduledGateCheckpointEvidence>>, graph: Awaited<ReturnType<typeof loadTaskGraph>>,
  expectedJobIds: readonly string[]): Promise<boolean> {
  if (scope.requestAttemptCount === 0) return true
  const result = await client.query<Row>(`SELECT item."id", item."taskId", item."type", item."status", item."content", step."status" AS "stepStatus"
    FROM "agent_items" AS item JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId"
    WHERE item."sessionId" = $1 AND item."turnId" = $2 AND item."taskId" = $3 AND item."type" = 'question'
      AND item."content"->>'stage' = 'scheduled_gate' AND item."content"->'scheduledGateChoiceBinding'->>'gateTaskId' = $4
      AND item."content"->'scheduledGateChoiceBinding'->>'gateAttempt' = $5 ORDER BY item."createdAt" ASC, item."id" ASC LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, scope.gateTaskId, String(scope.requestAttemptCount)])
  if (result.rows.length !== 1) return false
  const item = result.rows[0], content = record(item.content), binding = parseTurnQuestionGateChoiceBinding(content?.scheduledGateChoiceBinding)
  const waitId = turnScheduledGateChoiceWaitId(binding)
  if (!binding || !waitId || item.id !== `agent-wait:question:${waitId}` || item.taskId !== scope.rootTaskId
    || item.type !== "question" || item.status !== "completed" || item.stepStatus !== "waiting_for_user"
    || binding.gateTaskId !== scope.gateTaskId || binding.gateAttempt !== scope.requestAttemptCount
    || binding.owner.userId !== scope.userId || binding.owner.sessionId !== scope.sessionId || binding.owner.turnId !== scope.turnId
    || binding.owner.rootTaskId !== scope.rootTaskId || binding.owner.rootAttemptCount !== Number(row.rootAttemptCount)
    || binding.owner.executionId !== String(row.executionId) || binding.owner.executionAttemptCount !== Number(row.executionAttemptCount)
    || binding.continuationKey !== evidence.continuationKey || binding.snapshotDigest !== evidence.snapshotDigest
    || binding.evidenceDigest !== evidence.evidenceDigest || binding.checkpointDigest !== evidence.checkpointDigest
    || binding.analyzeGraphRevision !== evidence.analyzeGraphRevision || binding.jobIds.some(jobId => !expectedJobIds.includes(jobId))
    || binding.graphRevision !== startRevision(graph, scope.rootTaskId, scope.requestAttemptCount)) return false
  const state = parseTurnScheduledGateChoiceItemState(item.content, item.status, binding), ack = state?.resumeAcknowledgement
  return state !== undefined && state.answer !== null && !!ack && ack.gateTaskId === scope.gateTaskId
    && ack.requestAttemptCount === scope.requestAttemptCount && ack.resumedAttemptCount === scope.requestAttemptCount + 1
}

/** Validates the exact registered Gate target and returns only its scheduling disposition. */
export async function matchScheduledGateWaitTarget(client: Queryable, scope: ScheduledGateWaitScope): Promise<ScheduledGateWaitDisposition | null> {
  if (![scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.stepId, scope.gateTaskId].every(id)
    || !nonNegative(scope.requestAttemptCount) || scope.requestAttemptCount === Number.MAX_SAFE_INTEGER) return null
  const result = await client.query<Row>(`SELECT gate."id", gate."parentTaskId", gate."rootTaskId", gate."sessionId", gate."turnId", gate."depth",
      gate."role", gate."taskType", gate."status", gate."attemptCount", gate."maxAttempts", gate."result", gate."expectedOutputSchema", gate."allowedActions",
      root."attemptCount" AS "rootAttemptCount", root."status" AS "rootStatus", turn."rootTaskId" AS "turnRootTaskId",
      turn."status" AS "turnStatus", turn."source", turn."executionMode", turn."input", session."userId", session."status" AS "sessionStatus",
      execution."id" AS "executionId", execution."attemptCount" AS "executionAttemptCount", execution."status" AS "executionStatus", execution."state"
    FROM "sub_agent_tasks" AS gate
    JOIN "sub_agent_tasks" AS root ON root."id" = gate."rootTaskId" AND root."sessionId" = gate."sessionId" AND root."turnId" = gate."turnId"
    JOIN "agent_sessions" AS session ON session."id" = gate."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = gate."turnId" AND turn."sessionId" = gate."sessionId"
    JOIN "agent_executions" AS execution ON execution."sessionId" = turn."sessionId" AND execution."userId" = session."userId"
    WHERE gate."id" = $1 AND gate."sessionId" = $2 AND gate."turnId" = $3 AND gate."rootTaskId" = $4
      AND gate."parentTaskId" = $4 AND gate."depth" = 1 AND session."userId" = $5 AND turn."userId" = $5
      AND ${OPEN_SESSION}`, [scope.gateTaskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  if (result.rows.length !== 1) return null
  const row = result.rows[0], evidence = scheduledGateCheckpointEvidence(row.state)
  if (row.id !== scope.gateTaskId || row.parentTaskId !== scope.rootTaskId || row.rootTaskId !== scope.rootTaskId
    || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId || row.userId !== scope.userId
    || row.turnRootTaskId !== scope.rootTaskId || !active(row.rootStatus, ["queued", "running", "waiting", "waiting_for_user"])
    || !active(row.turnStatus, ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user", "waiting_for_tool"])
    || row.sessionStatus === "aborted" || row.sessionStatus === "archived" || !active(row.executionStatus, ["running", "waiting_for_user"])
    || !fixedTask(row) || !evidence || evidence.owner.userId !== scope.userId || evidence.owner.sessionId !== scope.sessionId
    || evidence.owner.turnId !== scope.turnId || evidence.owner.rootTaskId !== scope.rootTaskId
    || evidence.owner.rootAttemptCount !== Number(row.rootAttemptCount) || evidence.owner.executionId !== String(row.executionId)
    || evidence.owner.executionAttemptCount !== Number(row.executionAttemptCount)
    || !scheduledSnapshotMatches({ source: row.source, executionMode: row.executionMode, input: row.input }, evidence.snapshotDigest)) return null
  const graphScope: GraphIdentityScope = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }
  const graph = await loadTaskGraph(client, graphScope, false)
  const gateNode = graph.snapshot?.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  const prepareNode = graph.snapshot?.nodes.find(node => node.key === "prepare")
  const gateState = graph.state?.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  const prepareState = graph.state?.nodes.find(node => node.key === "prepare")
  const gateTask = gateNode && graph.tasks.get(gateNode.taskId), prepareTask = prepareNode && graph.tasks.get(prepareNode.taskId)
  if (!graph.snapshot || !graph.state || !gateNode || gateNode.taskId !== scope.gateTaskId
    || gateNode.templateId !== SCHEDULED_GATE_TEMPLATE_ID || gateNode.verificationDisposition !== "specialized"
    || gateNode.verification !== undefined || gateNode.depth !== 4 || !same(gateNode.dependsOn, ["prepare"])
    || gateNode.goal !== SCHEDULED_GATE_NODE_GOAL || !same(gateNode.successCriteria, SCHEDULED_GATE_NODE_CRITERIA) || !prepareNode
    || prepareNode.templateId !== "prepare" || prepareNode.depth !== 3 || !gateState || gateState.status !== row.status
    || gateState.taskId !== scope.gateTaskId || !gateTask || gateTask.status !== row.status
    || !fixedTask({ role: gateTask.role, taskType: gateTask.taskType, expectedOutputSchema: gateTask.expectedOutputSchema, allowedActions: gateTask.allowedActions })
    || !prepareState || prepareState.taskId !== prepareNode.taskId || prepareState.status !== "completed"
    || !prepareTask || prepareTask.status !== "completed" || prepareTask.role !== "prepare"
    || prepareTask.taskType !== "scheduled_application_prepare") return null
  const prepareProof = await registeredPrepareProof(client, scope, scope.gateTaskId, row, evidence, graph, prepareTask)
  if (!prepareProof || !sameVerifiedPrefix(graph, prepareProof)) return null
  const jobs = scheduledGatePreparedJobIds(prepareProof)
  if (!jobs) return null
  const attempt = Number(row.attemptCount), status = String(row.status), maxAttempts = Number(row.maxAttempts)
  if (!scheduledGateAttemptLineageMatches({ rootTaskId: scope.rootTaskId, gateTaskId: scope.gateTaskId, maxAttempts,
    requestAttemptCount: scope.requestAttemptCount, currentAttemptCount: attempt, currentStatus: status,
    events: graph.state.appliedEvents }) || !await hasExactResumeAcknowledgement(client, scope, row, evidence, graph, jobs)) return null
  if (status === "queued" || status === "running") return "pending"
  if (status === "waiting_for_user") {
    const envelope = parseScheduledGateTaskEnvelope(row.result, status, jobs)
    if (envelope?.structuredResult.status !== "question_required"
      || startRevision(graph, scope.rootTaskId, attempt) === null) return null
    return "matched"
  }
  if (TERMINAL.has(status) && attempt > 0 && startRevision(graph, scope.rootTaskId, attempt) !== null) {
    if (status !== "completed") return "matched"
    return parseScheduledGateTaskEnvelope(row.result, status, jobs)?.structuredResult.status === "completed" ? "matched" : null
  }
  return "stale"
}

/** Re-reads the exact admitted current Gate question for private Root question persistence. Caller holds a repeatable-read snapshot. */
export async function readScheduledGateQuestionCandidate(client: Queryable, scope: ScheduledGateWaitScope): Promise<ScheduledGateQuestionCandidate | null> {
  if (await matchScheduledGateWaitTarget(client, scope) !== "matched") return null
  const result = await client.query<Row>(`SELECT gate."id", gate."status", gate."attemptCount", gate."maxAttempts", gate."result", gate."parentTaskId",
      gate."rootTaskId", gate."sessionId", gate."turnId", gate."role", gate."taskType", gate."expectedOutputSchema", gate."allowedActions",
      root."attemptCount" AS "rootAttemptCount", turn."rootTaskId" AS "turnRootTaskId", turn."source", turn."executionMode", turn."input",
      session."userId", execution."id" AS "executionId", execution."attemptCount" AS "executionAttemptCount", execution."state"
    FROM "sub_agent_tasks" AS gate
    JOIN "sub_agent_tasks" AS root ON root."id" = gate."rootTaskId" AND root."sessionId" = gate."sessionId" AND root."turnId" = gate."turnId"
    JOIN "agent_sessions" AS session ON session."id" = gate."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = gate."turnId" AND turn."sessionId" = gate."sessionId"
    JOIN "agent_executions" AS execution ON execution."sessionId" = turn."sessionId" AND execution."userId" = session."userId"
    WHERE gate."id" = $1 AND gate."sessionId" = $2 AND gate."turnId" = $3 AND gate."rootTaskId" = $4
      AND gate."parentTaskId" = $4 AND gate."depth" = 1 AND session."userId" = $5 AND turn."userId" = $5
      AND ${OPEN_SESSION}`, [scope.gateTaskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  if (result.rows.length !== 1) return null
  const row = result.rows[0], evidence = scheduledGateCheckpointEvidence(row.state), attempt = Number(row.attemptCount)
  if (row.id !== scope.gateTaskId || row.status !== "waiting_for_user" || !positive(attempt)
    || row.parentTaskId !== scope.rootTaskId || row.rootTaskId !== scope.rootTaskId || row.sessionId !== scope.sessionId
    || row.turnId !== scope.turnId || row.turnRootTaskId !== scope.rootTaskId || row.userId !== scope.userId
    || !fixedTask(row) || !evidence || evidence.owner.userId !== scope.userId || evidence.owner.sessionId !== scope.sessionId
    || evidence.owner.turnId !== scope.turnId || evidence.owner.rootTaskId !== scope.rootTaskId
    || evidence.owner.rootAttemptCount !== Number(row.rootAttemptCount) || evidence.owner.executionId !== String(row.executionId)
    || evidence.owner.executionAttemptCount !== Number(row.executionAttemptCount)
    || !scheduledSnapshotMatches({ source: row.source, executionMode: row.executionMode, input: row.input }, evidence.snapshotDigest)) return null
  const graph = await loadTaskGraph(client, { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }, false)
  const gateNode = graph.snapshot?.nodes.find(node => node.key === SCHEDULED_GATE_TEMPLATE_ID)
  const prepareNode = graph.snapshot?.nodes.find(node => node.key === "prepare")
  const prepareTask = prepareNode && graph.tasks.get(prepareNode.taskId)
  if (!graph.snapshot || !graph.state || !gateNode || gateNode.taskId !== scope.gateTaskId || !prepareNode || !prepareTask
    || prepareTask.status !== "completed") return null
  const proof = await registeredPrepareProof(client, scope, scope.gateTaskId, row, evidence, graph, prepareTask)
  if (!proof || !sameVerifiedPrefix(graph, proof)) return null
  const expectedJobIds = proof && scheduledGatePreparedJobIds(proof), envelope = expectedJobIds && parseScheduledGateTaskEnvelope(row.result, row.status, expectedJobIds)
  const start = startRevision(graph, scope.rootTaskId, attempt)
  const question = envelope?.structuredResult.status === "question_required" ? envelope.structuredResult : null
  const binding = question && start !== null ? parseTurnQuestionGateChoiceBinding({ schemaVersion: "agent-harness.v2.scheduled-gate-choice-wait.v1",
    owner: { userId: evidence.owner.userId, sessionId: evidence.owner.sessionId, turnId: evidence.owner.turnId,
      rootTaskId: evidence.owner.rootTaskId, rootAttemptCount: evidence.owner.rootAttemptCount,
      executionId: evidence.owner.executionId, executionAttemptCount: evidence.owner.executionAttemptCount },
    continuationKey: evidence.continuationKey, snapshotDigest: evidence.snapshotDigest,
    evidenceDigest: evidence.evidenceDigest, checkpointDigest: evidence.checkpointDigest,
    analyzeGraphRevision: evidence.analyzeGraphRevision, graphRevision: start, gateTaskId: scope.gateTaskId, gateAttempt: attempt,
    kind: question.kind, jobIds: question.jobIds, allowedChoiceIds: question.allowedChoiceIds }) : null
  return question && binding ? { question, binding } : null
}
