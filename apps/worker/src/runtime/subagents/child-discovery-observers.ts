import { createChildDiscoveryAttemptCollector, type DiscoveryAttemptCollectorFence } from "./child-discovery-attempt.js"
import type { DiscoveryAttemptLifecycleEvent } from "../tools/lifecycle.js"
import type { JobDiscoveryExecutionFence } from "../tools/job-discover-tool.js"
import type { ToolExecutionContext } from "../tools/types.js"
import { turnEngineTenantTransaction, type TurnEnginePool } from "../turns/turn-engine-owner-sql.js"
import { createChildDiscoveryRecoveryCollector } from "./child-discovery-recovery.js"
import { parseTaskGraphSnapshot, taskGraphItemId } from "./task-graph-snapshot.js"
import type { Queryable } from "./pg-store-persistence.js"
import type { SubagentLease, SubagentTaskRecord } from "./types.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { DiscoveryAttemptSidecar } from "./child-discovery-attempt.js"
import type { DiscoveryQueryCapture } from "./child-discovery-query-footprint.js"
import type { DiscoveryRecoverySnapshot } from "./task-graph-discovery-recovery-contract.js"

const MAX_ATTEMPT_COUNT = 1_000_000
const MAX_GRAPH_REVISION = 2_147_483_646
const NONTERMINAL_TURN_STATUSES = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])

export function childDiscoveryExecutionFence(task: SubagentTaskRecord, lease: SubagentLease, selectedJob?: string, selectedJobPreparation?: unknown): JobDiscoveryExecutionFence | undefined {
  const actions = Array.isArray(task.allowedActions) ? task.allowedActions : []
  const eligible = task.role === "scout" && lease.role === "scout" && task.taskType === "job_discovery" && !selectedJob
    && !selectedJobPreparation && actions.includes("jobs.discover") && task.id === lease.id && task.userId === lease.userId
    && task.sessionId === lease.sessionId && task.turnId === lease.turnId && task.rootTaskId === lease.rootTaskId && lease.turnId !== null
    && typeof lease.leaseOwner === "string" && lease.leaseOwner.trim() === lease.ownerId && Number.isSafeInteger(lease.attemptCount) && lease.attemptCount >= 1
  return eligible ? { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId!, taskId: lease.id,
    rootTaskId: lease.rootTaskId, role: "scout", leaseOwner: lease.leaseOwner!, attemptCount: lease.attemptCount } : undefined
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || !keys.every((key): key is string => typeof key === "string")) return undefined
    return value as Record<string, unknown>
  } catch { return undefined }
}

function storedJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}

