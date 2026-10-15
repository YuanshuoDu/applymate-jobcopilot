import { describe, expect, it } from "vitest"

import {
  buildScheduledAutomationSnapshot,
  ScheduledAutomationSnapshotValidationError,
  type ScheduledAutomationSnapshotInput,
} from "./scheduled-automation-snapshot"

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

  it("accepts eight roles and locations with trimmed 160-character entries", () => {
    const maxLengthEntry = "x".repeat(160)
    const paddedEntry = " " + maxLengthEntry + " "
    const snapshot = buildScheduledAutomationSnapshot({
      ...validInput(),
      targetRoles: Array(8).fill(paddedEntry),
      targetLocations: Array(8).fill(maxLengthEntry),
    })

    expect(snapshot.targetRoles).toEqual(Array(8).fill(maxLengthEntry))
    expect(snapshot.targetLocations).toEqual(Array(8).fill(maxLengthEntry))
  })

  it.each(["targetRoles", "targetLocations"] as const)("rejects more than eight %s entries", field => {
    expect(() => buildScheduledAutomationSnapshot({ ...validInput(), [field]: Array(9).fill("value") }))
      .toThrow(ScheduledAutomationSnapshotValidationError)
  })

  it.each(["targetRoles", "targetLocations"] as const)("rejects %s entries longer than 160 characters", field => {
    expect(() => buildScheduledAutomationSnapshot({
      ...validInput(),
      [field]: ["x".repeat(161)],
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
