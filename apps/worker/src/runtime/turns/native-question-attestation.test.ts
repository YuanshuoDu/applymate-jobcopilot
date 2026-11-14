import { describe, expect, it } from "vitest"

import { issueNativeQuestionControlReceipt, readTrustedNativeQuestionAttestation,
  verifyNativeQuestionAttestation } from "./native-question-attestation.js"
import { TURN_QUESTION_INTENT_SCHEMA } from "./turn-question-contract.js"

const identity = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: "root-1", rootTaskId: "root-1" }
const input = { question: "Which city?", choices: [{ label: "Berlin", value: "berlin" }] }
const output = { schemaVersion: TURN_QUESTION_INTENT_SCHEMA, kind: "user_question", stage: "user_input", question: input.question, options: input.choices }

function issue(overrides: Partial<Parameters<typeof issueNativeQuestionControlReceipt>[0]> = {}) {
  return issueNativeQuestionControlReceipt({
    identity, actorRole: "orchestrator", capabilities: ["canManageChildren"], toolCallId: "call-1",
    toolName: "agent.ask_user", toolVersion: "1", requestInput: input, effectiveInput: input, toolOutput: output, ...overrides,
  })
}

describe("native question server attestation", () => {
  it("issues a private receipt only for canonical built-in root input and output", () => {
    const receipt = issue()
    expect(receipt).not.toBeNull()
    expect(JSON.stringify(receipt)).not.toContain(input.question)
    expect(JSON.stringify(receipt)).not.toContain("berlin")
    expect(readTrustedNativeQuestionAttestation(receipt, identity, "call-1", input)).toMatchObject({
      toolCallId: "call-1", userId: identity.userId, sessionId: identity.sessionId,
      turnId: identity.turnId, stepId: identity.stepId, taskId: identity.taskId,
    })
  })

  it.each([
    ["changed output", { toolOutput: { ...output, question: "Different?" } }],
    ["changed effective input", { effectiveInput: { question: input.question, choices: [{ label: "Paris", value: "paris" }] } }],
    ["blank call", { toolCallId: " " }],
    ["wrong tool version", { toolVersion: "2" }],
    ["child task", { identity: { ...identity, taskId: "child-1" } }],
    ["wrong actor", { actorRole: "analyst" }],
    ["missing capability", { capabilities: [] }],
  ])("does not attest %s", (_name, overrides) => {
    expect(issue(overrides)).toBeNull()
  })

  it("rejects JSON-cloned receipts and stale or forged durable identity and digest", () => {
    const receipt = issue()
    expect(readTrustedNativeQuestionAttestation(JSON.parse(JSON.stringify(receipt)), identity, "call-1", input)).toBeNull()
    const attestation = receipt?.attestation
    expect(verifyNativeQuestionAttestation(attestation, identity, "call-1", input)).toEqual(attestation)
    expect(verifyNativeQuestionAttestation(attestation, { ...identity, sessionId: "other-session" }, "call-1", input)).toBeNull()
    expect(verifyNativeQuestionAttestation(attestation, identity, "other-call", input)).toBeNull()
    expect(verifyNativeQuestionAttestation(attestation, identity, "call-1", { question: "Changed?" })).toBeNull()
    expect(verifyNativeQuestionAttestation({ ...attestation, inputDigest: "sha256:" + "0".repeat(64) }, identity, "call-1", input)).toBeNull()
    expect(verifyNativeQuestionAttestation({ ...attestation, question: input.question }, identity, "call-1", input)).toBeNull()
  })
})
