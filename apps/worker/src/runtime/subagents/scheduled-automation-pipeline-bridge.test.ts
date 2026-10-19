import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationEvaluation } from "../planning/task-graph-verification.js"
import { SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION } from "./scheduled-automation-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA, type AnalystResult, type ScoutResult } from "./role-results.js"
import { TASK_GRAPH_VERIFIER_VERSION, publicTaskGraphVerificationReport, type TaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { taskGraphResultDigest, type TaskGraphPgVerificationResult } from "./task-graph-pg-verification.js"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"
import {
  createScheduledAutomationPipelineBridge,
  SCHEDULED_PIPELINE_ATTESTATION_SCHEMA,
  type ScheduledAutomationPipelineBridgeDependencies,
  type ScheduledAutomationPipelineBridgeScope,
  type ScheduledAutomationPipelineBridgeState,
} from "./scheduled-automation-pipeline-bridge.js"

const scope: ScheduledAutomationPipelineBridgeScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", rootAttemptCount: 4,
  turnLeaseOwnerId: "worker-1", turnLeaseVersion: 5,
}
const criteriaSnapshot = {
  schemaVersion: SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION, targetRoles: ["Engineer"], targetLocations: ["Dublin"],
  minScore: 70, dailyCap: 10, requireApproval: true, autoApply: false,
}
const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
} as const
const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [{ id: "uses-scout", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-node" } }],
} as const
const scoutNode = {
  key: "scout-node", taskId: "scout-task", templateId: "scout", goal: "Find matching jobs", successCriteria: ["Return evidenced jobs"],
  dependsOn: [], depth: 1, verificationDisposition: "typed", verification: scoutVerification,
}
const analystNode = {
  key: "analyst-node", taskId: "analyst-task", templateId: "analyst", goal: "Analyze discovered jobs", successCriteria: ["Return evidenced findings"],
  dependsOn: ["scout-node"], depth: 2, verificationDisposition: "typed", verification: analystVerification,
}
const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [scoutNode, analystNode] }
const scoutEvidenceDigest = "a".repeat(64)
const analystEvidenceDigest = "c".repeat(64)
const emptyDiscoveryDigest = "e".repeat(64)

type FixtureOptions = Readonly<{
  candidateIds?: readonly string[]; findingIds?: readonly string[]; source?: string; mode?: string
  rootAttemptCount?: number; snapshotInput?: unknown; health?: Record<string, unknown> | null
  scoutAttemptCount?: number
  rootStatus?: string; turnStatus?: string; turnLeaseOwnerId?: string | null; turnLeaseVersion?: number; turnLeaseExpiresAt?: Date | string | null
  scoutStatus?: "completed" | "partial"; analystStatus?: "completed" | "partial"
}>

