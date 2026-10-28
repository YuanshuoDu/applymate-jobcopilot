import type { TurnQuestionScheduledChoiceBinding } from "./turn-question-contract.js"
import { buildTurnQuestionScheduledChoiceBinding, buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence, parseTurnQuestionScheduledChoiceBinding,
  scheduledAnalyzeCheckpointEvidence, turnScheduledPrepareChoiceWaitId, isTurnQuestionUsage } from "./turn-question-contract.js"
import { toRepositoryJson } from "./turn-engine-types.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import { scheduledSnapshotMatches } from "../subagents/scheduled-taskgraph-continuation-receipt.js"
import { SCHEDULED_PIPELINE_CANDIDATE_EVENT, parseScheduledPipelineCandidatePayload } from "../subagents/scheduled-pipeline-candidate-store.js"
import { questionConflict, type TurnQuestionQueryClient } from "./turn-question-store-guards.js"

type Row = Record<string, unknown>

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(toRepositoryJson(left)) === JSON.stringify(toRepositoryJson(right))
}

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null
}

export async function loadScheduledChoiceBinding(client: TurnQuestionQueryClient, input: { owner: TurnExecutionOwnerFence; expected?: TurnQuestionScheduledChoiceBinding; expectedReceipt?: unknown }): Promise<{ binding: TurnQuestionScheduledChoiceBinding; waitId: string; stepId: string; stepStatus: string; candidateFinishReason: string; candidateUsage: unknown }> {
  const candidate = await client.query<Row>(`SELECT event."itemId", event."taskId", event."actor", event."correlationId", event."idempotencyKey", event."payload",
      step."taskId" AS "stepTaskId", step."ordinal", step."attempt", step."status" AS "stepStatus", root."attemptCount", root."status" AS "rootStatus"
    FROM "agent_events" AS event JOIN "agent_sessions" AS session ON session."id" = event."sessionId"
    JOIN "agent_steps" AS step ON step."id" = event."correlationId" AND step."sessionId" = event."sessionId" AND step."turnId" = event."turnId"
    JOIN "sub_agent_tasks" AS root ON root."id" = event."taskId" AND root."sessionId" = event."sessionId" AND root."turnId" = event."turnId"
    WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."taskId" = $3 AND event."type" = $4
      AND session."userId" = $5 AND root."rootTaskId" = root."id" AND root."parentTaskId" IS NULL
    ORDER BY event."sequence" DESC LIMIT 1 FOR SHARE OF event, step, root`,
  [input.owner.sessionId, input.owner.turnId, input.owner.rootTaskId, SCHEDULED_PIPELINE_CANDIDATE_EVENT, input.owner.userId])
  const row = candidate.rows[0], payload = parseScheduledPipelineCandidatePayload(row?.payload), rootAttempt = Number(row?.attemptCount)
  if (candidate.rows.length !== 1 || !payload || row?.itemId !== null || row.taskId !== input.owner.rootTaskId
    || row.actor !== "orchestrator" || row.correlationId !== payload.finalStepId || row.stepTaskId !== input.owner.rootTaskId
    || payload.sessionId !== input.owner.sessionId || payload.turnId !== input.owner.turnId || payload.rootTaskId !== input.owner.rootTaskId
    || !Number.isSafeInteger(rootAttempt) || rootAttempt < 1 || payload.rootAttemptCount !== rootAttempt
    || payload.finalStepOrdinal !== Number(row.ordinal) || !Number.isSafeInteger(payload.finalStepOrdinal) || payload.finalStepOrdinal < 0
    || Number(row.attempt) !== 1 || payload.stepAttempt !== 1 || typeof payload.candidateText !== "string" || !payload.candidateText.trim()
    || typeof payload.finishReason !== "string" || !payload.finishReason.trim() || payload.finishReason.length > 128 || !isTurnQuestionUsage(payload.usage)
    || !["running", "waiting_for_user"].includes(String(row.rootStatus)) || !["streaming", "waiting_for_user", "completed"].includes(String(row.stepStatus))
    || row.idempotencyKey !== `scheduled-candidate:${input.owner.rootTaskId}:${rootAttempt}:${payload.finalStepId}`) throw questionConflict("scheduled candidate binding")
  const live = await client.query<Row>(`SELECT turn."source", turn."executionMode", turn."input", execution."id", execution."attemptCount", execution."status", execution."state"
    FROM "agent_turns" AS turn JOIN "agent_executions" AS execution ON execution."sessionId" = turn."sessionId"
      AND execution."id" = execution."state"->'scheduledTaskGraphContinuation'->'owner'->>'executionId'
    JOIN "agent_sessions" AS session ON session."id" = turn."sessionId"
    WHERE turn."id" = $1 AND turn."sessionId" = $2 AND turn."userId" = $3 AND execution."userId" = $3 AND session."userId" = $3 FOR SHARE OF execution`,
  [input.owner.turnId, input.owner.sessionId, input.owner.userId])
  const execution = live.rows[0], state = record(execution?.state), marker = record(state?.scheduledTaskGraphContinuation), markerOwner = record(marker?.owner)
  if (live.rows.length !== 1 || !execution || !["running", "waiting_for_user"].includes(String(execution.status))) throw questionConflict("scheduled execution binding")
  const evidence = scheduledAnalyzeCheckpointEvidence(state), checkpointDigest = evidence?.checkpointDigest, stableOwner = evidence?.owner
  if (!evidence || !checkpointDigest || !marker || !stableOwner || !markerOwner
    || !scheduledSnapshotMatches({ source: execution.source, executionMode: execution.executionMode, input: execution.input }, evidence.snapshotDigest)
    || stableOwner.userId !== input.owner.userId || stableOwner.sessionId !== input.owner.sessionId
    || stableOwner.turnId !== input.owner.turnId || stableOwner.rootTaskId !== input.owner.rootTaskId
    || stableOwner.rootAttemptCount !== rootAttempt || stableOwner.executionId !== execution.id
    || stableOwner.executionAttemptCount !== Number(execution.attemptCount)) throw questionConflict("scheduled Analyze checkpoint binding")
  const stepId = String(payload.finalStepId), binding = buildTurnQuestionScheduledChoiceBindingFromAnalyzeEvidence({ owner: stableOwner,
    continuationKey: evidence.continuationKey, snapshotDigest: evidence.snapshotDigest, evidenceDigest: evidence.evidenceDigest,
    checkpointDigest, analyzeGraphRevision: evidence.analyzeGraphRevision, finalStepId: stepId, finalStepOrdinal: Number(row.ordinal) })
  const id = turnScheduledPrepareChoiceWaitId(binding)
  const expected = input.expected ? parseTurnQuestionScheduledChoiceBinding(input.expected)
    : input.expectedReceipt === undefined ? undefined : buildTurnQuestionScheduledChoiceBinding({ receipt: input.expectedReceipt,
      finalStepId: stepId, finalStepOrdinal: Number(row.ordinal) })
  if (!binding || !id || (input.expected !== undefined || input.expectedReceipt !== undefined) && (!expected || !sameJson(expected, binding))) {
    throw questionConflict("scheduled choice continuation binding")
  }
  return { binding, waitId: id, stepId, stepStatus: String(row.stepStatus), candidateFinishReason: payload.finishReason, candidateUsage: payload.usage }
}
