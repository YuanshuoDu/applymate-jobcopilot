import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { StoredAgentInput } from "./input-claim-store.js"

type QueryClient = Pick<pg.PoolClient, "query">
export type RootInputContextRow = {
  id: string; sessionId: string; targetTurnId: string | null; userId: string; clientMessageId: string
  delivery: string; status: string; content: unknown; acceptedSequence: bigint | string
  consumedByStepId: string | null; consumedAt: Date | string | null; createdAt: Date | string
}
type Lookup = { readonly sessionId: string; readonly turnId: string; readonly inputId: string }

export async function readRootInputContext(
  client: QueryClient, scope: TenantScope, input: Lookup,
  validateOwner: () => Promise<void>, mapInput: (row: RootInputContextRow) => StoredAgentInput,
): Promise<StoredAgentInput | null> {
  await validateOwner()
  const result = await client.query<RootInputContextRow>(
    `SELECT "id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence", "consumedByStepId", "consumedAt", "createdAt"
     FROM "agent_inputs"
     WHERE "id" = $4 AND "sessionId" = $1 AND "targetTurnId" = $2 AND "userId" = $3
       AND "delivery" IN ('steer', 'follow_up') AND "cancelledAt" IS NULL
       AND (("status" IN ('accepted', 'queued') AND "consumedByStepId" IS NULL AND "consumedAt" IS NULL)
         OR ("status" = 'consumed' AND "consumedByStepId" IS NOT NULL AND "consumedAt" IS NOT NULL))
     FOR SHARE`,
    [input.sessionId, input.turnId, scope.userId, input.inputId],
  )
  return result.rows[0] ? mapInput(result.rows[0]) : null
}
