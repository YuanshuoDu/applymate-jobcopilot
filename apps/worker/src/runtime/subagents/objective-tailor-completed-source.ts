import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import { parseObjectiveTailorFinalOutcomeSidecar } from "@jobcopilot/agent-protocol"
import { verifyCompletedObjectiveTailorWaveSlots, type ObjectiveTailorWaveCompletionWitness, type ObjectiveTailorWaveSlotOutcome } from "../canonical-objective-tailor-wave-completion.js"
import { readObjectiveTailorWaveInventory, type ObjectiveTailorWaveInventory } from "./objective-tailor-wave-inventory.js"
import { loadTaskGraph, type GraphIdentityScope, type LoadedGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphItemId } from "./task-graph-snapshot.js"

type Row = Record<string, unknown>
type Queryable = Pick<PoolClient, "query">
export type CompletedObjectiveTailorSourceEvidence = Readonly<{
  sourceTurnId: string; reviewTurnId: string; sourceRootTaskId: string; graphItemId: string; graphRevision: number; finalItemId: string
  witness: ObjectiveTailorWaveCompletionWitness; outcomes: readonly ObjectiveTailorWaveSlotOutcome[]
}>
type Input = Readonly<{ userId: string; sessionId: string; reviewTurnId: string; sourceTurnId: string; rootTaskId: string;
  graphItemId: string; graphRevision: number; selectedSlotIds: readonly string[] }>
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const MANIFEST_V1 = "agent-harness.v2.task-graph-sources.v1"
const MANIFEST_V2 = "agent-harness.v2.task-graph-sources.v2"

/** Reads a completed ordinary Objective source in the caller's owner-fenced transaction. */
export async function readCompletedObjectiveTailorSourceEvidence(
  client: Queryable, input: Input,
): Promise<CompletedObjectiveTailorSourceEvidence | undefined> {
  try { return await readSource(client, input) } catch { return undefined }
}

async function readSource(client: Queryable, input: Input): Promise<CompletedObjectiveTailorSourceEvidence | undefined> {
  if (!validIds(input) || input.reviewTurnId === input.sourceTurnId || !validSlots(input.selectedSlotIds)) return undefined
  if (!one(await client.query(`SELECT "id" FROM "User" WHERE "id" = $1 FOR UPDATE NOWAIT`, [input.userId]), input.userId)) return undefined
  if (!one(await client.query(`SELECT "id" FROM "agent_sessions" WHERE "id" = $1 AND "userId" = $2 AND "status" NOT IN ('aborted','archived') FOR SHARE NOWAIT`,
    [input.sessionId, input.userId]), input.sessionId)) return undefined
  const review = await client.query(`SELECT "id", "status", "source" FROM "agent_turns" WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR SHARE NOWAIT`,
    [input.reviewTurnId, input.sessionId, input.userId])
  if (review.rows.length !== 1 || review.rows[0]?.id !== input.reviewTurnId || review.rows[0].status !== "in_progress" || review.rows[0].source !== "user") return undefined
  const source = await client.query(`SELECT "id", "rootTaskId", "status", "source", "executionMode" FROM "agent_turns"
    WHERE "id" = $1 AND "sessionId" = $2 AND "userId" = $3 FOR SHARE NOWAIT`, [input.sourceTurnId, input.sessionId, input.userId])
  const turn = source.rows[0] as Row | undefined
  if (source.rows.length !== 1 || turn?.id !== input.sourceTurnId || turn.rootTaskId !== input.rootTaskId
    || turn.status !== "completed" || turn.source !== "user"
    || turn.executionMode !== "canonical_task_graph" || !safeId(turn.rootTaskId)) return undefined
  const root = await client.query(`SELECT task."id", task."attemptCount", task."result" FROM "sub_agent_tasks" AS task
    JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = task."id"
      AND task."parentTaskId" IS NULL AND task."role" = 'orchestrator' AND task."taskType" = 'root' AND task."status" = 'completed'
      AND turn."rootTaskId" = task."id" AND turn."status" = 'completed' AND turn."userId" = $4 AND session."userId" = $4
    FOR SHARE OF task NOWAIT`, [input.rootTaskId, input.sessionId, input.sourceTurnId, input.userId])
  if (root.rows.length !== 1 || root.rows[0]?.id !== turn.rootTaskId || !positiveInteger(root.rows[0]?.attemptCount)) return undefined
  const scope: GraphIdentityScope = { userId: input.userId, sessionId: input.sessionId, turnId: input.sourceTurnId,
    rootTaskId: input.rootTaskId, parentTaskId: input.rootTaskId }
  const loaded = await loadTaskGraph(client, scope, true)
  if (!loaded.item || !loaded.snapshot || !loaded.state || loaded.rootTaskId !== scope.rootTaskId
    || loaded.discoveryTurnEligibility !== "ordinary" || loaded.item.id !== taskGraphItemId(scope.rootTaskId)
    || loaded.item.id !== input.graphItemId || loaded.item.revision !== input.graphRevision
    || !hasOwn(loaded.snapshot, "objectiveTailor") || !hasOwn(loaded.state, "objectiveTailor")) return undefined
  const ids = loaded.snapshot.nodes.map(node => node.taskId)
  const locked = await client.query(`SELECT task."id", task."status", task."role", task."taskType", task."result", task."context"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
      AND task."parentTaskId" = $5 AND session."userId" = $6 ORDER BY task."id" FOR SHARE OF task NOWAIT`,
    [ids, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId])
  if (!sameLockedTasks(locked.rows, loaded)) return undefined
  const reread = await loadTaskGraph(client, scope, true)
  if (!sameLoadedGraph(loaded, reread)) return undefined
  const inventory = await readObjectiveTailorWaveInventory(client, scope, reread)
  if (!inventory?.marker || inventory.graphRevision !== input.graphRevision || inventory.graphRevision !== reread.item?.revision) return undefined
  const terminal = await readTerminalItem(client, input, scope, inventory.graphRevision, inventory, reread)
  const rootResult = record(root.rows[0]?.result)
  if (!terminal || rootResult?.status !== "completed" || rootResult.finalItemId !== terminal.finalItemId) return undefined
  const completed = await verifyCompletedObjectiveTailorWaveSlots({ client: client as PoolClient, scope, loaded: reread,
    selectedSlotIds: input.selectedSlotIds })
  if (completed.status !== "ready" || completed.outcomes.length !== input.selectedSlotIds.length
    || completed.outcomes.some(value => value.status !== "ready" || !input.selectedSlotIds.includes(value.slotId))) return undefined
  for (const slotId of input.selectedSlotIds) {
    const ordinal = Number(slotId.slice(7))
    if (terminal.outcomes.slots[ordinal - 1]?.status !== "ready") return undefined
  }
  return { sourceTurnId: input.sourceTurnId, reviewTurnId: input.reviewTurnId, sourceRootTaskId: scope.rootTaskId,
    graphItemId: reread.item.id, graphRevision: reread.item.revision, finalItemId: terminal.finalItemId,
    witness: completed.witness, outcomes: completed.outcomes }
}

