import { parseScheduledPipelineCandidatePayload } from "@jobcopilot/agent-protocol"
import type pg from "pg"
import type { SteeringReconciliationScope } from "./steering-reconciliation-contract.js"
import { readScheduledPipelineRecoveryStepProfile, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY } from "./scheduled-pipeline-recovery-step.js"

type Client = Pick<pg.PoolClient, "query">
type Scope = Pick<SteeringReconciliationScope, "userId" | "sessionId" | "turnId" | "rootTaskId" | "parentAttemptCount">
type CurrentStep = Readonly<{ id: string; ordinal: number; inputThroughSequence: bigint; modelProfileSnapshot: unknown }>
type Row = Record<string, unknown>
const AGENDA_ERROR = "steering_reconciliation_agenda_invalid"
const ELIGIBLE_SOURCE_STATUSES = new Set(["streaming", "completed", "waiting_for_user", "waiting_for_tool"])

function record(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Row : null
}

function containsRecoveryMarker(value: unknown): boolean {
  return Object.hasOwn(record(value) ?? {}, SCHEDULED_PIPELINE_RECOVERY_STEP_PROFILE_KEY)
}

function failClosed(): never { throw new Error(AGENDA_ERROR) }

/** Reuses only the source candidate's real agenda for an exact operational recovery Step. */
export async function resolveSteeringAgendaStep(client: Client, scope: Scope, current: CurrentStep): Promise<string> {
  const marker = readScheduledPipelineRecoveryStepProfile(current.modelProfileSnapshot)
  if (!marker) return containsRecoveryMarker(current.modelProfileSnapshot) ? failClosed() : current.id
  if (marker.recoveryStepId !== current.id || marker.owner.userId !== scope.userId || marker.owner.sessionId !== scope.sessionId
    || marker.owner.turnId !== scope.turnId || marker.owner.rootTaskId !== scope.rootTaskId
    || marker.rootAttemptCount !== scope.parentAttemptCount || current.ordinal <= marker.sourceStepOrdinal
    || marker.inputThroughSequence !== current.inputThroughSequence.toString()) return failClosed()

  const result = await client.query<Row>(`SELECT event."id" AS "sourceEventId", event."actor", event."itemId", event."payload" AS "candidatePayload",
      step."id" AS "sourceStepId", step."taskId" AS "sourceStepTaskId", step."ordinal" AS "sourceStepOrdinal",
      step."attempt" AS "sourceStepAttempt", step."status" AS "sourceStepStatus", step."modelProfileSnapshot" AS "sourceProfile",
      step."finishReason" AS "sourceFinishReason", step."inputTokens" AS "sourceInputTokens",
      step."outputTokens" AS "sourceOutputTokens", step."estimatedCostUsd" AS "sourceCost"
    FROM "agent_events" AS event
    JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_steps" AS step ON step."id" = event."correlationId" AND step."sessionId" = event."sessionId" AND step."turnId" = event."turnId"
    WHERE event."id" = $1 AND event."sessionId" = $2 AND event."turnId" = $3 AND event."taskId" = $4
      AND event."type" = 'native_verification.scheduled_candidate_staged' AND event."correlationId" = $5
      AND event."actor" = 'orchestrator' AND event."itemId" IS NULL AND session."userId" = $6
      AND step."taskId" = $4 AND step."ordinal" = $7 AND step."attempt" = 1
    LIMIT 2`, [marker.sourceEventId, scope.sessionId, scope.turnId, scope.rootTaskId, marker.sourceStepId, scope.userId, marker.sourceStepOrdinal])
  if (result.rows.length !== 1) return failClosed()
  const row = result.rows[0]!, candidate = parseScheduledPipelineCandidatePayload(row.candidatePayload)
  if (!candidate || row.sourceEventId !== marker.sourceEventId || row.sourceStepId !== marker.sourceStepId
    || row.sourceStepTaskId !== scope.rootTaskId || Number(row.sourceStepOrdinal) !== marker.sourceStepOrdinal
    || Number(row.sourceStepAttempt) !== 1 || !ELIGIBLE_SOURCE_STATUSES.has(String(row.sourceStepStatus))
    || readScheduledPipelineRecoveryStepProfile(row.sourceProfile) || candidate.sessionId !== scope.sessionId
    || candidate.turnId !== scope.turnId || candidate.rootTaskId !== scope.rootTaskId
    || candidate.rootAttemptCount !== marker.rootAttemptCount || candidate.finalStepId !== marker.sourceStepId
    || candidate.finalStepOrdinal !== marker.sourceStepOrdinal
    || row.sourceFinishReason != null && row.sourceFinishReason !== candidate.finishReason
    || candidate.usage !== null && row.sourceFinishReason != null
      && (Number(row.sourceInputTokens) !== candidate.usage.inputTokens || Number(row.sourceOutputTokens) !== candidate.usage.outputTokens
        || Number(row.sourceCost) !== candidate.usage.estimatedCostUsd)) return failClosed()
  return marker.sourceStepId
}
