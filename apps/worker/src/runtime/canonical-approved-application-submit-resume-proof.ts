import type { PoolClient } from "pg"
import { bindReviewedApplicationSubmissionMaterial, type ApplicationSubmissionMaterial, type ReviewedApplicationMaterialProof } from "@jobcopilot/shared"
import type { ApplicationRow } from "../db/application-task-completion.js"
import { reviewedApplicationFillSelector } from "./reviewed-application-fill-binding.js"
import { readSelectedJobReviewedArtifactWithClient, type SelectedJobReviewedArtifact } from "./selected-job-reviewed-artifact-read.js"
import type { TurnLease } from "./turns/lease.js"
import { loadTaskGraph } from "./subagents/task-graph-pg-state.js"
import { APPLICATION_FILLER_TEMPLATE_ID } from "./subagents/role-policy.js"
import { taskGraphFingerprint } from "./subagents/task-graph-snapshot.js"
import { readCanonicalApprovedApplicationSubmitReceipts } from "./canonical-approved-application-submit-resume-receipts.js"

type Client = Pick<PoolClient, "query">; type Row = Record<string, unknown>
export type CanonicalApprovedApplicationSubmitResumeProof = Readonly<{
  userId: string; sessionId: string; turnId: string; rootTaskId: string; turnOwnerId: string; turnLeaseVersion: number
  turnRevision: number; applicationTaskId: string; jobId: string; fillerTaskId: string; graphRevision: number
  graphFingerprint: string; approvalId: string; waitItemId: string; approvalRevision: number; resourceHash: string
  materialHash: string; answersHash: string; state: "form_filled" | "submission_authorized"
  workerTaskId: string | null; outboxId: string | null
}>
type Identity = Readonly<{ lease: TurnLease; rootTaskId: string; now: Date }>