async function readTerminalItem(client: Queryable, input: Input, scope: GraphIdentityScope, revision: number,
  inventory: ObjectiveTailorWaveInventory, loaded: LoadedGraph): Promise<{ finalItemId: string; outcomes: NonNullable<ReturnType<typeof parseObjectiveTailorFinalOutcomeSidecar>> } | undefined> {
  const event = await client.query(`SELECT event."id", event."itemId", event."taskId", event."actor", event."idempotencyKey", event."payload"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = 'turn.completed'
      AND event."idempotencyKey" = $3 AND session."userId" = $4`,
    [scope.sessionId, scope.turnId, `turn:${scope.turnId}:event:turn-completed`, scope.userId])
  const row = event.rows[0] as Row | undefined, payload = record(row?.payload)
  const finalItemId = payload?.finalItemId
  if (event.rows.length !== 1 || !row || row.actor !== "orchestrator" || row.taskId !== scope.rootTaskId
    || !safeId(finalItemId) || row.itemId !== finalItemId || payload?.turnId !== scope.turnId || payload.taskId !== scope.rootTaskId) return undefined
  const itemResult = await client.query(`SELECT item."id", item."type", item."status", item."phase", item."content"
    FROM "agent_items" AS item JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
    WHERE item."id" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."taskId" = $4
      AND item."type" = 'agent_message' AND item."status" = 'completed' AND item."phase" = 'final_answer' AND session."userId" = $5
    FOR SHARE OF item NOWAIT`, [finalItemId, scope.sessionId, scope.turnId, scope.rootTaskId, input.userId])
  const item = itemResult.rows[0] as Row | undefined, content = record(item?.content), final = record(content?.final)
  if (itemResult.rows.length !== 1 || item?.id !== finalItemId || typeof content?.text !== "string"
    || final?.schemaVersion !== "agent-harness.v2.final" || final.response !== content.text) return undefined
  const outcomes = parseObjectiveTailorFinalOutcomeSidecar(content.objectiveTailorFinalOutcomes)
  if (!outcomes || outcomes.slots.length !== inventory.occupiedSlots.length
    || !validSourceManifest(content.taskGraphSources, finalItemId, revision, inventory, loaded)) return undefined
  return { finalItemId, outcomes }
}

