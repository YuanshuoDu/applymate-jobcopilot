import type { PoolClient } from "pg"
import {
  bindReviewedApplicationSubmissionMaterial, hashAgentReceiptValue, hashApplicationSubmissionMaterial,
  isApplicationSubmissionManifest,
  parseReviewedApplicationFillBrowserStartEvent, type ReviewedApplicationMaterialProof,
} from "@jobcopilot/shared"
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js"
import { readSelectedJobReviewedArtifactWithClient } from "../runtime/selected-job-reviewed-artifact-read.js"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"

type Client = Pick<PoolClient, "query">
type ApprovalHashes = Readonly<{ resourceHash: string; materialHash: string; answersHash: string }>
type TaskRow = { id: string; userId: string; jobId: string; sessionId: string; fillTurnId: string; fillTurnSessionId: string; fillTurnUserId: string; resumeId: string | null; coverLetterId: string | null; confirmedAnswers: unknown }
type FillerRow = { id: string; attemptCount: number }
type EventRow = { actor: string; data: unknown; createdAt: Date | string }
type ArtifactRow = { id: string; userId: string; jobId: string; artifactType: string; lifecycle: string; content: unknown; hash: string }
const REVIEWED_MANIFEST_SCHEMA = "agent-harness.application-submission.v2" as const

export type ReviewedApplicationSubmitMaterial = Readonly<{ artifactHash: string; reviewedCoverLetter?: string }>

/** Prevents a missing marker from downgrading this exact task's immutable reviewed artifact to legacy mode. */
export async function hasReviewedSubmissionArtifact(client: Client, identity: ApplicationSubmitIdentity): Promise<boolean> {
  const result = await client.query<{ content: unknown }>(`SELECT "content" FROM "agent_artifact" WHERE "id"=$1 AND "userId"=$2
    AND "jobId"=$3 AND "artifactType"='application' AND "lifecycle"='base' LIMIT 2`,
  [`application:${identity.applicationTaskId}`, identity.userId, identity.jobId])
  if (result.rows.length === 0) return false
  if (result.rows.length !== 1) return true
  const value = result.rows[0]?.content
  if (!value || typeof value !== "object" || Array.isArray(value)) return true
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) return true
    const schema = Object.getOwnPropertyDescriptor(value, "schemaVersion")
    const commitment = Object.getOwnPropertyDescriptor(value, "reviewedCoverLetterHash")
    return Boolean(commitment || schema && "value" in schema && schema.value === REVIEWED_MANIFEST_SCHEMA)
  } catch { return true }
}

