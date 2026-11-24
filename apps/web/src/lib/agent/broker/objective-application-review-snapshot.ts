import { createHash } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import {
  hashApprovalScope, objectiveApplicationApprovalSetItemId, parseObjectiveApplicationApprovalSet,
  parseObjectiveApplicationReviewIntent, parseObjectiveTailorFinalOutcomeSidecar, parseObjectiveTailorGraph,
} from "@jobcopilot/agent-protocol"
import {
  buildObjectiveApplicationResumeWitness, canonicalJson, readAgentSelectedJobMaterial,
} from "@jobcopilot/shared"
import { hashArtifactContent } from "../artifacts/hash"
import { protocolScope } from "../approval/types"
import { canonicalTaskGraphItemId } from "../session/final-task-graph-source-detail"
import { parseObjectiveApprovalSetMemberEnvelope, type ObjectiveApprovalSetMemberEnvelope } from "./objective-approval-set-decision-data"

type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>
type Status = "pending" | "approved" | "rejected" | "expired"
export type ObjectiveApplicationReviewSnapshot = Readonly<{
  turnId: string; turnRevision: number; setStatus: "pending" | "resolved"
  members: readonly Readonly<{
    approvalId: string; slotOrdinal: number; status: Status; receiptRevision: number
    job: Readonly<{ company: string; role: string }>
    artifactRef: Readonly<{ artifactId: string; version: number; contentHash: string; sourceDigest: string }>
    resumeId: string; decisionAvailable: boolean
  }>[]
}>

const INTENT_KIND = "objective_application_review"
const REVIEW_GOAL = "Review the selected completed Objective materials for application preparation."
const REVIEW_TEXT = "Review the selected verified materials. This does not authorize an application or submission."
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const HASH = /^[a-f0-9]{64}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/

/** Reads a closed owner-scoped approval projection without locking or mutating durable rows. */
export async function readObjectiveApplicationReviewSnapshot(
  database: PrismaClient,
  input: Readonly<{ userId: string; sessionId: string; turnId: string }>,
): Promise<ObjectiveApplicationReviewSnapshot | null> {
  try {
    return await database.$transaction(tx => readSnapshot(tx, input), { isolationLevel: "RepeatableRead" })
  } catch { return null }
}

