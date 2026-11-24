import type pg from "pg"
import type { TurnLease } from "./turns/lease.js"
import type { ResumeContent } from "../db/resume-pdf.js"
import type { FlowType } from "../flows/index.js"
import { OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, parseObjectiveReviewedFillSource } from "@jobcopilot/shared"
import { acquireSourceMaterialFence } from "../db/source-material-fence.js"
import { reviewedApplicationFillSelector } from "./reviewed-application-fill-binding.js"
import type { ObjectiveReviewedApplicationFillEvidence } from "./objective-reviewed-application-fill-read.js"

/** A positive marker carries no ApplicationTask identity into model-visible context. */
export type ApplicationFillPreparation = Readonly<{ available: true }>
export type ApplicationFillContext = {
  applicationTaskId: string; jobId: string; turnInput: unknown; applicationUserId: string; applicationSessionId: string | null
  fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; taskStatus: string; checkpoint: string | null
  resumeId: string | null; coverLetterId: string | null; confirmedAnswers: unknown; jobUserId: string; jobUrl: string | null
  jobTitle: string; jobCompany: string; jobKeywords: string | null; jobDescription: string | null; jobCoverLetter: string | null
  accountStatus: string; userName: string | null; userEmail: string; userPhone: string | null; userLocation: string | null
  userLinkedin: string | null; personaFields: unknown; resumeContent: unknown; coverLetterContent: string | null
  sessionUserId: string; sessionStatus: string; turnUserId: string; turnSessionId: string; turnStatus: string
}

type BoundApplicationTask = {
  id: string
  userId: string
  jobId: string
  sessionId: string | null
  fillTurnSessionId: string | null
  fillTurnUserId: string | null
  turnInput: unknown
  status: string
  checkpoint: string | null
}

/** Exposes the fixed fill template only after the leased Turn's persisted materials validate. */
export async function loadApplicationFillPreparation(
  pool: Pick<pg.Pool, "connect">,
  lease: TurnLease,
  now = new Date(),
): Promise<ApplicationFillPreparation | undefined> {
  if (![lease.userId, lease.sessionId, lease.turnId, lease.ownerId].every(value => typeof value === "string" && value.trim())
    || !Number.isSafeInteger(lease.leaseVersion) || lease.leaseVersion < 1 || !(now instanceof Date) || !Number.isFinite(now.getTime())) return undefined
  const client = await pool.connect()
  let committed = false
  try {
    await client.query("BEGIN")
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    const bound = await client.query<BoundApplicationTask>(
      `SELECT app."id", app."userId", app."jobId", app."sessionId", app."fillTurnSessionId", app."fillTurnUserId", app."status", app."checkpoint",
              turn."input" AS "turnInput"
       FROM "agent_turns" AS turn
       INNER JOIN "application_tasks" AS app ON app."fillTurnId" = turn."id"
       WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3
         AND turn."leaseOwnerId" = $4 AND turn."leaseVersion" = $5
         AND turn."leaseExpiresAt" > $6 AND turn."status" = 'in_progress'`,
      [lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion, now],
    )
    if (bound.rows.length === 0) return await commitUnavailable(client, () => { committed = true })
    if (bound.rows.length !== 1) throw new Error("application_fill_binding_invalid")
    const task = bound.rows[0]!
    if (task.userId !== lease.userId || task.sessionId !== lease.sessionId
      || task.fillTurnUserId !== lease.userId || task.fillTurnSessionId !== lease.sessionId) {
      throw new Error("application_fill_binding_invalid")
    }
    const objectiveMarker = objectiveSourceMarker(task.turnInput)
    if (objectiveMarker && (task.status !== "filling" || task.checkpoint !== "taskgraph_fill_queued")) {
      throw new Error("objective_application_fill_unavailable")
    }
    if (task.status === "filling" && task.checkpoint === "browser_active") {
      return await commitUnavailable(client, () => { committed = true })
    }
    if (task.status !== "filling" || task.checkpoint !== "taskgraph_fill_queued") {
      throw new Error("application_fill_state_invalid")
    }

    if (objectiveMarker) {
      const source = parseObjectiveReviewedFillSource(task.turnInput)
      if (!source) throw new Error("objective_application_fill_unavailable")
      await acquireSourceMaterialFence(client, [lease.userId])
      const { readObjectiveReviewedApplicationFillSource } = await import("./objective-reviewed-application-fill-read.js")
      const evidence: ObjectiveReviewedApplicationFillEvidence | undefined = await readObjectiveReviewedApplicationFillSource(client, { userId: lease.userId,
        sessionId: lease.sessionId, fillTurnId: lease.turnId, applicationTaskId: task.id, jobId: task.jobId,
        turnInput: task.turnInput, phase: "prepare", now })
      if (!evidence || evidence.source.approvalId !== source.approvalId
        || evidence.source.reviewTurnId !== source.reviewTurnId
        || evidence.source.materialProofHash !== source.materialProofHash) {
        throw new Error("objective_application_fill_unavailable")
      }
      await client.query("COMMIT")
      committed = true
      return Object.freeze({ available: true })
    }

    const selector = reviewedApplicationFillSelector(task.turnInput)
    if (selector.kind === "invalid") return await commitUnavailable(client, () => { committed = true })
    if (selector.kind === "selected") {
      // The terminal reader imports TaskGraph state; defer loading it until the marked path.
      const { readSelectedJobReviewedArtifactWithClient } = await import("./selected-job-reviewed-artifact-read.js")
      const proof = await readSelectedJobReviewedArtifactWithClient(client, {
        userId: lease.userId, sessionId: lease.sessionId, jobId: task.jobId, sourceTurnId: selector.sourceTurnId,
      })
      if (!proof || proof.jobId !== task.jobId || proof.sourceTurnId !== selector.sourceTurnId) {
        return await commitUnavailable(client, () => { committed = true })
      }
    }

    const materials = await client.query<{ id: string }>(
      `SELECT app."id"
       FROM "application_tasks" AS app
       INNER JOIN "Job" AS job ON job."id" = app."jobId" AND job."userId" = app."userId"
       INNER JOIN "Resume" AS resume ON resume."id" = app."resumeId" AND resume."userId" = app."userId"
         AND (resume."targetJobId" IS NULL OR resume."targetJobId" = app."jobId")
       LEFT JOIN "CoverLetter" AS cover ON cover."id" = app."coverLetterId"
         AND cover."userId" = app."userId" AND cover."jobId" = app."jobId"
       WHERE app."id" = $1 AND app."userId" = $2 AND app."sessionId" = $3
         AND app."fillTurnId" = $4 AND app."fillTurnSessionId" = $3 AND app."fillTurnUserId" = $2
         AND app."status" = 'filling' AND app."checkpoint" = 'taskgraph_fill_queued'
         AND app."resumeId" IS NOT NULL AND (app."coverLetterId" IS NULL OR cover."id" IS NOT NULL)`,
      [task.id, lease.userId, lease.sessionId, lease.turnId],
    )
    if (materials.rows.length !== 1) throw new Error("application_fill_material_unavailable")
    await client.query("COMMIT")
    committed = true
    return Object.freeze({ available: true })
  } catch (error: unknown) {
    if (!committed) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}

async function commitUnavailable(client: Pick<pg.PoolClient, "query">, markCommitted: () => void): Promise<undefined> {
  await client.query("COMMIT")
  markCommitted()
  return undefined
}

export function buildApplicationFillInput(row: ApplicationFillContext, reviewedSourceSelected: boolean) {
  if (!row.resumeId || !row.resumeContent) throw new Error("resume_unavailable")
  if (!reviewedSourceSelected && row.coverLetterId && row.coverLetterContent === null) throw new Error("cover_letter_unavailable")
  const resumeContent = parseResumeContent(row.resumeContent)
  const persona: Record<string, string> = { fullName: row.userName ?? "", email: row.userEmail,
    phone: row.userPhone ?? "", location: row.userLocation ?? "", linkedinUrl: row.userLinkedin ?? "" }
  if (Array.isArray(row.personaFields)) for (const item of row.personaFields) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const value = item as Record<string, unknown>
      if (typeof value.key === "string" && value.key.trim() && typeof value.value === "string") persona[value.key] = value.value
    }
  }
  if (!reviewedSourceSelected && (row.coverLetterContent || row.jobCoverLetter)) persona.coverLetter = row.coverLetterContent ?? row.jobCoverLetter ?? ""
  return { applyUrl: safeApplyUrl(row.jobUrl), jobTitle: (row.jobTitle || "Application").slice(0, 256),
    jobCompany: (row.jobCompany || "Company").slice(0, 256), jobKeywords: (row.jobKeywords ?? "").slice(0, 8000),
    jobDescription: (row.jobDescription ?? "").slice(0, 20_000), persona, resumeContent, confirmedAnswers: parseAnswers(row.confirmedAnswers) }
}