function validSourceManifest(value: unknown, finalItemId: string, revision: number, inventory: ObjectiveTailorWaveInventory,
  loaded: LoadedGraph): boolean {
  const row = record(value)
  if (!row || ![MANIFEST_V1, MANIFEST_V2].includes(String(row.schemaVersion)) || row.graphRevision !== revision
    || !dense(row.sources, 8)) return false
  const allowed = row.schemaVersion === MANIFEST_V1 ? "graphRevision,schemaVersion,sources" : "graphRevision,historicalNodeIndices,schemaVersion,sources"
  if (!exactKeys(row, allowed)) return false
  let historical: unknown[] = []
  if (row.schemaVersion === MANIFEST_V2) {
    const indices = row.historicalNodeIndices
    if (!dense(indices, 40) || indices.some((value, index) => !Number.isSafeInteger(value) || Number(value) < 0
      || Number(value) >= inventory.sourceNodeCount || index > 0 && Number(value) <= Number(indices[index - 1]))) return false
    historical = indices
  }
  const sourceIndices = inventory.sourceSnapshot.nodes.map((_node, index) => index).filter(index => !historical.includes(index))
  if (sourceIndices.length !== row.sources.length) return false
  return row.sources.every((raw, index) => {
    const source = record(raw), nodeIndex = sourceIndices[index], node = nodeIndex === undefined ? undefined : inventory.sourceSnapshot.nodes[nodeIndex]
    if (!source || !node || !exactKeys(source, "nodeIndex,role,roleResultStatus,sourceKey,taskStatus,resultState")) return false
    const sourceKey = `src_${createHash("sha256").update(`taskGraphSource:v1\0${finalItemId}\0${revision}\0${nodeIndex}`).digest("base64url")}`
    return source.nodeIndex === nodeIndex && source.sourceKey === sourceKey && source.role === node.templateId
      && (source.role === "scout" || source.role === "analyst") && source.taskStatus === loaded.tasks.get(node.taskId)?.status
      && source.resultState === "valid" && (source.roleResultStatus === "completed" || source.roleResultStatus === "partial")
  })
}

function sameLockedTasks(rows: readonly Row[], loaded: LoadedGraph): boolean {
  const ids = loaded.snapshot?.nodes.map(node => node.taskId) ?? []
  if (rows.length !== ids.length || new Set(rows.map(row => row.id)).size !== ids.length) return false
  return rows.every(row => {
    const task = loaded.tasks.get(String(row.id))
    return Boolean(task && row.status === task.status && row.role === task.role && row.taskType === task.taskType
      && canonicalTaskGraphJson(row.result ?? null) === canonicalTaskGraphJson(task.result ?? null))
  })
}
function sameLoadedGraph(left: LoadedGraph, right: LoadedGraph): boolean {
  return Boolean(left.item && right.item && left.item.revision === right.item.revision && left.item.id === right.item.id
    && left.snapshot && right.snapshot && canonicalTaskGraphJson(left.snapshot) === canonicalTaskGraphJson(right.snapshot)
    && left.state && right.state && canonicalTaskGraphJson(left.state) === canonicalTaskGraphJson(right.state)
    && [...left.tasks].every(([id, task]) => canonicalTaskGraphJson(task) === canonicalTaskGraphJson(right.tasks.get(id))))
}
function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? parseJson(value) : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return (prototype === Object.prototype || prototype === null) ? parsed as Row : undefined }
  catch { return undefined }
}
function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown } catch { return undefined } }
function exactKeys(value: Row, csv: string): boolean {
  const keys = csv.split(","), actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === "string" && keys.includes(key)
    && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!))
}
function dense(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}
function one(result: { rows: Row[] }, id: string): boolean { return result.rows.length === 1 && result.rows[0]?.id === id }
function validIds(value: Input): boolean {
  return [value.userId, value.sessionId, value.reviewTurnId, value.sourceTurnId, value.rootTaskId, value.graphItemId].every(safeId)
    && Number.isSafeInteger(value.graphRevision) && value.graphRevision > 0
}
function validSlots(value: readonly string[]): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= 8 && Reflect.ownKeys(value).length === value.length + 1
    && value.every((id, index) => /^tailor-[1-8]$/.test(id) && (index === 0 || Number(id.slice(7)) > Number(value[index - 1]?.slice(7))))
    && new Set(value).size === value.length
}
function safeId(value: unknown): value is string { return typeof value === "string" && ID.test(value) && value.trim() === value }
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function hasOwn(value: unknown, key: string): boolean { return value !== null && typeof value === "object" && Object.hasOwn(value, key) }
