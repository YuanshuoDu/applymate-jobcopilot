import { Pool } from "pg"
import { Redis } from "ioredis"
import { Worker } from "bullmq"
import { AgentTreeManager } from "./manager.ts"
import { PgSubagentTaskStore } from "./pg-store.ts"
import { parseSubagentDispatchJobId } from "./dispatch-identity.ts"
import { runSubagentQueueJob } from "../../queue/subagent-pause-dispatch.ts"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.ts"
import { executionOwnerFence } from "../execution-owner.ts"
import { registerDurableSubagentWait } from "./durable-subagent-wait-store.ts"
import { startDurableWaitResolver } from "./durable-wait-resolver.ts"
import { loadDurableSubagentWaitResume, commitDurableSubagentWaitResume } from "./durable-subagent-wait-resume.ts"
import { loadChildAttemptResume } from "./child-resume.ts"
import { createChildDurableWaitReplay } from "./child-durable-wait-replay.ts"
import { TurnExecutionEventWriter, executeToolWithItems } from "../turns/turn-execution-events.ts"
import { recoverPersistedToolCalls } from "../turns/turn-execution-tools.ts"
import { childWaitClaimEventKey } from "./child-durable-wait-replay.ts"
import { canonicalJson, redactSensitiveText } from "@jobcopilot/shared"
import { contextToModelMessages } from "../turns/turn-engine-messages.ts"
import { projectChildToolCallIdsForModelContext } from "../turns/turn-tool-call-id-projection.ts"
import { readRecoveryStateSnapshot } from "./durable-child-wait-recovery-diagnostics.fixture.mjs"

const [, , mode, queueName, rawIds] = process.argv
const ids = JSON.parse(rawIds)
const phoneShapedToolCallId = "child-wait-call:415-555-0134"
const readyMarkerByMode = {
  "worker-a": "WORKER_A_READY",
  "worker-a-crash": "WORKER_A_READY",
  "worker-b-crash-before-resume": "WORKER_B_READY",
  "worker-b-crash-resume": "WORKER_B_READY",
  "worker-b-crash-after-wait-ack": "WORKER_B_READY",
  "worker-b-crash-before-claim": "WORKER_B_READY",
  "worker-b-crash-after-orphan-reissue": "WORKER_B_READY",
  "worker-b-crash-after-claim-result": "WORKER_B_READY",
  "worker-b": "WORKER_B_READY",
}
const crashCutModes = new Set([
  "worker-a-crash",
  "worker-b-crash-before-resume",
  "worker-b-crash-resume",
  "worker-b-crash-after-wait-ack",
  "worker-b-crash-before-claim",
  "worker-b-crash-after-orphan-reissue",
  "worker-b-crash-after-claim-result",
])
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 6 })
const redis = new Redis(process.env.AGENT_TURN_REDIS_TEST_URL, { maxRetriesPerRequest: null })
const store = new PgSubagentTaskStore(pool, 30_000)
const manager = new AgentTreeManager(store, { heartbeatMs: 2_000 })
const turnStore = createPgTurnEngineStore(pool)
const resolver = mode.startsWith("worker-b") ? startDurableWaitResolver(pool, { intervalMs: 100, ownerId: "restart-fixture-worker-b" }) : undefined
let stopped = false

function say(value) { process.stdout.write(`${value}\n`) }
function boundedIds(value) {
  return Array.isArray(value) && value.length <= 8
    ? value.map(id => typeof id === "string" ? id.slice(0, 256) : null)
    : null
}

