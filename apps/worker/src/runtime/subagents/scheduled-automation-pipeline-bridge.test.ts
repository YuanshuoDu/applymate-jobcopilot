import { describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { parseScheduledPipelineAttestation } from "@jobcopilot/agent-protocol"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationEvaluation } from "../planning/task-graph-verification.js"
import { SCHEDULED_AUTOMATION_SNAPSHOT_SCHEMA_VERSION } from "./scheduled-automation-snapshot.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult, type AnalystResult, type ScoutResult } from "./role-results.js"
import { TASK_GRAPH_VERIFIER_VERSION, publicTaskGraphVerificationReport, type TaskGraphStoredVerificationReport, type TaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, canonicalTaskGraphJson, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { taskGraphResultDigest, type TaskGraphPgVerificationResult } from "./task-graph-pg-verification.js"
import type { TaskGraphCurrentState } from "./task-graph-command-port.js"
import { buildScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { SCHEDULED_PREPARE_COMPLETION_SCHEMA, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, scheduledPrepareResultDigest } from "./scheduled-prepare-task-graph-verification.js"
import type { PrepareResult } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES as TEMPLATES } from "./task-graph-templates.js"
import { SCHEDULED_GATE_NODE_CRITERIA, SCHEDULED_GATE_NODE_GOAL, SCHEDULED_GATE_OUTPUT_SCHEMA,
  SCHEDULED_GATE_ROLE, SCHEDULED_GATE_TASK_TYPE, SCHEDULED_GATE_TEMPLATE_ID } from "./scheduled-gate-contract.js"
import { scheduledTaskGraphContinuationKey } from "./scheduled-pipeline-handoff.js"
import {
  createScheduledAutomationPipelineBridge,
  SCHEDULED_PIPELINE_ATTESTATION_SCHEMA,
  type ScheduledAutomationPipelineBridgeDependencies,
  type ScheduledAutomationPipelineBridgeScope,
  type ScheduledAutomationPipelineBridgeState,
  type ScheduledAutomationPipelineAttestation,
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
  const analystReport: TaskGraphStoredVerificationReport = {
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
  return { state, dependencies, verifyCompletedNode, scoutResult, scoutReport, analystReport }
}

const PREPARE_GOAL = "Prepare application materials using the persisted scheduled Analyze checkpoint."
const PREPARE_CRITERIA = [
  "Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
  "Persist immutable owner-fenced material references and return no resume or letter bodies.",
]

function appendVerifiedPrepareAndGate(fixture: ReturnType<typeof makeFixture>, withGate: boolean) {
  const snapshot = fixture.state.snapshot as { schemaVersion: string; nodes: readonly unknown[] }
  const current = fixture.state.current
  const prepareNode = { key: "prepare", taskId: "prepare-task", templateId: "prepare", goal: PREPARE_GOAL,
    successCriteria: PREPARE_CRITERIA, dependsOn: ["analyst-node"], depth: 3, verificationDisposition: "specialized" }
  const prepareResult: PrepareResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare", status: "completed",
    taskId: "prepare-task", attemptCount: 1, snapshotDigest: `sha256:${"b".repeat(64)}`, checkpointDigest: "d".repeat(64), jobs: [], materials: [] }
  const binding = { owner: { ...scope, executionId: "execution-1", executionAttemptCount: 1 },
    continuationKey: `scheduled-taskgraph:sha256:${"f".repeat(64)}`, snapshotDigest: prepareResult.snapshotDigest,
    evidenceDigest: "c".repeat(64), checkpointDigest: prepareResult.checkpointDigest,
    analyzeGraphRevision: 7, prepareScheduleRevision: 8 }
  const continuationKey = scheduledTaskGraphStableContinuationKey(binding)
  if (!continuationKey) throw new Error("test_prepare_binding_invalid")
  const receipt = buildScheduledTaskGraphContinuationReceipt({ ...binding, continuationKey })
  if (!receipt) throw new Error("test_prepare_receipt_invalid")
  const facts = { schemaVersion: SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA, receipt, result: prepareResult,
    completion: { schemaVersion: SCHEDULED_PREPARE_COMPLETION_SCHEMA, graphRevision: 9, nodes: [
      { taskId: "scout-task", attemptCount: 2, role: "scout", taskType: TEMPLATES.scout.taskType,
        status: "completed", verification: "passed", dependsOnTaskIds: [] },
      { taskId: "analyst-task", attemptCount: 3, role: "analyst", taskType: TEMPLATES.analyst.taskType,
        status: "completed", verification: "passed", dependsOnTaskIds: ["scout-task"] },
      { taskId: "prepare-task", attemptCount: 1, role: "prepare", taskType: TEMPLATES.prepare.taskType,
        status: "completed", verification: "passed", dependsOnTaskIds: ["analyst-task"],
        tool: "scheduled.application.prepare@1", resultDigest: scheduledPrepareResultDigest(prepareResult) },
    ] } }
  const prepareTask = { id: "prepare-task", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, role: TEMPLATES.prepare.role,
    taskType: TEMPLATES.prepare.taskType, status: "completed", attemptCount: 1, failureReason: null,
    expectedOutputSchema: TEMPLATES.prepare.expectedOutputSchema, allowedActions: TEMPLATES.prepare.allowedActions,
    result: { status: "completed", structuredResult: prepareResult, taskGraphScheduledPrepareProofFacts: facts } }
  const currentPrepare = { ...prepareNode, status: "completed", readiness: "ready", resultSummary: null, failureReason: null }
  const nodes = [...snapshot.nodes, prepareNode]
  const currentNodes = [...current.nodes, currentPrepare]
  const tasks = [...fixture.state.tasks, prepareTask]
  if (withGate) {
    const gateNode = { key: SCHEDULED_GATE_TEMPLATE_ID, taskId: "gate-task", templateId: SCHEDULED_GATE_TEMPLATE_ID,
      goal: SCHEDULED_GATE_NODE_GOAL, successCriteria: SCHEDULED_GATE_NODE_CRITERIA, dependsOn: ["prepare"], depth: 4,
      verificationDisposition: "specialized" }
    nodes.push(gateNode)
    currentNodes.push({ ...gateNode, status: "waiting_for_user", readiness: "blocked_dependency", resultSummary: null, failureReason: null })
    tasks.push({ id: "gate-task", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId, role: SCHEDULED_GATE_ROLE,
      taskType: SCHEDULED_GATE_TASK_TYPE, status: "waiting_for_user", attemptCount: 1, failureReason: null,
      expectedOutputSchema: SCHEDULED_GATE_OUTPUT_SCHEMA, allowedActions: [], result: { status: "waiting_for_user" } })
  }
  const extendedState = { ...fixture.state,
    snapshot: { schemaVersion: snapshot.schemaVersion, nodes },
    current: { revision: withGate ? 10 : 9, nodes: currentNodes } as unknown as TaskGraphCurrentState,
    tasks,
  }
  return { ...fixture, state: extendedState,
    dependencies: { ...fixture.dependencies, load: async () => extendedState } }
}

function legacyEvidenceDigest(fixture: ReturnType<typeof makeFixture>, attestation: ScheduledAutomationPipelineAttestation): string {
  if (attestation.schemaVersion !== SCHEDULED_PIPELINE_ATTESTATION_SCHEMA) throw new Error("expected_legacy_v1_attestation")
  const stableOwner = { userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId,
    rootTaskId: scope.rootTaskId, rootAttemptCount: scope.rootAttemptCount }
  const digest = (value: unknown) => createHash("sha256").update(canonicalTaskGraphJson(value)).digest("hex")
  return digest({ owner: stableOwner, snapshotDigest: attestation.snapshotDigest,
    graphDigest: digest(parseTaskGraphSnapshot(fixture.state.snapshot)), graphRevision: 7,
    receipt: attestation.scout.discoveryReceipt.receiptDigest,
    scout: { taskId: "scout-task", attemptCount: 2, report: publicTaskGraphVerificationReport(fixture.scoutReport) },
    analyst: { taskId: "analyst-task", attemptCount: 3, report: publicTaskGraphVerificationReport(fixture.analystReport),
      bindings: fixture.analystReport.dependencyBindings },
  })
}

function alterTaskResult(fixture: ReturnType<typeof makeFixture>, taskId: string) {
  const state = { ...fixture.state, tasks: fixture.state.tasks.map(task => {
    if (task.id !== taskId) return task
    const envelope = task.result as Record<string, unknown>
    const result = envelope.structuredResult as Record<string, unknown>
    return { ...task, result: { ...envelope, structuredResult: { ...result, summary: "Changed persisted evidence" } } }
  }) }
  return { ...fixture, dependencies: { ...fixture.dependencies, load: async () => state } }
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
  it("projects execution-scoped extras out of the exact V1 attestation owner", async () => {
    const fixture = makeFixture()
    const executionScope = { ...scope, executionId: "", executionAttemptCount: 0 }
    const result = await createScheduledAutomationPipelineBridge(fixture.dependencies)(executionScope)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    const parsed = parseScheduledPipelineAttestation(result.attestation)
    expect(parsed).not.toBeNull()
    expect(Object.keys(result.attestation.owner).sort()).toEqual(["rootAttemptCount", "rootTaskId", "sessionId", "turnId", "turnLeaseOwnerId", "turnLeaseVersion", "userId"])
    expect(parsed?.owner).toEqual(scope)
  })

  it("returns a bounded owner-fenced attestation from verified Scout and Analyst outputs", async () => {
    const fixture = makeFixture()
    const result = await createScheduledAutomationPipelineBridge(fixture.dependencies)(scope)
    expect(result.status).toBe("ready")
    if (result.status !== "ready") return
    if (result.attestation.schemaVersion !== SCHEDULED_PIPELINE_ATTESTATION_SCHEMA) throw new Error("expected_legacy_v1_attestation")
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

  it("preserves the legacy Analyze identity through valid Prepare and Gate suffixes", async () => {
    const base = makeFixture()
    const prepare = appendVerifiedPrepareAndGate(makeFixture(), false)
    const gate = appendVerifiedPrepareAndGate(makeFixture(), true)
    const rotatedGate = appendVerifiedPrepareAndGate(makeFixture({ turnLeaseOwnerId: "worker-2", turnLeaseVersion: 6 }), true)
    const [baseResult, prepareResult, gateResult, rotatedResult] = await Promise.all([
      createScheduledAutomationPipelineBridge(base.dependencies)(scope),
      createScheduledAutomationPipelineBridge(prepare.dependencies)(scope),
      createScheduledAutomationPipelineBridge(gate.dependencies)(scope),
      createScheduledAutomationPipelineBridge(rotatedGate.dependencies)({ ...scope, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 6 }),
    ])
    expect([baseResult.status, prepareResult.status, gateResult.status, rotatedResult.status]).toEqual(["ready", "ready", "ready", "ready"])
    if (baseResult.status !== "ready" || prepareResult.status !== "ready" || gateResult.status !== "ready" || rotatedResult.status !== "ready") return
    const baseline = baseResult.attestation
    expect(baseline.evidenceDigest).toBe(legacyEvidenceDigest(base, baseline))
    expect(prepareResult.attestation.evidenceDigest).toBe(baseline.evidenceDigest)
    expect(gateResult.attestation.evidenceDigest).toBe(baseline.evidenceDigest)
    expect(rotatedResult.attestation.evidenceDigest).toBe(baseline.evidenceDigest)
    const key = scheduledTaskGraphContinuationKey(scope, baseline, "execution-1", 1)
    expect(scheduledTaskGraphContinuationKey(scope, prepareResult.attestation, "execution-1", 1)).toBe(key)
    expect(scheduledTaskGraphContinuationKey(scope, gateResult.attestation, "execution-1", 1)).toBe(key)
    expect(scheduledTaskGraphContinuationKey({ ...scope, turnLeaseOwnerId: "worker-2", turnLeaseVersion: 6 },
      rotatedResult.attestation, "execution-1", 1)).toBe(key)
  })

  it.each([["Scout", "scout-task"], ["Analyst", "analyst-task"]] as const)(
    "rejects changed persisted %s evidence instead of re-attesting it", async (_role, taskId) => {
      const fixture = alterTaskResult(makeFixture(), taskId)
      const state = await fixture.dependencies.load()
      const task = state.tasks.find(value => value.id === taskId)!
      const envelope = task.result as Record<string, unknown>
      expect(() => validateRoleResult(envelope.structuredResult, taskId === "scout-task" ? "scout" : "analyst")).not.toThrow()
      await expect(createScheduledAutomationPipelineBridge(fixture.dependencies)(scope))
        .resolves.toEqual({ status: "blocked", reasonCode: "task_graph_evidence_unverified" })
    },
  )

  it("accepts zero candidates only when the canonical verifier proves the complete server receipt", async () => {
    const fixture = makeFixture({ candidateIds: [], findingIds: [], health: { candidateCount: 0 } })
    const result = await createScheduledAutomationPipelineBridge(fixture.dependencies)(scope)
    expect(result.status).toBe("ready")
    if (result.status === "ready") {
      if (result.attestation.schemaVersion !== SCHEDULED_PIPELINE_ATTESTATION_SCHEMA) throw new Error("expected_legacy_v1_attestation")
      expect(result.attestation.scout.discoveryReceipt.candidateCount).toBe(0)
    }
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
