import { describe, expect, it } from "vitest"
import {
  CANARY_OBSERVATION_MS,
  INTERNAL_OBSERVATION_MS,
  evaluateRolloutStage,
  type RolloutMetrics,
} from "./stage-controller.js"

const metrics: RolloutMetrics = {
  turnCompletionRate: 0.999,
  unauthorizedExternalAction: 0,
  submissionDuplicate: 0,
  replayConsistency: 1,
  costP95Ratio: 1,
}

describe("rollout stage controller", () => {
  it("holds internal-only until its 24-hour observation window completes", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    expect(evaluateRolloutStage("internal-only", metrics, from, new Date(from.getTime() + INTERNAL_OBSERVATION_MS - 1))).toMatchObject({
      status: "hold", nextStage: "internal-only", observationReady: false, observationWindowMs: INTERNAL_OBSERVATION_MS,
    })
  })

  it("advances a healthy canary after its four-hour observation window", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    expect(evaluateRolloutStage("1%", metrics, from, new Date(from.getTime() + CANARY_OBSERVATION_MS))).toMatchObject({
      status: "advance", nextStage: "5%", observationReady: true,
    })
  })

  it("rolls back a failed canary to the immediately previous stage", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    expect(evaluateRolloutStage("25%", { ...metrics, submissionDuplicate: 1, costP95Ratio: 1.3 }, from, new Date(from.getTime() + CANARY_OBSERVATION_MS))).toMatchObject({
      status: "rollback", nextStage: "5%", failures: ["submission_duplicate", "cost_p95"],
    })
  })

  it("holds internal-only on failure because there is no lower stage", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    expect(evaluateRolloutStage("internal-only", { ...metrics, turnCompletionRate: 0.5 }, from, new Date(from.getTime() + INTERNAL_OBSERVATION_MS))).toMatchObject({
      status: "hold", nextStage: "internal-only", failures: ["turn_completion_rate"],
    })
  })

  it("does not advance past 100%", () => {
    const from = new Date("2026-01-01T00:00:00.000Z")
    expect(evaluateRolloutStage("100%", metrics, from, new Date(from.getTime() + CANARY_OBSERVATION_MS))).toMatchObject({
      status: "hold", nextStage: "100%", observationReady: true,
    })
  })
})
