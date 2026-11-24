export async function waitForObjectiveTailorWave1WriterGate({ task, mode, say, waitForCommand, blockedWriters, expectedScope }) {
  const slotId = task?.context?.objectiveTailorCandidateWitness?.slotId
  if (mode !== "first" || task?.role !== "writer" || task.context?.objectiveTailorCandidateMode !== true
    || task.userId !== expectedScope.userId || task.sessionId !== expectedScope.sessionId || task.turnId !== expectedScope.turnId
    || typeof slotId !== "string" || !["tailor-1", "tailor-2", "tailor-3", "tailor-4"].includes(slotId)
    || task.context?.objectiveTailorCorrectionProof
    || (task.attemptCount !== undefined && task.attemptCount !== 1)
    || typeof task.id !== "string" || blockedWriters.has(task.id)) return
  blockedWriters.add(task.id)
  if (blockedWriters.size === 4) say("TAILOR_WAVE1_WRITERS_PAUSED 4")
  await waitForCommand("resume-wave1")
}

export function createObjectiveTailorWaveDraftModel({ deps, task, userId, sessionId, turnId, profile }) {
  if (task?.userId !== userId || task?.sessionId !== sessionId || task?.turnId !== turnId
    || !task.context?.objectiveTailorCandidateMode) throw new Error("fixture_draft_context_invalid")
  if (task.role === "writer") return writerModel({ deps, task, userId, sessionId, turnId, profile })
  if (task.role === "reviewer") return reviewerModel({ deps, task, userId, sessionId, turnId, profile })
  throw new Error("fixture_draft_role_unsupported")
}

function writerModel({ deps, task, userId, sessionId, turnId, profile }) {
  const jobId = task.context.selectedJobPreparation?.jobId
  const witness = task.context.objectiveTailorCandidateWitness
  if (typeof jobId !== "string" || witness?.candidate?.jobId !== jobId || typeof witness.slotId !== "string") {
    throw new Error("fixture_writer_binding_invalid")
  }
  const correction = task.context.objectiveTailorCorrectionProof
  const revision = correction ? deps.writerReviewDependencyFromTaskContext(task.context, jobId) : null
  if (correction && (!revision || revision.artifactRef.version < 1)) throw new Error("fixture_writer_review_dependency_missing")
  return { id: "objective-tailor-wave-writer-fixture", profile, async *stream(request) {
    assertScope(request, { userId, sessionId, turnId, taskId: task.id })
    const drafts = toolCalls(request, "cover_letter.draft"), prior = drafts.at(-1)
    if (revision) {
      const reads = toolCalls(request, "artifact.version.read"), read = reads.at(-1)
      if (!read) { yield* emit(`read-${task.id}`, "artifact.version.read", { artifactRef: revision.artifactRef }); return }
      const readResult = toolResult(request, read)
      if (!readResult || readResult.error || !sameRef(readResult.value?.artifactRef, revision.artifactRef)) throw new Error("fixture_writer_reviewed_version_read_invalid")
    }
    if (!prior) {
      const base = childRuntimeContext(request).coverLetterBase
      if (!isRecord(base) || typeof base.artifactId !== "string" || typeof base.baseHash !== "string") {
        throw new Error("fixture_writer_base_capability_missing")
      }
      const input = { baseArtifactId: base.artifactId, baseHash: base.baseHash,
        content: `Synthetic ${correction ? "corrected " : ""}cover letter for confirmed engineering role ${witness.slotId}.`, constraints: { maxWords: 160 } }
      if (revision) { input.expectedPreviousHash = revision.artifactRef.contentHash; input.expectedPreviousVersion = revision.artifactRef.version }
      yield* emit(`draft-${task.id}`, "cover_letter.draft", input); return
    }
    const result = toolResult(request, prior), ref = result?.value?.artifactRef
    if (!result || result.error || !validRef(ref) || revision && ref.version !== revision.artifactRef.version + 1) {
      throw new Error("fixture_writer_draft_receipt_invalid")
    }
    yield { type: "text_delta", text: JSON.stringify({ schemaVersion: deps.roleResultSchema, role: "writer", status: "completed", artifactRef: ref }) }
    yield { type: "completed", finishReason: "stop" }
  } }
}

