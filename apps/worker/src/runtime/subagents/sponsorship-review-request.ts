import type pg from "pg"
import { resolveRootTaskSponsorshipTargetCountry } from "../context/root-task-objective.js"
import type { ToolExecutionContext } from "../tools/types.js"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { lockTaskGraphScope } from "./task-graph-pg-state.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { readSponsorshipTaskObservationsWithClient, type SponsorshipObservationTask } from "./sponsorship-observation-binder-core.js"
import { selectedSponsorshipWaitTargets } from "./sponsorship-private-context-wait.js"
import { buildSponsorshipReviewPacket } from "./sponsorship-review-packet.js"
import { ensureNativeVerificationControl } from "./native-verification-pg-request.js"
import type { NativeCoordinationRuntimeOptions } from "../tools/coordination-types.js"

type Row = Record<string, unknown>
type Pool = Pick<pg.Pool, "connect">
const MAX_SPONSORSHIP_REVIEWS_PER_TURN = 8

function record(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try { const prototype = Object.getPrototypeOf(parsed); return prototype === Object.prototype || prototype === null ? parsed as Row : undefined } catch { return undefined }
}
function validId(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value }

/** Creates one Root-only no-tool reviewer from a current, exact Scout wait and owner-scoped source receipt. */
export async function requestSponsorshipReview(pool: Pool, native: NativeCoordinationRuntimeOptions,
  context: ToolExecutionContext, jobId: string): Promise<Readonly<{ taskId: string; status: string }>> {
  const rootAttempt = native.parentAttemptCount()
  if (!native.enabled || context.actorRole !== "orchestrator" || !validId(context.taskId) || context.taskId !== context.rootTaskId
    || !validId(context.rootTaskId) || !validId(context.sessionId) || !validId(context.turnId) || !validId(context.stepId)
    || !validId(context.scope.userId) || !validId(jobId) || !Number.isSafeInteger(rootAttempt) || typeof rootAttempt !== "number" || rootAttempt < 1) {
    throw new Error("sponsorship_review_scope_unavailable")
  }
  const scope: TaskGraphExecutionScope = {
    userId: context.scope.userId, sessionId: context.sessionId, turnId: context.turnId,
    rootTaskId: context.rootTaskId, parentTaskId: context.rootTaskId, stepId: context.stepId,
    turnLeaseOwner: native.turnLeaseOwner, turnLeaseVersion: native.turnLeaseVersion,
    parentLeaseOwner: native.parentLeaseOwner, parentAttemptCount: rootAttempt,
  }
  let client: pg.PoolClient
  try { client = await pool.connect() } catch { throw new Error("sponsorship_review_unavailable") }
  let transactionOpen = false
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ")
    transactionOpen = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [scope.userId])
    const parent = await lockTaskGraphScope(client, scope, true)
    if (parent.id !== scope.rootTaskId || parent.parentTaskId !== null) throw new Error("sponsorship_review_scope_unavailable")
    const turn = await client.query(`SELECT turn."input" FROM "agent_turns" AS turn
      JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
      WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
        AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND session."userId" = $3 FOR SHARE OF turn`,
    [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion])
    const turnInput = record(turn.rows[0])?.input
    const country = resolveRootTaskSponsorshipTargetCountry(turnInput)
    if (turn.rows.length !== 1 || country.status !== "valid") throw new Error("sponsorship_review_country_unavailable")
    const step = await client.query(`SELECT "ordinal", "attempt", "status", "taskId" FROM "agent_steps"
      WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3 AND "taskId" = $4 AND "status" = 'streaming' FOR UPDATE`,
    [scope.stepId, scope.sessionId, scope.turnId, scope.rootTaskId])
    const stepRow = record(step.rows[0]), ordinal = Number(stepRow?.ordinal), attempt = Number(stepRow?.attempt)
    if (step.rows.length !== 1 || stepRow?.taskId !== scope.rootTaskId || stepRow.status !== "streaming"
      || !Number.isSafeInteger(ordinal) || ordinal < 1 || !Number.isSafeInteger(attempt) || attempt < 1) {
      throw new Error("sponsorship_review_step_unavailable")
    }
    const receipts = await loadTaskGraphVerificationReceipts(client, {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.rootTaskId, taskId: scope.rootTaskId, attemptCount: attempt,
    })
    const matched = await selectedSponsorshipWaitTargets(client, receipts, {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      rootAttemptCount: scope.parentAttemptCount, turnLeaseOwner: scope.turnLeaseOwner,
      turnLeaseVersion: scope.turnLeaseVersion, attempt, previousOrdinal: ordinal - 1,
    }, [], { allowDurableConsumedResultWithoutProjection: true })
    if (!matched || matched.length !== 1 || matched[0]?.role !== "scout" || matched[0]?.status !== "completed") {
      throw new Error("sponsorship_review_source_unavailable")
    }
    const sourceTask = await client.query(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
        task."role", task."taskType", task."status", task."attemptCount", task."context", task."result"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      WHERE task."id" = $1 AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4 AND task."parentTaskId" = $4
        AND task."role" = 'scout' AND task."taskType" = 'job_discovery' AND task."status" = 'completed'
        AND session."userId" = $5 AND turn."userId" = $5 AND turn."rootTaskId" = $4
      FOR SHARE OF task`, [matched[0].taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
    const scout = record(sourceTask.rows[0]) as unknown as SponsorshipObservationTask | undefined
    if (sourceTask.rows.length !== 1 || !scout || scout.attemptCount < 1 || scout.id !== matched[0].taskId) {
      throw new Error("sponsorship_review_source_unavailable")
    }
    const jobLock = await client.query(`SELECT "id" FROM "Job" WHERE "id" = $1 AND "userId" = $2 FOR SHARE`, [jobId, scope.userId])
    if (jobLock.rows.length !== 1) throw new Error("sponsorship_review_source_unavailable")
    const candidates = await readSponsorshipTaskObservationsWithClient(client, scout, { jobIds: [jobId] })
    const selected = candidates?.length === 1 ? candidates[0] : undefined
    if (!selected || selected.jobId !== jobId || selected.observation.status !== "inconclusive" || !selected.source) {
      throw new Error("sponsorship_review_source_unavailable")
    }
    const packet = buildSponsorshipReviewPacket({ userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, rootAttemptCount: scope.parentAttemptCount, scoutTaskId: scout.id,
      scoutAttempt: scout.attemptCount, scoutResultDigest: selected.source.scoutResultDigest, jobId,
      sourceReceiptDigest: selected.source.sourceReceiptDigest, materialDigest: selected.source.materialDigest,
      targetCountryCode: country.sponsorshipTargetCountry.countryCode, job: selected.source.job })
    if (!packet) throw new Error("sponsorship_review_source_unavailable")
    const control = await ensureNativeVerificationControl(client, { scope, parent, target: packet.target, content: packet.content,
      maxSponsorshipControls: MAX_SPONSORSHIP_REVIEWS_PER_TURN })
    if (!control) throw new Error("sponsorship_review_capacity_unavailable")
    await client.query("COMMIT")
    transactionOpen = false
    return { taskId: control.taskId, status: control.status }
  } catch (error) {
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
    if (error instanceof Error && /^sponsorship_review_[a-z_]+$/.test(error.message)) throw error
    throw new Error("sponsorship_review_unavailable")
  } finally { client.release() }
}