async function readSnapshot(tx: Tx, input: { userId: string; sessionId: string; turnId: string }): Promise<ObjectiveApplicationReviewSnapshot | null> {
  if (![input.userId, input.sessionId, input.turnId].every(id)) return null
  const turns = await tx.agentTurn.findMany({ where: { id: input.turnId, userId: input.userId, sessionId: input.sessionId }, take: 2,
    select: { id: true, userId: true, sessionId: true, source: true, executionMode: true, status: true, revision: true, rootTaskId: true, input: true } })
  if (turns.length !== 1) return null
  const turn = turns[0]!, selection = turnSelection(turn.input)
  if (!selection || turn.id !== input.turnId || !id(turn.rootTaskId) || turn.rootTaskId === selection.rootTaskId || turn.source !== "user"
    || turn.executionMode !== "canonical_task_graph" || !Number.isSafeInteger(turn.revision) || turn.revision < 0) return null
  const [reviewRoots, sourceTurns] = await Promise.all([
    tx.subAgentTask.findMany({ where: { id: turn.rootTaskId, sessionId: input.sessionId, turnId: input.turnId,
      rootTaskId: turn.rootTaskId, parentTaskId: null, role: "orchestrator", taskType: "root", depth: 0 }, take: 2, select: { id: true } }),
    tx.agentTurn.findMany({ where: { id: selection.sourceTurnId, userId: input.userId, sessionId: input.sessionId,
      status: "completed", source: "user", executionMode: "canonical_task_graph", rootTaskId: selection.rootTaskId }, take: 2,
      select: { id: true } }),
  ])
  if (reviewRoots.length !== 1 || sourceTurns.length !== 1) return null

  const setId = reviewSetId(input.sessionId, input.turnId), itemId = objectiveApplicationApprovalSetItemId(setId)
  const items = await tx.agentItem.findMany({ where: { id: itemId, sessionId: input.sessionId, turnId: input.turnId, type: "approval_request" }, take: 2,
    select: { id: true, sessionId: true, turnId: true, stepId: true, taskId: true, type: true, status: true, phase: true, revision: true, content: true, startedAt: true, completedAt: true } })
  const item = items[0], set = item && parseObjectiveApplicationApprovalSet(item.content)
  if (items.length !== 1 || !item || !set || item.id !== itemId || item.sessionId !== input.sessionId || item.turnId !== input.turnId
    || item.stepId !== null || item.taskId !== null || item.type !== "approval_request" || item.phase !== "commentary"
    || set.setId !== setId || set.sourceTurnId !== selection.sourceTurnId || set.intentHash !== intentHash(selection)
    || set.members.length !== selection.slotOrdinals.length || set.members.some((entry, index) =>
      entry.slotOrdinal !== selection.slotOrdinals[index] || entry.approvalId !== approvalId(setId, entry.slotOrdinal))) return null
  const pending = item.status === "started" && item.revision === 0 && item.completedAt === null && turn.status === "waiting_for_approval"
  const resolved = item.status === "completed" && item.revision === 1 && item.completedAt instanceof Date && turn.status === "waiting_for_approval"
  if (!pending && !resolved) return null
  const rawApprovals = await tx.agentApproval.findMany({
    where: { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, type: "review_application",
      OR: [{ id: { in: set.members.map(member => member.approvalId) } }, { payload: { path: ["setId"], equals: setId } }] },
    orderBy: { id: "asc" }, take: 10,
  })
  if (rawApprovals.length !== set.members.length) return null
  const byId = new Map(rawApprovals.map(row => [row.id, row]))
  const members: ObjectiveApplicationReviewSnapshot["members"][number][] = []
  const jobs = new Set<string>(), taskIds = new Set<string>(), calls = new Set<string>()
  for (const entry of set.members) {
    const receipt = byId.get(entry.approvalId), envelope = receipt && parseObjectiveApprovalSetMemberEnvelope(receipt.payload)
    const proof = envelope?.proof
    if (!receipt || !envelope || !proof || !id(receipt.jobId) || !id(receipt.taskId) || !id(receipt.toolCallId)
      || envelope.setId !== setId
      || envelope.sourceTurnId !== selection.sourceTurnId || envelope.slotOrdinal !== entry.slotOrdinal
      || proof.source.rootTaskId !== selection.rootTaskId || proof.source.graphRevision !== selection.graphRevision
      || !await validReceipt(receipt, envelope, input, setId, selection, set.expiresAt, entry.slotOrdinal)
      || jobs.has(receipt.jobId) || taskIds.has(receipt.taskId) || calls.has(receipt.toolCallId)) return null
    jobs.add(receipt.jobId); taskIds.add(receipt.taskId); calls.add(receipt.toolCallId)
    const jobId = receipt.jobId, taskId = receipt.taskId
    const [jobRows, taskRows, versionRows, headRows, reviewRows] = await Promise.all([
      tx.job.findMany({ where: { id: jobId, userId: input.userId }, take: 2, select: { id: true, company: true, role: true,
        finalResumeId: true, finalResumeAssignmentRevision: true, finalResume: { select: { id: true, userId: true, name: true, content: true,
          templateId: true, templateOptions: true, kind: true, targetJobId: true, parentResumeId: true, basicsDetached: true, materialRevision: true } } } }),
      tx.applicationTask.findMany({ where: { id: taskId, userId: input.userId, sessionId: input.sessionId, jobId }, take: 2,
        select: { id: true, resumeId: true, status: true, checkpoint: true, workerTaskId: true, fillTurnId: true,
          fillTurnSessionId: true, fillTurnUserId: true, startedAt: true, completedAt: true } }),
      tx.agentArtifactVersion.findMany({ where: { artifactId: proof.source.artifactId, version: proof.source.version,
        userId: input.userId, sessionId: input.sessionId, jobId, artifactType: "cover_letter", taskId: proof.source.writerTaskId }, take: 2 }),
      tx.agentArtifact.findMany({ where: { id: proof.source.artifactId, userId: input.userId, jobId,
        artifactType: "cover_letter", lifecycle: "draft" }, take: 2, select: { id: true, version: true, hash: true, content: true } }),
      tx.agentArtifactReview.findMany({ where: { userId: input.userId, sessionId: input.sessionId, jobId,
        artifactId: proof.source.artifactId, version: proof.source.version, contentHash: proof.source.contentHash,
        sourceDigest: proof.source.sourceDigest, currentSourceDigest: proof.source.sourceDigest, status: "passed",
        taskId: proof.source.reviewerTaskId, toolCallId: proof.source.reviewerToolCallId, reviewHash: proof.source.reviewHash }, take: 2 }),
    ])
    const job = jobRows[0], task = taskRows[0], version = versionRows[0]
    if (jobRows.length !== 1 || taskRows.length !== 1 || versionRows.length !== 1 || !job || !task || !version
      || !boundedText(job.company, 160) || !boundedText(job.role, 160)
      || job.id !== receipt.jobId || task.id !== receipt.taskId || version.taskId !== proof.source.writerTaskId
      || version.artifactId !== proof.source.artifactId || version.version !== proof.source.version
      || version.contentHash !== proof.source.contentHash || version.sourceDigest !== proof.source.sourceDigest
      || hashArtifactContent(version.content) !== proof.source.contentHash) return null
    const readyTask = task.resumeId === proof.resumeWitness.resumeId && task.status === "waiting_for_user" && task.checkpoint === "materials_ready"
      && task.workerTaskId === null && task.fillTurnId === null && task.fillTurnSessionId === null && task.fillTurnUserId === null
      && task.startedAt === null && task.completedAt === null
    const now = new Date(), currentSource = await currentJobDigest(tx, input.userId, jobId)
    const currentResume = buildCurrentResumeWitness(job, input.userId, jobId)
    const currentHead = headRows.length === 1 && headRows[0]?.version === proof.source.version && headRows[0]?.hash === proof.source.contentHash
      && headRows[0]?.id === proof.source.artifactId && pointerMatches(headRows[0]?.content, proof.source.artifactId, proof.source.version, proof.source.contentHash)
    const currentReview = reviewRows.length === 1 && reviewRows[0]?.artifactId === proof.source.artifactId
      && reviewRows[0]?.status === "passed" && reviewRows[0]?.currentSourceDigest === currentSource
    const current = Boolean(readyTask && currentSource === proof.source.sourceDigest && currentResume
      && canonicalJson(currentResume) === canonicalJson(proof.resumeWitness) && currentHead && currentReview
      && await currentObjectiveProof(tx, input, selection, proof))
    members.push({ approvalId: receipt.id, slotOrdinal: entry.slotOrdinal, status: receipt.status as Status,
      receiptRevision: receipt.revision, job: { company: job.company, role: job.role },
      artifactRef: { artifactId: proof.source.artifactId, version: proof.source.version,
        contentHash: proof.source.contentHash, sourceDigest: proof.source.sourceDigest }, resumeId: proof.resumeWitness.resumeId,
      decisionAvailable: pending && receipt.status === "pending" && (receipt.expiresAt as Date) > now && current })
  }
  if (pending && !members.some(member => member.status === "pending") || resolved && members.some(member => member.status === "pending")) return null
  return { turnId: input.turnId, turnRevision: turn.revision, setStatus: pending ? "pending" : "resolved", members }
}

