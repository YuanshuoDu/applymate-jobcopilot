import { describe, expect, it } from "vitest"

import { assertRoleAction, assertTaskRole, roleContract, RoleContractError } from "./role-contracts.js"

describe("Writer and Reviewer role contracts", () => {
  it("keeps Writer draft-only and Reviewer read/review-only", () => {
    const writer = roleContract("writer")
    const reviewer = roleContract("reviewer")
    expect(writer.allowedActions).toContain("artifact.draft.create")
    expect(writer.allowedActions).not.toContain("artifact.review")
    expect(writer.draftOnly).toBe(true)
    expect(writer.canReview).toBe(false)
    expect(reviewer.allowedActions).toEqual(["artifact.read", "artifact.review"])
    expect(reviewer.reviewOnly).toBe(true)
    expect(reviewer.canCreateDraft).toBe(false)
    expect(reviewer.canMutateArtifacts).toBe(false)
    expect(reviewer.canExecute).toBe(false)
  })

  it("rejects cross-role and execution actions", () => {
    expect(() => assertTaskRole("reviewer", "writer")).toThrow(RoleContractError)
    expect(() => assertRoleAction("reviewer", "artifact.draft.replace")).toThrow(/cannot perform/)
    expect(() => roleContract("executor")).toThrow(/Unsupported subagent role/)
  })
})
