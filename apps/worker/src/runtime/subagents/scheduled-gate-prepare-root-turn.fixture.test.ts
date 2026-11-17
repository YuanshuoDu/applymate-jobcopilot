import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { scheduledGatePrepareAnalyzeProof } from "./scheduled-gate-prepare-root-turn.fixture.js"

describe("scheduled Gate Prepare Root Turn fixture", () => {
  it("returns only the exact Analyze handoff proof and hashes the private claim token", () => {
    const proof = scheduledGatePrepareAnalyzeProof({ continuationKey: "continuation-v2", checkpointDigest: "a".repeat(64),
      claimToken: "private-claim-token", executionId: "execution-1", executionAttemptCount: 1 })
    expect(proof).toEqual({ status: "analyze_checkpointed", continuationKey: "continuation-v2", checkpointDigest: "a".repeat(64),
      claimTokenDigest: `sha256:${createHash("sha256").update("private-claim-token", "utf8").digest("hex")}`,
      executionId: "execution-1", executionAttemptCount: 1 })
    expect(JSON.stringify(proof)).not.toContain("private-claim-token")
  })
})
