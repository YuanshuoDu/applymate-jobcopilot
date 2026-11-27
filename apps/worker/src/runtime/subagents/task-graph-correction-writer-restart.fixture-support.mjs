export function createCorrectionWriterRestartModel(input) {
  const { selected, task, observations, modelProfile, latestToolResult, record, say, roleResultSchema } = input
  const callId = selected.correctionDraftCallId
  const readCallId = selected.correctionReadCallId
  const predecessorRef = record(selected.predecessorRef)
  const draftInput = {
    baseArtifactId: selected.baseArtifactId,
    baseHash: selected.baseHash,
    content: selected.body,
    constraints: { maxWords: 160 },
  }
  let draftEmitted = false
  const exactReference = (value, expected) => {
    const ref = record(value)
    return Boolean(ref && Object.keys(ref).sort().join(",") === "artifactId,contentHash,sourceDigest,version"
      && ref.artifactId === expected.artifactId && ref.version === expected.version
      && ref.contentHash === expected.contentHash && ref.sourceDigest === expected.sourceDigest)
  }
  return {
    id: "p3-correction-writer-restart-model",
    profile: modelProfile(),
    async *stream(request) {
      say(`P3_CORRECTION_WRITER_MODEL_ENTERED attempt=${task.attemptCount}`)
      const hasReviewFrame = JSON.stringify(request.messages).includes("agent-harness.v2.writer-review-feedback")
      observations.reviewFeedbackIncluded = hasReviewFrame
      if (!hasReviewFrame) throw new Error("p3_correction_writer_review_feedback_missing")
      const receipt = latestToolResult(request, callId)
      if (receipt) {
        const artifactRef = record(receipt.artifactRef)
        if (!artifactRef || Object.keys(artifactRef).sort().join(",") !== "artifactId,contentHash,sourceDigest,version"
          || artifactRef.version !== selected.expectedVersion
          || artifactRef.artifactId !== selected.expectedArtifactId
          || artifactRef.sourceDigest !== selected.sourceDigest
          || typeof artifactRef.contentHash !== "string") {
          throw new Error("p3_correction_writer_draft_receipt_invalid")
        }
        observations.draftReceiptReplayed = task.attemptCount > 1
        yield { type: "text_delta", text: JSON.stringify({
          schemaVersion: roleResultSchema, role: "writer", status: "completed", artifactRef,
        }) }
        yield { type: "completed", finishReason: "stop" }
        return
      }
      const predecessorScopeValid = typeof readCallId === "string" && readCallId.trim().length > 0
        && readCallId !== callId && predecessorRef
        && Object.keys(predecessorRef).sort().join(",") === "artifactId,contentHash,sourceDigest,version"
        && predecessorRef.artifactId === selected.expectedArtifactId
        && predecessorRef.version === 1 && predecessorRef.sourceDigest === selected.sourceDigest
        && typeof predecessorRef.contentHash === "string"
      const predecessorRead = predecessorScopeValid ? latestToolResult(request, readCallId) : null
      if (!predecessorRead) {
        if (task.attemptCount !== 1 || !predecessorScopeValid
          || !request.tools.some(tool => record(tool)?.name === "artifact.version.read")
          || !request.tools.some(tool => record(tool)?.name === "cover_letter.draft")) {
          throw new Error("p3_correction_writer_predecessor_read_unavailable")
        }
        yield { type: "tool_call_completed", callId: readCallId, name: "artifact.version.read", arguments: { artifactRef: predecessorRef } }
        yield { type: "completed", finishReason: "tool_calls" }
        return
      }
      if (!exactReference(predecessorRead.artifactRef, predecessorRef) || typeof predecessorRead.content !== "string") {
        throw new Error("p3_correction_writer_predecessor_read_receipt_invalid")
      }
      observations.predecessorArtifactRead = true
      if (draftEmitted || task.attemptCount !== 1 || !request.tools.some(tool => record(tool)?.name === "cover_letter.draft")) {
        throw new Error("p3_correction_writer_prior_draft_receipt_missing")
      }
      draftEmitted = true
      observations.draftToolCallEmitted = true
      say(`P3_CORRECTION_WRITER_DRAFT_EMITTED attempt=${task.attemptCount}`)
      yield { type: "tool_call_completed", callId, name: "cover_letter.draft", arguments: draftInput }
      yield { type: "completed", finishReason: "tool_calls" }
    },
  }
}
