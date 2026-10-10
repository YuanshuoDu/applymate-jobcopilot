import { describe, expect, it } from "vitest"

import { parsePersistedTaskGraphNode, validTaskGraphResultEnvelopeKeys } from "./plan-ledger-task-graph-metadata.js"

const base = {
  key: "scout", templateId: "scout", goal: "Find relevant jobs", successCriteria: ["Save evidence"],
  dependsOn: [], depth: 1, taskId: "task-scout",
}
const criterion = { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }
const verification = { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout", criteria: [criterion] }
const digest = "a".repeat(64)
const report = {
  verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met",
  criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }],
  evidenceDigest: digest, resultDigest: "b".repeat(64),
}
const dependencyBinding = {
  nodeKey: "scout-a", taskId: "task-scout-a", attemptCount: 1,
  nodeDigest: digest, resultDigest: digest, evidenceDigest: digest, reportDigest: digest,
}
const result = {
  status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: null, finalText: "private", structuredResult: {},
}
const nativeSource = {
  taskId: "source-task", rootTaskId: "root-task", parentTaskId: "root-task", turnId: "turn-1",
  role: "auditor", taskType: "audit", status: "failed", attemptCount: 1,
  resultDigest: "d".repeat(64), graphNodeKey: "native-prior", origin: "task_graph",
}
const nativeDelegation = {
  schemaVersion: "agent-harness.v2.task-graph.native-delegation.v1", operationKind: "spawn",
  operationId: "native-operation", requestFingerprint: "a".repeat(64), callerTaskId: "root-task",
  role: "auditor", taskType: "audit", contextDigest: "b".repeat(64), contextBytes: 0,
}

