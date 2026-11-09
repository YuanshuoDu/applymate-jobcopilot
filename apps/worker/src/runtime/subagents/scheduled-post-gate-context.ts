import type pg from "pg"
import { scheduledSnapshotMatches } from "./scheduled-taskgraph-continuation-receipt.js"
import { buildScheduledPipelineGraphAttestation } from "./scheduled-pipeline-current-attestation.js"
import type { ScheduledAutomationPipelineAttestation, ScheduledAutomationPipelineBridgeScope } from "./scheduled-automation-pipeline-bridge.js"
import { scheduledAuditGateCheckpointEvidence } from "./scheduled-audit-invocation.js"
import { parseScheduledAutomationSnapshot } from "./scheduled-automation-snapshot.js"
import { verifyCompletedTaskGraphNodeEvidence } from "./task-graph-pg-verification.js"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope, type GraphTaskRow } from "./task-graph-pg-state.js"
import { readScheduledPostGateReceipt, validateScheduledPostGateHandoff } from "./scheduled-post-gate-handoff.js"
import { SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE,
  SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE,
  type ScheduledPostGateHandoff } from "./scheduled-post-gate-contract.js"
import type { ScheduledGateCheckpointEvidence } from "./scheduled-gate-contract.js"
import type { SubagentLease } from "./types.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
export type ScheduledPostGateChildContext = Readonly<{
  owner: ScheduledPostGateHandoff["owner"]
  attestation: ScheduledAutomationPipelineAttestation
  handoff: ScheduledPostGateHandoff
  actor: Readonly<{ taskId: string; attemptCount: number; leaseOwner: string }>
}> & (Readonly<{ kind: "execute"; packageRefs: readonly string[] }> | Readonly<{ kind: "audit" }>)

/** Reconstructs current server-owned Gate/TaskGraph facts for exactly one live Post-Gate child lease. */
export async function readScheduledPostGateChildContext(client: Queryable, lease: SubagentLease,
  now = new Date()): Promise<ScheduledPostGateChildContext | null> {
  if (!lease.turnId || lease.parentTaskId !== lease.rootTaskId || !validId(lease.ownerId)
    || !Number.isSafeInteger(lease.attemptCount) || lease.attemptCount < 1) return null
  await client.query("SELECT set_config('app.user_id', $1, true)", [lease.userId])
  const live = await readLiveChild(client, lease, now)
  if (!live || live.turnSource !== "automation" || live.executionMode !== "canonical_task_graph"
    || !active(live.turnStatus) || !active(live.rootStatus) || live.rootTaskType !== "root"
    || live.turnRootTaskId !== lease.rootTaskId
    || live.userId !== lease.userId || live.sessionStatus === "aborted" || live.sessionStatus === "archived"
    || !["running", "paused", "completed"].includes(String(live.executionStatus))) return null
  const turnInput = record(live.turnInput), snapshot = parseScheduledAutomationSnapshot(turnInput?.scheduledAutomationSnapshot)
  if (!turnInput || !snapshot) return null
  const identity = { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    rootTaskId: lease.rootTaskId, parentTaskId: lease.rootTaskId }
  const handoff = await readScheduledPostGateReceipt(client, identity)
  if (!handoff || handoff.owner.rootAttemptCount !== live.rootAttemptCount
    || handoff.owner.executionId !== live.executionId || handoff.owner.executionAttemptCount !== live.executionAttemptCount) return null
  const checkpoint = scheduledAuditGateCheckpointEvidence(live.executionState, live.executionStatus)
  if (!checkpoint || !sameCheckpointOwner(checkpoint.owner, handoff.owner) || checkpoint.continuationKey !== handoff.continuationKey
    || checkpoint.snapshotDigest !== handoff.snapshotDigest || checkpoint.checkpointDigest !== handoff.gateProof.prepareProof.receipt.checkpointDigest
    || checkpoint.evidenceDigest !== handoff.gateProof.prepareProof.receipt.evidenceDigest
    || checkpoint.analyzeGraphRevision !== handoff.gateProof.prepareProof.receipt.analyzeGraphRevision
    || !scheduledSnapshotMatches({ source: live.turnSource, executionMode: live.executionMode, input: live.turnInput }, handoff.snapshotDigest)) return null

  const scope = readScopeFromHandoff(handoff, live.rootLeaseOwner)
  const loaded = await loadTaskGraph(client, identity as GraphIdentityScope, false)
  if (!loaded.snapshot || !loaded.state || !loaded.item
    || !await validateScheduledPostGateHandoff(client, scope, loaded, handoff)) return null
  const prefix = gateEvidencePrefix(loaded.snapshot, currentTaskGraph(loaded), loaded.tasks, handoff.gateTaskId)
  if (!prefix) return null
  const built = await buildScheduledPipelineGraphAttestation({ scope: pipelineOwner(handoff.owner),
    schedule: snapshot, snapshot: prefix.snapshot, current: prefix.current, tasks: prefix.tasks,
    verifyCompletedNode: input => verifyCompletedTaskGraphNodeEvidence(client, input) })
  if (built.status !== "ready" || built.attestation.snapshotDigest !== handoff.snapshotDigest
    || built.attestation.evidenceDigest !== handoff.gateProof.prepareProof.receipt.evidenceDigest
    || built.attestation.graphRevision !== handoff.gateProof.prepareProof.receipt.analyzeGraphRevision
    || !sameOwner(built.attestation.owner, handoff.owner)) return null
  const actor = { taskId: lease.id, attemptCount: lease.attemptCount, leaseOwner: lease.ownerId }
  if (lease.taskType === SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE && lease.role === SCHEDULED_POST_GATE_EXECUTE_ROLE) {
    const node = handoff.executeNodes.find(value => value.taskId === lease.id)
    return node ? { kind: "execute", owner: handoff.owner, attestation: built.attestation, handoff,
      actor, packageRefs: node.packageRefs } : null
  }
  if (lease.taskType === SCHEDULED_POST_GATE_AUDIT_TASK_TYPE && lease.role === SCHEDULED_POST_GATE_AUDIT_ROLE
    && handoff.auditTaskId === lease.id) return { kind: "audit", owner: handoff.owner, attestation: built.attestation, handoff, actor }
  return null
}

