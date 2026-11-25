import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import { hashApprovalScope, objectiveApplicationApprovalSetItemId, parseObjectiveApplicationApprovalSet,
  parseObjectiveApplicationReviewIntent, isApprovalHash } from "@jobcopilot/agent-protocol"
import { canonicalJson, objectiveApplicationApprovedIntentId, parseObjectiveApplicationApprovedIntent,
  parseObjectiveApplicationReviewMemberProof, buildObjectiveReviewedFillHandoffOutboxData,
  parseObjectiveReviewedFillHandoffOutboxRow, objectiveReviewedFillHandoffIdempotencyKey } from "@jobcopilot/shared"
import { parseObjectiveApprovalSetMemberEnvelope } from "../broker/objective-approval-set-decision-data"
import { readObjectiveApplicationApprovalRetirement, type ObjectiveApplicationApprovalRetirementReason } from "../broker/objective-application-approval-retirement"
import { protocolScope } from "../approval/types"
import { hashArtifactContent } from "../artifacts/hash"
import { canonicalTaskGraphItemId } from "./final-task-graph-source-detail"
import type { ObjectiveJourneySource } from "./objective-journey-report-source"
import type { ObjectiveJourneyReport } from "./objective-journey-report-contract"

type Tx = Prisma.TransactionClient
type Row = Record<string, unknown>
type Status = ObjectiveJourneyReport["slots"][number]["reviewStatus"]
export type ObjectiveJourneyApprovedBinding = Readonly<{
  userId: string; sessionId: string; sourceTurnId: string; sourceFinalItemId: string; rootTaskId: string
  graphItemId: string; graphRevision: number; writerTaskId: string; reviewerTaskId: string; slotOrdinal: number; jobId: string
  reviewTurnId: string; setId: string; approvalId: string; applicationTaskId: string; materialProofHash: string
}>
export type ObjectiveJourneyApproval = Readonly<{
  slotOrdinal: number; reviewStatus: Status; reviewTurnId: string | null
  retirementReason: ObjectiveApplicationApprovalRetirementReason | null
  approvedBinding?: ObjectiveJourneyApprovedBinding
}>
type Candidate = { turn: Row; selection: ReturnType<typeof parseObjectiveApplicationReviewIntent>; ordinals: number[]; clientMessageId: string | null; valid: boolean; sequence?: bigint }
const LIMIT = 256, GOAL = "Review the selected completed Objective materials for application preparation."
const TEXT = "Review the selected verified materials. This does not authorize an application or submission."
const APPROVED = "objective_application_review_approved", APPROVED_BODY = "Objective application review approval recorded."
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/, HASH = /^[a-f0-9]{64}$/

