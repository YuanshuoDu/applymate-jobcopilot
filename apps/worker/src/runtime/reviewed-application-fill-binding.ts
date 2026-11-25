import { randomUUID } from "node:crypto"
import type { Pool, PoolClient } from "pg"
import { OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, canonicalJson,
  parseObjectiveReviewedFillSource, type ObjectiveReviewedFillSource, type ObjectiveApplicationResumeWitness } from "@jobcopilot/shared"
import { acquireSourceMaterialFence } from "../db/source-material-fence.js"
import type { SelectedJobReviewedArtifact } from "./selected-job-reviewed-artifact-read.js"
import type { SubagentLease } from "./subagents/types.js"
import type { ObjectiveReviewedApplicationFillEvidence } from "./objective-reviewed-application-fill-read.js"

const SELECTOR_SCHEMA = "agent-harness.v2.selected-job-reviewed-fill-source.v1"
const BINDING_SCHEMA = "agent-harness.v2.reviewed-application-fill-browser-start.v1"
export const OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA = "agent-harness.v2.objective-reviewed-fill-browser-start.v1" as const
const BINDING_BODY = "Reviewed application material bound to browser-start attempt."

export type ReviewedApplicationFillSelector = Readonly<{ kind: "absent" | "invalid" }>
  | Readonly<{ kind: "selected"; sourceTurnId: string }>
  | Readonly<{ kind: "objective"; source: ObjectiveReviewedFillSource }>
export type BrowserStartClaim = Readonly<{ status: "claimed"; reviewedMaterial?: SelectedJobReviewedArtifact;
  objectiveEvidence?: ObjectiveReviewedApplicationFillEvidence }>
  | Readonly<{ status: "already_started" | "stale" | "conflict" }>

type Queryable = Pick<PoolClient, "query">
type LockedTurn = { status: string; input: unknown }
type LockedApplicationTask = { id: string; jobId: string; status: string; checkpoint: string | null }

/** Parse the exact private marker used by template preparation and browser start. */
export function reviewedApplicationFillSelector(value: unknown): ReviewedApplicationFillSelector {
  const input = plainRecord(value)
  if (!input) return { kind: "invalid" }
  if (!Object.hasOwn(input, "reviewedApplicationMaterialSource")) return { kind: "absent" }
  const objective = parseObjectiveReviewedFillSource(value)
  if (objective) return { kind: "objective", source: objective }
  const source = plainRecord(input.reviewedApplicationMaterialSource)
  if (source?.schemaVersion === OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA) return { kind: "invalid" }
  if (!source || Object.keys(source).sort().join(",") !== "schemaVersion,sourceTurnId"
    || source.schemaVersion !== SELECTOR_SCHEMA || !text(source.sourceTurnId, 256)) return { kind: "invalid" }
  return { kind: "selected", sourceTurnId: source.sourceTurnId }
}

export function sameReviewedApplicationFillSelector(left: ReviewedApplicationFillSelector, right: ReviewedApplicationFillSelector): boolean {
  if (left.kind !== right.kind) return false
  switch (left.kind) {
    case "absent": case "invalid": return true
    case "selected": return right.kind === "selected" && left.sourceTurnId === right.sourceTurnId
    case "objective": return right.kind === "objective" && left.source.approvalId === right.source.approvalId
      && left.source.reviewTurnId === right.source.reviewTurnId && left.source.materialProofHash === right.source.materialProofHash
  }
}

