import type pg from "pg"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import { canonicalTaskGraphJson, parseTaskGraphEvent, parseTaskGraphSnapshot, taskGraphItemId, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { TaskGraphFailedBranchRepairRelation } from "./task-graph-pg-failed-branch-relation.js"

type Client = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : null } catch { return null }
}
function exact(row: Row | null, keys: readonly string[]): boolean {
  return row !== null && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key))
}
function seq(value: unknown): bigint | null {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return null
  const parsed = BigInt(value); return parsed <= 9_223_372_036_854_775_807n ? parsed : null
}

/** Verifies only cancellations created by this call, then checks their retained rows stayed unexecuted. */
export async function verifyTaskGraphFailedBranchCancellationHistory(client: Client, scope: GraphIdentityScope,
  relation: TaskGraphFailedBranchRepairRelation, snapshot: TaskGraphSnapshot, callSequence: bigint,
  persistedEvents: readonly unknown[]): Promise<boolean> {
  const expected = relation.sources.filter(binding => binding.source.nodeKey !== relation.branchRoot.nodeKey)
  if (expected.length !== relation.cancellations.length || expected.length < 1) return false
  const rows = new Map(persistedEvents.map(value => [String(object(value)?.id), object(value)] as const))
  const eventIds = new Set<string>(), eventKeys = new Set<string>(), outboxKeys: string[] = []
  let previousSequence = callSequence
  for (const [index, binding] of relation.cancellations.entries()) {
    const expectedSource = expected[index]?.source, cancel = binding, row = rows.get(cancel.event.id)
    const payload = object(row?.payload), event = parseTaskGraphEvent(payload?.event), item = object(payload?.item)
    const key = taskGraphLifecycleKey(scope.rootTaskId, cancel.source.nodeKey, 0, "task.cancelled")
    const sequence = seq(row?.sequence), content = item && parseSnapshot(item.content)
    if (!expectedSource || expectedSource.nodeKey !== cancel.source.nodeKey || expectedSource.taskId !== cancel.source.taskId
      || !row || !sequence || sequence <= previousSequence || sequence >= BigInt(relation.planEvent.sequence)
      || sequence.toString() !== cancel.event.sequence || row.sessionId !== scope.sessionId || row.turnId !== scope.turnId
      || row.sessionUserId !== scope.userId || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
      || row.itemId !== taskGraphItemId(scope.rootTaskId) || row.taskId !== cancel.source.taskId || row.type !== "item.delta"
      || row.actor !== "system" || row.correlationId !== scope.turnId || row.causationId !== relation.agentPlanCall.stepId
      || row.idempotencyKey !== key || cancel.event.idempotencyKey !== key
      || !exact(payload, ["kind", "event", "revision", "item"]) || payload?.kind !== "lifecycle"
      || !event || event.type !== "task.cancelled" || event.nodeKey !== cancel.source.nodeKey || event.idempotencyKey !== key
      || event.expectedRevision !== relation.observedRevision + index || payload?.revision !== relation.observedRevision + index + 1
      || !item || item.schemaVersion !== AGENT_STREAM_SCHEMA_VERSION || item.id !== taskGraphItemId(scope.rootTaskId)
      || item.sessionId !== scope.sessionId || item.turnId !== scope.turnId || item.taskId !== scope.rootTaskId
      || item.stepId !== relation.agentPlanCall.stepId || item.type !== "task_graph" || item.revision !== payload.revision
      || !content || canonicalTaskGraphJson(content) !== canonicalTaskGraphJson(snapshot)) return false
    const expectedOutbox = { eventId: row.id, sessionId: row.sessionId, turnId: row.turnId, itemId: row.itemId,
      taskId: row.taskId, sequence: sequence.toString(), type: row.type, actor: row.actor, correlationId: row.correlationId,
      causationId: row.causationId, idempotencyKey: row.idempotencyKey, payload: row.payload }
    let outboxMatches = false
    try { outboxMatches = canonicalTaskGraphJson(row.outboxPayload) === canonicalTaskGraphJson(expectedOutbox) } catch { return false }
    if (row.outboxTopic !== "agent.session.event" || row.outboxAggregateId !== scope.sessionId
      || row.outboxIdempotencyKey !== `agent-event:${row.id}` || !outboxMatches
      || eventIds.has(String(row.id)) || eventKeys.has(key)) return false
    eventIds.add(String(row.id)); eventKeys.add(key); outboxKeys.push(`agent-event:${row.id}`); previousSequence = sequence
  }
  return verifyCancelledRows(client, scope, snapshot, expected.map(binding => binding.source), [...eventKeys], outboxKeys)
}

function parseSnapshot(value: unknown): TaskGraphSnapshot | null { try { return parseTaskGraphSnapshot(value) } catch { return null } }

