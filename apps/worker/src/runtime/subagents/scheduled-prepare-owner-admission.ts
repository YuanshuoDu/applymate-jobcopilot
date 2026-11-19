import { createHash } from "node:crypto"
import type pg from "pg"
import type { AgentArtifactTaskFence } from "../../db/agent-artifact-repo.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { ScheduledPrepareOwner } from "../tools/scheduled-application-prepare.js"
import type { SubagentLease } from "./types.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { scheduledSnapshotMatches } from "./scheduled-taskgraph-continuation-receipt.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type OwnerLineage = Pick<ScheduledPrepareOwner, "userId" | "sessionId" | "turnId" | "rootTaskId" | "rootAttemptCount">
type ParentWait = Readonly<{ targetTaskIds: readonly string[] }>
const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])
export type ScheduledPrepareOwnerAdmission = Readonly<{
  state: "live" | "dependency_wait"
  lineage: OwnerLineage
  turnLeaseOwnerId: string | null
  turnLeaseVersion: number
  taskFence: AgentArtifactTaskFence
  turn: Row
  dependencyWait?: ParentWait
}>

const OWNER_SQL = `SELECT task."role", task."taskType", task."status" AS "taskStatus", task."leaseOwner" AS "taskLeaseOwner",
  task."leaseExpiresAt" AS "taskLeaseExpiresAt", task."attemptCount" AS "taskAttemptCount", task."interruptRequestedAt",
  turn."id" AS "turnId", turn."source", turn."executionMode", turn."input", turn."status" AS "turnStatus",
  turn."leaseOwnerId", turn."leaseVersion", turn."leaseExpiresAt", turn."leaseStartedAt", turn."rootTaskId" AS "turnRootTaskId",
  root."status" AS "rootStatus", root."attemptCount" AS "rootAttemptCount", root."leaseOwner" AS "rootLeaseOwner",
  root."leaseExpiresAt" AS "rootLeaseExpiresAt", root."interruptRequestedAt" AS "rootInterruptRequestedAt",
  root."completedAt" AS "rootCompletedAt", root."closedAt" AS "rootClosedAt", root."nextAttemptAt" AS "rootNextAttemptAt",
  session."userId" AS "userId", session."status" AS "sessionStatus"
  FROM "sub_agent_tasks" task JOIN "agent_turns" turn ON turn."id"=task."turnId" AND turn."sessionId"=task."sessionId"
  JOIN "sub_agent_tasks" root ON root."id"=task."rootTaskId" AND root."sessionId"=task."sessionId" AND root."turnId"=task."turnId"
  JOIN "agent_sessions" session ON session."id"=task."sessionId"
  WHERE task."id"=$1 AND task."sessionId"=$2 AND task."turnId"=$3 AND task."rootTaskId"=$4
    AND task."parentTaskId"=$4 AND turn."userId"=$5 AND session."userId"=$5`

