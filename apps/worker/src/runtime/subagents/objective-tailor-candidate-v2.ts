import { createHash } from "node:crypto"
import { Buffer } from "node:buffer"
import type pg from "pg"
import { isTaskGraphTerminal } from "../planning/task-graph-transition-rules.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import type { JobRecord } from "../tools/read-tools.js"
import { isCanonicalJobId } from "../tools/job-read-output-redaction.js"
import { readScheduledDraftAnalystProof, hasScheduledDraftMembershipRequirement,
  type ScheduledDraftAnalystProof } from "./scheduled-draft-candidate-analyst-proof.js"
import { scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { readObjectiveTailorWaveInventory, type ObjectiveTailorWaveInventory } from "./objective-tailor-wave-inventory.js"
import { makeObjectiveTailorWaveCandidateSelection, parseObjectiveTailorWaveCandidateRefs,
  type ObjectiveTailorWaveCandidateSelection } from "./objective-tailor-wave-witness.js"

export const OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA = "agent-harness.v2.objective-tailor-wave-catalog.v1" as const
const MAX_ANALYSTS = 8, MAX_FINDINGS = 512, MAX_CANDIDATES = 8
type Queryable = Pick<pg.PoolClient, "query">
export type ObjectiveTailorWaveCandidateCard = Readonly<{ candidateRef: string; title: string; company: string; score: number }>
export type ObjectiveTailorWaveCandidateCatalog = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA
  graphRevision: number
  candidates: readonly ObjectiveTailorWaveCandidateCard[]
}>
type Occurrence = Readonly<{ analystKey: string; score: number; materialDigest?: string; proof: ScheduledDraftAnalystProof }>
type Pool = Readonly<{ catalog: ObjectiveTailorWaveCandidateCatalog; selections: readonly ObjectiveTailorWaveCandidateSelection[] }>

/** Builds a public-only catalog from the frozen source prefix and exact occupied wave inventory. */
export async function buildObjectiveTailorWaveCandidateCatalog(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph,
): Promise<ObjectiveTailorWaveCandidateCatalog | undefined> {
  return (await candidatePool(client, scope, loaded))?.catalog
}

/** Re-resolves one bounded distinct wave against the current whole-graph CAS revision. */
export async function resolveObjectiveTailorWaveCandidates(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph, expectedRevision: unknown, candidateRefs: unknown,
): Promise<readonly ObjectiveTailorWaveCandidateSelection[] | undefined> {
  const refs = parseObjectiveTailorWaveCandidateRefs(candidateRefs)
  if (!Number.isSafeInteger(expectedRevision) || !refs) return undefined
  const pool = await candidatePool(client, scope, loaded)
  if (!pool || pool.catalog.graphRevision !== expectedRevision) return undefined
  const selected = refs.map(ref => pool.selections.find(selection => selection.candidateRef === ref))
  return selected.every((value): value is ObjectiveTailorWaveCandidateSelection => Boolean(value)) ? selected : undefined
}

async function candidatePool(client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph): Promise<Pool | undefined> {
  const inventory = await readObjectiveTailorWaveInventory(client, scope, loaded)
  if (!inventory) return undefined
  const sourceNodes = inventory.sourceSnapshot.nodes, occupied = new Set(inventory.occupiedJobIds)
  const analysts = sourceNodes.filter(node => node.templateId === "analyst" && node.verificationDisposition === "typed"
    && hasScheduledDraftMembershipRequirement(node.verification)
    && loaded.state?.nodes.find(current => current.key === node.key)?.status === "completed")
  if (analysts.length > MAX_ANALYSTS || sourceNodes.some((node, index) => !isTaskGraphTerminal(loaded.state?.nodes[index]?.status ?? ""))) return undefined
  const proofs = new Map<string, ScheduledDraftAnalystProof>()
  for (const node of analysts) {
    const proof = await readScheduledDraftAnalystProof(client, scope, inventory.sourceSnapshot, node)
    if (!proof || proof.result.findings.length > MAX_FINDINGS) return undefined
    proofs.set(node.key, proof)
  }
  const order = new Map(sourceNodes.map((node, index) => [node.key, index] as const)), occurrences = new Map<string, Occurrence[]>()
  for (const [analystKey, proof] of proofs) for (const finding of proof.result.findings) {
    if (!isCanonicalJobId(finding.jobId) || !Number.isFinite(finding.score) || finding.score < 0 || finding.score > 10) continue
    const list = occurrences.get(finding.jobId) ?? []
    list.push({ analystKey, score: finding.score, materialDigest: proof.materialDigests.get(finding.jobId), proof })
    occurrences.set(finding.jobId, list)
  }
  const ranked = [...occurrences.entries()].flatMap(([jobId, rows]) => {
    if (occupied.has(jobId)) return []
    const latest = latestOccurrence(rows, order)
    return latest?.materialDigest ? [{ jobId, latest }] : []
  }).sort((left, right) => right.latest.score - left.latest.score || compare(left.jobId, right.jobId))
  const source = createPostgresReadToolDataSource(client), selections: ObjectiveTailorWaveCandidateSelection[] = [], cards: ObjectiveTailorWaveCandidateCard[] = []
  for (const { jobId, latest } of ranked) {
    if (cards.length >= MAX_CANDIDATES) break
    const job = await source.getJob(scope.userId, jobId)
    if (!validDisplayJob(job, jobId) || scheduledDraftJobMaterialDigest(job) !== latest.materialDigest) continue
    const selection = makeObjectiveTailorWaveCandidateSelection({ scope, sourceGraphRevision: inventory.sourceGraphRevision,
      sourceGraphDigest: inventory.sourceGraphDigest, sourceStatusDigest: inventory.sourceStatusDigest,
      analystProofDigest: sha256(latest.proof.binding), candidate: { jobId, score: latest.score, materialDigest: latest.materialDigest! },
      sourceAnalystKey: latest.analystKey })
    if (!selection) continue
    selections.push(selection)
    cards.push({ candidateRef: selection.candidateRef, title: job.role.trim().slice(0, 160).trim(),
      company: job.company.trim().slice(0, 160).trim(), score: latest.score })
  }
  return { catalog: { schemaVersion: OBJECTIVE_TAILOR_WAVE_CATALOG_SCHEMA, graphRevision: inventory.graphRevision, candidates: cards }, selections }
}

function latestOccurrence(rows: readonly Occurrence[], order: ReadonlyMap<string, number>): Occurrence | undefined {
  const byAnalyst = new Map<string, Occurrence>()
  for (const row of rows) {
    if (byAnalyst.has(row.analystKey)) return undefined
    byAnalyst.set(row.analystKey, row)
  }
  const latest = [...rows].sort((left, right) => (order.get(right.analystKey) ?? -1) - (order.get(left.analystKey) ?? -1))[0]
  return latest && typeof latest.materialDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(latest.materialDigest) ? latest : undefined
}
function validDisplayJob(job: JobRecord | null, jobId: string): job is JobRecord {
  return Boolean(job && job.id === jobId && typeof job.role === "string" && job.role.trim().length > 0 && job.role.trim().length <= 500
    && typeof job.company === "string" && job.company.trim().length > 0 && job.company.trim().length <= 500)
}
function sha256(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function compare(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")) }
