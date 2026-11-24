import type { Prisma, PrismaClient } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope, type ApprovalScope } from "@jobcopilot/agent-protocol"
import {
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR, OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY,
  OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
  bindReviewedApplicationSubmissionMaterial, hashAgentReceiptValue, hashObjectiveApplicationSubmissionMaterial,
  parseObjectiveApplicationSubmissionManifestEvent,
  parseObjectiveReviewedApplicationFillBrowserStartEvent, parseObjectiveReviewedFillSource,
  type LegacyApplicationSubmissionMaterial, type ObjectiveReviewedFillSource,
} from "@jobcopilot/shared"
import type { ReviewedSubmitMaterialInput } from "./reviewed-submit-material"
import { hashArtifactContent } from "../artifacts/hash"
import { verifyObjectiveReviewedFillFreshness, type ObjectiveReviewedFillAuthority } from "./objective-reviewed-fill-authority"

const START_EVENT = "reviewed_application_fill_browser_started"
const START_BODY = "Reviewed application material bound to browser-start attempt."
const RESOURCE_HASH = /^sha256:([a-f0-9]{64})$/

type Client = Pick<PrismaClient, "applicationTaskEvent" | "subAgentTask" | "agentApproval">
type ReceiptRow = { id: string; userId: string; sessionId: string; turnId: string; jobId: string; taskId: string | null
  type: string; status: string; toolCallId: string | null; payload: unknown; resourceHash: string | null; materialHash: string | null
  answersHash: string | null; scopeHash: string | null; nonceHash: string | null; revision: number; expiresAt: Date | null }
type ReplayReceipt = Readonly<{ nonceHash: string | null; resourceHash: string | null; materialHash: string | null; answersHash: string | null
  expiresAt: Date | null; sessionId: string | null; turnId: string | null; toolCallId: string | null; jobId: string | null; revision: number; scopeHash: string | null }>
export type ObjectiveSubmitTaskRow = Readonly<{
  id: string; userId: string; sessionId: string | null; jobId: string; fillTurnId: string | null
  fillTurnSessionId: string | null; fillTurnUserId: string | null; status: string; checkpoint: string | null
  resumeId: string | null; coverLetterId: string | null; confirmedAnswers: unknown
}>
export type ObjectiveSubmitFillTurnRow = Readonly<{
  id: string; userId: string; sessionId: string; source: string; status: string; rootTaskId: string | null
  input: unknown; executionMode: string | null; createdAt: Date
}>
export type ObjectiveReviewedSubmitMaterial = Readonly<{
  mode: "reviewed"; ready: true; resourceHash: string; materialHash: string; answersHash: string
  objectiveSource: ObjectiveReviewedFillSource; fillTurnCreatedAt: Date
}>
export type ObjectiveReceiptVerifier = (material: LegacyApplicationSubmissionMaterial, hashes: {
  resourceHash: string; materialHash: string; answersHash: string
}) => Promise<boolean>
export type ObjectiveAuthorityContext = Readonly<{ tx: Prisma.TransactionClient; authority: ObjectiveReviewedFillAuthority }>