export async function readScheduledPrepareOwnerAdmission(
  client: Queryable, lease: SubagentLease, owner: ExecutionOwnerFence, now = new Date(),
): Promise<ScheduledPrepareOwnerAdmission> {
  if (owner.kind !== "task" || lease.role !== "prepare" || lease.taskType !== "scheduled_application_prepare"
    || lease.turnId === null || lease.id !== owner.taskId
    || lease.userId !== owner.userId || lease.sessionId !== owner.sessionId || lease.turnId !== owner.turnId
    || lease.rootTaskId !== owner.rootTaskId || lease.ownerId !== owner.ownerId || lease.attemptCount !== owner.attemptCount
    || lease.leaseOwner !== lease.ownerId || lease.parentTaskId !== lease.rootTaskId) throw stale()
  const result = await client.query<Row>(OWNER_SQL, [lease.id, lease.sessionId, lease.turnId, lease.rootTaskId, lease.userId])
  const row = object(result.rows[0]), timestamp = now.getTime()
  const scheduledSnapshot = parseScheduledAutomationSnapshot(object(row?.input)?.scheduledAutomationSnapshot)
  if (result.rows.length !== 1 || !row || row.userId !== lease.userId || row.sessionStatus !== "running"
    || row.role !== "prepare" || row.taskType !== "scheduled_application_prepare" || row.taskStatus !== "running"
    || row.taskLeaseOwner !== lease.ownerId || Number(row.taskAttemptCount) !== lease.attemptCount
    || row.interruptRequestedAt !== null || !future(row.taskLeaseExpiresAt, timestamp)
    || row.turnId !== lease.turnId || row.turnRootTaskId !== lease.rootTaskId || !scheduledSnapshot
    || !scheduledSnapshotMatches({ id: row.turnId, userId: row.userId, sessionId: lease.sessionId,
      source: row.source, executionMode: row.executionMode, input: row.input }, snapshotDigest(row.input))
    || !Number.isSafeInteger(Number(row.leaseVersion)) || Number(row.leaseVersion) < 1
    || !Number.isSafeInteger(Number(row.rootAttemptCount)) || Number(row.rootAttemptCount) < 1
    || row.rootInterruptRequestedAt !== null || row.rootCompletedAt !== null || row.rootClosedAt !== null || row.rootNextAttemptAt !== null) throw stale()
  const lineage: OwnerLineage = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    rootTaskId: lease.rootTaskId, rootAttemptCount: Number(row.rootAttemptCount) }
  const taskFence: AgentArtifactTaskFence = { taskId: lease.id, userId: lease.userId, sessionId: lease.sessionId,
    turnId: lease.turnId, rootTaskId: lease.rootTaskId, parentTaskId: lease.parentTaskId,
    leaseOwner: lease.ownerId, attemptCount: lease.attemptCount }
  const turn = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: lease.rootTaskId,
    source: row.source, executionMode: row.executionMode, input: row.input, status: row.turnStatus,
    leaseOwnerId: row.leaseOwnerId, leaseVersion: Number(row.leaseVersion), leaseExpiresAt: row.leaseExpiresAt as Date | string }
  const turnLeaseOwnerId = text(row.leaseOwnerId) ? row.leaseOwnerId : null
  const live = row.turnStatus === "in_progress" && turnLeaseOwnerId !== null && future(row.leaseExpiresAt, timestamp)
    && row.rootStatus === "running" && row.rootLeaseOwner === turnLeaseOwnerId
  if (live && turnLeaseOwnerId) return { state: "live", lineage, turnLeaseOwnerId, turnLeaseVersion: Number(row.leaseVersion), taskFence, turn }
  const waiting = row.turnStatus === "waiting_for_dependency" && cleared(row.leaseOwnerId) && cleared(row.leaseExpiresAt)
    && cleared(row.leaseStartedAt) && row.rootStatus === "waiting" && cleared(row.rootLeaseOwner)
    && cleared(row.rootLeaseExpiresAt)
  if (!waiting) throw stale()
  const dependencyWait = await readParentWait(client, lease, Number(row.rootAttemptCount))
  return { state: "dependency_wait", lineage, turnLeaseOwnerId: null, turnLeaseVersion: Number(row.leaseVersion),
    taskFence, turn, dependencyWait }
}

export function scheduledPrepareTurnOwnerFromAdmission(
  admission: ScheduledPrepareOwnerAdmission, receiptOwner: ScheduledPrepareOwner,
): ScheduledPrepareOwner {
  if (!sameLineage(admission.lineage, receiptOwner)) throw stale()
  const turnLeaseOwnerId = admission.state === "dependency_wait" ? receiptOwner.turnLeaseOwnerId : admission.turnLeaseOwnerId
  const turnLeaseVersion = admission.state === "dependency_wait" ? receiptOwner.turnLeaseVersion : admission.turnLeaseVersion
  if (!text(turnLeaseOwnerId) || !Number.isSafeInteger(turnLeaseVersion)
    || admission.state === "dependency_wait" && turnLeaseVersion !== admission.turnLeaseVersion) throw stale()
  return { ...admission.lineage, turnLeaseOwnerId, turnLeaseVersion, executionId: "", executionAttemptCount: 0 }
}