async function currentObjectiveProof(tx: Tx, input: { userId: string; sessionId: string }, selection: NonNullable<ReturnType<typeof parseObjectiveApplicationReviewIntent>>,
  proof: ObjectiveApprovalSetMemberEnvelope["proof"]): Promise<boolean> {
  const source = proof.source, graphId = canonicalTaskGraphItemId(source.rootTaskId)
  if (source.graphItemId !== graphId || source.graphRevision !== selection.graphRevision) return false
  const [roots, graphs, finals] = await Promise.all([
    tx.subAgentTask.findMany({ where: { id: source.rootTaskId, sessionId: input.sessionId, turnId: source.sourceTurnId,
      rootTaskId: source.rootTaskId, parentTaskId: null, role: "orchestrator", taskType: "root", depth: 0, status: "completed" }, take: 2, select: { result: true } }),
    tx.agentItem.findMany({ where: { id: graphId, sessionId: input.sessionId, turnId: source.sourceTurnId,
      taskId: source.rootTaskId, type: "task_graph" }, take: 2, select: { id: true, revision: true, content: true } }),
    tx.agentItem.findMany({ where: { id: source.finalItemId, sessionId: input.sessionId, turnId: source.sourceTurnId,
      taskId: source.rootTaskId, type: "agent_message", status: "completed", phase: "final_answer" }, take: 2, select: { id: true, content: true } }),
  ])
  const result = record(roots[0]?.result), graphRow = graphs[0], graph = record(graphRow?.content), nodes = graph?.nodes
  const parsed = graph && parseObjectiveTailorGraph(graph.objectiveTailor, nodes), slot = parsed?.slots[source.slotOrdinal - 1]
  const nodeRows = Array.isArray(nodes) ? nodes.map(record) : [], writer = nodeRows.find(node => node?.key === (slot?.correction?.writerNodeKey ?? slot?.writerNodeKey))
  const reviewer = nodeRows.find(node => node?.key === (slot?.correction?.reviewerNodeKey ?? slot?.reviewerNodeKey)), final = record(finals[0]?.content)
  const answer = record(final?.final), sidecar = parseObjectiveTailorFinalOutcomeSidecar(final?.objectiveTailorFinalOutcomes)
  return roots.length === 1 && result?.status === "completed" && result.finalItemId === source.finalItemId
    && graphs.length === 1 && graphRow?.id === graphId && graphRow.revision === source.graphRevision && !!slot
    && slot.slotId === `tailor-${source.slotOrdinal}` && writer?.taskId === source.writerTaskId && reviewer?.taskId === source.reviewerTaskId
    && finals.length === 1 && finals[0]?.id === source.finalItemId && typeof final?.text === "string"
    && answer?.schemaVersion === "agent-harness.v2.final" && answer.response === final.text
    && sidecar?.slots[source.slotOrdinal - 1]?.status === "ready"
}