/** V3 is accepted only from its immutable worker manifest, exact completed Fill and review authority. */
export async function resolveObjectiveReviewedSubmitMaterial(
  client: Client, input: ReviewedSubmitMaterialInput, task: ObjectiveSubmitTaskRow, turn: ObjectiveSubmitFillTurnRow,
  verifyReceipt: ObjectiveReceiptVerifier, authorityContext?: ObjectiveAuthorityContext,
): Promise<ObjectiveReviewedSubmitMaterial | null> {
  try {
    if (!sameTask(task, input) || turn.id !== input.fillTurnId || turn.userId !== input.userId || turn.sessionId !== input.sessionId
      || turn.source !== "user" || turn.status !== "waiting_for_approval" || turn.executionMode !== "canonical_task_graph"
      || !validDate(turn.createdAt) || !turn.rootTaskId || turn.rootTaskId.trim() !== turn.rootTaskId
      || task.status !== "waiting_for_authorization" || task.checkpoint !== "form_filled") return null
    const source = parseObjectiveReviewedFillSource(turn.input)
    if (!source) return null
    const binding = await readBrowserBinding(client, input, task, turn)
    if (!binding || !sameSource(binding.objectiveSource, source) || binding.proof.rootTaskId === turn.rootTaskId) return null
    const manifest = await readManifest(client, input, task, source)
    if (!manifest || manifest.material.applicationTaskId !== task.id || manifest.material.jobId !== task.jobId
      || manifest.material.resumeId !== task.resumeId || manifest.material.coverLetterId !== task.coverLetterId) return null
    const bound = await bindReviewedApplicationSubmissionMaterial({ applicationTaskId: task.id, jobId: task.jobId,
      resumeId: task.resumeId, coverLetterId: task.coverLetterId }, binding.proof)
    if (!bound || bound.reviewedCoverLetterHash !== manifest.material.reviewedCoverLetterHash) return null
    const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
    if (answersHash !== manifest.answersHash) return null
    const materialHash = await hashObjectiveApplicationSubmissionMaterial(manifest.material)
    const hashMatch = RESOURCE_HASH.exec(manifest.hash)
    if (!materialHash || hashMatch?.[0] !== manifest.hash) return null
    const resourceHash = hashMatch[1]!
    const legacyMaterial: LegacyApplicationSubmissionMaterial = { applicationTaskId: task.id, jobId: task.jobId,
      resumeId: task.resumeId, coverLetterId: task.coverLetterId }
    if (!await verifyReceipt(legacyMaterial, { resourceHash, materialHash, answersHash })) return null
    if (authorityContext) {
      const authority = authorityContext.authority
      if (authority.jobId !== task.jobId || authority.resumeId !== manifest.material.resumeId
        || !sameSource(authority.source, source) || !sameBrowserProof(binding.proof, authority.input.member.proof.source)
        || !await decidedBeforeFill(client, input, source, turn.createdAt)) return null
      await verifyObjectiveReviewedFillFreshness(authorityContext.tx, authority)
    }
    return { mode: "reviewed", ready: true, resourceHash, materialHash, answersHash,
      objectiveSource: source, fillTurnCreatedAt: turn.createdAt }
  } catch { return null }
}

export async function signedReceiptMatches(client: Client, input: ReviewedSubmitMaterialInput,
  material: LegacyApplicationSubmissionMaterial, hashes: { resourceHash: string; materialHash: string; answersHash: string }): Promise<boolean> {
  const rows = await client.agentApproval.findMany({ where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId,
    taskId: input.applicationTaskId, turnId: input.fillTurnId, jobId: input.jobId, type: "submit_application",
    status: { in: ["approved", "consumed"] } }, take: 2,
    select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, type: true, status: true,
      toolCallId: true, payload: true, resourceHash: true, materialHash: true, answersHash: true, scopeHash: true,
      nonceHash: true, revision: true, expiresAt: true } })
  if (rows.length !== 1) return false
  const row = rows[0]! as ReceiptRow
  if (row.id !== input.approvalId || row.userId !== input.userId || row.sessionId !== input.sessionId
    || row.turnId !== input.fillTurnId || row.taskId !== input.applicationTaskId || row.jobId !== input.jobId
    || row.type !== "submit_application" || !["approved", "consumed"].includes(row.status)
    || row.toolCallId !== `application-submit:${input.applicationTaskId}` || !matchesSubmitPayload(row.payload, material)
    || row.resourceHash !== hashes.resourceHash || row.materialHash !== hashes.materialHash || row.answersHash !== hashes.answersHash
    || !row.scopeHash || !row.nonceHash || !Number.isSafeInteger(row.revision) || row.revision < 0
    || !validDate(row.expiresAt)) return false
  const nonceHash = await hashApprovalNonce(input.receiptNonce)
  if (nonceHash !== row.nonceHash) return false
  const scope: ApprovalScope = { userId: input.userId, sessionId: input.sessionId, turnId: input.fillTurnId, jobId: input.jobId,
    toolCallId: row.toolCallId, action: "submit_application", resourceHash: hashes.resourceHash,
    materialHash: hashes.materialHash, answersHash: hashes.answersHash, revision: row.revision,
    nonceHash, expiresAt: row.expiresAt.toISOString() }
  return await hashApprovalScope(scope) === row.scopeHash
}

