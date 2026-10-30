import { describe, expect, it } from "vitest"

import {
  TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  taskGraphVerificationDependencyNodeKeys,
  validateTaskGraphVerificationDependencySelectors,
  type TaskGraphVerificationContract,
  type TaskGraphVerificationDependencyGraphNode,
} from "./task-graph-verification.js"
import {
  TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  evaluateFindingsCoverScoutCandidates,
  evaluateFindingsFromScoutDependency,
  parseTaskGraphVerificationEvidenceProjection,
} from "./task-graph-verification-cross-node.js"

const scoutContract: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
}
const analystContract: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [
    { id: "from-scout-a", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" } },
    { id: "from-scout-b", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-b" } },
    { id: "from-scout-again", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" } },
  ],
}
const coverageContract: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "coverage", check: { kind: "findings_cover_scout_candidates_gte", dependencyNodeKey: "scout-a", minimumPercent: 75 } }],
}
const perSourceCoverageContract: TaskGraphVerificationContract = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "analyst",
  criteria: [{ id: "coverage", check: { kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["scout-b", "scout-a"], minimumPercent: 75 } }],
}

function scout(key: string): TaskGraphVerificationDependencyGraphNode {
  return { key, templateId: "scout", dependsOn: [], verificationDisposition: "typed", verification: scoutContract }
}
function analyst(dependsOn: readonly string[]): TaskGraphVerificationDependencyGraphNode {
  return { key: "analyst", templateId: "analyst", dependsOn, verificationDisposition: "typed", verification: analystContract }
}

