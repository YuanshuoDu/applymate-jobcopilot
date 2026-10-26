import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { parseTaskGraphOperationalFailureReplacement, validateTaskGraphOperationalFailureReplacement, type TaskGraphOperationalFailureReplacement } from "../planning/task-graph-operational-failure-replacement.js"
import type { TaskGraphProposal } from "../planning/task-graph.js"
import { parseTaskGraphVerificationReport, taskGraphVerificationReportMatchesStatus, type TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { parseTaskGraphOperationalFailedBranchRelation, parseTaskGraphOperationalFailurePlanNodes, taskGraphOperationalFailedBranchFingerprint,
  type TaskGraphOperationalFailedBranchRelation } from "./task-graph-pg-operational-failed-branch-relation.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey, taskGraphProposalKey, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { proveTaskGraphOperationalObservedGraph } from "./task-graph-pg-operational-failure-observation.js"
import { operationalCancellationsHaveNoOtherEvidence, proveTaskGraphOperationalHistoryCancellations } from "./task-graph-pg-operational-failure-cancellations.js"
import { steeringReconciliationId, steeringReconciliationIdempotencyKey, validSteeringReconciliationToolCall, type SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import { normalizeRootPlanCriteria } from "./root-plan-criteria.js"

type Client = Pick<pg.PoolClient, "query">; type Row = Record<string, unknown>; type EventRef = Readonly<{ id: string; sequence: bigint; stepId: string; idempotencyKey: string }>
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function exact(value: Row | null, keys: readonly string[]): value is Row { return value !== null && Reflect.ownKeys(value).length === keys.length && Reflect.ownKeys(value).every(key => typeof key === "string" && keys.includes(key)) }
function seq(value: unknown): bigint | null {
  if (typeof value === "bigint") return value > 0n ? value : null
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null
  const parsed = BigInt(value); return parsed <= 9_223_372_036_854_775_807n ? parsed : null
}
function invalid(): never { throw new Error("steering_reconciliation_operational_failure_event_invalid") }
function parseSchedule(value: unknown): TaskGraphScheduleReceipt | null {
  const row = object(value)
  if (!row || !exact(row, ["status", "revision", "nodes", "readyTaskIds"]) || row.status !== "accepted"
    || !Number.isSafeInteger(row.revision) || !Array.isArray(row.nodes) || !Array.isArray(row.readyTaskIds)) return null
  const nodes = row.nodes.map(object)
  if (nodes.some(node => !exact(node, ["key", "taskId", "status"]) || typeof node.key !== "string" || typeof node.taskId !== "string"
    || node.status !== "queued" && node.status !== "waiting")
    || nodes.some((node, i) => nodes.slice(0, i).some(prior => prior?.key === node?.key || prior?.taskId === node?.taskId))) return null
  const queued = new Set(nodes.filter((node): node is Row => node?.status === "queued").map(node => node.taskId as string))
  if (!row.readyTaskIds.every((id): id is string => typeof id === "string" && queued.has(id)) || new Set(row.readyTaskIds).size !== row.readyTaskIds.length) return null
  return row as unknown as TaskGraphScheduleReceipt
}
function same(left: unknown, right: unknown): boolean { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) }
function eventIds(relation: TaskGraphOperationalFailedBranchRelation): string[] {
  return [...new Set([relation.failedSource.event.id, relation.observedGraphEvent.id, ...relation.priorCancellations.map(value => value.event.id),
    ...relation.cancellations.map(value => value.event.id), ...relation.verifiedExternalDependencies.map(value => value.completedEvent.id), relation.planEvent.id])]
}
async function readEvents(client: Client, scope: SteeringReconciliationScope, ids: readonly string[]): Promise<Map<string, Row>> {
  const result = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId", event."type",
      event."actor", event."correlationId", event."causationId", event."sequence"::text AS "sequence", event."idempotencyKey", event."payload",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId",
      outbox."topic" AS "outboxTopic", outbox."aggregateId" AS "outboxAggregateId", outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $3
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = $3 AND turn."rootTaskId" = $4
      LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."id" = ANY($5::text[])
    ORDER BY event."sequence", event."id"`, [scope.sessionId, scope.turnId, scope.userId, scope.rootTaskId, ids])
  if (result.rows.length !== ids.length || result.rows.some(row => row.sessionUserId !== scope.userId
    || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId)) invalid()
  const rows = new Map(result.rows.map(row => [String(row.id), row]))
  if (rows.size !== ids.length) invalid()
  return rows
}
function outboxMatches(row: Row): boolean {
  const expected = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId, taskId: row.taskId, sequence: String(row.sequence),
    type: row.type, actor: row.actor, correlationId: row.correlationId, causationId: row.causationId, idempotencyKey: row.idempotencyKey, payload: row.payload }
  return row.outboxTopic === "agent.session.event" && row.outboxAggregateId === row.sessionId && row.outboxIdempotencyKey === `agent-event:${row.id}` && same(row.outboxPayload, expected)
}
function lifecycleSnapshot(row: Row, scope: SteeringReconciliationScope, type: string, nodeKey: string, taskId: string, attempt: number,
  expectedRevision: number, expectedCausationId: string | null = null): TaskGraphSnapshot {
  const payload = object(row.payload), item = object(payload?.item), event = parseTaskGraphEvent(payload?.event), key = taskGraphLifecycleKey(scope.rootTaskId, nodeKey, attempt, type)
  let snapshot: TaskGraphSnapshot
  try { snapshot = parseTaskGraphSnapshot(item?.content) } catch { return invalid() }
  const sequence = seq(row.sequence)
  if (!sequence || !outboxMatches(row) || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId
    || row.itemId !== taskGraphItemId(scope.rootTaskId) || row.taskId !== taskId || row.type !== "item.delta"
    || row.actor !== "system" || row.correlationId !== scope.turnId || row.causationId !== expectedCausationId || row.idempotencyKey !== key
    || payload?.kind !== "lifecycle" || !exact(payload, ["kind", "event", "revision", "item"])
    || event?.type !== type || event.nodeKey !== nodeKey || event.expectedRevision !== expectedRevision
    || event.idempotencyKey !== key || payload.revision !== expectedRevision + 1
    || !item || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== taskGraphItemId(scope.rootTaskId)
    || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.rootTaskId
    || item.type !== "task_graph" || item.status !== "streaming" || item.phase !== null || item.revision !== payload.revision) return invalid()
  return snapshot
}
async function callInput(client: Client, scope: SteeringReconciliationScope, relation: TaskGraphOperationalFailedBranchRelation): Promise<Readonly<{ sequence: bigint; nodes: TaskGraphProposal["nodes"]; criteria?: readonly string[] }>> {
  const call = relation.agentPlanCall, result = await client.query<Row>(`SELECT event."sequence"::text AS "sequence", event."type", event."actor",
      event."taskId" AS "eventTaskId", event."itemId" AS "eventItemId", event."correlationId", event."idempotencyKey", event."payload",
      item."id", item."stepId", item."taskId" AS "itemTaskId", item."type" AS "itemType", item."content"
    FROM "agent_events" AS event JOIN "agent_items" AS item ON item."id" = event."itemId"
      AND item."sessionId" = event."sessionId" AND item."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'tool_call.started'
      AND event."taskId" = $3 AND event."correlationId" = $4 AND item."taskId" = $3 AND item."stepId" = $5 LIMIT 2`,
  [scope.sessionId, scope.turnId, scope.rootTaskId, call.callId, call.stepId])
  const row = result.rows[0], sequence = seq(row?.sequence), content = object(row?.content), input = object(content?.input)
  const event = row && { type: row.type, actor: row.actor, taskId: row.eventTaskId, itemId: row.eventItemId,
    correlationId: row.correlationId, idempotencyKey: row.idempotencyKey, payload: row.payload }
  const item = row && { id: row.id, stepId: row.stepId, taskId: row.itemTaskId, type: row.itemType, content: row.content }
  const parsedInput = (() => {
    if (!input || typeof input.expectedRevision !== "number") return null
    const nodes = parseTaskGraphOperationalFailurePlanNodes(input.nodes), criteria = normalizeRootPlanCriteria(input.rootSuccessCriteria)
    const mode = nodes && parseTaskGraphOperationalFailureReplacement(input.replaceOperationalFailure, nodes)
    return nodes && criteria !== null && mode?.ok ? { expectedRevision: input.expectedRevision, nodes, replaceOperationalFailure: mode.value,
      ...(criteria === undefined ? {} : { rootSuccessCriteria: criteria }) } : null
  })()
  if (result.rows.length !== 1 || !sequence || sequence <= BigInt(relation.failedSource.event.sequence)
    || row?.stepId !== call.stepId || row.itemType !== "tool_call" || content?.toolName !== "agent.plan"
    || !validSteeringReconciliationToolCall(event!, item!, scope, call.stepId, "revise", relation.observedRevision,
      undefined, undefined, call.replaceOperationalFailure)
    || !parsedInput || !same(parsedInput.replaceOperationalFailure, call.replaceOperationalFailure)
    || parsedInput.expectedRevision !== relation.observedRevision
    || sequence <= BigInt(relation.observedGraphEvent.sequence)
    || sequence >= BigInt(relation.cancellations[0]?.event.sequence ?? relation.planEvent.sequence)) return invalid()
  const fingerprint = taskGraphOperationalFailedBranchFingerprint({ rootTaskId: scope.rootTaskId, expectedRevision: relation.observedRevision,
    replaceOperationalFailure: call.replaceOperationalFailure, nodes: parsedInput.nodes,
    ...(parsedInput.rootSuccessCriteria === undefined ? {} : { rootSuccessCriteria: parsedInput.rootSuccessCriteria }) })
  if (fingerprint !== relation.requestFingerprint) return invalid()
  return { sequence, nodes: parsedInput.nodes, ...(parsedInput.rootSuccessCriteria === undefined ? {} : { criteria: parsedInput.rootSuccessCriteria }) }
}
async function readTasks(client: Client, scope: SteeringReconciliationScope, ids: readonly string[]): Promise<Map<string, Row>> {
  const result = await client.query<Row>(`SELECT task."id", task."status", task."role", task."taskType", task."attemptCount", task."leaseOwner",
      task."leaseExpiresAt", task."nextAttemptAt", task."startedAt", task."completedAt", task."closedAt",
      task."interruptRequestedAt", task."failureReason", task."result", task."confidence", task."qualityGateResult", task."contextSnapshotId", task."outputArtifactIds",
      EXISTS (SELECT 1 FROM "agent_outbox" dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch'
        AND dispatch."aggregateId" = task."sessionId" AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id") AS "hasCanonicalDispatch",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId"
    FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id" = task."sessionId"
    JOIN "agent_turns" turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND session."userId" = $5 AND turn."userId" = $5
    ORDER BY task."id" FOR UPDATE OF task`, [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  if (result.rows.length !== ids.length) invalid()
  return new Map(result.rows.map(row => [String(row.id), row]))
}
function validTaskOwner(row: Row, scope: SteeringReconciliationScope): boolean { return row.sessionUserId === scope.userId && row.turnUserId === scope.userId && row.turnRootTaskId === scope.rootTaskId }
function taskType(templateId: string): string | null { return templateId === "scout" ? "job_discovery" : templateId === "analyst" ? "job_analysis" : null }
function validReport(task: Row, node: TaskGraphSnapshot["nodes"][number], status: "passed" | "unverified"): Row | null {
  const result = object(task.result), raw = object(result?.taskGraphVerificationReport)
  const report = raw && node.verification ? parseTaskGraphVerificationReport(raw, node.verification.criteria.map(item => item.id)) : null
  return task.role === node.templateId && report?.status === status
    && taskGraphVerificationReportMatchesStatus(report, status === "passed" ? "completed" : "failed")
    && (status !== "unverified" || report.reasonCode === "result_invalid" && exact(result, ["workerResult", "taskGraphVerificationReport"])
      && result.workerResult === null) ? raw : null
}
function deltaMatches(before: TaskGraphSnapshot, after: TaskGraphSnapshot, sources: readonly TaskGraphSnapshot["nodes"][number][],
  mapping: ReadonlyMap<string, string>, proposals: readonly unknown[], receipt: TaskGraphScheduleReceipt, revision: number): boolean {
  const sourceKeys = new Set(sources.map(node => node.key)), retained = before.nodes.filter(node => !sourceKeys.has(node.key))
  const inserted = after.nodes.filter(node => !before.nodes.some(old => old.key === node.key)), oldIds = new Set(before.nodes.map(node => node.taskId))
  const newIds = new Set<string>()
  if (after.nodes.length !== retained.length + sources.length || inserted.length !== sources.length || receipt.revision !== revision
    || receipt.nodes.length !== sources.length || !same(before.rootSuccessCriteria ?? null, after.rootSuccessCriteria ?? null)
    || retained.some(node => !same(node, after.nodes.find(next => next.key === node.key)))) return false
  return sources.every(source => {
    const key = mapping.get(source.key), proposal = proposals.find(value => object(value)?.key === key), model = object(proposal)
    const node = key && after.nodes.find(next => next.key === key), result = node && receipt.nodes.find(entry => entry.key === node.key)
    if (!source || !model || !node || !result || !exact(result as unknown as Row, ["key", "taskId", "status"])
      || result.taskId !== node.taskId || result.status !== "queued" && result.status !== "waiting"
      || node.taskId === source.taskId || oldIds.has(node.taskId) || newIds.has(node.taskId)
      || node.verificationDisposition !== "typed" || node.depth !== source.depth) return false
    newIds.add(node.taskId)
    const { depth: _depth, taskId: _taskId, verificationDisposition: _disposition, registeredScoutEnvelope: _envelope, ...stored } = node
    const envelope = { ...source, key: node.key, taskId: node.taskId, goal: model.goal,
      successCriteria: model.successCriteria, dependsOn: model.dependsOn, verification: model.verification }
    return same(stored, model) && same(envelope, node)
  })
}
/** Re-proves the v5 relation against immutable call, source, lifecycle, cancellation, dependency, and proposal evidence. */
export async function assertTaskGraphOperationalFailedBranchHistory(client: Client, scope: SteeringReconciliationScope,
  input: TaskGraphOperationalFailedBranchRelation, receiptEvent: EventRef): Promise<TaskGraphScheduleReceipt> {
  const relation = parseTaskGraphOperationalFailedBranchRelation(input), call = input.agentPlanCall
  if (!relation || relation.graphRootTaskId !== scope.rootTaskId || receiptEvent.sequence <= 0n || receiptEvent.stepId !== call.stepId
    || receiptEvent.idempotencyKey !== relation.operationKey
    || relation.operationKey !== steeringReconciliationIdempotencyKey({ ...scope, stepId: call.stepId }, call.callId)
    || new Set([...eventIds(relation), receiptEvent.id]).size !== eventIds(relation).length + 1) return invalid()
  const events = await readEvents(client, scope, eventIds(relation)), failedRow = events.get(relation.failedSource.event.id)
  const failedPayload = object(failedRow?.payload), failedEventData = parseTaskGraphEvent(failedPayload?.event)
  if (failedEventData?.type !== "task.failed") return invalid()
  const before = lifecycleSnapshot(failedRow ?? {}, scope, "task.failed", relation.failedSource.source.nodeKey,
    relation.failedSource.source.taskId, relation.failedSource.attemptCount, failedEventData.expectedRevision)
  const failureRevision = failedEventData.expectedRevision + 1
  if (String(failedRow?.sequence) !== relation.failedSource.event.sequence || before.nodes.find(node => node.key === relation.failedSource.source.nodeKey)?.taskId !== relation.failedSource.source.taskId
    || failureRevision > relation.observedRevision
    || relation.failedSource.event.idempotencyKey !== taskGraphLifecycleKey(scope.rootTaskId, relation.failedSource.source.nodeKey, relation.failedSource.attemptCount, "task.failed")) return invalid()
  const observed = await proveTaskGraphOperationalObservedGraph(client, { scope: { userId: scope.userId, sessionId: scope.sessionId,
    turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }, observedRevision: relation.observedRevision,
    event: relation.observedGraphEvent })
  const observedRow = events.get(relation.observedGraphEvent.id)
  if (!observed || !observedRow || !same(observed.event, relation.observedGraphEvent)
    || !same(observed.snapshot.rootSuccessCriteria ?? null, before.rootSuccessCriteria ?? null)) return invalid()
  const sourceNodes = relation.sources.map(binding => before.nodes.find(node => node.key === binding.source.nodeKey && node.taskId === binding.source.taskId))
    .filter((node): node is TaskGraphSnapshot["nodes"][number] => node !== undefined)
  if (sourceNodes.length !== relation.sources.length || relation.sources.some(binding => !same(
    before.nodes.find(node => node.key === binding.source.nodeKey && node.taskId === binding.source.taskId),
    observed.snapshot.nodes.find(node => node.key === binding.source.nodeKey && node.taskId === binding.source.taskId)))) return invalid()
  const read = await callInput(client, scope, relation), expectedCall = parseTaskGraphOperationalFailureReplacement(call.replaceOperationalFailure, read.nodes)
  if (!expectedCall.ok || !same(expectedCall.value, call.replaceOperationalFailure)
    || read.sequence <= BigInt(relation.failedSource.event.sequence)
    || read.sequence >= BigInt(relation.cancellations[0]?.event.sequence ?? relation.planEvent.sequence)) return invalid()
  if (sourceNodes.some(node => node.templateId !== "scout" && node.templateId !== "analyst")) return invalid()
  const proposal: TaskGraphProposal = { expectedRevision: relation.observedRevision, nodes: read.nodes as TaskGraphProposal["nodes"] }
  const validation = validateTaskGraphOperationalFailureReplacement({ snapshot: observed.snapshot, replaceOperationalFailure: call.replaceOperationalFailure,
    proposal, ...(read.criteria === undefined ? {} : { proposedRootSuccessCriteria: read.criteria }) })
  if (!validation.ok || validation.value.sourceNodes.length !== relation.sources.length
    || validation.value.sourceNodes.some((node, index) => node.key !== relation.sources[index]?.source.nodeKey
      || node.taskId !== relation.sources[index]?.source.taskId || validation.value.sourceToReplacementKey.get(node.key) !== relation.sources[index]?.replacementKey)) return invalid()
  const externalKeys = new Set<string>(), closure = new Set(sourceNodes.map(node => node.key)), byKey = new Map(observed.snapshot.nodes.map(node => [node.key, node] as const))
  const pending = sourceNodes.flatMap(node => [...node.dependsOn])
  while (pending.length) { const key = pending.pop()!, node = byKey.get(key); if (!node) return invalid(); if (!closure.has(key) && !externalKeys.has(key)) { externalKeys.add(key); pending.push(...node.dependsOn) } }
  const external = observed.snapshot.nodes.filter(node => externalKeys.has(node.key)).sort((left, right) => left.key.localeCompare(right.key))
  if (external.some(node => !same(before.nodes.find(original => original.key === node.key && original.taskId === node.taskId), node))) return invalid()
  if (external.length !== relation.verifiedExternalDependencies.length) return invalid()
  const tasks = await readTasks(client, scope, [...relation.sources.map(source => source.source.taskId), ...external.map(node => node.taskId)])
  const failed = tasks.get(relation.failedSource.source.taskId), failedNode = sourceNodes.find(node => node.taskId === relation.failedSource.source.taskId)!
  if (!failed || !validTaskOwner(failed, scope) || failed.status !== "failed" || failed.role !== failedNode.templateId
    || failed.taskType !== taskType(failedNode.templateId)
    || Number(failed.attemptCount) !== relation.failedSource.attemptCount || failed.failureReason !== relation.failedSource.failureReason
    || failed.leaseOwner !== null || failed.leaseExpiresAt !== null || failed.nextAttemptAt !== null
    || failed.startedAt === null || failed.completedAt === null || failed.closedAt !== null
    || failed.interruptRequestedAt !== null || taskGraphResultDigest(failed.result) !== relation.failedSource.resultDigest
    || !validReport(failed, failedNode, "unverified")) return invalid()
  const failedEvent = events.get(relation.failedSource.event.id)!
  if (failedEventData.failureReason !== relation.failedSource.failureReason) return invalid()
  const graphScope = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId }
  for (const [index, cancellation] of relation.cancellations.entries()) {
    const row = events.get(cancellation.event.id)!, source = cancellation.source, node = sourceNodes.find(value => value.key === source.nodeKey)
    if (!node || source.nodeKey === relation.failedSource.source.nodeKey
      || String(row.sequence) !== cancellation.event.sequence
      || BigInt(cancellation.event.sequence) <= read.sequence
      || BigInt(cancellation.event.sequence) >= BigInt(relation.planEvent.sequence)
      || !same(lifecycleSnapshot(row, scope, "task.cancelled", source.nodeKey, source.taskId, 0, relation.observedRevision + index,
        call.stepId), observed.snapshot)) return invalid()
    const task = tasks.get(source.taskId)
    if (!task || !validTaskOwner(task, scope) || task.status !== "cancelled" || task.role !== node.templateId
      || task.taskType !== taskType(node.templateId) || Number(task.attemptCount) !== 0
      || task.result !== null || task.failureReason !== null || task.leaseOwner !== null || task.leaseExpiresAt !== null
      || task.nextAttemptAt !== null || task.startedAt !== null || task.completedAt === null || task.closedAt !== null || task.interruptRequestedAt !== null
      || task.confidence !== null || task.qualityGateResult !== null || task.contextSnapshotId !== null
      || !Array.isArray(task.outputArtifactIds) || task.outputArtifactIds.length !== 0) return invalid()
  }
  if (relation.cancellations.length && !await operationalCancellationsHaveNoOtherEvidence(client, graphScope,
    relation.cancellations.map(value => value.source), relation.cancellations)) return invalid()
  const prior = await proveTaskGraphOperationalHistoryCancellations(client, { scope: graphScope, failureGraph: before,
    failureSequence: relation.failedSource.event.sequence, observedSequence: relation.observedGraphEvent.sequence, sourceNodes, failedNode,
    operationCancellations: relation.cancellations })
  if (!prior || !same(prior, relation.priorCancellations)) return invalid()
  for (const [index, dependency] of relation.verifiedExternalDependencies.entries()) {
    const node = external[index], task = node && tasks.get(node.taskId), event = events.get(dependency.completedEvent.id)
    const report = node && task && validReport(task, node, "passed")
    if (!node || node.key !== dependency.dependency.nodeKey || node.taskId !== dependency.dependency.taskId || !task || !event || !report
      || !validTaskOwner(task, scope) || task.status !== "completed" || task.role !== node.templateId
      || task.taskType !== taskType(node.templateId) || Number(task.attemptCount) !== dependency.attemptCount
      || task.failureReason !== null || task.leaseOwner !== null || task.leaseExpiresAt !== null || task.nextAttemptAt !== null
      || taskGraphResultDigest(task.result) !== dependency.resultDigest || taskGraphResultDigest(report) !== dependency.reportDigest
      || String(event.sequence) !== dependency.completedEvent.sequence
      || Number(object(event.payload)?.revision) > relation.observedRevision
      || !same(lifecycleSnapshot(event, scope, "task.completed", node.key, node.taskId, dependency.attemptCount, Number(object(event.payload)?.revision) - 1), before)) return invalid()
  }
  const planRow = events.get(relation.planEvent.id)!, planPayload = object(planRow.payload), planItem = object(planPayload?.item)
  const planSequence = seq(planRow.sequence)
  const after = (() => { try { return parseTaskGraphSnapshot(planItem?.content) } catch { return null } })(), schedule = parseSchedule(planPayload?.receipt)
  if (!after || !schedule || !planSequence || String(planRow.sequence) !== relation.planEvent.sequence || planSequence >= receiptEvent.sequence
    || planRow.type !== "item.delta" || planRow.actor !== "orchestrator" || planRow.taskId !== scope.rootTaskId
    || planRow.itemId !== taskGraphItemId(scope.rootTaskId) || planRow.correlationId !== scope.turnId || planRow.causationId !== call.stepId
    || planRow.idempotencyKey !== relation.planEvent.idempotencyKey || !outboxMatches(planRow)
    || planRow.idempotencyKey !== taskGraphProposalKey(scope.rootTaskId, relation.resultingRevision - 1)
    || planPayload?.kind !== "proposal" || planPayload.fingerprint !== relation.requestFingerprint || planPayload.revision !== relation.resultingRevision
    || !exact(planPayload, ["kind", "fingerprint", "receipt", "revision", "item", "content"])
    || !planItem || planItem.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || planItem.id !== taskGraphItemId(scope.rootTaskId)
    || planItem.sessionId !== scope.sessionId || planItem.turnId !== scope.turnId || planItem.stepId !== call.stepId
    || planItem.taskId !== scope.rootTaskId || planItem.type !== "task_graph" || planItem.revision !== relation.resultingRevision
    || !same(planPayload.content, planItem.content)
    || read.sequence >= planSequence
    || !deltaMatches(observed.snapshot, after, validation.value.sourceNodes, validation.value.sourceToReplacementKey, read.nodes, schedule, relation.resultingRevision)) return invalid()
  return schedule
}