/** Revalidates the immutable reviewed manifest and its exact browser-start attempt before approval consumption. */
export async function readReviewedApplicationSubmitMaterial(input: {
  client: Client; identity: ApplicationSubmitIdentity; sourceTurnId: string; approval: ApprovalHashes; currentSource: boolean
}): Promise<ReviewedApplicationSubmitMaterial | null> {
  const { client, identity, sourceTurnId, approval } = input
  const [taskResult, fillerResult, eventResult, artifactResult] = await Promise.all([
    client.query<TaskRow>(`SELECT "id","userId","jobId","sessionId","fillTurnId","fillTurnSessionId","fillTurnUserId","resumeId","coverLetterId","confirmedAnswers"
      FROM "application_tasks" WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5 LIMIT 2`,
    [identity.applicationTaskId, identity.userId, identity.jobId, identity.sessionId, identity.fillTurnId]),
    client.query<FillerRow>(`SELECT filler."id",filler."attemptCount" FROM "sub_agent_tasks" filler
      JOIN "agent_turns" turn ON turn."id"=filler."turnId" AND turn."sessionId"=filler."sessionId" AND turn."userId"=$3
      JOIN "agent_sessions" session ON session."id"=filler."sessionId" AND session."userId"=$3
      WHERE filler."sessionId"=$1 AND filler."turnId"=$2 AND filler."role"='application_filler'
        AND filler."taskType"='application_fill_for_review' AND filler.status='completed'
        AND filler."leaseOwner" IS NULL AND filler."leaseExpiresAt" IS NULL AND filler."interruptRequestedAt" IS NULL LIMIT 2`,
    [identity.sessionId, identity.fillTurnId, identity.userId]),
    client.query<EventRow>(`SELECT "actor","data","createdAt" FROM "application_task_events" WHERE "taskId"=$1
      AND "type"='reviewed_application_fill_browser_started' AND "data"->>'fillTurnId'=$2 LIMIT 2`,
    [identity.applicationTaskId, identity.fillTurnId]),
    client.query<ArtifactRow>(`SELECT "id","userId","jobId","artifactType","lifecycle","content","hash" FROM "agent_artifact"
      WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3 AND "artifactType"='application' AND "lifecycle"='base' LIMIT 2`,
    [`application:${identity.applicationTaskId}`, identity.userId, identity.jobId]),
  ])
  const task = taskResult.rows[0], filler = fillerResult.rows[0], event = eventResult.rows[0], artifact = artifactResult.rows[0]
  if (taskResult.rows.length !== 1 || fillerResult.rows.length !== 1 || eventResult.rows.length !== 1 || artifactResult.rows.length !== 1
    || !task || !filler || !event || !artifact || !sameTask(task, identity) || !validFiller(filler)) return null
  const binding = parseReviewedApplicationFillBrowserStartEvent(event.data)
  if (event.actor !== "worker" || !binding || !validEventTime(event.createdAt, binding.leaseExpiresAt)
    || binding.userId !== identity.userId || binding.sessionId !== identity.sessionId || binding.fillTurnId !== identity.fillTurnId
    || binding.jobId !== identity.jobId || binding.applicationTaskId !== identity.applicationTaskId
    || binding.fillerTaskId !== filler.id || binding.attemptCount !== filler.attemptCount || binding.proof.sourceTurnId !== sourceTurnId) return null
  if (artifact.id !== `application:${identity.applicationTaskId}` || artifact.userId !== identity.userId || artifact.jobId !== identity.jobId
    || artifact.artifactType !== "application" || artifact.lifecycle !== "base" || !validArtifactHash(artifact.content, artifact.hash, approval.resourceHash)) return null
  const manifest = artifact.content
  if (!isApplicationSubmissionManifest(manifest) || manifest.schemaVersion !== REVIEWED_MANIFEST_SCHEMA
    || manifest.applicationTaskId !== task.id || manifest.jobId !== task.jobId || manifest.resumeId !== task.resumeId
    || manifest.coverLetterId !== task.coverLetterId) return null
  const answersHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
  const material = await bindReviewedApplicationSubmissionMaterial({
    applicationTaskId: task.id, jobId: task.jobId, resumeId: task.resumeId, coverLetterId: task.coverLetterId,
  }, binding.proof)
  if (!material || manifest.answersHash !== answersHash || answersHash !== approval.answersHash
    || manifest.reviewedCoverLetterHash !== material.reviewedCoverLetterHash
    || await hashApplicationSubmissionMaterial(material) !== approval.materialHash) return null
  if (!input.currentSource) return { artifactHash: approval.resourceHash }
  const current = await readSelectedJobReviewedArtifactWithClient(client, {
    userId: identity.userId, sessionId: identity.sessionId, jobId: identity.jobId, sourceTurnId,
  })
  if (!current || !sameProof(current, binding.proof) || typeof current.content !== "string" || !current.content.trim()) return null
  return { artifactHash: approval.resourceHash, reviewedCoverLetter: current.content }
}

function sameTask(task: TaskRow, identity: ApplicationSubmitIdentity): boolean {
  return task.id === identity.applicationTaskId && task.userId === identity.userId && task.jobId === identity.jobId
    && task.sessionId === identity.sessionId && task.fillTurnId === identity.fillTurnId
    && task.fillTurnSessionId === identity.sessionId && task.fillTurnUserId === identity.userId
}
function validFiller(row: FillerRow): boolean { return typeof row.id === "string" && row.id.trim() === row.id && row.id.length > 0 && Number.isSafeInteger(row.attemptCount) && row.attemptCount > 0 }
function validEventTime(value: Date | string, leaseExpiresAt: string): boolean {
  const created = value instanceof Date ? value : new Date(value), expiry = new Date(leaseExpiresAt)
  return Number.isFinite(created.getTime()) && Number.isFinite(expiry.getTime()) && created.getTime() < expiry.getTime()
}
function validArtifactHash(content: unknown, storedHash: string, resourceHash: string): boolean {
  return typeof storedHash === "string" && /^[a-f0-9]{64}$/.test(resourceHash)
    && storedHash === `sha256:${resourceHash}` && hashArtifactContent(content) === storedHash
}
function sameProof(value: ReviewedApplicationMaterialProof, expected: ReviewedApplicationMaterialProof): boolean {
  return value.jobId === expected.jobId && value.sourceTurnId === expected.sourceTurnId && value.rootTaskId === expected.rootTaskId
    && value.graphRevision === expected.graphRevision && value.writerTaskId === expected.writerTaskId
    && value.reviewerTaskId === expected.reviewerTaskId && value.reviewerToolCallId === expected.reviewerToolCallId
    && value.reviewHash === expected.reviewHash && value.artifactId === expected.artifactId && value.version === expected.version
    && value.contentHash === expected.contentHash && value.sourceDigest === expected.sourceDigest
}