function makeFixture(options: FixtureOptions = {}) {
  const candidateIds = options.candidateIds ?? ["job-1"]
  const findingIds = options.findingIds ?? candidateIds
  const evidence = [...new Set([...candidateIds, ...findingIds])].map(id => ({ id: `evidence-${id}`, kind: "job" as const, ref: id, source: "greenhouse" }))
  const scoutResult: ScoutResult = {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: options.scoutStatus ?? "completed",
    candidates: candidateIds.map(jobId => ({ jobId, source: "greenhouse", url: `https://jobs.example/${jobId}`, evidenceIds: [`evidence-${jobId}`] })),
    evidence, summary: "Scout result",
  }
  const analystResult: AnalystResult = {
    schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: options.analystStatus ?? "completed",
    findings: findingIds.map(jobId => ({ jobId, score: 9.2, evidenceIds: [`evidence-${jobId}`] })), evidence, summary: "Analyst result",
  }
  const scoutReport: TaskGraphVerificationReport = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }],
    evidenceDigest: scoutEvidenceDigest, resultDigest: taskGraphResultDigest(scoutResult),
  }
  const dependencyBinding = {
    nodeKey: scoutNode.key, taskId: scoutNode.taskId, attemptCount: 2, nodeDigest: taskGraphResultDigest(scoutNode),
    resultDigest: scoutReport.resultDigest!, evidenceDigest: scoutEvidenceDigest, reportDigest: taskGraphResultDigest(scoutReport),
  }
  const analystReport = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
    criteria: [{ criterionId: "uses-scout", status: "passed", reasonCode: "criteria_met" }],
    evidenceDigest: analystEvidenceDigest, resultDigest: taskGraphResultDigest(analystResult), dependencyBindings: [dependencyBinding],
  }
  const health = options.health === null ? undefined : {
    schemaVersion: "agent-harness.v2.task-graph.discovery-attempt-health.v1", attemptedCalls: 1, completedCalls: 1,
    failedCalls: 0, unresolvedCalls: 0, candidateCount: candidateIds.length, providerFailures: 0, materializationFailures: 0, hasMore: false,
    ...options.health,
  }
  const resultEnvelope = (result: unknown, report: unknown, discoveryAttempt?: unknown) => ({
    finalItemId: null, finalText: "completed", status: "completed", stepCount: 2, toolCallCount: 2,
    structuredResult: result, taskGraphVerificationReport: report,
    ...(discoveryAttempt === undefined ? {} : { discoveryAttempt }),
  })
  const tasks = [
    taskRecord("scout-task", "scout", TASK_GRAPH_TEMPLATES.scout.taskType, 2, resultEnvelope(scoutResult, scoutReport,
      health === undefined ? undefined : { attemptCount: options.scoutAttemptCount ?? 2, health })),
    taskRecord("analyst-task", "analyst", TASK_GRAPH_TEMPLATES.analyst.taskType, 3, resultEnvelope(analystResult, analystReport)),
  ]
  const current = {
    revision: 7,
    nodes: [
      currentNode(scoutNode, scoutReport), currentNode(analystNode, publicTaskGraphVerificationReport(analystReport as never)),
    ],
  } as unknown as TaskGraphCurrentState
  const state: ScheduledAutomationPipelineBridgeState = {
    turn: {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      source: options.source ?? "automation", executionMode: options.mode ?? "canonical_task_graph",
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: options.snapshotInput ?? criteriaSnapshot },
      status: options.turnStatus ?? "in_progress", leaseOwnerId: options.turnLeaseOwnerId ?? scope.turnLeaseOwnerId,
      leaseVersion: options.turnLeaseVersion ?? scope.turnLeaseVersion, leaseExpiresAt: options.turnLeaseExpiresAt ?? new Date(Date.now() + 60_000),
    },
    root: { id: scope.rootTaskId, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      status: options.rootStatus ?? "running", attemptCount: options.rootAttemptCount ?? scope.rootAttemptCount },
    snapshot, current, tasks,
  }
  const verifyCompletedNode = vi.fn(async (input: Parameters<ScheduledAutomationPipelineBridgeDependencies["verifyCompletedNode"]>[0]) => verificationProof(input.structuredResult, input.node.templateId))
  const dependencies: ScheduledAutomationPipelineBridgeDependencies = { load: async () => state, verifyCompletedNode }
  return { state, dependencies, verifyCompletedNode, scoutResult }
}

function taskRecord(id: string, role: string, taskType: string, attemptCount: number, result: unknown) {
  return { id, userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    parentTaskId: scope.rootTaskId, role, taskType, status: "completed", attemptCount, failureReason: null,
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role }, allowedActions: TASK_GRAPH_TEMPLATES[role as "scout" | "analyst"].allowedActions, result }
}
function currentNode(node: typeof scoutNode | typeof analystNode, report: TaskGraphVerificationReport) {
  return { key: node.key, taskId: node.taskId, templateId: node.templateId, goal: node.goal, successCriteria: node.successCriteria,
    dependsOn: node.dependsOn, status: "completed", readiness: "ready", resultSummary: "done", failureReason: null,
    verification: node.verification, verificationCriterionIds: report.criteria.map(item => item.criterionId), verificationReport: publicTaskGraphVerificationReport(report) }
}
function verificationProof(value: unknown, role: string): TaskGraphPgVerificationResult {
  const scout = role === "scout"
  const result = value as ScoutResult | AnalystResult
  const empty = scout ? (result as ScoutResult).candidates.length === 0 : (result as AnalystResult).findings.length === 0
  const projection = scout
    ? { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout" as const,
      candidates: (result as ScoutResult).candidates.map(({ jobId, evidenceIds }) => ({ jobId, evidenceIds })),
      evidenceIds: empty ? [`read:source:jobs.discover:${emptyDiscoveryDigest}`] : result.evidence.map(item => item.id),
      ...(empty ? { emptyDiscoveryReceipt: { digest: emptyDiscoveryDigest } } : {}) }
    : { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "analyst" as const,
      findings: (result as AnalystResult).findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })),
      evidenceIds: result.evidence.map(item => item.id),
      ...(empty ? { emptyDiscoveryReceipt: { digest: emptyDiscoveryDigest } } : {}) }
  const evaluation: TaskGraphVerificationEvaluation = { status: "passed", reasonCode: "criteria_met", criteria: [{
    criterionId: scout ? "candidate-count" : "uses-scout", status: "passed", reasonCode: "criteria_met",
  }] }
  const report: TaskGraphVerificationReport = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met", criteria: evaluation.criteria,
    evidenceDigest: scout ? scoutEvidenceDigest : analystEvidenceDigest, resultDigest: taskGraphResultDigest(value),
  }
  return { verified: true, report, evaluation, projection, structuredResult: value }
}

