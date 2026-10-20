import { describe, expect, it, vi } from "vitest"
import type { Queryable } from "./pg-store-persistence.js"
import { normalizeRootPlanCriteria, parsePersistedRootCriteria, parsePinnedRootCriteria, readRootPlanCriteriaObservation,
  requireNormalizedRootPlanCriteria, requireOwnedRootPlanCriteria, requireRootPlanCriteriaReadback, resolveRootPlanCriteria } from "./root-plan-criteria.js"

describe("root plan criteria", () => {
  it("bounds, trims, and deterministically deduplicates only additional model criteria", () => {
    expect(normalizeRootPlanCriteria(undefined)).toBeUndefined()
    expect(normalizeRootPlanCriteria(["  Keep original wording  ", "Keep original wording", "Check evidence"])).toEqual([
      "Keep original wording", "Check evidence",
    ])
    expect(normalizeRootPlanCriteria(["x".repeat(512)])).toEqual(["x".repeat(512)])
    expect(normalizeRootPlanCriteria(["💼".repeat(128)])).toEqual(["💼".repeat(128)])
    expect(requireNormalizedRootPlanCriteria([" Include evidence "])).toEqual(["Include evidence"])
    expect(() => requireNormalizedRootPlanCriteria([])).toThrow()
    for (const invalid of [[], ["  \n"], ["x".repeat(513)], ["💼".repeat(129)], Array.from({ length: 5 }, () => "criterion")]) {
      expect(normalizeRootPlanCriteria(invalid)).toBeNull()
    }
    const sparse: unknown[] = []
    sparse[1] = "criterion"
    expect(normalizeRootPlanCriteria(sparse)).toBeNull()
  })

  it("pins the complete bounded server goal before extra criteria and never replaces a pinned list", () => {
    const goal = "Find EU software roles and prepare an evidence-backed shortlist"
    const resolved = resolveRootPlanCriteria(goal, [], ["Only include Berlin roles"])
    expect(resolved).toEqual({ status: "persist", criteria: [goal, "Only include Berlin roles"] })
    expect(resolveRootPlanCriteria(goal, resolved.criteria, ["Only include Berlin roles"])).toEqual({
      status: "unchanged", criteria: [goal, "Only include Berlin roles"],
    })
    expect(resolveRootPlanCriteria(goal, resolved.criteria, ["Only include Berlin roles", "Add salaries"])).toEqual({ status: "conflict" })
    expect(resolveRootPlanCriteria("Changed objective", resolved.criteria, ["Only include Berlin roles"])).toEqual({ status: "conflict" })
    expect(resolveRootPlanCriteria("x".repeat(2_001), [], ["criterion"])).toEqual({ status: "invalid" })
    expect(parsePersistedRootCriteria([goal, "Only include Berlin roles"])).toEqual([goal, "Only include Berlin roles"])
    expect(parsePersistedRootCriteria([goal, goal])).toBeNull()
    expect(parsePersistedRootCriteria(["x".repeat(2_001)])).toBeNull()
    expect(readRootPlanCriteriaObservation({ revision: 1 })).toBeUndefined()
    expect(readRootPlanCriteriaObservation({ rootSuccessCriteria: [goal] })).toEqual([goal])
    expect(() => readRootPlanCriteriaObservation({ rootSuccessCriteria: null })).toThrow("task_graph_current_state_invalid:rootSuccessCriteria")
  })

  it("gates checklist writes against the owned Turn objective and validates pinned readback", async () => {
    const goal = "Find EU software roles"
    const query = vi.fn().mockResolvedValue({ rows: [{ input: { input: { goal } } }] })
    const client = { query } as unknown as Queryable
    const scope = { turnId: "turn", sessionId: "session", userId: "user", rootTaskId: "root" }
    await expect(requireOwnedRootPlanCriteria(client, scope, { goal, successCriteria: [] }, undefined, ["Include evidence"]))
      .resolves.toEqual([goal, "Include evidence"])
    await expect(requireOwnedRootPlanCriteria(client, scope, { goal, successCriteria: [] }, [goal, "Old checklist"], ["Changed checklist"]))
      .rejects.toMatchObject({ code: "root_success_criteria_conflict" })
    await expect(requireOwnedRootPlanCriteria(client, scope, { goal: "Changed objective", successCriteria: [] }, undefined, ["Include evidence"]))
      .rejects.toMatchObject({ code: "root_success_criteria_invalid" })
    expect(requireRootPlanCriteriaReadback(goal, [], [goal, "Include evidence"])).toEqual([goal, "Include evidence"])
    expect(() => requireRootPlanCriteriaReadback("Changed objective", [], [goal, "Include evidence"]))
      .toThrow(expect.objectContaining({ code: "root_success_criteria_invalid" }))
    expect(query).toHaveBeenCalledTimes(3)
  })

  it("rejects accessor criteria without evaluating the property or list entries", () => {
    let reads = 0
    const state: Record<string, unknown> = {}
    Object.defineProperty(state, "rootSuccessCriteria", {
      enumerable: true, get: () => { reads += 1; return ["Whole goal"] },
    })
    expect(() => readRootPlanCriteriaObservation(state)).toThrow("task_graph_current_state_invalid:rootSuccessCriteria")
    const criteria: unknown[] = []
    Object.defineProperty(criteria, "0", { enumerable: true, get: () => { reads += 1; return "Whole goal" } })
    expect(() => readRootPlanCriteriaObservation({ rootSuccessCriteria: criteria })).toThrow("task_graph_current_state_invalid:rootSuccessCriteria")
    expect(normalizeRootPlanCriteria(criteria)).toBeNull()
    const throwing = new Proxy({}, { getOwnPropertyDescriptor: () => { throw new Error("descriptor unavailable") } }) as Record<string, unknown>
    expect(() => readRootPlanCriteriaObservation(throwing)).toThrow("task_graph_current_state_invalid:rootSuccessCriteria")
    expect(reads).toBe(0)
  })

  it("parses only a bounded whole-goal pin plus the additional checklist", () => {
    const goal = "g".repeat(2_000), extras = Array.from({ length: 4 }, (_, index) => `${index}${"x".repeat(511)}`)
    expect(parsePinnedRootCriteria([goal])).toEqual([goal])
    expect(parsePinnedRootCriteria([goal, ...extras])).toEqual([goal, ...extras])
    expect(parsePinnedRootCriteria([goal, "x".repeat(600)])).toBeNull()
    expect(parsePinnedRootCriteria([goal, ...Array.from({ length: 6 }, (_, index) => `extra ${index}`)])).toBeNull()
    expect(parsePinnedRootCriteria(["x".repeat(2_001)])).toBeNull()
  })
})
