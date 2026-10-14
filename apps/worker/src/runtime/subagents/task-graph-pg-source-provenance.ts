import type { PoolClient } from "pg"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { TaskGraphSnapshot } from "./task-graph-snapshot.js"
import {
  compareTaskGraphInputCursors, rememberTaskGraphSourceCheckpointMetadata, type TaskGraphInputRelation,
} from "./task-graph-source-intent-context.js"

type Queryable = Pick<PoolClient, "query">
type Row = Record<string, unknown>
export type PersistedTaskGraphProposalSource = Readonly<{ payload: unknown; causationId: unknown }>
export type PersistedTaskGraphProposalNode = Readonly<{ key: string; taskId: string }>
const MAX_PG_BIGINT = 9_223_372_036_854_775_807n

function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : null
}
function strictText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
}

/** Extract the persisted proposal receipt's node identities; callers validate the full receipt first. */
export function parsePersistedTaskGraphProposalNodes(value: unknown): readonly PersistedTaskGraphProposalNode[] {
  const payload = object(value), receipt = object(payload?.receipt)
  if (payload?.kind !== "proposal" || !receipt || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 1
    || !Array.isArray(receipt.nodes) || receipt.nodes.length === 0 || !Array.isArray(receipt.readyTaskIds)
    || receipt.readyTaskIds.some(id => typeof id !== "string")) throw new Error("task_graph_receipt_invalid")
  const nodes: PersistedTaskGraphProposalNode[] = []
  for (const value of receipt.nodes) {
    const node = object(value)
    if (!node || typeof node.key !== "string" || !node.key.trim() || typeof node.taskId !== "string" || !node.taskId.trim()
      || (node.status !== "queued" && node.status !== "waiting")) throw new Error("task_graph_receipt_invalid")
    nodes.push({ key: node.key, taskId: node.taskId })
  }
  return nodes
}

