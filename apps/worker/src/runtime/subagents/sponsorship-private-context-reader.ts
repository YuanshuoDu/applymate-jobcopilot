import type pg from "pg"
import type { SponsorshipObservationModelFrame } from "./sponsorship-observation-contract.js"
import { toSponsorshipObservationModelFrame } from "./sponsorship-observation-contract.js"
import { readSponsorshipTaskObservationsWithClient, sponsorshipCandidateJobIds, type SponsorshipObservationTask } from "./sponsorship-observation-binder-core.js"
import { loadTaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import { lockTaskGraphScope } from "./task-graph-pg-state.js"
import { selectedSponsorshipWaitTargets } from "./sponsorship-private-context-wait.js"
import { resolveRootTaskSponsorshipTargetCountry } from "../context/root-task-objective.js"
import { readCurrentSponsorshipReviewWithClient, type SponsorshipCurrentReviewReadDiagnosticStage } from "./sponsorship-review-current-reader.js"

type Row = Record<string, unknown>
type Pool = Pick<pg.Pool, "connect">
export type SponsorshipPrivateContextFence = Readonly<{
  userId: string
  sessionId: string
  turnId: string
  taskId: string
  rootTaskId: string
  rootAttemptCount: number
  turnLeaseOwner: string
  turnLeaseVersion: number
  stepId: string
}>
export type PrivateSponsorshipContextEntry = Readonly<{ jobId: string; observation: SponsorshipObservationModelFrame }>
export type SponsorshipPrivateContextReadDiagnosticStage =
  | "scope_validated" | "scope_rejected" | "connection_unavailable"
  | "step_bound" | "step_unavailable" | "adjacent_wait_found" | "adjacent_wait_missing"
  | "wait_binding_started" | "wait_targets_bound" | "wait_targets_unavailable"
  | "auditor_target_bound" | "auditor_target_unavailable" | "country_bound" | "country_unavailable"
  | "review_source_readback_started" | "review_source_readback_bound" | "review_source_readback_missing"
  | "source_tasks_bound" | "source_tasks_unavailable" | "source_targets_unavailable"
  | "source_observations_bound" | "source_observations_unavailable" | "read_complete" | "read_failed"
  | SponsorshipCurrentReviewReadDiagnosticStage
const MAX_WAIT_JOBS = 50

function reportDiagnosticStage(
  report: ((stage: SponsorshipPrivateContextReadDiagnosticStage) => void) | undefined,
  stage: SponsorshipPrivateContextReadDiagnosticStage,
): void {
  if (process.env.NODE_ENV !== "test" || typeof report !== "function") return
  try { report(stage) } catch { /* Diagnostics must never change the read result. */ }
}

function row(value: unknown): Row | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try { const prototype = Object.getPrototypeOf(value); return prototype === Object.prototype || prototype === null ? value as Row : undefined } catch { return undefined }
}
function text(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}
function exact(value: unknown, keys: readonly string[]): Row | undefined {
  const parsed = row(value)
  if (!parsed) return undefined
  const actual = Reflect.ownKeys(parsed)
  if (actual.length !== keys.length || actual.some(key => typeof key !== "string" || !keys.includes(key))) return undefined
  return keys.every(key => Object.hasOwn(parsed, key)) ? parsed : undefined
}
function validFence(input: SponsorshipPrivateContextFence): boolean {
  return [input.userId, input.sessionId, input.turnId, input.taskId, input.rootTaskId, input.turnLeaseOwner, input.stepId].every(value => text(value))
    && input.taskId === input.rootTaskId && Number.isSafeInteger(input.rootAttemptCount) && input.rootAttemptCount > 0
    && Number.isSafeInteger(input.turnLeaseVersion) && input.turnLeaseVersion > 0
}
/** Reads only the immediately preceding completed Root wait request, then rebinds source in this fenced transaction. */
export async function readPrivateSponsorshipContext(pool: Pool, input: SponsorshipPrivateContextFence,
  waitProjections: readonly Readonly<{ id: string; content: unknown }>[] = [],
  reportStage?: (stage: SponsorshipPrivateContextReadDiagnosticStage) => void): Promise<readonly PrivateSponsorshipContextEntry[] | undefined> {
  const diagnose = (stage: SponsorshipPrivateContextReadDiagnosticStage) => reportDiagnosticStage(reportStage, stage)
  if (!validFence(input)) { diagnose("scope_rejected"); return undefined }
  diagnose("scope_validated")
  let client: pg.PoolClient
  try { client = await pool.connect() } catch { diagnose("connection_unavailable"); return undefined }
  let transactionOpen = false
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); transactionOpen = true
    await client.query("SELECT set_config('app.user_id', $1, true)", [input.userId])
    const scope = { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, rootTaskId: input.rootTaskId,
      parentTaskId: input.rootTaskId, turnLeaseOwner: input.turnLeaseOwner, turnLeaseVersion: input.turnLeaseVersion,
      parentLeaseOwner: input.turnLeaseOwner, parentAttemptCount: input.rootAttemptCount, stepId: input.stepId }
    await lockTaskGraphScope(client, scope)
    const stepResult = await client.query(`SELECT step."ordinal", step."attempt", step."taskId", step."status"
      FROM "agent_steps" AS step JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
      JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
      WHERE step."id" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4
        AND step."status" = 'streaming' AND turn."userId" = $5 AND turn."rootTaskId" = $4
        AND turn."leaseOwnerId" = $6 AND turn."leaseVersion" = $7 AND session."userId" = $5 FOR UPDATE OF step`,
    [input.stepId, input.sessionId, input.turnId, input.rootTaskId, input.userId, input.turnLeaseOwner, input.turnLeaseVersion])
    const step = row(stepResult.rows[0]), ordinal = Number(step?.ordinal), attempt = Number(step?.attempt)
    if (stepResult.rows.length !== 1 || step?.taskId !== input.rootTaskId || step.status !== "streaming"
      || !Number.isSafeInteger(ordinal) || ordinal < 1 || !Number.isSafeInteger(attempt) || attempt < 1) {
      diagnose("step_unavailable")
      await client.query("COMMIT"); transactionOpen = false; return undefined
    }
    diagnose("step_bound")
    const targetExists = await client.query(`SELECT 1 FROM "agent_items" AS item
      JOIN "agent_steps" AS step ON step."id" = item."stepId" AND step."sessionId" = item."sessionId" AND step."turnId" = item."turnId" AND step."taskId" = item."taskId"
      JOIN "sub_agent_tasks" AS task ON task."id" = item."taskId" AND task."sessionId" = item."sessionId" AND task."turnId" = item."turnId"
      JOIN "agent_sessions" AS session ON session."id" = item."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = item."turnId" AND turn."sessionId" = item."sessionId"
      WHERE item."taskId" = $1 AND item."sessionId" = $2 AND item."turnId" = $3 AND item."type" = 'tool_call'
        AND item."content"->>'toolName' IN ('agent.wait', 'wait_subagents') AND step."ordinal" = $4 AND step."attempt" = $5
        AND task."rootTaskId" = $1 AND task."parentTaskId" IS NULL AND session."userId" = $6 AND turn."userId" = $6 AND turn."rootTaskId" = $1 LIMIT 1`,
    [input.rootTaskId, input.sessionId, input.turnId, ordinal - 1, attempt, input.userId])
    if (targetExists.rows.length === 0) { diagnose("adjacent_wait_missing"); await client.query("COMMIT"); transactionOpen = false; return undefined }
    diagnose("adjacent_wait_found")
    const receipts = await loadTaskGraphVerificationReceipts(client, { userId: input.userId, sessionId: input.sessionId, turnId: input.turnId,
      rootTaskId: input.rootTaskId, parentTaskId: input.rootTaskId, taskId: input.rootTaskId, attemptCount: attempt })
    diagnose("wait_binding_started")
    const matchedTargets = await selectedSponsorshipWaitTargets(client, receipts, {
      userId: input.userId, sessionId: input.sessionId, turnId: input.turnId, rootTaskId: input.rootTaskId,
      rootAttemptCount: input.rootAttemptCount, turnLeaseOwner: input.turnLeaseOwner, turnLeaseVersion: input.turnLeaseVersion,
      attempt, previousOrdinal: ordinal - 1,
    }, waitProjections)
    if (!matchedTargets) { diagnose("wait_targets_unavailable"); await client.query("COMMIT"); transactionOpen = false; return undefined }
    diagnose("wait_targets_bound")
    if (matchedTargets.some(target => target.role === "auditor")) {
      if (matchedTargets.length !== 1 || matchedTargets[0]?.role !== "auditor" || matchedTargets[0].status !== "completed") {
        diagnose("auditor_target_unavailable")
        await client.query("COMMIT"); transactionOpen = false; return undefined
      }
      diagnose("auditor_target_bound")
      const turn = await client.query(`SELECT turn."input" FROM "agent_turns" AS turn
        JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
        WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
          AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND session."userId" = $3 FOR SHARE OF turn`,
      [input.turnId, input.sessionId, input.userId, input.rootTaskId, input.turnLeaseOwner, input.turnLeaseVersion])
      const country = resolveRootTaskSponsorshipTargetCountry(row(turn.rows[0])?.input)
      if (turn.rows.length !== 1 || country.status !== "valid") {
        diagnose("country_unavailable")
        await client.query("COMMIT"); transactionOpen = false; return undefined
      }
      diagnose("country_bound")
      diagnose("review_source_readback_started")
      const review = await readCurrentSponsorshipReviewWithClient(client, { scope: { userId: input.userId, sessionId: input.sessionId,
          turnId: input.turnId, rootTaskId: input.rootTaskId, parentTaskId: input.rootTaskId,
          turnLeaseOwner: input.turnLeaseOwner, turnLeaseVersion: input.turnLeaseVersion,
          parentLeaseOwner: input.turnLeaseOwner, parentAttemptCount: input.rootAttemptCount },
        reviewerTaskId: matchedTargets[0].taskId, rootAttemptCount: input.rootAttemptCount,
        targetCountryCode: country.sponsorshipTargetCountry.countryCode }, stage => diagnose(stage))
      if (!review) diagnose("review_source_readback_missing")
      else diagnose("review_source_readback_bound")
      await client.query("COMMIT"); transactionOpen = false
      if (review) diagnose("read_complete")
      return review ? [review] : undefined
    }
    const taskIds = matchedTargets.map(target => target.taskId)
    const children = await client.query(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId", task."rootTaskId", task."parentTaskId",
        task."role", task."taskType", task."status", task."attemptCount", task."context", task."result"
      FROM "sub_agent_tasks" AS task JOIN "agent_sessions" AS session ON session."id" = task."sessionId"
      JOIN "agent_turns" AS turn ON turn."id" = task."turnId" AND turn."sessionId" = task."sessionId"
      WHERE task."id" = ANY($1::text[]) AND task."sessionId" = $2 AND task."turnId" = $3 AND task."rootTaskId" = $4
        AND task."parentTaskId" = $4 AND session."userId" = $5 AND turn."userId" = $5 AND turn."rootTaskId" = $4
      FOR SHARE OF task`, [taskIds, input.sessionId, input.turnId, input.rootTaskId, input.userId])
    if (children.rows.length !== taskIds.length) { diagnose("source_tasks_unavailable"); await client.query("COMMIT"); transactionOpen = false; return undefined }
    const byId = new Map(children.rows.map(value => { const child = row(value); return [String(child?.id), child] as const }))
    if (byId.size !== taskIds.length || taskIds.some(id => !byId.has(id))) { diagnose("source_tasks_unavailable"); await client.query("COMMIT"); transactionOpen = false; return undefined }
    if (taskIds.some(id => {
      const child = byId.get(id)
      return !child || child.userId !== input.userId || child.sessionId !== input.sessionId || child.turnId !== input.turnId
        || child.rootTaskId !== input.rootTaskId || child.parentTaskId !== input.rootTaskId
        || child.status !== matchedTargets.find(target => target.taskId === id)?.status
        || child.role !== matchedTargets.find(target => target.taskId === id)?.role
    })) { diagnose("source_tasks_unavailable"); await client.query("COMMIT"); transactionOpen = false; return undefined }
    diagnose("source_tasks_bound")
    const eligible = taskIds.flatMap(id => {
      const child = byId.get(id)
      if (!child) return []
      const task = child as unknown as SponsorshipObservationTask
      const jobIds = sponsorshipCandidateJobIds(task)
      return jobIds?.length ? [{ task, jobIds }] : []
    })
    if (eligible.reduce((count, item) => count + item.jobIds.length, 0) > MAX_WAIT_JOBS
      || new Set(eligible.flatMap(item => item.jobIds)).size !== eligible.reduce((count, item) => count + item.jobIds.length, 0)) {
      diagnose("source_targets_unavailable")
      await client.query("COMMIT"); transactionOpen = false; return undefined
    }
    const entries: PrivateSponsorshipContextEntry[] = []
    for (const item of eligible) {
      const observations = await readSponsorshipTaskObservationsWithClient(client, item.task)
      if (!observations || observations.length !== item.jobIds.length) { diagnose("source_observations_unavailable"); await client.query("COMMIT"); transactionOpen = false; return undefined }
      for (const { jobId, observation } of observations) entries.push({ jobId, observation: toSponsorshipObservationModelFrame(observation) })
    }
    diagnose("source_observations_bound")
    await client.query("COMMIT"); transactionOpen = false
    diagnose("read_complete")
    return entries
  } catch {
    diagnose("read_failed")
    if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
    return undefined
  } finally { client.release() }
}