/** Fence reviewed source writes, re-read the selector/proof, and atomically claim browser start. */
export async function claimApplicationFillBrowserStart(input: {
  pool: Pool
  lease: SubagentLease
  expectedSelector: ReviewedApplicationFillSelector
  expectedObjectiveResumeWitness?: ObjectiveApplicationResumeWitness
  applicationTaskId: string
  jobId: string
}): Promise<BrowserStartClaim> {
  const { lease, expectedSelector } = input
  const fillTurnId = lease.turnId
  if (expectedSelector.kind === "invalid" || !text(fillTurnId, 256) || !text(input.applicationTaskId, 256) || !text(input.jobId, 256)) return { status: "conflict" }
  const client = await input.pool.connect()
  let open = false
  try {
    await client.query("BEGIN")
    open = true
    await client.query("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    if (expectedSelector.kind === "selected" || expectedSelector.kind === "objective") await acquireSourceMaterialFence(client, [lease.userId])

    const session = await client.query<{ status: string }>(
      'SELECT status FROM agent_sessions WHERE id=$1 AND "userId"=$2 FOR UPDATE', [lease.sessionId, lease.userId])
    if (!session.rows[0] || !["running", "waiting_for_user"].includes(session.rows[0].status)) return await txResult(client, "ROLLBACK", { status: "stale" })

    const turn = await client.query<LockedTurn>(
      'SELECT status, "input" FROM agent_turns WHERE id=$1 AND "sessionId"=$2 AND "userId"=$3 FOR UPDATE', [lease.turnId, lease.sessionId, lease.userId])
    if (!turn.rows[0] || !["in_progress", "waiting_for_user", "waiting_for_dependency"].includes(turn.rows[0].status)) return await txResult(client, "ROLLBACK", { status: "stale" })

    const task = await client.query<{ id: string }>(
      `SELECT sub."id" FROM sub_agent_tasks sub
       JOIN agent_sessions s ON s."id"=sub."sessionId" AND s."userId"=$4
       JOIN agent_turns t ON t."id"=sub."turnId" AND t."sessionId"=sub."sessionId" AND t."userId"=$4
       WHERE sub."id"=$1 AND sub."sessionId"=$2 AND sub."turnId"=$3 AND sub."role"=$5 AND sub."taskType"=$6
         AND sub.status='running' AND sub."leaseOwner"=$7 AND sub."attemptCount"=$8
         AND date_trunc('milliseconds',sub."leaseExpiresAt")=date_trunc('milliseconds',$9::timestamptz)
         AND sub."leaseExpiresAt">clock_timestamp() AND sub."interruptRequestedAt" IS NULL FOR UPDATE OF sub`,
      [lease.id, lease.sessionId, lease.turnId, lease.userId, lease.role, lease.taskType, lease.ownerId, lease.attemptCount, lease.leaseExpiresAt])
    if (task.rowCount !== 1) return await txResult(client, "ROLLBACK", { status: "stale" })

    const app = await client.query<LockedApplicationTask>(
      `SELECT "id", "jobId", "status", "checkpoint" FROM application_tasks
       WHERE "id"=$1 AND "userId"=$2 AND "jobId"=$3 AND "sessionId"=$4 AND "fillTurnId"=$5
         AND "fillTurnSessionId"=$4 AND "fillTurnUserId"=$2 FOR UPDATE`,
      [input.applicationTaskId, lease.userId, input.jobId, lease.sessionId, lease.turnId])
    if (app.rows.length !== 1) return await txResult(client, "ROLLBACK", { status: "conflict" })
    if (app.rows[0]!.status !== "filling") return await txResult(client, "ROLLBACK", { status: "conflict" })
    if (app.rows[0]!.checkpoint === "browser_active") return await txResult(client, "COMMIT", { status: "already_started" })
    if (app.rows[0]!.checkpoint !== "taskgraph_fill_queued") return await txResult(client, "ROLLBACK", { status: "conflict" })

    const persistedSelector = reviewedApplicationFillSelector(turn.rows[0]!.input)
    if (!sameReviewedApplicationFillSelector(expectedSelector, persistedSelector)) return await txResult(client, "ROLLBACK", { status: "conflict" })
    const prior = await client.query<{ id: string }>(
      `SELECT "id" FROM "application_task_events" WHERE "taskId"=$1
       AND "type"='reviewed_application_fill_browser_started' AND "data"->>'fillTurnId'=$2 LIMIT 2`, [app.rows[0]!.id, lease.turnId])
    if (prior.rows.length !== 0) return await txResult(client, "ROLLBACK", { status: "conflict" })
    let objectiveEvidence: ObjectiveReviewedApplicationFillEvidence | undefined
    if (expectedSelector.kind === "objective") {
      const { readObjectiveReviewedApplicationFillSource } = await import("./objective-reviewed-application-fill-read.js")
      objectiveEvidence = await readObjectiveReviewedApplicationFillSource(client, {
        userId: lease.userId, sessionId: lease.sessionId, fillTurnId, applicationTaskId: input.applicationTaskId,
        jobId: input.jobId, turnInput: turn.rows[0]!.input, phase: "browser_start" })
    }
    const reviewedMaterial = expectedSelector.kind === "selected"
      ? await readCurrentReviewedMaterial(client, lease, input.jobId, expectedSelector.sourceTurnId)
      : objectiveEvidence?.reviewedArtifact
    if (expectedSelector.kind === "selected" && !reviewedMaterial || expectedSelector.kind === "objective"
      && (!objectiveEvidence || !input.expectedObjectiveResumeWitness
        || canonicalJson(objectiveEvidence.resumeWitness) !== canonicalJson(input.expectedObjectiveResumeWitness))) {
      return await txResult(client, "ROLLBACK", { status: "conflict" })
    }

    if (reviewedMaterial) await insertBindingEvent(client, lease, app.rows[0]!, reviewedMaterial,
      expectedSelector.kind === "objective" ? expectedSelector.source : undefined)
    const updated = await client.query(
      `UPDATE application_tasks AS app SET "checkpoint"='browser_active', "updatedAt"=NOW()
       WHERE app."id"=$1 AND app."userId"=$2 AND app."jobId"=$3 AND app."sessionId"=$4 AND app."fillTurnId"=$5
         AND app."fillTurnSessionId"=$4 AND app."fillTurnUserId"=$2 AND app."status"='filling'
         AND app."checkpoint"='taskgraph_fill_queued' AND EXISTS (
           SELECT 1 FROM sub_agent_tasks sub
           JOIN agent_sessions s ON s."id"=sub."sessionId" AND s."userId"=$2
           JOIN agent_turns t ON t."id"=sub."turnId" AND t."sessionId"=sub."sessionId" AND t."userId"=$2
           WHERE sub."id"=$6 AND sub."sessionId"=$4 AND sub."turnId"=$5 AND sub."role"=$7
             AND sub."taskType"=$8 AND sub.status='running' AND sub."leaseOwner"=$9 AND sub."attemptCount"=$10
             AND date_trunc('milliseconds',sub."leaseExpiresAt")=date_trunc('milliseconds',$11::timestamptz)
             AND sub."leaseExpiresAt">clock_timestamp() AND sub."interruptRequestedAt" IS NULL
         ) RETURNING app."id"`,
      [input.applicationTaskId, lease.userId, input.jobId, lease.sessionId, lease.turnId, lease.id, lease.role, lease.taskType, lease.ownerId, lease.attemptCount, lease.leaseExpiresAt])
    if (updated.rowCount !== 1) return await txResult(client, "ROLLBACK", { status: "conflict" })
    await client.query("COMMIT")
    open = false
    return { status: "claimed", ...(reviewedMaterial ? { reviewedMaterial } : {}), ...(objectiveEvidence ? { objectiveEvidence } : {}) }
  } catch (error) {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function readCurrentReviewedMaterial(client: Queryable, lease: SubagentLease, jobId: string, sourceTurnId: string): Promise<SelectedJobReviewedArtifact | null> {
  const { readSelectedJobReviewedArtifactWithClient } = await import("./selected-job-reviewed-artifact-read.js")
  const proof = await readSelectedJobReviewedArtifactWithClient(client, { userId: lease.userId, sessionId: lease.sessionId, jobId, sourceTurnId })
  return proof?.jobId === jobId && proof.sourceTurnId === sourceTurnId ? proof : null
}

async function insertBindingEvent(client: Queryable, lease: SubagentLease, app: LockedApplicationTask, proof: SelectedJobReviewedArtifact,
  objectiveSource?: ObjectiveReviewedFillSource): Promise<void> {
  const data = {
    schemaVersion: objectiveSource ? OBJECTIVE_REVIEWED_FILL_BROWSER_START_SCHEMA : BINDING_SCHEMA,
    ...(objectiveSource ? { objectiveSource } : {}), userId: lease.userId, sessionId: lease.sessionId, fillTurnId: lease.turnId,
    jobId: app.jobId, applicationTaskId: app.id, fillerTaskId: lease.id, attemptCount: lease.attemptCount,
    leaseOwner: lease.ownerId, leaseExpiresAt: lease.leaseExpiresAt.toISOString(), sourceTurnId: proof.sourceTurnId,
    rootTaskId: proof.rootTaskId, graphRevision: proof.graphRevision, writerTaskId: proof.writerTaskId,
    reviewerTaskId: proof.reviewerTaskId, reviewerToolCallId: proof.reviewerToolCallId, reviewHash: proof.reviewHash,
    artifactId: proof.artifactId, version: proof.version, contentHash: proof.contentHash, sourceDigest: proof.sourceDigest,
  }
  await client.query(
    `INSERT INTO "application_task_events" ("id", "taskId", "type", "actor", "body", "data", "createdAt")
     VALUES ($1, $2, 'reviewed_application_fill_browser_started', 'worker', $3, $4::jsonb, NOW())`,
    [randomUUID(), app.id, BINDING_BODY, JSON.stringify(data)])
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null
  try { const prototype = Object.getPrototypeOf(parsed); return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(parsed).length === 0 ? parsed as Record<string, unknown> : null } catch { return null }
}
function text(value: unknown, limit: number): value is string { return typeof value === "string" && value.trim().length > 0 && value.length <= limit }
async function txResult<T extends BrowserStartClaim>(client: PoolClient, command: "COMMIT" | "ROLLBACK", result: T): Promise<T> { await client.query(command); return result }
