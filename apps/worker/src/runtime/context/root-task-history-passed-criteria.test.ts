import { describe, expect, it } from "vitest"
import { taskGraphResultDigest } from "../subagents/task-graph-pg-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-verification-report.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import {
  copyRootTaskHistoryPassedCriteria,
  deriveRootTaskHistoryPassedCriteria,
  filterRootTaskHistoryPassedCriteriaForEmittedNodes,
  parseRootTaskHistoryPassedCriteria,
  type RootTaskHistoryPassedCriterion,
} from "./root-task-history-passed-criteria.js"

const scoutCheck = { role: "scout", kind: "candidate_count_gte", minimum: 1 } as const
const analystCheck = { role: "analyst", kind: "finding_count_gte", minimum: 1 } as const
type Input = Parameters<typeof deriveRootTaskHistoryPassedCriteria>[0]
type Role = "scout" | "analyst"

function result(role: Role) {
  const evidence = [{ id: "e1", kind: "job", ref: "job-1", source: "greenhouse" }]
  return role === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", candidates: [{ jobId: "job-1",
      source: "greenhouse", url: null, evidenceIds: ["e1"] }], evidence, summary: "one result" }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role, status: "completed", findings: [{ jobId: "job-1",
      score: 8, evidenceIds: ["e1"] }], evidence, summary: "one result" }
}

function report(ids: readonly string[], value: unknown) {
  return {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION,
    status: "passed" as const,
    reasonCode: "criteria_met" as const,
    criteria: ids.map(criterionId => ({ criterionId, status: "passed" as const, reasonCode: "criteria_met" as const })),
    evidenceDigest: "a".repeat(64),
    resultDigest: taskGraphResultDigest(value),
  }
}

function inputFor(role: Role, ids: readonly string[] = ["criterion"]): Input {
  const structuredResult = result(role), check = role === "scout" ? scoutCheck : analystCheck, currentReport = report(ids, structuredResult)
  return {
    role, templateId: role, taskRole: role, verificationRole: role, verificationDisposition: "typed",
    status: "completed", failureReason: null, attemptCount: 1, isRepair: false, isNative: false,
    criterionIds: ids, currentReport, persistedReport: currentReport, structuredResult, checkDescriptors: ids.map(() => check),
  }
}

describe("root task history passed criteria derivation", () => {
  it.each(["scout", "analyst"] as const)("emits digest-bound typed %s pass facts as source-local ordinals", role => {
    const facts = deriveRootTaskHistoryPassedCriteria(inputFor(role))
    expect(facts).toEqual([{
      criterionOrdinal: 1, status: "passed", check: role === "scout" ? scoutCheck : analystCheck,
    }])
    const serialized = JSON.stringify(facts)
    for (const privateValue of [
      '"criterion"', "job-1", "e1", "greenhouse", taskGraphResultDigest(result(role)),
    ]) expect(serialized).not.toContain(privateValue)
  })

  it("omits unknown descriptors while preserving known pass facts at their original ordinals", () => {
    const base = inputFor("analyst", ["unknown-check", "known-check"])
    const facts = deriveRootTaskHistoryPassedCriteria({ ...base, checkDescriptors: [undefined, analystCheck] })
    expect(facts).toEqual([{ criterionOrdinal: 2, status: "passed", check: analystCheck }])
    expect(deriveRootTaskHistoryPassedCriteria({ ...base, checkDescriptors: [undefined, undefined] })).toBeUndefined()
  })

  it("rejects noncompleted, failed, untyped, native, repair, or invalid-attempt sources", () => {
    const base = inputFor("scout")
    const invalid: Partial<Input>[] = [
      { status: "running" }, { failureReason: undefined }, { failureReason: "failed" },
      { verificationDisposition: "legacy" }, { verificationDisposition: undefined }, { isNative: true }, { isRepair: true },
      { attemptCount: 0 }, { attemptCount: -1 }, { attemptCount: 1.5 }, { attemptCount: Number.MAX_SAFE_INTEGER + 1 },
      { templateId: "analyst" }, { taskRole: "analyst" }, { verificationRole: "analyst" },
    ]
    for (const changes of invalid) expect(deriveRootTaskHistoryPassedCriteria({ ...base, ...changes })).toBeUndefined()
  })

  it("requires matching canonical current and persisted all-passed reports plus the stored result digest", () => {
    const base = inputFor("analyst")
    const changedDigest = { ...base.currentReport!, resultDigest: "b".repeat(64) }
    expect(deriveRootTaskHistoryPassedCriteria({ ...base, currentReport: changedDigest, persistedReport: changedDigest })).toBeUndefined()
    expect(deriveRootTaskHistoryPassedCriteria({ ...base, persistedReport: { ...base.currentReport!, resultDigest: "b".repeat(64) } })).toBeUndefined()
    expect(deriveRootTaskHistoryPassedCriteria({ ...base, currentReport: undefined })).toBeUndefined()
    expect(deriveRootTaskHistoryPassedCriteria({ ...base, structuredResult: undefined })).toBeUndefined()
    expect(deriveRootTaskHistoryPassedCriteria({
      ...base, currentReport: { ...base.currentReport!, criteria: [{ criterionId: "other", status: "passed", reasonCode: "criteria_met" }] },
    })).toBeUndefined()
    expect(deriveRootTaskHistoryPassedCriteria({
      ...base, currentReport: { ...base.currentReport!, criteria: [{ criterionId: "criterion", status: "failed", reasonCode: "criterion_not_met" }] },
    })).toBeUndefined()
  })
})

