import type pg from "pg"
import type { TenantScope } from "@jobcopilot/agent-protocol"

import { restoreCanonicalTurnSnapshot } from "./canonical-turn-snapshot-state.js"
import {
  CONTEXT_SNAPSHOT_COLUMNS_QUALIFIED,
  mapContextSnapshotRow,
  type ContextSnapshotRow,
} from "./context-snapshot-row.js"
import type { SelectedJobMemoryRecord } from "./selected-job-memory.js"
import type { StepContextSnapshot } from "./step-context-builder.js"

export type CanonicalTurnSnapshotLoad = Readonly<{
  snapshot: StepContextSnapshot
  selectedJobMemories?: readonly SelectedJobMemoryRecord[]
  throughSequence: bigint
}>

type SnapshotQueryClient = Pick<pg.PoolClient, "query">

const PINNED_SNAPSHOT_SQL = `SELECT ${CONTEXT_SNAPSHOT_COLUMNS_QUALIFIED}
  FROM "agent_context_snapshots" AS snapshot
  JOIN "agent_sessions" AS session ON session."id" = snapshot."sessionId"
  WHERE snapshot."id" = $1 AND snapshot."sessionId" = $2 AND session."userId" = $3`

const LATEST_SNAPSHOT_SQL = `SELECT ${CONTEXT_SNAPSHOT_COLUMNS_QUALIFIED}
  FROM "agent_context_snapshots" AS snapshot
  JOIN "agent_sessions" AS session ON session."id" = snapshot."sessionId"
  WHERE snapshot."sessionId" = $1 AND session."userId" = $2
  ORDER BY snapshot."throughSequence" DESC, snapshot."version" DESC LIMIT 1`

export async function loadCanonicalTurnSnapshot(
  client: SnapshotQueryClient,
  input: { readonly scope: TenantScope; readonly sessionId: string; readonly pinnedSnapshotId: unknown },
): Promise<CanonicalTurnSnapshotLoad | null> {
  const pinned = Boolean(input.pinnedSnapshotId)
  const result = pinned
    ? await client.query<ContextSnapshotRow>(PINNED_SNAPSHOT_SQL, [input.pinnedSnapshotId, input.sessionId, input.scope.userId])
    : await client.query<ContextSnapshotRow>(LATEST_SNAPSHOT_SQL, [input.sessionId, input.scope.userId])
  const row = result.rows[0]
  if (!row) {
    if (pinned) throw new Error("context_snapshot_missing")
    return null
  }

  const validated = mapContextSnapshotRow(row)
  const restored = restoreCanonicalTurnSnapshot(validated.content, validated.throughSequence, input.scope, input.sessionId)
  return { ...restored, throughSequence: validated.throughSequence }
}