/** Joins each source slot to its latest exact owner-scoped review request; malformed/latest bindings stay unknown. */
export async function readObjectiveJourneyReportApprovals(tx: Tx, source: ObjectiveJourneySource): Promise<readonly ObjectiveJourneyApproval[]> {
  const empty = (slotOrdinal: number, reviewStatus: Status = "not_requested", reviewTurnId: string | null = null): ObjectiveJourneyApproval =>
    ({ slotOrdinal, reviewStatus, reviewTurnId, retirementReason: null })
  const turns = await tx.agentTurn.findMany({ where: { userId: source.userId, sessionId: source.sessionId,
    source: "user", executionMode: "canonical_task_graph", AND: [
      { input: { path: ["intent", "kind"], equals: "objective_application_review" } },
      { input: { path: ["intent", "selection", "sourceTurnId"], equals: source.sourceTurnId } },
    ] }, take: LIMIT + 1, select: { id: true, userId: true, sessionId: true, source: true, executionMode: true,
      status: true, rootTaskId: true, input: true } })
  if (turns.length > LIMIT) return source.slots.map(slot => empty(slot.ordinal, "unknown"))
  const candidates = turns.map(turn => candidate(turn, source))
  const messageIds = candidates.map(row => row.clientMessageId).filter((id): id is string => id !== null)
  const inputs = messageIds.length ? await tx.agentInput.findMany({ where: { userId: source.userId, sessionId: source.sessionId,
    clientMessageId: { in: messageIds } }, take: LIMIT + 1, select: { targetTurnId: true, clientMessageId: true,
      delivery: true, status: true, acceptedSequence: true, cancelledAt: true } }) : []
  if (inputs.length > LIMIT) return source.slots.map(slot => empty(slot.ordinal, "unknown"))
  for (const row of candidates) {
    const found = inputs.filter(input => input.clientMessageId === row.clientMessageId && input.targetTurnId === row.turn.id)
    const input = found[0]
    if (found.length === 1 && input?.delivery === "follow_up" && ["accepted", "consumed"].includes(input.status)
      && input.cancelledAt === null && sequence(input.acceptedSequence) !== null) row.sequence = sequence(input.acceptedSequence)!
  }
  const bySlot = new Map<number, Candidate[]>()
  for (const row of candidates) for (const ordinal of row.ordinals) bySlot.set(ordinal, [...(bySlot.get(ordinal) ?? []), row])
  const heads = new Map<string, Promise<ReviewHead | null>>()
  return Promise.all(source.slots.map(async slot => {
    const rows = bySlot.get(slot.ordinal) ?? []
    if (!rows.length) return empty(slot.ordinal)
    if (rows.some(row => row.sequence === undefined)) return empty(slot.ordinal, "unknown", rows.at(-1)?.turn.id as string | null ?? null)
    rows.sort((a, b) => a.sequence! === b.sequence! ? 0 : a.sequence! > b.sequence! ? -1 : 1)
    const selected = rows[0]!
    if (rows[1]?.sequence === selected.sequence || !selected.valid || !selected.selection) return empty(slot.ordinal, "unknown", selected.turn.id as string)
    if (!slot.sourceReady || !slot.jobId || !slot.writerTaskId || !slot.reviewerTaskId) return empty(slot.ordinal, "unknown", selected.turn.id as string)
    let headPromise = heads.get(selected.turn.id as string)
    if (!headPromise) {
      headPromise = readHead(tx, source, selected)
      heads.set(selected.turn.id as string, headPromise)
    }
    const head = await headPromise
    const approvalId = memberId(source.sessionId, selected.turn.id as string, slot.ordinal)
    if (!head) return empty(slot.ordinal, "unknown", selected.turn.id as string)
    const receipt = await readReceipt(tx, source, slot, head, approvalId)
    if (!receipt) return empty(slot.ordinal, "unknown", selected.turn.id as string)
    return readMember(tx, source, slot, head, receipt)
  }))
}

function candidate(value: unknown, source: ObjectiveJourneySource): Candidate {
  const turn = record(value) ?? {}, input = record(turn.input), intent = record(input?.intent), rawSelection = record(intent?.selection)
  const parsed = parseObjectiveApplicationReviewIntent(intent?.selection)
  const rawOrdinals = ordinals(rawSelection?.slotOrdinals, source.slots.map(slot => slot.ordinal))
  const selection = parsed && parsed.sourceTurnId === source.sourceTurnId ? parsed : null
  const content = Array.isArray(input?.content) && input.content.length === 1 ? record(input.content[0]) : null
  const valid = !!selection && !!input && !!intent && !!content && selection.rootTaskId === source.rootTaskId
    && selection.graphRevision === source.graphRevision && selection.graphItemId === canonicalTaskGraphItemId(source.rootTaskId)
    && exact(input, "clientMessageId,content,goal,intent") && exact(intent, "kind,selection,version")
    && intent.kind === "objective_application_review" && intent.version === 1 && input.goal === GOAL
    && bounded(input.clientMessageId) && exact(content, "text,type") && content.type === "text" && content.text === TEXT
    && turn.userId === source.userId && turn.sessionId === source.sessionId && turn.source === "user"
    && turn.executionMode === "canonical_task_graph" && validId(turn.id) && validId(turn.rootTaskId)
    && ["waiting_for_approval", "completed"].includes(String(turn.status))
  const clientMessageId = bounded(input?.clientMessageId) ? input.clientMessageId : null
  return { turn, selection, ordinals: selection?.slotOrdinals ? [...selection.slotOrdinals] : rawOrdinals,
    clientMessageId, valid: Boolean(valid) }
}

type ReviewHead = { reviewTurnId: string; setId: string; intentHash: string; expiresAt: string; status: "pending" | "resolved"; members: readonly { slotOrdinal: number; approvalId: string }[] }
type Receipt = { id: string; userId: string; sessionId: string; turnId: string; taskId: string; jobId: string; toolCallId: string
  status: "pending" | "approved" | "rejected" | "expired"; revision: number; expiresAt: Date; proof: NonNullable<ReturnType<typeof parseObjectiveApplicationReviewMemberProof>> }