describe("root task history passed criteria parsing and pruning", () => {
  const parseCheck = (value: unknown, expectedRole?: string) => {
    if (value === scoutCheck && (expectedRole === undefined || expectedRole === "scout")) return scoutCheck
    if (value === analystCheck && (expectedRole === undefined || expectedRole === "analyst")) return analystCheck
    return undefined
  }
  const lesson = (passedCriteria: unknown) => ({
    ordinalScope: "source_graph_local", advisoryOnly: true, notCurrentEvidence: true,
    nodeOrdinal: 2, criterionFailures: [], passedCriteria,
  })

  it("parses only nonempty ordered unique fixed-status facts with one matching known role", () => {
    const valid = [{ criterionOrdinal: 1, status: "passed", check: analystCheck },
      { criterionOrdinal: 3, status: "passed", check: analystCheck }]
    expect(parseRootTaskHistoryPassedCriteria(valid, "analyst", parseCheck)).toEqual(valid)
    expect(parseRootTaskHistoryPassedCriteria([
      { criterionOrdinal: 1, status: "passed", check: analystCheck }, { criterionOrdinal: 2, status: "passed", check: scoutCheck },
    ], undefined, parseCheck)).toBeUndefined()
    let getterReads = 0
    const accessor = Object.defineProperty({ criterionOrdinal: 1, status: "passed" }, "check", {
      enumerable: true, get: () => { getterReads += 1; return analystCheck },
    })
    expect(parseRootTaskHistoryPassedCriteria([accessor], "analyst", parseCheck)).toBeUndefined()
    expect(getterReads).toBe(0)
    for (const invalid of [
      [], [{ criterionOrdinal: 1, status: "failed", check: analystCheck }],
      [{ criterionOrdinal: 0, status: "passed", check: analystCheck }],
      [{ criterionOrdinal: 9, status: "passed", check: analystCheck }],
      [{ criterionOrdinal: 2, status: "passed", check: analystCheck }, { criterionOrdinal: 1, status: "passed", check: analystCheck }],
      [{ criterionOrdinal: 1, status: "passed", check: analystCheck }, { criterionOrdinal: 1, status: "passed", check: analystCheck }],
      [{ criterionOrdinal: 1, status: "passed", check: analystCheck, privateId: "secret" }],
      [{ criterionOrdinal: 1, status: "passed", check: scoutCheck }],
      [{ criterionOrdinal: 1, status: "passed", check: analystCheck }, { criterionOrdinal: 2, status: "passed", check: scoutCheck }],
    ]) expect(parseRootTaskHistoryPassedCriteria(invalid, "analyst", parseCheck)).toBeUndefined()
  })

  it("drops whole dependent pass facts when their source ordinal is absent and copies only closed fields", () => {
    const dependent = { criterionOrdinal: 1, status: "passed" as const,
      check: { role: "analyst", kind: "findings_from_scout_dependency", dependencyNodeOrdinal: 1 } as const }
    const independent = { criterionOrdinal: 2, status: "passed" as const, check: analystCheck }
    const facts: readonly RootTaskHistoryPassedCriterion[] = [dependent, independent]
    expect(filterRootTaskHistoryPassedCriteriaForEmittedNodes(facts, new Set([1]))).toEqual(facts)
    expect(filterRootTaskHistoryPassedCriteriaForEmittedNodes(facts, new Set([2]))).toEqual([independent])
    expect(filterRootTaskHistoryPassedCriteriaForEmittedNodes([dependent], new Set([2]))).toBeUndefined()
    expect(copyRootTaskHistoryPassedCriteria(facts)).toEqual(facts)
    expect(copyRootTaskHistoryPassedCriteria(facts)?.[0]?.check).not.toBe(dependent.check)
  })
})
