import { describe, expect, it } from "vitest"

import {
  COMMAND_DISPOSITIONS,
  OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
  OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION,
  parseObjectiveVerificationRequirements,
} from "./types"

const validRequirements = {
  schemaVersion: OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION,
  requirements: [
    { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } },
    { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
  ],
}

describe("Agent command contracts", () => {
  it("keeps the public disposition vocabulary closed", () => {
    expect(COMMAND_DISPOSITIONS).toEqual([
      "started",
      "steered",
      "queued_follow_up",
      "duplicate",
    ])
  })

  it("parses the exact objective requirement subset without changing its values or order", () => {
    const parsed = parseObjectiveVerificationRequirements(validRequirements)
    expect(parsed).toEqual(validRequirements)
    expect(parsed).not.toBe(validRequirements)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed?.requirements)).toBe(true)
  })

  it("accepts the full entry, ID, and minimum boundaries", () => {
    const requirements = Array.from({ length: 8 }, (_, index) => ({
      id: index === 0 ? `a${"b".repeat(63)}` : `count-${index}`,
      check: { kind: "candidate_count_gte" as const, minimum: index === 0 ? 1 : index === 7 ? 50 : 2 },
    }))
    const parsed = parseObjectiveVerificationRequirements({
      schemaVersion: OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION,
      requirements,
    })
    expect(parsed?.requirements).toHaveLength(8)
    expect(parsed?.requirements[0]?.id).toHaveLength(64)
    if (parsed?.schemaVersion !== OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION) throw new Error("expected v1 requirements")
    expect(parsed.requirements[0]?.check.minimum).toBe(1)
    expect(parsed.requirements[7]?.check.minimum).toBe(50)
  })

  it("parses the versioned location requirement with canonical, sorted, deduplicated values", () => {
    const parsed = parseObjectiveVerificationRequirements({
      schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
      requirements: [
        { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } },
        { id: "candidate-location", check: { kind: "candidate_location_in", locations: ["Dublin, Ireland", " Berlin ", "dublin"] } },
      ],
    })

    expect(parsed).toEqual({
      schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
      requirements: [
        { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } },
        { id: "candidate-location", check: { kind: "candidate_location_in", locations: ["berlin", "dublin", "dublin, ireland"] } },
      ],
    })
    expect(parseObjectiveVerificationRequirements(validRequirements)).toEqual(validRequirements)
  })

  it("rejects unsupported versions, kinds, bounds, malformed IDs, and duplicate IDs", () => {
    const invalid = [
      { ...validRequirements, schemaVersion: "other" },
      { ...validRequirements, requirements: [{ id: "A", check: { kind: "candidate_count_gte", minimum: 1 } }] },
      { ...validRequirements, requirements: [{ id: "same", check: { kind: "evidence_count_gte", minimum: 1 } }] },
      ...[0, 51, 1.5, Number.NaN, Number.POSITIVE_INFINITY].map((minimum) => ({
        ...validRequirements,
        requirements: [{ id: "count", check: { kind: "candidate_count_gte", minimum } }],
      })),
      { ...validRequirements, requirements: validRequirements.requirements.map((entry) => ({ ...entry, id: "same" })) },
      { ...validRequirements, requirements: [] },
      { ...validRequirements, requirements: Array.from({ length: 9 }, (_, index) => ({
        id: `count-${index}`, check: { kind: "candidate_count_gte", minimum: 1 },
      })) },
      {
        schemaVersion: OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION,
        requirements: [{ id: "candidate-location", check: { kind: "candidate_location_in", locations: ["Dublin"] } }],
      },
      {
        schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
        requirements: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
      },
      {
        schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
        requirements: [{ id: "not-the-location-id", check: { kind: "candidate_location_in", locations: ["Dublin"] } }],
      },
      {
        schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
        requirements: [{ id: "candidate-location", check: { kind: "candidate_location_in", locations: [] } }],
      },
      {
        schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
        requirements: [{ id: "candidate-location", check: { kind: "candidate_location_in", locations: ["x".repeat(129)] } }],
      },
      {
        schemaVersion: OBJECTIVE_LOCATION_REQUIREMENTS_SCHEMA_VERSION,
        requirements: Array.from({ length: 9 }, (_, index) => ({
          id: index === 0 ? "candidate-location" : `location-${index}`,
          check: { kind: "candidate_location_in", locations: [`City ${index}`] },
        })),
      },
    ]
    for (const value of invalid) expect(parseObjectiveVerificationRequirements(value)).toBeNull()
  })

  it("rejects extra, hidden, symbol, accessor, sparse-array, and custom-prototype fields", () => {
    const extra = { ...validRequirements, unexpected: true }
    const hidden = { ...validRequirements }
    Object.defineProperty(hidden, "hidden", { value: true })
    const symbol = { ...validRequirements, [Symbol("extra")]: true }
    const customPrototype = Object.assign(Object.create({ inherited: true }), validRequirements)
    const sparse = { ...validRequirements, requirements: new Array(1) }
    const extraArrayKey = [...validRequirements.requirements] as unknown[] & { extra?: boolean }
    extraArrayKey.extra = true
    const decoratedArray = { ...validRequirements, requirements: extraArrayKey }
    let getterCalls = 0
    const accessor = { schemaVersion: validRequirements.schemaVersion } as Record<string, unknown>
    Object.defineProperty(accessor, "requirements", {
      enumerable: true,
      get() { getterCalls += 1; return validRequirements.requirements },
    })

    for (const value of [extra, hidden, symbol, customPrototype, sparse, decoratedArray, accessor]) {
      expect(parseObjectiveVerificationRequirements(value)).toBeNull()
    }
    expect(getterCalls).toBe(0)
  })

  it("rejects extra fields at every nested level", () => {
    expect(parseObjectiveVerificationRequirements({
      ...validRequirements,
      requirements: [{ ...validRequirements.requirements[0], extra: true }],
    })).toBeNull()
    expect(parseObjectiveVerificationRequirements({
      ...validRequirements,
      requirements: [{
        id: "candidate-count",
        check: { ...validRequirements.requirements[0].check, extra: true },
      }],
    })).toBeNull()
  })
})
