import type pg from "pg"
import { lockTaskGraphScope } from "./task-graph-pg-state.js"
import { readNativeVerificationControlTasks } from "./native-verification-pg-request.js"
import { readCurrentSponsorshipReviewWithClient } from "./sponsorship-review-current-reader.js"
import { resolveRootTaskSponsorshipTargetCountry } from "../context/root-task-objective.js"
import type { TaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { parseSponsorshipFinalAnswerBinding, SPONSORSHIP_FINAL_ANSWER_SCHEMA, type SponsorshipFinalAnswerBinding,
  type SponsorshipFinalAnswerOutcome } from "./sponsorship-final-answer-contract.js"

type Pool = Pick<pg.Pool, "connect">
type Queryable = Pick<pg.PoolClient, "query">
type Row = Record<string, unknown>
const MAX_FINAL_REVIEWED_JOBS = 8

function row(value: unknown): Row | undefined {
  const parsed = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown } catch { return undefined } })() : value
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Row : undefined
}

function currentScoutMember(binding: TaskGraphFinalSummaryBinding, taskId: string): boolean {
  return binding.members?.some(member => member.taskId === taskId && member.kind === "business"
    && member.role === "scout" && member.taskType === "job_discovery" && member.taskStatus === "completed") === true
}

function summaryContainsJob(binding: TaskGraphFinalSummaryBinding, taskId: string, jobId: string): boolean {
  return binding.summary.discoveredJobs.some(item => item.jobId === jobId && item.taskIds.includes(taskId))
}

function outcome(entry: Awaited<ReturnType<typeof readCurrentSponsorshipReviewWithClient>>): SponsorshipFinalAnswerOutcome | undefined {
  if (!entry || !entry.reviewBindingDigest || !entry.reviewerTaskId || !Number.isSafeInteger(entry.reviewerAttempt)) return undefined
  const observation = entry.observation
  if (observation.status === "explicit") return {
    jobId: entry.jobId, role: observation.sourceContext.role, status: "explicit", polarity: observation.claim.polarity,
    reviewerTaskId: entry.reviewerTaskId, reviewerAttempt: entry.reviewerAttempt, reviewBindingDigest: entry.reviewBindingDigest,
  }
  if (observation.status === "inconclusive") return {
    jobId: entry.jobId, role: observation.sourceContext.role, status: "inconclusive",
    reviewerTaskId: entry.reviewerTaskId, reviewerAttempt: entry.reviewerAttempt, reviewBindingDigest: entry.reviewBindingDigest,
  }
  return undefined
}