function reviewerModel({ deps, task, userId, sessionId, turnId, profile }) {
  const jobId = task.context.selectedJobPreparation?.jobId
  const witness = task.context.objectiveTailorCandidateWitness
  const ref = deps.writerArtifactReferenceFromTaskContext(task.context, jobId)
  if (witness?.candidate?.jobId !== jobId || !validRef(ref)) throw new Error("fixture_reviewer_binding_invalid")
  const corrected = Boolean(task.context.objectiveTailorCorrectionProof)
  const decisions = { "tailor-1": "passed", "tailor-2": "needs_revision", "tailor-3": "rejected", "tailor-4": "passed",
    "tailor-5": "passed", "tailor-6": "needs_revision", "tailor-7": "passed", "tailor-8": "rejected" }
  const decision = corrected ? "passed" : decisions[witness.slotId]
  if (!decision) throw new Error("fixture_reviewer_slot_missing")
  return { id: "objective-tailor-wave-reviewer-fixture", profile, async *stream(request) {
    assertScope(request, { userId, sessionId, turnId, taskId: task.id })
    const reads = toolCalls(request, "artifact.version.read"), read = reads.at(-1)
    if (!read) { yield* emit(`read-${task.id}`, "artifact.version.read", { artifactRef: ref }); return }
    const readResult = toolResult(request, read), content = readResult?.value?.content
    if (!readResult || readResult.error || !sameRef(readResult.value?.artifactRef, ref) || typeof content !== "string") {
      throw new Error("fixture_reviewer_version_read_invalid")
    }
    const reviews = toolCalls(request, "artifact.review"), previous = reviews.at(-1)
    if (!previous) {
      const findings = decision === "passed" ? [] : [{ id: "synthetic_review_note", code: decision === "rejected" ? "fit_gap" : "clarity",
        severity: decision === "rejected" ? "error" : "warning", message: `Synthetic review: ${decision} for the observed role.`,
        artifactHash: ref.contentHash, evidence: [{ artifactHash: ref.contentHash, path: "body", summary: content.slice(0, 80) || "Reviewed saved cover letter." }] }]
      yield* emit(`review-${task.id}`, "artifact.review", { artifactRef: ref, decision, findings }); return
    }
    const result = toolResult(request, previous), value = result?.value
    if (!result || result.error || value?.status !== decision || !sameRef(value.artifactRef, ref) || typeof value.reviewHash !== "string") {
      throw new Error("fixture_reviewer_receipt_invalid")
    }
    yield { type: "text_delta", text: JSON.stringify({ schemaVersion: deps.roleResultSchema, role: "reviewer",
      status: "completed", artifactRef: value.artifactRef, reviewStatus: value.status, reviewHash: value.reviewHash }) }
    yield { type: "completed", finishReason: "stop" }
  } }
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
function emit(id, name, args) {
  return [{ type: "tool_call_completed", callId: id, name, arguments: args }, { type: "completed", finishReason: "tool_calls" }]
}
function validRef(value) {
  return Boolean(value && typeof value.artifactId === "string" && Number.isSafeInteger(value.version) && value.version > 0
    && /^sha256:[a-f0-9]{64}$/.test(value.contentHash) && /^sha256:[a-f0-9]{64}$/.test(value.sourceDigest))
}
function sameRef(left, right) {
  return validRef(left) && validRef(right) && left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}
function assertScope(request, expected) {
  if (request?.metadata?.userId !== expected.userId || request.metadata.sessionId !== expected.sessionId
    || request.metadata.turnId !== expected.turnId || request.metadata.taskId !== expected.taskId) {
    throw new Error("fixture_child_model_scope_mismatch")
  }
}
function childRuntimeContext(request) {
  const contexts = []
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (part?.type !== "text" || !part.text?.includes("\"runtimeContext\"")) continue
    const separator = part.text.indexOf("\n")
    if (separator < 0) continue
    try { const context = JSON.parse(part.text.slice(separator + 1))?.runtimeContext; if (isRecord(context)) contexts.push(context) }
    catch { /* Other model text is not the private runtime context. */ }
  }
  if (contexts.length !== 1) throw new Error("fixture_child_runtime_context_missing")
  return contexts[0]
}
function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value) }
