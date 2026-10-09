import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { revalidateTaskGraphDependencyBindings } from "./task-graph-pg-dependency-binding-readback.js"
import { type LoadedGraph, type GraphIdentityScope, type GraphTaskRow } from "./task-graph-pg-state.js"
import { canonicalTaskGraphJson, taskGraphState, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import { evaluateTaskGraphVerification, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-verification-report.js"
import { ROLE_RESULT_SCHEMA, validateRoleResult } from "./role-results.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { verifyCompletedScoutDependencies, type TaskGraphCompletedDependencyProof } from "./task-graph-pg-completed-dependency-verification.js"

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
function loaded(result?: unknown, currentSnapshot = snapshot): LoadedGraph {
  const statuses = new Map<string, { status: GraphTaskRow["status"]; failureReason: string | null }>(currentSnapshot.nodes.map(node => [node.taskId, { status: "completed", failureReason: null }]))
  const tasks = new Map<string, GraphTaskRow>([
    ["scout-task", { id: "scout-task", status: "completed", role: "scout", failureReason: null, result: null }],
    ["analyst-task", { id: "analyst-task", status: "completed", role: "analyst", failureReason: null, result: result ?? { taskGraphVerificationReport: { malformed: true } } }],
  ])
  return { rootTaskId: scope.rootTaskId, item: { id: "graph", revision: 1, content: null, createdAt: null }, snapshot: currentSnapshot, state: taskGraphState(currentSnapshot, 1, statuses, []), tasks }
}

const scoutProjection = {
  schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout" as const,
  candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }], evidenceIds: ["read:job:job-1"],
}
const bindings = [{ nodeKey: "scout", taskId: "scout-task", attemptCount: 1, nodeDigest: "a".repeat(64),
  resultDigest: "b".repeat(64), evidenceDigest: "c".repeat(64), reportDigest: "d".repeat(64) }]
const proof: TaskGraphCompletedDependencyProof = { projections: new Map([["scout", scoutProjection]]), bindings }

function analystResult(jobId = "job-1") {
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
    findings: [{ jobId, score: 8, evidenceIds: [`read:job:${jobId}`] }],
    evidence: [{ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "jobs.get" }], summary: "Analysis" }
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
})