export function scheduledPrepareDependencyWaitMatchesGraph(
  admission: ScheduledPrepareOwnerAdmission, snapshot: TaskGraphSnapshot,
  currentNodes: readonly Readonly<{ key: string; taskId: string; status: string }>[], prepareTaskId: string,
): boolean {
  if (admission.state !== "dependency_wait") return true
  const targets = admission.dependencyWait?.targetTaskIds
  if (!targets || currentNodes.length !== snapshot.nodes.length) return false
  const current = new Map(currentNodes.map(node => [node.key, node] as const))
  if (current.size !== currentNodes.length || snapshot.nodes.some(node => current.get(node.key)?.taskId !== node.taskId)) return false
  const pendingIds = snapshot.nodes.filter(node => !TERMINAL_TASK_STATUSES.has(current.get(node.key)!.status)).map(node => node.taskId)
  return targets.includes(prepareTaskId) && sameIds(targets, pendingIds)
}

async function readParentWait(client: Queryable, lease: SubagentLease, rootAttemptCount: number): Promise<ParentWait> {
  const rows = await client.query<Row>(`SELECT wait."targetTaskIds", wait."mode", wait."status", wait."suspendedAt", wait."consumedAt", wait."result",
    step."taskId" AS "stepTaskId", step."status" AS "stepStatus", step."attempt", step."ordinal",
    (SELECT MAX(current."ordinal") FROM "agent_steps" current WHERE current."sessionId"=step."sessionId"
      AND current."turnId"=step."turnId" AND current."taskId"=step."taskId" AND current."attempt"=step."attempt") AS "latestOrdinal"
    FROM "agent_wait_conditions" wait JOIN "agent_steps" step ON step."id"=wait."stepId"
      AND step."sessionId"=wait."sessionId" AND step."turnId"=wait."turnId"
    WHERE wait."userId"=$1 AND wait."sessionId"=$2 AND wait."turnId"=$3 AND wait."parentTaskId"=$4
      AND wait."consumedAt" IS NULL AND EXISTS (SELECT 1 FROM "agent_sessions" session
        WHERE session."id"=wait."sessionId" AND session."userId"=$1 AND session."status"='running')
    ORDER BY wait."createdAt" DESC, wait."id" DESC LIMIT 2`, [lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId])
  if (rows.rows.length !== 1) throw stale()
  const row = object(rows.rows[0]), ids = parseIds(row?.targetTaskIds), result = object(row?.result), request = object(result?.request)
  const requestIds = parseIds(request?.targetTaskIds), timeoutMs = request?.timeoutMs
  if (!row || !ids || !request || !requestIds || row.status !== "waiting" || row.mode !== "all"
    || row.suspendedAt === null || row.suspendedAt === undefined || row.consumedAt !== null
    || row.stepTaskId !== null && row.stepTaskId !== lease.rootTaskId || row.stepStatus !== "waiting_for_tool"
    || !Number.isSafeInteger(Number(row.attempt)) || Number(row.attempt) !== rootAttemptCount || Number(row.ordinal) !== Number(row.latestOrdinal)
    || request.mode !== "all" || Object.keys(request).sort().join(",") !== "mode,targetTaskIds,timeoutMs"
    || !Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 86_400_000
    || !sameIds(ids, requestIds)) throw stale()
  return { targetTaskIds: ids }
}

function parseIds(value: unknown): readonly string[] | null {
  const parsed = typeof value === "string" ? parseJson(value) : value
  if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 11
    || parsed.some(id => !text(id)) || new Set(parsed).size !== parsed.length) return null
  return parsed as string[]
}
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return null } }
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? parseJson(value) : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function sameLineage(left: OwnerLineage, right: ScheduledPrepareOwner): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
}
function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && new Set(left).size === left.length && new Set(right).size === right.length
    && left.every(id => right.includes(id))
}
function future(value: unknown, now: number): boolean {
  const date = value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isFinite(date) && date > now
}
function snapshotDigest(value: unknown): string {
  const snapshot = parseScheduledAutomationSnapshot(object(object(value)?.scheduledAutomationSnapshot))
  if (!snapshot) return ""
  const projection = [snapshot.schemaVersion, snapshot.targetRoles, snapshot.targetLocations, snapshot.minScore,
    snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]
  return `sha256:${createHash("sha256").update(JSON.stringify(projection), "utf8").digest("hex")}`
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 }
function cleared(value: unknown): boolean { return value === null || value === undefined }
function stale(): Error { return new Error("scheduled_prepare_owner_stale") }
