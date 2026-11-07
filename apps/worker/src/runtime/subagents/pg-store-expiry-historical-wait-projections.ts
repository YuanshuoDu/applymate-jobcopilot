import type pg from "pg"
import { createHash } from "node:crypto"
import { canonicalJson } from "@jobcopilot/shared"
import { dateValue } from "./pg-store-persistence.js"
import { childWaitContinuationKeyMatchesSafeProjection } from "./pg-store-expiry-child-wait-claim-call-proof.js"
import { projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"
import { cognitiveAgendaReceiptIdempotencyKey } from "../turns/cognitive-agenda-receipt.js"
import { DurableSubagentWaitError, safeSubagentWaitJson, type DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"
import { inspectChildWaitSourceLifecycle } from "./child-resume-source-wait-lifecycle.js"
import { isCanonicalWaitResultPair, partitionWaitResultEvents } from "./pg-store-expiry-step-completion-proof.js"
import { exactKeys, readCanonicalWaitStepToolChain, record } from "./pg-store-expiry-step-tool-chain-proof.js"
import { readCanonicalHistoricalSourceStepPrefix } from "./pg-store-expiry-historical-source-step-prefix.js"
import type { HistoricalWaitBinding, RecoveredWaitHandoff, TerminalCallProjection } from "./pg-store-expiry-historical-wait-binding.js"
import type { HistoricalSourceStepPrefix } from "./pg-store-expiry-historical-source-step-prefix.js"

export const MAX_HISTORICAL_SOURCE_WAITS = 16
function sameJson(left: unknown, right: unknown): boolean { try { return canonicalJson(left) === canonicalJson(right) } catch { return false } }
function strictWaitIds(value: unknown, allowEmpty = false): string[] | null {
  return Array.isArray(value) && value.length <= 8 && (allowEmpty || value.length > 0) && value.every(id => typeof id === "string" && id.length > 0 && id.length <= 256 && id.trim() === id)
    && new Set(value).size === value.length ? value as string[] : null
}
function waitCallProjection(startEventId: unknown, rawCallId: unknown, callItemId: unknown, stepId: unknown, attempt: unknown,
  sourceWait: HistoricalWaitBinding): TerminalCallProjection | null {
  if (typeof startEventId !== "string" || !startEventId.trim() || typeof rawCallId !== "string" || !rawCallId.trim() || rawCallId.trim() !== rawCallId
    || rawCallId.length > 256 || typeof callItemId !== "string" || !callItemId.trim() || typeof stepId !== "string" || !stepId.trim()
    || typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) return null
  const projected = record(projectWaitCallEventContent({ toolName: "wait_subagents", toolCallId: rawCallId })).toolCallId
  return typeof projected === "string" ? { startEventId, rawCallId, projectedCallId: projected, callItemId, stepId, attempt, sourceWait } : null
}
function projectedCallId(rawCallId: unknown): string | null {
  if (typeof rawCallId !== "string") return null
  const projected = record(projectWaitCallEventContent({ toolName: "wait_subagents", toolCallId: rawCallId })).toolCallId
  return typeof projected === "string" ? projected : null
}
function digest(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && value.trim() === value
    ? createHash("sha256").update(value).digest("hex") : null
}
async function readRecoveredWaitHandoff(client: pg.PoolClient, scope: { id: string; sessionId: string; turnId: string }, wait: Record<string, unknown>,
  attempt: number, callItemId: string, callId: string, resultItemId: string): Promise<RecoveredWaitHandoff | null> {
  const stepId = wait.stepId
  if (wait.sourceStepStatus !== "waiting_for_tool" || typeof stepId !== "string"
    || ![scope.id, scope.sessionId, scope.turnId, wait.id, callItemId, callId, resultItemId].every(value => typeof value === "string" && value.length > 0)
    || !Number.isSafeInteger(attempt) || attempt < 1) return null
  const sourceStepPrefix = await readCanonicalHistoricalSourceStepPrefix(client, scope, {
    stepId, attempt, callItemId, callId, resultItemId, waitKind: "recovered", terminalMode: "recovered_handoff",
  })
  if (!sourceStepPrefix) return null
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(stepId), prefix = `task:${scope.id}:event:`
  if (!agendaKey) return null
  const keys = [prefix + `step-started:${stepId}`, prefix + agendaKey, prefix + `model-started:${stepId}`,
    prefix + `model-completed:${stepId}`, prefix + `model-usage:${stepId}`, prefix + `item-started:${callItemId}`]
  const events = keys.map(key => sourceStepPrefix.events.find(event => event.idempotencyKey === key))
  if (events.some(event => !event) || new Set(events.map(event => event?.id)).size !== keys.length) return null
  return { schemaVersion: "recovered_wait_handoff.v1", waitId: String(wait.id), stepId, attempt,
    sourceCallItemId: callItemId, sourceCallId: callId, sourceResultItemId: resultItemId,
    events: events.map(event => ({ id: event!.id, sequence: event!.sequence, type: event!.type, actor: event!.actor,
      itemId: event!.itemId, correlationId: event!.correlationId, causationId: event!.causationId,
      idempotencyKey: event!.idempotencyKey, payloadDigest: event!.payloadDigest })), sourceStepPrefix }
}
function sourceWaitBinding(wait: Record<string, unknown>, lifecycle: { state: "unreconciled" | "waiting" | "recovered"; callItemId: string; toolCallId: string; sourceAttempt: number; resultItemId?: string },
  projectedCallId: string, claimKeyDigest: string | null = null): HistoricalWaitBinding | null {
  const state = lifecycle.state
  const request = record(record(wait.result).request), ids = strictWaitIds(wait.targetTaskIds), matched = strictWaitIds(wait.matchedTaskIds, true)
  const deadline = wait.deadlineAt instanceof Date ? wait.deadlineAt : new Date(String(wait.deadlineAt))
  const timeoutMs = request.timeoutMs, sourceKeyDigest = digest(wait.idempotencyKey)
  const recoveryOwnerDigest = state === "recovered" ? digest(record(record(wait.result).sourceLifecycleRecovery).ownerId) : null
  if (state === "unreconciled" || typeof wait.id !== "string" || typeof wait.stepId !== "string" || !ids || !matched || !deadline || !Number.isFinite(deadline.getTime())
    || !lifecycle.resultItemId || !sourceKeyDigest || !Number.isSafeInteger(timeoutMs) || Number(timeoutMs) < 1 || Number(timeoutMs) > 30_000
    || state === "recovered" && !recoveryOwnerDigest || !["ready", "timed_out"].includes(String(wait.status)) || !["any", "all"].includes(String(wait.mode))) return null
  return { waitId: wait.id, sourceStepId: wait.stepId, sourceAttempt: lifecycle.sourceAttempt, sourceCallItemId: lifecycle.callItemId,
    sourceCallId: lifecycle.toolCallId, projectedSourceCallId: projectedCallId, sourceResultItemId: lifecycle.resultItemId,
    sourceKeyDigest, sourceLifecycleRecoveryOwnerDigest: recoveryOwnerDigest, claimKeyDigest, sourceKind: state === "waiting" ? "normal_waiting" : "recovered",
    deadlineAt: deadline.toISOString(), status: wait.status as "ready" | "timed_out",
    mode: wait.mode as "any" | "all", targetTaskIds: ids, matchedTaskIds: matched, timeoutMs: Number(timeoutMs) }
}

/** Returns only individually proven consumed waits; omitted or ambiguous starts remain blockers. */
export async function readChildWaitTerminalCallProjections(client: pg.PoolClient, task: Record<string, unknown>): Promise<TerminalCallProjection[]> {
  const id = task.id, sessionId = task.sessionId, turnId = task.turnId, rootTaskId = task.rootTaskId, userId = task.userId
  const ownerId = task.leaseOwner, attemptCount = task.attemptCount, leaseExpiresAt = dateValue(task.leaseExpiresAt)
  if (typeof id !== "string" || !id || typeof sessionId !== "string" || !sessionId || typeof turnId !== "string" || !turnId
    || typeof rootTaskId !== "string" || !rootTaskId || typeof userId !== "string" || !userId || typeof ownerId !== "string" || !ownerId
    || typeof attemptCount !== "number" || !Number.isSafeInteger(attemptCount) || attemptCount < 1 || !leaseExpiresAt) return []
  const waits = await client.query<Record<string, unknown>>(`SELECT wait.*,
      (SELECT COUNT(*)::int FROM "agent_wait_conditions" AS duplicateWait WHERE duplicateWait."parentTaskId" = owner."id"
        AND duplicateWait."sessionId" = owner."sessionId" AND duplicateWait."turnId" = owner."turnId" AND duplicateWait."stepId" = wait."stepId") AS "sourceWaitCount",
      source."status" AS "sourceStepStatus", source."ordinal" AS "sourceStepOrdinal"
    FROM "sub_agent_tasks" AS owner JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = $5
    JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId" AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
    JOIN "agent_wait_conditions" AS wait ON wait."parentTaskId" = owner."id" AND wait."sessionId" = owner."sessionId" AND wait."turnId" = owner."turnId" AND wait."userId" = session."userId"
    JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = owner."id"
    WHERE owner."id" = $1 AND owner."sessionId" = $2 AND owner."turnId" = $3 AND owner."rootTaskId" = $4 AND owner."parentTaskId" IS NOT NULL
      AND owner."status" = 'running' AND owner."leaseOwner" = $6 AND owner."attemptCount" = $7 AND owner."leaseExpiresAt" = $8 AND owner."interruptRequestedAt" IS NULL
      AND wait."status" IN ('ready', 'timed_out') AND wait."suspendedAt" IS NOT NULL AND wait."consumedAt" IS NOT NULL
      AND source."attempt" BETWEEN 1 AND $7 AND source."status" IN ('waiting_for_tool', 'completed')
    ORDER BY source."attempt" DESC, source."ordinal" DESC, wait."createdAt" DESC, wait."id" DESC LIMIT ${MAX_HISTORICAL_SOURCE_WAITS + 1}`,
  [id, sessionId, turnId, rootTaskId, userId, ownerId, attemptCount, leaseExpiresAt])
  if (!waits.rows.length || waits.rows.length > MAX_HISTORICAL_SOURCE_WAITS) return []
  const projections: TerminalCallProjection[] = []
  const claimSources = new Map<string, string>(), ambiguousClaims = new Set<string>()
  for (const wait of waits.rows) {
    const waitResult = record(wait.result), outcome = waitResult.outcome, targetIds = strictWaitIds(wait.targetTaskIds), stepId = wait.stepId
    if (Number(wait.sourceWaitCount) !== 1 || !targetIds || typeof stepId !== "string"
      || !sameJson(record(waitResult.request), { targetTaskIds: wait.targetTaskIds, mode: wait.mode, timeoutMs: record(waitResult.request).timeoutMs })) continue
    const targetRows = await client.query<{ id: string }>(`SELECT child."id" FROM unnest($1::text[]) AS target("id")
      JOIN "sub_agent_tasks" AS child ON child."id" = target."id" AND child."parentTaskId" = $2 AND child."sessionId" = $3
        AND child."turnId" = $4 AND child."rootTaskId" = $5
      JOIN "agent_sessions" AS session ON session."id" = child."sessionId" AND session."userId" = $6 ORDER BY child."id"`,
    [targetIds, id, sessionId, turnId, rootTaskId, userId])
    if (targetRows.rows.length !== targetIds.length || !sameJson(targetRows.rows.map(row => row.id).sort(), [...targetIds].sort())) continue
    let lifecycle: Awaited<ReturnType<typeof inspectChildWaitSourceLifecycle>>
    try {
      lifecycle = await inspectChildWaitSourceLifecycle(client, { id, sessionId, turnId, rootTaskId, userId, ownerId, attemptCount, leaseExpiresAt } as never,
        wait, stepId, outcome as DurableSubagentWaitResult)
    } catch (error) {
      if (error instanceof DurableSubagentWaitError) continue
      throw error
    }
    if (lifecycle.state === "unreconciled" || !lifecycle.resultItemId) continue
    const sourceStart = await client.query<{ id: string }>(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3
      AND "itemId" = $4 AND "type" = 'tool_call.started' AND "actor" = 'subagent' AND "correlationId" = $5
      AND "idempotencyKey" = 'task:' || $3 || ':event:tool-started:' || $5
      AND "payload" = jsonb_build_object('toolCallId', $5, 'toolName', 'wait_subagents', 'taskId', $3) LIMIT 2`,
    [sessionId, turnId, id, lifecycle.callItemId, lifecycle.toolCallId])
    if (sourceStart.rows.length !== 1) continue
    const projectedSourceCallId = projectedCallId(lifecycle.toolCallId)
    if (!projectedSourceCallId) continue
    const binding = sourceWaitBinding(wait, lifecycle, projectedSourceCallId)
    if (!binding) continue
    const sourceStepPrefix = await readCanonicalHistoricalSourceStepPrefix(client, { id, sessionId, turnId }, {
      stepId, attempt: lifecycle.sourceAttempt, callItemId: lifecycle.callItemId, callId: lifecycle.toolCallId,
      resultItemId: lifecycle.resultItemId, waitKind: binding.sourceKind,
    })
    const sourceStepHandoff = sourceStepPrefix || binding.sourceKind !== "recovered" ? null
      : await readRecoveredWaitHandoff(client, { id, sessionId, turnId }, wait, lifecycle.sourceAttempt,
        lifecycle.callItemId, lifecycle.toolCallId, lifecycle.resultItemId)
    if (!sourceStepPrefix && !sourceStepHandoff) continue
    const sourceStepEvidence = sourceStepPrefix ? { sourceStepPrefix } : { sourceStepHandoff: sourceStepHandoff! }
    const sourceProjection = waitCallProjection(sourceStart.rows[0]?.id, lifecycle.toolCallId, lifecycle.callItemId, stepId, lifecycle.sourceAttempt, binding)
    if (!sourceProjection) continue
    projections.push({ ...sourceProjection, ...sourceStepEvidence })
    const claimRows: { rows: Record<string, unknown>[] } = await client.query<Record<string, unknown>>(`SELECT claimStep."id" AS "stepId", claimStep."attempt", claimStep."status" AS "stepStatus",
        call."id" AS "callItemId", call."content" AS "callContent", call."status" AS "callStatus", call."revision" AS "callRevision", call."phase" AS "callPhase",
        callStart."id" AS "startEventId", callStart."sequence" AS "startSequence", sourceCall."content"->'input' AS "sourceInput",
        result."id" AS "resultItemId", result."content" AS "resultContent", result."status" AS "resultStatus", result."revision" AS "resultRevision", result."phase" AS "resultPhase"
      FROM "sub_agent_tasks" AS owner JOIN "agent_sessions" AS session ON session."id" = owner."sessionId" AND session."userId" = $5
      JOIN "agent_turns" AS turn ON turn."id" = owner."turnId" AND turn."sessionId" = owner."sessionId" AND turn."userId" = session."userId" AND turn."rootTaskId" = owner."rootTaskId"
      JOIN "agent_wait_conditions" AS wait ON wait."id" = $9 AND wait."parentTaskId" = owner."id" AND wait."sessionId" = owner."sessionId" AND wait."turnId" = owner."turnId" AND wait."userId" = session."userId"
      JOIN "agent_steps" AS source ON source."id" = wait."stepId" AND source."sessionId" = wait."sessionId" AND source."turnId" = wait."turnId" AND source."taskId" = owner."id"
      JOIN "agent_items" AS sourceCall ON sourceCall."sessionId" = source."sessionId" AND sourceCall."turnId" = source."turnId" AND sourceCall."taskId" = source."taskId" AND sourceCall."stepId" = source."id" AND sourceCall."type" = 'tool_call' AND sourceCall."content"->>'toolName' = 'wait_subagents'
      JOIN "agent_steps" AS claimStep ON claimStep."sessionId" = source."sessionId" AND claimStep."turnId" = source."turnId" AND claimStep."taskId" = source."taskId"
        AND claimStep."attempt" = owner."attemptCount" AND claimStep."ordinal" = (SELECT MIN(later."ordinal") FROM "agent_steps" AS later WHERE later."sessionId" = source."sessionId" AND later."turnId" = source."turnId" AND later."taskId" = source."taskId" AND later."attempt" = owner."attemptCount" AND later."ordinal" > source."ordinal")
      JOIN "agent_items" AS call ON call."sessionId" = claimStep."sessionId" AND call."turnId" = claimStep."turnId" AND call."taskId" = claimStep."taskId" AND call."stepId" = claimStep."id" AND call."type" = 'tool_call' AND call."content"->>'toolName' = 'wait_subagents'
      JOIN "agent_events" AS callStart ON callStart."sessionId" = call."sessionId" AND callStart."turnId" = call."turnId" AND callStart."taskId" = call."taskId" AND callStart."itemId" = call."id" AND callStart."type" = 'tool_call.started'
      LEFT JOIN "agent_items" AS result ON result."sessionId" = call."sessionId" AND result."turnId" = call."turnId" AND result."taskId" = call."taskId" AND result."stepId" = claimStep."id" AND result."type" = 'tool_result' AND result."content"->>'toolCallId' = call."content"->>'toolCallId'
      WHERE owner."id" = $1 AND owner."sessionId" = $2 AND owner."turnId" = $3 AND owner."rootTaskId" = $4 AND owner."status" = 'running'
        AND owner."parentTaskId" IS NOT NULL AND owner."leaseOwner" = $6 AND owner."attemptCount" = $7 AND owner."leaseExpiresAt" = $8 AND owner."interruptRequestedAt" IS NULL
        AND claimStep."status" IN ('streaming', 'completed') AND callStart."actor" = 'subagent' AND callStart."correlationId" = call."content"->>'toolCallId'
        AND callStart."idempotencyKey" = 'task:' || owner."id" || ':event:child-wait-claim:' || claimStep."attempt"::text || ':' || claimStep."id"
        AND callStart."payload" = jsonb_build_object('toolCallId', call."content"->>'toolCallId', 'toolName', 'wait_subagents', 'taskId', owner."id")
        AND call."id" = 'task:' || owner."id" || ':item:tool-call:' || (call."content"->>'toolCallId') || ':attempt:' || claimStep."attempt"::text
        AND call."status" = 'completed' AND call."revision" = 1 AND call."phase" IS NULL LIMIT 3`,
    [id, sessionId, turnId, rootTaskId, userId, ownerId, attemptCount, leaseExpiresAt, wait.id])
    if (claimRows.rows.length !== 1) continue
    const claim: Record<string, unknown> = claimRows.rows[0]!, claimContent = record(claim.callContent), input = record(claimContent.input), sourceInput = record(claim.sourceInput)
    const claimId = claimContent.toolCallId, claimStepId = claim.stepId, claimAttempt: unknown = claim.attempt, claimCallItemId = claim.callItemId
    const claimKeyDigest = digest(input.idempotencyKey)
    const claimInputValid = exactKeys(claimContent, ["toolCallId", "toolName", "toolVersion", "input", "status", "errorCode"])
      && claimContent.toolName === "wait_subagents" && claimContent.toolVersion === "1" && claimContent.status === "completed" && claimContent.errorCode === null
      && exactKeys(input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"]) && input.mode === wait.mode
      && input.timeoutMs === record(waitResult.request).timeoutMs && sameJson(input.taskIds, targetIds)
      && typeof sourceInput.idempotencyKey === "string" && childWaitContinuationKeyMatchesSafeProjection(sourceInput.idempotencyKey, input.idempotencyKey)
    if (!claimInputValid || typeof claimId !== "string" || typeof claimStepId !== "string" || typeof claimAttempt !== "number"
      || typeof claimCallItemId !== "string" || !claimCallItemId || claimAttempt !== attemptCount || !claimKeyDigest
      || !waitCallProjection(claim.startEventId, claimId, claimCallItemId, claimStepId, claimAttempt,
        { ...binding, claimKeyDigest })) continue
    const resultId = `task:${id}:item:tool-result:${claimId}:attempt:${claimAttempt}`, resultContent = record(claim.resultContent)
    const safeOutcome = safeSubagentWaitJson(outcome, 16_384)
    if (claim.resultItemId !== resultId || claim.resultStatus !== "completed" || claim.resultRevision !== 1 || claim.resultPhase !== null
      || !exactKeys(resultContent, ["toolCallId", "output", "errorCode"]) || resultContent.toolCallId !== claimId || resultContent.errorCode !== null
      || !sameJson(resultContent.output, safeOutcome)) continue
    const callTerminal = await client.query<Record<string, unknown>>(`SELECT "id", "sequence", "type", "actor", "itemId", "correlationId", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = $4 LIMIT 2`,
    [sessionId, turnId, id, `task:${id}:event:tool-finished:${claimId}`])
    const terminal = callTerminal.rows[0]
    if (callTerminal.rows.length !== 1 || terminal?.type !== "tool_call.completed" || terminal.actor !== "subagent" || terminal.itemId !== claim.callItemId
      || terminal.correlationId !== claimId || !sameJson(terminal.payload, { toolCallId: claimId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: id })) continue
    const resultKeys = [`task:${id}:event:item-started:${resultId}`, `task:${id}:event:tool-result-completed:${claimId}:${resultId}:1`]
    const resultEvents = await client.query<Record<string, unknown>>(`SELECT "id", "type", "actor", "itemId", "correlationId", "causationId", "sequence", "idempotencyKey", "payload" FROM "agent_events"
      WHERE "sessionId" = $1 AND "turnId" = $2 AND "taskId" = $3 AND ("itemId" = $4 OR "correlationId" = $4 OR "idempotencyKey" = ANY($5::text[])
        OR "causationId" IN (SELECT anchor."id" FROM "agent_events" AS anchor WHERE anchor."sessionId" = $1 AND anchor."turnId" = $2 AND anchor."taskId" = $3 AND anchor."idempotencyKey" = ANY($5::text[]))) ORDER BY "sequence" LIMIT 4`,
    [sessionId, turnId, id, resultId, resultKeys])
    const resultPair = partitionWaitResultEvents(resultEvents.rows, resultKeys)
    if (!resultPair || !isCanonicalWaitResultPair(terminal, resultPair.started, resultPair.completed, resultId, claimStepId, resultContent)) continue
    const { started: resultStarted, completed: resultCompleted, extra: nextEvent } = resultPair
    if (typeof resultStarted.id !== "string" || typeof resultCompleted.id !== "string") continue
    const stepToolChain = await readCanonicalWaitStepToolChain(client, { id, sessionId, turnId },
      { stepId: claimStepId, attempt: claimAttempt, callItemId: claimCallItemId, callId: claimId, resultItemId: resultId })
    if (!stepToolChain || typeof nextEvent?.id !== "string" || nextEvent.id !== stepToolChain.nextEventId) continue
    const claimProjection = waitCallProjection(claim.startEventId, claimId, claimCallItemId, claimStepId, claimAttempt,
      { ...binding, claimKeyDigest })
    if (claimProjection) {
      const previousSource = claimSources.get(claimProjection.startEventId)
      if (previousSource && previousSource !== sourceProjection.startEventId) ambiguousClaims.add(claimProjection.startEventId)
      claimSources.set(claimProjection.startEventId, sourceProjection.startEventId)
      projections.push({ ...claimProjection, ...sourceStepEvidence, resultItemId: resultId, resultStartedEventId: resultStarted.id,
        resultCompletedEventId: resultCompleted.id, stepCompletedEventId: stepToolChain.stepCompletedEventId, stepToolChain })
    }
  }
  return projections.filter(projection => !projection.resultItemId || !ambiguousClaims.has(projection.startEventId))
}
