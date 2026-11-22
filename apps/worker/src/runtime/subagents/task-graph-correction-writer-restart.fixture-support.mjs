export function createCorrectionWriterRestartModel(input) {
  const { selected, task, observations, modelProfile, latestToolResult, record, say, waitForCommand, roleResultSchema } = input
  const callId = selected.correctionDraftCallId
  const draftInput = {
    baseArtifactId: selected.baseArtifactId,
    baseHash: selected.baseHash,
    content: selected.body,
    constraints: { maxWords: 160 },
  }
  let draftEmitted = false
  return {
    id: "p3-correction-writer-restart-model",
    profile: modelProfile(),
    async *stream(request) {
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
        if (selected.pauseAfterCorrectionReceipt === true && task.attemptCount === 1) {
          say(`P3_CORRECTION_WRITER_RECEIPT_COMMITTED ${task.id} ${task.attemptCount}`)
          await waitForCommand(`continue-correction-writer:${task.id}`)
        }
        yield { type: "text_delta", text: JSON.stringify({
          schemaVersion: roleResultSchema, role: "writer", status: "completed", artifactRef,
        }) }
        yield { type: "completed", finishReason: "stop" }
        return
      }
      if (draftEmitted || task.attemptCount !== 1 || !request.tools.some(tool => record(tool)?.name === "cover_letter.draft")) {
        throw new Error("p3_correction_writer_prior_draft_receipt_missing")
      }
      draftEmitted = true
      yield { type: "tool_call_completed", callId, name: "cover_letter.draft", arguments: draftInput }
      yield { type: "completed", finishReason: "tool_calls" }
    },
  }
}
