import { describe, expect, it } from "vitest"

import {
  evaluateFindingsCoverScoutCandidateUnion,
  evaluateFindingsCoverEachScoutCandidates,
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
    expect(taskGraphVerificationCheckDependencyNodeKeys({ kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["scout-b", "scout-a"], minimumPercent: 60 }))
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
    expect(remapTaskGraphVerificationCheckDependencies(
      { kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["old-a", "external"], minimumPercent: 75 }, mapping,
    )).toEqual({ kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["new-a", "external"], minimumPercent: 75 })
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

  it("requires each selected Scout to meet its own threshold, counting overlap for each source", () => {
    const disjoint = dependencies({ a: scout("a1", "a2", "a3", "a4"), b: scout("b1", "b2", "b3", "b4") })
    expect(evaluateFindingsCoverEachScoutCandidates(["a", "b"], ["a1", "a2"], disjoint, 25)).toBe("criterion_not_met")
    expect(evaluateFindingsCoverEachScoutCandidates(["a", "b"], ["a1", "a2", "b1", "b2"], disjoint, 50)).toBe("passed")

    const overlap = dependencies({
      a: scout("shared-1", "shared-2", "a-only-1", "a-only-2"),
      b: scout("shared-1", "shared-2", "b-only-1", "b-only-2"),
    })
    expect(evaluateFindingsCoverEachScoutCandidates(["a", "b"], ["shared-1", "shared-2"], overlap, 50)).toBe("passed")
    expect(evaluateFindingsCoverEachScoutCandidates(["a", "b"], ["shared"], overlap, 75)).toBe("criterion_not_met")

    const third = dependencies({ a: scout("one", "two", "three"), b: scout("other") })
    expect(evaluateFindingsCoverEachScoutCandidates(["a", "b"], ["one", "other"], third, 33)).toBe("passed")
    expect(evaluateFindingsCoverEachScoutCandidates(["a", "b"], ["one", "other"], third, 34)).toBe("criterion_not_met")
  })

  it("fails closed for empty selected sources, outsiders, duplicate findings, invalid selectors, and thresholds", () => {
    const parsed = dependencies({ empty: scout(), populated: scout("one"), other: scout("two") })
    expect(evaluateFindingsCoverEachScoutCandidates(["empty", "populated"], ["one"], parsed, 1)).toBe("criterion_not_met")
    expect(evaluateFindingsCoverEachScoutCandidates(["populated", "other"], ["one", "outside"], parsed, 1)).toBe("criterion_not_met")
    expect(evaluateFindingsCoverEachScoutCandidates(["populated", "other"], ["one", "one"], parsed, 1)).toBe("criterion_not_met")
    expect(evaluateFindingsCoverEachScoutCandidates(["populated", "populated"], ["one"], parsed, 1)).toBe("criterion_not_met")
    expect(evaluateFindingsCoverEachScoutCandidates(["populated", "other"], ["one", "two"], parsed, 0)).toBe("criterion_not_met")
    expect(evaluateFindingsCoverEachScoutCandidates(["populated", "other"], [], parsed, 1)).toBe("criterion_not_met")
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
    const parsed: ReadonlyMap<string, TaskGraphVerificationParsedProjection> = new Map<string, TaskGraphVerificationParsedProjection>([
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
