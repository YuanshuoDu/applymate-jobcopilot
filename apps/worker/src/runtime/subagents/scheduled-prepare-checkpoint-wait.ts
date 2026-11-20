import { createHash } from "node:crypto"
import type pg from "pg"
import { readScheduledPipelineRecoveryStepProfile, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY } from "./scheduled-pipeline-recovery-step.js"
import { resolveSteeringAgendaStep } from "./scheduled-recovery-agenda-lineage.js"
import type { ScheduledTaskGraphContinuationReceipt } from "./scheduled-taskgraph-continuation-receipt.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import { canonicalTaskGraphJson } from "./task-graph-snapshot.js"

type Client = Pick<pg.PoolClient, "query">
type Owner = ScheduledTaskGraphContinuationReceipt["owner"]
export type ResumedPrepareWait = Readonly<{ scope: TaskGraphExecutionScope; waitId: string; prepareTaskId: string }>

/** Proves the persisted Prepare wait led to this operational recovery Step under the live root lease. */
export async function resumedPrepareWaitOwner(client: Client, prior: Owner, input: ResumedPrepareWait,
  handoffKey: string): Promise<Owner | null> {
  const { scope, waitId, prepareTaskId } = input
  if (scope.userId !== prior.userId || scope.sessionId !== prior.sessionId || scope.turnId !== prior.turnId
    || scope.rootTaskId !== prior.rootTaskId || scope.parentTaskId !== prior.rootTaskId
    || scope.parentAttemptCount !== prior.rootAttemptCount || !scope.turnLeaseOwner
    || scope.parentLeaseOwner !== scope.turnLeaseOwner || !Number.isSafeInteger(scope.turnLeaseVersion)
    || scope.turnLeaseVersion <= prior.turnLeaseVersion || !scope.stepId || !waitId || !prepareTaskId) return null
  const rows = await client.query<{
    profile: unknown; previousProfile: unknown; previousWaitId: string; previousWaitKey: string;
    previousStepId: string; previousCompletion: unknown; ordinal: number; inputCursor: string; previousInputCursor: string
  }>(`SELECT step."modelProfileSnapshot" AS "profile", previous."modelProfileSnapshot" AS "previousProfile",
      step."ordinal", step."inputThroughSequence"::text AS "inputCursor", previous."inputThroughSequence"::text AS "previousInputCursor",
      older."id" AS "previousWaitId", older."idempotencyKey" AS "previousWaitKey",
      previous."id" AS "previousStepId", completed."payload" AS "previousCompletion"
    FROM "agent_sessions" session
    JOIN "agent_turns" turn ON turn."sessionId"=session."id" AND turn."userId"=session."userId"
    JOIN "sub_agent_tasks" root ON root."id"=turn."rootTaskId" AND root."sessionId"=session."id" AND root."turnId"=turn."id"
    JOIN "agent_steps" step ON step."sessionId"=session."id" AND step."turnId"=turn."id" AND step."taskId"=root."id"
    JOIN "agent_wait_conditions" current ON current."stepId"=step."id" AND current."sessionId"=session."id"
      AND current."userId"=session."userId" AND current."turnId"=turn."id" AND current."parentTaskId"=root."id"
    JOIN "agent_steps" previous ON previous."sessionId"=session."id" AND previous."turnId"=turn."id"
      AND previous."taskId"=root."id" AND previous."attempt"=step."attempt" AND previous."ordinal"<step."ordinal"
      AND previous."id"=step."modelProfileSnapshot"->'${SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY}'->>'predecessorStepId'
    JOIN "agent_wait_conditions" older ON older."stepId"=previous."id" AND older."sessionId"=session."id"
      AND older."userId"=session."userId" AND older."turnId"=turn."id" AND older."parentTaskId"=root."id"
    JOIN "agent_events" completed ON completed."sessionId"=session."id"
      AND completed."turnId"=turn."id" AND completed."taskId"=root."id" AND completed."correlationId"=previous."id"
      AND completed."type"='step.completed' AND completed."actor"='orchestrator' AND completed."itemId" IS NULL
      AND completed."idempotencyKey"='turn:'||turn."id"||':event:step-completed:'||previous."id"
    WHERE session."id"=$1 AND session."userId"=$2 AND session."status"='running'
      AND turn."id"=$3 AND root."id"=$4 AND turn."status"='in_progress'
      AND turn."leaseVersion"=$5 AND turn."leaseOwnerId"=$6 AND turn."leaseExpiresAt">clock_timestamp()
      AND root."role"='orchestrator' AND root."taskType"='root' AND root."parentTaskId" IS NULL AND root."rootTaskId"=$4
      AND root."status"='running' AND root."attemptCount"=$7 AND root."leaseOwner"=$6 AND root."leaseExpiresAt">clock_timestamp()
      AND root."interruptRequestedAt" IS NULL AND root."failureReason" IS NULL
      AND step."id"=$8 AND step."attempt"=1 AND step."status"='streaming'
      AND NOT EXISTS (SELECT 1 FROM "agent_steps" newer WHERE newer."sessionId"=$1 AND newer."turnId"=$3
        AND newer."taskId"=$4 AND newer."attempt"=step."attempt" AND newer."ordinal">step."ordinal")
      AND current."id"=$9 AND current."idempotencyKey"=$11 AND current."status"='ready' AND current."mode"='all'
      AND current."consumedAt" IS NULL AND current."suspendedAt" IS NULL
      AND current."targetTaskIds"=jsonb_build_array($10::text) AND current."matchedTaskIds"=current."targetTaskIds"
      AND current."result"->'request'=jsonb_build_object('mode','all','targetTaskIds',current."targetTaskIds",'timeoutMs',86400000)
      AND previous."status"='waiting_for_tool' AND older."status"='ready' AND older."mode"='all'
      AND older."suspendedAt" IS NOT NULL AND older."resolvedAt" IS NOT NULL
      AND older."consumedAt">=GREATEST(older."suspendedAt",older."resolvedAt")
      AND older."targetTaskIds"=current."targetTaskIds" AND older."matchedTaskIds"=older."targetTaskIds"
      AND older."result"->'request'=current."result"->'request'
    LIMIT 2`,
  [scope.sessionId, scope.userId, scope.turnId, scope.rootTaskId, scope.turnLeaseVersion, scope.turnLeaseOwner,
    scope.parentAttemptCount, scope.stepId, waitId, prepareTaskId, scheduledPrepareDependencyWaitKey(handoffKey, scope.stepId)])
  if (rows.rows.length !== 1) return null
  const row = rows.rows[0]!, current = readScheduledPipelineRecoveryStepProfile(row.profile)
  const previous = readScheduledPipelineRecoveryStepProfile(row.previousProfile)
  if (!current || current.predecessorStepId !== row.previousStepId || current.inputThroughSequence !== row.inputCursor
    || row.previousWaitKey !== scheduledPrepareDependencyWaitKey(handoffKey, row.previousStepId)) return null
  const completion = { stepId: row.previousStepId, status: "waiting_for_dependency", taskId: prior.rootTaskId }
  if (previous) {
    if (previous.recoveryStepId !== row.previousStepId || current.recoveryCursor !== previous.recoveryCursor + 1
      || current.sourceEventId !== previous.sourceEventId || current.sourceStepId !== previous.sourceStepId
      || current.sourceStepOrdinal !== previous.sourceStepOrdinal || current.sourceInputThroughSequence !== previous.sourceInputThroughSequence
      || previous.inputThroughSequence !== row.previousInputCursor || BigInt(row.inputCursor) < BigInt(previous.inputThroughSequence)
      || previous.rootAttemptCount !== prior.rootAttemptCount || canonicalTaskGraphJson(previous.owner) !== canonicalTaskGraphJson(current.owner)
      || canonicalTaskGraphJson(row.previousCompletion) !== canonicalTaskGraphJson({ ...completion, waitId: row.previousWaitId })) return null
  } else {
    // The first wait can be created on the original model candidate Step. Its completion event has no wait ID.
    if (Object.hasOwn(row.previousProfile ?? {}, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY)
      || current.recoveryCursor !== 1 || current.sourceStepId !== row.previousStepId
      || current.sourceInputThroughSequence !== row.previousInputCursor
      || canonicalTaskGraphJson(row.previousCompletion) !== canonicalTaskGraphJson(completion)) return null
  }
  const candidateStepId = await resolveSteeringAgendaStep(client, scope, {
    id: scope.stepId, ordinal: row.ordinal, inputThroughSequence: BigInt(row.inputCursor), modelProfileSnapshot: row.profile,
  })
  if (candidateStepId !== current.sourceStepId) return null
  return { ...prior, turnLeaseOwnerId: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion }
}

export function scheduledPrepareDependencyWaitKey(continuationKey: string, stepId: string): string {
  const digest = createHash("sha256").update(continuationKey).update("\0").update(stepId).digest("hex")
  return `scheduled-prepare-dependency:${digest}`
}