/** One bounded read restores every current node's server-causal Step checkpoint and the active Root Step. */
export async function loadTaskGraphSourceInputRelations(
  client: Queryable,
  scope: GraphIdentityScope,
  snapshot: TaskGraphSnapshot,
  proposals: readonly PersistedTaskGraphProposalSource[],
  currentStepId?: string,
): Promise<ReadonlyMap<string, TaskGraphInputRelation>> {
  const causes = collectProposalCauses(snapshot, proposals)
  const causalStepIds = [...new Set([...causes.values()].filter((value): value is string => value !== null))]
  const steps = await client.query(`WITH current_steps AS MATERIALIZED (
      SELECT step."id" FROM "agent_steps" AS step
      WHERE step."sessionId" = $4 AND step."turnId" = $5 AND step."taskId" = $3
        AND step."status" = 'streaming' AND ($2::text IS NULL OR step."id" = $2)
    ), requested AS (
      SELECT unnest($1::text[]) AS "id", FALSE AS "isCurrent"
      UNION ALL SELECT current_steps."id", TRUE FROM current_steps
    )
    SELECT step."id", step."sessionId", step."turnId", step."taskId", turn."rootTaskId" AS "rootTaskId",
      session."userId" AS "userId", step."inputThroughSequence", step."consumedInputIds",
      BOOL_OR(requested."isCurrent") AS "isCurrent"
    FROM requested
    JOIN "agent_steps" AS step ON step."id" = requested."id"
    JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
    WHERE step."sessionId" = $4 AND step."turnId" = $5 AND step."taskId" = $3
      AND turn."rootTaskId" = $6 AND turn."userId" = $7 AND session."userId" = $7
    GROUP BY step."id", step."sessionId", step."turnId", step."taskId", turn."rootTaskId", session."userId",
      step."inputThroughSequence", step."consumedInputIds"`,
  [causalStepIds, currentStepId ?? null, scope.parentTaskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  return resolveTaskGraphSourceInputRelations(snapshot, proposals, steps.rows, scope, currentStepId)
}

export function resolveTaskGraphSourceInputRelations(
  snapshot: TaskGraphSnapshot,
  proposals: readonly PersistedTaskGraphProposalSource[],
  values: readonly unknown[],
  scope: GraphIdentityScope,
  currentStepId?: string,
): ReadonlyMap<string, TaskGraphInputRelation> {
  const causes = collectProposalCauses(snapshot, proposals)
  const rows = values.map(object).filter((row): row is Row => row !== null && row.sessionId === scope.sessionId
    && row.turnId === scope.turnId && row.taskId === scope.parentTaskId && row.rootTaskId === scope.rootTaskId && row.userId === scope.userId)
  const current = rows.filter(row => row.isCurrent === true && (currentStepId === undefined || row.id === currentStepId))
  const currentCursor = current.length === 1 ? checkpointCursor(current[0]!) : undefined
  const trustedCurrentStepId = current.length === 1 && strictText(current[0]!.id) ? current[0]!.id as string : undefined
  const byStep = new Map<string, Row[]>()
  for (const row of rows) if (typeof row.id === "string") {
    const group = byStep.get(row.id) ?? []
    group.push(row); byStep.set(row.id, group)
  }
  const sourceInputCursors = new Map<string, bigint | undefined>()
  const sourceStepIds = new Map<string, string | undefined>()
  const relations = new Map(snapshot.nodes.map(node => {
    const cause = causes.get(node.key), matches = typeof cause === "string" ? byStep.get(cause) ?? [] : []
    const sourceCursor = matches.length === 1 ? checkpointCursor(matches[0]!) : undefined
    sourceInputCursors.set(node.key, sourceCursor)
    sourceStepIds.set(node.key, matches.length === 1 ? cause! : undefined)
    return [node.key, compareTaskGraphInputCursors(sourceCursor, currentCursor)] as const
  }))
  if (trustedCurrentStepId) rememberTaskGraphSourceCheckpointMetadata(relations, {
    currentStepId: trustedCurrentStepId, sourceStepIds, sourceInputCursors,
  })
  return relations
}

function collectProposalCauses(
  snapshot: TaskGraphSnapshot,
  proposals: readonly PersistedTaskGraphProposalSource[],
): Map<string, string | null> {
  const nodes = new Map(snapshot.nodes.map(node => [node.key, node.taskId] as const)), causes = new Map<string, string | null>()
  for (const proposal of proposals) {
    const payload = object(proposal.payload)
    if (payload?.kind !== "proposal") continue
    const receiptNodes = parsePersistedTaskGraphProposalNodes(payload), item = object(payload.item)
    const causalStepId = strictText(proposal.causationId) && item?.stepId === proposal.causationId ? proposal.causationId : null
    for (const node of receiptNodes) {
      if (nodes.get(node.key) !== node.taskId) continue
      const previous = causes.get(node.key)
      causes.set(node.key, causes.has(node.key) && previous !== causalStepId ? null : causalStepId)
    }
  }
  return causes
}

function checkpointCursor(row: Row): bigint | undefined {
  const cursor = parseCursor(row.inputThroughSequence), consumed = parseConsumedInputIds(row.consumedInputIds)
  if (cursor === undefined || !consumed || cursor === 0n && consumed.length > 0) return undefined
  return cursor
}

function parseCursor(value: unknown): bigint | undefined {
  try {
    const cursor = typeof value === "bigint" ? value
      : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value)
        : typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value) ? BigInt(value) : undefined
    return cursor !== undefined && cursor >= 0n && cursor <= MAX_PG_BIGINT ? cursor : undefined
  } catch { return undefined }
}

function parseConsumedInputIds(value: unknown): readonly string[] | undefined {
  const parsed = object(value) ? null : typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!Array.isArray(parsed) || parsed.some(id => !strictText(id)) || new Set(parsed).size !== parsed.length) return undefined
  return parsed as string[]
}
