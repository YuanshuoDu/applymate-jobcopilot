import { describe, expect, it } from "vitest"
import {
  isScheduledAutomationTurn, parseScheduledAutomationSnapshot, sameScheduledAutomationCriteria,
  scheduledAutomationCriteria, scheduledAutomationHistoryCompatibilitySql, SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION,
} from "./scheduled-automation-snapshot.js"

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION,
    targetRoles: ["Engineer"], targetLocations: ["Dublin"], minScore: 70,
    dailyCap: 10, requireApproval: true, autoApply: false,
    ...overrides,
  }
}

describe("scheduled automation snapshot validator", () => {
  it("validates the full snapshot and returns normalized, immutable criteria", () => {
    const parsed = parseScheduledAutomationSnapshot(snapshot({
      targetRoles: [" Engineer ", "AI Engineer"], targetLocations: [], minScore: 0,
    }))

    expect(parsed).toEqual({
      schemaVersion: SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION,
      targetRoles: ["Engineer", "AI Engineer"], targetLocations: [], minScore: 0,
      dailyCap: 10, requireApproval: true, autoApply: false,
    })
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.targetRoles)).toBe(true)
    expect(scheduledAutomationCriteria({ scheduledAutomationSnapshot: snapshot() })).toEqual({
      targetRoles: ["Engineer"], targetLocations: ["Dublin"], minScore: 70,
    })
  })

  it.each([
    ["missing", undefined],
    ["null", null],
    ["array", []],
    ["wrong schema version", snapshot({ schemaVersion: "v2" })],
    ["missing field", (() => { const { autoApply: _omitted, ...value } = snapshot(); return value })()],
    ["extra field", snapshot({ automationId: "private-id" })],
    ["empty roles", snapshot({ targetRoles: [] })],
    ["too many roles", snapshot({ targetRoles: Array(9).fill("Engineer") })],
    ["blank role", snapshot({ targetRoles: [" \t "] })],
    ["long role", snapshot({ targetRoles: ["x".repeat(161)] })],
    ["non-string role", snapshot({ targetRoles: [1] })],
    ["sparse role list", snapshot({ targetRoles: Object.assign(Array(2), { 1: "Engineer" }) })],
    ["too many locations", snapshot({ targetLocations: Array(9).fill("Dublin") })],
    ["blank location", snapshot({ targetLocations: ["  "] })],
    ["non-array locations", snapshot({ targetLocations: null })],
    ["fractional score", snapshot({ minScore: 70.5 })],
    ["out-of-range score", snapshot({ minScore: 101 })],
    ["zero daily cap", snapshot({ dailyCap: 0 })],
    ["fractional daily cap", snapshot({ dailyCap: 1.5 })],
    ["non-boolean approval", snapshot({ requireApproval: "true" })],
    ["non-boolean auto-apply", snapshot({ autoApply: 0 })],
  ])("rejects a %s snapshot", (_name, value) => {
    expect(parseScheduledAutomationSnapshot(value)).toBeUndefined()
  })

  it("rejects accessors and non-plain snapshot objects without reading them", () => {
    let getterCalled = false
    const accessor = snapshot()
    Object.defineProperty(accessor, "dailyCap", { enumerable: true, get() { getterCalled = true; return 10 } })

    expect(parseScheduledAutomationSnapshot(accessor)).toBeUndefined()
    expect(getterCalled).toBe(false)
    expect(parseScheduledAutomationSnapshot(Object.assign(Object.create({ inherited: true }), snapshot()))).toBeUndefined()
  })

  it("matches JavaScript integer parsing at decimal boundaries and guards SQL float casts", () => {
    const precise = JSON.stringify(snapshot({ minScore: 100 }))
      .replace('"minScore":100', '"minScore":100.00000000000000000000000001')
      .replace('"dailyCap":10', '"dailyCap":10.00000000000000000000000001')
    const huge = JSON.stringify(snapshot({ minScore: 100 })).replace('"minScore":100', '"minScore":1e10000')

    expect(parseScheduledAutomationSnapshot(JSON.parse(precise))).toMatchObject({ minScore: 100, dailyCap: 10 })
    expect(parseScheduledAutomationSnapshot(JSON.parse(huge))).toBeUndefined()

    const sql = scheduledAutomationHistoryCompatibilitySql("$5")
    expect(sql).toContain("COALESCE((turn.\"source\" = 'automation' AND turn.\"input\"->>'automationRunMode' = 'scheduled'), FALSE)")
    expect(sql).toContain("::numeric NOT BETWEEN -1 AND 101")
    expect(sql).toContain("::numeric NOT BETWEEN 0 AND 51")
    expect(sql).toContain("::double precision")
    expect(sql).toContain("to_jsonb((")
  })

  it("requires matching ordered criteria and marks only automation scheduled Turns", () => {
    const left = { targetRoles: ["Engineer", "AI Engineer"], targetLocations: ["Dublin"], minScore: 70 }
    expect(sameScheduledAutomationCriteria(left, { ...left, targetRoles: ["AI Engineer", "Engineer"] })).toBe(false)
    expect(sameScheduledAutomationCriteria(left, { ...left, targetLocations: ["Berlin"] })).toBe(false)
    expect(sameScheduledAutomationCriteria(left, { ...left, minScore: 71 })).toBe(false)
    expect(sameScheduledAutomationCriteria(left, { ...left })).toBe(true)
    expect(isScheduledAutomationTurn("automation", { automationRunMode: "scheduled" })).toBe(true)
    expect(isScheduledAutomationTurn("user", { automationRunMode: "scheduled" })).toBe(false)
    expect(isScheduledAutomationTurn("automation", { automationRunMode: "manual" })).toBe(false)
  })
})
