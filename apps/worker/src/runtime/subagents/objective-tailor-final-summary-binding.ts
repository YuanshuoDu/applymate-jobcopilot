import { createHash } from "node:crypto"
import type { PoolClient } from "pg"
import { parseObjectiveTailorGraph } from "@jobcopilot/agent-protocol"
import { isTaskGraphTerminal } from "../planning/task-graph-transition-rules.js"
import type { TurnLease } from "../turns/lease.js"
import {
  verifyCanonicalObjectiveTailorWaveCompletion,
  type ObjectiveTailorWaveCompletionWitness,
  type ObjectiveTailorWaveSlotStatus,
} from "../canonical-objective-tailor-wave-completion.js"
import { parseObjectiveTailorCorrectionProof } from "./objective-tailor-correction-witness.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId } from "./task-graph-snapshot.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import {
  deriveObjectiveReportedScoreFloorFromLoaded,
  parseObjectiveTailorFinalOutcome,
  OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA,
  type ObjectiveTailorFinalOutcomeProjection,
} from "./objective-reported-score-floor.js"
export { parseObjectiveTailorFinalOutcome, OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA }
export type { ObjectiveTailorFinalOutcomeProjection }

type OrdinarySummaryBuilder = (loaded: LoadedGraph, historical?: ReadonlySet<number>, resolved?: ReadonlySet<string>) => TaskGraphFinalSummaryBinding | null

const DIGEST = /^[a-f0-9]{64}$/
type SettledStatus = Exclude<ObjectiveTailorWaveSlotStatus, "pending">
const SLOT_STATUSES: readonly SettledStatus[] = ["ready", "needs_revision", "rejected", "stale", "failed"]
export type ObjectiveTailorFinalSummaryRead = Readonly<{ status: "unmarked" | "invalid" }>
  | Readonly<{ status: "ready"; root: Readonly<{ id: string; attemptCount: number }>; projection: ObjectiveTailorFinalOutcomeProjection }>

export async function buildCurrentTaskGraphFinalSummaryBinding(input: Readonly<{
  client: PoolClient; lease: TurnLease; rootTaskId: string; loaded: LoadedGraph
  historicalNodeIndices?: ReadonlySet<number>; resolvedRepairTaskIds?: ReadonlySet<string>
  buildOrdinary: OrdinarySummaryBuilder
}>): Promise<TaskGraphFinalSummaryBinding | null> {
  const read = await readObjectiveTailorFinalSummary(input)
  if (read.status === "unmarked") return input.buildOrdinary(input.loaded, input.historicalNodeIndices, input.resolvedRepairTaskIds)
  if (read.status !== "ready") return null
  const prefix = summaryPrefix(input.loaded, read.projection.sourceNodeCount)
  const history = prefixHistory(input.historicalNodeIndices, read.projection.sourceNodeCount, input.loaded.snapshot!.nodes.length)
  const base = input.buildOrdinary(prefix, history, input.resolvedRepairTaskIds)
  if (!base || base.graphRevision !== read.projection.graphRevision
    || base.rootTaskId !== input.loaded.rootTaskId || base.graphItemId !== input.loaded.item?.id) return null
  if (!base.members) return null
  const reportedScoreFloor = deriveObjectiveReportedScoreFloorFromLoaded({
    loaded: input.loaded,
    sourceNodes: prefix.snapshot!.nodes,
    effectiveAnalystTaskIds: base.members
      .filter(member => member.templateId === "analyst" && member.kind !== "historical")
      .map(member => member.taskId),
    summary: base.summary,
  })
  return { ...base, objectiveTailorFinalOutcome: { ...read.projection, reportedScoreFloor } }
}

/** Selects only the exact V2 marker; malformed or mixed markers never become V1 absence. */
export function hasObjectiveTailorWaveMarker(loaded: LoadedGraph): boolean {
  return hasOwn(loaded.snapshot, "objectiveTailor") || hasOwn(loaded.state, "objectiveTailor")
}

/** Resolves the actual leased Root row, then reuses the same-client V2 terminal proof. */
export async function readObjectiveTailorFinalSummary(input: Readonly<{
  client: PoolClient; lease: TurnLease; rootTaskId: string; loaded: LoadedGraph
}>): Promise<ObjectiveTailorFinalSummaryRead> {
  try {
    if (!hasObjectiveTailorWaveMarker(input.loaded)) return { status: "unmarked" }
    const root = await readOwnedRoot(input.client, input.lease, input.rootTaskId)
    if (!root) return { status: "invalid" }
    const verified = await verifyCanonicalObjectiveTailorWaveCompletion({
      client: input.client, lease: input.lease, root, loaded: input.loaded, allowAbsent: false,
    })
    if (verified.status !== "ready") return { status: "invalid" }
    const projection = projectOutcome(input.loaded, verified.witness, root.attemptCount)
    return projection ? { status: "ready", root, projection } : { status: "invalid" }
  } catch { return { status: "invalid" } }
}

