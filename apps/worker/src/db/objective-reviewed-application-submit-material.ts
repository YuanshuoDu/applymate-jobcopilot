import type { PoolClient } from "pg"
import {
  bindReviewedApplicationSubmissionMaterial, canonicalJson, hashAgentReceiptValue, hashObjectiveApplicationSubmissionMaterial,
  parseObjectiveReviewedFillSource, parseObjectiveReviewedApplicationFillBrowserStartEvent,
} from "@jobcopilot/shared"
import type { ObjectiveReviewedFillSource } from "@jobcopilot/shared"
import type { ApplicationSubmitIdentity } from "../queue/application-submit-fence.js"
import { readObjectiveSubmissionManifestWithClient } from "./objective-submission-manifest-event.js"
import { readObjectiveReviewedApplicationFillSource } from "../runtime/objective-reviewed-application-fill-read.js"
import { hashArtifactContent } from "../runtime/subagents/artifact-adapters.js"

type Client = Pick<PoolClient, "query">
type Row = Record<string, unknown>
type ApprovalHashes = Readonly<{ resourceHash: string; materialHash: string; answersHash: string }>
type Phase = "authorize" | "marker" | "boundary"
type Input = Readonly<{ client: Client; identity: ApplicationSubmitIdentity; turnInput: unknown; approval: ApprovalHashes; phase: Phase; now?: Date }>
type Task = Readonly<{ resumeId: string | null; coverLetterId: string | null; confirmedAnswers: unknown; status: string; checkpoint: string | null }>
type Filler = Readonly<{ id: string; attemptCount: number }>
type BrowserEvent = Readonly<{ actor: string; data: unknown; createdAt: Date | string }>
export type ObjectiveReviewedApplicationSubmitPacket = Readonly<{
  reviewedResumeContent: unknown
  reviewedCoverLetter: string
  confirmedAnswers: Readonly<Record<string, string>>
  approvedApplyUrl: string
}>
export type ObjectiveReviewedApplicationSubmitMaterial = Readonly<{
  artifactHash: string
  packet: ObjectiveReviewedApplicationSubmitPacket
  objectiveSource: ObjectiveReviewedFillSource
}>

const HEX = /^[a-f0-9]{64}$/
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/
const BROWSER_START_TYPE = "reviewed_application_fill_browser_started"
const MANIFEST_TYPE = "objective_submission_manifest_recorded"

/** Revalidates V3 Objective submission material and current Resume on the submit fence transaction. */
export async function readObjectiveReviewedApplicationSubmitMaterial(input: Input): Promise<ObjectiveReviewedApplicationSubmitMaterial | null> {
  const { client, identity, approval, phase } = input
  if (!validInput(input)) return null
  const objectiveSource = parseObjectiveReviewedFillSource(input.turnInput)
  if (!objectiveSource) return null
  try {
    const evidence = await readObjectiveReviewedApplicationFillSource(client, {
      userId: identity.userId, sessionId: identity.sessionId, fillTurnId: identity.fillTurnId,
      applicationTaskId: identity.applicationTaskId, jobId: identity.jobId, turnInput: input.turnInput,
      phase, ...(input.now ? { now: input.now } : {}),
    })
    if (!evidence || !sameSource(evidence.source, objectiveSource)) return null
    const scope = { userId: identity.userId, sessionId: identity.sessionId, applicationTaskId: identity.applicationTaskId,
      jobId: identity.jobId, fillTurnId: identity.fillTurnId }
    const stored = await readObjectiveSubmissionManifestWithClient(client, scope)
    if (!stored || stored.hash !== `sha256:${approval.resourceHash}`) return null
    const [task, filler, event, job] = await Promise.all([
      readCurrentTask(client, identity, phase), readCompletedFiller(client, identity), readBrowserStart(client, identity),
      readCurrentJob(client, identity),
    ])
    if (!task || !filler || !event || event.actor !== "worker" || !job) return null
    const binding = parseObjectiveReviewedApplicationFillBrowserStartEvent(event.data)
    if (!binding || !sameBrowserStart(binding, identity, filler, objectiveSource, evidence, event.createdAt)) return null
    const manifest = stored.manifest, material = manifest.material
    if (material.applicationTaskId !== identity.applicationTaskId || material.jobId !== identity.jobId
      || material.resumeId !== task.resumeId || material.coverLetterId !== task.coverLetterId
      || task.resumeId !== evidence.resumeWitness.resumeId) return null
    const answerHash = await hashAgentReceiptValue("answers", task.confirmedAnswers ?? null)
    const materialHash = await hashObjectiveApplicationSubmissionMaterial(material)
    const confirmedAnswers = projectConfirmedAnswers(task.confirmedAnswers)
    const reviewed = await bindReviewedApplicationSubmissionMaterial({ applicationTaskId: identity.applicationTaskId,
      jobId: identity.jobId, resumeId: task.resumeId, coverLetterId: task.coverLetterId }, binding.proof)
    if (!answerHash || answerHash !== manifest.answersHash || answerHash !== approval.answersHash
      || !materialHash || materialHash !== approval.materialHash || manifest.answersHash !== approval.answersHash
      || !reviewed || reviewed.reviewedCoverLetterHash !== material.reviewedCoverLetterHash || !confirmedAnswers) return null
    return { artifactHash: approval.resourceHash, objectiveSource, packet: {
      reviewedCoverLetter: evidence.reviewedArtifact.content, reviewedResumeContent: evidence.resumeContent,
      confirmedAnswers, approvedApplyUrl: job.url,
    } }
  } catch { return null }
}