function gateEvidencePrefix(snapshot: TaskGraphSnapshot, current: ReturnType<typeof currentTaskGraph>,
  tasks: ReadonlyMap<string, GraphTaskRow>, gateTaskId: string) {
  const gateIndexes = snapshot.nodes.flatMap((node, index) => node.key === "gate" && node.templateId === "gate" ? [index] : [])
  if (gateIndexes.length !== 1 || current.nodes.length !== snapshot.nodes.length) return null
  const count = gateIndexes[0]! + 1, nodes = snapshot.nodes.slice(0, count), currentNodes = current.nodes.slice(0, count)
  if (nodes[count - 1]?.taskId !== gateTaskId || nodes.some((node, index) => currentNodes[index]?.key !== node.key
    || currentNodes[index]?.taskId !== node.taskId)) return null
  const prefixTasks = new Map(nodes.flatMap(node => {
    const task = tasks.get(node.taskId)
    return task ? [[node.taskId, task] as const] : []
  }))
  if (prefixTasks.size !== count) return null
  return { snapshot: { ...snapshot, nodes }, current: { ...current, nodes: currentNodes }, tasks: prefixTasks }
}

async function readLiveChild(client: Queryable, lease: SubagentLease, now: Date): Promise<Row | null> {
  const result = await client.query<Row>(`SELECT child."id", child."userId", child."sessionId", child."turnId", child."rootTaskId",
      child."parentTaskId", child."role", child."taskType", child."status", child."attemptCount", child."leaseOwner",
      child."leaseExpiresAt", child."interruptRequestedAt", root."attemptCount" AS "rootAttemptCount",
      root."taskType" AS "rootTaskType", root."status" AS "rootStatus", root."leaseOwner" AS "rootLeaseOwner",
      turn."source" AS "turnSource", turn."executionMode", turn."input" AS "turnInput", turn."status" AS "turnStatus",
      turn."rootTaskId" AS "turnRootTaskId", session."userId" AS "userId", session."status" AS "sessionStatus",
      execution."id" AS "executionId", execution."attemptCount" AS "executionAttemptCount",
      execution."status" AS "executionStatus", execution."state" AS "executionState"
    FROM "sub_agent_tasks" AS child JOIN "sub_agent_tasks" AS root ON root."id" = child."rootTaskId" AND root."sessionId" = child."sessionId"
    JOIN "agent_sessions" AS session ON session."id" = child."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = child."turnId" AND turn."sessionId" = child."sessionId"
    JOIN "agent_executions" AS execution ON execution."sessionId" = turn."sessionId" AND execution."userId" = session."userId"
    WHERE child."id" = $1 AND child."userId" = $2 AND child."sessionId" = $3 AND child."turnId" = $4
      AND child."rootTaskId" = $5 AND child."parentTaskId" = $5 AND child."status" = 'running'
      AND child."leaseOwner" = $6 AND child."attemptCount" = $7 AND child."leaseExpiresAt" > $8
      AND child."interruptRequestedAt" IS NULL AND turn."userId" = $2 AND session."status" NOT IN ('aborted','archived')
      AND turn."status" NOT IN ('completed','failed','interrupted','cancelled','closed')
      AND turn."source" = 'automation' AND turn."executionMode" = 'canonical_task_graph'
      AND execution."status" IN ('running','paused','completed')
      AND turn."rootTaskId" = $5`, [lease.id, lease.userId, lease.sessionId, lease.turnId, lease.rootTaskId,
    lease.ownerId, lease.attemptCount, now])
  const row = result.rows.length === 1 ? result.rows[0] : null
  if (!row || !sameLease(row, lease, now) || !Number.isSafeInteger(row.rootAttemptCount)
    || !Number.isSafeInteger(row.executionAttemptCount)) return null
  return row
}

