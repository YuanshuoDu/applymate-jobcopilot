import { describe, expect, it } from "vitest"
import { NESTED_SCOUT_PROFILE_MARKER } from "./nested-scout-profile.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { filterNestedScoutProtectedActions, hasNestedScoutPrivateContext, hasNestedScoutProtectedActions,
  hasUnsupportedNestedScoutBudgetLimits, isNestedScoutCreationAuthorityValid } from "./nested-scout-creation-authority.js"

const typed = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }
const parent = { role: "scout", taskType: "job_discovery", depth: 1, parentTaskId: "root", rootTaskId: "root", expectedOutputSchema: typed,
  context: { nestedScoutProfile: NESTED_SCOUT_PROFILE_MARKER }, allowedActions: ["wait_subagents", "scout.delegate", "scout.results"] }
const child = { role: "scout", taskType: "job_discovery", depth: 2, parentTaskId: "scout", rootTaskId: "root", expectedOutputSchema: typed,
  context: { nestedScoutSourceSlice: ["greenhouse"], nestedScoutQueryScope: [{ source: "greenhouse", targetRoles: ["Engineer"], targetLocations: [], maxPageSize: 20 }] },
  allowedActions: ["jobs.discover", "tool_results.read"] }

describe("nested Scout creation authority", () => {
  it("detects reserved own context keys, including hostile objects", () => {
    expect(hasNestedScoutPrivateContext({ nestedScoutProfile: undefined })).toBe(true)
    expect(hasNestedScoutPrivateContext({ safe: { nestedScoutProfile: "forged" } })).toBe(false)
    expect(hasNestedScoutPrivateContext(new Proxy({}, { ownKeys() { throw Error() } }))).toBe(true)
  })

  it("filters only delegate/results and preserves wait_subagents", () => {
    expect(hasNestedScoutProtectedActions(["scout.delegate"])).toBe(true)
    expect(filterNestedScoutProtectedActions(["wait_subagents", "scout.delegate", "jobs.search", "scout.results"]))
      .toEqual(["wait_subagents", "jobs.search"])
  })

  it("accepts only typed profile parents and in-scope read-only children", () => {
    expect(isNestedScoutCreationAuthorityValid("parent_template", parent)).toBe(true)
    expect(isNestedScoutCreationAuthorityValid("child_execution", child)).toBe(true)
    expect(isNestedScoutCreationAuthorityValid("parent_template", { ...parent, context: { nestedScoutProfile: "forged" } })).toBe(false)
    expect(isNestedScoutCreationAuthorityValid("child_execution", { ...child, allowedActions: ["scout.delegate"] })).toBe(false)
  })

  it.each(["maxInputTokens", "maxOutputTokens", "maxCostUsd"] as const)(
    "marks a configured %s limit, including zero, unsupported for nested Scout admission", key => {
      expect(hasUnsupportedNestedScoutBudgetLimits({ limits: { [key]: 0 } })).toBe(true)
      expect(hasUnsupportedNestedScoutBudgetLimits({ [key]: 1 })).toBe(true)
    },
  )

  it("allows missing/default budgets and effective step/tool-only limits", () => {
    expect(hasUnsupportedNestedScoutBudgetLimits(undefined)).toBe(false)
    expect(hasUnsupportedNestedScoutBudgetLimits(null)).toBe(false)
    expect(hasUnsupportedNestedScoutBudgetLimits({})).toBe(false)
    expect(hasUnsupportedNestedScoutBudgetLimits({ limits: { maxSteps: 4, maxToolCalls: 8 } })).toBe(false)
  })

  it("uses canonical effective-limit parsing for malformed values and null wrapper fallback", () => {
    expect(hasUnsupportedNestedScoutBudgetLimits({ limits: {
      maxInputTokens: "100", maxOutputTokens: -1, maxCostUsd: Number.POSITIVE_INFINITY,
    } })).toBe(false)
    expect(hasUnsupportedNestedScoutBudgetLimits({ limits: null, maxCostUsd: 0 })).toBe(true)
  })
})