/** Locks current Root/Turn/Step, current graph source members, Reviewer attempt, and live Job material. */
export async function readSponsorshipFinalAnswerWithClient(client: Queryable, input: Readonly<{
  scope: TaskGraphExecutionScope
  rootAttemptCount: number
  targetCountryCode: string
  graphBinding: TaskGraphFinalSummaryBinding
  expectedStepStatus: "streaming" | "completed"
}>): Promise<SponsorshipFinalAnswerBinding | undefined> {
  try {
    const { scope } = input
    if (scope.parentTaskId !== scope.rootTaskId || input.graphBinding.rootTaskId !== scope.rootTaskId
      || !Number.isSafeInteger(input.rootAttemptCount) || input.rootAttemptCount < 1) return undefined
    await client.query("SELECT set_config('app.user_id', $1, true)", [scope.userId])
    const scopeFence = input.expectedStepStatus === "completed"
      ? (({ stepId: _stepId, ...readScope }) => readScope)(scope)
      : scope
    await lockTaskGraphScope(client, scopeFence)
    const step = await client.query(`SELECT step."ordinal", step."attempt", step."status", step."taskId"
      FROM "agent_steps" AS step JOIN "agent_turns" AS turn ON turn."id" = step."turnId" AND turn."sessionId" = step."sessionId"
      JOIN "agent_sessions" AS session ON session."id" = step."sessionId"
      WHERE step."id" = $1 AND step."sessionId" = $2 AND step."turnId" = $3 AND step."taskId" = $4
        AND step."status" = $8 AND turn."rootTaskId" = $4 AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6
        AND turn."userId" = $7 AND session."userId" = $7 FOR UPDATE OF step`,
    [scope.stepId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion,
      scope.userId, input.expectedStepStatus])
    const stepRow = step.rows[0] as Row | undefined
    if (step.rows.length !== 1 || stepRow?.taskId !== scope.rootTaskId || stepRow.status !== input.expectedStepStatus
      || !Number.isSafeInteger(stepRow.ordinal) || Number(stepRow.ordinal) < 1 || !Number.isSafeInteger(stepRow.attempt) || Number(stepRow.attempt) < 1
      || Number(scope.parentAttemptCount) !== input.rootAttemptCount) return undefined
    const turn = await client.query(`SELECT turn."input" FROM "agent_turns" AS turn
      JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
      WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND turn."rootTaskId" = $4
        AND turn."leaseOwnerId" = $5 AND turn."leaseVersion" = $6 AND session."userId" = $3 FOR SHARE OF turn`,
    [scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId, scope.turnLeaseOwner, scope.turnLeaseVersion])
    const country = turn.rows.length === 1 ? resolveRootTaskSponsorshipTargetCountry(row(turn.rows[0])?.input) : { status: "invalid" as const }
    if (country.status !== "valid" || country.sponsorshipTargetCountry.countryCode !== input.targetCountryCode) return undefined

    const controls = await readNativeVerificationControlTasks(client, scope)
    const exactControls = controls.filter(task => task.control.target.kind === "sponsorship_source"
      && task.control.target.rootAttemptCount === input.rootAttemptCount
      && currentScoutMember(input.graphBinding, task.control.target.scoutTaskId))
    if (exactControls.length > MAX_FINAL_REVIEWED_JOBS) return undefined
    const seenJobs = new Set<string>(), seenReviewers = new Set<string>(), outcomes: SponsorshipFinalAnswerOutcome[] = []
    for (const control of exactControls) {
      const target = control.control.target
      if (target.kind !== "sponsorship_source" || target.targetCountryCode !== input.targetCountryCode
        || !summaryContainsJob(input.graphBinding, target.scoutTaskId, target.jobId)
        || control.status !== "completed" || control.failureReason !== null || control.interruptRequestedAt !== null
        || seenJobs.has(target.jobId) || seenReviewers.has(control.taskId)) return undefined
      const current = await readCurrentSponsorshipReviewWithClient(client, { scope, reviewerTaskId: control.taskId,
        rootAttemptCount: input.rootAttemptCount, targetCountryCode: input.targetCountryCode })
      const parsed = outcome(current)
      if (!parsed || parsed.jobId !== target.jobId || parsed.reviewerTaskId !== control.taskId) return undefined
      seenJobs.add(parsed.jobId); seenReviewers.add(parsed.reviewerTaskId); outcomes.push(parsed)
    }
    outcomes.sort((left, right) => left.jobId.localeCompare(right.jobId))
    return parseSponsorshipFinalAnswerBinding({ schemaVersion: SPONSORSHIP_FINAL_ANSWER_SCHEMA, rootTaskId: scope.rootTaskId,
      rootAttemptCount: input.rootAttemptCount, candidateStepId: scope.stepId,
      targetCountryCode: input.targetCountryCode, outcomes }) ?? undefined
  } catch { return undefined }
}

/** Candidate read runs in its own owner-scoped transaction; terminal re-read uses the caller's transaction. */
export async function readSponsorshipFinalAnswerWithPool(pool: Pool, input: Parameters<typeof readSponsorshipFinalAnswerWithClient>[1]): Promise<SponsorshipFinalAnswerBinding | undefined> {
  let client: pg.PoolClient
  try { client = await pool.connect() } catch { return undefined }
  let open = false
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ"); open = true
    const result = await readSponsorshipFinalAnswerWithClient(client, input)
    if (!result) { await client.query("ROLLBACK"); open = false; return undefined }
    await client.query("COMMIT"); open = false; return result
  } catch {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    return undefined
  } finally { client.release() }
}
