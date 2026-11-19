import type pg from "pg"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { ChildResumeObservationSet } from "./child-resume-observations.js"
import { projectChildResumeObservations, type DurableWaitResume } from "./child-resume-observations.js"
import { buildChildResumeReplayReceipts, type ChildResumeReplayPair } from "./child-resume-replay-receipts.js"
import { spawnKey } from "./pg-store-persistence.js"
import { scoutDelegateSpawnKey } from "./scout-delegate-spawn-key.js"
import { isSubagentTaskId } from "../tools/redaction.js"
import type { SubagentLease } from "./types.js"

type Row = Record<string, unknown>
type QueryClient = Pick<pg.PoolClient, "query">
type RestoredDelegate = Readonly<{ taskId: string; status: "queued" | "duplicate" }>
type SpawnProof = Readonly<{ pair: ChildResumeReplayPair; spawnKey: string; storedTaskId: string; status: RestoredDelegate["status"] }>
const MAX_DELEGATE_PROOFS = 256
const unavailable = () => new Error("child_resume_delegate_receipt_unavailable")

const proofSql = `SELECT expected."idempotencyKey" AS "idempotencyKey", spawn."id" AS "spawnId", spawn."payload" AS "spawnPayload",
  child."id" AS "childTaskId", child."sessionId" AS "childSessionId", child."turnId" AS "childTurnId", child."rootTaskId" AS "childRootTaskId",
  child."parentTaskId" AS "childParentTaskId", child."depth" AS "childDepth", child."role" AS "childRole", child."taskType" AS "childTaskType",
  session."userId" AS "sessionUserId", turn."id" AS "turnId", turn."sessionId" AS "turnSessionId", turn."userId" AS "turnUserId"
  FROM unnest($1::text[]) AS expected("idempotencyKey")
  LEFT JOIN "agent_outbox" AS spawn ON spawn."topic" = 'agent.subagent.spawn' AND spawn."aggregateId" = $2
    AND spawn."idempotencyKey" = expected."idempotencyKey"
  LEFT JOIN "sub_agent_tasks" AS child ON child."id" = spawn."payload"->>'taskId' AND child."sessionId" = $2
    AND child."turnId" = $3 AND child."rootTaskId" = $4 AND child."parentTaskId" = $5
    AND child."depth" = 2 AND child."role" = 'scout' AND child."taskType" = 'job_discovery'
  LEFT JOIN "agent_sessions" AS session ON session."id" = $2 AND session."userId" = $6
  LEFT JOIN "agent_turns" AS turn ON turn."id" = $3 AND turn."sessionId" = $2 AND turn."userId" = $6
  LIMIT ${MAX_DELEGATE_PROOFS + 1}`

/** Restores only completed delegate responses re-bound to their exact durable direct-child spawn. */
export async function buildChildResumeObservationsWithDelegateReceipts(
  client: QueryClient, rows: readonly Row[], lease: SubagentLease, currentAttemptOrdinal?: number,
  durableWaits: readonly DurableWaitResume[] = [],
): Promise<ChildResumeObservationSet> {
  const replay = buildChildResumeReplayReceipts(rows, lease, currentAttemptOrdinal, durableWaits)
  const successful = replay.pairs.filter(pair => pair.toolName === "scout.delegate" && pair.status === "completed")
  if (successful.length > MAX_DELEGATE_PROOFS) throw new Error("child_resume_observation_limit")
  const calls = new Map(rows.filter(row => row.type === "tool_call").map(row => [row.id, row]))
  for (const pair of successful) {
    const call = calls.get(pair.callItem.id), content = object(call?.content)
    if (call?.status !== "completed" || content?.toolName !== "scout.delegate" || content.toolCallId !== pair.toolCallId) throw unavailable()
  }
  const proofs = successful.map(pair => proofFor(pair, lease))
  if (new Set(proofs.map(proof => proof.spawnKey)).size !== proofs.length) throw unavailable()
  const taskIds = new Map<string, RestoredDelegate>()
  if (proofs.length) {
    const result = await client.query<Row>(proofSql, [proofs.map(proof => proof.spawnKey), lease.sessionId, lease.turnId,
      lease.rootTaskId, lease.id, lease.userId])
    if (result.rows.length !== proofs.length || result.rows.length > MAX_DELEGATE_PROOFS) throw unavailable()
    const expected = new Map(proofs.map(proof => [proof.spawnKey, proof]))
    for (const row of result.rows) {
      const key = requiredText(row, "idempotencyKey"), proof = expected.get(key)
      if (!proof || taskIds.has(proof.pair.resultItemId)) throw unavailable()
      const childId = validateSpawnRow(row, proof, lease)
      if (proof.storedTaskId !== childId && proof.storedTaskId !== redactSensitiveText(childId)) throw unavailable()
      taskIds.set(proof.pair.resultItemId, { taskId: childId, status: proof.status })
    }
    if (taskIds.size !== proofs.length) throw unavailable()
  }
  return projectChildResumeObservations(replay, taskIds)
}

function proofFor(pair: ChildResumeReplayPair, lease: SubagentLease): SpawnProof {
  const output = object(pair.output)
  if (pair.status !== "completed" || pair.errorCode !== null || !output || !exactKeys(output, ["taskId", "status"])
    || typeof output.taskId !== "string" || !output.taskId.trim() || output.taskId.length > 256
    || output.status !== "queued" && output.status !== "duplicate" || !Number.isSafeInteger(pair.attempt) || pair.attempt < 1) throw unavailable()
  return { pair, storedTaskId: output.taskId, status: output.status, spawnKey: spawnKey(lease.sessionId,
    scoutDelegateSpawnKey(lease.id, pair.attempt, pair.toolCallId)) }
}

function validateSpawnRow(row: Row, proof: SpawnProof, lease: SubagentLease): string {
  const childId = requiredText(row, "childTaskId"), spawnId = requiredText(row, "spawnId")
  const payload = object(row.spawnPayload)
  if (!isSubagentTaskId(childId) || !payload || !exactKeys(payload, ["taskId"]) || payload.taskId !== childId || row.idempotencyKey !== proof.spawnKey
    || row.childSessionId !== lease.sessionId || row.childTurnId !== lease.turnId || row.childRootTaskId !== lease.rootTaskId
    || row.childParentTaskId !== lease.id || Number(row.childDepth) !== 2 || row.childRole !== "scout" || row.childTaskType !== "job_discovery"
    || row.sessionUserId !== lease.userId || row.turnId !== lease.turnId || row.turnSessionId !== lease.sessionId || row.turnUserId !== lease.userId
    || !spawnId) throw unavailable()
  return childId
}

function object(value: unknown): Row | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : null }
function exactKeys(value: Row, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(), keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}
function requiredText(row: Row, key: string): string {
  const value = row[key]
  if (typeof value !== "string" || !value.trim()) throw unavailable()
  return value
}
