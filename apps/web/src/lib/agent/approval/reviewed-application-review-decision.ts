import { createHash } from "node:crypto"
import { Prisma } from "@prisma/client"
import {
  hashApprovalNonce, hashApprovalScope, type ApprovalScope,
} from "@jobcopilot/agent-protocol"
import {
  hashReviewedApplicationMaterialProof, readAgentSelectedJobMaterial,
  type AgentSelectedJobMaterialQueryClient, type AgentSelectedJobQueryParameter, type ReviewedApplicationMaterialProof,
} from "@jobcopilot/shared"
import { hashArtifactContent } from "../artifacts/hash"
import { waitItemId } from "../broker/item-ids"

const ISSUE = "reviewed_application_review_issued", SCHEMA = "agent-harness.v2.reviewed-application-review-binding.v1"
const REVIEW_INTENT = "reviewed_application_review", OBJECTIVE_INTENT = "objective_task_graph_execution"
const UNAVAILABLE = Object.freeze({ status: "unavailable" as const }), LEGACY = Object.freeze({ status: "legacy" as const })
type Result = typeof UNAVAILABLE | typeof LEGACY | Readonly<{ status: "reviewed_approved"; sourceTurnId: string }> | Readonly<{ status: "reviewed_rejected" }>
type Input = Readonly<{ userId: string; sessionId: string; approvalId: string; decision: "approved" | "rejected"; now: Date; receiptNonce?: unknown; requestedSourceTurnId?: unknown }>
type Row = Record<string, unknown>
type Issued = { approvalId: string; reviewTurnId: string; applicationTaskId: string; userId: string; sessionId: string; jobId: string; proof: ReviewedApplicationMaterialProof; receiptScope: Row }

