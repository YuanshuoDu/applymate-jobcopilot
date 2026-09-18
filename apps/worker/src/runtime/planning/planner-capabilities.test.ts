import { describe, expect, it, vi } from "vitest"

import { PlannerCapabilityError, derivePlannerCapabilityCatalog } from "./planner-capabilities.js"

function registry(definitions: readonly unknown[]) {
  return { list: vi.fn(() => definitions) }
}

describe("planner capability catalog", () => {
  it("keeps only server-requested tools and templates that are registered", () => {
    const catalog = derivePlannerCapabilityCatalog(registry([
      { name: "jobs.search", version: "1", template: "jobs.read" },
      { name: "jobs.get", version: "1" },
    ]), ["read"], ["jobs.search", "missing"], ["jobs.read", "missing-template"])

    expect(catalog).toEqual({ tools: ["jobs.search"], templates: ["jobs.read"] })
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.tools)).toBe(true)
  })

  it("fails closed with a typed error when the registry cannot be inspected", () => {
    const unavailable = { list: vi.fn(() => { throw new Error("registry down") }) }

    expect(() => derivePlannerCapabilityCatalog(unavailable, undefined, ["jobs.search"], [])).toThrowError(
      expect.objectContaining({ name: "PlannerCapabilityError", code: "planner_capability_unavailable" }),
    )
  })

  it("rejects malformed template metadata instead of advertising it", () => {
    expect(() => derivePlannerCapabilityCatalog(registry([{ name: "jobs.search", template: "" }]), undefined, ["jobs.search"], [])).toThrowError(
      expect.objectContaining({ name: "PlannerCapabilityError", code: "planner_capability_invalid" }),
    )
    expect(() => derivePlannerCapabilityCatalog(registry([]), undefined, [""], [])).toThrowError(PlannerCapabilityError)
  })
})
