import { describe, expect, it } from "vitest"

import {
  buildScheduledAutomationSnapshot,
  parseAutomationRunMode,
  parseScheduledAutomationSnapshot,
  ScheduledAutomationSnapshotValidationError,
  type ScheduledAutomationSnapshotInput,
} from "./scheduled-automation-snapshot"
import { JobsSearchInputSchema } from "./discovery-tool-types"

type SearchTargetField = "targetRoles" | "targetLocations"

function schemaRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function schemaTargetBound(field: SearchTargetField, bound: "minItems" | "maxItems" | "maxLength"): number {
  const target = schemaRecord(schemaRecord(JobsSearchInputSchema.properties)?.[field])
  const value = bound === "maxLength" ? schemaRecord(target?.items)?.maxLength : target?.[bound]
  const resolved = value === undefined && bound === "minItems" ? 0 : value
  if (typeof resolved !== "number" || !Number.isSafeInteger(resolved)) throw new Error("Missing search target schema bound")
  return resolved
}

function validInput(): ScheduledAutomationSnapshotInput {
  return {
    targetRoles: ["Engineer", "Data Scientist"],
    targetLocations: ["Dublin", "Amsterdam"],
    minScore: 75,
    dailyCap: 12,
    requireApproval: false,
    autoApply: true,
  }
}

function validSnapshot() {
  return {
    schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
    ...validInput(),
  }
}

describe("parseAutomationRunMode", () => {
  it.each([["scheduled"], ["manual"]] as const)("accepts the %s marker", mode => {
    expect(parseAutomationRunMode(mode)).toBe(mode)
  })

  it.each([undefined, null, "unknown", "Scheduled", 1])("rejects a missing or unknown marker (%s)", value => {
    expect(parseAutomationRunMode(value)).toBeNull()
  })
})