function turnSelection(value: unknown) {
  const input = record(value), intent = record(input?.intent)
  const content = Array.isArray(input?.content) && input.content.length === 1 ? record(input.content[0]) : null
  if (!input || !exact(input, "clientMessageId,content,goal,intent") || !intent || !exact(intent, "kind,selection,version")
    || !boundedText(input.clientMessageId, 128) || input.goal !== REVIEW_GOAL || !content || !exact(content, "text,type")
    || content.type !== "text" || content.text !== REVIEW_TEXT || intent.kind !== INTENT_KIND || intent.version !== 1) return null
  return parseObjectiveApplicationReviewIntent(intent.selection)
}

async function validReceipt(receipt: Row, envelope: ObjectiveApprovalSetMemberEnvelope,
  input: { userId: string; sessionId: string; turnId: string }, setId: string,
  selection: NonNullable<ReturnType<typeof parseObjectiveApplicationReviewIntent>>, expiry: string, ordinal: number): Promise<boolean> {
  const proof = envelope.proof, sourceTurnId = selection.sourceTurnId
  if (envelope.setId !== setId || envelope.sourceTurnId !== sourceTurnId || envelope.slotOrdinal !== ordinal
    || receipt.id !== approvalId(setId, ordinal) || receipt.userId !== input.userId || receipt.sessionId !== input.sessionId
    || receipt.turnId !== input.turnId || receipt.type !== "review_application" || !oneOf(receipt.status, ["pending", "approved", "rejected", "expired"])
    || !id(receipt.taskId) || !id(receipt.jobId) || !id(receipt.toolCallId) || !Number.isSafeInteger(receipt.revision) || Number(receipt.revision) < 0
    || !(receipt.expiresAt instanceof Date) || receipt.expiresAt.toISOString() !== expiry || receipt.consumedAt !== null || proof.source.jobId !== receipt.jobId
    || proof.source.sourceTurnId !== sourceTurnId || proof.source.slotOrdinal !== ordinal || proof.resumeWitness.userId !== input.userId
    || proof.resumeWitness.jobId !== receipt.jobId || receipt.materialHash !== proof.materialProofHash
    || !hash(receipt.resourceHash) || !hash(receipt.answersHash) || !hash(receipt.materialHash) || !hash(receipt.scopeHash) || !hash(receipt.nonceHash)
    || (receipt.status === "pending" ? receipt.decidedAt !== null : !(receipt.decidedAt instanceof Date))) return false
  const resource = bareHash(hashArtifactContent({ kind: "review_application", userId: input.userId, sessionId: input.sessionId,
    jobId: receipt.jobId, applicationTaskId: receipt.taskId, slotOrdinal: ordinal }))
  const answers = bareHash(hashArtifactContent({ kind: "review_application", formAnswers: null }))
  if (receipt.resourceHash !== resource || receipt.answersHash !== answers) return false
  return receipt.scopeHash === await hashApprovalScope(protocolScope({ userId: input.userId, sessionId: input.sessionId, turnId: input.turnId,
    jobId: receipt.jobId as string, toolCallId: receipt.toolCallId as string, action: "review_application",
    resourceHash: receipt.resourceHash, materialHash: receipt.materialHash, answersHash: receipt.answersHash,
    revision: Number(receipt.revision), expiresAt: receipt.expiresAt }, receipt.nonceHash as string))
}