describe("TaskGraph cross-node verification selectors", () => {
  it("selects unique dependency keys in canonical order and accepts direct typed Scout edges", () => {
    expect(taskGraphVerificationDependencyNodeKeys(analystContract)).toEqual(["scout-a", "scout-b"])
    expect(validateTaskGraphVerificationDependencySelectors([scout("scout-b"), scout("scout-a"), analyst(["scout-a", "scout-b"])]))
      .toBe(true)
  })

  it("requires every selected union key to be a direct typed Scout and collects the sorted complete proof set", () => {
    const unionContract: TaskGraphVerificationContract = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
        { id: "membership", check: { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-b", "scout-a"] } },
        { id: "coverage", check: { kind: "findings_cover_scout_candidate_union_gte", dependencyNodeKeys: ["scout-c", "scout-a"], minimumPercent: 70 } },
      ],
    }
    const unionAnalyst = (dependsOn: readonly string[]): TaskGraphVerificationDependencyGraphNode => ({
      key: "analyst", templateId: "analyst", dependsOn, verificationDisposition: "typed", verification: unionContract,
    })
    expect(taskGraphVerificationDependencyNodeKeys(unionContract)).toEqual(["scout-a", "scout-b", "scout-c"])
    expect(validateTaskGraphVerificationDependencySelectors([
      scout("scout-a"), scout("scout-b"), scout("scout-c"), unionAnalyst(["scout-a", "scout-b", "scout-c"]),
    ])).toBe(true)
    expect(validateTaskGraphVerificationDependencySelectors([
      scout("scout-a"), scout("scout-b"), scout("scout-c"), unionAnalyst(["scout-a", "scout-b"]),
    ])).toBe(false)
    expect(validateTaskGraphVerificationDependencySelectors([
      scout("scout-a"), scout("scout-b"), { ...scout("scout-c"), verificationDisposition: "legacy_unverified", verification: undefined },
      unionAnalyst(["scout-a", "scout-b", "scout-c"]),
    ])).toBe(false)
  })

  it("collects every per-source selector and requires each to be a direct typed Scout", () => {
    const sourceAnalyst = (dependsOn: readonly string[]): TaskGraphVerificationDependencyGraphNode => ({
      key: "analyst", templateId: "analyst", dependsOn, verificationDisposition: "typed", verification: perSourceCoverageContract,
    })
    expect(taskGraphVerificationDependencyNodeKeys(perSourceCoverageContract)).toEqual(["scout-a", "scout-b"])
    expect(validateTaskGraphVerificationDependencySelectors([scout("scout-a"), scout("scout-b"), sourceAnalyst(["scout-a", "scout-b"])]))
      .toBe(true)
    expect(validateTaskGraphVerificationDependencySelectors([scout("scout-a"), scout("scout-b"), sourceAnalyst(["scout-a"])]))
      .toBe(false)
    expect(validateTaskGraphVerificationDependencySelectors([
      scout("scout-a"), { ...scout("scout-b"), verificationDisposition: "legacy_unverified", verification: undefined },
      sourceAnalyst(["scout-a", "scout-b"]),
    ])).toBe(false)
  })
  it("accepts zero Scout and Analyst results only when both bind the verified empty-search receipt", () => {
    const digest = "a".repeat(64)
    const scoutProjection = parseTaskGraphVerificationEvidenceProjection({
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout", candidates: [],
      evidenceIds: [`read:source:jobs.discover:${digest}`], emptyDiscoveryReceipt: { digest },
    })
    const analystProjection = parseTaskGraphVerificationEvidenceProjection({
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "analyst", findings: [],
      evidenceIds: [], emptyDiscoveryReceipt: { digest },
    })
    expect(scoutProjection.ok).toBe(true)
    expect(analystProjection.ok).toBe(true)
    if (!scoutProjection.ok || !analystProjection.ok) return
    const dependencies = new Map([["scout-a", scoutProjection.value]])
    expect(evaluateFindingsFromScoutDependency("scout-a", [], dependencies, digest)).toBe("passed")
    expect(evaluateFindingsCoverScoutCandidates("scout-a", [], dependencies, 75, digest)).toBe("passed")
    expect(evaluateFindingsFromScoutDependency("scout-a", [], dependencies, "b".repeat(64))).toBe("criterion_not_met")
    expect(evaluateFindingsCoverScoutCandidates("scout-a", [], dependencies, 75)).toBe("criterion_not_met")
  })

  it("rejects a zero Scout projection that lacks its canonical full-search receipt", () => {
    expect(parseTaskGraphVerificationEvidenceProjection({
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout", candidates: [], evidenceIds: [],
    })).toMatchObject({ ok: false, reasonCode: "canonical_evidence_missing" })
  })

  it("treats coverage as an exact direct typed Scout dependency", () => {
    const coverageAnalyst = (dependsOn: readonly string[]): TaskGraphVerificationDependencyGraphNode =>
      ({ key: "analyst", templateId: "analyst", dependsOn, verificationDisposition: "typed", verification: coverageContract })
    expect(taskGraphVerificationDependencyNodeKeys(coverageContract)).toEqual(["scout-a"])
    expect(validateTaskGraphVerificationDependencySelectors([scout("scout-a"), coverageAnalyst(["scout-a"])] )).toBe(true)
    expect(validateTaskGraphVerificationDependencySelectors([scout("scout-a"), coverageAnalyst([])])).toBe(false)
    expect(validateTaskGraphVerificationDependencySelectors([
      { ...scout("scout-a"), verificationDisposition: "legacy_unverified", verification: undefined }, coverageAnalyst(["scout-a"]),
    ])).toBe(false)
  })

  it.each([
    ["indirect source", [scout("scout-a"), analyst(["middle"])]],
    ["legacy source", [{ ...scout("scout-a"), verificationDisposition: "legacy_unverified", verification: undefined }, analyst(["scout-a"]) ]],
    ["specialized source", [{ key: "scout-a", templateId: "cover_letter_writer", dependsOn: [], verificationDisposition: "specialized" }, analyst(["scout-a"]) ]],
    ["wrong-role source", [{ ...analyst(["scout-a"]), key: "scout-a" }, analyst(["scout-a"]) ]],
  ] as const)("rejects a selector with a %s", (_label, nodes) => {
    expect(validateTaskGraphVerificationDependencySelectors(nodes as readonly TaskGraphVerificationDependencyGraphNode[])).toBe(false)
  })
})
