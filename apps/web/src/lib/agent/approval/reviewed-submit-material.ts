import { Prisma, type PrismaClient } from "@prisma/client"
import { hashApprovalNonce, hashApprovalScope, type ApprovalScope } from "@jobcopilot/agent-protocol"
import {
  bindReviewedApplicationSubmissionMaterial, buildApplicationSubmissionManifest, hashAgentReceiptValue,
  hashApplicationSubmissionMaterial, isApplicationSubmissionManifest,
  parseReviewedApplicationFillBrowserStartEvent, parseReviewedApplicationFillSource,
  type LegacyApplicationSubmissionMaterial,
} from "@jobcopilot/shared"
import { hashArtifactContent } from "../artifacts/hash"
import { acquireSourceMaterialFence } from "../source-material-fence"

const START_EVENT = "reviewed_application_fill_browser_started"
const REVIEWED_MANIFEST_SCHEMA = "agent-harness.application-submission.v2"
const TASK_REF_PREFIX = "application-task:"

type Client = Pick<PrismaClient, "agentApproval" | "agentArtifact" | "agentTurn" | "applicationTask" | "applicationTaskEvent" | "subAgentTask">
export type ReviewedSubmitMaterialInput = Readonly<{ userId: string; sessionId: string; applicationTaskId: string; jobId: string; fillTurnId: string; approvalId: string; receiptNonce: string }>
type Input = ReviewedSubmitMaterialInput
type ReceiptRow = { id: string; userId: string; sessionId: string; turnId: string; jobId: string; taskId: string | null; type: string; status: string
  toolCallId: string | null; payload: unknown; resourceHash: string | null; materialHash: string | null; answersHash: string | null; scopeHash: string | null
  nonceHash: string | null; revision: number; expiresAt: Date | null }
type ArtifactRow = { id: string; userId: string; jobId: string; artifactType: string; lifecycle: string; baseId: string | null; baseHash: string | null
  content: unknown; hash: string; constraintHash: string; provenanceRefs: unknown; evidenceRefs: unknown; previousHash: string | null; version: number }
type ReplayReceipt = Readonly<{ nonceHash: string | null; resourceHash: string | null; materialHash: string | null; answersHash: string | null
  expiresAt: Date | null; sessionId: string | null; turnId: string | null; toolCallId: string | null; jobId: string | null; revision: number; scopeHash: string | null }>
type MaterialResult =
  | Readonly<{ mode: "legacy" }>
  | Readonly<{ mode: "reviewed"; ready: true; resourceHash: string; materialHash: string; answersHash: string }>
  | Readonly<{ mode: "unavailable" }>

const UNAVAILABLE: MaterialResult = Object.freeze({ mode: "unavailable" })