/** Reads a private, exact proof for resuming only the already-filled canonical Turn. */
export async function readCanonicalApprovedApplicationSubmitResumeProof(
  client: Client, input: Identity,
): Promise<CanonicalApprovedApplicationSubmitResumeProof | null> {
  const { lease, rootTaskId, now } = input
  if (![lease.userId, lease.sessionId, lease.turnId, lease.ownerId, rootTaskId].every(validId)
    || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1 || !validDate(now)) return null
  const turns = await client.query<Row>(`SELECT turn."id", turn."userId", turn."sessionId", turn."source", turn."executionMode", turn."status",
      turn."rootTaskId", turn."input", turn."revision", turn."leaseOwnerId", turn."leaseVersion", turn."leaseExpiresAt",
      session."status" AS "sessionStatus"
    FROM "agent_turns" AS turn JOIN "agent_sessions" AS session ON session."id"=turn."sessionId" AND session."userId"=turn."userId"
    WHERE turn."id"=$1 AND turn."sessionId"=$2 AND turn."userId"=$3 AND turn."rootTaskId"=$4
      AND turn."source"='user' AND (turn."executionMode"='canonical_task_graph' OR turn."executionMode" IS NULL)
      AND turn."status"='in_progress'
      AND turn."leaseOwnerId"=$5 AND turn."leaseVersion"=$6 AND turn."leaseExpiresAt">$7
      AND session."status" IN ('running','waiting_for_user')`,
  [lease.turnId, lease.sessionId, lease.userId, rootTaskId, lease.ownerId, lease.leaseVersion, now])
  if (turns.rows.length !== 1) return null
  const turn = turns.rows[0]!
  if (![turn.id, turn.userId, turn.sessionId, turn.rootTaskId].every(validId) || turn.id !== lease.turnId
    || turn.userId !== lease.userId || turn.sessionId !== lease.sessionId || turn.rootTaskId !== rootTaskId
    || turn.source !== "user" || (turn.executionMode !== "canonical_task_graph" && turn.executionMode !== null)
    || turn.status !== "in_progress"
    || turn.leaseOwnerId !== lease.ownerId || Number(turn.leaseVersion) !== lease.leaseVersion
    || !Number.isSafeInteger(turn.revision) || Number(turn.revision) < 1 || !future(turn.leaseExpiresAt, now)) return null
  const roots = await client.query<Row>(`SELECT root."id", root."status", root."leaseOwner", root."attemptCount", root."leaseExpiresAt",
      root."interruptRequestedAt", root."completedAt", root."closedAt", root."nextAttemptAt", root."failureReason"
    FROM "sub_agent_tasks" AS root
    JOIN "agent_sessions" AS session ON session."id"=root."sessionId"
    JOIN "agent_turns" AS turn ON turn."id"=root."turnId" AND turn."sessionId"=root."sessionId" AND turn."userId"=session."userId"
    WHERE root."id"=$1 AND root."sessionId"=$2 AND root."turnId"=$3 AND root."rootTaskId"=$1 AND root."parentTaskId" IS NULL
      AND session."userId"=$4 AND root."role"='orchestrator' AND root."taskType"='root' AND root."depth"=0
      AND root."status" IN ('running','waiting','waiting_for_user') AND root."attemptCount"=1
      AND ((root."status"='running' AND root."leaseOwner"=$5 AND root."leaseExpiresAt">$6)
        OR (root."status"='running' AND root."leaseOwner" IS NOT NULL AND root."leaseExpiresAt" IS NOT NULL AND root."leaseExpiresAt"<=$6)
        OR (root."status" IN ('waiting','waiting_for_user') AND root."leaseOwner" IS NULL AND root."leaseExpiresAt" IS NULL))
      AND root."interruptRequestedAt" IS NULL AND root."completedAt" IS NULL AND root."closedAt" IS NULL
      AND root."nextAttemptAt" IS NULL AND root."failureReason" IS NULL`,
  [rootTaskId, lease.sessionId, lease.turnId, lease.userId, lease.ownerId, now])
  if (roots.rows.length !== 1 || !resumableRoot(roots.rows[0]!, lease.ownerId, now)) return null
  let graph
  try { graph = await loadTaskGraph(client, { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId, parentTaskId: rootTaskId }, false) }
  catch { return null }
  const nodes = graph.snapshot?.nodes, graphNodes = graph.state?.nodes
  if (!graph.item || !nodes || !graphNodes || nodes.length !== 1 || graphNodes.length !== 1) return null
  const node = nodes[0]!, current = graphNodes[0]!
  if (node.templateId !== APPLICATION_FILLER_TEMPLATE_ID || node.taskId !== current.taskId || current.status !== "completed"
    || node.verificationDisposition !== "specialized"
    || node.verification !== undefined || node.repairOf !== undefined || node.nativeDelegation !== undefined) return null
  const filler = await client.query<Row>(`SELECT filler."result" FROM "sub_agent_tasks" AS filler
    JOIN "agent_sessions" AS session ON session."id"=filler."sessionId"
    JOIN "agent_turns" AS turn ON turn."id"=filler."turnId" AND turn."sessionId"=filler."sessionId" AND turn."userId"=session."userId"
    WHERE filler."id"=$1 AND filler."sessionId"=$2 AND filler."turnId"=$3 AND filler."rootTaskId"=$4
      AND filler."parentTaskId"=$4 AND session."userId"=$5 AND filler."role"='application_filler'
      AND filler."taskType"='application_fill_for_review' AND filler."status"='completed'
      AND filler."leaseOwner" IS NULL AND filler."leaseExpiresAt" IS NULL AND filler."interruptRequestedAt" IS NULL
      AND filler."completedAt" IS NOT NULL AND filler."closedAt" IS NULL AND filler."nextAttemptAt" IS NULL
      AND filler."failureReason" IS NULL`, [node.taskId, lease.sessionId, lease.turnId, rootTaskId, lease.userId])
  if (filler.rows.length !== 1 || !filledResult(filler.rows[0]!.result)) return null
  const tasks = await client.query<ApplicationRow & { workerTaskId: string | null; question: unknown }>(`SELECT "id", "userId", "sessionId", "jobId", "fillTurnId", "fillTurnSessionId", "fillTurnUserId", "status", "checkpoint",
      "workerTaskId", "resumeId", "coverLetterId", "confirmedAnswers", "question" FROM "application_tasks"
    WHERE "fillTurnId"=$1 AND "fillTurnSessionId"=$2 AND "fillTurnUserId"=$3 AND "userId"=$3 AND "sessionId"=$2 LIMIT 2`,
  [lease.turnId, lease.sessionId, lease.userId])
  if (tasks.rows.length !== 1) return null
  const task = tasks.rows[0]!, jobId = task.jobId
  if (![task.id, jobId].every(validId) || task.userId !== lease.userId || task.sessionId !== lease.sessionId
    || task.fillTurnId !== lease.turnId || task.fillTurnSessionId !== lease.sessionId || task.fillTurnUserId !== lease.userId
    || task.question != null || (task.resumeId !== null && !validId(task.resumeId)) || (task.coverLetterId !== null && !validId(task.coverLetterId))) return null
  const selector = reviewedApplicationFillSelector(turn.input)
  if (selector.kind === "invalid" || (turn.executionMode === null && selector.kind !== "selected")) return null
  const material = await preparedMaterial(client, selector, task, lease, node.taskId)
  if (!material) return null
  const receipts = await readCanonicalApprovedApplicationSubmitReceipts(client, { lease, task, material, now, turnRevision: Number(turn.revision) })
  if (!receipts || receipts.state === "form_filled" && (task.status !== "waiting_for_authorization" || task.checkpoint !== "form_filled" || task.workerTaskId !== null)
    || receipts.state === "submission_authorized" && (task.status !== "filling" || task.checkpoint !== "submission_authorized" || task.workerTaskId !== receipts.workerTaskId)) return null
  return { userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId, turnOwnerId: lease.ownerId,
    turnLeaseVersion: lease.leaseVersion, turnRevision: Number(turn.revision), applicationTaskId: task.id, jobId, fillerTaskId: node.taskId,
    graphRevision: graph.item.revision, graphFingerprint: taskGraphFingerprint(graph.snapshot), approvalId: `application-fill:${task.id}:${lease.turnId}`,
    waitItemId: `agent-wait:approval:application-fill:${task.id}:${lease.turnId}`, approvalRevision: receipts.approvalRevision,
    resourceHash: receipts.resourceHash, materialHash: receipts.materialHash, answersHash: receipts.answersHash,
    state: receipts.state, workerTaskId: receipts.workerTaskId, outboxId: receipts.outboxId }
}