function buildCurrentResumeWitness(job: Row | undefined, userId: string, jobId: string) {
  const resume = record(job?.finalResume)
  if (!job || !resume || job.finalResumeId !== resume.id || resume.userId !== userId || resume.targetJobId !== jobId || resume.kind !== "adapted"
    || !id(resume.id) || typeof resume.name !== "string" || !(resume.templateId === null || typeof resume.templateId === "string")
    || !(resume.templateOptions === null || typeof resume.templateOptions === "object")
    || !(resume.parentResumeId === null || typeof resume.parentResumeId === "string") || typeof resume.basicsDetached !== "boolean"
    || !Number.isSafeInteger(resume.materialRevision) || !Number.isSafeInteger(job.finalResumeAssignmentRevision)) return null
  return buildObjectiveApplicationResumeWitness({ userId, jobId, resumeId: resume.id,
    finalResumeAssignmentRevision: Number(job.finalResumeAssignmentRevision), materialRevision: Number(resume.materialRevision),
    material: { name: resume.name, content: resume.content, templateId: resume.templateId, templateOptions: resume.templateOptions,
      kind: resume.kind, targetJobId: resume.targetJobId, parentResumeId: resume.parentResumeId, basicsDetached: resume.basicsDetached } })
}

async function currentJobDigest(tx: Tx, userId: string, jobId: string): Promise<string | null> {
  try {
    const material = await readAgentSelectedJobMaterial({ query: async <T>(sql: string, values: readonly unknown[]) => ({
      rows: await tx.$queryRawUnsafe<T[]>(sql, ...values),
    }) }, { userId, jobId })
    return material.preparation.sourceDigest
  } catch { return null }
}
function pointerMatches(value: unknown, artifactId: string, version: number, contentHash: string): boolean {
  const row = record(value)
  return !!row && exact(row, "artifactId,contentHash,kind,version") && row.kind === "agent_artifact_version"
    && row.artifactId === artifactId && row.version === version && row.contentHash === contentHash
}
function reviewSetId(sessionId: string, turnId: string): string {
  return `objective-review-${createHash("sha256").update(`objective-application-review-set.v1\0${sessionId}\0${turnId}`).digest("hex").slice(0, 40)}`
}
function approvalId(setId: string, ordinal: number): string { return `objective-review:${setId}:${ordinal}` }
function intentHash(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex") }
function bareHash(value: string): string { return value.startsWith("sha256:") ? value.slice(7) : value }
function hash(value: unknown): value is string { return typeof value === "string" && HASH.test(value) }
function oneOf(value: unknown, choices: readonly string[]): boolean { return typeof value === "string" && choices.includes(value) }
function id(value: unknown): value is string { return typeof value === "string" && ID.test(value) }
function boundedText(value: unknown, limit: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= limit && value.trim() === value }
function exact(value: Row, csv: string): boolean { return Reflect.ownKeys(value).length === csv.split(",").length && Object.keys(value).sort().join(",") === csv.split(",").sort().join(",") }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try {
    const keys = Reflect.ownKeys(value)
    if ((Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
      || keys.some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
        || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return null
    return value as Row
  } catch { return null }
}
