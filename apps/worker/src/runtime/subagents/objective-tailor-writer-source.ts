import type pg from "pg"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"
import { RUNNABLE_SESSION } from "../session-gate.js"
import { loadSelectedJobArtifactContext, type SelectedJobArtifactContextBundle } from "./selected-job-artifact-context.js"
import { readCurrentObjectiveTailorBinding } from "./objective-tailor-current-binding.js"
import { parseObjectiveTailorCandidateWitness, type ObjectiveTailorCandidateWitness } from "./objective-tailor-witness.js"
import { parseObjectiveTailorWaveCandidateWitness, type ObjectiveTailorWaveCandidateWitness } from "./objective-tailor-wave-witness.js"
import { readObjectiveTailorWaveInventory } from "./objective-tailor-wave-inventory.js"
import { parseObjectiveTailorCorrectionProof } from "./objective-tailor-correction-witness.js"
import { readObjectiveTailorCorrectionChildBinding } from "./objective-tailor-correction-child-source.js"
import { readCurrentScheduledDraftJobMaterialDigest, scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import type { SubagentLease } from "./types.js"
import type { SelectedJobArtifactContextForChild } from "./scheduled-draft-writer-source.js"

type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>

/** Resolve only the witnessed pair's exact current Job source for its running child lease. */
export async function loadObjectiveTailorChildSource(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph, lease: SubagentLease,
): Promise<SelectedJobArtifactContextForChild | undefined> {
  if (!validLease(lease, scope)) return undefined
  const taskType = lease.role === "writer" ? "cover_letter_draft" : "cover_letter_review"
  const row = await readLiveChild(client, scope, lease, taskType)
  if (!row || !rowMatchesLease(row, scope, lease, taskType)) return undefined
  const contextVersion = objectiveTailorContextVersion(lease.context)
  if (!contextVersion || !sameLeaseContext(row.context, lease.context)) return undefined
  if (hasObjectiveTailorGraphMarker(loaded)) {
    if (contextVersion !== "wave") return undefined
    return loadWaveChildSource(client, scope, loaded, lease, row)
  }
  if (contextVersion !== "single") return undefined
  const binding = await readCurrentObjectiveTailorBinding(client, scope, loaded)
  const taskId = lease.role === "writer" ? binding.status === "bound" && binding.writerTaskId
    : binding.status === "bound" && binding.reviewerTaskId
  if (binding.status !== "bound" || taskId !== lease.id) return undefined
  const jobId = binding.witness.candidate.jobId
  if (!matchesContext(row.context, lease.context, binding.witness, jobId)) return undefined
  let source: SelectedJobArtifactContextBundle
  try { source = await loadSelectedJobArtifactContext(client, scope.userId, jobId) }
  catch { return undefined }
  const jobs = source.transientSources.filter(item => item.sourceRef === `job:${jobId}`)
  if (source.preparation.jobId !== jobId || jobs.length !== 1
    || record(jobs[0]?.content)?.id !== jobId
    || scheduledDraftJobMaterialDigest(jobs[0]?.content) !== binding.witness.candidate.materialDigest) return undefined
  if (lease.role === "reviewer") return { context: source }
  const assertCurrentDraftMaterial = async (current: Queryable, userId: string, currentJobId: string): Promise<boolean> => {
    if (userId !== scope.userId || currentJobId !== jobId) return false
    return await readCurrentScheduledDraftJobMaterialDigest(current, scope.userId, jobId) === binding.witness.candidate.materialDigest
  }
  return { context: source, assertCurrentDraftMaterial }
}

async function loadWaveChildSource(client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph,
  lease: SubagentLease, row: Row): Promise<SelectedJobArtifactContextForChild | undefined> {
  const inventory = await readObjectiveTailorWaveInventory(client, scope, loaded)
  const leaseContext = record(lease.context), witness = parseObjectiveTailorWaveCandidateWitness(leaseContext?.objectiveTailorCandidateWitness)
  const correction = leaseContext && Object.hasOwn(leaseContext, "objectiveTailorCorrectionProof")
    ? parseObjectiveTailorCorrectionProof(leaseContext.objectiveTailorCorrectionProof) : undefined
  if (!inventory?.marker || !witness || !matchesWaveContext(row.context, lease.context, witness)) return undefined
  if (leaseContext && Object.hasOwn(leaseContext, "objectiveTailorCorrectionProof") && !correction) return undefined
  const slots = inventory.occupiedSlots.filter(slot => {
    return correction
      ? (lease.role === "writer" ? slot.correction?.writerTaskId : slot.correction?.reviewerTaskId) === lease.id
      : (lease.role === "writer" ? slot.writerTaskId : slot.reviewerTaskId) === lease.id
  })
  const slot = slots[0]
  if (slots.length !== 1 || !slot || canonicalTaskGraphJson(slot.witness) !== canonicalTaskGraphJson(witness)
    || correction && (!slot.correction || canonicalTaskGraphJson(slot.correction.proof) !== canonicalTaskGraphJson(correction)
      || canonicalTaskGraphJson(correction.candidateWitness) !== canonicalTaskGraphJson(witness))) return undefined
  if (correction && !await readObjectiveTailorCorrectionChildBinding({ client, scope, loaded, taskId: lease.id,
    role: lease.role as "writer" | "reviewer", context: lease.context, inventory })) return undefined
  const jobId = witness.candidate.jobId
  const source = await loadVerifiedJobSource(client, scope.userId, jobId, witness.candidate.materialDigest)
  if (!source) return undefined
  if (lease.role === "reviewer") return { context: source }
  return { context: source, assertCurrentDraftMaterial: materialRechecker(scope.userId, jobId, witness.candidate.materialDigest) }
}

async function readLiveChild(client: Queryable, scope: GraphIdentityScope, lease: SubagentLease, taskType: string): Promise<Row | undefined> {
  const result = await client.query(`WITH live AS MATERIALIZED (SELECT clock_timestamp() AS "at")
    SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
      task."role", task."taskType", task."status", task."attemptCount", task."leaseOwner", task."interruptRequestedAt", task."context"
    FROM live JOIN "agent_sessions" AS session ON session."id" = $1 AND session."userId" = $2 AND ${RUNNABLE_SESSION}
    JOIN "agent_turns" AS turn ON turn."id" = $3 AND turn."sessionId" = session."id" AND turn."userId" = session."userId"
      AND turn."rootTaskId" = $4 AND turn."source" = 'user' AND turn."executionMode" = 'canonical_task_graph'
      AND turn."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled')
    JOIN "sub_agent_tasks" AS root ON root."id" = $4 AND root."sessionId" = session."id" AND root."turnId" = turn."id"
      AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL AND root."role" = 'orchestrator' AND root."taskType" = 'root'
      AND root."status" NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed') AND root."interruptRequestedAt" IS NULL
    JOIN "sub_agent_tasks" AS task ON task."id" = $5 AND task."sessionId" = session."id"
      AND task."turnId" = turn."id" AND task."rootTaskId" = $4
      AND task."parentTaskId" = $6 AND task."role" = $7 AND task."taskType" = $8
      AND task."status" = 'running' AND task."attemptCount" = $9 AND task."leaseOwner" = $10
      AND task."interruptRequestedAt" IS NULL AND task."leaseExpiresAt" > live."at"`,
  [scope.sessionId, scope.userId, scope.turnId, scope.rootTaskId, lease.id, scope.parentTaskId,
    lease.role, taskType, lease.attemptCount, lease.ownerId])
  return result.rows.length === 1 ? result.rows[0] as Row : undefined
}

function validLease(lease: SubagentLease, scope: GraphIdentityScope): boolean {
  return (lease.role === "writer" && lease.taskType === "cover_letter_draft"
      || lease.role === "reviewer" && lease.taskType === "cover_letter_review")
    && lease.status === "running" && lease.interruptRequestedAt === null && !lease.signal.aborted
    && lease.userId === scope.userId && lease.sessionId === scope.sessionId && lease.turnId === scope.turnId
    && lease.rootTaskId === scope.rootTaskId && lease.parentTaskId === scope.parentTaskId
    && typeof lease.ownerId === "string" && lease.ownerId.trim().length > 0 && lease.leaseOwner === lease.ownerId
    && Number.isSafeInteger(lease.attemptCount) && lease.attemptCount > 0
    && lease.leaseExpiresAt instanceof Date && Number.isFinite(lease.leaseExpiresAt.getTime())
}

function rowMatchesLease(row: Row, scope: GraphIdentityScope, lease: SubagentLease, taskType: string): boolean {
  return row.id === lease.id && row.userId === scope.userId && row.sessionId === scope.sessionId && row.turnId === scope.turnId
    && row.rootTaskId === scope.rootTaskId && row.parentTaskId === scope.parentTaskId && row.role === lease.role
    && row.taskType === taskType && row.status === "running" && row.attemptCount === lease.attemptCount
    && row.leaseOwner === lease.ownerId && row.interruptRequestedAt === null
}

function matchesContext(rowValue: unknown, leaseValue: unknown, witness: ObjectiveTailorCandidateWitness, jobId: string): boolean {
  const row = record(rowValue), lease = record(leaseValue)
  if (!row || !lease || !sameLeaseContext(row, lease)) return false
  const rowWitness = parseObjectiveTailorCandidateWitness(row.objectiveTailorCandidateWitness)
  return row.objectiveTailorCandidateMode === true && rowWitness !== undefined
    && canonicalTaskGraphJson(rowWitness) === canonicalTaskGraphJson(witness) && selectedJobMatches(row, jobId)
}

function matchesWaveContext(rowValue: unknown, leaseValue: unknown, witness: ObjectiveTailorWaveCandidateWitness): boolean {
  const row = record(rowValue), lease = record(leaseValue)
  if (!row || !lease || !sameLeaseContext(row, lease)) return false
  const rowWitness = parseObjectiveTailorWaveCandidateWitness(row.objectiveTailorCandidateWitness)
  return row.objectiveTailorCandidateMode === true && rowWitness !== undefined
    && canonicalTaskGraphJson(rowWitness) === canonicalTaskGraphJson(witness) && selectedJobMatches(row, witness.candidate.jobId)
}

function selectedJobMatches(context: Row, jobId: string): boolean {
  const selection = record(context.selectedJobPreparation)
  return selection !== undefined && Reflect.ownKeys(selection).length === 1 && selection.jobId === jobId
}

function sameLeaseContext(rowValue: unknown, leaseValue: unknown): boolean {
  const row = record(rowValue), lease = record(leaseValue)
  return Boolean(row && lease && canonicalTaskGraphJson(row) === canonicalTaskGraphJson(lease))
}

function objectiveTailorContextVersion(value: unknown): "single" | "wave" | undefined {
  const context = record(value), witness = record(context?.objectiveTailorCandidateWitness)
  if (!context || !witness || context.objectiveTailorCandidateMode !== true) return undefined
  if (parseObjectiveTailorCandidateWitness(witness)) return "single"
  if (parseObjectiveTailorWaveCandidateWitness(witness)) return "wave"
  return undefined
}

function hasObjectiveTailorGraphMarker(loaded: LoadedGraph): boolean {
  try {
    return Boolean(loaded.snapshot && Object.hasOwn(loaded.snapshot, "objectiveTailor")
      || loaded.state && Object.hasOwn(loaded.state, "objectiveTailor"))
  } catch { return true }
}

async function loadVerifiedJobSource(client: Queryable, userId: string, jobId: string, materialDigest: string): Promise<SelectedJobArtifactContextBundle | undefined> {
  let source: SelectedJobArtifactContextBundle
  try { source = await loadSelectedJobArtifactContext(client, userId, jobId) }
  catch { return undefined }
  const jobs = source.transientSources.filter(item => item.sourceRef === `job:${jobId}`)
  return source.preparation.jobId === jobId && jobs.length === 1 && record(jobs[0]?.content)?.id === jobId
    && scheduledDraftJobMaterialDigest(jobs[0]?.content) === materialDigest ? source : undefined
}

function materialRechecker(userId: string, jobId: string, materialDigest: string) {
  return async (current: Queryable, currentUserId: string, currentJobId: string): Promise<boolean> => {
    if (currentUserId !== userId || currentJobId !== jobId) return false
    return await readCurrentScheduledDraftJobMaterialDigest(current, userId, jobId) === materialDigest
  }
}

function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const row = value as Row, keys = Reflect.ownKeys(row)
    return (Object.getPrototypeOf(row) === Object.prototype || Object.getPrototypeOf(row) === null)
      && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(row, key)?.enumerable
        && "value" in Object.getOwnPropertyDescriptor(row, key)!) ? row : undefined
  } catch { return undefined }
}
