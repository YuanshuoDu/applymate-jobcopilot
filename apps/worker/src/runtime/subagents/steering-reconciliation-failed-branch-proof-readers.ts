import { createHash } from "node:crypto"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type pg from "pg"
import type { TaskGraphScheduleReceipt } from "./task-graph-command-port.js"
import { parsePersistedTaskGraphNativeReceipt } from "./task-graph-native-command.js"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId,
  taskGraphLifecycleKey, taskGraphProposalKey } from "./task-graph-snapshot.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { SteeringReconciliationDurableScope } from "./steering-reconciliation-contract.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type VerifiedTaskGraphFailedBranchReplacementMemoryWitness = Readonly<{
  reason: "result_invalid"
  sourceTemplateIds: readonly string[]
  successorTemplateIds: readonly string[]
}>

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function exactRow(row: Row | null, keys: readonly string[]): row is Row {
  return row !== null && Reflect.ownKeys(row).length === keys.length
    && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key))
}
function sequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value > 0n && value <= 9_223_372_036_854_775_807n ? value : null
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? BigInt(value) : null
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null
  const parsed = BigInt(value)
  return parsed <= 9_223_372_036_854_775_807n ? parsed : null
}
function invalid(): never { throw new Error("steering_reconciliation_failed_branch_event_invalid") }
type ObservedSnapshot = Readonly<{ snapshot: TaskGraphSnapshot; sequence: bigint; id: string; itemStepId: string | null }>

export async function readTaskGraphReplacementObservedSnapshot(client: Client, scope: SteeringReconciliationDurableScope,
  beforeSequence: bigint, expectedRevision: number): Promise<ObservedSnapshot> {
  const result = await client.query<Row>(`SELECT event."id", event."sessionId", event."turnId", event."itemId", event."taskId",
      event."sequence"::text AS "sequence", event."type", event."actor", event."correlationId", event."causationId",
      event."idempotencyKey", event."payload", session."userId" AS "sessionUserId", turn."userId" AS "turnUserId",
      turn."rootTaskId" AS "turnRootTaskId", outbox."topic" AS "outboxTopic", outbox."aggregateId" AS "outboxAggregateId",
      outbox."idempotencyKey" AS "outboxIdempotencyKey", outbox."payload" AS "outboxPayload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId" AND session."userId" = $4
      JOIN "agent_turns" AS turn ON turn."id" = event."turnId" AND turn."sessionId" = event."sessionId"
        AND turn."userId" = $4 AND turn."rootTaskId" = $3
      LEFT JOIN "agent_outbox" AS outbox ON outbox."idempotencyKey" = 'agent-event:' || event."id"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $5
      AND event."type" IN ('item.started', 'item.delta') AND event."sequence" < $6::bigint
    ORDER BY event."sequence" DESC LIMIT 1`, [scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId,
    taskGraphItemId(scope.rootTaskId), beforeSequence.toString()])
  const row = result.rows[0], payload = object(row?.payload), item = object(payload?.item), seq = sequence(row?.sequence)
  const snapshot = parseTaskGraphReplacementSnapshot(item?.content), itemStepId = item?.stepId
  if (itemStepId !== null && (typeof itemStepId !== "string" || itemStepId.length === 0)) invalid()
  if (result.rows.length !== 1 || !row || !payload || !item || !snapshot || seq === null || seq >= beforeSequence
    || Number(payload.revision) !== expectedRevision || item.revision !== expectedRevision || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION
    || item.id !== taskGraphItemId(scope.rootTaskId) || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId
    || item.taskId !== scope.rootTaskId || item.type !== "task_graph" || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId
    || row.itemId !== taskGraphItemId(scope.rootTaskId) || row.sessionUserId !== scope.userId || row.turnUserId !== scope.userId
    || row.turnRootTaskId !== scope.rootTaskId || row.correlationId !== scope.turnId || row.type !== "item.delta"
    || row.outboxTopic !== "agent.session.event" || row.outboxAggregateId !== scope.sessionId
    || row.outboxIdempotencyKey !== `agent-event:${row.id}`) invalid()
  const expectedOutbox = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId,
    taskId: row.taskId, sequence: String(row.sequence), type: row.type, actor: row.actor,
    correlationId: row.correlationId, causationId: row.causationId, idempotencyKey: row.idempotencyKey, payload: row.payload }
  if (canonicalTaskGraphJson(row.outboxPayload) !== canonicalTaskGraphJson(expectedOutbox)) invalid()
  if (payload.kind === "lifecycle") {
    const event = parseTaskGraphEvent(payload.event), node = event && snapshot.nodes.find(value => value.key === event.nodeKey)
    if (!event || !node || row.actor !== "system" || row.taskId !== node.taskId || row.causationId !== null
      || payload.revision !== expectedRevision || event.expectedRevision !== expectedRevision - 1
      || event.idempotencyKey !== row.idempotencyKey || !validTaskGraphReplacementLifecycleKey(row.idempotencyKey, scope.rootTaskId, event.nodeKey, event.type)) invalid()
  } else if (payload.kind === "proposal") {
    const allowed = ["kind", "fingerprint", "receipt", "revision", "item", "content"]
    if (Object.hasOwn(payload, "operationKey")) allowed.push("operationKey")
    if (Object.hasOwn(payload, "observedRevision")) allowed.push("observedRevision")
    if (!exactRow(payload, allowed) || row.taskId !== scope.rootTaskId || row.actor !== "orchestrator" || row.causationId !== itemStepId
      || typeof itemStepId !== "string" || !/^[0-9a-f]{64}$/.test(String(payload.fingerprint))
      || row.idempotencyKey !== taskGraphProposalKey(scope.rootTaskId, expectedRevision - 1)
      || !parseTaskGraphReplacementScheduleReceipt(payload.receipt)
      || canonicalTaskGraphJson(payload.content) !== canonicalTaskGraphJson(item.content)) invalid()
  } else if (payload.kind === "native_command") {
    const receipt = parsePersistedTaskGraphNativeReceipt(payload, { type: row.type, itemId: row.itemId, taskId: row.taskId,
      idempotencyKey: row.idempotencyKey }, { id: taskGraphItemId(scope.rootTaskId), revision: expectedRevision }, snapshot,
      { sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId })
    if (row.actor !== "orchestrator" || typeof itemStepId !== "string" || row.causationId !== itemStepId
      || receipt.graphRevision !== expectedRevision || canonicalTaskGraphJson(payload.content) !== canonicalTaskGraphJson(item.content)) invalid()
  } else invalid()
  return { snapshot, sequence: seq, id: String(row.id), itemStepId }
}

