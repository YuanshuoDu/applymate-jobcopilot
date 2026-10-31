import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { revalidateTaskGraphDependencyBindings } from "./task-graph-pg-dependency-binding-readback.js"
import { type LoadedGraph, type GraphIdentityScope, type GraphTaskRow } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphState, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { evaluateTaskGraphVerification, evaluateTaskGraphVerificationWithReverifiedEmptyAnalyst, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION, TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "./role-results.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { verifyCompletedScoutDependencies, type TaskGraphCompletedDependencyProof } from "./task-graph-pg-completed-dependency-verification.js"
import { emptyAnalystCoverageDigest } from "./task-graph-empty-analyst-proof.js"

vi.mock("./task-graph-pg-completed-dependency-verification.js", () => ({ verifyCompletedScoutDependencies: vi.fn() }))

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const snapshotValue = {
  schemaVersion: "agent-harness.v2.task-graph",
  nodes: [
  { key: "scout", taskId: "scout-task", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidates", check: { kind: "candidate_count_gte", minimum: 1 } }] } },
  { key: "analyst", taskId: "analyst-task", templateId: "analyst", goal: "Analyze", successCriteria: ["Analyze"], dependsOn: ["scout"], depth: 2, verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
    { id: "membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } },
    { id: "minimum-findings", check: { kind: "finding_count_gte", minimum: 1 } },
  ] } },
  ],
} as const
const snapshot = parseTaskGraphSnapshot(snapshotValue)
const nodes = snapshot.nodes
function loaded(result?: unknown, currentSnapshot = snapshot, analystStatus: "completed" | "failed" = "completed", revision = 1): LoadedGraph {
  const statuses = new Map<string, { status: GraphTaskRow["status"]; failureReason: string | null }>(currentSnapshot.nodes.map(node => [node.taskId, {
    status: node.templateId === "analyst" ? analystStatus : "completed",
    failureReason: node.templateId === "analyst" && analystStatus === "failed" ? "task_graph_verification_failed" : null,
  }]))
  const tasks = new Map<string, GraphTaskRow>(currentSnapshot.nodes.map(node => [node.taskId, {
    id: node.taskId, status: node.templateId === "analyst" ? analystStatus : "completed", role: node.templateId,
    attemptCount: node.templateId === "analyst" ? 2 : 1,
    failureReason: node.templateId === "analyst" && analystStatus === "failed" ? "task_graph_verification_failed" : null,
    result: node.templateId === "analyst" ? result ?? { taskGraphVerificationReport: { malformed: true } } : null,
  } as GraphTaskRow]))
  return { rootTaskId: scope.rootTaskId, item: { id: "graph", revision, content: null, createdAt: null }, snapshot: currentSnapshot, state: taskGraphState(currentSnapshot, revision, statuses, []), tasks }
}

const scoutProjection = {
  schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout" as const,
  candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }], evidenceIds: ["read:job:job-1"],
}
const bindings = [{ nodeKey: "scout", taskId: "scout-task", attemptCount: 1, nodeDigest: "a".repeat(64),
  resultDigest: "b".repeat(64), evidenceDigest: "c".repeat(64), reportDigest: "d".repeat(64) }]
const proof: TaskGraphCompletedDependencyProof = { projections: new Map([["scout", scoutProjection]]), bindings }

const multiSnapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
  ...["scout-a", "scout-b"].map(key => ({ key, taskId: `${key}-task`, templateId: "scout", goal: `Find ${key}`, successCriteria: ["Find"], dependsOn: [], depth: 1,
    verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidates", check: { kind: "candidate_count_gte", minimum: 1 } }] } })),
  { key: "analyst", taskId: "analyst-task", templateId: "analyst", goal: "Analyze", successCriteria: ["Analyze"], dependsOn: ["scout-a", "scout-b"], depth: 2,
    verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
      { id: "coverage", check: { kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["scout-a", "scout-b"], minimumPercent: 75 } },
      { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
      { id: "evidence-count", check: { kind: "evidence_count_gte", minimum: 1 } },
    ] } },
] })
const multiProjections = new Map([
  ["scout-a", { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout" as const, candidates: [{ jobId: "job-a", evidenceIds: ["read:job:job-a"] }], evidenceIds: ["read:job:job-a"] }],
  ["scout-b", { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout" as const, candidates: [{ jobId: "job-b", evidenceIds: ["read:job:job-b"] }], evidenceIds: ["read:job:job-b"] }],
])
const multiBindings = [
  { nodeKey: "scout-a", taskId: "scout-a-task", attemptCount: 1, nodeDigest: "1".repeat(64), resultDigest: "2".repeat(64), evidenceDigest: "3".repeat(64), reportDigest: "4".repeat(64) },
  { nodeKey: "scout-b", taskId: "scout-b-task", attemptCount: 1, nodeDigest: "5".repeat(64), resultDigest: "6".repeat(64), evidenceDigest: "7".repeat(64), reportDigest: "8".repeat(64) },
]

function analystResult(jobId = "job-1") {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
    findings: [{ jobId, score: 8, evidenceIds: [`read:job:${jobId}`] }],
    evidence: [{ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "jobs.get" }], summary: "Analysis" }
}
function emptyAnalystResult() {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence: [], summary: "No findings" }
}

function reportFor(value = analystResult(), currentSnapshot = snapshot) {
  const node = currentSnapshot.nodes.find(item => item.key === "analyst")!
  const result = validateRoleResult(value, "analyst")
  const projection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "analyst" as const,
    findings: result.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })), evidenceIds: result.evidence.map(item => item.id) }
  const evaluation = evaluateTaskGraphVerification(node.verification!, projection, proof.projections)
  return { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: evaluation.status, reasonCode: evaluation.reasonCode,
    criteria: evaluation.criteria, evidenceDigest: "e".repeat(64), resultDigest: taskGraphResultDigest(result), dependencyBindings: bindings }
}