export function hasObjectiveTailorFinalOutcome(value: unknown): boolean {
  const row = record(value)
  return Boolean(row && Object.hasOwn(row, "objectiveTailorFinalOutcome"))
}

export function readBoundObjectiveTailorFinalOutcome(value: unknown): ObjectiveTailorFinalOutcomeProjection | null {
  const row = record(value)
  if (!row || !Object.hasOwn(row, "objectiveTailorFinalOutcome")) return null
  try {
    const descriptor = Object.getOwnPropertyDescriptor(row, "objectiveTailorFinalOutcome")
    const outcome = descriptor?.enumerable && "value" in descriptor ? parseObjectiveTailorFinalOutcome(descriptor.value) : null
    const members = row.members
    if (!outcome || row.graphRevision !== outcome.graphRevision || row.summary && record(row.summary)?.graphRevision !== outcome.graphRevision
      || typeof row.rootTaskId !== "string" || !row.rootTaskId.trim()
      || typeof row.graphItemId !== "string" || row.graphItemId !== taskGraphItemId(row.rootTaskId) || !dense(members, 8) || members.length !== outcome.sourceNodeCount) return null
    const taskIds = new Set<string>()
    for (let index = 0; index < members.length; index += 1) {
      const member = record(members[index])
      if (!member || member.nodeIndex !== index || (member.templateId !== "scout" && member.templateId !== "analyst")
        || member.role !== member.templateId || typeof member.nodeKey !== "string" || !member.nodeKey.trim()
        || typeof member.taskType !== "string" || !member.taskType.trim() || typeof member.taskId !== "string" || !member.taskId.trim()
        || taskIds.has(member.taskId) || typeof member.taskStatus !== "string" || !["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"].includes(member.taskStatus)
        || typeof member.kind !== "string" || !["business", "historical"].includes(member.kind)) return null
      taskIds.add(member.taskId)
    }
    return outcome
  } catch { return null }
}

/** Emits only fixed counts and one-based slot status; no IDs, hashes, prose, or authority claims. */
export function renderObjectiveTailorFinalOutcome(value: unknown): readonly string[] {
  if (!hasObjectiveTailorFinalOutcome(value)) return []
  const outcome = readBoundObjectiveTailorFinalOutcome(value)
  if (!outcome) return ["Objective Tailor review results: unavailable."]
  const counts = Object.fromEntries(SLOT_STATUSES.map(status => [status, outcome.slots.filter(slot => slot.status === status).length])) as Record<SettledStatus, number>
  const notReady = outcome.slots.length - counts.ready
  const detail = SLOT_STATUSES.filter(status => status !== "ready" && counts[status] > 0)
    .map(status => `${counts[status]} ${statusLabel(status)}`).join(", ")
  const summary = `Objective Tailor review: ${counts.ready} ready (review passed and source current), ${notReady} not ready${detail ? ` (${detail})` : ""}.`
  const bySlot = `Per-slot review: ${outcome.slots.map(slot => `slot ${slot.ordinal} ${statusLabel(slot.status)}`).join(", ")}.`
  return [summary, bySlot]
}