export function urlPattern(value: string): string {
  const segments = new URL(value).pathname.replace(/^\/+/, "").split("/")
  return `${segments.slice(0, 2).join("/")}/`
}

export function isAllowedDestination(raw: string, flow: FlowType, approved: string): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== "https:" || url.username || url.password) return false
    const host = url.hostname.toLowerCase()
    if (flow === "greenhouse") return host === "boards.greenhouse.io" || host.endsWith(".greenhouse.io")
    if (flow === "lever") return ["jobs.lever.co", "jobs.eu.lever.co", "app.lever.co"].includes(host)
    if (flow === "workday") return host.endsWith(".myworkdayjobs.com")
    if (flow === "smartrecruiters") return ["jobs.smartrecruiters.com", "careers.smartrecruiters.com"].includes(host)
    if (flow === "personio") return host.endsWith(".jobs.personio.com")
    return url.origin === new URL(approved).origin
  } catch { return false }
}

function parseResumeContent(value: unknown): ResumeContent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("resume_invalid")
  return value as ResumeContent
}
function parseAnswers(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
    Boolean(entry[0].trim()) && typeof entry[1] === "string" && Boolean(entry[1].trim())))
}
function safeApplyUrl(value: string | null): string {
  if (!value || value.length > 2048) throw new Error("apply_url_invalid")
  const url = new URL(value)
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("apply_url_invalid")
  return url.toString()
}

function objectiveSourceMarker(value: unknown): boolean {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false
    const envelope = Object.getOwnPropertyDescriptor(value, "reviewedApplicationMaterialSource")
    const marker = envelope && Object.hasOwn(envelope, "value") ? envelope.value : undefined
    if (!marker || typeof marker !== "object" || Array.isArray(marker)) return false
    const schema = Object.getOwnPropertyDescriptor(marker, "schemaVersion")
    return !!schema && Object.hasOwn(schema, "value") && schema.value === OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA
  } catch { return false }
}