/** Caller must acquire the #1159 source fence before owner locks; this read-only helper never acquires locks or mutates. */
export async function readReviewedApplicationReviewDecision(tx: Prisma.TransactionClient, input: Input): Promise<Result> {
  try {
    if (![input.userId, input.sessionId, input.approvalId].every(text) || !(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) return UNAVAILABLE
    const approval = await tx.agentApproval.findFirst({ where: { id: input.approvalId, userId: input.userId, sessionId: input.sessionId },
      select: { id: true, userId: true, sessionId: true, turnId: true, taskId: true, jobId: true, toolCallId: true, type: true,
        status: true, title: true, body: true, impact: true, payload: true, resourceHash: true, materialHash: true, answersHash: true,
        scopeHash: true, nonceHash: true, revision: true, expiresAt: true, decidedAt: true, consumedAt: true } })
    if (!approval) return UNAVAILABLE
    const turnId = text(approval.turnId) ? approval.turnId : null
    const [turns, issuedRows] = turnId ? await Promise.all([
      tx.agentTurn.findMany({ where: { id: turnId, userId: input.userId, sessionId: input.sessionId }, take: 2,
        select: { id: true, userId: true, sessionId: true, source: true, executionMode: true, status: true, revision: true, input: true } }),
      tx.applicationTaskEvent.findMany({ where: { taskId: approval.taskId ?? "", type: ISSUE,
        data: { path: ["reviewTurnId"], equals: turnId } }, take: 2,
        select: { id: true, taskId: true, type: true, actor: true, body: true, data: true } }),
    ]) : [[], []]
    const intent = reviewIntent(turns.length === 1 ? turns[0]!.input : null)
    const stable = approval.id.startsWith("reviewed-application-review:") || approval.toolCallId?.startsWith("review_application:") === true
    if (!stable && issuedRows.length === 0 && intent.kind === "absent") return LEGACY
    if (intent.kind !== "reviewed" || turns.length !== 1 || issuedRows.length !== 1) return UNAVAILABLE
    const turn = turns[0]!, event = issuedRows[0]!, binding = parseIssued(event.data)
    if (!binding || event.taskId !== approval.taskId || event.type !== ISSUE || event.actor !== "worker"
      || event.body !== "Reviewed application approval binding recorded."
      || turn.id !== turnId || turn.userId !== input.userId || turn.sessionId !== input.sessionId || turn.source !== "user"
      || turn.executionMode !== "canonical_task_graph" || turn.status !== "waiting_for_approval" || turn.revision !== approval.revision + 1
      || intent.jobId !== binding.jobId || intent.sourceTurnId !== binding.proof.sourceTurnId
      || binding.approvalId !== approval.id || binding.reviewTurnId !== turnId || binding.userId !== input.userId
      || binding.sessionId !== input.sessionId || !await approvalMatches(approval, input, binding, turnId)
      || !await currentWait(tx, input, approval, binding)) return UNAVAILABLE
    const task = await currentApplicationTask(tx, input, approval, binding)
    const resumeId = task && text(task.resumeId) ? task.resumeId : null
    if (!task || !resumeId) return UNAVAILABLE
    const base = await tx.resume.findMany({ where: { id: resumeId, userId: input.userId, kind: "base" }, take: 2, select: { id: true } })
    if (base.length !== 1 || base[0]!.id !== resumeId) return UNAVAILABLE
    const hashes = [await hashReviewedApplicationMaterialProof(binding.proof),
      bareHash(hashArtifactContent({ kind: "review_application", userId: input.userId, sessionId: input.sessionId,
        jobId: task.jobId, applicationTaskId: task.id })),
      bareHash(hashArtifactContent({ kind: "review_application", formAnswers: null }))]
    if (hashes[0] !== binding.receiptScope.materialHash || hashes[1] !== binding.receiptScope.resourceHash
      || hashes[2] !== binding.receiptScope.answersHash) return UNAVAILABLE
    if (input.decision === "rejected") return { status: "reviewed_rejected" }
    if (typeof input.receiptNonce !== "string" || !input.receiptNonce.trim() || input.receiptNonce.length > 256
      || await hashApprovalNonce(input.receiptNonce) !== approval.nonceHash
      || input.requestedSourceTurnId !== undefined && input.requestedSourceTurnId !== binding.proof.sourceTurnId) return UNAVAILABLE
    if (!await currentReviewedArtifact(tx, input, binding.proof)) return UNAVAILABLE
    const source = await readAgentSelectedJobMaterial(prismaMaterialClient(tx), { userId: input.userId, jobId: binding.jobId })
    if (source.preparation.sourceDigest !== binding.proof.sourceDigest || source.baseResume.id !== resumeId) return UNAVAILABLE
    return { status: "reviewed_approved", sourceTurnId: binding.proof.sourceTurnId }
  } catch { return UNAVAILABLE }
}

function reviewIntent(value: unknown): { kind: "absent" | "invalid" } | { kind: "reviewed"; sourceTurnId: string; jobId: string } {
  const input = record(value), intent = record(input?.intent)
  if (!intent || intent.kind !== REVIEW_INTENT) return { kind: "absent" }
  if (Object.hasOwn(input!, "selectedJobPreparation") || !exactKeys(intent, ["jobId", "kind", "sourceTurnId", "version"])
    || intent.version !== 1 || !text(intent.sourceTurnId) || !text(intent.jobId)) return { kind: "invalid" }
  return { kind: "reviewed", sourceTurnId: intent.sourceTurnId, jobId: intent.jobId }
}

function parseIssued(value: unknown): Issued | null {
  const row = exactRecord(value, ["schemaVersion", "approvalId", "reviewTurnId", "applicationTaskId", "userId", "sessionId", "jobId", "proof", "receiptScope"])
  if (!row || row.schemaVersion !== SCHEMA || ![row.approvalId, row.reviewTurnId, row.applicationTaskId, row.userId, row.sessionId, row.jobId].every(text)
    || !isReviewedProof(row.proof) || row.proof.jobId !== row.jobId) return null
  const scope = exactRecord(row.receiptScope, ["action", "toolCallId", "resourceHash", "materialHash", "answersHash", "revision", "expiresAt"])
  if (!scope || scope.action !== "review_application" || !text(scope.toolCallId)
    || ![scope.resourceHash, scope.materialHash, scope.answersHash].every(digest)
    || !Number.isSafeInteger(scope.revision) || typeof scope.expiresAt !== "string") return null
  const issued = row as unknown as Issued
  return { ...issued, proof: row.proof, receiptScope: scope }
}

async function approvalMatches(row: Row, input: Input, binding: Issued, turnId: string): Promise<boolean> {
  const scope = binding.receiptScope, expiresAt = row.expiresAt
  if (row.id !== `reviewed-application-review:${turnId}` || row.id !== input.approvalId || row.userId !== input.userId
    || row.sessionId !== input.sessionId || row.turnId !== turnId || row.taskId !== binding.applicationTaskId || row.jobId !== binding.jobId
    || row.toolCallId !== `review_application:${turnId}` || row.type !== "review_application" || row.status !== "pending"
    || row.decidedAt !== null || row.consumedAt !== null || !exactPayload(row.payload, row.taskId, row.jobId)
    || !digest(row.resourceHash) || row.resourceHash !== scope.resourceHash || row.materialHash !== scope.materialHash
    || row.answersHash !== scope.answersHash || !approvalHash(row.nonceHash) || !approvalHash(row.scopeHash)
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || !(expiresAt instanceof Date)
    || !Number.isFinite(expiresAt.getTime()) || expiresAt <= input.now || scope.toolCallId !== row.toolCallId
    || scope.revision !== row.revision || scope.expiresAt !== expiresAt.toISOString()) return false
  const approvalScope: ApprovalScope = { userId: input.userId, sessionId: input.sessionId, turnId,
    jobId: binding.jobId, toolCallId: row.toolCallId as string, action: "review_application",
    resourceHash: row.resourceHash as string, materialHash: row.materialHash as string, answersHash: row.answersHash as string,
    revision: Number(row.revision), nonceHash: row.nonceHash as string, expiresAt: expiresAt.toISOString() }
  return await hashApprovalScope(approvalScope) === row.scopeHash
}

async function currentWait(tx: Prisma.TransactionClient, input: Input, approval: Row, binding: Issued): Promise<boolean> {
  const [items, events] = await Promise.all([
    tx.agentItem.findMany({ where: { id: waitItemId("approval", input.approvalId), sessionId: input.sessionId,
      turnId: binding.reviewTurnId, type: "approval_request", status: "started" }, take: 2,
      select: { id: true, sessionId: true, turnId: true, stepId: true, taskId: true, type: true, status: true,
        phase: true, revision: true, content: true, startedAt: true, completedAt: true } }),
    tx.agentEvent.findMany({ where: { sessionId: input.sessionId, turnId: binding.reviewTurnId,
      type: "approval.requested", correlationId: input.approvalId }, take: 2,
      select: { id: true, sessionId: true, turnId: true, itemId: true, taskId: true, type: true, actor: true,
        correlationId: true, idempotencyKey: true, payload: true } }),
  ])
  if (items.length !== 1 || events.length !== 1) return false
  const item = items[0]!, event = events[0]!, content = exactRecord(item.content,
    ["waitKind", "approvalId", "toolCallId", "action", "title", "body", "impact", "scopeHash", "receiptRevision", "expiresAt", "decision"])
  const payload = exactRecord(event.payload, ["approvalId", "action", "scopeHash", "revision"]), expiry = approval.expiresAt
  return Boolean(content && payload && expiry instanceof Date && item.sessionId === input.sessionId && item.turnId === binding.reviewTurnId
    && item.stepId === null && item.taskId === null && item.type === "approval_request" && item.status === "started"
    && item.phase === "commentary" && item.revision === 0 && item.startedAt instanceof Date && item.completedAt === null
    && content.waitKind === "approval" && content.approvalId === approval.id && content.toolCallId === approval.toolCallId
    && content.action === "review_application" && content.title === approval.title && content.body === approval.body
    && sameJson(content.impact, { externalSubmission: false, jobId: binding.jobId })
    && content.scopeHash === approval.scopeHash && content.receiptRevision === approval.revision
    && content.expiresAt === expiry.toISOString() && content.decision === null
    && event.sessionId === input.sessionId && event.turnId === binding.reviewTurnId && event.itemId === null
    && event.taskId === binding.applicationTaskId && event.type === "approval.requested" && event.actor === "orchestrator"
    && event.correlationId === approval.id && event.idempotencyKey === `approval:${approval.id}:requested`
    && payload.approvalId === approval.id && payload.action === "review_application"
    && approvalHash(payload.scopeHash) && payload.revision === approval.revision)
}

async function currentApplicationTask(tx: Prisma.TransactionClient, input: Input, approval: Row, binding: Issued): Promise<Row | null> {
  const rows = await tx.applicationTask.findMany({ where: { id: binding.applicationTaskId, userId: input.userId,
    sessionId: input.sessionId, jobId: binding.jobId }, take: 2,
    select: { id: true, userId: true, sessionId: true, jobId: true, resumeId: true, coverLetterId: true, confirmedAnswers: true,
      status: true, checkpoint: true, workerTaskId: true, startedAt: true, completedAt: true,
      fillTurnId: true, fillTurnSessionId: true, fillTurnUserId: true } })
  const task = rows.length === 1 ? rows[0] : null
  return task && task.id === approval.taskId && task.status === "waiting_for_user" && task.checkpoint === "materials_ready"
    && task.workerTaskId === null && task.startedAt === null && task.completedAt === null
    && task.fillTurnId === null && task.fillTurnSessionId === null && task.fillTurnUserId === null
    && text(task.resumeId) ? task : null
}

async function currentReviewedArtifact(tx: Prisma.TransactionClient, input: Input, proof: ReviewedApplicationMaterialProof): Promise<boolean> {
  const sources = await tx.agentTurn.findMany({ where: { id: proof.sourceTurnId, userId: input.userId, sessionId: input.sessionId,
    source: "user", executionMode: "canonical_task_graph", status: "completed" }, take: 2,
    select: { id: true, rootTaskId: true, input: true } })
  if (sources.length !== 1 || sources[0]!.rootTaskId !== proof.rootTaskId || !selectedSource(sources[0]!.input, proof.jobId)) return false
  const roots = await tx.subAgentTask.findMany({ where: { id: proof.rootTaskId, sessionId: input.sessionId,
    turnId: proof.sourceTurnId, rootTaskId: proof.rootTaskId, parentTaskId: null, role: "orchestrator", taskType: "root", depth: 0, status: "completed" },
    take: 2, select: { id: true } })
  if (roots.length !== 1) return false
  const graphId = `task-graph-${createHash("sha256").update(proof.rootTaskId).digest("hex")}`
  const graphs = await tx.agentItem.findMany({ where: { id: graphId, sessionId: input.sessionId, turnId: proof.sourceTurnId,
    taskId: proof.rootTaskId, type: "task_graph" }, take: 2, select: { id: true, revision: true } })
  if (graphs.length !== 1 || graphs[0]!.revision !== proof.graphRevision) return false
  return artifactLineageCurrent(tx, input, proof)
}

async function artifactLineageCurrent(tx: Prisma.TransactionClient, input: Input, proof: ReviewedApplicationMaterialProof): Promise<boolean> {
  const heads = await tx.agentArtifact.findMany({ where: { id: proof.artifactId, userId: input.userId, jobId: proof.jobId,
    artifactType: "cover_letter", lifecycle: "draft" }, take: 2,
    select: { id: true, userId: true, jobId: true, artifactType: true, lifecycle: true, content: true, hash: true, version: true } })
  if (heads.length !== 1) return false
  const head = heads[0]!, pointer = record(head.content)
  if (head.id !== proof.artifactId || head.userId !== input.userId || head.jobId !== proof.jobId || head.artifactType !== "cover_letter"
    || head.lifecycle !== "draft" || head.version !== proof.version || head.hash !== proof.contentHash
    || !pointer || !exactKeys(pointer, ["kind", "artifactId", "version", "contentHash"]) || pointer.kind !== "agent_artifact_version"
    || pointer.artifactId !== proof.artifactId || pointer.version !== proof.version || pointer.contentHash !== proof.contentHash) return false
  const versions = await tx.agentArtifactVersion.findMany({ where: { artifactId: proof.artifactId, version: proof.version,
    userId: input.userId, sessionId: input.sessionId, jobId: proof.jobId, artifactType: "cover_letter" }, take: 2,
    select: { id: true, artifactId: true, version: true, userId: true, sessionId: true, jobId: true, artifactType: true,
      content: true, contentHash: true, sourceDigest: true, taskId: true } })
  if (versions.length !== 1) return false
  const version = versions[0]!
  if (version.artifactId !== proof.artifactId || version.version !== proof.version || version.userId !== input.userId
    || version.sessionId !== input.sessionId || version.jobId !== proof.jobId || version.artifactType !== "cover_letter"
    || version.taskId !== proof.writerTaskId || version.contentHash !== proof.contentHash || version.sourceDigest !== proof.sourceDigest
    || typeof version.content !== "string" || hashArtifactContent(version.content) !== proof.contentHash) return false
  const reviews = await tx.agentArtifactReview.findMany({ where: { artifactVersionId: version.id, userId: input.userId,
    sessionId: input.sessionId, jobId: proof.jobId, artifactId: proof.artifactId, version: proof.version,
    contentHash: proof.contentHash, sourceDigest: proof.sourceDigest, currentSourceDigest: proof.sourceDigest,
    status: "passed", taskId: proof.reviewerTaskId, toolCallId: proof.reviewerToolCallId, reviewHash: proof.reviewHash }, take: 2,
    select: { id: true, artifactVersionId: true, userId: true, sessionId: true, jobId: true, artifactId: true, version: true,
      contentHash: true, sourceDigest: true, currentSourceDigest: true, status: true, taskId: true, toolCallId: true, reviewHash: true } })
  return reviews.length === 1 && reviews[0]!.artifactVersionId === version.id && reviews[0]!.status === "passed"
}

function selectedSource(value: unknown, jobId: string): boolean {
  const input = record(value), intent = record(input?.intent), selected = record(input?.selectedJobPreparation)
  if (!input || !selected || !exactKeys(selected, ["jobId"]) || selected.jobId !== jobId) return false
  if (Object.hasOwn(input, "intent")) return Boolean(intent && exactKeys(intent, ["kind", "version"])
    && intent.kind === OBJECTIVE_INTENT && intent.version === 1)
  return exactKeys(input, ["clientMessageId", "content", "goal", "selectedJobPreparation"])
    && text(input.clientMessageId) && typeof input.goal === "string" && Array.isArray(input.content)
}

function prismaMaterialClient(tx: Prisma.TransactionClient): AgentSelectedJobMaterialQueryClient {
  return { query: async <T>(sql: string, values: readonly AgentSelectedJobQueryParameter[]) => ({
    rows: await tx.$queryRawUnsafe<T[]>(sql, ...values),
  }) }
}

function exactPayload(value: unknown, taskId: unknown, jobId: unknown): boolean {
  const row = exactRecord(value, ["applicationTaskId", "jobId"])
  return Boolean(row && row.applicationTaskId === taskId && row.jobId === jobId)
}
function isReviewedProof(value: unknown): value is ReviewedApplicationMaterialProof {
  const proof = record(value), keys = ["artifactId", "contentHash", "graphRevision", "jobId", "reviewHash", "reviewerTaskId",
    "reviewerToolCallId", "rootTaskId", "sourceDigest", "sourceTurnId", "version", "writerTaskId"]
  return Boolean(proof && exactKeys(proof, keys) && [proof.jobId, proof.sourceTurnId, proof.rootTaskId, proof.writerTaskId,
    proof.reviewerTaskId, proof.reviewerToolCallId, proof.artifactId].every(text)
    && Number.isSafeInteger(proof.graphRevision) && Number(proof.graphRevision) > 0
    && Number.isSafeInteger(proof.version) && Number(proof.version) > 0
    && [proof.reviewHash, proof.contentHash, proof.sourceDigest].every(value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)))
}
function exactRecord(value: unknown, keys: readonly string[]): Row | null {
  const row = record(value)
  return row && Reflect.ownKeys(row).length === keys.length && Reflect.ownKeys(row).every(key => typeof key === "string" && keys.includes(key))
    && keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(row, key); return Boolean(descriptor?.enumerable && "value" in descriptor) }) ? row : null
}
function exactKeys(row: Row, keys: readonly string[]): boolean { return Object.keys(row).sort().join(",") === [...keys].sort().join(",") }
function sameJson(left: unknown, right: unknown): boolean { return JSON.stringify(sortJson(left)) === JSON.stringify(sortJson(right)) }
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortJson((value as Row)[key])]))
}
function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null ? value as Row : null
}
function text(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function digest(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) }
function approvalHash(value: unknown): value is string { return typeof value === "string" && /^(?:sha256:)?[a-f0-9]{64}$/.test(value) }
function bareHash(value: string): string { return value.startsWith("sha256:") ? value.slice(7) : value }
