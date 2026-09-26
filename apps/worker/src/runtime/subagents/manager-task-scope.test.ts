import { describe, expect, it } from "vitest"

import { isTaskPathWithin, normalizeTaskPath, policyFromTask } from "./manager-task-scope.js"
import { defaultSubagentPolicy } from "./types.js"

describe("subagent manager task-scope helpers", () => {
  it("uses defaults when the persisted policy snapshot is absent or malformed", () => {
    expect(policyFromTask({ budgetSnapshot: null })).toEqual(defaultSubagentPolicy())
    expect(policyFromTask({ budgetSnapshot: { subagentPolicy: [] } })).toEqual(defaultSubagentPolicy())
  })

  it("normalizes a persisted policy and rejects invalid values through the shared validator", () => {
    expect(policyFromTask({ budgetSnapshot: { subagentPolicy: { maxDepth: 2, maxAttempts: 2 } } })).toMatchObject({ maxDepth: 2, maxAttempts: 2 })
    expect(() => policyFromTask({ budgetSnapshot: { subagentPolicy: { maxDepth: 0 } } })).toThrow("Subagent maxDepth must be a positive integer")
  })

  it("accepts only normalized absolute task paths and checks subtree boundaries", () => {
    expect(normalizeTaskPath("/root/child")).toBe("/root/child")
    expect(normalizeTaskPath("root/child")).toBeNull()
    expect(normalizeTaskPath("/root/%2fchild")).toBeNull()
    expect(isTaskPathWithin("/root/child/grandchild", "/root/child")).toBe(true)
    expect(isTaskPathWithin("/root/children", "/root/child")).toBe(false)
  })
})
