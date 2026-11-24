import { describe, expect, it } from "vitest"
import {
  legacyWitnessMatches, makeScheduledDraftCandidateWitnessV2, parseScheduledDraftCandidateWitness,
  type ScheduledDraftCandidateWitnessV1, type ScheduledDraftCandidateWitnessV2,
} from "./scheduled-draft-candidate-witness.js"

const digest = "a".repeat(64)
const analyst = { nodeKey: "analyst", taskId: "analyst-task", attemptCount: 1, resultDigest: digest,
  evidenceDigest: digest, reportDigest: digest, scouts: [{ nodeKey: "scout", taskId: "scout-task", attemptCount: 1,
    nodeDigest: digest, resultDigest: digest, evidenceDigest: digest, reportDigest: digest }] }
const core = { graphRevision: 3, graphDigest: digest, stableStatusDigest: digest,
  newlyProposedNodeKeys: ["plan"], candidate: { jobId: "job-1", score: 8 }, sourceAnalystKeys: ["analyst"], analysts: [analyst] }
const legacy: ScheduledDraftCandidateWitnessV1 = {
  bindingVersion: "agent-harness.v2.scheduled-draft-candidate-binding.v1", ...core,
}

describe("scheduled draft candidate witness versions", () => {
  it("builds only a V2 witness with the selected material commitment", () => {
    const witness = makeScheduledDraftCandidateWitnessV2({ ...core, jobMaterialDigest: `sha256:${digest}` })

    expect(witness.bindingVersion).toBe(2)
    expect(parseScheduledDraftCandidateWitness(witness)).toEqual(witness)
  })

  it("continues to parse the closed persisted V1 witness", () => {
    expect(parseScheduledDraftCandidateWitness(legacy)).toEqual(legacy)
    expect(legacyWitnessMatches(legacy, core)).toBe(true)
  })

  const malformed: readonly [string, (value: ScheduledDraftCandidateWitnessV2) => unknown][] = [
    ["missing digest", ({ jobMaterialDigest: _digest, ...rest }) => rest],
    ["malformed digest", value => ({ ...value, jobMaterialDigest: "sha256:invalid" })],
    ["unknown field", value => ({ ...value, privateSource: "forged" })],
  ]
  it.each(malformed)("rejects V2 with %s", (_name, alter) => {
    const valid = makeScheduledDraftCandidateWitnessV2({ ...core, jobMaterialDigest: `sha256:${digest}` })
    expect(parseScheduledDraftCandidateWitness(alter(valid))).toBeUndefined()
  })

  it("does not accept V2-only material fields on a V1 witness", () => {
    expect(parseScheduledDraftCandidateWitness({ ...legacy, jobMaterialDigest: `sha256:${digest}` })).toBeUndefined()
    expect(legacyWitnessMatches(legacy, { ...core, graphRevision: 4 })).toBe(false)
  })
})
