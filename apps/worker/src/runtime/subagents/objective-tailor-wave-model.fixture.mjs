import { createObjectiveTailorWaveDraftModel } from "./objective-tailor-wave-draft.fixture.mjs"
import { createObjectiveTailorWaveSourceModel, diagnoseObjectiveTailorWaveOne, diagnoseObjectiveTailorWaveOneReceipt,
  diagnoseObjectiveTailorWaveGraph, fixtureAllTasksCompleted, fixtureObservation, fixtureToolCalls, fixtureToolResult, sourcePlan } from "./objective-tailor-wave-source.fixture.mjs"

const WAIT_PREFIX = "p3-1336-", SOURCE_KEYS = ["scout-greenhouse", "scout-lever", "scout-workday", "analyst-greenhouse-a", "analyst-greenhouse-b",
  "analyst-lever", "analyst-workday"]
const ANALYST_KEYS = SOURCE_KEYS.filter(key => key.startsWith("analyst-"))
const MODEL_PROFILE = { provider: "fixture", model: "objective-tailor-wave", nativeTools: true, structuredOutput: true,
  streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
  supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" }

export function createObjectiveTailorWaveModels({ deps, userId, sessionId, turnId, mode, say, waitForCommand }) {
  const blockedWriters = new Set()
  let wave1Identity
  let coverageFailureReported = false
  const childModel = input => {
    if (input?.task?.role === "scout" || input?.task?.role === "analyst") {
      return createObjectiveTailorWaveSourceModel({ task: input.task, userId, sessionId, turnId, profile: MODEL_PROFILE,
        roleResultSchema: deps.roleResultSchema, say })
    }
    return createObjectiveTailorWaveDraftModel({ deps, task: input?.task, userId, sessionId, turnId, profile: MODEL_PROFILE, mode,
      say, waitForCommand, blockedWriters })
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
        wave1Identity = sourceAndSlotIdentity(currentGraph(request))
        if (!wave1Identity) throw new Error("fixture_wave1_identity_unavailable")
        yield* emit(`p3-1336-ordinary-plan:${turnId}`, "agent.plan", {
          expectedRevision: currentGraph(request).revision,
          nodes: [{ key: "ordinary-after-wave", templateId: "scout", goal: "This generic append must remain closed.",
            successCriteria: ["Read a source"], dependsOn: [] }],
        })
        void wave
        return
      }
      const ordinaryPlan = plans.find(call => call.id === `p3-1336-ordinary-plan:${turnId}`)
      if (tailors.length === 1 && ordinaryPlan && !hasPhase(request, "wave1", turnId)) {
        const error = fixtureToolResult(request, ordinaryPlan), graph = currentGraph(request)
        const currentIdentity = sourceAndSlotIdentity(graph)
        if (!error?.error || !currentIdentity || JSON.stringify(currentIdentity) !== JSON.stringify(wave1Identity)) {
          throw new Error("fixture_ordinary_plan_append_was_not_closed")
        }
        say(`TAILOR_ORDINARY_PLAN_REJECTED ${graph.revision}`)
        const wave = acceptedTailorReceipt(request, tailors[0], 8)
        yield* emitWait(request, "wave1", turnId, wave.nodes.map(node => node.taskId)); return
      }
      if (tailors.length === 1 && ordinaryPlan && hasPhase(request, "wave1", turnId) && !phaseReady(request, "wave1", turnId)) {
        const wave = acceptedTailorReceipt(request, tailors[0], 8)
        yield* emitWait(request, "wave1", turnId, wave.nodes.map(node => node.taskId)); return
      }
      if (tailors.length === 1 && phaseReady(request, "wave1", turnId)) {
        say("TAILOR_WAVE1_WAIT_READY")
        yield* emitWaveReplay(request, turnId, tailors[0]); return
      }
      if (tailors.length === 2 && phaseReady(request, "wave1", turnId)) {
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
        const graph = currentGraph(request)
        yield* emit(`p3-1336-wrong-feedback:${turnId}`, "agent.tailor", {
          expectedRevision: graph.revision, correctionSlotId: "tailor-1",
        })
        return
      }
      const wrongFeedback = tailors.find(call => call.input?.correctionSlotId === "tailor-1")
      const wrongResult = wrongFeedback ? fixtureToolResult(request, wrongFeedback) : undefined
      if (tailors.length === 4 && wrongResult && !wrongResult.error) throw new Error("fixture_wrong_feedback_was_accepted")
      if (tailors.length === 4 && wrongFeedback && wrongResult?.error && !tailors.some(call => call.input?.correctionSlotId === "tailor-2")) {
        const graph = currentGraph(request)
        if (graph.revision !== Number(wrongFeedback.input?.expectedRevision)) throw new Error("fixture_wrong_feedback_changed_graph")
        say("TAILOR_WRONG_FEEDBACK_REJECTED")
        yield* emit(`p3-1336-correct-slot-2:${turnId}`, "agent.tailor", { expectedRevision: graph.revision, correctionSlotId: "tailor-2" })
        return
      }
      if (tailors.length === 5 && !tailors.some(call => call.input?.correctionSlotId === "tailor-6")) {
        const receipt = acceptedCorrectionReceipt(request, tailors[4])
        const graph = currentGraph(request)
        yield* emit(`p3-1336-correct-slot-6:${turnId}`, "agent.tailor", { expectedRevision: graph.revision, correctionSlotId: "tailor-6" })
        void receipt
        return
      }
      if (tailors.length === 6 && !hasPhase(request, "corrections", turnId)) {
        const first = acceptedCorrectionReceipt(request, tailors[4])
        const second = acceptedCorrectionReceipt(request, tailors[5])
        yield* emitWait(request, "corrections", turnId, [...first.nodes, ...second.nodes].map(node => node.taskId)); return
      }
      if (tailors.length === 6 && hasPhase(request, "corrections", turnId) && !phaseReady(request, "corrections", turnId)) {
        const first = acceptedCorrectionReceipt(request, tailors[4])
        const second = acceptedCorrectionReceipt(request, tailors[5])
        yield* emitWait(request, "corrections", turnId, [...first.nodes, ...second.nodes].map(node => node.taskId)); return
      }
      if (phaseReady(request, "corrections", turnId)) {
        say("TAILOR_CORRECTIONS_WAIT_READY")
        say("TAILOR_FINAL_OUTCOME 6 2")
        yield { type: "text_delta", text: "The eight source-backed roles were reviewed: six are ready, and two were rejected." }
        yield { type: "completed", finishReason: "stop" }
        return
      }
      throw new Error("fixture_root_phase_unrecognized")
      } catch {
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
function phaseReady(request, phase, turnId) {
  const prefix = `${WAIT_PREFIX}${phase}-wait:${turnId}:`, calls = fixtureToolCalls(request, "agent.wait")
    .filter(call => typeof call.input?.idempotencyKey === "string" && call.input.idempotencyKey.startsWith(prefix))
  const result = calls.length ? fixtureToolResult(request, calls.at(-1)) : undefined
  if (result?.error) throw new Error("fixture_wait_result_error")
  if (result?.value?.status !== "ready") return false
  const expected = calls.at(-1)?.input?.taskIds
  return Array.isArray(expected) && expected.length > 0 && fixtureAllTasksCompleted(result.value, expected)
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
function acceptedCorrectionReceipt(request, call) {
  const result = fixtureToolResult(request, call), value = result?.value
  const expectedRevision = call.input?.expectedRevision
  if (!result || result.error || value?.status !== "accepted" || !Number.isSafeInteger(expectedRevision)
    || value.revision !== expectedRevision + 1
    || !Array.isArray(value.nodes) || value.nodes.length !== 2 || value.readyTaskIds?.length !== 1) throw new Error("fixture_correction_receipt_invalid")
  return value
}
function assertReplayMatches(request, original, replay) {
  const first = acceptedTailorReceipt(request, original, 8), duplicate = acceptedTailorReceipt(request, replay, 8)
  if (duplicate.status !== "duplicate" || JSON.stringify(first.nodes) !== JSON.stringify(duplicate.nodes)
    || JSON.stringify(first.readyTaskIds) !== JSON.stringify(duplicate.readyTaskIds)) throw new Error("fixture_wave_replay_identity_mismatch")
}
function currentGraph(request) { return fixtureObservation(request, "task_graph_current") }
function graphKeys(graph) { return Array.isArray(graph.nodes) ? graph.nodes.map(node => node?.key).filter(key => typeof key === "string") : [] }
function sourceAndSlotIdentity(graph) {
  const sourceKeys = graphKeys(graph).sort(), expectedSourceKeys = [...SOURCE_KEYS].sort()
  if (sourceKeys.length !== expectedSourceKeys.length || sourceKeys.some((key, index) => key !== expectedSourceKeys[index])) return undefined
  const slots = graph?.objectiveTailorWave?.slots
  if (!Array.isArray(slots) || slots.length !== 4) return undefined
  const identity = slots.map(slot => [slot?.slotId, slot?.sourceAnalystNodeKey, slot?.initial?.writer?.taskId, slot?.initial?.reviewer?.taskId])
  if (identity.some((slot, index) => slot[0] !== `tailor-${index + 1}` || slot.some(value => typeof value !== "string")
    || !ANALYST_KEYS.includes(slot[1]))) return undefined
  return { sourceKeys, slots: identity }
}
function emit(id, name, args) { return [{ type: "tool_call_completed", callId: id, name, arguments: args }, { type: "completed", finishReason: "tool_calls" }] }
function assertRequestScope(request, expected) {
  if (request?.metadata?.userId !== expected.userId || request.metadata.sessionId !== expected.sessionId
    || request.metadata.turnId !== expected.turnId || request.metadata.taskId !== expected.taskId) {
    throw new Error("fixture_root_model_scope_mismatch")
  }
}