function readScopeFromHandoff(handoff: ScheduledPostGateHandoff, parentLeaseOwner: unknown): TaskGraphReadScope {
  return { userId: handoff.owner.userId, sessionId: handoff.owner.sessionId, turnId: handoff.owner.turnId,
    rootTaskId: handoff.owner.rootTaskId, parentTaskId: handoff.owner.rootTaskId, parentAttemptCount: handoff.owner.rootAttemptCount,
    turnLeaseOwner: handoff.owner.turnLeaseOwnerId, turnLeaseVersion: handoff.owner.turnLeaseVersion,
    parentLeaseOwner: validId(parentLeaseOwner) ? parentLeaseOwner : handoff.owner.turnLeaseOwnerId }
}
function pipelineOwner(owner: ScheduledPostGateHandoff["owner"]): ScheduledAutomationPipelineBridgeScope {
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
    rootAttemptCount: owner.rootAttemptCount, turnLeaseOwnerId: owner.turnLeaseOwnerId, turnLeaseVersion: owner.turnLeaseVersion }
}
function sameOwner(left: ScheduledAutomationPipelineBridgeScope, right: ScheduledPostGateHandoff["owner"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
    && left.turnLeaseOwnerId === right.turnLeaseOwnerId && left.turnLeaseVersion === right.turnLeaseVersion
}
function sameCheckpointOwner(left: ScheduledGateCheckpointEvidence["owner"], right: ScheduledPostGateHandoff["owner"]): boolean {
  return left.userId === right.userId && left.sessionId === right.sessionId && left.turnId === right.turnId
    && left.rootTaskId === right.rootTaskId && left.rootAttemptCount === right.rootAttemptCount
    && left.executionId === right.executionId && left.executionAttemptCount === right.executionAttemptCount
}
function sameLease(row: Row, lease: SubagentLease, now: Date): boolean {
  const expiry = row.leaseExpiresAt instanceof Date ? row.leaseExpiresAt : new Date(String(row.leaseExpiresAt))
  return row.id === lease.id && row.userId === lease.userId && row.sessionId === lease.sessionId && row.turnId === lease.turnId
    && row.rootTaskId === lease.rootTaskId && row.parentTaskId === lease.parentTaskId && row.status === "running"
    && row.role === lease.role && row.taskType === lease.taskType && row.leaseOwner === lease.ownerId
    && Number(row.attemptCount) === lease.attemptCount && row.interruptRequestedAt == null
    && expiry.getTime() > now.getTime() && lease.leaseExpiresAt.getTime() > now.getTime()
}
function active(value: unknown): boolean {
  return ["queued", "running", "retrying", "waiting", "waiting_for_user", "waiting_for_tool", "waiting_for_dependency", "in_progress"].includes(String(value))
}
function record(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
