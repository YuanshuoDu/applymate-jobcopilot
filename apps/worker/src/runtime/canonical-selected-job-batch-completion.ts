import type { PoolClient } from "pg"
import { parseSelectedJobBatchGraph } from "@jobcopilot/agent-protocol"

import { findCurrentDraftHeadWithClient, findReviewReceiptWithClient } from "../db/agent-artifact-repo.js"
import { readSelectedJobSourceDigestWithClient } from "./subagents/selected-job-artifact-context.js"
import {
  verifySelectedJobBatchCompletion,
  type SelectedJobBatchCompletionResult,
  type SelectedJobBatchCompletionWitness,
  type SelectedJobBatchTaskContext,
} from "./multi-selected-job-completion-gate.js"
import type { SelectedJobBatchArtifactVersion } from "./multi-selected-job-correction-evidence.js"
import { loadVerifiedShortlistBatchResources } from "./verified-shortlist-batch-resources.js"
import { pairSelectedJobBatchPlan, type SelectedJobBatchPair, type SelectedJobBatchSlot } from "./subagents/selected-job-batch-plan.js"
import type { TaskGraphCommandPort, TaskGraphCurrentState, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { SubagentTaskRecord } from "./subagents/types.js"
import type { TurnLease } from "./turns/lease.js"

type RootRow = Pick<SubagentTaskRecord, "id" | "attemptCount" | "sessionId" | "turnId" | "rootTaskId" | "parentTaskId" | "role" | "taskType" | "status" | "leaseOwner" | "interruptRequestedAt">
  & Readonly<{ sessionUserId: string; turnUserId: string }>
type ContextRow = Readonly<{
  taskId: string; taskSessionId: string; taskTurnId: string; taskRootTaskId: string; taskParentTaskId: string | null
  taskRole: string; context: unknown; sessionUserId: string; turnUserId: string; turnRootTaskId: string
}>
const SHA256 = /^sha256:[a-f0-9]{64}$/

export type CanonicalSelectedJobBatchCompletionInput = Readonly<{
  client: PoolClient
  lease: TurnLease
  rootTaskId: string
  binding: unknown
  commandPort: Pick<TaskGraphCommandPort, "readCurrentWithClient"> | undefined
  acceptedWitness?: SelectedJobBatchCompletionWitness
}>

/** Revalidates every batch proof on one caller-owned terminal/candidate transaction. */
export async function verifyCanonicalSelectedJobBatchCompletion(
  input: CanonicalSelectedJobBatchCompletionInput,
): Promise<SelectedJobBatchCompletionResult> {
  let slots: readonly SelectedJobBatchSlot[] = [], pairs: readonly SelectedJobBatchPair[] = []
  try {
    const readGraph = input.commandPort?.readCurrentWithClient
    if (!input.client || !readGraph || !safeId(input.rootTaskId)) return blocked(slots)
    const verifiedSlots = await loadVerifiedShortlistBatchResources({
      client: input.client, lease: input.lease, expectedRootTaskId: input.rootTaskId, binding: input.binding,
    })
    if (!verifiedSlots) return blocked(slots)
    slots = verifiedSlots
    const root = await lockCurrentRoot(input.client, input.lease, input.rootTaskId)
    if (!root) return blocked(slots)
    const scope: TaskGraphReadScope = {
      userId: input.lease.userId, sessionId: input.lease.sessionId, turnId: input.lease.turnId,
      rootTaskId: input.rootTaskId, parentTaskId: input.rootTaskId,
      turnLeaseOwner: input.lease.ownerId, turnLeaseVersion: input.lease.leaseVersion,
      parentLeaseOwner: input.lease.ownerId, parentAttemptCount: root.attemptCount,
    }
    const graph = await readGraph(input.client, scope)
    const chains = parseSelectedJobBatchGraph(graph.nodes, slots.map(slot => slot.slotId))
    if (!chains) return blocked(slots)
    pairs = pairSelectedJobBatchPlan(chains.flatMap(chain => [chain.initial.writer, chain.initial.reviewer]), slots)
    const taskContexts = await readExactTaskContexts(input.client, input.lease, input.rootTaskId, graph, graph.nodes)
    if (!taskContexts) return blocked(pairs)
    return await verifySelectedJobBatchCompletion({
      graph, pairs, taskContexts, lease: input.lease, root,
      ...(input.acceptedWitness ? { expectedWitness: input.acceptedWitness } : {}),
      readCurrentDraftHead: scope => findCurrentDraftHeadWithClient(input.client, scope),
      readArtifactVersion: scope => readBatchArtifactVersion(input.client, scope),
      readCurrentSourceDigest: jobId => readSelectedJobSourceDigestWithClient(input.client, input.lease.userId, jobId),
      readCurrentReviewReceipt: scope => findReviewReceiptWithClient(input.client, scope),
    })
  } catch {
    return blocked(pairs.length ? pairs : slots)
  }
}

async function lockCurrentRoot(client: PoolClient, lease: TurnLease, rootTaskId: string): Promise<RootRow | null> {
  const result = await client.query<RootRow>(`SELECT root."id", root."sessionId", root."turnId", root."rootTaskId",
      root."parentTaskId", root."role", root."taskType", root."status", root."attemptCount", root."leaseOwner", root."interruptRequestedAt",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId"
    FROM "sub_agent_tasks" AS root
    JOIN "agent_sessions" AS session ON session."id" = root."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = root."turnId" AND turn."sessionId" = root."sessionId"
    WHERE root."id" = $1 AND root."sessionId" = $3 AND root."turnId" = $4
      AND root."rootTaskId" = $1 AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator' AND root."taskType" = 'root'
      AND root."status" = 'running' AND root."leaseOwner" = $5 AND root."interruptRequestedAt" IS NULL
      AND root."leaseExpiresAt" > clock_timestamp() AND session."id" = $3 AND session."userId" = $2
      AND turn."id" = $4 AND turn."userId" = $2 AND turn."rootTaskId" = $1
      AND turn."status" = 'in_progress' AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6
      AND turn."leaseExpiresAt" > clock_timestamp()
    FOR UPDATE OF root`, [rootTaskId, lease.userId, lease.sessionId, lease.turnId, lease.ownerId, lease.leaseVersion])
  const root = result.rows[0]
  return result.rows.length === 1 && root && root.id === rootTaskId && root.sessionUserId === lease.userId && root.turnUserId === lease.userId
    && root.sessionId === lease.sessionId && root.turnId === lease.turnId && root.rootTaskId === rootTaskId
    && root.parentTaskId === null && root.role === "orchestrator" && root.taskType === "root" && root.status === "running"
    && root.leaseOwner === lease.ownerId && root.interruptRequestedAt === null
    && Number.isSafeInteger(root.attemptCount) && root.attemptCount >= 1 ? root : null
}

async function readExactTaskContexts(
  client: PoolClient, lease: TurnLease, rootTaskId: string, graph: TaskGraphCurrentState, nodes: readonly TaskGraphCurrentState["nodes"][number][],
): Promise<readonly SelectedJobBatchTaskContext[] | null> {
  const taskIds = nodes.map(node => node.taskId)
  if (taskIds.length !== graph.nodes.length || taskIds.some(id => !safeId(id)) || new Set(taskIds).size !== taskIds.length) return null
  const result = await client.query<ContextRow>(`SELECT task."id" AS "taskId",
      task."sessionId" AS "taskSessionId", task."turnId" AS "taskTurnId", task."rootTaskId" AS "taskRootTaskId",
      task."parentTaskId" AS "taskParentTaskId", task."role" AS "taskRole", task."context",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId"
    FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $3 AND task."turnId" = $4
      AND task."rootTaskId" = $5 AND task."parentTaskId" = $5 AND session."userId" = $2
      AND turn."userId" = $2 AND turn."rootTaskId" = $5
    FOR KEY SHARE OF task`, [taskIds, lease.userId, lease.sessionId, lease.turnId, rootTaskId])
  if (result.rows.length !== taskIds.length) return null
  const rows = new Map<string, ContextRow>()
  for (const row of result.rows) {
    if (!row || !taskIds.includes(row.taskId) || rows.has(row.taskId)
      || row.taskSessionId !== lease.sessionId || row.taskTurnId !== lease.turnId || row.taskRootTaskId !== rootTaskId
      || row.taskParentTaskId !== rootTaskId || row.sessionUserId !== lease.userId || row.turnUserId !== lease.userId
      || row.turnRootTaskId !== rootTaskId || typeof row.taskRole !== "string") return null
    rows.set(row.taskId, row)
  }
  const contexts: SelectedJobBatchTaskContext[] = []
  for (const taskId of taskIds) {
    const row = rows.get(taskId)
    if (!row) return null
    contexts.push({ taskId, role: row.taskRole, context: row.context })
  }
  return contexts
}

async function readBatchArtifactVersion(client: PoolClient, scope: Readonly<{
  userId: string; sessionId: string; jobId: string; artifactId: string; taskId: string; version: number
}>): Promise<SelectedJobBatchArtifactVersion | null> {
  const result = await client.query<SelectedJobBatchArtifactVersion>(`SELECT "artifactId", "artifactType", "taskId", "version", "contentHash", "sourceDigest", "previousHash"
    FROM "agent_artifact_version" WHERE "userId" = $1 AND "sessionId" = $2 AND "jobId" = $3 AND "artifactId" = $4
      AND "version" = $5 AND "artifactType" = 'cover_letter' AND "taskId" = $6
    LIMIT 2`, [scope.userId, scope.sessionId, scope.jobId, scope.artifactId, scope.version, scope.taskId])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.artifactId === scope.artifactId && row.artifactType === "cover_letter"
    && row.taskId === scope.taskId && row.version === scope.version
    && SHA256.test(row.contentHash) && SHA256.test(row.sourceDigest)
    && (row.previousHash === null || typeof row.previousHash === "string" && SHA256.test(row.previousHash)) ? row : null
}

function blocked(value: readonly SelectedJobBatchSlot[] | readonly SelectedJobBatchPair[]): SelectedJobBatchCompletionResult {
  return { status: "blocked", outcomes: value.map(row => ({ slotId: row.slotId, jobId: row.jobId, status: "invalid" as const })) }
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}