export function validTaskGraphReplacementLifecycleKey(key: unknown, rootTaskId: string, nodeKey: string, type: string): boolean {
  const hash = createHash("sha256").update(nodeKey).digest("hex").slice(0, 20), prefix = `${taskGraphItemId(rootTaskId)}:node:${hash}:`
  if (typeof key !== "string" || !key.startsWith(prefix)) return false
  const match = /^(0|[1-9][0-9]*):(task\.[a-z_]+)$/.exec(key.slice(prefix.length))
  return Boolean(match && match[2] === type && Number.isSafeInteger(Number(match[1]))
    && taskGraphLifecycleKey(rootTaskId, nodeKey, Number(match[1]), type) === key)
}

export function parseTaskGraphReplacementSnapshot(value: unknown): TaskGraphSnapshot | null { try { return parseTaskGraphSnapshot(value) } catch { return null } }
export function parseTaskGraphReplacementScheduleReceipt(value: unknown): TaskGraphScheduleReceipt | null {
  const row = object(value)
  if (!row || !exactRow(row, ["status", "revision", "nodes", "readyTaskIds"]) || row.status !== "accepted"
    || !Number.isSafeInteger(row.revision) || !Array.isArray(row.nodes) || !Array.isArray(row.readyTaskIds)) return null
  const nodes = row.nodes.map(object)
  if (nodes.some(node => !node || !exactRow(node, ["key", "taskId", "status"])
    || typeof node.key !== "string" || typeof node.taskId !== "string" || node.status !== "queued" && node.status !== "waiting")
    || nodes.some((node, index) => nodes.slice(0, index).some(previous => previous?.key === node?.key || previous?.taskId === node?.taskId))) return null
  const queued = new Set(nodes.filter((node): node is Row => node?.status === "queued").map(node => node.taskId as string))
  if (!row.readyTaskIds.every((id): id is string => typeof id === "string" && id.length > 0 && queued.has(id))
    || new Set(row.readyTaskIds).size !== row.readyTaskIds.length) return null
  return row as unknown as TaskGraphScheduleReceipt
}

export function taskGraphFailedBranchReplacementDeltaMatches(before: TaskGraphSnapshot, after: TaskGraphSnapshot,
  sources: readonly TaskGraphSnapshot["nodes"][number][], mapping: ReadonlyMap<string, string>, proposals: readonly unknown[],
  receipt: TaskGraphScheduleReceipt, revision: number): boolean {
  const removed = new Set(sources.map(node => node.key)), retained = before.nodes.filter(node => !removed.has(node.key))
  const inserted = after.nodes.filter(node => !before.nodes.some(old => old.key === node.key)), oldTaskIds = new Set(before.nodes.map(node => node.taskId))
  if (receipt.revision !== revision || after.nodes.length !== retained.length + sources.length || inserted.length !== sources.length
    || receipt.nodes.length !== sources.length || canonicalTaskGraphJson(before.rootSuccessCriteria ?? null) !== canonicalTaskGraphJson(after.rootSuccessCriteria ?? null)
    || retained.some(node => canonicalTaskGraphJson(node) !== canonicalTaskGraphJson(after.nodes.find(next => next.key === node.key)))) return false
  return sources.every(source => {
    const key = mapping.get(source.key), node = key && after.nodes.find(value => value.key === key)
    const proposal = proposals.find(value => object(value)?.key === key), receiptNode = receipt.nodes.find(value => value.key === key)
    const proposalRow = object(proposal)
    if (!node || !proposal || !receiptNode || node.taskId === source.taskId || oldTaskIds.has(node.taskId) || node.verificationDisposition !== "typed"
      || !proposalRow || !exactRow(receiptNode as unknown as Row, ["key", "taskId", "status"])
      || receiptNode.taskId !== node.taskId || receiptNode.status !== "queued" && receiptNode.status !== "waiting") return false
    const { depth: _depth, taskId: _taskId, verificationDisposition: _disposition, registeredScoutEnvelope: _envelope, ...stored } = node
    const envelope = { ...source, key: node.key, taskId: node.taskId, goal: proposalRow.goal,
      successCriteria: proposalRow.successCriteria, dependsOn: proposalRow.dependsOn, verification: proposalRow.verification }
    return canonicalTaskGraphJson(stored) === canonicalTaskGraphJson(proposal)
      && node.depth === source.depth && canonicalTaskGraphJson(envelope) === canonicalTaskGraphJson(node)
  })
}