async function readHead(tx: Tx, source: ObjectiveJourneySource, candidate: Candidate): Promise<ReviewHead | null> {
  const selection = candidate.selection, turn = candidate.turn, reviewTurnId = turn.id as string
  if (!selection || !candidate.valid || selection.sourceTurnId !== source.sourceTurnId || selection.rootTaskId !== source.rootTaskId
    || selection.graphRevision !== source.graphRevision || selection.graphItemId !== canonicalTaskGraphItemId(source.rootTaskId)) return null
  const setId = reviewSetId(source.sessionId, reviewTurnId), itemId = objectiveApplicationApprovalSetItemId(setId)
  const [roots, items] = await Promise.all([
    tx.subAgentTask.findMany({ where: { id: turn.rootTaskId as string, sessionId: source.sessionId, turnId: reviewTurnId,
      rootTaskId: turn.rootTaskId as string, parentTaskId: null, role: "orchestrator", taskType: "root", depth: 0 }, take: 2,
      select: { id: true, status: true, failureReason: true, leaseOwner: true, leaseExpiresAt: true, completedAt: true } }),
    tx.agentItem.findMany({ where: { id: itemId, sessionId: source.sessionId, turnId: reviewTurnId, type: "approval_request" }, take: 2,
      select: { id: true, sessionId: true, turnId: true, stepId: true, taskId: true, type: true, status: true, phase: true,
        revision: true, content: true, completedAt: true } }),
  ])
  const root = roots[0], item = items[0], set = item && parseObjectiveApplicationApprovalSet(item.content)
  if (roots.length !== 1 || !root || root.id !== turn.rootTaskId || roots[0]?.failureReason !== null || items.length !== 1 || !item
    || item.id !== itemId || item.sessionId !== source.sessionId || item.turnId !== reviewTurnId || item.stepId !== null || item.taskId !== null
    || item.phase !== "commentary" || !set || set.setId !== setId || set.sourceTurnId !== source.sourceTurnId
    || set.intentHash !== selectionDigest(selection) || set.members.length !== selection.slotOrdinals.length
    || set.members.some((member, i) => member.slotOrdinal !== selection.slotOrdinals[i]
      || member.approvalId !== memberId(source.sessionId, reviewTurnId, member.slotOrdinal))) return null
  const pending = item.status === "started" && item.revision === 0 && item.completedAt === null && turn.status === "waiting_for_approval"
  const resolved = item.status === "completed" && item.revision === 1 && item.completedAt instanceof Date
    && (turn.status === "waiting_for_approval" || turn.status === "completed")
  if ((!pending && !resolved) || (turn.status === "completed" && (root.status !== "completed" || root.leaseOwner !== null
    || root.leaseExpiresAt !== null || !(root.completedAt instanceof Date)))) return null
  return { reviewTurnId, setId, intentHash: selectionDigest(selection), expiresAt: set.expiresAt,
    status: pending ? "pending" : "resolved", members: set.members.map(member => ({ slotOrdinal: member.slotOrdinal, approvalId: member.approvalId })) }
}

async function readReceipt(tx: Tx, source: ObjectiveJourneySource, slot: ObjectiveJourneySource["slots"][number],
  head: ReviewHead, approvalId: string): Promise<Receipt | null> {
  if (!slot.sourceReady || !slot.jobId || !slot.writerTaskId || !slot.reviewerTaskId) return null
  const member = head.members.find(entry => entry.slotOrdinal === slot.ordinal)
  if (!member || member.approvalId !== approvalId) return null
  const rows = await tx.agentApproval.findMany({ where: { id: approvalId, userId: source.userId, sessionId: source.sessionId,
    turnId: head.reviewTurnId, type: "review_application" }, take: 2,
    select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, toolCallId: true,
      status: true, revision: true, expiresAt: true, decidedAt: true, consumedAt: true, payload: true,
      resourceHash: true, materialHash: true, answersHash: true, scopeHash: true, nonceHash: true } })
  const row = rows[0], envelope = row && parseObjectiveApprovalSetMemberEnvelope(row.payload), proof = envelope?.proof
  const expiresAt = row?.expiresAt
  if (rows.length !== 1 || !row || !envelope || !proof || !validId(row.taskId) || !validId(row.toolCallId)
    || row.jobId !== slot.jobId || row.id !== approvalId || row.userId !== source.userId || row.sessionId !== source.sessionId
    || row.turnId !== head.reviewTurnId || envelope.setId !== head.setId || envelope.sourceTurnId !== source.sourceTurnId
    || envelope.slotOrdinal !== slot.ordinal || proof.source.sourceTurnId !== source.sourceTurnId || proof.source.rootTaskId !== source.rootTaskId
    || proof.source.graphRevision !== source.graphRevision || proof.source.graphItemId !== canonicalTaskGraphItemId(source.rootTaskId)
    || proof.source.slotOrdinal !== slot.ordinal || proof.source.jobId !== slot.jobId
    || proof.source.writerTaskId !== slot.writerTaskId || proof.source.reviewerTaskId !== slot.reviewerTaskId
    || !(expiresAt instanceof Date) || !Number.isFinite(expiresAt.getTime())
    || !await validReceipt(row, proof, source, head, slot.ordinal)) return null
  const competing = await tx.agentApproval.findMany({ where: { userId: source.userId, sessionId: source.sessionId,
    turnId: head.reviewTurnId, type: "review_application", id: { not: approvalId }, AND: [
      { payload: { path: ["setId"], equals: head.setId } }, { payload: { path: ["slotOrdinal"], equals: slot.ordinal } },
    ] }, take: 1, select: { id: true } })
  if (competing.length) return null
  return { id: row.id, userId: row.userId, sessionId: row.sessionId, turnId: head.reviewTurnId,
    taskId: row.taskId, jobId: row.jobId, toolCallId: row.toolCallId, status: row.status as Receipt["status"],
    revision: row.revision, expiresAt, proof }
}