function completedLoaded(value = analystResult(), currentSnapshot = snapshot, report = reportFor(value, currentSnapshot)): LoadedGraph {
  return loaded({ structuredResult: value, taskGraphVerificationReport: report }, currentSnapshot)
}
function failedEmptyReport(value = emptyAnalystResult()) {
  const node = multiSnapshot.nodes.find(item => item.key === "analyst")!
  const result = validateRoleResult(value, "analyst")
  const projection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "analyst" as const, findings: [], evidenceIds: [] }
  const evaluation = evaluateTaskGraphVerificationWithReverifiedEmptyAnalyst(node.verification!, projection, multiProjections)
  const resultDigest = taskGraphResultDigest(result)
  const evidenceDigest = emptyAnalystCoverageDigest({ scope: { ...scope, taskId: "analyst-task", attemptCount: 2 }, node,
    resultDigest, dependencyNodeKeys: ["scout-a", "scout-b"], dependencyBindings: multiBindings })
  if (evaluation.status !== "failed" || !evidenceDigest) throw new Error("empty_analyst_test_fixture_invalid")
  return { verifierVersion: TASK_GRAPH_EMPTY_ANALYST_VERIFIER_VERSION, status: "failed", reasonCode: evaluation.reasonCode,
    criteria: evaluation.criteria, evidenceDigest, resultDigest, dependencyBindings: multiBindings }
}

