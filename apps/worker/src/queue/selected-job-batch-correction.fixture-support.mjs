const MAX_WAIT_CALLS = 8
const WAIT_TIMEOUT_MS = 30_000
const SLOTS = ["slot-1", "slot-2"]
const JOB1_FEEDBACK_MARKER = "BATCH_FEEDBACK_JOB_1_ONLY"
const JOB2_FEEDBACK_MARKER = "BATCH_FEEDBACK_JOB_2_MUST_NOT_LEAK"

function isRecord(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)) }
function record(value) {
  if (typeof value === "string") { try { value = JSON.parse(value) } catch { return null } }
  return isRecord(value) ? value : null
}
function toolCalls(request, name) {
  return (request.messages ?? []).flatMap(message => (message.content ?? [])
    .filter(part => message.role === "assistant" && part?.type === "tool_use" && part.name === name))
}
function toolResult(request, call) {
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role !== "tool" || part?.type !== "tool_result" || part.toolUseId !== call.id) continue
    if (typeof part.content !== "string") return { error: true }
    try { return { error: part.isError === true, value: JSON.parse(part.content) } } catch { return { error: true } }
  }
  return undefined
}
function emitTool(callId, name, args) {
  return [{ type: "tool_call_completed", callId, name, arguments: args }, { type: "completed", finishReason: "tool_calls" }]
}
function profile() {
  return { provider: "fixture", model: "selected-job-batch-fixture", nativeTools: true, structuredOutput: true,
    streaming: true, continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" }
}
function selectedJobId(task) {
  const selection = task?.context?.selectedJobPreparation
  if (!isRecord(selection) || typeof selection.jobId !== "string" || !selection.jobId.trim()) throw new Error("fixture_selected_job_context_missing")
  return selection.jobId
}
function planNodes(deps, crossSlot) {
  const writers = SLOTS.map(slot => {
    const entry = deps.selectedJobBatchTemplatesForSlot(slot)
    if (!entry) throw new Error("fixture_slot_template_missing")
    return { key: `writer-${slot}`, templateId: entry.writerTemplateId, goal: `Write the synthetic ${slot} job-specific draft`,
      successCriteria: ["Persist one scoped draft"], dependsOn: [] }
  })
  const reviewers = SLOTS.map((slot, index) => {
    const entry = deps.selectedJobBatchTemplatesForSlot(slot), writer = `writer-${slot}`
    if (!entry) throw new Error("fixture_slot_template_missing")
    return { key: `reviewer-${slot}`, templateId: entry.reviewerTemplateId, goal: `Review only the paired ${slot} Writer draft`,
      successCriteria: ["Persist one scoped review"], dependsOn: [crossSlot ? `writer-${SLOTS[1 - index]}` : writer] }
  })
  return [...writers, ...reviewers]
}
function readPlanReceipt(request, call, expected) {
  const result = toolResult(request, call), value = record(result?.value)
  if (!result || result.error || !value || value.status !== "accepted" || !Number.isSafeInteger(value.revision)
    || value.revision !== expected.revision || !Array.isArray(value.nodes) || value.nodes.length !== expected.nodes
    || !Array.isArray(value.readyTaskIds) || value.readyTaskIds.length !== expected.ready) throw new Error("fixture_plan_receipt_invalid")
  const nodes = value.nodes.map(record)
  if (nodes.some(node => !node || typeof node.key !== "string" || typeof node.taskId !== "string"
    || !["queued", "waiting"].includes(node.status)) || new Set(nodes.map(node => node.taskId)).size !== nodes.length) {
    throw new Error("fixture_plan_receipt_invalid")
  }
  const ready = nodes.filter(node => node.status === "queued").map(node => node.taskId)
  if (ready.length !== value.readyTaskIds.length || ready.some((id, index) => id !== value.readyTaskIds[index])) {
    throw new Error("fixture_plan_receipt_invalid")
  }
  return { nodes, ids: nodes.map(node => node.taskId), revision: value.revision }
}
function currentGraph(request) {
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (part?.type !== "text" || typeof part.text !== "string" || !part.text.includes('"kind":"task_graph_current"')) continue
    const start = part.text.indexOf("{")
    if (start < 0) break
    const graph = record(part.text.slice(start))
    if (graph?.kind === "task_graph_current" && Number.isSafeInteger(graph.revision) && Array.isArray(graph.nodes)) return graph
  }
  throw new Error("fixture_current_graph_unavailable")
}
function sameRef(left, right) {
  const valid = value => isRecord(value) && typeof value.artifactId === "string" && value.artifactId.length > 0
    && Number.isSafeInteger(value.version) && value.version > 0
    && /^sha256:[a-f0-9]{64}$/.test(value.contentHash) && /^sha256:[a-f0-9]{64}$/.test(value.sourceDigest)
  return valid(left) && valid(right) && left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function allTasksCompleted(output, ids) {
  return isRecord(output) && output.status === "ready" && Array.isArray(output.tasks) && output.tasks.length === ids.length
    && output.tasks.every(task => ids.includes(task?.taskId) && task?.status === "completed")
    && Array.isArray(output.matchedTaskIds) && ids.every(id => output.matchedTaskIds.includes(id))
}
function assertNeedsRevision(initial, graph) {
  const writer = initial.nodes.find(node => node.key === "writer-slot-1")
  const reviewer = initial.nodes.find(node => node.key === "reviewer-slot-1")
  const graphWriter = graph.nodes.find(node => node.key === writer?.key), graphReviewer = graph.nodes.find(node => node.key === reviewer?.key)
  const writerResult = record(graphWriter?.resultProjection), reviewerResult = record(graphReviewer?.resultProjection)
  const projectionValid = value => value?.schemaVersion === "agent-harness.v2.task-graph.result-projection"
    && value.trust === "untrusted" && value.availability === "available" && value.status === "completed"
  if (!writer || !reviewer || graphWriter?.taskId !== writer.taskId || graphReviewer?.taskId !== reviewer.taskId
    || graphWriter.status !== "completed" || graphReviewer.status !== "completed"
    || !projectionValid(writerResult) || writerResult.role !== "writer"
    || !projectionValid(reviewerResult) || reviewerResult.role !== "reviewer" || reviewerResult.reviewStatus !== "needs_revision"
    || !sameRef(writerResult.artifactRef, reviewerResult.artifactRef)) {
    throw new Error("fixture_initial_review_not_verified")
  }
  return { reviewerKey: reviewer.key }
}
function correctionNodes(deps, reviewerKey) {
  const entry = deps.selectedJobBatchTemplatesForSlot(SLOTS[0])
  if (!entry) throw new Error("fixture_slot_template_missing")
  const writerKey = "writer-correction-slot-1"
  return [
    { key: writerKey, templateId: entry.writerTemplateId, goal: "Revise only slot-1 using its exact verified Reviewer feedback",
      successCriteria: ["Read the reviewed version and persist one same-job successor draft"], dependsOn: [reviewerKey] },
    { key: "reviewer-correction-slot-1", templateId: entry.reviewerTemplateId,
      goal: "Review only the exact corrected slot-1 Writer version", successCriteria: ["Persist a fresh review of the successor version"], dependsOn: [writerKey] },
  ]
}
function correctionModelText(request) {
  return (request.messages ?? []).flatMap(message => message.content ?? [])
    .filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n")
}

export function createSelectedJobBatchCorrectionModels({ deps, userId, say, waitForCommand }) {
  let initialPlan, correctionPlan, correctionExpectedRevision
  let planBarrierReached = false, crossSlotRejected = false
  const rootModel = ({ userId: requestUserId }) => {
    if (requestUserId !== userId) throw new Error("fixture_turn_owner_mismatch")
    return { adapter: { id: "selected-job-batch-root-fixture", profile: profile(), async *stream(request) {
      const plans = toolCalls(request, "agent.plan")
      if (!plans.length) { yield* emitTool("batch-plan-cross-slot", "agent.plan", { expectedRevision: 0, nodes: planNodes(deps, true) }); return }
      const rejected = toolResult(request, plans[0])
      if (!rejected?.error || rejected.value?.code !== "selected_job_batch_plan_invalid") throw new Error("fixture_cross_slot_plan_not_rejected")
      if (!crossSlotRejected) { say("BATCH_CROSS_SLOT_REJECTED"); crossSlotRejected = true }
      if (plans.length === 1) { yield* emitTool("batch-plan-valid", "agent.plan", { expectedRevision: 0, nodes: planNodes(deps, false) }); return }
      if (plans.length > 3) throw new Error("fixture_unexpected_replan")
      if (!initialPlan) {
        initialPlan = readPlanReceipt(request, plans[1], { revision: 1, nodes: 4, ready: 2 })
        if (!planBarrierReached) { planBarrierReached = true; say("BATCH_PLAN_PERSISTED"); await waitForCommand("continue-batch") }
      }
      if (plans.length === 3 && !correctionPlan) {
        correctionPlan = readPlanReceipt(request, plans[2], { revision: correctionExpectedRevision + 1, nodes: 2, ready: 1 })
        if (correctionPlan.nodes[0]?.key !== "writer-correction-slot-1"
          || correctionPlan.nodes[1]?.key !== "reviewer-correction-slot-1") throw new Error("fixture_correction_plan_receipt_invalid")
      }
      const waits = toolCalls(request, "agent.wait"), previous = waits.at(-1), receipt = previous && toolResult(request, previous)
      if (receipt?.error) throw new Error("fixture_wait_receipt_invalid")
      const output = record(receipt?.value)
      if (!correctionPlan && output && allTasksCompleted(output, initialPlan.ids)) {
        const graph = currentGraph(request), { reviewerKey } = assertNeedsRevision(initialPlan, graph)
        correctionExpectedRevision = graph.revision
        yield* emitTool("batch-plan-correction-slot-1", "agent.plan", {
          expectedRevision: correctionExpectedRevision, nodes: correctionNodes(deps, reviewerKey),
        })
        return
      }
      const targetIds = correctionPlan ? [...initialPlan.ids, ...correctionPlan.ids] : initialPlan.ids
      if (correctionPlan && output && allTasksCompleted(output, targetIds)) {
        yield { type: "text_delta", text: "Both synthetic job materials were independently reviewed after the slot-1 correction." }
        yield { type: "completed", finishReason: "stop" }
        return
      }
      if (waits.length >= MAX_WAIT_CALLS) throw new Error("fixture_wait_limit_exceeded")
      yield* emitTool(`batch-wait-${waits.length + 1}`, "agent.wait", { idempotencyKey: `selected-job-batch-full-loop:wait:${waits.length + 1}`,
        taskIds: targetIds, mode: "all", timeoutMs: WAIT_TIMEOUT_MS })
    } }, registry: {}, candidates: [] }
  }
  const childModel = ({ task }) => {
    if (task?.userId !== userId) throw new Error("fixture_child_owner_mismatch")
    const role = task?.role, jobId = selectedJobId(task)
    if (role === "writer") return writerModel(deps, task, jobId, userId)
    if (role === "reviewer") return reviewerModel(deps, task, jobId)
    throw new Error("fixture_child_role_unsupported")
  }
  return { rootModel, childModel }
}

function writerModel(deps, task, jobId, userId) {
  const role = "writer"
  const baseArtifactId = `cover-letter-base:${deps.hashArtifactContent({ userId, jobId }).slice(7)}`
  const baseHash = deps.hashArtifactContent({ kind: "cover_letter_base", jobId })
  const revision = deps.writerReviewDependencyFromTaskContext(task.context, jobId)
  if (revision && !String(task.goal).includes("slot-1")) throw new Error("fixture_cross_slot_writer_feedback")
  return { id: "selected-job-batch-writer-fixture", profile: profile(), async *stream(request) {
    if (revision) {
      const text = correctionModelText(request)
      if (!text.includes(JOB1_FEEDBACK_MARKER) || text.includes(JOB2_FEEDBACK_MARKER)) throw new Error("fixture_writer_feedback_scope_invalid")
      const reads = toolCalls(request, "artifact.version.read"), read = reads.at(-1), readResult = read && toolResult(request, read)
      if (!read) { yield* emitTool(`read-reviewed-${task.id}`, "artifact.version.read", { artifactRef: revision.artifactRef }); return }
      if (!readResult || readResult.error || !sameRef(readResult.value?.artifactRef, revision.artifactRef)) throw new Error("fixture_revision_read_receipt_invalid")
      const drafts = toolCalls(request, "cover_letter.draft"), prior = drafts.at(-1)
      if (!prior) { yield* emitTool(`correct-draft-${task.id}`, "cover_letter.draft", { baseArtifactId, baseHash,
        expectedPreviousHash: revision.artifactRef.contentHash, expectedPreviousVersion: revision.artifactRef.version,
        content: "Synthetic corrected job-specific cover letter for isolated integration verification.", constraints: { maxWords: 160 } }); return }
      const result = toolResult(request, prior)
      if (!result || result.error || !isRecord(result.value?.artifactRef)
        || result.value.artifactRef.version !== revision.artifactRef.version + 1) throw new Error("fixture_revision_writer_receipt_invalid")
      yield { type: "text_delta", text: JSON.stringify({ schemaVersion: deps.ROLE_RESULT_SCHEMA, role, status: "completed", artifactRef: result.value.artifactRef }) }
      yield { type: "completed", finishReason: "stop" }
      return
    }
    const drafts = toolCalls(request, "cover_letter.draft"), prior = drafts.at(-1)
    if (!prior) { yield* emitTool(`draft-${task.id}`, "cover_letter.draft", { baseArtifactId, baseHash,
      content: `Synthetic ${String(task.goal).includes("slot-1") ? "slot-1" : "slot-2"} job-specific cover letter for isolated integration verification.`, constraints: { maxWords: 160 } }); return }
    const result = toolResult(request, prior)
    if (!result || result.error || !isRecord(result.value?.artifactRef)) throw new Error("fixture_writer_tool_receipt_invalid")
    yield { type: "text_delta", text: JSON.stringify({ schemaVersion: deps.ROLE_RESULT_SCHEMA, role, status: "completed", artifactRef: result.value.artifactRef }) }
    yield { type: "completed", finishReason: "stop" }
  } }
}

function reviewerModel(deps, task, jobId) {
  const role = "reviewer"
  const artifactRef = deps.writerArtifactReferenceFromTaskContext(task.context, jobId)
  return { id: "selected-job-batch-reviewer-fixture", profile: profile(), async *stream(request) {
    const reads = toolCalls(request, "artifact.version.read")
    if (!reads.length) { yield* emitTool(`read-${task.id}`, "artifact.version.read", { artifactRef }); return }
    const read = toolResult(request, reads.at(-1))
    if (!read || read.error || !sameRef(read.value?.artifactRef, artifactRef)) throw new Error("fixture_reviewer_read_receipt_invalid")
    const reviews = toolCalls(request, "artifact.review"), previous = reviews.at(-1)
    if (!previous) {
      const correction = artifactRef.version > 1
      const slot1 = String(task.goal).includes("slot-1")
      const needsRevision = slot1 && !correction
      const findings = needsRevision ? [{ id: "synthetic_feedback", code: "clarity", severity: "warning",
        message: JOB1_FEEDBACK_MARKER, artifactHash: artifactRef.contentHash,
        evidence: [{ artifactHash: artifactRef.contentHash, path: "body", summary: JOB1_FEEDBACK_MARKER }] }]
        : !slot1 && !correction ? [{ id: "other_slot_note", code: "positive_note", severity: "info",
          message: JOB2_FEEDBACK_MARKER, artifactHash: artifactRef.contentHash,
          evidence: [{ artifactHash: artifactRef.contentHash, path: "body", summary: JOB2_FEEDBACK_MARKER }] }] : []
      yield* emitTool(`review-${task.id}`, "artifact.review", { artifactRef,
        decision: needsRevision ? "needs_revision" : "passed", findings })
      return
    }
    const result = toolResult(request, previous), value = result?.value
    const expectedStatus = artifactRef.version > 1 ? "passed" : String(task.goal).includes("slot-1") ? "needs_revision" : "passed"
    if (!result || result.error || value?.status !== expectedStatus || typeof value.reviewHash !== "string"
      || !sameRef(value.artifactRef, artifactRef)) throw new Error("fixture_reviewer_tool_receipt_invalid")
    yield { type: "text_delta", text: JSON.stringify({ schemaVersion: deps.ROLE_RESULT_SCHEMA, role, status: "completed",
      artifactRef: value.artifactRef, reviewStatus: value.status, reviewHash: value.reviewHash }) }
    yield { type: "completed", finishReason: "stop" }
  } }
}