/** Treats any current-task V3 manifest event, including a malformed one, as Objective evidence. */
export async function hasObjectiveSubmissionManifestEvidence(client: Client, identity: ApplicationSubmitIdentity): Promise<boolean> {
  if (!validIdentity(identity)) return true
  let eventId: string
  try { eventId = `objective-submission-manifest:${hashArtifactContent([identity.applicationTaskId, identity.fillTurnId]).slice(7)}` }
  catch { return true }
  try {
    const result = await client.query<Row>(`SELECT event."id" FROM "application_task_events" AS event
      JOIN "application_tasks" AS task ON task."id"=event."taskId" AND task."userId"=$2 AND task."sessionId"=$3
        AND task."jobId"=$4 AND task."fillTurnId"=$5 AND task."fillTurnSessionId"=$3 AND task."fillTurnUserId"=$2
      WHERE event."taskId"=$1 AND (event."id"=$6 OR event."type"=$7) LIMIT 2`,
    [identity.applicationTaskId, identity.userId, identity.sessionId, identity.jobId, identity.fillTurnId, eventId, MANIFEST_TYPE])
    return result.rows.length > 0
  } catch { return true }
}

async function readCurrentTask(client: Client, identity: ApplicationSubmitIdentity, phase: Phase): Promise<Task | null> {
  const checkpoint = phase === "boundary" ? "submission_request_started" : "browser_active"
  const result = await client.query<Task>(`SELECT "resumeId", "coverLetterId", "confirmedAnswers", "status", "checkpoint"
    FROM "application_tasks" WHERE "id"=$1 AND "userId"=$2 AND "sessionId"=$3 AND "jobId"=$4
      AND "fillTurnId"=$5 AND "fillTurnSessionId"=$3 AND "fillTurnUserId"=$2 LIMIT 2 FOR SHARE`,
  [identity.applicationTaskId, identity.userId, identity.sessionId, identity.jobId, identity.fillTurnId])
  const task = result.rows[0]
  return result.rows.length === 1 && task && task.status === "filling" && task.checkpoint === checkpoint ? task : null
}

async function readCurrentJob(client: Client, identity: ApplicationSubmitIdentity): Promise<{ url: string } | null> {
  const result = await client.query<{ url: string }>(`SELECT url FROM "Job" WHERE "id"=$1 AND "userId"=$2 FOR SHARE`, [identity.jobId, identity.userId])
  const url = result.rows[0]?.url
  if (result.rows.length !== 1 || typeof url !== "string" || url.length > 2048 || url.trim() !== url) return null
  try { const parsed = new URL(url); return parsed.protocol === "https:" && !parsed.username && !parsed.password ? { url } : null }
  catch { return null }
}

function projectConfirmedAnswers(value: unknown): Readonly<Record<string, string>> | null {
  if (value === null || value === undefined) return Object.freeze(Object.create(null) as Record<string, string>)
  if (typeof value !== "object" || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return null
    const keys = Reflect.ownKeys(value)
    if (keys.length > 65) return null
    const answers = Object.create(null) as Record<string, string>
    for (const key of keys) {
      if (typeof key !== "string" || !key.trim() || key.length > 256) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")
        || typeof descriptor.value !== "string" || !descriptor.value.trim() || descriptor.value.length > 2000) return null
      answers[key] = descriptor.value
    }
    return Object.freeze(answers)
  } catch { return null }
}

