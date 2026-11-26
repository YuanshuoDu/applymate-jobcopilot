import type { Prisma } from "@prisma/client"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V3_SCHEMA, parseObjectiveTailorFinalOutcomeSidecar,
  type ObjectiveTailorGraph, type ObjectiveTailorSourceGroups } from "@jobcopilot/agent-protocol"
import { objectiveApplicationReviewPairProof, validObjectiveApplicationSourceManifest } from "../broker/objective-application-review-source-proof"
import { canonicalTaskGraphItemId, canonicalTaskGraphSourceKey, isCanonicalTaskGraphSourceManifest } from "./final-task-graph-source-detail"
import { parseFinalTaskGraphSourceManifest, type FinalTaskGraphSourceManifest } from "./final-task-graph-source-manifest"
import { readFinalTaskGraphSourceSnapshot } from "./objective-tailor-final-source-graph"
import { parseObjectiveTailorProgressSnapshot } from "./objective-tailor-progress-snapshot"
import { readObjectiveTailorSourceGroups } from "./objective-tailor-source-groups"
import type { ObjectiveJourneyReport, ObjectiveJourneyReportedScoreFloor } from "./objective-journey-report-contract"
import { objectiveJourneyAnalystGraphRequirements } from "./objective-journey-report-requirement-proof"
type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>; type Slot = ObjectiveJourneyReport["slots"][number]
type SourceGraphNodes = readonly Row[]
type SlotSource = Readonly<{
  ordinal: number; tailoringStatus: Slot["tailoringStatus"]; sourceReady: boolean; jobId: string | null
  job: Slot["job"]; writerTaskId: string | null; reviewerTaskId: string | null
  requirementAnalyst?: Readonly<{ nodeKey: string; taskId: string; attemptCount: number; proofDigest: string;
    jobMaterialDigest: string; criteriaIds: readonly string[]; dependencyNodeKeys: readonly string[];
    dependencies: readonly Readonly<{ nodeKey: string; taskId: string }>[] }> | null
}>
export type ObjectiveJourneySource = Readonly<{
  userId: string; sessionId: string; sourceTurnId: string; rootTaskId: string; finalItemId: string; graphRevision: number
  sourceCounts: ObjectiveJourneyReport["sourceCounts"]; slots: readonly SlotSource[]; reportedScoreFloor?: ObjectiveJourneyReportedScoreFloor
}>
export type ObjectiveJourneyProofContext = Readonly<{
  userId: string; sessionId: string; sourceTurnId: string; rootTaskId: string; finalItemId: string; graphRevision: number
  manifest: FinalTaskGraphSourceManifest
  sidecar: NonNullable<ReturnType<typeof parseObjectiveTailorFinalOutcomeSidecar>>
  progress: NonNullable<ReturnType<typeof parseObjectiveTailorProgressSnapshot>>
  tasks: ReadonlyMap<string, Row>; graphNodes: SourceGraphNodes; sourceGroups?: ObjectiveTailorSourceGroups
}>
export async function readObjectiveJourneySource(tx: Tx, input: Readonly<{ userId: string; sessionId: string; finalItemId: string }>): Promise<ObjectiveJourneySource | null> {
  const context = await readObjectiveJourneyProofContext(tx, input)
  if (!context || !validObjectiveApplicationSourceManifest(context.manifest, input.finalItemId, context.progress, context.tasks)) return null
  return readSlots(tx, input, context.sourceTurnId, context.rootTaskId, context.graphRevision, context.progress, context.sidecar, context.tasks, context.graphNodes)
}
/** Reads the owned graph proof before the report-specific completed-only gate. */
export async function readObjectiveJourneyProofContext(tx: Tx, input: Readonly<{ userId: string; sessionId: string; finalItemId: string }>,
  expectedGraphRevision?: number): Promise<ObjectiveJourneyProofContext | null> {
  if (![input.userId, input.sessionId, input.finalItemId].every(id)) return null
  const sessions = await tx.agentSession.findMany({ where: { id: input.sessionId, userId: input.userId }, take: 2, select: { id: true, userId: true } })
  const finals = await tx.agentItem.findMany({ where: { id: input.finalItemId, sessionId: input.sessionId, type: "agent_message",
    status: "completed", phase: "final_answer" }, take: 2, select: { id: true, sessionId: true, turnId: true, taskId: true,
      type: true, status: true, phase: true, content: true } })
  const final = finals[0] && record(finals[0]), content = record(final?.content), answer = record(content?.final)
  if (sessions.length !== 1 || sessions[0]?.id !== input.sessionId || sessions[0]?.userId !== input.userId
    || finals.length !== 1 || !final || !content || !answer || final.sessionId !== input.sessionId || !id(final.turnId)
    || !id(final.taskId) || final.id !== input.finalItemId || final.type !== "agent_message" || final.status !== "completed"
    || final.phase !== "final_answer" || answer.schemaVersion !== "agent-harness.v2.final" || answer.response !== content.text
    || typeof content.text !== "string") return null
  const turns = await tx.agentTurn.findMany({ where: { id: final.turnId, userId: input.userId, sessionId: input.sessionId }, take: 2,
    select: { id: true, userId: true, sessionId: true, status: true, source: true, executionMode: true, rootTaskId: true } })
  const turn = turns[0] && record(turns[0])
  if (turns.length !== 1 || !turn || turn.id !== final.turnId || turn.userId !== input.userId || turn.sessionId !== input.sessionId
    || turn.status !== "completed" || turn.source !== "user" || turn.executionMode !== "canonical_task_graph" || turn.rootTaskId !== final.taskId) return null
  return readGraph(tx, input, final, turn, expectedGraphRevision)
}
async function readGraph(tx: Tx, input: { userId: string; sessionId: string; finalItemId: string }, final: Row, turn: Row,
  expectedGraphRevision?: number): Promise<ObjectiveJourneyProofContext | null> {
  const sourceTurnId = turn.id, rootTaskId = turn.rootTaskId
  if (!id(sourceTurnId) || !id(rootTaskId)) return null
  const graphId = canonicalTaskGraphItemId(rootTaskId)
  const [roots, graphs] = await Promise.all([
    tx.subAgentTask.findMany({ where: { id: rootTaskId, sessionId: input.sessionId, turnId: sourceTurnId, rootTaskId,
      parentTaskId: null, role: "orchestrator", taskType: "root", depth: 0, status: "completed" }, take: 2,
      select: { id: true, status: true, result: true, failureReason: true, completedAt: true, leaseOwner: true, leaseExpiresAt: true } }),
    tx.agentItem.findMany({ where: { id: graphId, sessionId: input.sessionId, turnId: sourceTurnId, taskId: rootTaskId, type: "task_graph" }, take: 2,
      select: { id: true, sessionId: true, turnId: true, taskId: true, type: true, revision: true, content: true } }),
  ])
  const root = roots[0] && record(roots[0]), graphRow = graphs[0] && record(graphs[0]), finalContent = record(final.content)
  const manifest = parseFinalTaskGraphSourceManifest(finalContent?.taskGraphSources)
  const sidecar = parseObjectiveTailorFinalOutcomeSidecar(finalContent?.objectiveTailorFinalOutcomes)
  const sourceGroups = manifest && sidecar ? readObjectiveTailorSourceGroups(finalContent?.objectiveTailorSourceGroups, manifest, sidecar) : undefined
  const result = record(root?.result), progress = graphRow && parseObjectiveTailorProgressSnapshot(graphRow.content)
  if (roots.length !== 1 || !root || root.id !== rootTaskId || root.status !== "completed" || root.failureReason !== null
    || !(root.completedAt instanceof Date) || root.leaseOwner !== null || root.leaseExpiresAt !== null
    || result?.status !== "completed" || result.finalItemId !== input.finalItemId || graphs.length !== 1 || !graphRow
    || graphRow.id !== graphId || graphRow.sessionId !== input.sessionId || graphRow.turnId !== sourceTurnId || graphRow.taskId !== rootTaskId
    || graphRow.type !== "task_graph" || !Number.isSafeInteger(graphRow.revision) || expectedGraphRevision !== undefined && graphRow.revision !== expectedGraphRevision
    || !manifest || !sidecar || !progress
    || progress.marker.slots.length !== sidecar.slots.length || !isCanonicalTaskGraphSourceManifest(input.finalItemId, manifest)
    || graphRow.revision !== manifest.graphRevision || "graphRevision" in sidecar && sidecar.graphRevision !== graphRow.revision) return null
  const projected = readFinalTaskGraphSourceSnapshot(graphRow.content, final.content)
  if (!projected || projected.kind !== "objective-tailor") return null
  const graphNodes = sourceGraphNodes(projected.graph)
  if (!graphNodes) return null
  const allTaskIds = [rootTaskId, ...progress.nodes.map(node => node.taskId)]
  if (new Set(allTaskIds).size !== allTaskIds.length) return null
  const rows = await tx.subAgentTask.findMany({ where: { sessionId: input.sessionId, turnId: sourceTurnId, rootTaskId, id: { in: allTaskIds } },
    take: allTaskIds.length + 1, select: { id: true, sessionId: true, turnId: true, rootTaskId: true, parentTaskId: true,
      role: true, taskType: true, status: true, attemptCount: true, leaseOwner: true, leaseExpiresAt: true, result: true, context: true,
    } }) as unknown[]
  const tasks = new Map<string, Row>()
  for (const value of rows) {
    const task = record(value)
    if (!task || !id(task.id) || tasks.has(task.id) || task.sessionId !== input.sessionId || task.turnId !== sourceTurnId
      || task.rootTaskId !== rootTaskId) return null
    tasks.set(task.id, task)
  }
  if (rows.length !== allTaskIds.length || allTaskIds.some(taskId => !tasks.has(taskId))) return null
  return { userId: input.userId, sessionId: input.sessionId, sourceTurnId, rootTaskId, finalItemId: input.finalItemId,
    graphRevision: Number(graphRow.revision), manifest, sidecar, progress, tasks, graphNodes, ...(sourceGroups ? { sourceGroups } : {}) }
}
function sourceGraphNodes(value: unknown): SourceGraphNodes | undefined {
  try { const nodes = record(value)?.nodes
    if (!Array.isArray(nodes) || Object.getPrototypeOf(nodes) !== Array.prototype || nodes.length > 8 || Reflect.ownKeys(nodes).length !== nodes.length + 1) return undefined
    const rows = nodes.map(record); return rows.every((row): row is Row => !!row) ? rows : undefined
  } catch { return undefined }
}
async function readSlots(tx: Tx, input: { userId: string; sessionId: string; finalItemId: string }, sourceTurnId: string, rootTaskId: string, graphRevision: number,
  progress: NonNullable<ReturnType<typeof parseObjectiveTailorProgressSnapshot>>, sidecar: NonNullable<ReturnType<typeof parseObjectiveTailorFinalOutcomeSidecar>>,
  tasks: ReadonlyMap<string, Row>, graphNodes: SourceGraphNodes): Promise<ObjectiveJourneySource | null> {
  const candidates = progress.marker.slots.map((slot, index) => candidateForSlot(slot, index + 1, graphRevision, progress, tasks))
  const jobIds = candidates.flatMap(candidate => candidate ? [candidate.jobId] : [])
  const frequencies = new Map<string, number>()
  for (const jobId of jobIds) frequencies.set(jobId, (frequencies.get(jobId) ?? 0) + 1)
  const uniqueJobIds = jobIds.filter(jobId => frequencies.get(jobId) === 1)
  const jobs = uniqueJobIds.length ? await tx.job.findMany({ where: { userId: input.userId, id: { in: uniqueJobIds } }, take: uniqueJobIds.length + 1,
    select: { id: true, userId: true, company: true, role: true } }) : []
  const jobById = new Map<string, Row>()
  for (const value of jobs) {
    const job = record(value)
    if (!job || !id(job.id) || job.userId !== input.userId || jobById.has(job.id)) return null
    jobById.set(job.id, job)
  }
  if (jobById.size !== jobs.length) return null
  const slots: SlotSource[] = []
  for (let index = 0; index < progress.marker.slots.length; index += 1) {
    const marker = progress.marker.slots[index]!, ordinal = index + 1, status = sidecar.slots[index]!.status
    const candidate = candidates[index]
    const jobRow = candidate && frequencies.get(candidate.jobId) === 1 ? jobById.get(candidate.jobId) : undefined
    const job = jobRow ? jobLabel(jobRow) : undefined
    const pair = status === "ready" && candidate && job ? readyPair(marker, ordinal, graphRevision, candidate.jobId, progress, tasks) : undefined
    const requirementAnalyst = status === "ready" && pair && candidate && job
      ? requirementAnalystFor(marker.sourceAnalystNodeKey, candidate, progress, tasks, graphNodes) : null
    slots.push({ ordinal, tailoringStatus: status, sourceReady: !!pair && !!job, jobId: job ? candidate?.jobId ?? null : null,
      job: job ?? null, writerTaskId: pair?.writerTaskId ?? null, reviewerTaskId: pair?.reviewerTaskId ?? null, requirementAnalyst })
  }
  const sourceCounts = "sourceCounts" in sidecar ? sidecar.sourceCounts : {
    discoveredJobs: { knownCount: null, coverage: "unavailable" as const }, analyzedJobs: { knownCount: null, coverage: "unavailable" as const },
  }
  const reportedScoreFloor = sidecar.schemaVersion === OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_V3_SCHEMA
    ? sidecar.reportedScoreFloor : undefined
  return { userId: input.userId, sessionId: input.sessionId, sourceTurnId,
    rootTaskId, finalItemId: input.finalItemId, graphRevision, sourceCounts, slots,
    ...(reportedScoreFloor ? { reportedScoreFloor } : {}) }
}
function candidateForSlot(slot: ObjectiveTailorGraph["slots"][number], ordinal: number, revision: number,
  progress: NonNullable<ReturnType<typeof parseObjectiveTailorProgressSnapshot>>, tasks: ReadonlyMap<string, Row>):
  { jobId: string; sourceAnalystKeys: readonly string[]; analystProofDigest: string; jobMaterialDigest: string } | undefined {
  const writerNode = progress.nodes.find(node => node.key === slot.writerNodeKey), writer = writerNode && tasks.get(writerNode.taskId)
  const context = writer && record(writer.context), selected = context && exactRecord(context.selectedJobPreparation, "jobId")
  const witness = context && candidateWitness(context.objectiveTailorCandidateWitness)
  const contextKeys = context && Object.keys(context).sort().join(",")
  const allowed = "objectiveTailorCandidateMode,objectiveTailorCandidateWitness,selectedJobPreparation"
  const withDependencies = `${allowed},taskGraphDependencyResults`
  const sourceNodes = new Map(progress.nodes.map(node => [node.key, node]))
  return context?.objectiveTailorCandidateMode === true && (contextKeys === allowed || contextKeys === withDependencies)
    && selected?.jobId === witness?.jobId && witness?.slotId === `tailor-${ordinal}`
    && witness.writerNodeKey === slot.writerNodeKey && witness.reviewerNodeKey === slot.reviewerNodeKey
    && witness.sourceAnalystKeys.includes(slot.sourceAnalystNodeKey)
    && witness.sourceAnalystKeys.every(key => sourceNodes.get(key)?.templateId === "analyst")
    && witness.admittedRevision <= revision ? { jobId: witness.jobId, sourceAnalystKeys: witness.sourceAnalystKeys,
      analystProofDigest: witness.analystProofDigest, jobMaterialDigest: witness.materialDigest } : undefined
}
function requirementAnalystFor(nodeKey: string, candidate: NonNullable<ReturnType<typeof candidateForSlot>>,
  progress: NonNullable<ReturnType<typeof parseObjectiveTailorProgressSnapshot>>, tasks: ReadonlyMap<string, Row>,
  graphNodes: SourceGraphNodes): SlotSource["requirementAnalyst"] {
  const node = progress.nodes.find(value => value.key === nodeKey), task = node && tasks.get(node.taskId)
  const typedNode = graphNodes.find(value => value.key === nodeKey), verification = objectiveJourneyAnalystGraphRequirements(typedNode?.verification)
  const criteriaIds = verification?.criteriaIds ?? [], dependencyNodeKeys = verification?.dependencyNodeKeys ?? []
  const dependencies = dependencyNodeKeys.flatMap(key => {
    const dependency = progress.nodes.find(value => value.key === key)
    return dependency ? [{ nodeKey: key, taskId: dependency.taskId }] : []
  })
  const hasScoutMembership = verification?.hasScoutMembership ?? false
  return candidate.sourceAnalystKeys.length === 1 && candidate.sourceAnalystKeys[0] === nodeKey && node?.templateId === "analyst"
    && typedNode?.verificationDisposition === "typed" && verification !== undefined && hasScoutMembership
    && criteriaIds.length > 0 && dependencyNodeKeys.length > 0 && dependencies.length === dependencyNodeKeys.length
    && task?.id === node.taskId && task.role === "analyst" && task.taskType === "job_analysis" && task.status === "completed"
    && Number.isSafeInteger(task.attemptCount) && Number(task.attemptCount) >= 1 && task.leaseOwner === null && task.leaseExpiresAt === null
    ? { nodeKey, taskId: node.taskId, attemptCount: Number(task.attemptCount), proofDigest: candidate.analystProofDigest,
      jobMaterialDigest: candidate.jobMaterialDigest, criteriaIds, dependencyNodeKeys, dependencies } : null
}
function readyPair(slot: ObjectiveTailorGraph["slots"][number], ordinal: number, revision: number,
  jobId: string, progress: NonNullable<ReturnType<typeof parseObjectiveTailorProgressSnapshot>>, tasks: ReadonlyMap<string, Row>) {
  const correction = slot.correction, writerNode = progress.nodes.find(node => node.key === (correction?.writerNodeKey ?? slot.writerNodeKey))
  const reviewerNode = progress.nodes.find(node => node.key === (correction?.reviewerNodeKey ?? slot.reviewerNodeKey))
  const writerTask = writerNode && tasks.get(writerNode.taskId), reviewerTask = reviewerNode && tasks.get(reviewerNode.taskId)
  const source = pairSource(ordinal, writerNode?.taskId, reviewerNode?.taskId, writerTask?.result, reviewerTask?.result)
  if (!writerNode || !reviewerNode || !writerTask || !reviewerTask || !source) return undefined
  const proof = objectiveApplicationReviewPairProof({ snapshot: progress, slotOrdinal: ordinal, graphRevision: revision, jobId, source,
    writerTask, reviewerTask, tasks })
  return proof ? { writerTaskId: writerNode.taskId, reviewerTaskId: reviewerNode.taskId } : undefined
}
function pairSource(slotOrdinal: number, writerTaskId: string | undefined, reviewerTaskId: string | undefined, writerValue: unknown, reviewerValue: unknown) {
  const writer = record(record(writerValue)?.structuredResult), reviewer = record(record(reviewerValue)?.structuredResult)
  const ref = record(writer?.artifactRef)
  if (!writerTaskId || !reviewerTaskId || !ref || !reviewer || !id(ref.artifactId)
    || typeof ref.version !== "number" || !Number.isSafeInteger(ref.version) || ref.version < 1
    || typeof ref.contentHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.contentHash)
    || typeof ref.sourceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(ref.sourceDigest)
    || typeof reviewer.reviewHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(reviewer.reviewHash)) return undefined
  return { slotOrdinal, writerTaskId, reviewerTaskId, artifactId: ref.artifactId, version: ref.version,
    contentHash: ref.contentHash, sourceDigest: ref.sourceDigest, reviewHash: reviewer.reviewHash }
}
function candidateWitness(value: unknown): { jobId: string; slotId: string; writerNodeKey: string; reviewerNodeKey: string;
  sourceAnalystKeys: readonly string[]; analystProofDigest: string; materialDigest: string; admittedRevision: number } | undefined {
  const row = record(value), candidate = row && record(row.candidate), sources = row?.sourceAnalystKeys
  if (!row || !candidate || Object.keys(row).sort().join(",") !== "admittedRevision,analystProofDigest,candidate,candidateRef,reviewerNodeKey,schemaVersion,slotId,sourceAnalystKeys,sourceGraphDigest,sourceGraphRevision,sourceStatusDigest,writerNodeKey"
    || Object.keys(candidate).sort().join(",") !== "jobId,materialDigest,score" || !id(candidate.jobId)
    || typeof candidate.materialDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(candidate.materialDigest)
    || row.schemaVersion !== "agent-harness.v2.objective-tailor-wave-witness.v1" || typeof row.slotId !== "string"
    || typeof row.writerNodeKey !== "string" || typeof row.reviewerNodeKey !== "string" || !denseStrings(sources)
    || !Number.isSafeInteger(row.admittedRevision) || Number(row.admittedRevision) < 1
    || !Number.isSafeInteger(row.sourceGraphRevision) || Number(row.sourceGraphRevision) < 1 || Number(row.admittedRevision) <= Number(row.sourceGraphRevision)
    || typeof candidate.score !== "number" || !Number.isFinite(candidate.score) || candidate.score < 0 || candidate.score > 10
    || typeof row.candidateRef !== "string" || !/^otc2_[a-f0-9]{64}$/.test(row.candidateRef)
    || ![row.analystProofDigest, row.sourceGraphDigest, row.sourceStatusDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) return undefined
  return { jobId: candidate.jobId, slotId: row.slotId, writerNodeKey: row.writerNodeKey, reviewerNodeKey: row.reviewerNodeKey,
    sourceAnalystKeys: sources, analystProofDigest: row.analystProofDigest as string, materialDigest: candidate.materialDigest,
    admittedRevision: Number(row.admittedRevision) }
}
function denseStrings(value: unknown): value is string[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < 1 || value.length > 8) return false
  try {
    if (Reflect.ownKeys(value).length !== value.length + 1) return false
    const items: string[] = []
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") || !id(descriptor.value)) return false
      items.push(descriptor.value)
    }
    return new Set(items).size === items.length
  } catch { return false }
}
function jobLabel(row: Row): Slot["job"] | undefined {
  return typeof row.company === "string" && row.company.trim() === row.company && row.company.length > 0 && row.company.length <= 160
    && typeof row.role === "string" && row.role.trim() === row.role && row.role.length > 0 && row.role.length <= 160
    ? { company: row.company, role: row.role } : undefined
}
function exactRecord(value: unknown, keys: string): Row | undefined { const row = record(value); return row && Object.keys(row).sort().join(",") === keys ? row : undefined }
function record(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const keys = Reflect.ownKeys(value); return (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && keys.every(key => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value")) ? value as Row : undefined } catch { return undefined }
}
function id(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value) && value.trim() === value }
