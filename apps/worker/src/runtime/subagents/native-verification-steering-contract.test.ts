import { describe, expect, it } from "vitest"
import { canonicalNativeVerificationJson } from "./native-verification-contract.js"
import {
  NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
  NATIVE_VERIFICATION_USER_STEERING_STAGE,
  isNativeSteeringEvidence,
  nativeSteeringCheckpointInputIdsMatch,
  parseNativeSteeringTurnInput,
} from "./native-verification-steering-contract.js"

const referenceId = `user-self-attestation:${"a".repeat(64)}`
const summary = { schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA, stage: NATIVE_VERIFICATION_USER_STEERING_STAGE,
  content: [{ type: "text", text: "Use Dublin 🌍" }, { type: "text", text: "Keep the original goal." }] }
const evidence = { referenceId, kind: "user_self_attestation", summary: canonicalNativeVerificationJson(summary) }

describe("native user steering evidence contract", () => {
  it("requires checkpoint input IDs to equal the original input plus steering IDs claimed by that Step", () => {
    expect(nativeSteeringCheckpointInputIdsMatch(["root-input", "steer-1"], "root-input", ["steer-1"])).toBe(true)
    expect(nativeSteeringCheckpointInputIdsMatch([], null, [])).toBe(true)
    expect(nativeSteeringCheckpointInputIdsMatch(["root-input"], "root-input", ["steer-1"])).toBe(false)
    expect(nativeSteeringCheckpointInputIdsMatch(["root-input", "steer-1", "extra"], "root-input", ["steer-1"])).toBe(false)
    expect(nativeSteeringCheckpointInputIdsMatch(["steer-1"], null, ["steer-1"])).toBe(true)
  })

  it("binds the root message identity to input content without deriving the explicit goal", () => {
    const content = [{ type: "text", text: "Find jobs" }]
    expect(parseNativeSteeringTurnInput({ clientMessageId: "root-1", content, goal: "Explicit goal" }))
      .toEqual({ clientMessageId: "root-1", content })
    expect(parseNativeSteeringTurnInput({ input: { clientMessageId: "nested", content, goal: "Nested goal" } }))
      .toEqual({ clientMessageId: "nested", content })
    expect(parseNativeSteeringTurnInput({ clientMessageId: " ", content, goal: "Find jobs" })).toBeNull()
    expect(parseNativeSteeringTurnInput({ clientMessageId: "root-1", content: "not-an-array", goal: "Find jobs" })).toBeNull()
  })

  it("recognizes only complete canonical user-steering summaries in the private reference family", () => {
    expect(isNativeSteeringEvidence(evidence)).toBe(true)
    expect(isNativeSteeringEvidence({ ...evidence, referenceId: "user-self-attestation:bad" })).toBe(false)
    expect(isNativeSteeringEvidence({ ...evidence, kind: "user_input" })).toBe(false)
    expect(isNativeSteeringEvidence({ ...evidence, reportDigest: "x" })).toBe(false)
  })

  it.each([
    ["answer evidence", { kind: "user_self_attestation", stage: "user_input", question: "Q", options: [], answer: "A" }],
    ["attachment reference", { ...summary, content: [{ type: "attachment_ref", attachmentId: "a", mediaType: "text/plain" }] }],
    ["extra authority field", { ...summary, ownerId: "user-1" }],
    ["empty content", { ...summary, content: [] }],
    ["empty text", { ...summary, content: [{ type: "text", text: "" }] }],
  ])("rejects %s", (_name, value) => expect(isNativeSteeringEvidence({ ...evidence, summary: canonicalNativeVerificationJson(value) })).toBe(false))

  it("rejects noncanonical JSON and preserves exact text-part ordering", () => {
    expect(isNativeSteeringEvidence({ ...evidence, summary: JSON.stringify(summary) })).toBe(false)
    const reversed = { ...summary, content: [...summary.content].reverse() }
    expect(isNativeSteeringEvidence({ ...evidence, summary: canonicalNativeVerificationJson(reversed) })).toBe(true)
    expect(isNativeSteeringEvidence({ ...evidence, summary: canonicalNativeVerificationJson({ ...summary, schemaVersion: "other" }) })).toBe(false)
  })
})