async function validReceipt(row: Row, proof: Receipt["proof"], source: ObjectiveJourneySource, head: ReviewHead, ordinal: number): Promise<boolean> {
  if (!ID.test(String(row.taskId)) || !ID.test(String(row.toolCallId)) || !["pending", "approved", "rejected", "expired"].includes(String(row.status))
    || row.toolCallId !== `objective_review_application:${head.setId}:${ordinal}`
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !(row.expiresAt instanceof Date)
    || row.expiresAt.toISOString() !== head.expiresAt || row.consumedAt !== null || proof.source.jobId !== row.jobId
    || proof.source.slotOrdinal !== ordinal || proof.resumeWitness.userId !== source.userId || proof.resumeWitness.jobId !== row.jobId
    || row.materialHash !== proof.materialProofHash || ![row.resourceHash, row.materialHash, row.answersHash, row.scopeHash, row.nonceHash].every(isApprovalHash)
    || (row.status === "pending" ? row.decidedAt !== null : !(row.decidedAt instanceof Date))) return false
  const resourceHash = bare(hashArtifactContent({ kind: "review_application", userId: source.userId, sessionId: source.sessionId,
    jobId: row.jobId, applicationTaskId: row.taskId, slotOrdinal: ordinal }))
  const answersHash = bare(hashArtifactContent({ kind: "review_application", formAnswers: null }))
  if (row.resourceHash !== resourceHash || row.answersHash !== answersHash) return false
  return row.scopeHash === await hashApprovalScope(protocolScope({ userId: source.userId, sessionId: source.sessionId,
    turnId: head.reviewTurnId, jobId: row.jobId as string, toolCallId: row.toolCallId as string, action: "review_application",
    resourceHash, materialHash: row.materialHash as string, answersHash, revision: Number(row.revision), expiresAt: row.expiresAt }, row.nonceHash as string))
}