describe("revalidateTaskGraphDependencyBindings", () => {
  beforeEach(() => vi.mocked(verifyCompletedScoutDependencies).mockResolvedValue(proof))

  it("does no database reads for a unary graph", async () => {
    const client = { query: async () => { throw new Error("unexpected_query") } } as unknown as Pick<pg.PoolClient, "query">
    const unarySnapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: nodes.map(node => ({ ...node, templateId: "analyst", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "count", check: { kind: "finding_count_gte", minimum: 1 } }] } })) })
    const unary = { ...loaded(), snapshot: unarySnapshot }
    await expect(revalidateTaskGraphDependencyBindings(client, scope, unary)).resolves.toBe(unary)
  })

  it("rejects malformed private reports before exposing loaded graph state", async () => {
    const client = { query: async () => { throw new Error("unexpected_source_query") } } as unknown as Pick<pg.PoolClient, "query">
    await expect(revalidateTaskGraphDependencyBindings(client, scope, loaded())).rejects.toThrow("task_graph_verification_report_invalid")
  })

  it("accepts a fresh passed Analyst result only after matching source bindings and current findings", async () => {
    const client = { query: async () => { throw new Error("unexpected_query") } } as unknown as Pick<pg.PoolClient, "query">
    const current = completedLoaded()
    await expect(revalidateTaskGraphDependencyBindings(client, scope, current)).resolves.toBe(current)
    expect(verifyCompletedScoutDependencies).toHaveBeenCalledWith(client, scope, snapshot, nodes[1])
  })

  it("rejects a changed out-of-set Analyst finding while the source binding stays unchanged", async () => {
    const client = { query: async () => { throw new Error("unexpected_query") } } as unknown as Pick<pg.PoolClient, "query">
    const changed = analystResult("job-outside-scout")
    const passedBeforeChange = reportFor()
    const digestMatchesChangedResult = { ...passedBeforeChange, resultDigest: taskGraphResultDigest(validateRoleResult(changed, "analyst")) }
    await expect(revalidateTaskGraphDependencyBindings(client, scope, completedLoaded(changed, snapshot, digestMatchesChangedResult)))
      .rejects.toThrow("task_graph_verification_report_invalid")
    expect(verifyCompletedScoutDependencies).toHaveBeenCalledWith(client, scope, snapshot, nodes[1])
  })

  it("re-evaluates the current Analyst contract even when criterion IDs and source bindings are unchanged", async () => {
    const client = { query: async () => { throw new Error("unexpected_query") } } as unknown as Pick<pg.PoolClient, "query">
    const changedSnapshot = parseTaskGraphSnapshot({ ...snapshotValue, nodes: snapshotValue.nodes.map(node => node.key === "analyst"
      ? { ...node, verification: { ...node.verification, criteria: [
        { id: "membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } },
        { id: "minimum-findings", check: { kind: "finding_count_gte", minimum: 2 } },
      ] } } : node) })
    expect(changedSnapshot.nodes[1]?.verification?.criteria.map(item => item.id)).toEqual(nodes[1]?.verification?.criteria.map(item => item.id))
    const current = completedLoaded(analystResult(), changedSnapshot, reportFor())
    await expect(revalidateTaskGraphDependencyBindings(client, scope, current)).rejects.toThrow("task_graph_verification_report_invalid")
  })

  it("accepts v2 failed empty-Analyst reports only after rechecking current result, receipts, graph, and every Scout", async () => {
    const multiProof: TaskGraphCompletedDependencyProof = { projections: multiProjections, bindings: multiBindings }
    vi.mocked(verifyCompletedScoutDependencies).mockResolvedValue(multiProof)
    const value = emptyAnalystResult(), report = failedEmptyReport(value)
    const current = loaded({ structuredResult: value, taskGraphVerificationReport: report }, multiSnapshot, "failed", 5)
    const client = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pick<pg.PoolClient, "query">
    await expect(revalidateTaskGraphDependencyBindings(client, scope, current)).resolves.toBe(current)
    expect(verifyCompletedScoutDependencies).toHaveBeenCalledWith(client, scope, multiSnapshot, multiSnapshot.nodes[2])
  })

  it("rejects stale/tampered v2 proof material and current-attempt receipt presence", async () => {
    const multiProof: TaskGraphCompletedDependencyProof = { projections: multiProjections, bindings: multiBindings }
    vi.mocked(verifyCompletedScoutDependencies).mockResolvedValue(multiProof)
    const value = emptyAnalystResult(), report = failedEmptyReport(value)
    const malformedDigest = loaded({ structuredResult: value, taskGraphVerificationReport: { ...report, evidenceDigest: "f".repeat(64) } }, multiSnapshot, "failed")
    const emptyClient = { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pick<pg.PoolClient, "query">
    await expect(revalidateTaskGraphDependencyBindings(emptyClient, scope, malformedDigest)).rejects.toThrow("task_graph_verification_report_invalid")

    const changed = { ...value, findings: [{ jobId: "invented", score: 9, evidenceIds: ["read:job:invented"] }] }
    const changedResult = loaded({ structuredResult: changed, taskGraphVerificationReport: report }, multiSnapshot, "failed")
    await expect(revalidateTaskGraphDependencyBindings(emptyClient, scope, changedResult)).rejects.toThrow("task_graph_verification_report_invalid")

    const receiptClient = { query: async (sql: string) => sql.includes('FROM "agent_steps" AS step') && sql.includes('JOIN "agent_items" AS item')
      ? { rows: [{ id: "current-analyst-tool-call" }], rowCount: 1 } : { rows: [], rowCount: 0 } } as unknown as Pick<pg.PoolClient, "query">
    const current = loaded({ structuredResult: value, taskGraphVerificationReport: report }, multiSnapshot, "failed")
    await expect(revalidateTaskGraphDependencyBindings(receiptClient, scope, current)).rejects.toThrow("task_graph_verification_report_invalid")
  })

  it("does not upgrade v1 failed reports or let their bindings masquerade as v2 proof", async () => {
    const client = { query: async () => { throw new Error("unexpected_v1_failed_report_query") } } as unknown as Pick<pg.PoolClient, "query">
    const legacy = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
      criteria: [{ criterionId: "membership", status: "failed", reasonCode: "criterion_not_met" },
        { criterionId: "minimum-findings", status: "failed", reasonCode: "criterion_not_met" }],
      evidenceDigest: "e".repeat(64), resultDigest: "f".repeat(64), dependencyBindings: bindings }
    const old = loaded({ structuredResult: emptyAnalystResult(), taskGraphVerificationReport: legacy }, snapshot, "failed")
    await expect(revalidateTaskGraphDependencyBindings(client, scope, old)).resolves.toBe(old)
  })
})