describe("Plan Ledger persisted TaskGraph metadata", () => {
  it("projects typed, repaired, legacy, and specialized shapes without metadata", () => {
    const typed = parsePersistedTaskGraphNode({ ...base, verification, verificationDisposition: "typed" })
    const repaired = parsePersistedTaskGraphNode({
      ...base, key: "scout-repair", taskId: "task-repair", verification, verificationDisposition: "typed",
      repairOf: { graphRootTaskId: "root-1", nodeKey: "scout", taskId: "task-scout", criterionIds: ["candidate-count"] },
    })
    const legacy = parsePersistedTaskGraphNode({ ...base, verificationDisposition: "legacy_unverified" })
    const specialized = parsePersistedTaskGraphNode({ ...base, templateId: "cover_letter_writer", verificationDisposition: "specialized" })

    expect(typed).toEqual(base)
    expect(repaired).toMatchObject({ key: "scout-repair", taskId: "task-repair" })
    expect(repaired).not.toHaveProperty("repairOf")
    expect(legacy).toEqual(base)
    expect(specialized).toMatchObject({ templateId: "cover_letter_writer" })
  })

  it("projects valid persisted native spawn and followup metadata without exposing provenance", () => {
    const spawn = {
      ...base, templateId: "native", successCriteria: [], verificationDisposition: "legacy_unverified", nativeDelegation,
    }
    const followup = {
      ...spawn, key: "native-followup", taskId: "task-followup",
      nativeDelegation: { ...nativeDelegation, operationKind: "followup", source: nativeSource },
    }

    for (const node of [spawn, followup]) {
      expect(parsePersistedTaskGraphNode(node)).toEqual({
        key: node.key, templateId: "native", goal: node.goal, successCriteria: [], dependsOn: [], depth: 1, taskId: node.taskId,
      })
      expect(JSON.stringify(parsePersistedTaskGraphNode(node))).not.toMatch(/nativeDelegation|source-task|requestFingerprint/)
    }
  })

  it("fails closed for native declarations that are missing, mixed, or contain unknown metadata", () => {
    const node = { ...base, templateId: "native", successCriteria: [], verificationDisposition: "legacy_unverified", nativeDelegation }
    const invalid = [
      { ...node, nativeDelegation: undefined },
      { ...node, verificationDisposition: "typed", verification },
      { ...node, repairOf: { taskId: "task", nodeKey: "node", graphRootTaskId: "root", criterionIds: ["candidate-count"] } },
      { ...node, nativeDelegation: { ...nativeDelegation, authority: "approved" } },
      { ...node, nativeDelegation: { ...nativeDelegation, operationKind: "followup" } },
      { ...node, nativeDelegation: { ...nativeDelegation, operationKind: "followup", source: { ...nativeSource, rawResult: "private" } } },
      { ...node, nativeDelegation: { ...nativeDelegation, operationKind: "followup", source: { ...nativeSource, role: "executor" } } },
      { ...node, nativeDelegation: { ...nativeDelegation, source: nativeSource } },
      { ...node, templateId: "scout" },
      { ...base, templateId: "native", successCriteria: [] },
    ]
    for (const candidate of invalid) expect(parsePersistedTaskGraphNode(candidate)).toBeNull()
  })

  it("rejects unknown persisted shapes and malformed typed or repair metadata", () => {
    const invalid = [
      { ...base, verification },
      { ...base, verificationDisposition: "typed" },
      { ...base, verificationDisposition: "legacy_unverified", verification },
      { ...base, templateId: "cover_letter_writer", verificationDisposition: "specialized", verification },
      { ...base, verificationDisposition: "specialized" },
      { ...base, verificationDisposition: "future" },
      { ...base, verificationDisposition: "typed", verification: { ...verification, extra: true } },
      { ...base, verificationDisposition: "typed", verification: { ...verification, schemaVersion: "future" } },
      { ...base, verificationDisposition: "typed", verification: { ...verification, role: "analyst" } },
      { ...base, verificationDisposition: "typed", verification: { ...verification, criteria: [{ ...criterion, check: { ...criterion.check, extra: true } }] } },
      { ...base, verificationDisposition: "typed", verification: { ...verification, criteria: [{ ...criterion, check: { kind: "candidate_count_gte", minimum: 51 } }] } },
      { ...base, verificationDisposition: "typed", verification: { ...verification, criteria: [{ id: "a".repeat(65), check: criterion.check }] } },
      { ...base, verificationDisposition: "typed", verification: { ...verification, criteria: [criterion, criterion] } },
      { ...base, verificationDisposition: "typed", verification, repairOf: {} },
      { ...base, verificationDisposition: "typed", verification, repairOf: { graphRootTaskId: "root", nodeKey: "node", taskId: "task", criterionIds: ["x", "x"] } },
      { ...base, verificationDisposition: "typed", verification, repairOf: { graphRootTaskId: "root", nodeKey: "node", taskId: "task", criterionIds: ["not stable"] } },
      { ...base, verificationDisposition: "typed", verification, repairOf: { graphRootTaskId: "root", nodeKey: "node", taskId: "task", criterionIds: ["a".repeat(65)] } },
      { ...base, private: true },
    ]
    for (const node of invalid) expect(parsePersistedTaskGraphNode(node)).toBeNull()
  })

  it("accepts the bounded Scout and Analyst verifier check variants only for their matching roles", () => {
    const checks = [
      { kind: "finding_count_gte", minimum: 50 },
      { kind: "evidence_count_gte", minimum: 1 },
      { kind: "all_findings_have_evidence", minimumItems: 50 },
      { kind: "reported_score_gte", minimumScore: 10, minimumFindings: 50, aggregation: "all" },
    ]
    expect(parsePersistedTaskGraphNode({
      ...base, templateId: "analyst", verificationDisposition: "typed",
      verification: {
        schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "analyst",
        criteria: checks.map((value, index) => ({ id: "finding-" + index, check: value })),
      },
    })).toMatchObject({ templateId: "analyst" })
    expect(parsePersistedTaskGraphNode({
      ...base, verificationDisposition: "typed",
      verification: { ...verification, criteria: [
        criterion, { id: "evidence", check: { kind: "evidence_count_gte", minimum: 50 } },
        { id: "all-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 50 } },
      ] },
    })).toMatchObject({ templateId: "scout" })
    expect(parsePersistedTaskGraphNode({
      ...base, verificationDisposition: "typed",
      verification: { ...verification, criteria: [{ id: "wrong-role", check: checks[0] }] },
    })).toBeNull()
  })

  it("structurally validates known Worker report/receipt metadata without recomputing relationships", () => {
    expect(validTaskGraphResultEnvelopeKeys(result)).toBe(true)
    const passing = { ...result, taskGraphVerificationReport: report }
    expect(validTaskGraphResultEnvelopeKeys(passing)).toBe(true)
    const receipt = {
      schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: "root-1",
      targetNodeKey: "scout", targetTaskId: "task-scout", criterionIds: ["candidate-count"],
      repairNodeKey: "scout-repair", repairTaskId: "task-repair",
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", evidenceDigest: digest,
    }
    expect(validTaskGraphResultEnvelopeKeys({ ...passing, taskGraphRepairReceipt: receipt })).toBe(true)
    expect(validTaskGraphResultEnvelopeKeys({ ...result, taskGraphRepairReceipt: receipt })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({ ...passing, taskGraphVerificationReport: { ...report, extra: true } })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({ ...passing, taskGraphVerificationReport: { ...report, evidenceDigest: "A".repeat(64) } })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({ ...passing, taskGraphRepairReceipt: { ...receipt, evidenceDigest: "c".repeat(64) } })).toBe(true)
    expect(validTaskGraphResultEnvelopeKeys({
      ...passing, taskGraphRepairReceipt: { ...receipt, criterionIds: ["other-criterion"] },
    })).toBe(true)
    expect(validTaskGraphResultEnvelopeKeys({
      ...passing, taskGraphRepairReceipt: { ...receipt, criterionIds: ["not stable"] },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...passing, taskGraphRepairReceipt: { ...receipt, criterionIds: ["a".repeat(65)] },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({ ...passing, taskGraphRepairReceipt: { ...receipt, extra: true } })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({ ...passing, private: "ignored?" })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result,
      taskGraphVerificationReport: {
        ...report, status: "unverified", reasonCode: "canonical_evidence_missing",
        criteria: [{ criterionId: "other-criterion", status: "unverified", reasonCode: "canonical_evidence_missing" }],
        evidenceDigest: null, resultDigest: null,
      },
      taskGraphRepairReceipt: { ...receipt, evidenceDigest: "c".repeat(64) },
    })).toBe(true)
  })

  it("accepts only the exact Analyst Scout-selector check and strict private report bindings", () => {
    const analyst = {
      ...base, key: "analyst", templateId: "analyst", verificationDisposition: "typed",
      verification: {
        schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "analyst",
        criteria: [{ id: "from-scout", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a" } }],
      },
    }
    expect(parsePersistedTaskGraphNode(analyst)).toMatchObject({ key: "analyst", templateId: "analyst" })
    expect(parsePersistedTaskGraphNode({
      ...analyst, verification: { ...analyst.verification, criteria: [{
        id: "from-scout", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-a", taskId: "foreign" },
      }] },
    })).toBeNull()
    expect(parsePersistedTaskGraphNode({
      ...base, verificationDisposition: "typed",
      verification: { ...analyst.verification, role: "scout" },
    })).toBeNull()

    const passing = { ...result, taskGraphVerificationReport: { ...report, dependencyBindings: [dependencyBinding] } }
    expect(validTaskGraphResultEnvelopeKeys(passing)).toBe(true)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: { ...report, dependencyBindings: [{ ...dependencyBinding, nodeDigest: "A".repeat(64) }] },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: { ...report, dependencyBindings: [{ ...dependencyBinding, attemptCount: 0 }] },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: { ...report, dependencyBindings: [dependencyBinding, dependencyBinding] },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: {
        ...report, status: "unverified", reasonCode: "canonical_evidence_missing",
        criteria: [{ criterionId: "candidate-count", status: "unverified", reasonCode: "canonical_evidence_missing" }],
        evidenceDigest: null, resultDigest: null, dependencyBindings: [dependencyBinding],
      },
    })).toBe(false)
  })

  it("accepts Worker repair identifier order and partial criterion sets without deciding their lineage", () => {
    const outOfOrderReport = {
      ...report, criteria: [
        { criterionId: "beta", status: "passed", reasonCode: "criteria_met" },
        { criterionId: "alpha", status: "passed", reasonCode: "criteria_met" },
      ],
    }
    const outOfOrderReceipt = {
      schemaVersion: "agent-harness.v2.task-graph-repair-receipt.v1", graphRootTaskId: "root-1",
      targetNodeKey: "target", targetTaskId: "target-task", criterionIds: ["alpha", "beta"],
      repairNodeKey: "repair", repairTaskId: "repair-task",
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", evidenceDigest: "c".repeat(64),
    }
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: outOfOrderReport, taskGraphRepairReceipt: outOfOrderReceipt,
    })).toBe(true)

    const outOfOrderRepair = {
      ...base, key: "out-of-order-repair", verificationDisposition: "typed",
      verification: {
        schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout",
        criteria: [
          { id: "beta", check: { kind: "candidate_count_gte", minimum: 1 } },
          { id: "alpha", check: { kind: "evidence_count_gte", minimum: 1 } },
        ],
      },
      repairOf: { graphRootTaskId: "root-1", nodeKey: "target", taskId: "target-task", criterionIds: ["alpha", "beta"] },
    }
    expect(parsePersistedTaskGraphNode(outOfOrderRepair)).toMatchObject({ key: "out-of-order-repair" })

    const partialRepair = {
      ...base, key: "one-criterion-repair", templateId: "scout", verificationDisposition: "typed",
      verification: {
        schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "scout",
        criteria: [{ id: "beta", check: { kind: "candidate_count_gte", minimum: 1 } }],
      },
      repairOf: { graphRootTaskId: "root-1", nodeKey: "target", taskId: "target-task", criterionIds: ["beta"] },
    }
    expect(parsePersistedTaskGraphNode(partialRepair)).toMatchObject({ key: "one-criterion-repair" })
    expect(validTaskGraphResultEnvelopeKeys({
      ...result,
      taskGraphVerificationReport: { ...report, criteria: [{ criterionId: "beta", status: "passed", reasonCode: "criteria_met" }] },
      taskGraphRepairReceipt: { ...outOfOrderReceipt, criterionIds: ["beta"] },
    })).toBe(true)
  })

  it("accepts only the exact empty legacy/no-contract unverified report shape", () => {
    const emptyLegacyReport = {
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "unverified", reasonCode: "contract_invalid",
      criteria: [], evidenceDigest: null, resultDigest: null,
    }
    expect(validTaskGraphResultEnvelopeKeys({
      ...result,
      taskGraphVerificationReport: emptyLegacyReport,
    })).toBe(true)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result,
      taskGraphVerificationReport: { ...report, status: "passed", criteria: [] },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: { ...emptyLegacyReport, reasonCode: "repair_target_unresolved" },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: { ...emptyLegacyReport, resultDigest: "a".repeat(64) },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: { ...report, status: ["passed"] },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: { ...emptyLegacyReport, reasonCode: ["contract_invalid"] },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: {
        ...report, criteria: [{ ...report.criteria[0], status: ["passed"] }],
      },
    })).toBe(false)
    expect(validTaskGraphResultEnvelopeKeys({
      ...result, taskGraphVerificationReport: {
        ...report, criteria: [{ ...report.criteria[0], reasonCode: ["criteria_met"] }],
      },
    })).toBe(false)
  })
})