describe("scheduled automation TaskGraph pipeline bridge", () => {
  it("returns a bounded owner-fenced attestation from verified Scout and Analyst outputs", async () => {
    const fixture = makeFixture()
    const result = await createScheduledAutomationPipelineBridge(fixture.dependencies)(scope)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    expect(result.attestation).toMatchObject({
      schemaVersion: SCHEDULED_PIPELINE_ATTESTATION_SCHEMA,
      owner: scope,
      graphRevision: 7,
      scout: { taskId: "scout-task", attemptCount: 2, status: "completed", verification: "passed", candidateJobIds: ["job-1"] },
      analyst: { taskId: "analyst-task", attemptCount: 3, status: "completed", verification: "passed", dependsOnTaskIds: ["scout-task"], jobIds: ["job-1"] },
    })
    const snapshotProjection = [criteriaSnapshot.schemaVersion, criteriaSnapshot.targetRoles, criteriaSnapshot.targetLocations,
      criteriaSnapshot.minScore, criteriaSnapshot.dailyCap, criteriaSnapshot.requireApproval, criteriaSnapshot.autoApply]
    expect(result.attestation.snapshotDigest).toBe(`sha256:${createHash("sha256").update(JSON.stringify(snapshotProjection)).digest("hex")}`)
    expect(result.attestation.snapshotDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(result.attestation.evidenceDigest).toMatch(/^[a-f0-9]{64}$/)
    expect(result.attestation.scout.discoveryReceipt).toMatchObject({
      status: "complete", taskId: "scout-task", attemptCount: 2,
      completedCalls: 1, candidateCount: 1, providerFailures: 0, materializationFailures: 0, hasMore: false,
    })
    expect(fixture.verifyCompletedNode).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(result.attestation)).not.toContain("9.2")
    expect(JSON.stringify(result.attestation)).not.toContain("jobs.example")
  })

  it("keeps evidence identity stable when only the persisted Turn lease rotates", async () => {
    const first = makeFixture(), second = makeFixture({ turnLeaseOwnerId: "worker-2", turnLeaseVersion: 6 })
    const [before, after] = await Promise.all([
      createScheduledAutomationPipelineBridge(first.dependencies)(scope),
      createScheduledAutomationPipelineBridge(second.dependencies)({ ...scope, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 6 }),
    ])
    expect(before.status).toBe("ready"); expect(after.status).toBe("ready")
    if (before.status === "ready" && after.status === "ready") {
      expect(after.attestation.owner).toMatchObject({ turnLeaseOwnerId: "worker-2", turnLeaseVersion: 6 })
      expect(after.attestation.evidenceDigest).toBe(before.attestation.evidenceDigest)
    }
  })

  it("accepts zero candidates only when the canonical verifier proves the complete server receipt", async () => {
    const fixture = makeFixture({ candidateIds: [], findingIds: [], health: { candidateCount: 0 } })
    const result = await createScheduledAutomationPipelineBridge(fixture.dependencies)(scope)
    expect(result.status).toBe("ready")
    if (result.status === "ready") expect(result.attestation.scout.discoveryReceipt.candidateCount).toBe(0)
  })

  it.each([
    ["missing Scout empty-receipt marker", "scout", (projection: Record<string, unknown>) => { delete projection.emptyDiscoveryReceipt }],
    ["mismatched Scout sentinel", "scout", (projection: Record<string, unknown>) => { projection.evidenceIds = [] }],
    ["forged Scout receipt digest", "scout", (projection: Record<string, unknown>) => { projection.emptyDiscoveryReceipt = { digest: "f".repeat(64) } }],
    ["unexpected Scout candidate", "scout", (projection: Record<string, unknown>) => { projection.candidates = [{ jobId: "invented", evidenceIds: [] }] }],
    ["missing Analyst empty-receipt marker", "analyst", (projection: Record<string, unknown>) => { delete projection.emptyDiscoveryReceipt }],
    ["Analyst receipt differs from Scout", "analyst", (projection: Record<string, unknown>) => { projection.emptyDiscoveryReceipt = { digest: "f".repeat(64) } }],
  ] as const)("blocks zero handoff with %s", async (_name, role, mutate) => {
    const fixture = makeFixture({ candidateIds: [], findingIds: [], health: { candidateCount: 0 } })
    const verifyCompletedNode = vi.fn(async (input: Parameters<ScheduledAutomationPipelineBridgeDependencies["verifyCompletedNode"]>[0]) => {
      const proof = verificationProof(input.structuredResult, input.node.templateId)
      if (input.node.templateId !== role || !proof.projection) return proof
      const projection = { ...proof.projection } as unknown as Record<string, unknown>
      mutate(projection)
      return { ...proof, projection: projection as unknown as TaskGraphPgVerificationResult["projection"] }
    })
    await expect(createScheduledAutomationPipelineBridge({ ...fixture.dependencies, verifyCompletedNode })(scope))
      .resolves.toEqual({ status: "blocked", reasonCode: "task_graph_evidence_unverified" })
  })

  it.each([
    ["non-automation source", { source: "user" }, "scheduled_canonical_turn_required"],
    ["legacy runner", { mode: "legacy_pipeline_adapter" }, "scheduled_canonical_turn_required"],
    ["changed root attempt", { rootAttemptCount: 5 }, "root_lineage_invalid"],
    ["rebound lease owner", { turnLeaseOwnerId: "worker-2" }, "root_lineage_invalid"],
    ["rebound lease version", { turnLeaseVersion: 6 }, "root_lineage_invalid"],
    ["expired Turn lease", { turnLeaseExpiresAt: new Date(Date.now() - 1) }, "root_lineage_invalid"],
    ["terminal root", { rootStatus: "completed" }, "root_lineage_invalid"],
    ["waiting root", { rootStatus: "waiting" }, "root_lineage_invalid"],
    ["stale Scout attempt", { scoutAttemptCount: 1 }, "discovery_receipt_incomplete"],
    ["failed discovery call", { health: { completedCalls: 0, failedCalls: 1, candidateCount: null, providerFailures: null, materializationFailures: null, hasMore: null } }, "discovery_receipt_incomplete"],
    ["unresolved discovery call", { health: { completedCalls: 0, unresolvedCalls: 1, candidateCount: null, providerFailures: null, materializationFailures: null, hasMore: null } }, "discovery_receipt_incomplete"],
    ["pagination remaining", { health: { hasMore: true } }, "discovery_receipt_incomplete"],
    ["provider failure", { health: { providerFailures: 1 } }, "discovery_receipt_incomplete"],
    ["materialization failure", { health: { materializationFailures: 1 } }, "discovery_receipt_incomplete"],
    ["missing provider count", { health: { providerFailures: null } }, "discovery_receipt_incomplete"],
    ["partial Scout result", { scoutStatus: "partial" }, "task_graph_result_invalid"],
    ["partial Analyst result", { analystStatus: "partial" }, "task_graph_result_invalid"],
    ["analyst job outside Scout candidates", { findingIds: ["invented-job"] }, "discovery_result_mismatch"],
    ["discovery count differs from verified Scout candidates", { health: { candidateCount: 2 } }, "discovery_result_mismatch"],
  ] as const)("blocks %s", async (_name, overrides, reasonCode) => {
    const fixture = makeFixture(overrides)
    await expect(createScheduledAutomationPipelineBridge(fixture.dependencies)(scope)).resolves.toEqual({ status: "blocked", reasonCode })
  })

  it("blocks a missing discovery receipt even if the model result is empty", async () => {
    const fixture = makeFixture({ candidateIds: [], findingIds: [], health: null })
    await expect(createScheduledAutomationPipelineBridge(fixture.dependencies)(scope))
      .resolves.toEqual({ status: "blocked", reasonCode: "discovery_receipt_missing" })
  })

  it("fails closed when canonical evidence verification is unavailable", async () => {
    const fixture = makeFixture()
    const dependencies = { ...fixture.dependencies, verifyCompletedNode: async () => ({
      ...verificationProof(fixture.scoutResult, "scout"), verified: false,
    }) }
    await expect(createScheduledAutomationPipelineBridge(dependencies)(scope))
      .resolves.toEqual({ status: "blocked", reasonCode: "task_graph_evidence_unverified" })
  })
})
