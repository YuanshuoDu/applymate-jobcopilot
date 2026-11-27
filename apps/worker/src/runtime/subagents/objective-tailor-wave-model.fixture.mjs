import { createObjectiveTailorWaveDraftModel, waitForObjectiveTailorWave1WriterGate } from "./objective-tailor-wave-draft.fixture.mjs"
import { createObjectiveTailorWaveSourceModel, diagnoseObjectiveTailorWaveOne, diagnoseObjectiveTailorWaveOneReceipt,
  diagnoseObjectiveTailorWaveGraph, fixturePhaseReady, fixtureObservation,
  fixtureToolCalls, fixtureToolResult, objectiveTailorCorrectionReceiptStatus, objectiveTailorWaveDiagnosticCode,
  objectiveTailorCorrectionRetryEligible, objectiveTailorWaveIdentity, sourcePlan } from "./objective-tailor-wave-source.fixture.mjs"
import { objectiveTailorWaveSlotsFromCurrentGraph, parseObjectiveTailorWaveOutcomeObservation }
  from "../canonical-turn-objective-tailor-wave-context.ts"

const WAIT_PREFIX = "p3-1336-", SOURCE_KEYS = ["scout-greenhouse", "scout-lever", "scout-workday", "analyst-greenhouse-a", "analyst-greenhouse-b",
  "analyst-lever", "analyst-workday"]
