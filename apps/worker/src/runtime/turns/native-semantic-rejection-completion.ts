import type { ExecutionOwnerFence } from "../execution-owner.js"
import { assertSessionWorkAdmission } from "../session-gate.js"
import { loadNativeVerificationOwnedState } from "../subagents/native-verification-pg-bindings.js"
import { readNativeVerificationFailedRootRejectionWithClient } from "../subagents/native-verification-pg-readback.js"
import { readNativeVerificationControlTasks } from "../subagents/native-verification-pg-request.js"
import { loadTaskGraph } from "../subagents/task-graph-pg-state.js"
import type { TaskGraphReadScope } from "../subagents/task-graph-command-port.js"
import { lockTurnEngineOpenSession, lockTurnEngineOwnedTurn, ownerFenceSql, type TurnEngineQueryClient, type TurnEngineRow } from "./turn-engine-owner-sql.js"
import { nativeSemanticCheckpoint, nativeSemanticSchemaConflict, parseNativeSemanticRejectionIdentity, type NativeSemanticRejectionCount, type NativeSemanticRejectionIdentity } from "./native-semantic-rejection-ledger.js"
import { TurnEngineError } from "./turn-engine-types.js"

type CompletionInput = {
  owner: ExecutionOwnerFence; stepId: string; finishReason: string; errorCode: null
  inputTokens: number; outputTokens: number; estimatedCostUsd: number; now: Date; identity: NativeSemanticRejectionIdentity
}
function conflict(reason: string): TurnEngineError { return new TurnEngineError("persistence_conflict", `Native semantic rejection conflict: ${reason}`) }
function usage(input: CompletionInput): void {
  if (typeof input.finishReason !== "string" || input.finishReason.trim() === "" || input.errorCode !== null
    || !Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0 || !Number.isSafeInteger(input.outputTokens) || input.outputTokens < 0
    || !Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0 || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) throw conflict("step completion values")
}
function sameStep(row: TurnEngineRow, input: CompletionInput, checkpoint: bigint): boolean {
  return row.status === "completed" && row.errorCode === null && row.finishReason === input.finishReason
    && Number(row.inputTokens) === input.inputTokens && Number(row.outputTokens) === input.outputTokens
    && BigInt(String(row.inputThroughSequence)) === checkpoint
}
async function samePersistedCost(client: TurnEngineQueryClient, row: TurnEngineRow, input: CompletionInput): Promise<boolean> {
  const result = await client.query<{ same: boolean }>(`SELECT $1::numeric(12,8) = $2::numeric(12,8) AS same`, [input.estimatedCostUsd, row.estimatedCostUsd])
  return result.rows[0]?.same === true
}
function sameReceipt(row: TurnEngineRow, input: CompletionInput, checkpoint: bigint): boolean {
  const owner = input.owner, id = input.identity
  return row.userId === owner.userId && row.sessionId === owner.sessionId && row.turnId === owner.turnId
    && row.rootTaskId === owner.taskId && row.stepId === input.stepId && Number(row.attempt) === 1
    && BigInt(String(row.inputThroughSequence)) === checkpoint && row.candidateDigest === id.candidateDigest
    && row.controlTaskId === id.controlTaskId && row.controlOperationId === id.controlOperationId
    && Number(row.controlAttempt) === id.controlAttempt && row.controlReportDigest === id.controlReportDigest
}
function identityMatches(actual: NativeSemanticRejectionIdentity | null, expected: NativeSemanticRejectionIdentity): boolean {
  return actual !== null && actual.candidateDigest === expected.candidateDigest && actual.controlTaskId === expected.controlTaskId
    && actual.controlOperationId === expected.controlOperationId && actual.controlAttempt === expected.controlAttempt
    && actual.controlReportDigest === expected.controlReportDigest
}
async function lockCurrentOwnedRoot(client: TurnEngineQueryClient, owner: Extract<ExecutionOwnerFence, { kind: "turn" }>): Promise<TaskGraphReadScope | null> {
  const root = await client.query<TurnEngineRow>(`SELECT task."attemptCount", task."status" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId" AND session."userId" = $5
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $1 AND task."leaseOwner" = $4
      AND task."status" = 'running' AND task."interruptRequestedAt" IS NULL AND task."leaseExpiresAt" > CURRENT_TIMESTAMP FOR UPDATE OF task`,
  [owner.taskId, owner.sessionId, owner.turnId, owner.ownerId, owner.userId])
  const attempt = Number(root.rows[0]?.attemptCount)
  if (!Number.isSafeInteger(attempt) || attempt < 1) return null
  return { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
    rootTaskId: owner.taskId, parentTaskId: owner.taskId, turnLeaseOwner: owner.ownerId, turnLeaseVersion: owner.leaseVersion,
    parentLeaseOwner: owner.ownerId, parentAttemptCount: attempt }
}
async function currentFailedProof(client: TurnEngineQueryClient, input: CompletionInput, scope: TaskGraphReadScope): Promise<NativeSemanticRejectionIdentity | null> {
  const { identity } = input
  const graph = await loadTaskGraph(client, scope, true), state = await loadNativeVerificationOwnedState(client, scope, graph.snapshot, true)
  const controls = await readNativeVerificationControlTasks(client, scope)
  const matches = controls.filter(control => control.taskId === identity.controlTaskId)
  if (matches.length !== 1 || matches[0]!.packet.target.kind !== "root_goal") return null
  const candidateText = matches[0]!.packet.target.candidateText
  return readNativeVerificationFailedRootRejectionWithClient(client, {
    scope, graph, state, candidateText, controlTaskId: identity.controlTaskId, stepId: input.stepId,
  })
}
async function matchingSteps(client: TurnEngineQueryClient, input: CompletionInput, checkpoint: bigint): Promise<string[]> {
  const owner = input.owner, id = input.identity
  const result = await client.query<TurnEngineRow>(`SELECT rejection."stepId"
    FROM "agent_native_semantic_rejections" AS rejection JOIN "agent_steps" AS step
      ON step."id" = rejection."stepId" AND step."sessionId" = rejection."sessionId" AND step."turnId" = rejection."turnId"
      AND step."taskId" = rejection."rootTaskId" AND step."attempt" = rejection."attempt"
      AND step."status" = 'completed' AND step."errorCode" IS NULL AND step."finishReason" IS NOT NULL
    WHERE rejection."userId" = $1 AND rejection."sessionId" = $2 AND rejection."turnId" = $3 AND rejection."rootTaskId" = $4
      AND rejection."inputThroughSequence" = $5 AND rejection."candidateDigest" = $6
      AND rejection."controlTaskId" = $7 AND rejection."controlOperationId" = $8
      AND rejection."controlAttempt" = $9 AND rejection."controlReportDigest" = $10
    ORDER BY step."ordinal" ASC LIMIT 3`, [owner.userId, owner.sessionId, owner.turnId, owner.taskId, checkpoint.toString(), id.candidateDigest,
    id.controlTaskId, id.controlOperationId, id.controlAttempt, id.controlReportDigest])
  return result.rows.map(row => String(row.stepId))
}

