import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import * as verification from "./task-graph-pg-verification.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { parseTaskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, taskGraphVerificationDependencyNodeKeys, type TaskGraphVerificationEvaluation, type TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { validateTaskGraphVerificationDependencySelectors } from "../planning/task-graph-verification-cross-node.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import type { TaskGraphVerificationReport } from "./task-graph-verification-report.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { parseStoredTaskGraphVerificationReport } from "./task-graph-verification-report.js"

vi.mock("./task-graph-pg-verification.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./task-graph-pg-verification.js")>()
  return { ...actual, verifyCompletedTaskGraphNodeEvidence: vi.fn() }
})
beforeEach(() => vi.mocked(verification.verifyCompletedTaskGraphNodeEvidence).mockReset())

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const sourceVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidates", check: { kind: "candidate_count_gte", minimum: 1 } }] } as const
const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } }] } as const
function graph(overrides: { source?: Record<string, unknown>; analyst?: Record<string, unknown>; sourceTask?: Record<string, unknown>; sourceResult?: unknown } = {}): { snapshot: TaskGraphSnapshot; analyst: TaskGraphSnapshot["nodes"][number]; task: Record<string, unknown> } {
  const source = { key: "scout", taskId: "scout-task", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: sourceVerification, ...overrides.source }
  const analyst = { key: "analyst", taskId: "analyst-task", templateId: "analyst", goal: "Analyze jobs", successCriteria: ["Analyze jobs"], dependsOn: ["scout"], depth: 2, verificationDisposition: "typed", verification: analystVerification, ...overrides.analyst }
  const structuredResult = { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["job-evidence"] }], evidence: [{ id: "job-evidence", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Found one" }
  const report = { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met", criteria: [{ criterionId: "candidates", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64) }
  const task = { id: "scout-task", userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, turnRootTaskId: scope.rootTaskId, attemptCount: 2, status: "completed", role: "scout", taskType: "job_discovery", failureReason: null, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, allowedActions: TASK_GRAPH_TEMPLATES.scout.allowedActions, result: overrides.sourceResult ?? { status: "completed", structuredResult, taskGraphVerificationReport: report }, ...overrides.sourceTask }
  const snapshot = { schemaVersion: "agent-harness.v2.task-graph", nodes: [source, analyst] } as TaskGraphSnapshot
  return { snapshot, analyst: snapshot.nodes[1]!, task }
}

describe("verifyCompletedScoutDependencies", () => {
  it("binds only the fresh full-source proof to current node, task attempt and six-field report digests", async () => {
    const value = graph()
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FROM "sub_agent_tasks" AS task JOIN "agent_sessions"')) return { rows: [value.task], rowCount: 1 }
      throw new Error("unexpected_completed_dependency_query")
    })
    const projection: TaskGraphVerificationEvidenceProjection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout", candidates: [{ jobId: "job-1", evidenceIds: ["job-evidence"] }], evidenceIds: ["job-evidence"] }
    const report: TaskGraphVerificationReport = { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "passed", reasonCode: "criteria_met", criteria: [{ criterionId: "candidates", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64) }
    const evaluation: TaskGraphVerificationEvaluation = { status: "passed", reasonCode: "criteria_met", criteria: [{ criterionId: "candidates", status: "passed", reasonCode: "criteria_met" }] }
    vi.mocked(verification.verifyCompletedTaskGraphNodeEvidence).mockResolvedValue({ verified: true, report, evaluation, projection, structuredResult: value.task.result })
    expect(() => parseTaskGraphSnapshot(value.snapshot)).not.toThrow()
    const proof = await verifyCompletedScoutDependencies({ query } as unknown as Pick<pg.PoolClient, "query">, scope, value.snapshot, value.analyst)
    expect(taskGraphVerificationDependencyNodeKeys(value.analyst.verification!)).toEqual(["scout"])
    expect(validateTaskGraphVerificationDependencySelectors(value.snapshot.nodes)).toBe(true)
    expect(parseStoredTaskGraphVerificationReport(value.task.result && (value.task.result as Record<string, unknown>).taskGraphVerificationReport, ["candidates"], [])).toBeDefined()
    expect(query).toHaveBeenCalledOnce()
    expect(verification.verifyCompletedTaskGraphNodeEvidence).toHaveBeenCalledOnce()
    expect(proof?.projections.get("scout")).toEqual(projection)
    expect(proof?.bindings).toEqual([expect.objectContaining({ nodeKey: "scout", taskId: "scout-task", attemptCount: 2, nodeDigest: expect.stringMatching(/^[a-f0-9]{64}$/), reportDigest: expect.stringMatching(/^[a-f0-9]{64}$/) })])
    expect(verification.verifyCompletedTaskGraphNodeEvidence).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ scope: { ...scope, taskId: "scout-task", attemptCount: 2 } }))
    expect(query).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["indirect source", { analyst: { dependsOn: [] } }],
    ["non-Scout source", { source: { templateId: "analyst" } }],
    ["legacy source", { source: { verificationDisposition: "legacy_unverified" } }],
  ])("rejects %s without consulting persisted receipts", async (_name, overrides) => {
    const value = graph(overrides)
    const query = vi.fn(async () => { throw new Error("unexpected_query") })
    await expect(verifyCompletedScoutDependencies({ query } as unknown as Pick<pg.PoolClient, "query">, scope, value.snapshot, value.analyst)).resolves.toBeNull()
    expect(query).not.toHaveBeenCalled()
  })

  it.each([
    ["failed source", { sourceTask: { status: "failed" } }],
    ["foreign turn", { sourceTask: { turnId: "turn-foreign" } }],
    ["foreign role", { sourceTask: { role: "analyst" } }],
    ["unsupported task type", { sourceTask: { taskType: "research" } }],
    ["tampered tools", { sourceTask: { allowedActions: ["jobs.search", "application.submit"] } }],
    ["wrong output marker", { sourceTask: { expectedOutputSchema: { schemaVersion: "other", role: "scout" } } }],
  ])("rejects %s source metadata", async (_name, overrides) => {
    const value = graph(overrides)
    const query = vi.fn(async () => ({ rows: [value.task], rowCount: 1 }))
    await expect(verifyCompletedScoutDependencies({ query } as unknown as Pick<pg.PoolClient, "query">, scope, value.snapshot, value.analyst)).resolves.toBeNull()
    expect(verification.verifyCompletedTaskGraphNodeEvidence).not.toHaveBeenCalled()
  })
})
