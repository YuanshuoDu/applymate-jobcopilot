import { describe, expect, it } from "vitest"

import {
  evaluateFindingsCoverScoutCandidateUnion,
  evaluateFindingsFromScoutUnion,
  remapTaskGraphVerificationCheckDependencies,
  taskGraphVerificationCheckDependencyNodeKeys,
} from "./task-graph-verification-scout-union.js"
import type { TaskGraphVerificationCheck } from "./task-graph-verification-contract.js"
import type { TaskGraphVerificationParsedProjection } from "./task-graph-verification-cross-node.js"

function scout(...jobIds: string[]) {
  return { role: "scout" as const, items: jobIds.map(jobId => ({ jobId, evidenceIds: [] })), evidenceIds: [] }
}

function dependencies(entries: Record<string, ReturnType<typeof scout>>) {
  return new Map(Object.entries(entries))
}

describe("TaskGraph verification Scout union checks", () => {
  it("selects the ordered direct keys for scalar and union checks", () => {
    expect(taskGraphVerificationCheckDependencyNodeKeys({ kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" }))
      .toEqual(["scout-a"])
    expect(taskGraphVerificationCheckDependencyNodeKeys({ kind: "finding_count_gte", minimum: 1 })).toEqual([])
    expect(taskGraphVerificationCheckDependencyNodeKeys({ kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-b", "scout-a"] }))
      .toEqual(["scout-b", "scout-a"])
  })

  it("remaps selected scalar and array keys without changing array order or external references", () => {
    const mapping = new Map([["old-a", "new-a"], ["old-b", "new-b"]])
    expect(remapTaskGraphVerificationCheckDependencies(
      { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "old-a", minimumPercent: 60 }, mapping,
    )).toEqual({ kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "new-a", minimumPercent: 60 })
    expect(remapTaskGraphVerificationCheckDependencies(
      { kind: "findings_from_scout_union", dependencyNodeKeys: ["external", "old-b", "old-a"] }, mapping,
    )).toEqual({ kind: "findings_from_scout_union", dependencyNodeKeys: ["external", "new-b", "new-a"] })
    expect(remapTaskGraphVerificationCheckDependencies(
      { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: ["old-a", "old-b"], minimumPercent: 75 },
      new Map([["old-a", "same"], ["old-b", "same"]]),
    )).toEqual({ kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: ["same", "same"], minimumPercent: 75 })
  })

  it("combines disjoint sources and uses only each check's selected union", () => {
    const parsed = dependencies({ a: scout("one"), b: scout("two"), c: scout("outside") })
    expect(evaluateFindingsFromScoutUnion(["a", "b"], ["one", "two"], parsed)).toBe("passed")
    expect(evaluateFindingsFromScoutUnion(["a", "b"], ["outside"], parsed)).toBe("criterion_not_met")
    expect(evaluateFindingsFromScoutUnion(["a", "c"], ["outside"], parsed)).toBe("passed")
  })

  it("deduplicates overlapping candidate IDs and applies exact integer percentage boundaries", () => {
    const parsed = dependencies({ a: scout("one", "shared"), b: scout("shared", "three") })
    expect(evaluateFindingsCoverScoutCandidateUnion(["a", "b"], ["one", "three"], parsed, 66)).toBe("passed")
    expect(evaluateFindingsCoverScoutCandidateUnion(["a", "b"], ["one", "three"], parsed, 67)).toBe("criterion_not_met")
    expect(evaluateFindingsCoverScoutCandidateUnion(["a", "b"], ["one"], parsed, 33)).toBe("passed")
    expect(evaluateFindingsCoverScoutCandidateUnion(["a", "b"], ["one"], parsed, 34)).toBe("criterion_not_met")
  })

  it("allows an empty Scout beside a nonempty Scout but never an all-empty union", () => {
    const parsed = dependencies({ empty: scout(), populated: scout("one") })
    expect(evaluateFindingsFromScoutUnion(["empty", "populated"], ["one"], parsed)).toBe("passed")
    expect(evaluateFindingsCoverScoutCandidateUnion(["empty", "populated"], ["one"], parsed, 100)).toBe("passed")
    expect(evaluateFindingsFromScoutUnion(["empty", "empty2"], ["one"], dependencies({ empty: scout(), empty2: scout() })))
      .toBe("criterion_not_met")
    expect(evaluateFindingsCoverScoutCandidateUnion(["empty", "empty2"], ["one"], dependencies({ empty: scout(), empty2: scout() }), 1))
      .toBe("criterion_not_met")
  })

  it("fails closed for empty findings, duplicate findings, invalid selectors, and non-Scout projections", () => {
    const parsed: ReadonlyMap<string, TaskGraphVerificationParsedProjection> = new Map([
      ["a", scout("one")], ["b", scout("two")], ["analyst", { ...scout("three"), role: "analyst" as const }],
    ])
    expect(evaluateFindingsFromScoutUnion(["a", "b"], [], parsed)).toBe("criterion_not_met")
    expect(evaluateFindingsFromScoutUnion(["a", "b"], ["one", "one"], parsed)).toBe("criterion_not_met")
    expect(evaluateFindingsFromScoutUnion(["a", "a"], ["one"], parsed)).toBe("criterion_not_met")
    expect(evaluateFindingsFromScoutUnion(["a"], ["one"], parsed)).toBe("criterion_not_met")
    expect(evaluateFindingsFromScoutUnion(["a", "analyst"], ["three"], parsed)).toBe("criterion_not_met")
    expect(evaluateFindingsCoverScoutCandidateUnion(["a", "b"], ["one"], parsed, 0)).toBe("criterion_not_met")
  })
})
