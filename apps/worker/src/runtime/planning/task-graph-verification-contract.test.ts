import { describe, expect, it } from "vitest"
import {
  TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  validateTaskGraphVerificationContract,
  type TaskGraphVerificationCheck,
} from "./task-graph-verification-contract.js"

function contract(role: "scout" | "analyst", checks: readonly TaskGraphVerificationCheck[] | readonly unknown[]) {
  return {
    schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
    role,
    criteria: checks.map((check, index) => ({ id: `check-${index + 1}`, check })),
  }
}

describe("TaskGraph verification contract", () => {
  it("keeps existing scalar check shapes compatible", () => {
    const parsed = validateTaskGraphVerificationContract(contract("analyst", [
      { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" },
      { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout-b", minimumPercent: 75 },
    ]), "analyst")
    expect(parsed).toMatchObject({ ok: true, contract: { criteria: [
      { check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" } },
      { check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout-b", minimumPercent: 75 } },
    ] } })
  })

  it("accepts Analyst union checks and preserves selector order", () => {
    const checks: TaskGraphVerificationCheck[] = [
      { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-z", "scout-a"] },
      { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: ["scout-b", "scout-a"], minimumPercent: 100 },
    ]
    const parsed = validateTaskGraphVerificationContract(contract("analyst", checks), "analyst")
    expect(parsed).toEqual({ ok: true, contract: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: checks.map((check, index) => ({ id: `check-${index + 1}`, check })),
    } })
  })

  it("accepts explicit per-Scout coverage with the same strict selector and integer bounds", () => {
    const check = { kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["scout-b", "scout-a"], minimumPercent: 33 }
    expect(validateTaskGraphVerificationContract(contract("analyst", [check]), "analyst")).toEqual({ ok: true, contract: {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "check-1", check }],
    } })
    for (const malformed of [
      { ...check, dependencyNodeKeys: ["scout-a"] },
      { ...check, dependencyNodeKeys: ["scout-a", "scout-a"] },
      { ...check, dependencyNodeKeys: ["scout-a", " scout-b"] },
      { ...check, dependencyNodeKeys: Array.from({ length: 9 }, (_, index) => `scout-${index}`) },
      { ...check, minimumPercent: 0 }, { ...check, minimumPercent: 101 }, { ...check, minimumPercent: 33.5 },
      { ...check, extra: true },
    ]) expect(validateTaskGraphVerificationContract(contract("analyst", [malformed]), "analyst"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphVerificationContract(contract("scout", [check]), "scout"))
      .toMatchObject({ ok: false, error: { code: "unknown_check" } })
    const eight = { ...check, dependencyNodeKeys: Array.from({ length: 8 }, (_, index) => `scout-${index}`) }
    expect(validateTaskGraphVerificationContract(contract("analyst", [eight]), "analyst")).toMatchObject({ ok: true })
  })

  it("rejects wrong-role, malformed, duplicate, and out-of-range union selectors", () => {
    const validKeys = ["scout-a", "scout-b"]
    const malformed: unknown[] = [
      { kind: "findings_from_scout_union", dependencyNodeKeys: [] },
      { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a"] },
      { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-a"] },
      { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-b", "scout-c", "scout-d", "scout-e", "scout-f", "scout-g", "scout-h", "scout-i"] },
      { kind: "findings_from_scout_union", dependencyNodeKeys: ["", "scout-b"] },
      { kind: "findings_from_scout_union", dependencyNodeKeys: [" ", "scout-b"] },
      { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", " scout-b"] },
      { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "x".repeat(129)] },
      { kind: "findings_from_scout_union", dependencyNodeKeys: validKeys, extra: true },
      { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: validKeys, minimumPercent: 0 },
      { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: validKeys, minimumPercent: 101 },
      { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: validKeys, minimumPercent: 75.5 },
      { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: validKeys, minimumPercent: 75, extra: true },
    ]
    for (const check of malformed) {
      expect(validateTaskGraphVerificationContract(contract("analyst", [check]), "analyst")).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    }
    expect(validateTaskGraphVerificationContract(contract("scout", [
      { kind: "findings_from_scout_union", dependencyNodeKeys: validKeys },
    ]), "scout")).toMatchObject({ ok: false, error: { code: "unknown_check" } })
  })

  it("rejects sparse, accessor, symbol, extra-property, and non-plain selector arrays without reading accessors", () => {
    let invoked = false
    const sparse = new Array<string>(2)
    sparse[1] = "scout-b"
    const accessor = ["scout-a", "scout-b"]
    Object.defineProperty(accessor, "0", { enumerable: true, get: () => { invoked = true; return "scout-a" } })
    const symbolArray = ["scout-a", "scout-b"]
    Object.defineProperty(symbolArray, Symbol("extra"), { enumerable: true, value: true })
    const extraArray = ["scout-a", "scout-b"] as string[] & { extra?: boolean }
    extraArray.extra = true
    const nonPlainArray = Object.setPrototypeOf(["scout-a", "scout-b"], Object.create(Array.prototype)) as string[]
    const selectorProxy = new Proxy(["scout-a", "scout-b"], { ownKeys: () => { throw new Error("selector_proxy") } })
    const checkProxyTarget = { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-b"] }
    const checkProxy = new Proxy(checkProxyTarget, { ownKeys: () => { throw new Error("check_proxy") } })
    const checks = [sparse, accessor, symbolArray, extraArray, nonPlainArray, selectorProxy].map(dependencyNodeKeys => ({
      kind: "findings_from_scout_union", dependencyNodeKeys,
    })).concat([checkProxy])

    for (const check of checks) {
      expect(validateTaskGraphVerificationContract(contract("analyst", [check]), "analyst")).toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    }
    expect(invoked).toBe(false)
  })

  it("retains strict record and criterion validation for legacy contracts", () => {
    const check = Object.defineProperty({}, "kind", { enumerable: true, get: () => { throw new Error("getter_invoked") } })
    const symbolCheck = { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-b"] }
    Object.defineProperty(symbolCheck, Symbol("extra"), { enumerable: true, value: true })
    const inheritedCheck = Object.assign(Object.create({ inherited: true }), {
      kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-a", "scout-b"],
    })
    expect(validateTaskGraphVerificationContract(contract("analyst", [check]), "analyst"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    for (const malformed of [symbolCheck, inheritedCheck]) {
      expect(validateTaskGraphVerificationContract(contract("analyst", [malformed]), "analyst"))
        .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    }
    expect(validateTaskGraphVerificationContract({ ...contract("analyst", []), extra: true }, "analyst"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphVerificationContract(contract("analyst", [
      { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" },
    ]), "writer")).toMatchObject({ ok: false, error: { code: "unsupported_template" } })
  })
})