async function readMember(tx: Tx, source: ObjectiveJourneySource, slot: ObjectiveJourneySource["slots"][number],
  head: ReviewHead, receipt: Receipt): Promise<ObjectiveJourneyApproval> {
  const { reviewTurnId, setId } = head, approvalId = receipt.id, expectedStatus = receipt.status
  const proof = receipt.proof
  const unknown = () => ({ slotOrdinal: slot.ordinal, reviewStatus: "unknown" as const, reviewTurnId, retirementReason: null })
  if (head.status === "resolved" && expectedStatus === "pending") return unknown()
  const approvedEvents = await tx.applicationTaskEvent.findMany({ where: { taskId: receipt.taskId, type: APPROVED,
    data: { path: ["approvalId"], equals: approvalId } }, take: 2,
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  const outboxKey = objectiveReviewedFillHandoffIdempotencyKey(approvalId)
  if (expectedStatus !== "approved") {
    if (approvedEvents.length) return unknown()
    const retired = expectedStatus === "expired" ? await readObjectiveApplicationApprovalRetirement(tx, {
      userId: source.userId, sessionId: source.sessionId, reviewTurnId, sourceTurnId: source.sourceTurnId, setId,
      slotOrdinal: slot.ordinal, jobId: slot.jobId!, applicationTaskId: receipt.taskId, approvalId, receiptRevision: receipt.revision,
    }) : undefined
    return { slotOrdinal: slot.ordinal, reviewStatus: expectedStatus as Status, reviewTurnId, retirementReason: retired ?? null }
  }
  const intent = approvedEvents.length === 1 ? parseObjectiveApplicationApprovedIntent(approvedEvents[0]?.data) : null
  if (!intent || !outboxKey || approvedEvents[0]?.id !== objectiveApplicationApprovedIntentId(setId, slot.ordinal)
    || approvedEvents[0]?.taskId !== receipt.taskId || approvedEvents[0]?.actor !== "user" || approvedEvents[0]?.body !== APPROVED_BODY
    || intent.userId !== source.userId || intent.sessionId !== source.sessionId || intent.sourceTurnId !== source.sourceTurnId
    || intent.reviewTurnId !== reviewTurnId || intent.setId !== setId || intent.slotOrdinal !== slot.ordinal
    || intent.approvalId !== approvalId || intent.applicationTaskId !== receipt.taskId || intent.jobId !== slot.jobId
    || intent.materialProofHash !== proof.materialProofHash || !HASH.test(intent.materialProofHash)) return unknown()
  const expected = buildObjectiveReviewedFillHandoffOutboxData({ userId: source.userId, sessionId: source.sessionId,
    applicationTaskId: receipt.taskId, approvalId, predecessorTurnId: reviewTurnId })
  const outboxRows = await tx.agentOutbox.findMany({ where: { idempotencyKey: outboxKey }, take: 2,
    select: { id: true, topic: true, aggregateId: true, idempotencyKey: true, payload: true } })
  const actual = outboxRows.length === 1 && parseObjectiveReviewedFillHandoffOutboxRow(outboxRows[0])
  if (!expected || !actual || actual.topic !== expected.topic || actual.aggregateId !== expected.aggregateId
    || actual.idempotencyKey !== expected.idempotencyKey || canonicalJson(actual.payload) !== canonicalJson(expected.payload)) return unknown()
  return { slotOrdinal: slot.ordinal, reviewStatus: "approved", reviewTurnId, retirementReason: null,
    approvedBinding: { userId: source.userId, sessionId: source.sessionId, sourceTurnId: source.sourceTurnId,
      sourceFinalItemId: source.finalItemId, rootTaskId: source.rootTaskId, graphItemId: canonicalTaskGraphItemId(source.rootTaskId),
      graphRevision: source.graphRevision, writerTaskId: slot.writerTaskId!, reviewerTaskId: slot.reviewerTaskId!,
      slotOrdinal: slot.ordinal, jobId: slot.jobId!, reviewTurnId, setId, approvalId, applicationTaskId: receipt.taskId,
      materialProofHash: proof.materialProofHash } }
}

function reviewSetId(sessionId: string, turnId: string): string {
  return "objective-review-" + createHash("sha256").update(`objective-application-review-set.v1\0${sessionId}\0${turnId}`).digest("hex").slice(0, 40)
}
function selectionDigest(value: unknown): string { return createHash("sha256").update(canonicalJson(value)).digest("hex") }
function bare(value: string): string { return value.startsWith("sha256:") ? value.slice(7) : value }
function memberId(sessionId: string, turnId: string, ordinal: number): string { return `objective-review:${reviewSetId(sessionId, turnId)}:${ordinal}` }
function ordinals(value: unknown, fallback: readonly number[]): number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n, i) => Number.isSafeInteger(n) && n >= 1 && n <= 8 && (i === 0 || n > value[i - 1]!))
    ? [...value] : [...fallback]
}
function sequence(value: unknown): bigint | null { try { const result = typeof value === "bigint" ? value : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null; return result !== null && result >= 0n ? result : null } catch { return null } }
function bounded(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }
function validId(value: unknown): value is string { return typeof value === "string" && ID.test(value) && value.trim() === value }
function exact(value: Row | null, csv: string): boolean { return !!value && Reflect.ownKeys(value).length === csv.split(",").length && Object.keys(value).sort().join(",") === csv.split(",").sort().join(",") }
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  try { if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return null
    if (Reflect.ownKeys(value).some(key => typeof key !== "string" || !Object.getOwnPropertyDescriptor(value, key)?.enumerable
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"))) return null
    return value as Row
  } catch { return null }
}