const ANALYST_KEYS = SOURCE_KEYS.filter(key => key.startsWith("analyst-"))
const OUTCOME_SCHEMA = "agent-harness.v2.objective-tailor-wave-outcomes.v1"
const MODEL_PROFILE = { provider: "fixture", model: "objective-tailor-wave", nativeTools: true, structuredOutput: true,
  streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
  supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" }

export function createObjectiveTailorWaveModels({ deps, userId, sessionId, turnId, mode, say, waitForCommand }) {
  const blockedWriters = new Set()
  const pauseWave1Writer = task => waitForObjectiveTailorWave1WriterGate({ task, mode, say, waitForCommand, blockedWriters, expectedScope: { userId, sessionId, turnId } })
  const phaseReady = (request, phase, activeTurnId) => fixturePhaseReady(request, phase, activeTurnId, say, WAIT_PREFIX)
  let wave1Identity, correctionSourceIdentity, correctionSlotIds = [], readyNegativeProbeSlotId
  let coverageFailureReported = false
  const childModel = async input => {
    if (input?.task?.role === "scout" || input?.task?.role === "analyst") {
      return createObjectiveTailorWaveSourceModel({ task: input.task, userId, sessionId, turnId, profile: MODEL_PROFILE,
        roleResultSchema: deps.roleResultSchema, say })
    }
    if (input?.task?.role === "writer") await pauseWave1Writer(input.task)
    return createObjectiveTailorWaveDraftModel({ deps, task: input?.task, userId, sessionId, turnId, profile: MODEL_PROFILE })
  }
  const rootModel = ({ userId: requestUserId, state }) => {
    const scope = state?.scope
    if (requestUserId !== userId || scope?.userId !== userId
      || state?.snapshot?.goal?.id !== `turn-goal:${turnId}` || typeof state?.rootTaskId !== "string") {
      return { adapter: { id: "objective-tailor-nontarget-guard", profile: MODEL_PROFILE,
        async *stream() { throw new Error("fixture_turn_scope_mismatch") } }, registry: {}, candidates: [] }
    }
    const rootTaskId = state.rootTaskId
    return { adapter: { id: "objective-tailor-root-fixture", profile: MODEL_PROFILE, async *stream(request) {
      say("TAILOR_ROOT_STREAM_ENTERED")
      try {
      assertRequestScope(request, { userId, sessionId, turnId, taskId: rootTaskId })
      say("TAILOR_ROOT_REQUEST_SCOPE_OK")
      const plans = fixtureToolCalls(request, "agent.plan"), tailors = fixtureToolCalls(request, "agent.tailor")
      const laterCorrectionCalls = correctionSlotIds[1]
        ? tailors.filter(call => call.input?.correctionSlotId === correctionSlotIds[1]) : []
      if (!coverageFailureReported && plans.some(call => {
        const result = fixtureToolResult(request, call)
        return result?.error === true && result.value?.code === "task_graph_objective_coverage_incomplete"
      })) { coverageFailureReported = true; say("TAILOR_PLAN_FAILED objective_coverage_incomplete") }
      if (!plans.length) { say("TAILOR_ROOT_INITIAL_PLAN_REQUESTED"); yield* emit(`p3-1336-source-plan:${turnId}`, "agent.plan", sourcePlan()); return }
      if (plans.length === 1 && !tailors.length) {
        const receipt = acceptedReceipt(request, plans[0], 7)
        const scouts = taskIdsForKeys(receipt, SOURCE_KEYS.filter(key => key.startsWith("scout-")))
        const analysts = taskIdsForKeys(receipt, ANALYST_KEYS)
        if (!phaseReady(request, "wave-source", turnId)) {
          say("TAILOR_ROOT_SOURCE_WAIT_REQUESTED")
          yield* emitWait(request, "wave-source", turnId, scouts); return
        }
        if (!phaseReady(request, "wave-analyst", turnId)) {
          yield* emitWait(request, "wave-analyst", turnId, analysts); return
        }
        say("TAILOR_SOURCE_GRAPH_READY 7")
        yield* emitWave(turnId, "wave1", request, 4, say); return
      }
      if (tailors.length === 1 && !plans.some(call => call.id === `p3-1336-ordinary-plan:${turnId}`)) {
        diagnoseObjectiveTailorWaveOneReceipt(request, tailors[0], say)
        const wave = acceptedTailorReceipt(request, tailors[0], 8)
        const graph = currentGraph(request)
        wave1Identity = objectiveTailorWaveIdentity(graph, SOURCE_KEYS, ANALYST_KEYS)
        diagnosePostAppendGraph(graph, wave1Identity, say)
        if (!wave1Identity) throw new Error("fixture_wave1_identity_unavailable")
        const scoutProbe = sourcePlan().nodes[0]
        say("TAILOR_WAVE1_ORDINARY_PLAN_PROBE_EMITTED")
        yield* emit(`p3-1336-ordinary-plan:${turnId}`, "agent.plan", {
          expectedRevision: currentGraph(request).revision,
          nodes: [{ ...scoutProbe, key: "ordinary-after-wave", goal: "Search greenhouse for saved roles" }],
        })
        void wave
        return
      }
      const ordinaryPlan = plans.find(call => call.id === `p3-1336-ordinary-plan:${turnId}`)
      if (tailors.length === 1 && ordinaryPlan && !hasPhase(request, "wave1", turnId)) {
        const error = fixtureToolResult(request, ordinaryPlan), graph = currentGraph(request)
        const receiptStatus = !error ? "MISSING" : error.error === true ? "DENIED"
          : error.error === false ? "ACCEPTED" : "OTHER"
        say(`TAILOR_WAVE1_ORDINARY_PLAN_RECEIPT_${receiptStatus}`)
        say(`TAILOR_WAVE1_ORDINARY_PLAN_ERROR_CODE ${objectiveTailorWaveDiagnosticCode(error?.value)}`)
        const currentIdentity = objectiveTailorWaveIdentity(graph, SOURCE_KEYS, ANALYST_KEYS)
        if (!error?.error || !currentIdentity || JSON.stringify(currentIdentity) !== JSON.stringify(wave1Identity)) {
          throw new Error("fixture_ordinary_plan_append_was_not_closed")
        }
        say(`TAILOR_ORDINARY_PLAN_REJECTED ${graph.revision}`)
        const wave = acceptedTailorReceipt(request, tailors[0], 8)
        say("TAILOR_WAVE1_WAIT_EMITTED")
        yield* emitWait(request, "wave1", turnId, wave.nodes.map(node => node.taskId)); return
      }
      if (tailors.length === 1 && ordinaryPlan && hasPhase(request, "wave1", turnId) && !phaseReady(request, "wave1", turnId)) {
        const wave = acceptedTailorReceipt(request, tailors[0], 8)
        say("TAILOR_WAVE1_WAIT_EMITTED")
        yield* emitWait(request, "wave1", turnId, wave.nodes.map(node => node.taskId)); return
      }
      if (tailors.length === 1 && phaseReady(request, "wave1", turnId)) {
        say("TAILOR_WAVE1_WAIT_READY")
        say("TAILOR_WAVE1_REPLAY_EMITTED")
        yield* emitWaveReplay(request, turnId, tailors[0]); return
      }
      if (tailors.length === 2 && phaseReady(request, "wave1", turnId)) {
        const replayResult = fixtureToolResult(request, tailors[1])
        say(`TAILOR_WAVE1_REPLAY_RESULT_${replayResult ? "PRESENT" : "MISSING"}`)
        assertReplayMatches(request, tailors[0], tailors[1])
        say("TAILOR_WAVE1_REPLAY_MATCHED")
        yield* emitWave(turnId, "wave2", request, 4, say); return
      }
      if (tailors.length === 3 && !hasPhase(request, "wave2", turnId)) {
        const wave = acceptedTailorReceipt(request, tailors[2], 8)
        yield* emitWait(request, "wave2", turnId, wave.nodes.map(node => node.taskId)); return
      }
      if (tailors.length === 3 && hasPhase(request, "wave2", turnId) && !phaseReady(request, "wave2", turnId)) {
        const wave = acceptedTailorReceipt(request, tailors[2], 8)
        yield* emitWait(request, "wave2", turnId, wave.nodes.map(node => node.taskId)); return
      }
      if (tailors.length === 3 && phaseReady(request, "wave2", turnId)) {
        say("TAILOR_WAVE2_WAIT_READY")
        const outcomes = readVerifiedWaveOutcomes(request)
        const observedStatuses = outcomes.slots.map(slot => slot.status)
        if (JSON.stringify(observedStatuses) !== JSON.stringify([
          "ready", "needs_revision", "rejected", "ready", "ready", "needs_revision", "ready", "rejected",
        ])) throw new Error("fixture_observation_unavailable")
        correctionSlotIds = outcomes.slots.filter(slot => slot.effectivePair === "initial"
          && slot.status === "needs_revision").map(slot => slot.slotId)
        readyNegativeProbeSlotId = outcomes.slots.find(slot => slot.effectivePair === "initial"
          && slot.status === "ready")?.slotId
        if (correctionSlotIds.length !== 2 || new Set(correctionSlotIds).size !== 2
          || typeof readyNegativeProbeSlotId !== "string" || correctionSlotIds.includes(readyNegativeProbeSlotId)) {
          throw new Error("fixture_observation_unavailable")
        }
        say(`TAILOR_WAVE2_VERIFIED_OUTCOMES_CONSUMED ${outcomes.graphRevision} ${outcomes.slots.length} ${correctionSlotIds.length}`)
        const graph = currentGraph(request)
        yield* emit(`p3-1336-wrong-feedback:${turnId}`, "agent.tailor", {
          expectedRevision: graph.revision, correctionSlotId: readyNegativeProbeSlotId,
        })
        return
      }
      const wrongFeedback = readyNegativeProbeSlotId
        ? tailors.find(call => call.input?.correctionSlotId === readyNegativeProbeSlotId) : undefined
      const wrongResult = wrongFeedback ? fixtureToolResult(request, wrongFeedback) : undefined
      if (tailors.length === 4 && wrongResult && !wrongResult.error) throw new Error("fixture_wrong_feedback_was_accepted")
      const firstCorrectionSlotId = correctionSlotIds[0]
      if (tailors.length === 4 && wrongFeedback && wrongResult?.error && firstCorrectionSlotId
        && !tailors.some(call => call.input?.correctionSlotId === firstCorrectionSlotId)) {
        const graph = currentGraph(request)
        if (graph.revision !== Number(wrongFeedback.input?.expectedRevision)) throw new Error("fixture_wrong_feedback_changed_graph")
        say("TAILOR_WRONG_FEEDBACK_REJECTED")
        yield* emit(`p3-1336-correct-slot-${slotOrdinal(firstCorrectionSlotId)}:${turnId}`, "agent.tailor",
          { expectedRevision: graph.revision, correctionSlotId: firstCorrectionSlotId })
        return
      }
      if (tailors.length === 5 && !laterCorrectionCalls.length) {
        const secondCorrectionSlotId = correctionSlotIds[1]
        if (!firstCorrectionSlotId || !secondCorrectionSlotId) throw new Error("fixture_observation_unavailable")
        acceptedCorrectionReceipt(request, tailors[4], say, slotMarker(firstCorrectionSlotId))
        const graph = currentGraph(request)
        correctionSourceIdentity = objectiveTailorWaveIdentity(graph, SOURCE_KEYS, ANALYST_KEYS, 8, secondCorrectionSlotId)
        if (!correctionSourceIdentity) throw new Error("fixture_correction_receipt_invalid")
        yield* emit(`p3-1336-correct-slot-${slotOrdinal(secondCorrectionSlotId)}-attempt-1:${turnId}`, "agent.tailor",
          { expectedRevision: graph.revision, correctionSlotId: secondCorrectionSlotId }); return
      }
      const lastLaterCorrection = laterCorrectionCalls.at(-1), lastLaterCorrectionResult = lastLaterCorrection && fixtureToolResult(request, lastLaterCorrection)
      if (lastLaterCorrectionResult?.error) {
        const secondCorrectionSlotId = correctionSlotIds[1]
        if (!secondCorrectionSlotId) throw new Error("fixture_observation_unavailable")
        const graph = currentGraph(request), currentIdentity = objectiveTailorWaveIdentity(graph, SOURCE_KEYS, ANALYST_KEYS, 8, secondCorrectionSlotId)
        if (!objectiveTailorCorrectionRetryEligible(lastLaterCorrectionResult, lastLaterCorrection, graph,
          correctionSourceIdentity, currentIdentity, laterCorrectionCalls.length)) throw new Error("fixture_correction_receipt_invalid")
        say(`TAILOR_CORRECTION_SLOT${slotOrdinal(secondCorrectionSlotId)}_RETRY_REVISION_MISMATCH`)
        yield* emit(`p3-1336-correct-slot-${slotOrdinal(secondCorrectionSlotId)}-attempt-${laterCorrectionCalls.length + 1}:${turnId}`,
          "agent.tailor", { expectedRevision: graph.revision, correctionSlotId: secondCorrectionSlotId }); return
      }
      if (laterCorrectionCalls.length) {
        const [firstCorrectionId, secondCorrectionId] = correctionSlotIds
        if (!firstCorrectionId || !secondCorrectionId) throw new Error("fixture_observation_unavailable")
        const first = acceptedCorrectionReceipt(request, tailors[4], say, slotMarker(firstCorrectionId))
        const accepted = laterCorrectionCalls.filter(call => objectiveTailorCorrectionReceiptStatus(
          fixtureToolResult(request, call), call.input?.expectedRevision) === "ACCEPTED")
        if (tailors[4]?.input?.correctionSlotId !== firstCorrectionId
          || accepted.length !== 1) throw new Error("fixture_correction_receipt_invalid")
        const second = acceptedCorrectionReceipt(request, accepted[0], say, slotMarker(secondCorrectionId))
        if (!phaseReady(request, "corrections", turnId)) { yield* emitWait(request, "corrections", turnId, [...first.nodes, ...second.nodes].map(node => node.taskId)); return }
        const finalOutcomes = readVerifiedWaveOutcomes(request)
        const unresolved = finalOutcomes.slots.some(slot => ["pending", "needs_revision", "stale", "failed"].includes(slot.status))
        const readyCount = finalOutcomes.slots.filter(slot => slot.status === "ready").length
        const rejectedCount = finalOutcomes.slots.filter(slot => slot.status === "rejected").length
        if (unresolved || readyCount !== 6 || rejectedCount !== 2) throw new Error("fixture_observation_unavailable")
        say("TAILOR_CORRECTIONS_WAIT_READY")
        say(`TAILOR_FINAL_OUTCOME ${readyCount} ${rejectedCount}`)
        yield { type: "text_delta", text: `The eight source-backed roles were reviewed: ${readyCount} are ready, and ${rejectedCount} were rejected.` }; yield { type: "completed", finishReason: "stop" }; return
      }
      throw new Error("fixture_root_phase_unrecognized")
      } catch (error) {
        say(`TAILOR_ROOT_STREAM_FAILURE ${objectiveTailorWaveDiagnosticCode(error)}`)
        say("TAILOR_ROOT_STREAM_FAILED")
        throw new Error("fixture_root_stream_failed")
      }
    } }, registry: {}, candidates: [] }
  }
  return { rootModel, childModel }
}
function emitWave(turnId, phase, sourceRequest, count, say) {
  const graph = phase === "wave1" ? diagnoseObjectiveTailorWaveGraph(sourceRequest, say) : currentGraph(sourceRequest)
  const catalog = phase === "wave1" ? diagnoseObjectiveTailorWaveOne(sourceRequest, graph.revision, say)
    : fixtureObservation(sourceRequest, "objective_tailor_wave_candidate_catalog")?.catalog
  const tool = sourceRequest.tools?.find(value => value?.name === "agent.tailor")
  if (!catalog || catalog.graphRevision !== graph.revision || catalog.candidates.length !== (phase === "wave1" ? 8 : 4)
    || tool?.version !== "2") throw new Error("fixture_wave_catalog_unavailable")
  const candidateRefs = catalog.candidates.slice(0, count).map(value => value.candidateRef)
  if (candidateRefs.length !== count || new Set(candidateRefs).size !== count) {
    if (phase === "wave1") say("TAILOR_WAVE1_CANDIDATE_REFS_INVALID")
    throw new Error("fixture_wave_candidates_invalid")
  }
  if (phase === "wave1") say("TAILOR_WAVE1_TOOL_CALL_EMITTED")
  return emit(`p3-1336-${phase}:${turnId}`, "agent.tailor", { expectedRevision: graph.revision, candidateRefs })
}
function emitWaveReplay(request, turnId, prior) {
  const args = prior.input
  if (!args || !Array.isArray(args.candidateRefs) || args.candidateRefs.length !== 4) throw new Error("fixture_wave_replay_args_missing")
  return emit(`p3-1336-wave1-replay:${turnId}`, "agent.tailor", { expectedRevision: args.expectedRevision, candidateRefs: [...args.candidateRefs] })
}
function emitWait(request, phase, turnId, taskIds) {
  const prefix = `${WAIT_PREFIX}${phase}-wait:${turnId}:`, calls = fixtureToolCalls(request, "agent.wait")
    .filter(call => typeof call.input?.idempotencyKey === "string" && call.input.idempotencyKey.startsWith(prefix))
  const last = calls.at(-1), previous = last && fixtureToolResult(request, last)
  if (last && previous?.value?.status === "ready") return []
  const poll = calls.length + 1, key = `${prefix}${poll}`
  return emit(`${key}:call`, "agent.wait", { idempotencyKey: key, taskIds: [...taskIds], mode: "all", timeoutMs: 30_000 })
}
function hasPhase(request, phase, turnId) {
  const prefix = `${WAIT_PREFIX}${phase}-wait:${turnId}:`
  return fixtureToolCalls(request, "agent.wait").some(call => call.input?.idempotencyKey?.startsWith(prefix))
}
function acceptedReceipt(request, call, nodeCount) {
  const result = fixtureToolResult(request, call), value = result?.value
  const expectedRevision = call.input?.expectedRevision
  if (!result || result.error || value?.status !== "accepted" || !Number.isSafeInteger(expectedRevision)
    || value.revision !== expectedRevision + 1
    || !Array.isArray(value.nodes) || value.nodes.length !== nodeCount || !Array.isArray(value.readyTaskIds)) {
    throw new Error("fixture_plan_receipt_invalid")
  }
  return value
}
function taskIdsForKeys(receipt, keys) {
  const ids = keys.map(key => receipt.nodes.find(node => node?.key === key)?.taskId)
  if (ids.some(id => typeof id !== "string" || !id) || new Set(ids).size !== keys.length) throw new Error("fixture_source_plan_receipt_invalid")
  return ids
}
function acceptedTailorReceipt(request, call, nodeCount) {
  const result = fixtureToolResult(request, call), value = result?.value
  const expectedRevision = call.input?.expectedRevision
  if (!result || result.error || !["accepted", "duplicate"].includes(value?.status)
    || !Number.isSafeInteger(expectedRevision) || value.revision !== expectedRevision + 1
    || !Array.isArray(value.nodes) || value.nodes.length !== nodeCount
    || value.readyTaskIds?.length !== 4) throw new Error("fixture_wave_receipt_invalid")
  return value
}
function acceptedCorrectionReceipt(request, call, say, slot) {
  const result = fixtureToolResult(request, call), value = result?.value
  const status = objectiveTailorCorrectionReceiptStatus(result, call.input?.expectedRevision)
  say(`TAILOR_CORRECTION_${slot}_RECEIPT_${status}`)
  if (status !== "ACCEPTED") throw new Error("fixture_correction_receipt_invalid")
  return value
}
function assertReplayMatches(request, original, replay) {
  const first = acceptedTailorReceipt(request, original, 8), duplicate = acceptedTailorReceipt(request, replay, 8)
  if (duplicate.status !== "duplicate" || JSON.stringify(first.nodes) !== JSON.stringify(duplicate.nodes)
    || JSON.stringify(first.readyTaskIds) !== JSON.stringify(duplicate.readyTaskIds)) throw new Error("fixture_wave_replay_identity_mismatch")
}
function readVerifiedWaveOutcomes(request) {
  const graph = currentGraph(request), observation = plainRecord(fixtureObservation(request, "objective_tailor_wave_outcomes"))
  const current = objectiveTailorWaveSlotsFromCurrentGraph(graph)
  if (!observation || !exactKeys(observation, ["kind", "schemaVersion", "graphRevision", "slots"])
    || observation.kind !== "objective_tailor_wave_outcomes" || observation.schemaVersion !== OUTCOME_SCHEMA
    || !current || current.graphRevision !== graph?.revision || current.slots.length !== 8) {
    throw new Error("fixture_observation_unavailable")
  }
  const parsed = parseObjectiveTailorWaveOutcomeObservation({ schemaVersion: observation.schemaVersion,
    graphRevision: observation.graphRevision, slots: observation.slots }, current.graphRevision, current.slots)
  if (!parsed || parsed.slots.length !== 8) throw new Error("fixture_observation_unavailable")
  return parsed
}
function plainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) return undefined
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) return undefined
    }
    return value
  } catch { return undefined }
}
function exactKeys(value, expected) {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
}
function slotOrdinal(slotId) {
  const match = /^tailor-([1-8])$/.exec(slotId)
  if (!match) throw new Error("fixture_observation_unavailable")
  return Number(match[1])
}
function slotMarker(slotId) { return `SLOT${slotOrdinal(slotId)}` }
function currentGraph(request) { return fixtureObservation(request, "task_graph_current") }
function diagnosePostAppendGraph(graph, identity, say) {
  say(Array.isArray(graph?.nodes) ? "TAILOR_WAVE1_POST_APPEND_GRAPH_OBSERVED" : "TAILOR_WAVE1_POST_APPEND_GRAPH_UNAVAILABLE")
  say(identity ? "TAILOR_WAVE1_POST_APPEND_IDENTITY_VALID" : "TAILOR_WAVE1_POST_APPEND_IDENTITY_INVALID")
}
function emit(id, name, args) { return [{ type: "tool_call_completed", callId: id, name, arguments: args }, { type: "completed", finishReason: "tool_calls" }] }
function assertRequestScope(request, expected) {
  if (request?.metadata?.userId !== expected.userId || request.metadata.sessionId !== expected.sessionId
    || request.metadata.turnId !== expected.turnId || request.metadata.taskId !== expected.taskId) {
    throw new Error("fixture_root_model_scope_mismatch")
  }
}
