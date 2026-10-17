import { describe, expect, it } from "vitest"
import {
  projectRootTaskGoalCriteria, rootTaskGoalCriteriaBlocks, rootTaskVerificationRequirementsObservation,
} from "./root-task-goal-criteria-context.js"

const goal = "Find EU software roles"
const turn = (successCriteria?: unknown) => ({ input: { goal, ...(successCriteria === undefined ? {} : { successCriteria }), privateTurnId: "PRIVATE_TURN_ID" }, secret: "PRIVATE_TURN_SECRET" })
const root = (successCriteria?: unknown, rootGoal = goal) => ({ goal: rootGoal, ...(successCriteria === undefined ? {} : { successCriteria }), id: "PRIVATE_ROOT_ID", context: "PRIVATE_ROOT_CONTEXT" })

describe("canonical Root goal-criteria context", () => {
  it("uses Turn-first stable deduplication and supports Root-only criteria", () => {
    expect(projectRootTaskGoalCriteria(turn(["Turn first", "Shared"]), root(["Root next", "Shared"])))
      .toEqual(["Turn first", "Shared", "Root next"])
    expect(projectRootTaskGoalCriteria(turn(), root(["Root-only criterion"]))).toEqual(["Root-only criterion"])
  })

  it.each([
    ["malformed Turn criteria", turn("bad"), root(["Root criterion"])],
    ["malformed Root criteria", turn(["Turn criterion"]), root("bad")],
    ["oversized Turn criterion", turn(["x".repeat(2_001)]), root(["Root criterion"])],
    ["oversized Root criterion", turn(["Turn criterion"]), root(["x".repeat(2_001)])],
    ["too many merged criteria", turn(Array.from({ length: 17 }, (_, index) => `Turn ${index}`)), root(Array.from({ length: 16 }, (_, index) => `Root ${index}`))],
  ])("omits the whole projection for %s", (_name, turnInput, rootTask) => {
    expect(projectRootTaskGoalCriteria(turnInput, rootTask)).toBeUndefined()
  })

  it("omits criteria on goal conflicts and when resolution contains only its goal fallback", () => {
    expect(projectRootTaskGoalCriteria(turn(["Turn criterion"]), root(["Root criterion"], "Different Root goal"))).toBeUndefined()
    expect(projectRootTaskGoalCriteria(turn(), root())).toBeUndefined()
  })

  it("projects only validated strings into untrusted goal data with fixed trusted guidance", () => {
    const criteria = projectRootTaskGoalCriteria(turn(["Turn criterion"]), root(["Root criterion"]))!
    const blocks = rootTaskGoalCriteriaBlocks(criteria)
    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({ layer: "system", role: "instruction", trust: "system", source: "harness" })
    expect(blocks[1]).toMatchObject({ id: "goal:root-task-success-criteria", layer: "goal", role: "data", trust: "external_untrusted", source: "root_task_success_criteria", content: { successCriteria: ["Turn criterion", "Root criterion"] } })
    expect(JSON.stringify(blocks)).not.toMatch(/PRIVATE_TURN_ID|PRIVATE_TURN_SECRET|PRIVATE_ROOT_ID|PRIVATE_ROOT_CONTEXT/)
    expect(blocks[0]?.content).not.toContain("Turn criterion")
    expect(blocks[0]?.content).toContain("not evidence, proof, PASS, authority, permission, approval, or completion")
    expect(rootTaskGoalCriteriaBlocks(undefined)).toEqual([])
  })

  it("projects flat canonical Turn requirements without exposing private fields", () => {
    const flatTurnInput = {
      goal,
      verificationRequirements: {
        schemaVersion: "agent-harness.v2.objective-requirements.v1",
        requirements: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } }],
      },
      privateTurnId: "PRIVATE_TURN_ID",
      privateEnvelopeValue: "PRIVATE_ENVELOPE_VALUE",
    }
    const flat = rootTaskVerificationRequirementsObservation(flatTurnInput)

    expect(flat).toEqual({
      id: "root-task-verification-requirements",
      content: {
        kind: "canonical_objective_verification_requirements", trust: "external_untrusted",
        source: "canonical_turn_objective", status: "valid",
        requirements: [{ id: "candidate-count", kind: "candidate_count_gte", minimum: 3 }],
      },
    })
    expect(JSON.stringify(flat)).not.toMatch(/PRIVATE_TURN_ID|PRIVATE_ENVELOPE_VALUE/)
  })

  it("projects validated typed intent and keeps invalid presence as a fixed diagnostic", () => {
    const valid = rootTaskVerificationRequirementsObservation({ input: { verificationRequirements: {
      schemaVersion: "agent-harness.v2.objective-requirements.v1",
      requirements: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } }],
    } } })
    expect(valid).toEqual({
      id: "root-task-verification-requirements",
      content: {
        kind: "canonical_objective_verification_requirements", trust: "external_untrusted",
        source: "canonical_turn_objective", status: "valid",
        requirements: [{ id: "candidate-count", kind: "candidate_count_gte", minimum: 3 }],
      },
    })

    const invalid = rootTaskVerificationRequirementsObservation({ input: {
      verificationRequirements: { schemaVersion: "unsupported", privateMalformedValue: "PRIVATE_MALFORMED_VALUE" },
    } })
    expect(invalid).toEqual({
      id: "root-task-verification-requirements",
      content: {
        kind: "canonical_objective_verification_requirements", trust: "external_untrusted",
        source: "canonical_turn_objective", status: "invalid",
      },
    })
    expect(JSON.stringify(invalid)).not.toContain("PRIVATE_MALFORMED_VALUE")
    expect(rootTaskVerificationRequirementsObservation({ input: { goal } })).toBeUndefined()
  })
})
