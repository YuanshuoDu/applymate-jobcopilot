import type { ExecutionOwnerFence } from "../execution-owner.js"
import { lockTurnEngineOpenSession, lockTurnEngineOwnedTurn, type TurnEngineQueryClient, type TurnEngineRow } from "./turn-engine-owner-sql.js"
import { nativeSemanticSchemaConflict, type NativeSemanticProgressMode } from "./native-semantic-rejection-ledger.js"
import { TurnEngineError } from "./turn-engine-types.js"

function conflict(reason: string): TurnEngineError {
  return new TurnEngineError("persistence_conflict", `Native semantic persistence conflict: ${reason}`)
}

async function assertDurableDependencies(client: TurnEngineQueryClient): Promise<void> {
  const result = await client.query<{ tablePresent: boolean; canSelect: boolean; canInsert: boolean }>(`SELECT
    to_regclass('agent_native_semantic_rejections') IS NOT NULL AS "tablePresent",
    CASE WHEN to_regclass('agent_native_semantic_rejections') IS NULL THEN false
      ELSE has_table_privilege(current_user, to_regclass('agent_native_semantic_rejections'), 'SELECT') END AS "canSelect",
    CASE WHEN to_regclass('agent_native_semantic_rejections') IS NULL THEN false
      ELSE has_table_privilege(current_user, to_regclass('agent_native_semantic_rejections'), 'INSERT') END AS "canInsert"`)
  const row = result.rows[0]
  if (row?.tablePresent !== true || row.canSelect !== true || row.canInsert !== true) throw conflict("durable ledger schema or grants unavailable")
}

export async function resolveNativeSemanticProgressModeWithClient(
  client: TurnEngineQueryClient,
  input: { owner: ExecutionOwnerFence; requestedEnabled: boolean; now: Date },
): Promise<NativeSemanticProgressMode> {
  const { owner } = input
  if (owner.kind !== "turn" || owner.taskId !== owner.rootTaskId) throw conflict("mode owner must be the canonical root")
  if (!await lockTurnEngineOpenSession(client, owner) || !await lockTurnEngineOwnedTurn(client, owner)) throw conflict("mode owner fence")
  const current = await client.query<TurnEngineRow>(`SELECT to_jsonb(turn)->>'native_semantic_progress_mode' AS mode
    FROM "agent_turns" AS turn WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3`,
  [owner.turnId, owner.sessionId, owner.userId])
  const mode = current.rows[0]?.mode
  if (mode === "legacy_v1") return mode
  if (mode === "durable_v1") {
    try { await assertDurableDependencies(client) } catch (error: unknown) { return nativeSemanticSchemaConflict(error) }
    return mode
  }
  if (mode !== null && mode !== undefined) throw conflict("stored mode is invalid")
  if (!input.requestedEnabled) return "legacy_v1"

  try {
    const column = await client.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema()
        AND table_name = 'agent_turns' AND column_name = 'native_semantic_progress_mode') AS present`)
    if (column.rows[0]?.present !== true) throw conflict("mode column is unavailable")
    const prior = await client.query<{ present: boolean }>(`SELECT EXISTS (
      SELECT 1 FROM "agent_steps" WHERE "turnId" = $1 AND "sessionId" = $2) AS present`, [owner.turnId, owner.sessionId])
    const next: NativeSemanticProgressMode = prior.rows[0]?.present === true ? "legacy_v1" : "durable_v1"
    if (next === "durable_v1") await assertDurableDependencies(client)
    const saved = await client.query(`UPDATE "agent_turns" SET "native_semantic_progress_mode" = $1, "updatedAt" = $2
      WHERE "id" = $3 AND "sessionId" = $4 AND "userId" = $5 AND "native_semantic_progress_mode" IS NULL`,
    [next, input.now, owner.turnId, owner.sessionId, owner.userId])
    if (saved.rowCount !== 1) throw conflict("mode pin raced")
    return next
  } catch (error: unknown) {
    return nativeSemanticSchemaConflict(error)
  }
}