export async function replayReceiptScopeMatches(approval: ReplayReceipt,
  input: Pick<ReviewedSubmitMaterialInput, "userId" | "receiptNonce">): Promise<boolean> {
  if (!approval.nonceHash || !approval.resourceHash || !approval.materialHash || !approval.answersHash || !approval.expiresAt
    || !approval.sessionId || !approval.turnId || !approval.toolCallId || !approval.jobId || !input.receiptNonce) return false
  const nonceHash = await hashApprovalNonce(input.receiptNonce)
  const scope: ApprovalScope = { userId: input.userId, sessionId: approval.sessionId, turnId: approval.turnId, jobId: approval.jobId,
    toolCallId: approval.toolCallId, action: "submit_application", resourceHash: approval.resourceHash,
    materialHash: approval.materialHash, answersHash: approval.answersHash, revision: approval.revision,
    nonceHash, expiresAt: approval.expiresAt.toISOString() }
  return nonceHash === approval.nonceHash && await hashApprovalScope(scope) === approval.scopeHash
}

export function bareResourceHash(value: string): string | null {
  const match = /^sha256:([a-f0-9]{64})$/.exec(value)
  return match?.[0] === value ? match[1]! : null
}

/** A V3 record prevents an Objective Fill from dropping its source selector into legacy mode. */
export async function hasObjectiveSubmissionManifestSignal(
  client: Pick<PrismaClient, "applicationTaskEvent">, applicationTaskId: string, fillTurnId: string,
): Promise<boolean> {
  const hash = hashArtifactContent([applicationTaskId, fillTurnId])
  if (!RESOURCE_HASH.test(hash)) throw new Error("Invalid Objective submission identity")
  const id = `objective-submission-manifest:${hash.slice(7)}`
  const rows = await client.applicationTaskEvent.findMany({ where: { taskId: applicationTaskId, OR: [
    { id }, { type: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
      data: { path: ["scope", "fillTurnId"], equals: fillTurnId } },
  ] }, take: 2, select: { id: true } })
  return rows.length > 0
}

async function decidedBeforeFill(client: Client, input: ReviewedSubmitMaterialInput, source: ObjectiveReviewedFillSource,
  fillCreatedAt: Date): Promise<boolean> {
  const rows = await client.agentApproval.findMany({ where: { id: source.approvalId, userId: input.userId,
    sessionId: input.sessionId, turnId: source.reviewTurnId, taskId: input.applicationTaskId,
    type: "review_application", status: "approved" }, take: 2, select: { id: true, decidedAt: true, expiresAt: true } })
  const row = rows[0]
  return rows.length === 1 && row?.id === source.approvalId && validDate(row.decidedAt)
    && row.decidedAt <= fillCreatedAt && validDate(row.expiresAt) && row.expiresAt > fillCreatedAt
}

async function readBrowserBinding(client: Client, input: ReviewedSubmitMaterialInput, task: ObjectiveSubmitTaskRow,
  turn: ObjectiveSubmitFillTurnRow) {
  const rows = await client.applicationTaskEvent.findMany({
    where: { taskId: task.id, type: START_EVENT, data: { path: ["fillTurnId"], equals: input.fillTurnId } }, take: 2,
    select: { id: true, taskId: true, type: true, actor: true, body: true, data: true, createdAt: true },
  })
  const row = rows[0]
  const binding = rows.length === 1 && row?.taskId === task.id && row.type === START_EVENT
    && row.actor === "worker" && row.body === START_BODY
    ? parseObjectiveReviewedApplicationFillBrowserStartEvent(row.data) : null
  const fillers = binding && await client.subAgentTask.findMany({
    where: { id: binding.fillerTaskId, sessionId: input.sessionId, turnId: input.fillTurnId, rootTaskId: turn.rootTaskId,
      session: { is: { userId: input.userId } }, role: "application_filler", taskType: "application_fill_for_review",
      status: "completed", completedAt: { not: null }, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null }, take: 2,
    select: { id: true, attemptCount: true, status: true, completedAt: true, rootTaskId: true, leaseOwner: true,
      leaseExpiresAt: true, interruptRequestedAt: true },
  })
  const filler = fillers?.[0]
  if (!binding || binding.userId !== input.userId || binding.sessionId !== input.sessionId || binding.fillTurnId !== input.fillTurnId
    || binding.applicationTaskId !== task.id || binding.jobId !== task.jobId || binding.proof.sourceTurnId === input.fillTurnId
    || !sameDateOrder(turn.createdAt, row?.createdAt) || fillers?.length !== 1 || !filler || filler.id !== binding.fillerTaskId
    || !(row?.createdAt instanceof Date) || new Date(binding.leaseExpiresAt).getTime() <= row.createdAt.getTime()
    || filler.status !== "completed" || filler.attemptCount !== binding.attemptCount || filler.rootTaskId !== turn.rootTaskId
    || !validDate(filler.completedAt) || !sameDateOrder(row?.createdAt, filler.completedAt)
    || filler.leaseOwner !== null || filler.leaseExpiresAt !== null || filler.interruptRequestedAt !== null) return null
  return binding
}