async function readCompletedFiller(client: Client, identity: ApplicationSubmitIdentity): Promise<Filler | null> {
  const result = await client.query<Filler>(`SELECT filler."id", filler."attemptCount" FROM "sub_agent_tasks" AS filler
    JOIN "agent_turns" AS turn ON turn."id"=filler."turnId" AND turn."sessionId"=filler."sessionId" AND turn."userId"=$3
    JOIN "agent_sessions" AS session ON session."id"=filler."sessionId" AND session."userId"=$3
    WHERE filler."sessionId"=$1 AND filler."turnId"=$2 AND filler."role"='application_filler'
      AND filler."taskType"='application_fill_for_review' AND filler."status"='completed'
      AND filler."leaseOwner" IS NULL AND filler."leaseExpiresAt" IS NULL AND filler."interruptRequestedAt" IS NULL LIMIT 2`,
  [identity.sessionId, identity.fillTurnId, identity.userId])
  const row = result.rows[0]
  return result.rows.length === 1 && row && ID.test(row.id) && Number.isSafeInteger(row.attemptCount) && row.attemptCount > 0 ? row : null
}

async function readBrowserStart(client: Client, identity: ApplicationSubmitIdentity): Promise<BrowserEvent | null> {
  const result = await client.query<BrowserEvent>(`SELECT "actor", "data", "createdAt" FROM "application_task_events"
    WHERE "taskId"=$1 AND "type"=$2 AND "data"->>'fillTurnId'=$3 LIMIT 2`,
  [identity.applicationTaskId, BROWSER_START_TYPE, identity.fillTurnId])
  return result.rows.length === 1 ? result.rows[0] ?? null : null
}

function sameBrowserStart(binding: NonNullable<ReturnType<typeof parseObjectiveReviewedApplicationFillBrowserStartEvent>>,
  identity: ApplicationSubmitIdentity, filler: Filler, source: ObjectiveReviewedFillSource,
  evidence: NonNullable<Awaited<ReturnType<typeof readObjectiveReviewedApplicationFillSource>>>, createdAt: Date | string): boolean {
  const when = createdAt instanceof Date ? createdAt : new Date(createdAt), expiry = new Date(binding.leaseExpiresAt)
  const currentProof = { jobId: evidence.reviewedArtifact.jobId, sourceTurnId: evidence.reviewedArtifact.sourceTurnId,
    rootTaskId: evidence.reviewedArtifact.rootTaskId, graphRevision: evidence.reviewedArtifact.graphRevision,
    writerTaskId: evidence.reviewedArtifact.writerTaskId, reviewerTaskId: evidence.reviewedArtifact.reviewerTaskId,
    reviewerToolCallId: evidence.reviewedArtifact.reviewerToolCallId, reviewHash: evidence.reviewedArtifact.reviewHash,
    artifactId: evidence.reviewedArtifact.artifactId, version: evidence.reviewedArtifact.version,
    contentHash: evidence.reviewedArtifact.contentHash, sourceDigest: evidence.reviewedArtifact.sourceDigest }
  return binding.userId === identity.userId && binding.sessionId === identity.sessionId && binding.fillTurnId === identity.fillTurnId
    && binding.applicationTaskId === identity.applicationTaskId && binding.jobId === identity.jobId
    && binding.fillerTaskId === filler.id && binding.attemptCount === filler.attemptCount
    && sameSource(binding.objectiveSource, source) && canonicalProof(binding.proof, currentProof)
    && Number.isFinite(when.getTime()) && Number.isFinite(expiry.getTime()) && when < expiry
}

function canonicalProof(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right) } catch { return false }
}
function sameSource(left: ObjectiveReviewedFillSource, right: ObjectiveReviewedFillSource): boolean {
  return left.schemaVersion === right.schemaVersion && left.approvalId === right.approvalId
    && left.reviewTurnId === right.reviewTurnId && left.materialProofHash === right.materialProofHash
}
function validInput(input: Input): boolean {
  return validIdentity(input.identity) && [input.approval.resourceHash, input.approval.materialHash, input.approval.answersHash]
    .every(value => typeof value === "string" && HEX.test(value))
    && ["authorize", "marker", "boundary"].includes(input.phase)
    && (input.now === undefined || input.now instanceof Date && Number.isFinite(input.now.getTime()))
}
function validIdentity(identity: ApplicationSubmitIdentity): boolean {
  return [identity.sessionId, identity.fillTurnId, identity.applicationTaskId, identity.userId, identity.jobId, identity.approvalId]
    .every(value => typeof value === "string" && ID.test(value)) && HEX.test(identity.constraintHash)
}