/** Allows only the queue's atomic form_filled → authorized transition between checks. */
export function sameCanonicalApprovedApplicationSubmitResumeProof(before: CanonicalApprovedApplicationSubmitResumeProof, after: CanonicalApprovedApplicationSubmitResumeProof): boolean {
  const stable = (value: CanonicalApprovedApplicationSubmitResumeProof) => Object.fromEntries(Object.entries(value).filter(([key]) => !["state", "workerTaskId", "outboxId"].includes(key)))
  if (canonical(stable(before)) !== canonical(stable(after))) return false
  if (before.state === "form_filled" && after.state === "submission_authorized") return before.workerTaskId === null && before.outboxId === null && validId(after.workerTaskId) && validId(after.outboxId)
  return before.state === after.state && before.workerTaskId === after.workerTaskId && before.outboxId === after.outboxId
}

async function preparedMaterial(client: Client, selector: ReturnType<typeof reviewedApplicationFillSelector>, task: Row,
  lease: TurnLease, fillerTaskId: string): Promise<ApplicationSubmissionMaterial | null> {
  const legacy = { applicationTaskId: task.id as string, jobId: task.jobId as string, resumeId: task.resumeId as string | null, coverLetterId: task.coverLetterId as string | null }
  const events = await client.query<Row>(`SELECT "actor", "data" FROM "application_task_events"
    WHERE "taskId"=$1 AND "type"='reviewed_application_fill_browser_started' AND "data"->>'fillTurnId'=$2 LIMIT 2`, [task.id, lease.turnId])
  if (selector.kind === "absent") return events.rows.length === 0 ? legacy : null
  if (selector.kind !== "selected" || events.rows.length !== 1) return null
  const current = await readSelectedJobReviewedArtifactWithClient(client, { userId: lease.userId, sessionId: lease.sessionId, jobId: task.jobId as string, sourceTurnId: selector.sourceTurnId })
  if (!current || current.jobId !== task.jobId || current.sourceTurnId !== selector.sourceTurnId
    || !sameBrowserBinding(events.rows[0]!, lease, task, fillerTaskId, current)) return null
  const proof: ReviewedApplicationMaterialProof = { jobId: current.jobId, sourceTurnId: current.sourceTurnId, rootTaskId: current.rootTaskId,
    graphRevision: current.graphRevision, writerTaskId: current.writerTaskId, reviewerTaskId: current.reviewerTaskId,
    reviewerToolCallId: current.reviewerToolCallId, reviewHash: current.reviewHash, artifactId: current.artifactId,
    version: current.version, contentHash: current.contentHash, sourceDigest: current.sourceDigest }
  return bindReviewedApplicationSubmissionMaterial(legacy, proof)
}

