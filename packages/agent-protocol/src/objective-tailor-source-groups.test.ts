import { describe, expect, it } from "vitest"
import {
  OBJECTIVE_TAILOR_SOURCE_GROUPS_SCHEMA,
  parseObjectiveTailorSourceGroups,
} from "./objective-tailor-source-groups.js"

const scout = `src_${"A".repeat(43)}`
const analyst = `src_${"B".repeat(43)}`

function value(discoveredJobs: readonly string[] = [scout], analyzedJobs: readonly string[] = [analyst]) {
  return { schemaVersion: OBJECTIVE_TAILOR_SOURCE_GROUPS_SCHEMA, graphRevision: 4,
    groups: { discoveredJobs, analyzedJobs } }
}

describe("Objective Tailor source-group codec", () => {
  it("accepts bounded opaque groups, including empty zero-count groups", () => {
    expect(parseObjectiveTailorSourceGroups(value())).toEqual(value())
    expect(parseObjectiveTailorSourceGroups(value([], []))).toEqual(value([], []))
    expect(parseObjectiveTailorSourceGroups(value([scout], []))).toEqual(value([scout], []))
  })

  it("rejects duplicate, overlapping, overflow, malformed-key, or invalid-revision groups", () => {
    expect(parseObjectiveTailorSourceGroups(value([scout, scout], []))).toBeUndefined()
    expect(parseObjectiveTailorSourceGroups(value([scout], [scout]))).toBeUndefined()
    const eight = Array.from({ length: 8 }, (_, index) => `src_${String.fromCharCode(65 + index).repeat(43)}`)
    expect(parseObjectiveTailorSourceGroups(value(eight, [analyst]))).toBeUndefined()
    expect(parseObjectiveTailorSourceGroups(value(["source-private"], []))).toBeUndefined()
    expect(parseObjectiveTailorSourceGroups({ ...value(), graphRevision: 0 })).toBeUndefined()
    expect(parseObjectiveTailorSourceGroups({ ...value(), graphRevision: 1.5 })).toBeUndefined()
  })

  it("rejects open objects, custom array properties, and accessor values", () => {
    expect(parseObjectiveTailorSourceGroups({ ...value(), extra: true })).toBeUndefined()
    const protoKey = JSON.parse(JSON.stringify(value()))
    Object.defineProperty(protoKey, "__proto__", { value: { forged: true }, enumerable: true })
    expect(parseObjectiveTailorSourceGroups(protoKey)).toBeUndefined()
    const custom = value()
    Object.assign(custom.groups.discoveredJobs, { extra: true })
    expect(parseObjectiveTailorSourceGroups(custom)).toBeUndefined()
    const getter = value()
    Object.defineProperty(getter.groups, "analyzedJobs", { enumerable: true, get: () => [analyst] })
    expect(parseObjectiveTailorSourceGroups(getter)).toBeUndefined()
  })

  it("does not retain mutable input arrays", () => {
    const input = value()
    const parsed = parseObjectiveTailorSourceGroups(input)
    expect(parsed).toBeDefined()
    ;(input.groups.discoveredJobs as string[])[0] = analyst
    expect(parsed?.groups.discoveredJobs).toEqual([scout])
  })
})