function projectOutcome(loaded: LoadedGraph, witness: ObjectiveTailorWaveCompletionWitness, rootAttemptCount: number): ObjectiveTailorFinalOutcomeProjection | null {
  const { item, snapshot, state } = loaded
  if (!item || !snapshot || !state || loaded.discoveryTurnEligibility !== "ordinary"
    || !Number.isSafeInteger(item.revision) || item.revision !== state.revision || item.revision !== witness.graphRevision
    || !digestEqual(hash(snapshot), witness.graphDigest) || !Array.isArray(snapshot.nodes) || snapshot.nodes.length > 40
    || state.nodes.length !== snapshot.nodes.length || loaded.tasks.size !== snapshot.nodes.length) return null
  const marker = parseObjectiveTailorGraph(snapshot.objectiveTailor, snapshot.nodes)
  if (!marker || !state.objectiveTailor || canonicalTaskGraphJson(marker) !== canonicalTaskGraphJson(state.objectiveTailor)
    || canonicalTaskGraphJson(marker) !== canonicalTaskGraphJson(witness.marker)
    || marker.sourceNodeCount < 2 || marker.sourceNodeCount > 8 || marker.slots.length !== witness.outcomes.length) return null
  const sourceNodes: import("./task-graph-snapshot.js").TaskGraphSnapshot["nodes"] = snapshot.nodes.slice(0, marker.sourceNodeCount)
  const sourceKeys = new Set<string>(sourceNodes.map(node => node.key))
  if (sourceNodes.some(node => (node.templateId !== "scout" && node.templateId !== "analyst")
    || node.verificationDisposition !== "typed" || node.dependsOn.some((key: string) => !sourceKeys.has(key)))) return null
  const sourceSnapshot = parseTaskGraphSnapshot({ schemaVersion: snapshot.schemaVersion,
    ...(snapshot.rootSuccessCriteria ? { rootSuccessCriteria: snapshot.rootSuccessCriteria } : {}), nodes: sourceNodes })
  const sourceStates = state.nodes.slice(0, marker.sourceNodeCount)
  if (sourceStates.length !== marker.sourceNodeCount || sourceStates.some((node, index) => typeof node.taskId !== "string" || node.key !== sourceNodes[index]?.key
    || !isTaskGraphTerminal(node.status) || loaded.tasks.get(node.taskId)?.status !== node.status)) return null
  const sourceGraphDigest = hash(sourceSnapshot), sourceStatusDigest = hash(sourceStates.map(node => ({ key: node.key, status: node.status })))
  if (sourceGraphDigest !== witness.sourceGraphDigest || sourceStatusDigest !== witness.sourceStatusDigest) return null
  const slots: ObjectiveTailorFinalOutcomeProjection["slots"][number][] = []
  for (let index = 0; index < marker.slots.length; index += 1) {
    const slot = marker.slots[index]!, outcome = witness.outcomes[index]!
    const correction = slot.correction, correctionOutcome = record(outcome.correction)
    const correctionProof = correctionOutcome && parseObjectiveTailorCorrectionProof(correctionOutcome.proof)
    const writer = snapshot.nodes.find(node => node.key === (correction?.writerNodeKey ?? slot.writerNodeKey))
    const reviewer = snapshot.nodes.find(node => node.key === (correction?.reviewerNodeKey ?? slot.reviewerNodeKey))
    const initialWriter = snapshot.nodes.find(node => node.key === slot.writerNodeKey), initialReviewer = snapshot.nodes.find(node => node.key === slot.reviewerNodeKey)
    const proof = outcome.candidateWitness
    if (!writer || !reviewer || !initialWriter || !initialReviewer || proof.slotId !== slot.slotId || proof.candidate.jobId !== outcome.jobId
      || proof.sourceAnalystKeys[0] !== slot.sourceAnalystNodeKey || proof.writerNodeKey !== initialWriter.key || proof.reviewerNodeKey !== initialReviewer.key
      || writer.taskId !== outcome.writerTaskId || reviewer.taskId !== outcome.reviewerTaskId || outcome.status === "pending") return null
    if (correction ? !correctionOutcome || !correctionProof || Object.keys(correctionOutcome).sort().join(",") !== "proof,reviewerTaskId,writerTaskId"
      || correctionOutcome.writerTaskId !== writer.taskId || correctionOutcome.reviewerTaskId !== reviewer.taskId
      || correctionProof.slotId !== slot.slotId || correctionProof.writerNodeKey !== correction.writerNodeKey
      || correctionProof.reviewerNodeKey !== correction.reviewerNodeKey || correctionProof.prior.writerTaskId !== initialWriter.taskId
      || correctionProof.prior.reviewerTaskId !== initialReviewer.taskId || canonicalTaskGraphJson(correctionProof.candidateWitness) !== canonicalTaskGraphJson(proof)
      || loaded.tasks.get(initialWriter.taskId)?.status !== "completed" || loaded.tasks.get(initialReviewer.taskId)?.status !== "completed"
      : correctionOutcome !== null) return null
    const status: SettledStatus = outcome.status
    const writerTask = loaded.tasks.get(writer.taskId), reviewerTask = loaded.tasks.get(reviewer.taskId)
    const failed = (task: typeof writerTask) => Boolean(task && ["failed", "interrupted", "cancelled", "closed"].includes(task.status))
    if (!writerTask || !reviewerTask || !isTaskGraphTerminal(writerTask.status) || !isTaskGraphTerminal(reviewerTask.status)
      || outcome.status === "failed" && !failed(writerTask) && !failed(reviewerTask)
      || outcome.status !== "failed" && (writerTask.status !== "completed" || reviewerTask.status !== "completed")) return null
    slots.push({ ordinal: index + 1, status, evidenceDigest: hash(outcome) })
  }
  return parseObjectiveTailorFinalOutcome({ schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SCHEMA,
    graphRevision: item.revision, rootAttemptCount, graphDigest: witness.graphDigest, sourceNodeCount: marker.sourceNodeCount,
    sourceGraphDigest, sourceStatusDigest, slots })
}

