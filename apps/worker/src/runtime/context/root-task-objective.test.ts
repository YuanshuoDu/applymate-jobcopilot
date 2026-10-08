import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { digestNativeVerificationValue } from "../subagents/native-verification-contract.js"
import { resolveRootTaskObjective, rootTaskObjectiveDigest } from "./root-task-objective.js"

describe("canonical root task objective", () => {
  it("uses the canonical nested Turn goal and validates typed content parts", () => {
    const objective = resolveRootTaskObjective({ input: {
      goal: " Original objective ",
      content: [{ type: "text", text: "Reference context" }, { type: "attachment_ref", attachmentId: "resume-1", mediaType: "application/pdf" }],
    } }, { goal: "Original objective" })
    expect(objective).toEqual({
      goal: "Original objective", criteria: ["Original objective"], criteriaValid: true, turnGoalConflict: false,
    })
  })

  it("treats missing criteria fields as valid empty input and falls back to the frozen goal", () => {
    const objective = resolveRootTaskObjective({ input: { goal: "Original objective" } }, { goal: "Original objective" })
    expect(objective.criteria).toEqual(["Original objective"])
    expect(objective.criteriaValid).toBe(true)
  })

  it("rejects present malformed criteria and preserves ordered deduplication", () => {
    const malformed = resolveRootTaskObjective({ input: { goal: "Original objective", successCriteria: undefined } }, {
      goal: "Original objective",
    })
    expect(malformed.criteria).toEqual([])
    expect(malformed.criteriaValid).toBe(false)

    const merged = resolveRootTaskObjective({ input: { goal: "Original objective", successCriteria: ["first", "shared"] } }, {
      goal: "Original objective", successCriteria: ["shared", "last"],
    })
    expect(merged.criteria).toEqual(["first", "shared", "last"])
    expect(merged.criteriaValid).toBe(true)
  })

  it("marks criteria invalid when the valid ordered merge exceeds the output cap", () => {
    const turnCriteria = Array.from({ length: 20 }, (_, index) => `turn-${index.toString().padStart(2, "0")}`)
    const rootCriteria = ["turn-19", ...Array.from({ length: 14 }, (_, index) => `root-${index.toString().padStart(2, "0")}`)]
    const objective = resolveRootTaskObjective({ input: {
      goal: "Original objective", successCriteria: turnCriteria,
    } }, { goal: "Original objective", successCriteria: rootCriteria })

    expect(objective.criteria).toEqual([])
    expect(objective.criteriaValid).toBe(false)
  })

  it("marks empty criteria invalid when the Turn goal cannot provide a fallback", () => {
    const missingGoal = resolveRootTaskObjective({ input: { successCriteria: [] } }, {
      successCriteria: [],
    })
    const invalidGoal = resolveRootTaskObjective({ input: { goal: " ", successCriteria: [] } }, {
      goal: "Original objective", successCriteria: [],
    })

    expect(missingGoal).toEqual({ goal: null, criteria: [], criteriaValid: false, turnGoalConflict: true })
    expect(invalidGoal).toEqual({ goal: null, criteria: [], criteriaValid: false, turnGoalConflict: true })
  })

  it("keeps the fallback goal output but marks a 2,500-byte requirement invalid", () => {
    const goal = `${"€".repeat(833)}a`
    expect(Buffer.byteLength(goal, "utf8")).toBe(2_500)
    const objective = resolveRootTaskObjective({ input: { goal, successCriteria: [] } }, {
      goal, successCriteria: [],
    })

    expect(objective.criteria).toEqual([goal])
    expect(objective.criteriaValid).toBe(false)
  })

  it("keeps root goal conflict independent from otherwise valid criteria", () => {
    const objective = resolveRootTaskObjective({ input: { goal: "Original objective", successCriteria: ["Check evidence"] } }, {
      goal: "Changed objective", successCriteria: [],
    })
    expect(objective).toEqual({
      goal: "Original objective", criteria: ["Check evidence"], criteriaValid: true, turnGoalConflict: true,
    })
  })

  it("digests only the normalized packet goal and ordered criterion rows", () => {
    const criteria = [
      { criterionId: "criterion-1", requirement: "Use the saved evidence" },
      { criterionId: "criterion-2", requirement: "Preserve the user constraints" },
    ]
    const objective = { goal: "Verifier-normalized goal", criteria }
    expect(rootTaskObjectiveDigest(objective)).toBe(digestNativeVerificationValue(objective))
    expect(rootTaskObjectiveDigest({ goal: objective.goal, criteria: [...criteria].reverse() }))
      .not.toBe(rootTaskObjectiveDigest(objective))
  })
})
