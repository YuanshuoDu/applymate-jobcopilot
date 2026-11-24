import { createHash } from "node:crypto"
import type pg from "pg"
import { parseObjectiveTailorGraph, type ObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import { isTaskGraphTerminal } from "../planning/task-graph-transition-rules.js"
import { readScheduledDraftAnalystProof } from "./scheduled-draft-candidate-analyst-proof.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { makeObjectiveTailorWaveCandidateSelection, objectiveTailorWavePairPlan,
  parseObjectiveTailorWaveCandidateWitness, type ObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
type SourcePrefix = Omit<ObjectiveTailorWaveInventory, "sourceGraphRevision" | "occupiedSlots" | "occupiedJobIds" | "marker"> & Readonly<{
  sourceGraphRevision?: number
}>
export type ObjectiveTailorWaveOccupiedSlot = Readonly<{
  slotId: string
  jobId: string
  sourceAnalystNodeKey: string
  witness: ObjectiveTailorWaveCandidateWitness
  writerTaskId: string
  reviewerTaskId: string
}>
export type ObjectiveTailorWaveInventory = Readonly<{
  graphRevision: number
  sourceNodeCount: number
  sourceGraphRevision: number
  sourceGraphDigest: string
  sourceStatusDigest: string
  sourceSnapshot: TaskGraphSnapshot
  occupiedSlots: readonly ObjectiveTailorWaveOccupiedSlot[]
  occupiedJobIds: readonly string[]
  marker: ObjectiveTailorGraph | null
}>

/** Rebuilds marked V2 occupancy and its immutable typed prefix on the caller's exact owner client. */
export async function readObjectiveTailorWaveInventory(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph,
): Promise<ObjectiveTailorWaveInventory | undefined> {
  const graph = exactGraph(scope, loaded)
  if (!graph) return undefined
  const rows = await readMarkedRows(client, scope)
  const marker = graph.snapshot.objectiveTailor ?? null
  if (!marker) {
    if (graph.state.objectiveTailor || rows.length || graph.snapshot.nodes.some(node => isTailorNode(node.templateId))) return undefined
    const source = sourceInventory(graph, graph.snapshot.nodes.length, graph.item.revision)
    return source && { ...source, sourceGraphRevision: source.graphRevision, occupiedSlots: [], occupiedJobIds: [], marker: null }
  }
  const parsed = parseObjectiveTailorGraph(marker, graph.snapshot.nodes)
  if (!parsed || !graph.state.objectiveTailor
    || canonicalTaskGraphJson(parsed) !== canonicalTaskGraphJson(graph.state.objectiveTailor)
    || parsed.slots.some(slot => slot.correction) || rows.length !== parsed.slots.length * 2) return undefined
  const source = sourceInventory(graph, parsed.sourceNodeCount)
  if (!source) return undefined
  const occupied: ObjectiveTailorWaveOccupiedSlot[] = [], jobs = new Set<string>(), analysts = new Map<string, Awaited<ReturnType<typeof readScheduledDraftAnalystProof>>>()
  for (const slot of parsed.slots) {
    const writer = graph.snapshot.nodes.find(node => node.key === slot.writerNodeKey)
    const reviewer = graph.snapshot.nodes.find(node => node.key === slot.reviewerNodeKey)
    const writerRow = rows.find(row => row.id === writer?.taskId), reviewerRow = rows.find(row => row.id === reviewer?.taskId)
    const witness = sameWitness(writerRow?.context, reviewerRow?.context)
    if (!writer || !reviewer || !writerRow || !reviewerRow || !witness || jobs.has(witness.candidate.jobId)
      || witness.slotId !== slot.slotId || witness.sourceAnalystKeys[0] !== slot.sourceAnalystNodeKey
      || witness.writerNodeKey !== writer.key || witness.reviewerNodeKey !== reviewer.key
      || witness.sourceGraphRevision >= witness.admittedRevision || witness.admittedRevision > graph.item.revision
      || witness.sourceGraphDigest !== source.sourceGraphDigest || witness.sourceStatusDigest !== source.sourceStatusDigest
      || !selectionMatches(scope, witness)) return undefined
    const pair = objectiveTailorWavePairPlan(witness), stateWriter = graph.state.nodes.find(node => node.key === writer.key)
    const stateReviewer = graph.state.nodes.find(node => node.key === reviewer.key)
    if (!pair || !stateWriter || !stateReviewer || !rowMatches(writerRow, scope, writer.taskId, "writer", "cover_letter_draft", stateWriter.status)
      || !rowMatches(reviewerRow, scope, reviewer.taskId, "reviewer", "cover_letter_review", stateReviewer.status)
      || graph.tasks.get(writer.taskId)?.role !== "writer" || graph.tasks.get(reviewer.taskId)?.role !== "reviewer"
      || graph.tasks.get(writer.taskId)?.status !== stateWriter.status || graph.tasks.get(reviewer.taskId)?.status !== stateReviewer.status
      || !matchesBaseContext(writerRow.context, pair.templatesByNodeKey.get(writer.key)?.context)
      || !matchesBaseContext(reviewerRow.context, pair.templatesByNodeKey.get(reviewer.key)?.context)) return undefined
    let proof = analysts.get(witness.sourceAnalystKeys[0])
    if (proof === undefined) {
      const sourceNode = source.sourceSnapshot.nodes.find(node => node.key === witness.sourceAnalystKeys[0])
      proof = sourceNode && await readScheduledDraftAnalystProof(client, scope, source.sourceSnapshot, sourceNode) || null
      if (!proof) return undefined
      analysts.set(witness.sourceAnalystKeys[0], proof)
    }
    const finding = proof.result.findings.filter(item => item.jobId === witness.candidate.jobId)
    if (sha256(proof.binding) !== witness.analystProofDigest || finding.length !== 1 || finding[0]?.score !== witness.candidate.score) return undefined
    jobs.add(witness.candidate.jobId)
    occupied.push({ slotId: slot.slotId, jobId: witness.candidate.jobId, sourceAnalystNodeKey: slot.sourceAnalystNodeKey,
      witness, writerTaskId: writer.taskId, reviewerTaskId: reviewer.taskId })
  }
  const sourceGraphRevision = occupied[0]?.witness.sourceGraphRevision
  if (sourceGraphRevision === undefined || occupied.some(slot => slot.witness.sourceGraphRevision !== sourceGraphRevision)) return undefined
  return { graphRevision: graph.item.revision, sourceNodeCount: parsed.sourceNodeCount, sourceGraphRevision,
    sourceGraphDigest: source.sourceGraphDigest, sourceStatusDigest: source.sourceStatusDigest, sourceSnapshot: source.sourceSnapshot,
    occupiedSlots: occupied, occupiedJobIds: [...jobs], marker: parsed }
}

function exactGraph(scope: GraphIdentityScope, loaded: LoadedGraph): { item: NonNullable<LoadedGraph["item"]>; snapshot: TaskGraphSnapshot; state: NonNullable<LoadedGraph["state"]>; tasks: LoadedGraph["tasks"] } | undefined {
  const { item, snapshot, state } = loaded
  if (!scopeValid(scope) || scope.parentTaskId !== scope.rootTaskId || loaded.discoveryTurnEligibility !== "ordinary"
    || loaded.rootTaskId !== scope.rootTaskId || !item || !snapshot || !state || item.id !== taskGraphItemId(scope.rootTaskId)
    || !Number.isSafeInteger(item.revision) || item.revision < 1 || state.revision !== item.revision
    || state.nodes.length !== snapshot.nodes.length || loaded.tasks.size !== snapshot.nodes.length) return undefined
  try {
    if (canonicalTaskGraphJson(parseTaskGraphSnapshot(item.content)) !== canonicalTaskGraphJson(snapshot)) return undefined
  } catch { return undefined }
  for (const node of snapshot.nodes) {
    const task = loaded.tasks.get(node.taskId), stateNode = state.nodes.find(item => item.key === node.key)
    if (!task || task.id !== node.taskId || !stateNode || stateNode.taskId !== node.taskId || stateNode.status !== task.status
      || stateNode.templateId !== node.templateId || canonicalTaskGraphJson(stateNode.dependsOn) !== canonicalTaskGraphJson(node.dependsOn)) return undefined
  }
  return { item, snapshot, state, tasks: loaded.tasks }
}

function sourceInventory(
  graph: NonNullable<ReturnType<typeof exactGraph>>, count: number, sourceGraphRevision?: number,
): SourcePrefix | undefined {
  if (!Number.isSafeInteger(count) || count < 2 || count > 8 || count > graph.snapshot.nodes.length) return undefined
  const sourceNodes = graph.snapshot.nodes.slice(0, count), sourceKeys = new Set(sourceNodes.map(node => node.key))
  if (sourceNodes.some(node => (node.templateId !== "scout" && node.templateId !== "analyst")
    || node.verificationDisposition !== "typed" || node.dependsOn.some(key => !sourceKeys.has(key))
    || graph.tasks.get(node.taskId)?.role !== node.templateId)) return undefined
  const sourceSnapshot = parseTaskGraphSnapshot({ schemaVersion: graph.snapshot.schemaVersion,
    ...(graph.snapshot.rootSuccessCriteria ? { rootSuccessCriteria: graph.snapshot.rootSuccessCriteria } : {}), nodes: sourceNodes })
  const sourceStates = graph.state.nodes.slice(0, count)
  if (sourceStates.length !== count || sourceStates.some((node, index) => node.key !== sourceNodes[index]?.key || !isTaskGraphTerminal(node.status))) return undefined
  const sourceGraphDigest = sha256(sourceSnapshot), sourceStatusDigest = sha256(sourceStates.map(node => ({ key: node.key, status: node.status })))
  return { graphRevision: graph.item.revision, sourceNodeCount: count,
    ...(sourceGraphRevision === undefined ? {} : { sourceGraphRevision }), sourceGraphDigest, sourceStatusDigest, sourceSnapshot }
}

async function readMarkedRows(client: Queryable, scope: GraphIdentityScope): Promise<Row[]> {
  const result = await client.query<Row>(`SELECT task."id", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
      task."role", task."taskType", task."status", task."context", session."userId" AS "userId",
      turn."rootTaskId" AS "turnRootTaskId", turn."userId" AS "turnUserId"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    WHERE task."sessionId" = $1 AND task."turnId" = $2 AND session."userId" = $3 AND turn."userId" = $3
      AND (task."context" ? 'objectiveTailorCandidateMode' OR task."context" ? 'objectiveTailorCandidateWitness')
    ORDER BY task."id"`, [scope.sessionId, scope.turnId, scope.userId])
  return result.rows.map(row => ({ ...row, context: parseJson(row.context) }))
}

function sameWitness(writerValue: unknown, reviewerValue: unknown): ObjectiveTailorWaveCandidateWitness | undefined {
  const writer = record(writerValue), reviewer = record(reviewerValue)
  if (!writer || !reviewer || writer.objectiveTailorCandidateMode !== true || reviewer.objectiveTailorCandidateMode !== true) return undefined
  const left = parseObjectiveTailorWaveCandidateWitness(writer.objectiveTailorCandidateWitness)
  const right = parseObjectiveTailorWaveCandidateWitness(reviewer.objectiveTailorCandidateWitness)
  return left && right && canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) ? left : undefined
}
function matchesBaseContext(value: unknown, expected: unknown): boolean {
  const context = record(value), template = record(expected)
  if (!context || !template) return false
  const base = { ...context }; delete base.taskGraphDependencyResults
  return canonicalTaskGraphJson(base) === canonicalTaskGraphJson(template)
}
function rowMatches(row: Row, scope: GraphIdentityScope, id: string, role: string, type: string, status: string): boolean {
  return row.id === id && row.sessionId === scope.sessionId && row.turnId === scope.turnId && row.rootTaskId === scope.rootTaskId
    && row.parentTaskId === scope.parentTaskId && row.userId === scope.userId && row.turnUserId === scope.userId
    && row.turnRootTaskId === scope.rootTaskId && row.role === role && row.taskType === type && row.status === status
}
function selectionMatches(scope: GraphIdentityScope, witness: ObjectiveTailorWaveCandidateWitness): boolean {
  const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: witness.sourceGraphRevision,
    sourceGraphDigest: witness.sourceGraphDigest, sourceStatusDigest: witness.sourceStatusDigest,
    analystProofDigest: witness.analystProofDigest, candidate: witness.candidate, sourceAnalystKey: witness.sourceAnalystKeys[0] })
  return selection?.candidateRef === witness.candidateRef
}
function record(value: unknown): Row | undefined {
  const parsed = parseJson(value)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try {
    const row = parsed as Row, keys = Reflect.ownKeys(row)
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(row, key)?.enumerable
        && "value" in Object.getOwnPropertyDescriptor(row, key)!) ? row : undefined
  } catch { return undefined }
}
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return undefined }
}
function scopeValid(scope: GraphIdentityScope): boolean {
  return [scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId]
    .every(value => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256)
}
function isTailorNode(value: string): boolean { return value === "cover_letter_writer" || value === "cover_letter_reviewer" }
function sha256(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
