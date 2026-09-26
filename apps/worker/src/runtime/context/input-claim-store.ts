import type pg from "pg"
import type { InputContentPart, TenantScope } from "@jobcopilot/agent-protocol"
import { persistObservedSteeringMarker, type SteeringMarkerWrite } from "./steering-marker-store.js"
import type { ClaimInputsRequest, ClaimedInputs, StepCheckpoint, StoredAgentInput, TurnExecutionFence } from "./input-claim-types.js"
export type { ClaimInputsRequest, ClaimedInputs, StepCheckpoint, StoredAgentInput, TurnExecutionFence } from "./input-claim-types.js"
export interface InputClaimTransaction {
  getCheckpoint(input: { sessionId: string; turnId: string; stepId: string; lease?: TurnExecutionFence }): Promise<StepCheckpoint>; claimInputs(input: ClaimInputsRequest): Promise<ClaimedInputs>
  loadActiveSteeringInputs?(input: { sessionId: string; turnId: string; inputIds: readonly string[]; lease?: TurnExecutionFence }): Promise<readonly StoredAgentInput[]>; persistCheckpoint(input: { sessionId: string; turnId: string; stepId: string; checkpoint: StepCheckpoint; lease?: TurnExecutionFence }): Promise<void>
  appendObservedSteeringMarker?(input: SteeringMarkerWrite): Promise<void>
}
export interface InputClaimStore {
  readonly scope: TenantScope; withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T>
}
export class InputClaimStoreError extends Error {
  readonly recoverable = false
  constructor(readonly code: "owner_conflict" | "checkpoint_conflict" | "store_conflict", message: string) {
    super(message)
    this.name = "InputClaimStoreError"
  }
}
type CheckpointRow = { inputThroughSequence: bigint | string; consumedInputIds: unknown }; type QueryClient = Pick<pg.PoolClient, "query">
type InputRow = {
  id: string; sessionId: string; targetTurnId: string | null
  userId: string; clientMessageId: string; delivery: string; status: string
  content: unknown; acceptedSequence: bigint | string; consumedByStepId: string | null
  consumedAt: Date | string | null; createdAt: Date | string
}
function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new InputClaimStoreError("store_conflict", `Invalid ${field}`)
  return value
}
function inputContent(value: unknown): InputContentPart[] {
  if (!Array.isArray(value) || value.length === 0) throw new InputClaimStoreError("store_conflict", "Invalid AgentInput content")
  return value.map((part) => {
    if (!part || typeof part !== "object" || Array.isArray(part)) throw new InputClaimStoreError("store_conflict", "Invalid AgentInput content part")
    const record = part as Record<string, unknown>
    if (record.type === "text") return { type: "text", text: nonEmpty(record.text, "text part") }
    if (record.type === "attachment_ref") {
      return {
        type: "attachment_ref",
        attachmentId: nonEmpty(record.attachmentId, "attachmentId"),
        mediaType: nonEmpty(record.mediaType, "mediaType"),
        ...(record.filename === undefined ? {} : { filename: nonEmpty(record.filename, "filename") }),
      }
    }
    throw new InputClaimStoreError("store_conflict", "Unknown AgentInput content part")
  })
}
function date(value: Date | string | null, field: string): Date | null {
  if (value === null) return null
  const result = value instanceof Date ? new Date(value) : new Date(value)
  if (Number.isNaN(result.getTime())) throw new InputClaimStoreError("store_conflict", `Invalid ${field}`)
  return result
}
function mapInput(row: InputRow): StoredAgentInput {
  const delivery = row.delivery === "steer" || row.delivery === "follow_up" ? row.delivery : null
  const status = ["accepted", "queued", "consumed", "cancelled", "rejected"].includes(row.status) ? row.status as StoredAgentInput["status"] : null
  if (!delivery || !status) throw new InputClaimStoreError("store_conflict", "Invalid AgentInput state")
  const createdAt = date(row.createdAt, "createdAt")
  if (!createdAt) throw new InputClaimStoreError("store_conflict", "Invalid createdAt")
  return {
    id: nonEmpty(row.id, "id"),
    sessionId: nonEmpty(row.sessionId, "sessionId"),
    targetTurnId: row.targetTurnId,
    userId: nonEmpty(row.userId, "userId"),
    clientMessageId: nonEmpty(row.clientMessageId, "clientMessageId"),
    delivery,
    status,
    content: inputContent(row.content),
    acceptedSequence: BigInt(row.acceptedSequence),
    consumedByStepId: row.consumedByStepId,
    consumedAt: date(row.consumedAt, "consumedAt"),
    createdAt,
  }
}
function checkpoint(row: CheckpointRow): StepCheckpoint {
  if (!Array.isArray(row.consumedInputIds) || !row.consumedInputIds.every((id) => typeof id === "string" && id.length > 0)) {
    throw new InputClaimStoreError("store_conflict", "Invalid consumedInputIds checkpoint")
  }
  const ids = row.consumedInputIds as string[]
  if (new Set(ids).size !== ids.length) throw new InputClaimStoreError("checkpoint_conflict", "Duplicate consumed input checkpoint")
  const inputThroughSequence = BigInt(row.inputThroughSequence)
  if (inputThroughSequence < 0n) throw new InputClaimStoreError("checkpoint_conflict", "Negative input cursor")
  return { inputThroughSequence, consumedInputIds: ids }
}
async function assertOwner(client: QueryClient, scope: TenantScope, input: { sessionId: string; turnId: string }, lease?: TurnExecutionFence): Promise<void> {
  const session = await client.query(
    `SELECT "id"
     FROM "agent_sessions"
     WHERE "id" = $1 AND "userId" = $2
       AND "status" NOT IN ('aborted', 'archived')
     FOR UPDATE`,
    [input.sessionId, scope.userId],
  )
  if (!session.rows[0]) throw new InputClaimStoreError("owner_conflict", `Session ${input.sessionId} is outside the tenant scope`)
  const result = await client.query(
    `SELECT turn."id"
     FROM "agent_turns" AS turn
     JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
     WHERE turn."id" = $1 AND turn."sessionId" = $2
       AND turn."userId" = $3 AND session."userId" = $3
       AND turn."status" IN ('queued', 'in_progress', 'waiting_for_dependency', 'waiting_for_approval', 'waiting_for_user')
       AND ($4::text IS NULL OR (turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5 AND turn."leaseExpiresAt" > $6))
     FOR UPDATE`,
    [input.turnId, input.sessionId, scope.userId, lease?.ownerId ?? null, lease?.leaseVersion ?? null, lease?.now ?? new Date()],
  )
  if (!result.rows[0]) throw new InputClaimStoreError("owner_conflict", `Turn ${input.turnId} is outside the tenant scope`)
}
function inputSql(): string {
  return `SELECT "id", "sessionId", "targetTurnId", "userId", "clientMessageId",
                 "delivery", "status", "content", "acceptedSequence", "consumedByStepId",
                 "consumedAt", "createdAt"
          FROM "agent_inputs"
          WHERE "sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3
            AND "delivery" IN ('steer', 'follow_up')
            AND (("consumedByStepId" = $4 AND "status" = 'consumed') OR "id" = ANY($5::text[]))
          ORDER BY "acceptedSequence" ASC, "id" ASC
          FOR UPDATE`
}
function followUpSql(includeUnclaimed: boolean): string {
  return `SELECT "id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence", "consumedByStepId", "consumedAt", "createdAt"
          FROM "agent_inputs" WHERE "sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3 AND "delivery" = 'follow_up'
            AND "status" IN (${includeUnclaimed ? "'accepted', 'queued', 'consumed'" : "'consumed'"}) ORDER BY "acceptedSequence" ASC, "id" ASC FOR SHARE`
}
function sortInputs(inputs: StoredAgentInput[]): StoredAgentInput[] {
  return inputs.sort((left, right) => left.acceptedSequence < right.acceptedSequence ? -1 : left.acceptedSequence > right.acceptedSequence ? 1 : left.id.localeCompare(right.id))
}
function createTransaction(client: QueryClient, scope: TenantScope): InputClaimTransaction {
  return {
    async getCheckpoint(input) {
      await assertOwner(client, scope, input, input.lease)
      const result = await client.query<CheckpointRow>(
        `SELECT "inputThroughSequence", "consumedInputIds"
         FROM "agent_steps"
         WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
        [input.stepId, input.sessionId, input.turnId],
      )
      if (!result.rows[0]) throw new InputClaimStoreError("checkpoint_conflict", `Step ${input.stepId} is not owned by the Turn`)
      return checkpoint(result.rows[0])
    },
    async claimInputs(input) {
      await assertOwner(client, scope, input, input.lease)
      const existing = await client.query<InputRow>(inputSql(), [input.sessionId, input.turnId, scope.userId, input.stepId, [...input.checkpoint.consumedInputIds]])
      const existingInputs = sortInputs(existing.rows.map(mapInput))
      if (existingInputs.some((item) => item.userId !== scope.userId || item.sessionId !== input.sessionId || item.targetTurnId !== input.turnId)) {
        throw new InputClaimStoreError("owner_conflict", "AgentInput ownership mismatch")
      }
      const known = new Set(existingInputs.map((item) => item.id))
      if (input.checkpoint.consumedInputIds.some((id) => !known.has(id))) throw new InputClaimStoreError("checkpoint_conflict", "Checkpoint input is missing or outside the Turn")
      if (existingInputs.some((item) => item.status !== "consumed" || (item.delivery === "steer" && item.consumedByStepId !== input.stepId) || (item.delivery === "follow_up" && !item.consumedByStepId))) throw new InputClaimStoreError("checkpoint_conflict", "Checkpoint input is not durably consumed by this Step")
      const mode = input.mode ?? (input.rebuild ? "rebuild" : "new")
      if (mode !== "new") {
        const durableFollowUps = await client.query<InputRow>(followUpSql(false), [input.sessionId, input.turnId, scope.userId])
        const byId = new Map([...existingInputs, ...durableFollowUps.rows.map(mapInput)].map(item => [item.id, item]))
        return { inputs: sortInputs([...byId.values()]), newlyClaimedInputIds: [] }
      }
      const claimed = await client.query<InputRow>(
        `WITH candidates AS (
           SELECT "id"
           FROM "agent_inputs"
           WHERE "sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3
             AND "delivery" IN ('steer', 'follow_up') AND "status" IN ('accepted', 'queued')
             AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL
             AND ("delivery" = 'follow_up' OR "acceptedSequence" > $4)
           ORDER BY "acceptedSequence" ASC, "id" ASC
           FOR UPDATE
         )
         UPDATE "agent_inputs" AS input
         SET "status" = 'consumed', "consumedByStepId" = $5, "consumedAt" = $6
         FROM candidates
         WHERE input."id" = candidates."id"
         RETURNING input."id", input."sessionId", input."targetTurnId", input."userId",
                   input."clientMessageId", input."delivery", input."status", input."content",
                   input."acceptedSequence", input."consumedByStepId", input."consumedAt", input."createdAt"`,
        [input.sessionId, input.turnId, scope.userId, input.checkpoint.inputThroughSequence.toString(), input.stepId, input.now],
      )
      const newlyClaimed = sortInputs(claimed.rows.map(mapInput))
      const activeFollowUps = await client.query<InputRow>(followUpSql(true), [input.sessionId, input.turnId, scope.userId])
      const durableFollowUps = sortInputs(activeFollowUps.rows.map(mapInput))
      if (durableFollowUps.some((item) => item.status !== "consumed" || !item.consumedByStepId || !item.consumedAt)) throw new InputClaimStoreError("checkpoint_conflict", "Follow-up was not durably claimed")
      const byId = new Map([...existingInputs, ...durableFollowUps].map((item) => [item.id, item]))
      for (const item of newlyClaimed) byId.set(item.id, item)
      return {
        inputs: sortInputs([...byId.values()]),
        newlyClaimedInputIds: newlyClaimed.map((item) => item.id),
      }
    },
    async loadActiveSteeringInputs(input) {
      await assertOwner(client, scope, input, input.lease)
      if (input.inputIds.length === 0) return []
      if (input.inputIds.length > 128 || input.inputIds.some(id => typeof id !== "string" || id.trim() !== id || id.length === 0) || new Set(input.inputIds).size !== input.inputIds.length) throw new InputClaimStoreError("store_conflict", "Active steering marker input IDs are invalid")
      const result = await client.query<InputRow>(
        `SELECT "id", "sessionId", "targetTurnId", "userId", "clientMessageId",
                "delivery", "status", "content", "acceptedSequence", "consumedByStepId",
                "consumedAt", "createdAt"
         FROM "agent_inputs"
         WHERE "sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3
           AND "delivery" = 'steer' AND "id" = ANY($4::text[])
           AND "status" IN ('accepted', 'queued', 'consumed')
         ORDER BY "acceptedSequence" ASC, "id" ASC
         FOR SHARE`,
        [input.sessionId, input.turnId, scope.userId, [...input.inputIds]],
      )
      const inputs = sortInputs(result.rows.map(mapInput))
      if (inputs.length !== new Set(input.inputIds).size || inputs.some((item) => item.sessionId !== input.sessionId || item.targetTurnId !== input.turnId || item.userId !== scope.userId || item.delivery !== "steer")) {
        throw new InputClaimStoreError("owner_conflict", "Active steering marker input is outside the tenant Turn")
      }
      return inputs
    },
    async persistCheckpoint(input) {
      await assertOwner(client, scope, input, input.lease)
      const result = await client.query(
        `UPDATE "agent_steps"
         SET "inputThroughSequence" = $1, "consumedInputIds" = $2::jsonb
         WHERE "id" = $3 AND "sessionId" = $4 AND "turnId" = $5`,
        [input.checkpoint.inputThroughSequence.toString(), JSON.stringify([...input.checkpoint.consumedInputIds]), input.stepId, input.sessionId, input.turnId],
      )
      if (result.rowCount !== 1) throw new InputClaimStoreError("checkpoint_conflict", `Step ${input.stepId} checkpoint was not persisted`)
    },
    async appendObservedSteeringMarker(input) {
      await assertOwner(client, scope, input, input.lease)
      await persistObservedSteeringMarker(client, { userId: scope.userId, sessionId: input.sessionId, turnId: input.turnId, taskId: input.taskId, lease: input.lease ? { ownerId: input.lease.ownerId, now: input.lease.now } : undefined }, input)
    },
  }
}
export function createPgInputClaimStore(pool: Pick<pg.Pool, "connect">, scope: TenantScope): InputClaimStore {
  const boundScope = Object.freeze({ userId: scope.userId })
  return {
    scope: boundScope,
    async withTransaction<T>(work: (transaction: InputClaimTransaction) => Promise<T>): Promise<T> {
      const client = await pool.connect()
      let committed = false
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config($1, $2, true)", ["app.user_id", boundScope.userId])
        const result = await work(createTransaction(client, boundScope))
        await client.query("COMMIT")
        committed = true
        return result
      } catch (error: unknown) {
        if (!committed) await client.query("ROLLBACK").catch(() => undefined)
        throw error
      } finally {
        client.release()
      }
    },
  }
}
