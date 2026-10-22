import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import { assertCurrentItemLineage, assertCurrentStepLineage, lockTurnEngineOpenSession as lockOpenSession, lockTurnEngineOwnedTurn as lockOwnedTurn, ownerFenceSql, turnEngineTenantTransaction as tenantTransaction, type TurnEnginePool, type TurnEngineQueryClient as QueryClient, type TurnEngineRow as Row } from "./turn-engine-owner-sql.js"
import { enforceRootStepAndUsageBudgets, enforceRootToolCallBudget } from "./turn-engine-root-budget.js"
import { toRepositoryJson, type AtomicTurnNoProgressInput, type AtomicTurnNoProgressResult, type TurnEngineEventInput, type TurnEngineItem, type TurnEngineStore, type TurnEngineStep } from "./turn-engine-types.js"
import { STEERING_MARKER_EVENT_TYPE, parseSteeringMarkerPayload, type SteeringMarkerPayload } from "../context/steering-marker.js"
import { matchesAgentOutboxIdentity, type AgentOutboxIdentity, type AgentOutboxPayload } from "../outbox-identity.js"
import { commitTurnTerminal, type TurnEngineTerminalGuard } from "./turn-engine-terminal-commit.js"
import { assertSessionWorkAdmission } from "../session-gate.js"
import { attachTurnQuestionStore } from "./turn-question-store-factory.js"
import { resolveNativeSemanticProgressModeWithClient } from "./native-semantic-mode-store.js"
import { completeNativeSemanticRejectionStepWithClient } from "./native-semantic-rejection-completion.js"
import { nativeSemanticSchemaConflict, readNativeSemanticRejectionsWithClient } from "./native-semantic-rejection-ledger.js"
import { updateRootObjectiveHistoryProjection } from "../context/objective-history-projection.js"
function json(value: RepositoryJsonValue): string { return JSON.stringify(value) }
function conflict(resource: string): Error { return Object.assign(new Error(`TurnEngine persistence conflict: ${resource}`), { name: "TurnEnginePersistenceConflict" }) }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(toRepositoryJson(left)) === JSON.stringify(toRepositoryJson(right)) }
function markerIdentity(value: SteeringMarkerPayload): string { return JSON.stringify({ schemaVersion: value.schemaVersion, kind: value.kind, status: value.status, sessionId: value.sessionId, turnId: value.turnId, taskId: value.taskId, inputId: value.inputId, idempotencyKey: value.idempotencyKey, obligationId: value.obligationId, goalRevision: value.goalRevision, planRevision: value.planRevision, acceptedSequence: value.acceptedSequence }) }
function sameEventPayload(type: unknown, left: unknown, right: unknown): boolean { if (type !== STEERING_MARKER_EVENT_TYPE) return sameJson(left, right); const a = parseSteeringMarkerPayload(left), b = parseSteeringMarkerPayload(right); return a !== null && b !== null && markerIdentity(a) === markerIdentity(b) }
function ownedTurn(owner: ExecutionOwnerFence, base: number, turnIdParameter: number, sessionParameter: number, allowWaiting = false): { sql: string; values: unknown[] } {
  const fence = ownerFenceSql(owner, base, allowWaiting)
  return {
    sql: `FROM "agent_turns" AS turn ${fence.joins}
      WHERE turn."id" = $${turnIdParameter} AND turn."sessionId" = $${sessionParameter} AND ${fence.where}`,
    values: [...fence.values],
  }
}
function eventOutboxPayload(input: { readonly owner: ExecutionOwnerFence; readonly itemId: string | null; readonly type: string; readonly correlationId: string; readonly causationId: string | null; readonly idempotencyKey: string; readonly eventId: string; readonly sequence: string; readonly actor: string; readonly payload: RepositoryJsonValue }): AgentOutboxPayload {
  return { eventId: input.eventId, sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.taskId, itemId: input.itemId, sequence: input.sequence, type: input.type, actor: input.actor, correlationId: input.correlationId, causationId: input.causationId, idempotencyKey: input.idempotencyKey, payload: input.payload }
}
async function repairEventOutbox(client: QueryClient, expected: AgentOutboxIdentity): Promise<void> {
  const inserted = await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.events', $2, $3, $4::jsonb) ON CONFLICT ("idempotencyKey") DO NOTHING`, [expected.id, expected.aggregateId, expected.idempotencyKey, json(expected.payload)])
  if ((inserted.rowCount ?? 0) === 1) return
  const existing = await client.query<Row>(`SELECT "id", "topic", "aggregateId", "idempotencyKey", "payload" FROM "agent_outbox" WHERE "idempotencyKey" = $1 FOR UPDATE`, [expected.idempotencyKey])
  if (!matchesAgentOutboxIdentity(existing.rows[0], expected)) throw conflict(`event outbox ${expected.idempotencyKey} identity`)
}
async function projectRootTerminalEvent(client: QueryClient, owner: ExecutionOwnerFence, type: string, eventId: string): Promise<void> {
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || !["turn.failed", "turn.interrupted"].includes(type)) return
  if (!await updateRootObjectiveHistoryProjection(client, { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId }, { terminalEventId: eventId })) throw conflict(`terminal objective history ${eventId}`)
}
async function appendEventBatch(pool: TurnEnginePool, inputs: readonly TurnEngineEventInput[], transactionClient?: QueryClient): Promise<readonly { id: string }[]> {
  if (inputs.length === 0) return []
  const owner = inputs[0]!.owner
  if (inputs.some(input => input.owner.kind !== owner.kind || input.owner.userId !== owner.userId || input.owner.sessionId !== owner.sessionId
    || input.owner.turnId !== owner.turnId || input.owner.taskId !== owner.taskId || input.owner.rootTaskId !== owner.rootTaskId
    || input.owner.ownerId !== owner.ownerId || input.owner.leaseExpiresAt.getTime() !== owner.leaseExpiresAt.getTime()
    || (owner.kind === "task" ? input.owner.attemptCount !== owner.attemptCount : input.owner.leaseVersion !== owner.leaseVersion))) throw conflict("event batch owner")
  for (const input of inputs) if (input.owner.kind === "task" && ["turn.completed", "turn.failed", "turn.interrupted"].includes(input.type)) throw conflict(`child root lifecycle ${input.type}`)
  const append = async (client: QueryClient) => {
    if (!await lockOpenSession(client, owner)) throw conflict(`session ${owner.sessionId}`)
    if (!await lockOwnedTurn(client, owner, true)) throw conflict(`turn ${owner.turnId}`)
    if (inputs.some(input => ["step.started", "tool_call.started", "model.started"].includes(input.type))) await assertSessionWorkAdmission(client, owner)
    const result: { id: string }[] = []; let previousId: string | null = null
    for (const input of inputs) {
      if (input.itemId) await assertCurrentItemLineage(client, owner, input.itemId)
      if (input.actor !== undefined && (input.actor !== "system" || input.type !== STEERING_MARKER_EVENT_TYPE)) throw conflict(`event ${input.idempotencyKey} actor`)
      const actor = input.actor ?? (owner.kind === "task" ? "subagent" : "orchestrator")
      const existing = await client.query<Row>(`SELECT "id", "taskId", "turnId", "itemId", "type", "correlationId", "causationId", "sequence", "actor", "payload"
        FROM "agent_events" WHERE "sessionId" = $1 AND "idempotencyKey" = $2`, [owner.sessionId, input.idempotencyKey])
      const causationId = previousId ?? input.causationId
      if (existing.rows[0]) {
        const row = existing.rows[0]
        if (row.taskId !== owner.taskId || row.turnId !== owner.turnId || row.itemId !== input.itemId || row.type !== input.type
          || row.correlationId !== input.correlationId || row.causationId !== causationId || String(row.actor) !== actor || !sameEventPayload(row.type, row.payload, input.payload)) throw conflict(`event ${input.idempotencyKey} identity`)
        await repairEventOutbox(client, {
          id: `agent-outbox-${row.id}`, topic: "agent.events", aggregateId: owner.sessionId, idempotencyKey: `agent-event:${row.id}`,
          payload: eventOutboxPayload({ owner, eventId: String(row.id), itemId: input.itemId, sequence: String(row.sequence), type: input.type, actor: String(row.actor), correlationId: input.correlationId, causationId: row.causationId === null ? null : String(row.causationId), idempotencyKey: input.idempotencyKey, payload: input.payload }),
        })
        await projectRootTerminalEvent(client, owner, input.type, String(row.id))
        result.push({ id: String(row.id) }); previousId = String(row.id); continue
      }
      if (input.itemId) {
        const item = await client.query(`SELECT "id" FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4`, [input.itemId, owner.sessionId, owner.turnId, owner.taskId])
        if (!item.rows[0]) throw conflict(`item ${input.itemId}`)
      }
      const sequence = await client.query<{ eventSequence: bigint | string }>(`UPDATE "agent_sessions" SET "eventSequence" = "eventSequence" + 1 WHERE "id" = $1 AND "userId" = $2 RETURNING "eventSequence"`, [owner.sessionId, owner.userId])
      const next = sequence.rows[0]?.eventSequence
      if (next === undefined) throw conflict(`session ${owner.sessionId}`)
      await client.query(`INSERT INTO "agent_events" ("id", "sessionId", "turnId", "itemId", "taskId", "sequence", "type", "actor", "correlationId", "causationId", "idempotencyKey", "payload") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)`, [input.id, owner.sessionId, owner.turnId, input.itemId, owner.taskId, BigInt(next).toString(), input.type, actor, input.correlationId, causationId, input.idempotencyKey, json(input.payload)])
      await client.query(`INSERT INTO "agent_outbox" ("id", "topic", "aggregateId", "idempotencyKey", "payload") VALUES ($1, 'agent.events', $2, $3, $4::jsonb)`, [`agent-outbox-${input.id}`, owner.sessionId, `agent-event:${input.id}`, json({ eventId: input.id, sessionId: owner.sessionId, turnId: owner.turnId, taskId: owner.taskId, itemId: input.itemId, sequence: BigInt(next).toString(), type: input.type, actor, correlationId: input.correlationId, causationId, idempotencyKey: input.idempotencyKey, payload: input.payload })])
      await projectRootTerminalEvent(client, owner, input.type, input.id)
      result.push({ id: input.id }); previousId = input.id
    }
    return result
  }
  return transactionClient ? append(transactionClient) : tenantTransaction(pool, owner.userId, append)
}
async function commitTaskGraphNoProgress(pool: TurnEnginePool, owner: ExecutionOwnerFence, response: string, now: Date, denial: AtomicTurnNoProgressInput): Promise<AtomicTurnNoProgressResult> {
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId || denial.reasonCode !== "repeated_signature" || denial.signature !== "task_graph_terminal_denial" || denial.stateFingerprint !== denial.signature) throw conflict("TaskGraph no-progress identity")
  return tenantTransaction(pool, owner.userId, async client => {
    if (!await lockOpenSession(client, owner) || !await lockOwnedTurn(client, owner)) throw conflict(`turn ${owner.turnId}`)
    await assertSessionWorkAdmission(client, owner)
    const step = await client.query<Row>(`SELECT "status", "inputThroughSequence", "consumedInputIds" FROM "agent_steps" WHERE "id"=$1 AND "sessionId"=$2 AND "turnId"=$3 AND "taskId"=$4 AND "attempt"=1 FOR UPDATE`, [denial.stepId, owner.sessionId, owner.turnId, owner.taskId])
    if (!step.rows[0] || step.rows[0].status !== "streaming" || String(step.rows[0].inputThroughSequence) !== denial.inputThroughSequence.toString() || !sameJson(step.rows[0].consumedInputIds, denial.consumedInputIds)) throw conflict(`no-progress Step ${denial.stepId} fence`)
    const pending = await client.query<Row>(`SELECT "id" FROM "agent_inputs" WHERE "sessionId"=$1 AND "userId"=$2 AND "targetTurnId"=$3 AND "delivery"='steer' AND "status" IN ('accepted','queued','consumed') AND "cancelledAt" IS NULL AND "acceptedSequence">$4 FOR UPDATE`, [owner.sessionId, owner.userId, owner.turnId, denial.inputThroughSequence.toString()])
    if (pending.rows.length) return { status: "input_changed" }
    const start = await client.query<Row>(`SELECT "id" FROM "agent_events" WHERE "sessionId"=$1 AND "turnId"=$2 AND "idempotencyKey"=$3`, [owner.sessionId, owner.turnId, `turn:${owner.turnId}:event:step-started:${denial.stepId}`])
    if (!start.rows[0]) throw conflict(`no-progress Step start ${denial.stepId}`)
    const item = await client.query(`INSERT INTO "agent_items" ("id","sessionId","turnId","stepId","taskId","type","status","phase","revision","content","startedAt","completedAt","updatedAt") VALUES ($1,$2,$3,$4,$5,'agent_message','completed','final_answer',1,$6::jsonb,$7,$7,$7) ON CONFLICT ("id") DO NOTHING RETURNING "id"`, [denial.finalItemId, owner.sessionId, owner.turnId, denial.stepId, owner.taskId, json(denial.finalContent), now])
    if (item.rowCount !== 1) throw conflict(`no-progress final item ${denial.finalItemId}`)
    const closed = await client.query(`UPDATE "agent_steps" SET "status"='failed',"finishReason"=NULL,"errorCode"='no_progress',"inputTokens"=0,"outputTokens"=0,"estimatedCostUsd"=0,"completedAt"=$1 WHERE "id"=$2 AND "sessionId"=$3 AND "turnId"=$4 AND "taskId"=$5 AND "status"='streaming'`, [now, denial.stepId, owner.sessionId, owner.turnId, owner.taskId])
    if (closed.rowCount !== 1) throw conflict(`no-progress Step ${denial.stepId} close`)
    const guard = ownerFenceSql(owner, 3)
    const turn = await client.query(`UPDATE "agent_turns" AS turn SET "finalResponse"=$7,"error"='no_progress',"revision"="revision"+1,"updatedAt"=$8 ${guard.joins} WHERE turn."id"=$1 AND turn."sessionId"=$2 AND ${guard.where}`, [owner.turnId, owner.sessionId, ...guard.values, response, now])
    if (turn.rowCount !== 1) throw conflict(`no-progress Turn ${owner.turnId}`)
    const prefix = `turn:${owner.turnId}:event:`, final = JSON.parse(response) as RepositoryJsonValue
    const entries = [
      { suffix: `step-failed:${denial.stepId}`, type: "step.completed", itemId: null, correlationId: denial.stepId, payload: { stepId: denial.stepId, status: "failed", errorCode: "no_progress", taskId: owner.taskId } },
      { suffix: "turn-no-progress", type: "turn.no_progress", itemId: null, correlationId: owner.turnId, payload: { reasonCode: denial.reasonCode, signature: denial.signature, stateFingerprint: denial.stateFingerprint, taskId: owner.taskId } },
      { suffix: `item-started:${denial.finalItemId}`, type: "item.started", itemId: denial.finalItemId, correlationId: denial.stepId, payload: { itemId: denial.finalItemId, type: "agent_message", phase: "final_answer" } },
      { suffix: `final-completed:${denial.finalItemId}:1`, type: "item.completed", itemId: denial.finalItemId, correlationId: denial.finalItemId, payload: { itemId: denial.finalItemId, status: "completed", content: denial.finalContent } },
      { suffix: "turn-failed:no_progress", type: "turn.failed", itemId: denial.finalItemId, correlationId: owner.turnId, payload: { turnId: owner.turnId, taskId: owner.taskId, errorCode: "no_progress", finalItemId: denial.finalItemId, final } },
    ]
    const inputs = entries.map((entry, index): TurnEngineEventInput => ({ owner, id: `${prefix}${entry.suffix}`, itemId: entry.itemId, type: entry.type, correlationId: entry.correlationId, causationId: index ? null : String(start.rows[0]!.id), idempotencyKey: `${prefix}${entry.suffix}`, payload: toRepositoryJson(entry.payload) }))
    const saved = await appendEventBatch(pool, inputs, client)
    return { status: "no_progress", finalItemId: denial.finalItemId, events: entries.map((entry, index) => ({ id: saved[index]!.id, type: entry.type, itemId: entry.itemId, correlationId: entry.correlationId, causationId: index ? saved[index - 1]!.id : String(start.rows[0]!.id), payload: toRepositoryJson(entry.payload) })) }
  })
}
export function createPgTurnEngineStore(pool: TurnEnginePool, terminalGuard?: TurnEngineTerminalGuard): TurnEngineStore {
  return attachTurnQuestionStore({
    async resolveNativeSemanticProgressMode(input) {
      try { return await tenantTransaction(pool, input.owner.userId, client => resolveNativeSemanticProgressModeWithClient(client, input)) }
      catch (error: unknown) { return nativeSemanticSchemaConflict(error) }
    },
    async readNativeSemanticRejections(input) {
      try { return await tenantTransaction(pool, input.owner.userId, client => readNativeSemanticRejectionsWithClient(client, input)) }
      catch (error: unknown) { return nativeSemanticSchemaConflict(error) }
    },
    async completeNativeSemanticRejectionStep(input) {
      try { return await tenantTransaction(pool, input.owner.userId, client => completeNativeSemanticRejectionStepWithClient(client, input)) }
      catch (error: unknown) { return nativeSemanticSchemaConflict(error) }
    },
    async startStep(input): Promise<TurnEngineStep> {
      const actualAttempt = input.owner.kind === "task" ? input.owner.attemptCount : 1
      if (input.attempt !== actualAttempt) throw conflict(`step ${input.stepId} attempt`)
      const client = await pool.connect(); let committed = false
      try {
        await client.query("BEGIN")
        await client.query("SELECT set_config($1, $2, true)", ["app.user_id", input.owner.userId])
        if (!await lockOpenSession(client, input.owner)) throw conflict(`step ${input.stepId}`)
        const fence = ownerFenceSql(input.owner, 1)
        const owned = input.owner.kind === "turn"
          ? await client.query<Row>(`SELECT turn."id" FROM "agent_turns" AS turn ${fence.joins} WHERE turn."id" = $5 AND turn."sessionId" = $6 AND ${fence.where} FOR UPDATE`, [...fence.values, input.owner.turnId, input.owner.sessionId])
          : await client.query<Row>(`SELECT turn."id" FROM "agent_turns" AS turn ${fence.joins} WHERE turn."id" = $3 AND turn."sessionId" = $2 AND ${fence.where} FOR UPDATE`, fence.values as unknown[])
        if (!owned.rows[0]) throw conflict(`step ${input.stepId}`)
        await assertSessionWorkAdmission(client, input.owner)
        const existing = await client.query<Row>(`SELECT "id", "ordinal", "taskId", "attempt", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot"
          FROM "agent_steps" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 FOR UPDATE`, [input.stepId, input.owner.sessionId, input.owner.turnId])
        if (existing.rows[0]) {
          const row = existing.rows[0]
          if (row.taskId !== input.owner.taskId || Number(row.attempt) !== input.attempt || String(row.inputThroughSequence) !== input.inputThroughSequence.toString()
            || !sameJson(row.consumedInputIds, input.consumedInputIds) || !sameJson(row.modelProfileSnapshot, input.modelProfileSnapshot)) throw conflict(`step ${input.stepId} identity`)
          await client.query("COMMIT"); committed = true
          return { id: String(row.id), ordinal: Number(row.ordinal) }
        }
        await enforceRootStepAndUsageBudgets(client, input.owner)
        const ordinalResult = await client.query<{ ordinal: number | string }>(`SELECT COALESCE(MAX("ordinal"), -1) + 1 AS "ordinal" FROM "agent_steps" WHERE "turnId" = $1 AND "sessionId" = $2`, [input.owner.turnId, input.owner.sessionId])
        const ordinal = Number(ordinalResult.rows[0]?.ordinal ?? 0)
        const result = await client.query<{ id: string }>(`INSERT INTO "agent_steps"
          ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot", "startedAt")
          VALUES ($1, $2, $3, $4, $5, $6, 'streaming', $7, $8::jsonb, $9::jsonb, $10) RETURNING "id"`, [input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId, ordinal, input.attempt, input.inputThroughSequence.toString(), json([...input.consumedInputIds]), json(input.modelProfileSnapshot), input.now])
        if (!result.rows[0]) throw conflict(`step ${input.stepId}`)
        await client.query("COMMIT"); committed = true
        return { id: result.rows[0].id, ordinal }
      } catch (error: unknown) { if (!committed) await client.query("ROLLBACK").catch(() => undefined); throw error }
      finally { client.release() }
    },
    async updateStep(input): Promise<void> {
      return tenantTransaction(pool, input.owner.userId, async client => {
        if (!await lockOpenSession(client, input.owner)) throw conflict(`step ${input.stepId}`)
        if (!await lockOwnedTurn(client, input.owner, true)) throw conflict(`step ${input.stepId}`)
        const attempt = input.owner.kind === "task" ? input.owner.attemptCount : 1
        const guard = ownedTurn(input.owner, 13, 10, 9, true)
        const result = await client.query(`UPDATE "agent_steps" AS step SET "status" = $1, "finishReason" = $2, "errorCode" = $3,
          "inputTokens" = $4, "outputTokens" = $5, "estimatedCostUsd" = $6,
          "completedAt" = CASE WHEN $1 IN ('completed', 'failed', 'interrupted', 'waiting_for_tool', 'waiting_for_approval', 'waiting_for_user') THEN $7::timestamp(3) ELSE NULL::timestamp(3) END
          ${guard.sql} AND step."id" = $8 AND step."sessionId" = $9 AND step."turnId" = $10 AND step."taskId" = $11 AND step."attempt" = $12
          AND turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"`, [input.status, input.finishReason, input.errorCode, input.inputTokens, input.outputTokens, input.estimatedCostUsd, input.now, input.stepId, input.owner.sessionId, input.owner.turnId, input.owner.taskId, attempt, ...guard.values])
        if (result.rowCount !== 1) throw conflict(`step ${input.stepId}`)
      })
    },
    async finalizeScheduledPrepareCancellationStep(input): Promise<void> {
      if (!Number.isSafeInteger(input.inputTokens) || input.inputTokens < 0 || input.inputTokens > 2_147_483_647
        || !Number.isSafeInteger(input.outputTokens) || input.outputTokens < 0 || input.outputTokens > 2_147_483_647
        || !Number.isFinite(input.estimatedCostUsd) || input.estimatedCostUsd < 0 || input.estimatedCostUsd >= 10_000) {
        throw conflict(`step ${input.stepId} usage`)
      }
      const owner = input.owner
      const ownerKind: unknown = owner.kind
      if (ownerKind !== "task") throw conflict(`interrupted step ${input.stepId} owner kind`)
      if (!input.stepId.startsWith("scheduled-prepare-model:")) throw conflict(`interrupted step ${input.stepId} namespace`)
      return tenantTransaction(pool, owner.userId, async client => {
        if (!await lockOpenSession(client, owner)) throw conflict(`interrupted step ${input.stepId} session`)
        // Cancellation can clear this task's lease before the exact Scheduled Prepare model step unwinds.
        const authorized = await client.query<Row>(`SELECT turn."id" FROM "agent_turns" AS turn
          JOIN "sub_agent_tasks" AS owner_task ON owner_task."id" = $4 AND owner_task."sessionId" = turn."sessionId"
            AND owner_task."turnId" = turn."id" AND owner_task."rootTaskId" = $5
          JOIN "sub_agent_tasks" AS root_task ON root_task."id" = $5 AND root_task."sessionId" = turn."sessionId"
            AND root_task."turnId" = turn."id" AND root_task."rootTaskId" = root_task."id"
          WHERE turn."userId" = $1 AND turn."sessionId" = $2 AND turn."id" = $3 AND turn."rootTaskId" = $5
            AND owner_task."attemptCount" = $7 AND owner_task."interruptRequestedAt" IS NOT NULL
            AND ((owner_task."status" = 'running' AND owner_task."leaseOwner" = $6
                AND date_trunc('milliseconds', owner_task."leaseExpiresAt") = date_trunc('milliseconds', $8::timestamptz)
                AND owner_task."leaseExpiresAt" > clock_timestamp())
              OR (owner_task."status" = 'interrupted' AND owner_task."leaseOwner" IS NULL AND owner_task."leaseExpiresAt" IS NULL))
          FOR UPDATE OF turn, owner_task`, [owner.userId, owner.sessionId, owner.turnId, owner.taskId, owner.rootTaskId,
          owner.ownerId, owner.attemptCount, owner.leaseExpiresAt])
        if (!authorized.rows[0]) throw conflict(`interrupted step ${input.stepId} owner`)
        const updated = await client.query(`UPDATE "agent_steps" AS step SET "status" = 'interrupted',
          "finishReason" = 'cancelled', "errorCode" = 'scheduled_prepare_cancelled', "inputTokens" = $1,
          "outputTokens" = $2, "estimatedCostUsd" = $3, "completedAt" = $4::timestamp(3)
          WHERE step."id" = $5 AND step."sessionId" = $6 AND step."turnId" = $7 AND step."taskId" = $8
            AND step."attempt" = $9 AND step."status" = 'streaming' AND step."id" LIKE 'scheduled-prepare-model:%'`, [input.inputTokens, input.outputTokens,
          input.estimatedCostUsd, input.now, input.stepId, owner.sessionId, owner.turnId, owner.taskId, owner.attemptCount])
        if (updated.rowCount !== 1) throw conflict(`interrupted step ${input.stepId} lineage`)
      })
    },
    async waitForUser(input): Promise<void> {
      if (input.owner.kind !== "turn") throw conflict(`child wait ${input.owner.taskId}`)
      return tenantTransaction(pool, input.owner.userId, async client => {
        if (!await lockOpenSession(client, input.owner)) throw conflict(`session ${input.owner.sessionId}`)
        const guard = ownerFenceSql(input.owner, 4)
        const result = await client.query(`UPDATE "agent_turns" AS turn SET "status" = 'waiting_for_user', "revision" = "revision" + 1, "completedAt" = NULL, "updatedAt" = $1 ${guard.joins} WHERE turn."id" = $2 AND turn."sessionId" = $3 AND ${guard.where}`, [input.now, input.owner.turnId, input.owner.sessionId, ...guard.values])
        if (result.rowCount !== 1) throw conflict(`turn ${input.owner.turnId} wait state`)
      })
    },
    async createItem(input): Promise<TurnEngineItem> {
      return tenantTransaction(pool, input.owner.userId, async client => {
        if (!await lockOpenSession(client, input.owner)) throw conflict(`item ${input.itemId}`)
        const guard = ownedTurn(input.owner, 11, 3, 2, true)
        const stepAttempt = input.owner.kind === "task" ? 'owner_task."attemptCount"' : "1"
        if (!await lockOwnedTurn(client, input.owner, true)) throw conflict(`item ${input.itemId}`)
        await assertCurrentStepLineage(client, input.owner, input.stepId)
        if (input.type === "tool_call") await enforceRootToolCallBudget(client, input.owner, input.itemId)
        const result = await client.query<{ id: string; revision: number }>(`INSERT INTO "agent_items"
          ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "phase", "content", "startedAt", "updatedAt")
          SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $10 ${guard.sql}
          AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM "agent_steps" AS owner_step
            WHERE owner_step."id" = $4::text AND owner_step."turnId" = $3 AND owner_step."sessionId" = $2
              AND owner_step."taskId" = $5 AND owner_step."attempt" = ${stepAttempt}))
          ON CONFLICT ("id") DO NOTHING RETURNING "id", "revision"`, [input.itemId, input.owner.sessionId, input.owner.turnId, input.stepId, input.owner.taskId, input.type, input.status, input.phase, json(input.content), input.now, ...guard.values])
        if (result.rows[0]) return result.rows[0]
        const existing = await client.query<Row>(`SELECT item."id", item."revision", item."taskId", item."stepId", item."type", item."status", item."phase", item."content"
          FROM "agent_items" AS item JOIN "agent_turns" AS turn ON turn."id" = item."turnId"
          WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND turn."userId" = $4`, [input.itemId, input.owner.sessionId, input.owner.turnId, input.owner.userId])
        if (!existing.rows[0]) throw conflict(`item ${input.itemId}`)
        const row = existing.rows[0]
        if (row.taskId !== input.owner.taskId || row.stepId !== input.stepId || row.type !== input.type || row.status !== input.status
          || row.phase !== input.phase || !sameJson(row.content, input.content)) throw conflict(`item ${input.itemId} identity`)
        return { id: String(row.id), revision: Number(row.revision) }
      })
    },
    async updateItem(input): Promise<TurnEngineItem> {
      return tenantTransaction(pool, input.owner.userId, async client => {
        if (!await lockOpenSession(client, input.owner)) throw conflict(`item ${input.itemId}`)
        if (!await lockOwnedTurn(client, input.owner, true)) throw conflict(`item ${input.itemId}`)
        await assertCurrentItemLineage(client, input.owner, input.itemId)
        const guard = ownedTurn(input.owner, 12, 9, 8, true)
        const stepAttempt = input.owner.kind === "task" ? 'owner_task."attemptCount"' : "1"
        const result = await client.query<{ id: string; revision: number }>(`UPDATE "agent_items" AS item SET "status" = $1, "phase" = $2, "content" = $3::jsonb,
          "revision" = item."revision" + 1, "startedAt" = $4, "completedAt" = $5, "updatedAt" = $6 ${guard.sql}
          AND item."id" = $7 AND item."sessionId" = $8 AND item."turnId" = $9 AND item."taskId" = $10
          AND item."revision" = $11 AND turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
          AND (item."stepId" IS NULL OR EXISTS (SELECT 1 FROM "agent_steps" AS owner_step
            WHERE owner_step."id" = item."stepId" AND owner_step."turnId" = item."turnId" AND owner_step."sessionId" = item."sessionId"
              AND owner_step."taskId" = item."taskId" AND owner_step."attempt" = ${stepAttempt}))
          RETURNING item."id", item."revision"`, [input.status, input.phase, json(input.content), input.startedAt, input.completedAt, input.now, input.itemId, input.owner.sessionId, input.owner.turnId, input.owner.taskId, input.expectedRevision, ...guard.values])
        if (!result.rows[0]) throw conflict(`item ${input.itemId} revision ${input.expectedRevision}`)
        return result.rows[0]
      })
    },
    async appendEvent(input): Promise<{ id: string }> { return (await appendEventBatch(pool, [input]))[0]! },
    async appendEvents(inputs): Promise<readonly { id: string }[]> { return appendEventBatch(pool, inputs) },
    async recordFinalResponse(input) {
      if (input.owner.kind !== "turn") throw conflict(`child final response ${input.owner.taskId}`)
      if (input.terminal) return commitTurnTerminal(pool, { ...input.terminal, owner: input.owner, response: input.response, now: input.now }, terminalGuard)
      if (input.noProgress) return commitTaskGraphNoProgress(pool, input.owner, input.response, input.now, input.noProgress)
      return tenantTransaction(pool, input.owner.userId, async (client: QueryClient) => {
        if (!await lockOpenSession(client, input.owner)) throw conflict(`turn ${input.owner.turnId}`)
        const guard = ownerFenceSql(input.owner, 5, true)
        const result = await client.query(`UPDATE "agent_turns" AS turn SET "finalResponse" = $1, "updatedAt" = $2 ${guard.joins} WHERE turn."id" = $3 AND turn."sessionId" = $4 AND ${guard.where}`, [input.response, input.now, input.owner.turnId, input.owner.sessionId, ...guard.values])
        if (result.rowCount !== 1) throw conflict(`final response for turn ${input.owner.turnId}`)
      })
    },
  }, pool)
}