async function readManifest(client: Client, input: ReviewedSubmitMaterialInput, task: ObjectiveSubmitTaskRow, source: ObjectiveReviewedFillSource) {
  let id: string
  try {
    const hash = hashArtifactContent([task.id, input.fillTurnId])
    if (!RESOURCE_HASH.test(hash)) return null
    id = `objective-submission-manifest:${hash.slice(7)}`
  } catch { return null }
  const rows = await client.applicationTaskEvent.findMany({ where: { taskId: task.id, OR: [
    { id }, { type: OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE,
      data: { path: ["scope", "fillTurnId"], equals: input.fillTurnId } },
  ] }, take: 2, select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } })
  const row = rows[0]
  const packet = rows.length === 1 && row?.id === id && row.taskId === task.id
    && row.type === OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_TYPE
    && row.actor === OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_ACTOR
    && row.body === OBJECTIVE_APPLICATION_SUBMISSION_MANIFEST_EVENT_BODY
    ? parseObjectiveApplicationSubmissionManifestEvent(row.data) : null
  if (!packet || packet.scope.userId !== input.userId || packet.scope.sessionId !== input.sessionId
    || packet.scope.applicationTaskId !== task.id || packet.scope.jobId !== task.jobId || packet.scope.fillTurnId !== input.fillTurnId
    || !sameSource(packet.manifest.material.objectiveSource, source)) return null
  try { return hashArtifactContent(packet.manifest) === packet.hash ? { ...packet.manifest, hash: packet.hash } : null }
  catch { return null }
}

function sameTask(task: ObjectiveSubmitTaskRow, input: ReviewedSubmitMaterialInput): boolean {
  return task.id === input.applicationTaskId && task.userId === input.userId && task.sessionId === input.sessionId
    && task.jobId === input.jobId && task.fillTurnId === input.fillTurnId && task.fillTurnSessionId === input.sessionId
    && task.fillTurnUserId === input.userId && typeof task.resumeId === "string" && task.resumeId.length > 0
}
function matchesSubmitPayload(value: unknown, expected: LegacyApplicationSubmissionMaterial): boolean {
  const keys = ["applicationTaskId", "jobId", "resumeId", "coverLetterId"] as const
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
    const own = Reflect.ownKeys(value)
    if (own.length !== keys.length || !own.every(key => typeof key === "string" && keys.includes(key as typeof keys[number]))) return false
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      return Boolean(descriptor?.enumerable && "value" in descriptor) && (value as Record<string, unknown>)[key] === expected[key]
    })
  } catch { return false }
}
function sameSource(left: ObjectiveReviewedFillSource, right: ObjectiveReviewedFillSource): boolean {
  return left.schemaVersion === right.schemaVersion && left.approvalId === right.approvalId
    && left.reviewTurnId === right.reviewTurnId && left.materialProofHash === right.materialProofHash
}
function sameBrowserProof(binding: Readonly<{ jobId: string; sourceTurnId: string; rootTaskId: string; graphRevision: number;
  writerTaskId: string; reviewerTaskId: string; reviewerToolCallId: string; reviewHash: string; artifactId: string; version: number;
  contentHash: string; sourceDigest: string }>, proof: ObjectiveReviewedFillAuthority["input"]["member"]["proof"]["source"]): boolean {
  return binding.jobId === proof.jobId && binding.sourceTurnId === proof.sourceTurnId && binding.rootTaskId === proof.rootTaskId
    && binding.graphRevision === proof.graphRevision && binding.writerTaskId === proof.writerTaskId
    && binding.reviewerTaskId === proof.reviewerTaskId && binding.reviewerToolCallId === proof.reviewerToolCallId
    && binding.reviewHash === proof.reviewHash && binding.artifactId === proof.artifactId && binding.version === proof.version
    && binding.contentHash === proof.contentHash && binding.sourceDigest === proof.sourceDigest
}
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function sameDateOrder(before: unknown, after: unknown): boolean { return validDate(before) && validDate(after) && before <= after }