async function readOwnedRoot(client: PoolClient, lease: TurnLease, rootTaskId: string): Promise<{ id: string; attemptCount: number } | undefined> {
  const result = await client.query<{ id: string; attemptCount: number }>(`WITH observed AS (SELECT clock_timestamp() AS now)
    SELECT task."id", task."attemptCount"
    FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
    JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
    CROSS JOIN observed
    WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = task."id"
      AND task."parentTaskId" IS NULL AND task."role" = 'orchestrator' AND task."taskType" = 'root'
      AND task."status" = 'running' AND task."leaseOwner" = $4 AND task."leaseExpiresAt" > observed.now
      AND task."attemptCount" > 0 AND task."interruptRequestedAt" IS NULL
      AND session."userId" = $5 AND turn."userId" = $5 AND turn."rootTaskId" = task."id"
      AND turn."status" = 'in_progress' AND turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $6
      AND turn."leaseExpiresAt" > observed.now LIMIT 2`,
  [rootTaskId, lease.sessionId, lease.turnId, lease.ownerId, lease.userId, lease.leaseVersion])
  const row = result.rows[0]
  return result.rows.length === 1 && row?.id === rootTaskId && Number.isSafeInteger(row.attemptCount) && row.attemptCount > 0 ? row : undefined
}

function summaryPrefix(loaded: LoadedGraph, count: number): LoadedGraph {
  if (!loaded.snapshot || !loaded.state || !loaded.item || count < 2 || count > 8 || count > loaded.snapshot.nodes.length) throw new Error("objective_tailor_final_source_invalid")
  const nodes = loaded.snapshot.nodes.slice(0, count), tasks = new Map(nodes.map(node => {
    const task = loaded.tasks.get(node.taskId)
    if (!task) throw new Error("objective_tailor_final_source_invalid")
    return [node.taskId, task] as const
  }))
  return { ...loaded, snapshot: { ...loaded.snapshot, nodes }, state: { ...loaded.state, nodes: loaded.state.nodes.slice(0, count) }, tasks }
}
function prefixHistory(value: ReadonlySet<number> | undefined, count: number, graphCount: number): ReadonlySet<number> | undefined {
  if (value === undefined) return undefined
  const selected = new Set<number>()
  let visited = 0
  for (const index of value) {
    if (++visited > 40 || !Number.isSafeInteger(index) || index < 0 || index >= graphCount) throw new Error("task_graph_final_summary_historical_selection_invalid")
    if (index < count) selected.add(index)
  }
  return selected
}
function statusLabel(status: Exclude<ObjectiveTailorWaveSlotStatus, "pending">): string {
  return status === "ready" ? "ready" : status === "needs_revision" ? "needs revision" : status
}
function hash(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function digest(value: unknown): value is string { return typeof value === "string" && DIGEST.test(value) }
function digestEqual(left: unknown, right: unknown): boolean { return digest(left) && left === right }
function integer(value: unknown, minimum: number, maximum: number): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum
}
function dense(value: unknown, maximum: number): value is unknown[] {
  return Array.isArray(value) && value.length <= maximum && Reflect.ownKeys(value).length === value.length + 1
    && Reflect.ownKeys(value).every(key => key === "length" || typeof key === "string" && /^(0|[1-9][0-9]*)$/.test(key) && Number(key) < value.length)
}
function exactKeys(value: Record<string, unknown>, keys: string): boolean {
  const expected = keys.split(","), actual = Reflect.ownKeys(value)
  return actual.length === expected.length && actual.every(key => typeof key === "string" && expected.includes(key)
    && Boolean(Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!))
}
function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null }
  catch { return null }
}
function hasOwn(value: unknown, key: string): boolean { return value !== null && typeof value === "object" && Object.hasOwn(value, key) }
