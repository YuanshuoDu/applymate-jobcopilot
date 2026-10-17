import { Buffer } from "node:buffer"
import { describe, expect, it } from "vitest"
import { digestNativeVerificationValue } from "../subagents/native-verification-contract.js"
import {
  resolveRootTaskObjective, resolveRootTaskVerificationRequirements, rootTaskObjectiveDigest,
} from "./root-task-objective.js"

const objectiveRequirements = (minimum = 3) => ({
  schemaVersion: "agent-harness.v2.objective-requirements.v1",
  requirements: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum } },
    { id: "finding_count", check: { kind: "finding_count_gte", minimum: 1 } },
  ],
})

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

  it("fails closed when the persisted root is absent unless a caller opts into the fresh-root convention", () => {
    const turnInput = { input: { goal: "Original objective" } }
    expect(resolveRootTaskObjective(turnInput)).toEqual({
      goal: "Original objective", criteria: [], criteriaValid: false, turnGoalConflict: true,
    })
    expect(resolveRootTaskObjective(turnInput, undefined, { allowNativeFreshRootFallback: true })).toEqual({
      goal: "Original objective", criteria: ["Original objective"], criteriaValid: true, turnGoalConflict: false,
    })
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

describe("canonical Turn verification requirements", () => {
  it("accepts the flat canonical Turn input shape", () => {
    expect(resolveRootTaskVerificationRequirements({
      goal: "Find roles",
      verificationRequirements: objectiveRequirements(),
    })).toEqual({
      status: "valid",
      requirements: [
        { id: "candidate-count", kind: "candidate_count_gte", minimum: 3 },
        { id: "finding_count", kind: "finding_count_gte", minimum: 1 },
      ],
    })
  })

  it("distinguishes an absent field from a valid nested objective block", () => {
    expect(resolveRootTaskVerificationRequirements({ input: { goal: "Find roles" } })).toEqual({ status: "absent" })
    expect(resolveRootTaskVerificationRequirements({ input: { goal: "Find roles", verificationRequirements: objectiveRequirements() } }))
      .toEqual({
        status: "valid",
        requirements: [
          { id: "candidate-count", kind: "candidate_count_gte", minimum: 3 },
          { id: "finding_count", kind: "finding_count_gte", minimum: 1 },
        ],
      })
  })

  it("accepts a valid top-level objective block without a nested copy", () => {
    expect(resolveRootTaskVerificationRequirements({ verificationRequirements: objectiveRequirements() })).toEqual({
      status: "valid",
      requirements: [
        { id: "candidate-count", kind: "candidate_count_gte", minimum: 3 },
        { id: "finding_count", kind: "finding_count_gte", minimum: 1 },
      ],
    })
  })

  it.each([
    ["wrong schema version", { ...objectiveRequirements(), schemaVersion: "agent-harness.v2.objective-requirements.v2" }],
    ["unknown block key", { ...objectiveRequirements(), hidden: "private" }],
    ["wrong requirements type", { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: {} }],
    ["empty list", { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [] }],
    ["unsupported check kind", { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [{ id: "candidate-count", check: { kind: "evidence_count_gte", minimum: 1 } }] }],
    ["minimum below bound", objectiveRequirements(0)],
    ["minimum above bound", objectiveRequirements(51)],
    ["non-integer minimum", objectiveRequirements(1.5)],
    ["invalid ID grammar", { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [{ id: "UpperCase", check: { kind: "candidate_count_gte", minimum: 1 } }] }],
    ["duplicate IDs", { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [
      { id: "same-id", check: { kind: "candidate_count_gte", minimum: 1 } },
      { id: "same-id", check: { kind: "finding_count_gte", minimum: 1 } },
    ] }],
    ["unknown entry key", { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [{ id: "one", check: { kind: "candidate_count_gte", minimum: 1 }, note: "extra" }] }],
    ["unknown check key", { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: [{ id: "one", check: { kind: "candidate_count_gte", minimum: 1, note: "extra" } }] }],
    ["oversized list", { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: Array.from({ length: 9 }, (_, index) => ({ id: `requirement-${index}`, check: { kind: "candidate_count_gte", minimum: 1 } })) }],
  ])("marks %s invalid", (_name, value) => {
    expect(resolveRootTaskVerificationRequirements({ input: { verificationRequirements: value } })).toEqual({ status: "invalid" })
  })

  it("rejects sparse lists, accessors, hidden keys, and custom prototypes without invoking getters", () => {
    const sparse = new Array(1) as unknown[]
    sparse[1] = { id: "one", check: { kind: "candidate_count_gte", minimum: 1 } }
    const accessorBlock = objectiveRequirements()
    let getterInvoked = false
    Object.defineProperty(accessorBlock.requirements[0], "check", { enumerable: true, get: () => {
      getterInvoked = true
      return { kind: "candidate_count_gte", minimum: 1 }
    } })
    const hiddenBlock = objectiveRequirements()
    Object.defineProperty(hiddenBlock, "hidden", { value: "private", enumerable: false })
    const symbolBlock = objectiveRequirements()
    Object.defineProperty(symbolBlock, Symbol("hidden"), { value: "private" })
    const customPrototype = Object.assign(Object.create({ inherited: true }) as object, objectiveRequirements())
    for (const value of [
      { schemaVersion: "agent-harness.v2.objective-requirements.v1", requirements: sparse },
      accessorBlock,
      hiddenBlock,
      symbolBlock,
      customPrototype,
    ]) expect(resolveRootTaskVerificationRequirements({ verificationRequirements: value })).toEqual({ status: "invalid" })
    expect(getterInvoked).toBe(false)
  })

  it("rejects a custom-prototype envelope that owns a valid requirements block", () => {
    const envelope = Object.assign(Object.create({ inherited: true }) as object, {
      verificationRequirements: objectiveRequirements(),
    })

    expect(resolveRootTaskVerificationRequirements(envelope)).toEqual({ status: "invalid" })
  })

  it("compares duplicate requirements structurally while preserving list order", () => {
    const persistedCopy = {
      requirements: [
        { check: { minimum: 3, kind: "candidate_count_gte" }, id: "candidate-count" },
        { check: { minimum: 1, kind: "finding_count_gte" }, id: "finding_count" },
      ],
      schemaVersion: "agent-harness.v2.objective-requirements.v1",
    }
    expect(resolveRootTaskVerificationRequirements({
      verificationRequirements: objectiveRequirements(), input: { verificationRequirements: persistedCopy },
    }).status)
      .toBe("valid")
    expect(resolveRootTaskVerificationRequirements({
      verificationRequirements: objectiveRequirements(), input: { verificationRequirements: objectiveRequirements(4) },
    }))
      .toEqual({ status: "invalid" })
    expect(resolveRootTaskVerificationRequirements({
      verificationRequirements: objectiveRequirements(),
      input: { verificationRequirements: { ...persistedCopy, requirements: [...persistedCopy.requirements].reverse() } },
    }))
      .toEqual({ status: "invalid" })
  })

  it("keeps invalid typed intent separate from the existing prose objective", () => {
    const goal = "Find EU roles"
    const turnInput = { input: {
      goal, successCriteria: ["Keep prose intent"],
      verificationRequirements: { schemaVersion: "unsupported", requirements: "malformed" },
    } }
    expect(resolveRootTaskVerificationRequirements(turnInput)).toEqual({ status: "invalid" })
    expect(resolveRootTaskObjective(turnInput, { goal, successCriteria: [] })).toEqual({
      goal, criteria: ["Keep prose intent"], criteriaValid: true, turnGoalConflict: false,
    })
  })
})