function restoredWaitObservationSummary(restored, wait, pendingWait, owner, stepId) {
  const matches = restored.observations.filter(item => item?.content?.toolCallId === wait.toolCallId
    && item.content.toolName === "wait_subagents")
  if (matches.length !== 1) throw new Error("durable_child_wait_restored_observation_missing")
  const content = matches[0].content
  const snapshot = { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: restored.observations }
  const projection = projectChildToolCallIdsForModelContext(snapshot, owner, stepId)
  const projectedMatches = projection.snapshot.toolObservations.filter(item => item?.content?.toolName === "wait_subagents")
  if (projectedMatches.length !== 1) throw new Error("durable_child_wait_projected_observation_missing")
  const projectedId = projectedMatches[0].content.toolCallId
  const blocks = projection.snapshot.toolObservations.map(item => ({ ...item,
    layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" }))
  const messages = contextToModelMessages({ blocks })
  const parts = messages.flatMap(message => Array.isArray(message.content) ? message.content : [])
  const toolUse = parts.find(part => part?.type === "tool_use" && part.name === "wait_subagents")
  const toolResult = parts.find(part => part?.type === "tool_result" && part.toolUseId === projectedId)
  const repeated = projectChildToolCallIdsForModelContext(snapshot, owner, stepId)
  const repeatedId = repeated.snapshot.toolObservations.find(item => item?.content?.toolName === "wait_subagents")?.content?.toolCallId
  const serializedMessages = JSON.stringify(messages)
  if (projectedId === wait.toolCallId || projection.aliasToCanonical.get(projectedId) !== wait.toolCallId
    || redactSensitiveText(projectedId) !== projectedId || !toolUse || !toolResult || toolUse.id !== toolResult.toolUseId
    || toolUse.id !== projectedId || serializedMessages.includes(wait.toolCallId) || repeatedId !== projectedId) {
    throw new Error("durable_child_wait_model_projection_invalid")
  }
  const output = content.output
  const tasks = Array.isArray(output?.tasks) && output.tasks.length <= 8 ? output.tasks : null
  const targetTask = tasks?.find(task => task?.taskId === ids.targetTaskId)
  const targetFinalText = typeof targetTask?.result?.finalText === "string" ? targetTask.result.finalText.slice(0, 512) : null
  return {
    state: pendingWait ? "unconsumed" : "consumed",
    canonicalCallIdPreserved: content.toolCallId === wait.toolCallId,
    modelContextSafe: !serializedMessages.includes(wait.toolCallId),
    modelToolPairBound: toolUse.id === toolResult.toolUseId,
    deterministicProjection: repeatedId === projectedId,
    providerInvoked: false,
    inputTaskIds: boundedIds(content.input?.taskIds),
    outputTaskIds: boundedIds(output?.taskIds),
    matchedTaskIds: boundedIds(output?.matchedTaskIds),
    outputTaskIdsFromTasks: tasks ? tasks.map(task => typeof task?.taskId === "string" ? task.taskId.slice(0, 256) : null) : null,
    targetFinalText,
  }
}


function boundedErrorDetails(error) {
  if (error instanceof Error) return { name: String(error.name).slice(0, 128), message: error.message.slice(0, 1_000), stack: error.stack?.slice(0, 3_000) ?? null }
  return { name: typeof error, message: String(error).slice(0, 1_000), stack: null }
}

function executionStore(owner) {
  const bind = method => input => {
    const { identity, ...rest } = input
    return turnStore[method]({ ...rest, owner: identity })
  }
  return { createItem: bind("createItem"), updateItem: bind("updateItem"), appendEvent: bind("appendEvent") }
}

function turnExecutionOptions(lease, owner, executeTool, additions = {}) {
  return {
    identity: owner,
    scope: { userId: lease.userId },
    goal: lease.goal,
    snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: additions.observations ?? [] },
    contextBuilder: { build: async () => { throw new Error("fixture_context_builder_not_used") } },
    store: executionStore(owner),
    model: {},
    tools: [],
    executeTool,
    idFactory: prefix => `${prefix}:attempt:${lease.attemptCount}`,
    ...(additions.childWaitCallStartKey ? { childWaitCallStartKey: additions.childWaitCallStartKey } : {}),
    ...(additions.childWaitClaimRecovery ? { childWaitClaimRecovery: additions.childWaitClaimRecovery } : {}),
  }
}

async function claimExactWaitReissue(lease, owner, wait, continuation, now, optionsForCut = {}) {
  let restored = optionsForCut.restored
  if (!restored && optionsForCut.checkStaleLeaseSnapshot) {
    if (!(lease.leaseExpiresAt instanceof Date)) throw new Error("durable_child_wait_original_lease_snapshot_missing")
    const snapshotExpiresAt = lease.leaseExpiresAt
    // Keep the immutable claim snapshot while the owner-fenced store heartbeat advances the DB lease.
    await new Promise(resolve => setTimeout(resolve, 10))
    const heartbeat = await store.heartbeat({ taskId: lease.id, sessionId: lease.sessionId, ownerId: lease.ownerId,
      attemptCount: lease.attemptCount, now: new Date() })
    if (heartbeat !== "renewed") throw new Error("durable_child_wait_lease_heartbeat_not_renewed")
    const logicalNow = new Date(snapshotExpiresAt.getTime() + 1)
    const liveTask = await store.get(lease.id, lease.sessionId)
    if (!(liveTask?.leaseExpiresAt instanceof Date) || liveTask.leaseExpiresAt.getTime() <= logicalNow.getTime()) {
      throw new Error("durable_child_wait_db_lease_not_past_snapshot")
    }
    restored = await loadChildAttemptResume(pool, lease, logicalNow, wait)
    if (!restored) throw new Error("durable_child_wait_stale_snapshot_resume_missing")
    say(`WORKER_B_STALE_LEASE_SNAPSHOT_ACCEPTED ${JSON.stringify({ snapshotExpiresAt: snapshotExpiresAt.toISOString(),
      logicalNow: logicalNow.toISOString(), liveDbLeaseExpiresAt: liveTask.leaseExpiresAt.toISOString(), loaded: true })}`)
  } else if (!restored) restored = await loadChildAttemptResume(pool, lease, new Date(), wait)
  const orphanCallIds = Array.isArray(restored?.childWaitOrphanCallIds) ? restored.childWaitOrphanCallIds : []
  if (optionsForCut.expectedOrphanCallId && !orphanCallIds.includes(optionsForCut.expectedOrphanCallId)) {
    throw new Error("durable_child_wait_orphan_not_classified")
  }
  if (optionsForCut.expectedOrphanCallId && (restored.resume.toolCallCount !== 1
    || restored.observations.some(item => item?.content?.toolCallId === optionsForCut.expectedOrphanCallId))) {
    throw new Error("durable_child_wait_orphan_counted_or_observed")
  }
  let staleOwnerRejected = false, staleAttemptRejected = false
  try { await loadChildAttemptResume(pool, { ...lease, ownerId: `${lease.ownerId}:stale` }, new Date(), wait) }
  catch (error) { staleOwnerRejected = error?.message === "child_resume_owner_mismatch" }
  try { await loadChildAttemptResume(pool, { ...lease, attemptCount: lease.attemptCount + 1 }, new Date(), wait) }
  catch (error) { staleAttemptRejected = error?.message === "child_resume_owner_mismatch" }
  if (!staleOwnerRejected || !staleAttemptRejected) throw new Error("durable_child_wait_stale_owner_or_attempt_not_fenced")

  const restoredWait = restored?.durableWait
  if (!restoredWait || restoredWait.continuationStepId !== continuation.id || restoredWait.continuationOrdinal !== continuation.ordinal) {
    throw new Error("durable_child_wait_claim_continuation_not_restored")
  }
  const replay = createChildDurableWaitReplay(lease, restoredWait, restored.observations, () => new Date())
  replay.acknowledgeContinuation({ id: continuation.id, ordinal: continuation.ordinal })
  const call = { id: optionsForCut.crashBeforeClaim
    ? `child-wait-reissue:${lease.id}:attempt:${lease.attemptCount}:orphan`
    : `child-wait-reissue:${lease.id}:attempt:${lease.attemptCount}`, name: "wait_subagents", arguments: restoredWait.input }
  const wrongStepRejected = replay.childWaitCallStartKey(`${continuation.id}:wrong`, call) === undefined
  if (!wrongStepRejected) throw new Error("durable_child_wait_wrong_step_claimed")
  let dispatcherCalls = 0
  const options = turnExecutionOptions(lease, owner, async input => {
    const result = replay.execute(input)
    if (!result) {
      dispatcherCalls += 1
      throw new Error("durable_child_wait_exact_reissue_dispatched_wait")
    }
    if (result.status !== "completed" || canonicalJson(result.output) !== canonicalJson(restoredWait.output)) {
      throw new Error("durable_child_wait_exact_reissue_not_replayed")
    }
    const competingCallId = `${call.id}:competitor`
    const competingCall = { ...input.call, id: competingCallId }
    const repeatedStartKeyRejected = replay.childWaitCallStartKey(input.stepId, competingCall) === undefined
    const competingReplay = replay.execute({ ...input, call: competingCall })
    const competingReplayRejected = competingReplay.status === "failed" && competingReplay.errorCode === "wait_conflict"
    if (!repeatedStartKeyRejected || !competingReplayRejected) throw new Error("durable_child_wait_one_use_guard_missing")
    const competitor = new TurnExecutionEventWriter(options)
    const competingItemId = `task:${lease.id}:item:tool-call:${competingCallId}:attempt:${lease.attemptCount}`
    await turnStore.createItem({ owner, itemId: competingItemId, stepId: continuation.id, type: "tool_call", status: "started", phase: null,
      content: { toolCallId: competingCallId, toolName: "wait_subagents", toolVersion: "1", input: call.arguments }, now: new Date() })
    let competingFreshIdRejected = false
    try {
      await competitor.append("tool_call.started", competingCallId, competingItemId,
        { toolCallId: competingCallId, toolName: "wait_subagents", taskId: lease.id },
        childWaitClaimEventKey(lease.attemptCount, continuation.id))
    } catch { competingFreshIdRejected = true }
    if (!competingFreshIdRejected) throw new Error("durable_child_wait_competing_fresh_id_claimed")
    let competingOrphanRejected = false
    try { await loadChildAttemptResume(pool, lease, new Date(), restoredWait) }
    catch (error) { competingOrphanRejected = error?.message === "child_resume_wait_tool_call_conflict" }
    const competingItemDeleted = await pool.query(`DELETE FROM "agent_items" WHERE "id" = $1 AND "sessionId" = $2
      AND "turnId" = $3 AND "taskId" = $4 RETURNING "id"`, [competingItemId, lease.sessionId, lease.turnId, lease.id])
    const claimAfterCompetition = await pool.query(`SELECT "correlationId" FROM "agent_events" WHERE "sessionId" = $1
      AND "turnId" = $2 AND "taskId" = $3 AND "idempotencyKey" = $4`,
    [lease.sessionId, lease.turnId, lease.id, `task:${lease.id}:event:${childWaitClaimEventKey(lease.attemptCount, continuation.id)}`])
    if (!competingOrphanRejected || competingItemDeleted.rowCount !== 1 || claimAfterCompetition.rowCount !== 1
      || claimAfterCompetition.rows[0]?.correlationId !== call.id) throw new Error("durable_child_wait_competing_call_not_fenced")
    const claimForRecovery = (await loadChildAttemptResume(pool, lease, new Date(), restoredWait))?.childWaitClaimRecovery
    if (!claimForRecovery) throw new Error("durable_child_wait_claim_not_restored_after_competition")
    const staleOwner = { ...owner, ownerId: `${owner.ownerId}:stale` }
    const wrongOwnerOptions = turnExecutionOptions(lease, staleOwner, async () => { throw new Error("stale_claim_recovery_dispatched") },
      { childWaitClaimRecovery: claimForRecovery })
    let staleRecoveryOwnerRejected = false
    try { await recoverPersistedToolCalls(wrongOwnerOptions, new TurnExecutionEventWriter(wrongOwnerOptions), () => new Date()) }
    catch (error) { staleRecoveryOwnerRejected = error?.message === "child_wait_claim_recovery_owner_mismatch" }
    const staleAttempt = { ...owner, attemptCount: lease.attemptCount + 1 }
    const wrongAttemptOptions = turnExecutionOptions(lease, staleAttempt, async () => { throw new Error("stale_attempt_recovery_dispatched") },
      { childWaitClaimRecovery: claimForRecovery })
    let staleRecoveryAttemptRejected = false
    try { await recoverPersistedToolCalls(wrongAttemptOptions, new TurnExecutionEventWriter(wrongAttemptOptions), () => new Date()) }
    catch (error) { staleRecoveryAttemptRejected = error?.message === "child_wait_claim_recovery_owner_mismatch" }
    if (!staleRecoveryOwnerRejected || !staleRecoveryAttemptRejected) throw new Error("durable_child_wait_claim_recovery_fence_missing")
    say(`WORKER_B_REISSUE_CLAIMED ${JSON.stringify({ callId: call.id, stepId: continuation.id, waitId: restoredWait.waitId,
      exactInput: true, storedOutputMatched: true, wrongStepRejected, repeatedStartKeyRejected, competingReplayRejected,
      competingFreshIdRejected, competingOrphanRejected,
      orphanCallIds, staleOwnerRejected, staleAttemptRejected, staleRecoveryOwnerRejected, staleRecoveryAttemptRejected, dispatcherCalls })}`)
    return new Promise(() => {})
  }, {
    observations: restored.observations,
    childWaitCallStartKey: (stepId, candidate) => replay.childWaitCallStartKey(stepId, candidate),
  })
  const writer = new TurnExecutionEventWriter(options)
  if (optionsForCut.crashBeforeClaim) {
    await executeToolWithItems(options, writer, continuation, call, () => new Date(), () => {
      say(`WORKER_B_PRE_CLAIM_ORPHAN ${JSON.stringify({ callId: call.id, stepId: continuation.id, waitId: restoredWait.waitId,
        exactInput: true, executorCalls: dispatcherCalls })}`)
      return new Promise(() => {})
    })
    throw new Error("durable_child_wait_preclaim_barrier_returned")
  }
  await executeToolWithItems(options, writer, continuation, call, () => new Date())
  throw new Error("durable_child_wait_claim_barrier_returned")
}

async function recoverClaimedWait(lease, owner, restored, crashAfterResult) {
  const claim = restored?.childWaitClaimRecovery
  if (!claim) throw new Error("durable_child_wait_claim_recovery_missing")
  let executorCalls = 0
  const options = turnExecutionOptions(lease, owner, async () => {
    executorCalls += 1
    throw new Error("durable_child_wait_claim_recovery_dispatched_wait")
  }, { observations: restored.observations, childWaitClaimRecovery: claim })
  const observations = await recoverPersistedToolCalls(options, new TurnExecutionEventWriter(options), () => new Date())
  const recovered = observations.filter(item => item.id === `tool-result:${claim.call.id}`)
  const content = recovered[0]?.content
  if (recovered.length !== 1 || content?.toolCallId !== claim.call.id || content?.toolName !== "wait_subagents"
    || content?.status !== "completed" || content?.errorCode !== null || canonicalJson(content?.output) !== canonicalJson(claim.output)
    || executorCalls !== 0) throw new Error("durable_child_wait_claim_recovery_result_invalid")
  const summary = { callId: claim.call.id, stepId: claim.stepId, waitId: claim.output.waitId, outputMatched: true,
    orphanCallIds: restored.childWaitOrphanCallIds ?? [], restoredToolCallCount: restored.resume.toolCallCount,
    executorCalls, sameCallRecovered: true, resultItemStatus: claim.resultItem?.status ?? "created" }
  if (crashAfterResult) {
    say(`WORKER_B_REISSUE_RESULT_RECOVERED ${JSON.stringify(summary)}`)
    return new Promise(() => {})
  }
  say(`WORKER_B_REISSUE_RECOVERY_REUSED ${JSON.stringify(summary)}`)
  return content
}

async function waitForChild(lease, crashAfterRegistration = false) {
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `child-wait-step:${lease.id}:attempt:${lease.attemptCount}`
  const toolCallId = phoneShapedToolCallId
  if (redactSensitiveText(toolCallId) === toolCallId) throw new Error("fixture_tool_call_id_is_not_phone_shaped")
  const input = { taskIds: [ids.targetTaskId], mode: "any", timeoutMs: 30_000, idempotencyKey: `child-wait:${lease.id}:attempt:${lease.attemptCount}` }
  const now = new Date()
  await turnStore.startStep({ owner, stepId, ordinal: 0, attempt: lease.attemptCount, inputThroughSequence: 0n,
    consumedInputIds: [], modelProfileSnapshot: {}, now })
  const callItemId = `child-wait-call-item:${lease.id}`
  await turnStore.createItem({ owner, itemId: callItemId, stepId, type: "tool_call", status: "started", phase: null,
    content: { toolCallId, toolName: "wait_subagents", toolVersion: "1", input }, now })
  await turnStore.appendEvent({ owner, id: `task:${lease.id}:event:tool-started:${toolCallId}`, itemId: callItemId, type: "tool_call.started",
    correlationId: toolCallId, causationId: null, idempotencyKey: `task:${lease.id}:event:tool-started:${toolCallId}`,
    payload: { toolCallId, toolName: "wait_subagents", taskId: lease.id } })
  const wait = await registerDurableSubagentWait(pool, { lease, stepId, targetTaskIds: input.taskIds, mode: input.mode,
    timeoutMs: input.timeoutMs, idempotencyKey: input.idempotencyKey, now })
  if (crashAfterRegistration) {
    say(`WORKER_A_REGISTERED ${JSON.stringify({ waitId: wait.waitId, stepId })}`)
    return new Promise(() => {})
  }
  await turnStore.createItem({ owner, itemId: `child-wait-result-item:${lease.id}`, stepId, type: "tool_result", status: "completed", phase: null,
    content: { toolCallId, output: wait, errorCode: null }, now })
  await turnStore.updateStep({ owner, stepId, status: "waiting_for_tool", finishReason: "tool_calls", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now })
  return { status: "waiting", result: { waitId: wait.waitId } }
}

async function resumeChild(lease, crashBeforeWaitAck = false, crashAfterWaitAck = false, crashAfterClaimResult = false, reissueOrphan = false) {
  const now = new Date()
  const pendingWait = await loadDurableSubagentWaitResume(pool, lease, now)
  const restored = await loadChildAttemptResume(pool, lease, now, pendingWait)
  const wait = pendingWait ?? restored?.durableWait
  if (!wait || !restored?.durableWait || restored.durableWait.waitId !== wait.waitId
    || restored.durableWait.stepId !== wait.stepId || restored.durableWait.attempt !== wait.attempt
    || restored.durableWait.ordinal !== wait.ordinal
    || restored.resume.nextOrdinal !== wait.ordinal + 1 || wait.attempt !== lease.attemptCount) {
    throw new Error("durable_child_wait_resume_projection_invalid")
  }
  const owner = executionOwnerFence({ kind: "task", lease })
  const stepId = `child-resume-step:${lease.id}:attempt:${lease.attemptCount}`
  say(`WORKER_B_RESTORED_WAIT_OBSERVATION ${JSON.stringify(restoredWaitObservationSummary(restored, wait, pendingWait, owner, stepId))}`)
  if (restored.childWaitOrphanCallIds?.length) say(`WORKER_B_ORPHAN_ACCOUNTING ${JSON.stringify({
    orphanCallIds: restored.childWaitOrphanCallIds,
    restoredToolCallCount: restored.resume.toolCallCount,
    orphanObserved: restored.observations.some(item => restored.childWaitOrphanCallIds.includes(item?.content?.toolCallId)),
    claimRecoveryPresent: Boolean(restored.childWaitClaimRecovery),
  })}`)
  if (!pendingWait) say(`WORKER_B_CONSUMED_WAIT_RECOVERED ${JSON.stringify({ waitId: wait.waitId, stepId: wait.stepId, attempt: wait.attempt, ordinal: wait.ordinal })}`)
  const nextOrdinal = wait.ordinal + 1
  const continuation = await turnStore.startStep({ owner, stepId, ordinal: nextOrdinal, attempt: lease.attemptCount,
    inputThroughSequence: restored.resume.inputThroughSequence, consumedInputIds: restored.resume.consumedInputIds,
    modelProfileSnapshot: {}, now })
  if (continuation.id !== stepId || continuation.ordinal <= wait.ordinal) throw new Error("durable_child_wait_continuation_identity_invalid")
  if (!pendingWait) say(`WORKER_B_CONSUMED_WAIT_STEP_REUSED ${JSON.stringify({ waitId: wait.waitId, sourceStepId: wait.stepId,
    attempt: wait.attempt, sourceOrdinal: wait.ordinal, stepId: continuation.id, ordinal: continuation.ordinal })}`)
  if (crashBeforeWaitAck) {
    say(`WORKER_B_RESUME_STEP_STARTED ${JSON.stringify({ waitId: wait.waitId, stepId, ordinal: continuation.ordinal })}`)
    return new Promise(() => {})
  }
  if (!await commitDurableSubagentWaitResume(pool, lease, { waitId: wait.waitId, stepId: wait.stepId, nextStepOrdinal: continuation.ordinal, now })) {
    throw new Error("durable_child_wait_ack_pending")
  }
  if (crashAfterWaitAck) {
    say(`WORKER_B_RESUME_ACK_COMMITTED ${JSON.stringify({ waitId: wait.waitId, stepId, ordinal: continuation.ordinal })}`)
    return claimExactWaitReissue(lease, owner, wait, continuation, now,
      { crashBeforeClaim: true, checkStaleLeaseSnapshot: true })
  }
  if (reissueOrphan) {
    const orphanCallIds = restored.childWaitOrphanCallIds ?? []
    if (orphanCallIds.length !== 1) throw new Error("durable_child_wait_restart_orphan_count_invalid")
    say(`WORKER_B_ORPHAN_RESTORED ${JSON.stringify({ waitId: wait.waitId, stepId: continuation.id,
      orphanCallIds, restoredToolCallCount: restored.resume.toolCallCount,
      orphanObserved: restored.observations.some(item => item?.content?.toolCallId === orphanCallIds[0]),
      claimRecoveryPresent: Boolean(restored.childWaitClaimRecovery) })}`)
    return claimExactWaitReissue(lease, owner, wait, continuation, now,
      { restored, expectedOrphanCallId: orphanCallIds[0] })
  }
  if (restored.childWaitClaimRecovery) await recoverClaimedWait(lease, owner, restored, crashAfterClaimResult)
  await turnStore.createItem({ owner, itemId: `child-resume-final:${wait.sourceItemId}`, stepId, type: "agent_message", status: "completed",
    phase: "final_answer", content: { text: "parent-resumed-from-durable-child-result", wait: restored.durableWait.output }, now })
  await turnStore.updateStep({ owner, stepId, status: "completed", finishReason: "stop", errorCode: null,
    inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, now })
  return { status: "completed", result: { finalText: "parent-resumed-from-durable-child-result", waitId: wait.waitId } }
}

async function stop(code) {
  if (stopped) return
  stopped = true
  try { await resolver?.close() } catch (error) { process.stderr.write(`resolver_close_failed:${String(error)}\n`) }
  try { await worker.close() } catch (error) { process.stderr.write(`worker_close_failed:${String(error)}\n`) }
  try { await redis.quit() } catch { redis.disconnect() }
  try { await pool.end() } catch (error) { process.stderr.write(`pool_close_failed:${String(error)}\n`) }
  process.exit(code)
}

const worker = new Worker(queueName, async job => {
  if (job.data.taskId !== ids.waiterTaskId) throw new Error("unexpected_subagent_task")
  const identity = parseSubagentDispatchJobId(job.id, job.data.taskId)
  if (!identity) throw new Error("invalid_subagent_dispatch_identity")
  const execute = mode === "worker-a" ? ({ lease }) => waitForChild(lease)
    : mode === "worker-a-crash" ? ({ lease }) => waitForChild(lease, true)
      : mode === "worker-b-crash-before-resume" ? ({ lease }) => {
        say(`WORKER_B_RESUME_NOT_STARTED ${JSON.stringify({ taskId: lease.id, attemptCount: lease.attemptCount })}`)
        return new Promise(() => {})
      }
      : mode === "worker-b-crash-resume" ? ({ lease }) => resumeChild(lease, true)
      : mode === "worker-b-crash-after-wait-ack" ? ({ lease }) => resumeChild(lease, false, true)
      : mode === "worker-b-crash-before-claim" ? ({ lease }) => resumeChild(lease, false, true)
        : mode === "worker-b-crash-after-orphan-reissue" ? ({ lease }) => resumeChild(lease, false, false, false, true)
      : mode === "worker-b-crash-after-claim-result" ? ({ lease }) => resumeChild(lease, false, false, true)
      : mode === "worker-b" ? ({ lease }) => resumeChild(lease) : undefined
  if (!execute) throw new Error("invalid_fixture_mode")
  const executeWithDiagnostics = async input => {
    try { return await execute(input) }
    catch (error) {
      if (crashCutModes.has(mode)) process.stderr.write(`CRASH_CUT_EXECUTOR_ERROR ${JSON.stringify({ mode, ...boundedErrorDetails(error) })}\n`)
      throw error
    }
  }
  return runSubagentQueueJob(pool, manager, executeWithDiagnostics, job.data, identity)
}, { connection: redis, concurrency: 1, lockDuration: 15_000, skipVersionCheck: true })

worker.on("completed", (job, result) => {
  if (job.data.taskId !== ids.waiterTaskId) return
  if (crashCutModes.has(mode)) {
    process.stderr.write(`UNEXPECTED_CRASH_CUT_COMPLETION ${JSON.stringify({ mode, result, taskId: ids.waiterTaskId })}\n`)
    void stop(1)
    return
  }
  const marker = mode === "worker-a" ? "WORKER_A_WAITING" : "WORKER_B_RESUMED"
  say(`${marker} ${JSON.stringify({ result, taskId: ids.waiterTaskId })}`)
  void stop(0)
})
worker.on("failed", (job, error) => {
  if (job?.data.taskId !== ids.waiterTaskId) return
  process.stderr.write(`WORKER_FAILED ${error.message}\n`)
  void stop(1)
})

try {
  if (mode.startsWith("worker-b")) {
    const diagnosticsEnabled = mode === "worker-b-crash-resume"
    const processStartedAt = diagnosticsEnabled ? new Date().toISOString() : undefined
    const before = diagnosticsEnabled ? await readRecoveryStateSnapshot(pool, ids) : undefined
    if (before?.diagnostic === "query_failed") {
      throw new Error(`recovery_pre_snapshot_query_failed:${before.code ?? "unknown"}`)
    }
    const recoveryStartedAt = diagnosticsEnabled ? new Date().toISOString() : undefined
    const recovered = await manager.recover()
    const recoveryCompletedAt = diagnosticsEnabled ? new Date().toISOString() : undefined
    if (diagnosticsEnabled && !recovered.rows.some(row => row.id === ids.waiterTaskId)) {
      const after = await readRecoveryStateSnapshot(pool, ids)
      say(`WORKER_B_RECOVERY_DIAGNOSTIC ${JSON.stringify({ processStartedAt, recoveryStartedAt, recoveryCompletedAt,
        candidateScan: { targetPageRank: ids.recoveryTargetPageRank ?? null, candidateCount: ids.recoveryCandidateCount ?? null,
          fixtureBlockerCount: ids.recoveryFixtureBlockerCount ?? null, observedAt: ids.recoveryCandidateObservedAt ?? null },
        recovery: { reclaimed: recovered.reclaimed, terminal: recovered.terminal, targetReclaimed: recovered.rows.some(row => row.id === ids.waiterTaskId) },
        before, after })}`)
    }
    say(`WORKER_B_RECOVERED ${JSON.stringify({ reclaimed: recovered.reclaimed, terminal: recovered.terminal, rows: recovered.rows.map(row => ({ id: row.id, status: row.status })) })}`)
  }
  await worker.waitUntilReady()
  const readyMarker = readyMarkerByMode[mode]
  if (!readyMarker) throw new Error("invalid_fixture_mode")
  say(readyMarker)
} catch (error) {
  process.stderr.write(`WORKER_START_FAILED ${String(error)}\n`)
  await stop(1)
}