async function verifyCancelledRows(client: Client, scope: GraphIdentityScope, snapshot: TaskGraphSnapshot,
  sources: readonly TaskGraphFailedBranchRepairRelation["sources"][number]["source"][], keys: readonly string[], outboxKeys: readonly string[]): Promise<boolean> {
  const ids = sources.map(source => source.taskId).sort()
  const tasks = await client.query<Row>(`SELECT task."id", task."role", task."status", task."attemptCount", task."leaseOwner", task."leaseExpiresAt",
      task."nextAttemptAt", task."startedAt", task."completedAt", task."closedAt", task."interruptRequestedAt", task."failureReason",
      task."result", task."confidence", task."qualityGateResult", task."contextSnapshotId", task."outputArtifactIds",
      session."userId" AS "sessionUserId", turn."userId" AS "turnUserId", turn."rootTaskId" AS "turnRootTaskId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 AND session."userId" = $5 AND turn."userId" = $5
    ORDER BY task."id"`, [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  if (tasks.rows.length !== ids.length) return false
  const byId = new Map(tasks.rows.map(row => [String(row.id), row]))
  for (const source of sources) {
    const row = byId.get(source.taskId), node = snapshot.nodes.find(value => value.key === source.nodeKey && value.taskId === source.taskId)
    if (!row || !node || row.role !== node.templateId || row.sessionUserId !== scope.userId
      || row.turnUserId !== scope.userId || row.turnRootTaskId !== scope.rootTaskId
      || row.status !== "cancelled" || Number(row.attemptCount) !== 0 || row.leaseOwner !== null || row.leaseExpiresAt !== null
      || row.nextAttemptAt !== null || row.startedAt !== null || row.completedAt === null || row.closedAt !== null
      || row.interruptRequestedAt !== null || row.failureReason !== null || row.result !== null || row.confidence !== null
      || row.qualityGateResult !== null || row.contextSnapshotId !== null || !Array.isArray(row.outputArtifactIds) || row.outputArtifactIds.length !== 0) return false
  }
  const evidence = await client.query<Row>(`SELECT task."id",
      (EXISTS (SELECT 1 FROM "agent_steps" step WHERE step."sessionId" = task."sessionId" AND step."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_items" item WHERE item."sessionId" = task."sessionId" AND item."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_events" event WHERE event."sessionId" = task."sessionId" AND event."taskId" = task."id"
        AND event."idempotencyKey" <> ALL($5::text[]))
      OR EXISTS (SELECT 1 FROM "agent_tree_budget_reservations" reservation WHERE reservation."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_native_semantic_rejections" rejection WHERE rejection."rootTaskId" = task."id" OR rejection."controlTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_mailbox_messages" message WHERE message."fromTaskId" = task."id" OR message."toTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_mailbox_hydration_checkpoints" checkpoint WHERE checkpoint."taskId" = task."id" OR checkpoint."rootTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_tool_result_references" ref WHERE ref."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_transcript_events" transcript WHERE transcript."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_approvals" approval WHERE approval."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_artifact_version" artifact WHERE artifact."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_artifact_review" review WHERE review."taskId" = task."id")
      OR EXISTS (SELECT 1 FROM "application_tasks" application WHERE application."workerTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "sub_agent_tasks" child WHERE child."sessionId" = task."sessionId" AND child."parentTaskId" = task."id")
      OR EXISTS (SELECT 1 FROM "agent_outbox" outbox WHERE (outbox."payload"->>'taskId' = task."id" OR outbox."payload"->'payload'->>'taskId' = task."id")
        AND outbox."idempotencyKey" <> ALL($6::text[]))) AS "hasExecutionEvidence",
      EXISTS (SELECT 1 FROM "agent_wait_conditions" wait WHERE wait."sessionId" = task."sessionId" AND wait."turnId" = task."turnId"
        AND (wait."parentTaskId" = task."id" OR wait."targetTaskIds" @> jsonb_build_array(task."id")
          OR wait."matchedTaskIds" @> jsonb_build_array(task."id"))) AS "hasWaitEvidence",
      EXISTS (SELECT 1 FROM "agent_outbox" dispatch WHERE dispatch."topic" = 'agent.subagent.dispatch'
        AND dispatch."aggregateId" = task."sessionId" AND dispatch."idempotencyKey" = 'subagent-dispatch:' || task."id") AS "hasDispatch"
    FROM "sub_agent_tasks" task WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3
      AND task."rootTaskId" = $4 AND task."parentTaskId" = $4 ORDER BY task."id"`,
  [ids, scope.sessionId, scope.turnId, scope.rootTaskId, keys, outboxKeys])
  return evidence.rows.length === ids.length && evidence.rows.every(row => row.hasExecutionEvidence === false
    && row.hasWaitEvidence === false && row.hasDispatch === false)
}