function sameBrowserBinding(row: Row, lease: TurnLease, task: Row, fillerTaskId: string, proof: SelectedJobReviewedArtifact): boolean {
  const data = exact(row.data, "applicationTaskId,artifactId,attemptCount,contentHash,fillTurnId,fillerTaskId,graphRevision,jobId,leaseExpiresAt,leaseOwner,reviewHash,reviewerTaskId,reviewerToolCallId,rootTaskId,schemaVersion,sessionId,sourceDigest,sourceTurnId,userId,version,writerTaskId")
  return row.actor === "worker" && data?.schemaVersion === "agent-harness.v2.reviewed-application-fill-browser-start.v1"
    && data.userId === lease.userId && data.sessionId === lease.sessionId && data.fillTurnId === lease.turnId
    && data.applicationTaskId === task.id && data.fillerTaskId === fillerTaskId && data.jobId === task.jobId && data.rootTaskId === proof.rootTaskId
    && Number(data.graphRevision) === proof.graphRevision && Number.isSafeInteger(data.attemptCount) && Number(data.attemptCount) > 0
    && validId(data.leaseOwner) && isoDate(data.leaseExpiresAt) && data.sourceTurnId === proof.sourceTurnId
    && data.writerTaskId === proof.writerTaskId && data.reviewerTaskId === proof.reviewerTaskId
    && data.reviewerToolCallId === proof.reviewerToolCallId && data.reviewHash === proof.reviewHash && data.artifactId === proof.artifactId
    && Number(data.version) === proof.version && data.contentHash === proof.contentHash && data.sourceDigest === proof.sourceDigest
}
function filledResult(value: unknown): boolean { const row = exact(value, "status"); return row?.status === "filled_for_user_review" }
function resumableRoot(row: Row, ownerId: string, now: Date): boolean {
  const running = row.status === "running" && (row.leaseOwner === ownerId && future(row.leaseExpiresAt, now)
    || validId(row.leaseOwner) && expired(row.leaseExpiresAt, now))
  const waiting = (row.status === "waiting" || row.status === "waiting_for_user") && row.leaseOwner === null && row.leaseExpiresAt === null
  return Number(row.attemptCount) === 1 && (running || waiting) && row.interruptRequestedAt == null
    && row.completedAt == null && row.closedAt == null && row.nextAttemptAt == null && row.failureReason == null
}
function exact(value: unknown, keys: string): Row | null { const row = object(value); return row && Object.keys(row).sort().join(",") === keys ? row : null }
function object(value: unknown): Row | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { return Object.getPrototypeOf(parsed) === Object.prototype ? parsed as Row : null } catch { return null }
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; const row = object(value); return row ? `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}` : JSON.stringify(value) ?? "null" }
function validId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value) }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()) }
function future(value: unknown, now: Date): boolean { const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; return !!parsed && Number.isFinite(parsed.getTime()) && parsed > now }
function expired(value: unknown, now: Date): boolean { const parsed = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null; return !!parsed && Number.isFinite(parsed.getTime()) && parsed <= now }
function isoDate(value: unknown): boolean { if (typeof value !== "string") return false; const parsed = new Date(value); return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value }