export async function completeNativeSemanticRejectionStepWithClient(client: TurnEngineQueryClient, input: CompletionInput): Promise<NativeSemanticRejectionCount> {
  const { owner } = input, identity = parseNativeSemanticRejectionIdentity(input.identity)
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || !identity || input.stepId.trim() === "") throw conflict("completion requires canonical root identity")
  usage(input)
  if (!await lockTurnEngineOpenSession(client, owner) || !await lockTurnEngineOwnedTurn(client, owner)) throw conflict("completion owner fence")
  await assertSessionWorkAdmission(client, owner)
  const mode = await client.query<TurnEngineRow>(`SELECT to_jsonb(turn)->>'native_semantic_progress_mode' AS mode
    FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3`, [owner.turnId, owner.sessionId, owner.userId])
  if (mode.rows[0]?.mode !== "durable_v1") throw conflict("durable mode is not pinned")
  const rootScope = await lockCurrentOwnedRoot(client, owner)
  if (!rootScope) throw conflict("current root owner fence")
  const observedResult = await client.query<TurnEngineRow>(`SELECT "id", "taskId", "attempt", "status" FROM "agent_steps"
    WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`, [input.stepId, owner.sessionId, owner.turnId])
  const observed = observedResult.rows[0], replayCandidate = observed?.status === "completed", streamingCandidate = observed?.status === "streaming"
  if (!observed || observed.taskId !== owner.taskId || Number(observed.attempt) !== 1) throw conflict(`step ${input.stepId} lineage`)
  if (!replayCandidate && !streamingCandidate) throw conflict(`step ${input.stepId} status`)
  if (streamingCandidate) {
    const current = await currentFailedProof(client, input, rootScope)
    if (!identityMatches(current, identity)) throw conflict("current failed root proof does not match")
  }
  const result = await client.query<TurnEngineRow>(`SELECT "id", "taskId", "attempt", "status", "finishReason", "errorCode", "inputTokens", "outputTokens", "estimatedCostUsd", "inputThroughSequence"
    FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [input.stepId, owner.sessionId, owner.turnId])
  const step = result.rows[0]
  if (!step || step.taskId !== owner.taskId || Number(step.attempt) !== 1) throw conflict(`step ${input.stepId} lineage`)
  let checkpoint: bigint
  try { checkpoint = nativeSemanticCheckpoint(step.inputThroughSequence) } catch { throw conflict("step checkpoint") }
  try {
    if (step.status === "completed") {
      if (!sameStep(step, input, checkpoint) || !await samePersistedCost(client, step, input)) throw conflict(`step ${input.stepId} replay`)
      const prior = await client.query<TurnEngineRow>(`SELECT * FROM "agent_native_semantic_rejections" WHERE "turnId" = $1 AND "stepId" = $2`, [owner.turnId, input.stepId])
      if (!prior.rows[0] || !sameReceipt(prior.rows[0], input, checkpoint)) throw conflict(`step ${input.stepId} receipt replay`)
    } else {
      if (replayCandidate || step.status !== "streaming" || step.finishReason !== null || step.errorCode !== null
        || Number(step.inputTokens ?? 0) !== 0 || Number(step.outputTokens ?? 0) !== 0 || Number(step.estimatedCostUsd ?? 0) !== 0) {
        throw conflict(`step ${input.stepId} status`)
      }
      const fence = ownerFenceSql(owner, 11)
      const saved = await client.query(`UPDATE "agent_steps" AS step SET "status" = 'completed', "finishReason" = $1, "errorCode" = NULL,
        "inputTokens" = $2, "outputTokens" = $3, "estimatedCostUsd" = $4, "completedAt" = $5
        FROM "agent_turns" AS turn WHERE step."id" = $6 AND step."sessionId" = $7 AND step."turnId" = $8
          AND step."taskId" = $9 AND step."attempt" = 1 AND step."status" = 'streaming'
          AND step."inputThroughSequence" = $10 AND turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
          AND ${fence.where}`,
      [input.finishReason, input.inputTokens, input.outputTokens, input.estimatedCostUsd, input.now, input.stepId, owner.sessionId, owner.turnId, owner.taskId, checkpoint.toString(), ...fence.values])
      if (saved.rowCount !== 1) throw conflict(`step ${input.stepId} completion fence`)
      const inserted = await client.query(`INSERT INTO "agent_native_semantic_rejections"
        ("userId", "sessionId", "turnId", "rootTaskId", "stepId", "attempt", "inputThroughSequence", "candidateDigest", "controlTaskId", "controlOperationId", "controlAttempt", "controlReportDigest", "createdAt")
        VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT ("turnId", "stepId") DO NOTHING`,
      [owner.userId, owner.sessionId, owner.turnId, owner.taskId, input.stepId, checkpoint.toString(), identity.candidateDigest, identity.controlTaskId,
        identity.controlOperationId, identity.controlAttempt, identity.controlReportDigest, input.now])
      if (inserted.rowCount !== 1) throw conflict(`step ${input.stepId} receipt already exists`)
    }
    const steps = await matchingSteps(client, input, checkpoint)
    return { inputThroughSequence: checkpoint, distinctStepCount: steps.length }
  } catch (error: unknown) { return nativeSemanticSchemaConflict(error) }
}