/** Acquire the shared source fence and the submit scope in the established row-lock order. */
export async function lockReviewedSubmitSourceScope(tx: Prisma.TransactionClient, input: Input): Promise<boolean> {
  await acquireSourceMaterialFence(tx, [input.userId])
  const session = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_sessions" WHERE "id" = ${input.sessionId} AND "userId" = ${input.userId} FOR UPDATE
  `)
  if (!exactlyLocked(session, input.sessionId)) return false
  const turn = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_turns" WHERE "id" = ${input.fillTurnId} AND "sessionId" = ${input.sessionId}
      AND "userId" = ${input.userId} FOR UPDATE
  `)
  if (!exactlyLocked(turn, input.fillTurnId)) return false
  const task = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "application_tasks" WHERE "id" = ${input.applicationTaskId} AND "userId" = ${input.userId}
      AND "sessionId" = ${input.sessionId} AND "fillTurnId" = ${input.fillTurnId} AND "jobId" = ${input.jobId} FOR UPDATE
  `)
  if (!exactlyLocked(task, input.applicationTaskId)) return false
  const job = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Job" WHERE "id" = ${input.jobId} AND "userId" = ${input.userId} FOR UPDATE
  `)
  if (!exactlyLocked(job, input.jobId)) return false
  const approval = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "agent_approvals" WHERE "id" = ${input.approvalId} AND "userId" = ${input.userId}
      AND "sessionId" = ${input.sessionId} AND "taskId" = ${input.applicationTaskId} AND "turnId" = ${input.fillTurnId}
      AND "jobId" = ${input.jobId} AND "type" = 'submit_application' FOR UPDATE
  `)
  return exactlyLocked(approval, input.approvalId)
}

export function sameReviewedSubmitMaterialSnapshot(left: MaterialResult, right: MaterialResult): boolean {
  if (left.mode === "unavailable" || right.mode !== left.mode) return false
  return left.mode === "legacy" || (right.mode === "reviewed" && left.resourceHash === right.resourceHash
    && left.materialHash === right.materialHash && left.answersHash === right.answersHash)
}

export async function lockAndRereadReviewedSubmitMaterial(tx: Prisma.TransactionClient, input: Input, expected: MaterialResult): Promise<boolean> {
  return await lockReviewedSubmitSourceScope(tx, input)
    && sameReviewedSubmitMaterialSnapshot(expected, await resolveReviewedSubmitMaterial(tx, input))
}

export function submitMaterialHashesMatch(proof: MaterialResult, approval: Pick<ReceiptRow, "resourceHash" | "materialHash" | "answersHash">,
  legacyMaterialHash: string, legacyAnswersHash: string): boolean {
  if (proof.mode === "unavailable") return false
  return proof.mode === "legacy" ? approval.materialHash === legacyMaterialHash && approval.answersHash === legacyAnswersHash
    : approval.resourceHash === proof.resourceHash && approval.materialHash === proof.materialHash && approval.answersHash === proof.answersHash
}

export async function replayReceiptScopeMatches(approval: ReplayReceipt,
input: Pick<Input, "userId" | "receiptNonce">): Promise<boolean> {
  if (!approval.nonceHash || !approval.resourceHash || !approval.materialHash || !approval.answersHash || !approval.expiresAt
    || !approval.sessionId || !approval.turnId || !approval.toolCallId || !approval.jobId || !input.receiptNonce) return false
  const nonceHash = await hashApprovalNonce(input.receiptNonce)
  const scope: ApprovalScope = { userId: input.userId, sessionId: approval.sessionId, turnId: approval.turnId, jobId: approval.jobId,
    toolCallId: approval.toolCallId, action: "submit_application", resourceHash: approval.resourceHash,
    materialHash: approval.materialHash, answersHash: approval.answersHash, revision: approval.revision,
    nonceHash, expiresAt: approval.expiresAt.toISOString() }
  return nonceHash === approval.nonceHash && await hashApprovalScope(scope) === approval.scopeHash
}

function exactlyLocked(rows: readonly { id: string }[], expectedId: string): boolean {
  return rows.length === 1 && rows[0]?.id === expectedId
}

/**
 * Read-only preflight; every result is advisory. Call again on the existing transaction client after
 * taking the #1159 source fence, then Session, Turn, ApplicationTask and Job locks, in that order.
 */
export async function resolveReviewedSubmitMaterial(client: Client, input: Input): Promise<MaterialResult> {
  try {
    if (![input.userId, input.sessionId, input.applicationTaskId, input.jobId, input.fillTurnId, input.approvalId, input.receiptNonce]
      .every(value => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256)) return UNAVAILABLE
    const taskRows = await client.applicationTask.findMany({
      where: { id: input.applicationTaskId, userId: input.userId, sessionId: input.sessionId, jobId: input.jobId, fillTurnId: input.fillTurnId },
      take: 2, select: { id: true, userId: true, sessionId: true, jobId: true, fillTurnId: true, fillTurnSessionId: true,
        fillTurnUserId: true, resumeId: true, coverLetterId: true, confirmedAnswers: true },
    })
    if (taskRows.length !== 1) return UNAVAILABLE
    const task = taskRows[0]!
    const turns = await client.agentTurn.findMany({
      where: { id: input.fillTurnId, userId: input.userId, sessionId: input.sessionId, source: "user" },
      take: 2, select: { id: true, userId: true, sessionId: true, source: true, rootTaskId: true, input: true },
    })
    if (turns.length !== 1) return UNAVAILABLE
    const turn = turns[0]!
    if (turn.id !== input.fillTurnId || turn.userId !== input.userId || turn.sessionId !== input.sessionId || turn.source !== "user") return UNAVAILABLE
    const selection = parseReviewedApplicationFillSource(turn.input)
    if (selection.kind === "invalid") return UNAVAILABLE
    if (selection.kind === "absent") {
      const starts = await client.applicationTaskEvent.findMany({
        where: { taskId: input.applicationTaskId, type: START_EVENT, data: { path: ["fillTurnId"], equals: input.fillTurnId } },
        take: 1, select: { id: true },
      })
      if (starts.length !== 0) return UNAVAILABLE
      const artifacts = await client.agentArtifact.findMany({
        where: { id: `application:${task.id}`, userId: input.userId, jobId: input.jobId },
        take: 2, select: { content: true },
      })
      if (artifacts.length > 1 || artifacts.some(row => hasReviewedManifestVersion(row.content))) return UNAVAILABLE
      return { mode: "legacy" }
    }
    if (selection.kind !== "selected") return UNAVAILABLE
    const fillRootTaskId = turn.rootTaskId
    if (typeof fillRootTaskId !== "string" || !fillRootTaskId || fillRootTaskId.trim() !== fillRootTaskId) return UNAVAILABLE
    const material: LegacyApplicationSubmissionMaterial = {
      applicationTaskId: task.id, jobId: task.jobId, resumeId: task.resumeId, coverLetterId: task.coverLetterId,
    }
    const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
    const events = await client.applicationTaskEvent.findMany({
      where: { taskId: task.id, type: START_EVENT, data: { path: ["fillTurnId"], equals: input.fillTurnId } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: 2,
      select: { id: true, taskId: true, type: true, actor: true, data: true },
    })
    const reviewed = await reviewedMaterialFromEvent(client, input, task, events, selection.sourceTurnId, fillRootTaskId, material)
    if (!reviewed) return UNAVAILABLE
    const expectedMaterial = reviewed
    const expectedManifest = buildApplicationSubmissionManifest(expectedMaterial, answersHash)
    if (!expectedManifest || !isApplicationSubmissionManifest(expectedManifest)) return UNAVAILABLE
    if (expectedManifest.schemaVersion !== REVIEWED_MANIFEST_SCHEMA) return UNAVAILABLE
    const artifactRows = await client.agentArtifact.findMany({
      where: { id: `application:${task.id}`, userId: input.userId, jobId: input.jobId }, take: 2,
      select: { id: true, userId: true, jobId: true, artifactType: true, lifecycle: true, baseId: true, baseHash: true,
        content: true, hash: true, constraintHash: true, provenanceRefs: true, evidenceRefs: true, previousHash: true, version: true },
    })
    if (artifactRows.length !== 1 || !artifactMatches(artifactRows[0]!, input, expectedManifest)) return UNAVAILABLE
    const resourceHash = bareResourceHash(artifactRows[0]!.hash)
    if (!resourceHash) return UNAVAILABLE
    const materialHash = await hashApplicationSubmissionMaterial(reviewed)
    if (!materialHash || !await signedReceiptMatches(client, input, material, resourceHash, materialHash, answersHash)) return UNAVAILABLE
    return { mode: "reviewed", ready: true, resourceHash, materialHash, answersHash }
  } catch {
    return UNAVAILABLE
  }
}

async function reviewedMaterialFromEvent(client: Client, input: Input, task: {
  id: string; userId: string; sessionId: string | null; jobId: string; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null
}, rows: readonly { id: string; taskId: string; type: string; actor: string; data: unknown }[], sourceTurnId: string,
fillRootTaskId: string, material: LegacyApplicationSubmissionMaterial) {
  if (task.id !== input.applicationTaskId || task.userId !== input.userId || task.sessionId !== input.sessionId
    || task.jobId !== input.jobId || task.fillTurnId !== input.fillTurnId || task.fillTurnSessionId !== input.sessionId
    || task.fillTurnUserId !== input.userId || rows.length !== 1) return null
  const row = rows[0]!
  const binding = row.actor === "worker" && row.type === START_EVENT && row.taskId === task.id
    ? parseReviewedApplicationFillBrowserStartEvent(row.data) : null
  if (!binding || binding.userId !== input.userId || binding.sessionId !== input.sessionId || binding.fillTurnId !== input.fillTurnId
    || binding.applicationTaskId !== task.id || binding.jobId !== input.jobId || binding.proof.sourceTurnId !== sourceTurnId) return null
  if (binding.proof.rootTaskId === fillRootTaskId) return null
  const tasks = await client.subAgentTask.findMany({
    where: { sessionId: input.sessionId, turnId: input.fillTurnId, session: { is: { userId: input.userId } },
      role: "application_filler", taskType: "application_fill_for_review", status: "completed",
      rootTaskId: fillRootTaskId, completedAt: { not: null }, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null },
    take: 2, select: { id: true, attemptCount: true, status: true, completedAt: true, leaseOwner: true,
      leaseExpiresAt: true, interruptRequestedAt: true, rootTaskId: true },
  })
  if (tasks.length !== 1 || tasks[0]!.id !== binding.fillerTaskId || tasks[0]!.attemptCount !== binding.attemptCount
    || tasks[0]!.status !== "completed" || !tasks[0]!.completedAt || tasks[0]!.leaseOwner !== null
    || tasks[0]!.leaseExpiresAt !== null || tasks[0]!.interruptRequestedAt !== null || tasks[0]!.rootTaskId !== fillRootTaskId) return null
  return bindReviewedApplicationSubmissionMaterial(material, binding.proof)
}

function artifactMatches(row: ArtifactRow, input: Input, manifest: unknown): boolean {
  const id = `application:${input.applicationTaskId}`, ref = `${TASK_REF_PREFIX}${input.applicationTaskId}`
  try {
    return row.id === id && row.userId === input.userId && row.jobId === input.jobId && row.artifactType === "application"
      && row.lifecycle === "base" && row.baseId === id && row.baseHash === row.hash && row.version === 1 && row.previousHash === null
      && row.constraintHash === hashArtifactContent({ applicationTaskId: input.applicationTaskId, jobId: input.jobId })
      && exactSingleRef(row.provenanceRefs, ref) && exactSingleRef(row.evidenceRefs, ref)
      && isApplicationSubmissionManifest(row.content) && hashArtifactContent(row.content) === row.hash
      && hashArtifactContent(row.content) === hashArtifactContent(manifest)
  } catch { return false }
}

async function signedReceiptMatches(client: Client, input: Input, material: LegacyApplicationSubmissionMaterial,
  resourceHash: string, materialHash: string, answersHash: string): Promise<boolean> {
  const rows = await client.agentApproval.findMany({
    where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId, taskId: input.applicationTaskId,
      turnId: input.fillTurnId, jobId: input.jobId, type: "submit_application", status: { in: ["approved", "consumed"] } }, take: 2,
    select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, type: true, status: true,
      toolCallId: true, payload: true, resourceHash: true, materialHash: true, answersHash: true, scopeHash: true,
      nonceHash: true, revision: true, expiresAt: true },
  })
  if (rows.length !== 1) return false
  const approval = rows[0]! as ReceiptRow
  if (approval.id !== input.approvalId || approval.userId !== input.userId || approval.sessionId !== input.sessionId
    || approval.turnId !== input.fillTurnId || approval.taskId !== input.applicationTaskId || approval.jobId !== input.jobId
    || approval.type !== "submit_application" || !["approved", "consumed"].includes(approval.status)
    || approval.toolCallId !== `application-submit:${input.applicationTaskId}` || !matchesLegacyPayload(approval.payload, material)
    || approval.resourceHash !== resourceHash
    || approval.materialHash !== materialHash || approval.answersHash !== answersHash || !approval.scopeHash || !approval.nonceHash
    || !Number.isSafeInteger(approval.revision) || approval.revision < 0 || !(approval.expiresAt instanceof Date)
    || !Number.isFinite(approval.expiresAt.getTime())) return false
  const nonceHash = await hashApprovalNonce(input.receiptNonce)
  if (nonceHash !== approval.nonceHash) return false
  const scope: ApprovalScope = { userId: input.userId, sessionId: input.sessionId, turnId: input.fillTurnId, jobId: input.jobId,
    toolCallId: approval.toolCallId, action: "submit_application", resourceHash, materialHash, answersHash,
    revision: approval.revision, nonceHash, expiresAt: approval.expiresAt.toISOString() }
  return await hashApprovalScope(scope) === approval.scopeHash
}

function exactSingleRef(value: unknown, expected: string): boolean {
  return Array.isArray(value) && value.length === 1 && value[0] === expected
}
function hasReviewedManifestVersion(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return true
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return true
    const descriptor = Object.getOwnPropertyDescriptor(value, "schemaVersion")
    const commitment = Object.getOwnPropertyDescriptor(value, "reviewedCoverLetterHash")
    return Boolean(commitment || descriptor && (!descriptor.enumerable || !("value" in descriptor) || descriptor.value === REVIEWED_MANIFEST_SCHEMA))
  } catch { return true }
}
function matchesLegacyPayload(value: unknown, expected: LegacyApplicationSubmissionMaterial): boolean {
  const keys = ["applicationTaskId", "jobId", "resumeId", "coverLetterId"] as const
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false
    const own = Reflect.ownKeys(value)
    if (own.length !== keys.length || !own.every(key => typeof key === "string" && keys.includes(key as typeof keys[number]))) return false
    const row = value as Record<string, unknown>
    return keys.every(key => {
      const descriptor = Object.getOwnPropertyDescriptor(row, key)
      return Boolean(descriptor?.enumerable && "value" in descriptor) && row[key] === expected[key]
    })
  } catch { return false }
}
function bareResourceHash(value: string): string | null {
  const match = /^sha256:([a-f0-9]{64})$/.exec(value)
  return match?.[0] === value ? match[1]! : null
}
