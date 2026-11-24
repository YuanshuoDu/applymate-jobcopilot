import { Buffer } from "node:buffer"
import { createHash } from "node:crypto"
import type pg from "pg"
import { SELECTED_JOB_BATCH_TEMPLATE_CATALOG } from "@jobcopilot/agent-protocol"
import { isTaskGraphTerminal } from "../planning/task-graph-transition-rules.js"
import { hasScheduledDraftMembershipRequirement, readScheduledDraftAnalystProof, type ScheduledDraftAnalystProof } from "./scheduled-draft-candidate-analyst-proof.js"
import { scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import type { JobRecord } from "../tools/read-tools.js"
import { isCanonicalJobId } from "../tools/job-read-output-redaction.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, parseTaskGraphSnapshot, taskGraphItemId } from "./task-graph-snapshot.js"
import { makeObjectiveTailorCandidateSelection, parseObjectiveTailorCandidateWitness,
  type ObjectiveTailorCandidateProof, type ObjectiveTailorCandidateSelection } from "./objective-tailor-witness.js"

export const OBJECTIVE_TAILOR_CANDIDATE_CATALOG_SCHEMA = "agent-harness.v2.objective-tailor-candidate-catalog.v1" as const
const MAX_ANALYSTS = 8, MAX_FINDINGS = 512, MAX_CANDIDATES = 8
const BATCH_TEMPLATES = new Set<string>(SELECTED_JOB_BATCH_TEMPLATE_CATALOG.flatMap(entry => [entry.writerTemplateId, entry.reviewerTemplateId]))
type Queryable = Pick<pg.PoolClient, "query">
export type ObjectiveTailorCandidateCard = Readonly<{ candidateRef: string; title: string; company: string; score: number }>
export type ObjectiveTailorCandidateCatalog = Readonly<{
  schemaVersion: typeof OBJECTIVE_TAILOR_CANDIDATE_CATALOG_SCHEMA
  graphRevision: number
  candidates: readonly ObjectiveTailorCandidateCard[]
}>
type CandidateEntry = Readonly<{ selection: ObjectiveTailorCandidateSelection; card: ObjectiveTailorCandidateCard }>
type CandidatePool = Readonly<{ catalog: ObjectiveTailorCandidateCatalog; entries: readonly CandidateEntry[] }>

/** Build the public-safe selector from the exact graph already locked and loaded by its caller. */
export async function buildObjectiveTailorCandidateCatalog(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph,
): Promise<ObjectiveTailorCandidateCatalog | undefined> {
  return (await objectiveTailorCandidatePool(client, scope, loaded))?.catalog
}

/** Resolve only a selector recomputed from the exact current graph and same transaction client. */
export async function resolveObjectiveTailorCandidate(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph, expectedRevision: unknown, candidateRef: unknown,
): Promise<ObjectiveTailorCandidateSelection | undefined> {
  if (!Number.isSafeInteger(expectedRevision) || typeof candidateRef !== "string") return undefined
  const pool = await objectiveTailorCandidatePool(client, scope, loaded)
  if (!pool || pool.catalog.graphRevision !== expectedRevision) return undefined
  return pool.entries.find(entry => entry.selection.candidateRef === candidateRef)?.selection
}

async function objectiveTailorCandidatePool(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph,
): Promise<CandidatePool | undefined> {
  const graph = validGraph(scope, loaded)
  if (!graph) return undefined
  const proofs = await readAnalystProofs(client, scope, graph.snapshot, graph.state, loaded)
  if (!proofs) return undefined
  const graphDigest = sha256(graph.snapshot), statusDigest = sha256(graph.state.nodes.map(node => ({ key: node.key, status: node.status })))
  const proofByKey = new Map(proofs.map(proof => [proof.binding.nodeKey, proof] as const))
  const nodeOrder = new Map(graph.snapshot.nodes.map((node, index) => [node.key, index] as const))
  const occurrences = collectFindings(proofs), ranked = [...occurrences.entries()]
    .map(([jobId, rows]) => ({ jobId, latest: latestOccurrence(rows, nodeOrder) }))
    .filter((item): item is { jobId: string; latest: FindingOccurrence } => Boolean(item.latest?.materialDigest))
    .map(({ jobId, latest }) => ({ jobId, score: latest.score, materialDigest: latest.materialDigest!, sourceAnalystKeys: [latest.analystKey], proof: proofByKey.get(latest.analystKey)! }))
    .sort((a, b) => b.score - a.score || compare(a.jobId, b.jobId)).slice(0, MAX_CANDIDATES)
  const source = createPostgresReadToolDataSource(client), entries: CandidateEntry[] = []
  for (const rankedJob of ranked) {
    if (!rankedJob.materialDigest) continue
    const job = await source.getJob(scope.userId, rankedJob.jobId)
    if (!validDisplayJob(job, rankedJob.jobId) || scheduledDraftJobMaterialDigest(job) !== rankedJob.materialDigest) continue
    const candidate: ObjectiveTailorCandidateProof = { jobId: rankedJob.jobId, score: rankedJob.score, materialDigest: rankedJob.materialDigest }
    if (!rankedJob.proof) continue
    const selection = makeObjectiveTailorCandidateSelection({ scope, sourceGraphRevision: graph.revision,
      sourceGraphDigest: graphDigest, sourceStatusDigest: statusDigest, analystProofDigest: sha256(rankedJob.proof.binding),
      candidate, sourceAnalystKeys: rankedJob.sourceAnalystKeys })
    if (!selection) continue
    entries.push({ selection, card: { candidateRef: selection.candidateRef, title: job.role.trim().slice(0, 160).trim(),
      company: job.company.trim().slice(0, 160).trim(), score: rankedJob.score } })
  }
  return { catalog: { schemaVersion: OBJECTIVE_TAILOR_CANDIDATE_CATALOG_SCHEMA,
    graphRevision: graph.revision, candidates: entries.map(entry => entry.card) }, entries }
}

/** Revalidates an accepted source proof after the Root lease is released, using the caller-loaded live graph. */
export async function revalidateObjectiveTailorCandidateWitness(
  client: Queryable, scope: GraphIdentityScope, loaded: LoadedGraph, witnessValue: unknown,
): Promise<ObjectiveTailorCandidateSelection | undefined> {
  const witness = parseObjectiveTailorCandidateWitness(witnessValue), graph = graphBasis(scope, loaded)
  if (!witness || !graph || graph.revision < witness.admittedRevision || witness.sourceGraphRevision + 1 !== witness.admittedRevision) return undefined
  const nodes = graph.snapshot.nodes, writerIndex = nodes.findIndex(node => node.key === witness.writerNodeKey)
  const reviewerIndex = nodes.findIndex(node => node.key === witness.reviewerNodeKey)
  const writer = nodes[writerIndex], reviewer = nodes[reviewerIndex], sourceNodes = nodes.slice(0, writerIndex), suffix = nodes.slice(reviewerIndex + 1)
  if (writerIndex < 0 || reviewerIndex !== writerIndex + 1 || !writer || !reviewer
    || nodes.filter(node => node.templateId === "cover_letter_writer").length !== 1
    || nodes.filter(node => node.templateId === "cover_letter_reviewer").length !== 1
    || writer.templateId !== "cover_letter_writer" || reviewer.templateId !== "cover_letter_reviewer"
    || loaded.tasks.get(writer.taskId)?.role !== "writer" || loaded.tasks.get(reviewer.taskId)?.role !== "reviewer"
    || canonicalTaskGraphJson(reviewer.dependsOn) !== canonicalTaskGraphJson([writer.key])
    || canonicalTaskGraphJson(writer.dependsOn) !== canonicalTaskGraphJson(witness.sourceAnalystKeys)
    || sourceNodes.some(node => BATCH_TEMPLATES.has(node.templateId) || node.templateId === "scheduled.application.execute" || node.templateId === "scheduled.post_gate_audit")
    || suffix.some(node => (node.templateId !== "scout" && node.templateId !== "analyst")
      || node.dependsOn.includes(writer.key) || node.dependsOn.includes(reviewer.key))) return undefined
  const sourceSnapshot = parseTaskGraphSnapshot({ schemaVersion: graph.snapshot.schemaVersion,
    ...(graph.snapshot.rootSuccessCriteria ? { rootSuccessCriteria: graph.snapshot.rootSuccessCriteria } : {}), nodes: sourceNodes })
  const sourceKeys = new Set(sourceSnapshot.nodes.map(node => node.key))
  const sourceStates = graph.state.nodes.filter(node => sourceKeys.has(node.key))
  if (sourceStates.length !== sourceSnapshot.nodes.length || sourceStates.some(node => !isTaskGraphTerminal(node.status))) return undefined
  const sourceStatusDigest = sha256(sourceStates.map(node => ({ key: node.key, status: node.status })))
  if (sha256(sourceSnapshot) !== witness.sourceGraphDigest || sourceStatusDigest !== witness.sourceStatusDigest) return undefined
  const proofs = await readAnalystProofs(client, scope, sourceSnapshot, graph.state, loaded)
  if (!proofs) return undefined
  const latest = latestOccurrence(collectFindings(proofs).get(witness.candidate.jobId) ?? [], new Map(sourceSnapshot.nodes.map((node, index) => [node.key, index] as const)))
  const sourceProof = latest && proofs.find(proof => proof.binding.nodeKey === latest.analystKey)
  if (!latest || !sourceProof || latest.analystKey !== witness.sourceAnalystKeys[0] || latest.score !== witness.candidate.score
    || latest.materialDigest !== witness.candidate.materialDigest || sha256(sourceProof.binding) !== witness.analystProofDigest) return undefined
  const sourceAnalystKeys = [latest.analystKey]
  const job = await createPostgresReadToolDataSource(client).getJob(scope.userId, witness.candidate.jobId)
  if (!validDisplayJob(job, witness.candidate.jobId) || scheduledDraftJobMaterialDigest(job) !== witness.candidate.materialDigest) return undefined
  const selection = makeObjectiveTailorCandidateSelection({ scope, sourceGraphRevision: witness.sourceGraphRevision,
    sourceGraphDigest: witness.sourceGraphDigest, sourceStatusDigest: witness.sourceStatusDigest,
    analystProofDigest: witness.analystProofDigest, candidate: witness.candidate, sourceAnalystKeys })
  return selection?.candidateRef === witness.candidateRef ? selection : undefined
}

type EligibleGraph = Readonly<{ revision: number; snapshot: NonNullable<LoadedGraph["snapshot"]>; state: NonNullable<LoadedGraph["state"]> }>
function graphBasis(scope: GraphIdentityScope, loaded: LoadedGraph): EligibleGraph | undefined {
  const { item, snapshot, state } = loaded
  if (loaded.discoveryTurnEligibility !== "ordinary" || loaded.rootTaskId !== scope.rootTaskId || scope.parentTaskId !== scope.rootTaskId
    || !item || !snapshot || !state || item.id !== taskGraphItemId(scope.parentTaskId)
    || !Number.isSafeInteger(item.revision) || item.revision < 1 || state.revision !== item.revision
    || loaded.tasks.size !== snapshot.nodes.length || state.nodes.length !== snapshot.nodes.length) return undefined
  const persisted = parseTaskGraphSnapshot(item.content)
  if (canonicalTaskGraphJson(persisted) !== canonicalTaskGraphJson(snapshot)) return undefined
  const currentByKey = new Map(state.nodes.map(node => [node.key, node] as const))
  if (currentByKey.size !== snapshot.nodes.length) return undefined
  for (const node of snapshot.nodes) {
    const task = loaded.tasks.get(node.taskId), current = currentByKey.get(node.key)
    if (!task || task.id !== node.taskId || !current || current.taskId !== node.taskId || current.status !== task.status
      || current.templateId !== node.templateId || canonicalTaskGraphJson(current.dependsOn) !== canonicalTaskGraphJson(node.dependsOn)) return undefined
    if (BATCH_TEMPLATES.has(node.templateId)
      || node.templateId === "scheduled.application.execute" || node.templateId === "scheduled.post_gate_audit") return undefined
  }
  return { revision: item.revision, snapshot, state }
}
function validGraph(scope: GraphIdentityScope, loaded: LoadedGraph): EligibleGraph | undefined {
  const graph = graphBasis(scope, loaded)
  return graph && graph.state.nodes.every(node => isTaskGraphTerminal(node.status))
    && !graph.snapshot.nodes.some(node => node.templateId === "cover_letter_writer" || node.templateId === "cover_letter_reviewer"
    || BATCH_TEMPLATES.has(node.templateId) || node.templateId === "scheduled.application.execute" || node.templateId === "scheduled.post_gate_audit") ? graph : undefined
}
async function readAnalystProofs(client: Queryable, scope: GraphIdentityScope, snapshot: EligibleGraph["snapshot"],
  state: EligibleGraph["state"], loaded: LoadedGraph): Promise<ScheduledDraftAnalystProof[] | undefined> {
  const analysts = snapshot.nodes.filter(node => node.templateId === "analyst" && node.verificationDisposition === "typed"
    && hasScheduledDraftMembershipRequirement(node.verification)
    && state.nodes.find(current => current.key === node.key)?.status === "completed")
  if (analysts.length > MAX_ANALYSTS) return undefined
  const proofs: ScheduledDraftAnalystProof[] = []
  for (const node of analysts) {
    const task = loaded.tasks.get(node.taskId), proof = task?.status === "completed" && await readScheduledDraftAnalystProof(client, scope, snapshot, node)
    if (!proof || proof.result.findings.length > MAX_FINDINGS) return undefined
    proofs.push(proof)
  }
  return proofs
}
type FindingOccurrence = Readonly<{ analystKey: string; score: number; materialDigest?: string }>
function collectFindings(proofs: readonly ScheduledDraftAnalystProof[]): Map<string, FindingOccurrence[]> {
  const result = new Map<string, FindingOccurrence[]>()
  for (const proof of proofs) for (const finding of proof.result.findings) {
    if (!isCanonicalJobId(finding.jobId) || !Number.isFinite(finding.score) || finding.score < 0 || finding.score > 10) continue
    const list = result.get(finding.jobId) ?? []
    list.push({ analystKey: proof.binding.nodeKey, score: finding.score, materialDigest: proof.materialDigests.get(finding.jobId) })
    result.set(finding.jobId, list)
  }
  return result
}
function latestOccurrence(rows: readonly FindingOccurrence[], order: ReadonlyMap<string, number>): FindingOccurrence | undefined {
  const byAnalyst = new Map<string, FindingOccurrence>()
  for (const row of rows) {
    if (byAnalyst.has(row.analystKey)) return undefined
    byAnalyst.set(row.analystKey, row)
  }
  const latest = [...rows].sort((a, b) => (order.get(b.analystKey) ?? -1) - (order.get(a.analystKey) ?? -1))[0]
  return latest && typeof latest.materialDigest === "string" && /^sha256:[a-f0-9]{64}$/.test(latest.materialDigest) ? latest : undefined
}
function validDisplayJob(job: JobRecord | null, jobId: string): job is JobRecord {
  return Boolean(job && job.id === jobId && typeof job.role === "string" && job.role.trim().length > 0
    && job.role.trim().length <= 500 && typeof job.company === "string" && job.company.trim().length > 0 && job.company.trim().length <= 500)
}
function sha256(value: unknown): string { return createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex") }
function compare(left: string, right: string): number { return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")) }