describe("parseScheduledAutomationSnapshot", () => {
  it("accepts only the complete versioned snapshot envelope", () => {
    expect(parseScheduledAutomationSnapshot(validSnapshot())).toEqual({
      schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
      ...validInput(),
    })
  })

  it.each([
    ["wrong schema version", { ...validSnapshot(), schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v2" }],
    ["missing field", (() => { const value = validSnapshot(); delete (value as Record<string, unknown>).dailyCap; return value })()],
    ["extra field", { ...validSnapshot(), automationId: "mutable-row-id" }],
    ["out-of-range saved value", { ...validSnapshot(), dailyCap: 0 }],
    ["too few targetRoles", {
      ...validSnapshot(), targetRoles: Array(schemaTargetBound("targetRoles", "minItems") - 1).fill("Role"),
    }],
    ["out-of-range targetLocations", {
      ...validSnapshot(), targetLocations: Array(schemaTargetBound("targetLocations", "maxItems") + 1).fill("Location"),
    }],
    ["overlong targetRoles entry", { ...validSnapshot(), targetRoles: ["x".repeat(schemaTargetBound("targetRoles", "maxLength") + 1)] }],
    ["overlong targetLocations entry", { ...validSnapshot(), targetLocations: ["x".repeat(schemaTargetBound("targetLocations", "maxLength") + 1)] }],
  ])("rejects a persisted snapshot with %s", (_label, value) => {
    expect(() => parseScheduledAutomationSnapshot(value)).toThrow(ScheduledAutomationSnapshotValidationError)
  })
})

describe("buildScheduledAutomationSnapshot", () => {
  it("builds the versioned snapshot while preserving values and array order", () => {
    expect(buildScheduledAutomationSnapshot(validInput())).toEqual({
      schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
      targetRoles: ["Engineer", "Data Scientist"],
      targetLocations: ["Dublin", "Amsterdam"],
      minScore: 75,
      dailyCap: 12,
      requireApproval: false,
      autoApply: true,
    })
  })

  it("trims non-empty role and location entries while preserving their order", () => {
    expect(buildScheduledAutomationSnapshot({
      ...validInput(),
      targetRoles: ["  Engineer ", "Data Scientist  "],
      targetLocations: [" Dublin", "Amsterdam  "],
    })).toMatchObject({
      targetRoles: ["Engineer", "Data Scientist"],
      targetLocations: ["Dublin", "Amsterdam"],
    })
  })

  it.each([
    ["targetRoles", [""]],
    ["targetRoles", [" \t "]],
    ["targetLocations", [""]],
    ["targetLocations", [" \t "]],
  ] as const)("rejects blank-only %s entries", (field, value) => {
    expect(() => buildScheduledAutomationSnapshot({ ...validInput(), [field]: value }))
      .toThrow(ScheduledAutomationSnapshotValidationError)
  })

  it("accepts the inclusive numeric bounds and empty locations", () => {
    expect(buildScheduledAutomationSnapshot({
      targetRoles: ["Engineer"],
      targetLocations: [],
      minScore: 0,
      dailyCap: 1,
      requireApproval: true,
      autoApply: false,
    })).toMatchObject({ targetRoles: ["Engineer"], targetLocations: [], minScore: 0, dailyCap: 1 })
    expect(buildScheduledAutomationSnapshot({
      ...validInput(),
      minScore: 100,
      dailyCap: 50,
    })).toMatchObject({ minScore: 100, dailyCap: 50 })
  })

  it("requires at least one role while allowing empty locations", () => {
    expect(() => buildScheduledAutomationSnapshot({ ...validInput(), targetRoles: [] }))
      .toThrow(ScheduledAutomationSnapshotValidationError)
    expect(buildScheduledAutomationSnapshot({ ...validInput(), targetLocations: [] }))
      .toMatchObject({ targetRoles: ["Engineer", "Data Scientist"], targetLocations: [] })
  })

  it("accepts schema-max roles and locations with trimmed max-length entries", () => {
    const roleMaxLengthEntry = "x".repeat(schemaTargetBound("targetRoles", "maxLength"))
    const locationMaxLengthEntry = "x".repeat(schemaTargetBound("targetLocations", "maxLength"))
    const paddedRoleEntry = " " + roleMaxLengthEntry + " "
    const snapshot = buildScheduledAutomationSnapshot({
      ...validInput(),
      targetRoles: Array(schemaTargetBound("targetRoles", "maxItems")).fill(paddedRoleEntry),
      targetLocations: Array(schemaTargetBound("targetLocations", "maxItems")).fill(locationMaxLengthEntry),
    })

    expect(snapshot.targetRoles).toEqual(Array(schemaTargetBound("targetRoles", "maxItems")).fill(roleMaxLengthEntry))
    expect(snapshot.targetLocations).toEqual(Array(schemaTargetBound("targetLocations", "maxItems")).fill(locationMaxLengthEntry))
  })

  it.each(["targetRoles", "targetLocations"] as const)("rejects %s entries above the schema maximum", field => {
    expect(() => buildScheduledAutomationSnapshot({
      ...validInput(), [field]: Array(schemaTargetBound(field, "maxItems") + 1).fill("value"),
    }))
      .toThrow(ScheduledAutomationSnapshotValidationError)
  })

  it.each(["targetRoles", "targetLocations"] as const)("rejects %s entries above the schema maxLength", field => {
    expect(() => buildScheduledAutomationSnapshot({
      ...validInput(),
      [field]: ["x".repeat(schemaTargetBound(field, "maxLength") + 1)],
    })).toThrow(ScheduledAutomationSnapshotValidationError)
  })

  it("rejects a non-object input with a typed, clear error", () => {
    expect(() => buildScheduledAutomationSnapshot(null as unknown as ScheduledAutomationSnapshotInput))
      .toThrow(ScheduledAutomationSnapshotValidationError)
    try {
      buildScheduledAutomationSnapshot(null as unknown as ScheduledAutomationSnapshotInput)
    } catch (error) {
      expect(error).toBeInstanceOf(ScheduledAutomationSnapshotValidationError)
      expect((error as ScheduledAutomationSnapshotValidationError).message).toContain('"input"')
    }
  })

  it("rejects each missing required field", () => {
    const fields: (keyof ScheduledAutomationSnapshotInput)[] = [
      "targetRoles", "targetLocations", "minScore", "dailyCap", "requireApproval", "autoApply",
    ]
    for (const field of fields) {
      const input = validInput()
      delete input[field]
      expect(() => buildScheduledAutomationSnapshot(input))
        .toThrow(ScheduledAutomationSnapshotValidationError)
    }
  })

  it.each([
    ["targetRoles", 3],
    ["targetRoles", ["Engineer", 3]],
    ["targetLocations", "Dublin"],
    ["targetLocations", ["Dublin", null]],
    ["minScore", -1],
    ["minScore", 101],
    ["minScore", 4.5],
    ["minScore", "75"],
    ["dailyCap", 0],
    ["dailyCap", 51],
    ["dailyCap", 2.5],
    ["dailyCap", "12"],
    ["requireApproval", 0],
    ["autoApply", "true"],
  ] as const)("rejects invalid %s values", (field, badValue) => {
    expect(() => buildScheduledAutomationSnapshot({ ...validInput(), [field]: badValue }))
      .toThrow(ScheduledAutomationSnapshotValidationError)
  })

  it("rejects sparse arrays as arrays that do not contain only strings", () => {
    const roles = new Array(1)
    expect(() => buildScheduledAutomationSnapshot({ ...validInput(), targetRoles: roles }))
      .toThrow(ScheduledAutomationSnapshotValidationError)
  })

  it("copies both input arrays so later mutation cannot change the snapshot", () => {
    const input = validInput()
    const roles = input.targetRoles as string[]
    const locations = input.targetLocations as string[]
    const snapshot = buildScheduledAutomationSnapshot(input)

    roles.push("Designer")
    locations[0] = "Cork"

    expect(snapshot.targetRoles).toEqual(["Engineer", "Data Scientist"])
    expect(snapshot.targetLocations).toEqual(["Dublin", "Amsterdam"])
  })
})
