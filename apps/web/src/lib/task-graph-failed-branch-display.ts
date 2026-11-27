import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"

import { parseTaskGraphSnapshot } from "@jobcopilot/agent-protocol"
import { parseTaskGraphFailedBranchReconciliationReceipt, TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION }
  from "@jobcopilot/agent-protocol/task-graph-failed-branch-reconciliation"
import { db } from "@/lib/db"

const EVENT_TYPE = "agent.plan.reconciliation"
const codecs = {
  sha256: (value: string) => createHash("sha256").update(value, "utf8").digest("hex"),
  utf8ByteLength: (value: string) => Buffer.byteLength(value, "utf8"),
}

type Row = Record<string, unknown>
type DisplayScope = Readonly<{ userId: string; sessionId: string; turnId: string; rootTaskId: string; revision: number }>
type PersistedEvent = Readonly<{ id: string; sessionId: string; turnId: string; itemId: null; taskId: string; sequence: bigint;
  type: string; actor: string; correlationId: string; causationId: string; idempotencyKey: string; payload: unknown }>
export type FailedBranchReplacementDisplay = Readonly<{
  reason: "previous_branch_unverified"
  successorNodeIndexes: readonly number[]
}>

function record(value: unknown): Row | null {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value), descriptors = Object.getOwnPropertyDescriptors(value)
    return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every(key => typeof key === "string"
      && descriptors[key]?.enumerable && "value" in descriptors[key]!) ? value as Row : null
  } catch { return null }
}

function boundedText(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function validEvent(value: unknown, scope: DisplayScope): PersistedEvent | null {
  const row = record(value)
  const keys = ["id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload"]
  if (!row || Reflect.ownKeys(row).length !== keys.length || Reflect.ownKeys(row).some(key => typeof key !== "string" || !keys.includes(key))
    || !boundedText(row.id) || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId || row.itemId !== null
    || row.taskId !== scope.rootTaskId || row.type !== EVENT_TYPE || row.actor !== "orchestrator"
    || row.correlationId !== scope.turnId || !boundedText(row.causationId) || !boundedText(row.idempotencyKey)
    || typeof row.sequence !== "bigint" || row.sequence < BigInt(1)) return null
  return row as PersistedEvent
}

function validScope(scope: DisplayScope): boolean {
  return boundedText(scope.userId) && boundedText(scope.sessionId) && boundedText(scope.turnId) && boundedText(scope.rootTaskId)
    && Number.isSafeInteger(scope.revision) && scope.revision >= 1
}

function project(events: readonly unknown[], scope: DisplayScope, graph: unknown): FailedBranchReplacementDisplay | null {
  try {
    if (!validScope(scope) || events.length !== 1) return null
    const event = validEvent(events[0], scope)
    if (!event) return null
    const receipt = parseTaskGraphFailedBranchReconciliationReceipt(event.payload, codecs, {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    })
    const relation = receipt?.failedBranch
    if (!receipt || !relation || receipt.decision !== "revise" || receipt.resultingRevision !== scope.revision
      || relation.graphRootTaskId !== scope.rootTaskId || relation.resultingRevision !== scope.revision
      || receipt.stepId !== event.causationId || relation.operationKey !== event.idempotencyKey
      || event.sequence <= BigInt(relation.planEvent.sequence)) return null

    const relatedEventIds = new Set([
      relation.failedSource.event.id,
      ...relation.cancellations.map(item => item.event.id),
      ...relation.verifiedExternalDependencies.map(item => item.completedEvent.id),
      relation.planEvent.id,
    ])
    if (relatedEventIds.has(event.id)) return null
    const snapshot = parseTaskGraphSnapshot(graph)
    if (!snapshot || snapshot.nodes.length < 1) return null
    const sourceKeys = new Set(relation.sources.map(source => source.source.nodeKey))
    const sourceTaskIds = new Set(relation.sources.map(source => source.source.taskId))
    if (sourceKeys.size !== relation.sources.length || sourceTaskIds.size !== relation.sources.length
      || snapshot.nodes.some(node => sourceKeys.has(node.key) || sourceTaskIds.has(node.taskId))) return null

    const positions = new Map(snapshot.nodes.map((node, index) => [node.key, index] as const))
    const successorIndexes: number[] = []
    for (const binding of relation.sources) {
      const successor = positions.get(binding.replacementKey)
      if (successor === undefined) return null
      successorIndexes.push(successor)
    }
    successorIndexes.sort((left, right) => left - right)
    if (new Set(successorIndexes).size !== successorIndexes.length) return null
    return { reason: "previous_branch_unverified", successorNodeIndexes: successorIndexes }
  } catch {
    return null
  }
}

/** Reads and projects fixed display data only for the exact current graph revision. */
export async function readFailedBranchReplacementDisplay(input: Readonly<{
  scope: DisplayScope
  graph: unknown
}>): Promise<FailedBranchReplacementDisplay | null> {
  try {
    if (!validScope(input.scope) || !parseTaskGraphSnapshot(input.graph)) return null
    const { scope } = input
    const events = await db.agentEvent.findMany({
      where: {
        sessionId: scope.sessionId, turnId: scope.turnId, itemId: null, taskId: scope.rootTaskId,
        type: EVENT_TYPE, actor: "orchestrator", correlationId: scope.turnId,
        AND: [
          { payload: { path: ["schemaVersion"], equals: TASK_GRAPH_FAILED_BRANCH_RECONCILIATION_SCHEMA_VERSION } },
          { payload: { path: ["resultingRevision"], equals: scope.revision } },
        ],
      },
      select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, sequence: true,
        type: true, actor: true, correlationId: true, causationId: true, idempotencyKey: true, payload: true },
      take: 2,
    })
    return project(events, scope, input.graph)
  } catch {
    return null
  }
}