function exactRow(value: unknown, keys: readonly string[]): Record<string, unknown> | undefined {
  const row = plainRecord(value)
  if (!row) return undefined
  try {
    const ownKeys = Reflect.ownKeys(row)
    if (ownKeys.length !== keys.length || !ownKeys.every((key): key is string => typeof key === "string" && keys.includes(key))) return undefined
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(row, key)
      if (!descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return row
  } catch { return undefined }
}

function sameStrings(left: unknown, right: unknown): boolean {
  const parsedLeft = storedJson(left), parsedRight = storedJson(right)
  return Array.isArray(parsedLeft) && Array.isArray(parsedRight) && parsedLeft.length === parsedRight.length
    && parsedLeft.every((value, index) => typeof value === "string" && value === parsedRight[index])
}

function matchesScoutSchema(value: unknown): boolean {
  const row = exactRow(storedJson(value), ["role", "schemaVersion"])
  return row?.role === "scout" && row.schemaVersion === ROLE_RESULT_SCHEMA
}

function hasPrivateSelection(value: unknown): boolean {
  const context = plainRecord(storedJson(value))
  return !context || ["selectedJobPreparation", "coverLetterBase", "writerReviewFeedback"].some(key => Object.hasOwn(context, key))
}

function isOrdinaryRegisteredScout(snapshotValue: unknown, rowValue: unknown, lease: SubagentLease): boolean {
  const snapshot = parseTaskGraphSnapshot(snapshotValue)
  const row = exactRow(rowValue, ["allowedActions", "context", "expectedOutputSchema", "revision", "role", "taskType"])
  if (!row || !Number.isSafeInteger(Number(row.revision)) || Number(row.revision) < 1 || Number(row.revision) > MAX_GRAPH_REVISION
    || row.role !== lease.role || row.role !== "scout" || row.taskType !== lease.taskType || row.taskType !== "job_discovery"
    || hasPrivateSelection(row.context) || hasPrivateSelection(lease.context)
    || !matchesScoutSchema(row.expectedOutputSchema) || !matchesScoutSchema(lease.expectedOutputSchema)
    || !sameStrings(row.allowedActions, lease.allowedActions)) return false
  const matches = snapshot.nodes.filter(node => node.taskId === lease.id)
  if (matches.length !== 1) return false
  const node = matches[0]!, envelope = node.registeredScoutEnvelope
  return node.templateId === "scout" && node.verificationDisposition === "typed" && node.verification?.role === "scout"
    && !node.repairOf && !node.nativeDelegation && Boolean(envelope)
    && envelope!.role === row.role && envelope!.taskType === row.taskType
    && sameStrings(row.allowedActions, envelope!.allowedActions)
    && matchesScoutSchema(envelope!.expectedOutputSchema) && matchesScoutSchema(row.expectedOutputSchema)
    && envelope!.allowedActions.includes("jobs.discover")
}

/** One read-only, current-owner/Turn/lease-fenced lookup; failure disables recovery only. */
export async function readRegisteredOrdinaryScoutProvenance(client: Queryable, lease: SubagentLease): Promise<boolean> {
  const parentTaskId = lease.parentTaskId
  if (!lease.turnId || !parentTaskId || parentTaskId !== lease.rootTaskId || lease.status !== "running"
    || lease.role !== "scout" || lease.taskType !== "job_discovery" || lease.interruptRequestedAt !== null
    || !lease.ownerId.trim() || lease.leaseOwner !== lease.ownerId || !(lease.leaseExpiresAt instanceof Date)
    || lease.leaseExpiresAt.getTime() <= Date.now() || !Number.isSafeInteger(lease.attemptCount)
    || lease.attemptCount < 1 || lease.attemptCount > MAX_ATTEMPT_COUNT) return false
  const result = await client.query(`SELECT turn."status" AS "turnStatus", item."revision", item."content", task."role", task."taskType", task."allowedActions", task."expectedOutputSchema", task."context"
      FROM "agent_items" AS item
      JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
      JOIN "sub_agent_tasks" AS task ON task."id" = $5 AND task."sessionId" = item."sessionId"
      WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
        AND item."type" = 'task_graph' AND session."userId" = $7 AND session."status" NOT IN ('aborted', 'archived')
        AND turn."userId" = $7 AND turn."rootTaskId" = $6
        AND turn."status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
        AND task."turnId" = $3 AND task."rootTaskId" = $6 AND task."parentTaskId" = $4
        AND task."role" = 'scout' AND task."taskType" = 'job_discovery' AND task."status" = 'running'
        AND task."leaseOwner" = $8 AND task."attemptCount" = $9 AND task."interruptRequestedAt" IS NULL
        AND task."leaseExpiresAt" > clock_timestamp()
      LIMIT 2`, [taskGraphItemId(parentTaskId), lease.sessionId, lease.turnId, parentTaskId, lease.id,
      lease.rootTaskId, lease.userId, lease.ownerId, lease.attemptCount])
  try {
    if (result.rows.length !== 1) return false
    const row = exactRow(result.rows[0], ["allowedActions", "content", "context", "expectedOutputSchema", "revision", "role", "taskType", "turnStatus"])
    if (!row || typeof row.turnStatus !== "string" || !NONTERMINAL_TURN_STATUSES.has(row.turnStatus)) return false
    const { content, ...eligibilityRow } = row
    delete eligibilityRow.turnStatus
    return isOrdinaryRegisteredScout(content, eligibilityRow, lease)
  } catch { return false }
}

export function composeDiscoveryAttemptObservers(
  health: (event: DiscoveryAttemptLifecycleEvent) => void,
  recovery?: (event: DiscoveryAttemptLifecycleEvent) => void,
): (event: DiscoveryAttemptLifecycleEvent) => void {
  return event => {
    try { health(event) } catch { /* Health observation cannot change tool execution. */ }
    try { recovery?.(event) } catch { /* Recovery observation cannot suppress health or change tool execution. */ }
  }
}

export async function createChildDiscoveryObservers(pool: TurnEnginePool, lease: SubagentLease, fence: DiscoveryAttemptCollectorFence): Promise<{
  observeLifecycleEvent: (event: DiscoveryAttemptLifecycleEvent) => void
  observeEffectiveCriteria: (context: ToolExecutionContext, capture: DiscoveryQueryCapture) => void
  discoveryAttemptSidecar: () => DiscoveryAttemptSidecar | undefined
  discoveryRecoverySidecar: () => DiscoveryRecoverySnapshot | undefined
}> {
  const health = createChildDiscoveryAttemptCollector(fence)
  let recovery: ReturnType<typeof createChildDiscoveryRecoveryCollector> | undefined
  try {
    const eligible = await turnEngineTenantTransaction(pool, lease.userId, client => readRegisteredOrdinaryScoutProvenance(client, lease))
    if (eligible) recovery = createChildDiscoveryRecoveryCollector(fence)
  } catch { /* Provenance failure disables recovery only. */ }
  const observeLifecycleEvent = composeDiscoveryAttemptObservers(health.observeLifecycleEvent, recovery?.observeLifecycleEvent)
  return {
    observeLifecycleEvent,
    observeEffectiveCriteria: health.observeEffectiveCriteria,
    discoveryAttemptSidecar: health.sidecar,
    discoveryRecoverySidecar: () => recovery?.recovery(),
  }
}
