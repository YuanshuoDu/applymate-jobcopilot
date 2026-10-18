import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { taskGraphItemId, parseTaskGraphSnapshot, type TaskGraphSnapshot } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { TaskGraphTaskTemplate } from "./task-graph-command-port.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-pg-verification.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, type TaskGraphVerificationEvidenceProjection } from "../planning/task-graph-verification.js"
import { verifyCompletedScoutDependencies } from "./task-graph-pg-completed-dependency-verification.js"
import { verifyCompletedTaskGraphNodeEvidence, taskGraphResultDigest } from "./task-graph-pg-verification.js"
import {
  readScheduledDraftCandidateBinding,
  isScheduledDraftTemplate,
  scheduledDraftPair,
  scheduledDraftTaskContext,
  selectTopScheduledDraftCandidate,
  selectVerifiedScheduledDraftCandidate,
  validateScheduledDraftCandidateWitness,
} from "./scheduled-draft-candidate.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"

vi.mock("./task-graph-pg-completed-dependency-verification.js", () => ({ verifyCompletedScoutDependencies: vi.fn() }))
vi.mock("./task-graph-pg-verification.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./task-graph-pg-verification.js")>()
  return { ...actual, verifyCompletedTaskGraphNodeEvidence: vi.fn() }
})

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const passed = (criterionId: string) => ({ criterionId, status: "passed", reasonCode: "criteria_met" }) as const
type Spec = Readonly<{ key: string; scoutKey: string; findings: readonly Readonly<{ jobId: string; score: number }>[] }>

function fixture(specs: readonly Spec[]) {
  const nodes: Record<string, unknown>[] = [], rows = new Map<string, Record<string, unknown>>(), sourceProofs = new Map<string, unknown>()
  const resultByTask = new Map<string, { result: Record<string, unknown>; projection: TaskGraphVerificationEvidenceProjection; report: Record<string, unknown> }>()
  for (const [index, spec] of specs.entries()) {
    const scoutTaskId = `scout-task-${spec.key}`, analystTaskId = `analyst-task-${spec.key}`
    const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] }
    const analystVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [
      { id: "membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: spec.scoutKey } },
      { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
    ] }
    nodes.push(
      { key: spec.scoutKey, taskId: scoutTaskId, templateId: "scout", goal: "Find current jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: scoutVerification },
      { key: spec.key, taskId: analystTaskId, templateId: "analyst", goal: "Analyze current jobs", successCriteria: ["Analyze jobs"], dependsOn: [spec.scoutKey], depth: 2, verificationDisposition: "typed", verification: analystVerification },
    )
    const jobIds = [...new Set(spec.findings.map(item => item.jobId))]
    const evidence = jobIds.map(jobId => ({ id: `read:job:${jobId}`, kind: "job", ref: jobId, source: "jobs.get" }))
    const analystResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed",
      findings: spec.findings.map(item => ({ ...item, evidenceIds: [`read:job:${item.jobId}`] })), evidence, summary: "Persisted analysis" }
    const reportBase = { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      criteria: [passed("membership"), passed("finding-count")], evidenceDigest: `${index + 1}`.repeat(64), resultDigest: taskGraphResultDigest(analystResult) }
    const scoutBinding = { nodeKey: spec.scoutKey, taskId: scoutTaskId, attemptCount: 2, nodeDigest: `${index + 2}`.repeat(64),
      resultDigest: `${index + 3}`.repeat(64), evidenceDigest: `${index + 4}`.repeat(64), reportDigest: `${index + 5}`.repeat(64) }
    const report = { ...reportBase, dependencyBindings: [scoutBinding] }
    const envelope = { finalItemId: `item-${spec.key}`, finalText: "done", status: "completed", stepCount: 2, toolCallCount: 1,
      structuredResult: analystResult, taskGraphVerificationReport: report }
    rows.set(scoutTaskId, { id: scoutTaskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, turnRootTaskId: scope.rootTaskId, userId: scope.userId, status: "completed", role: "scout", context: {} })
    rows.set(analystTaskId, { id: analystTaskId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, turnRootTaskId: scope.rootTaskId, userId: scope.userId, attemptCount: 3, status: "completed",
      role: "analyst", taskType: TASK_GRAPH_TEMPLATES.analyst.taskType, failureReason: null,
      expectedOutputSchema: TASK_GRAPH_TEMPLATES.analyst.expectedOutputSchema, allowedActions: TASK_GRAPH_TEMPLATES.analyst.allowedActions,
      context: {}, result: envelope, resultProjection: { role: "analyst", findings: [{ jobId: "model-projection-job", score: 10 }] } })
    const scoutProjection: TaskGraphVerificationEvidenceProjection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "scout",
      candidates: jobIds.map(jobId => ({ jobId, evidenceIds: [`read:job:${jobId}`] })), evidenceIds: evidence.map(item => item.id) }
    sourceProofs.set(spec.key, { projections: new Map([[spec.scoutKey, scoutProjection]]), bindings: [scoutBinding] })
    const analystProjection: TaskGraphVerificationEvidenceProjection = { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION, role: "analyst",
      findings: analystResult.findings.map(({ jobId, score, evidenceIds }) => ({ jobId, score, evidenceIds })), evidenceIds: evidence.map(item => item.id) }
    resultByTask.set(analystTaskId, { result: analystResult, projection: analystProjection, report: reportBase })
  }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes })
  const statuses = new Map(snapshot.nodes.map(node => [node.key, "completed"] as const))
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (!sql.includes('FROM "sub_agent_tasks" AS task')) throw new Error("unexpected_query")
    const ids = Array.isArray(values?.[0]) ? values[0] as string[] : [String(values?.[0])]
    const found = ids.flatMap(id => rows.get(String(id)) ?? [])
    return { rows: found, rowCount: found.length }
  }) }
  vi.mocked(verifyCompletedScoutDependencies).mockImplementation(async (_client, _scope, _snapshot, analyst) => sourceProofs.get(analyst.key) as never ?? null)
  vi.mocked(verifyCompletedTaskGraphNodeEvidence).mockImplementation(async (_client, input) => {
    const current = resultByTask.get(input.scope.taskId)!
    return { verified: true, report: current.report as never, evaluation: { status: "passed", reasonCode: "criteria_met", criteria: [] },
      projection: current.projection, structuredResult: current.result }
  })
  return { client, snapshot, rows, sourceProofs, statuses }
}

function selectCandidate(value: ReturnType<typeof fixture>, keys = ["analyst"], snapshot = value.snapshot, newlyProposedNodeKeys: readonly string[] = []) {
  const added = new Set(newlyProposedNodeKeys), statuses = new Map(snapshot.nodes.map(node => [node.key, value.statuses.get(node.key) ?? (added.has(node.key) ? "queued" : node.templateId === "cover_letter_writer" ? "queued" : node.templateId === "cover_letter_reviewer" ? "waiting" : "completed")] as const))
  return selectVerifiedScheduledDraftCandidate(value.client as never, scope, snapshot, 7, keys, statuses, newlyProposedNodeKeys)
}

function addDraftPair(value: ReturnType<typeof fixture>) {
  const snapshot = parseTaskGraphSnapshot({ ...value.snapshot, nodes: [...value.snapshot.nodes,
    { key: "writer", taskId: "writer-task", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Draft"], dependsOn: ["analyst"], depth: 3 },
    { key: "reviewer", taskId: "reviewer-task", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review"], dependsOn: ["writer"], depth: 4 },
  ] })
  for (const [id, role, status] of [["writer-task", "writer", "queued"], ["reviewer-task", "reviewer", "waiting"]]) {
    value.rows.set(id, { id, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
      turnRootTaskId: scope.rootTaskId, userId: scope.userId, role, status, context: {} })
  }
  return snapshot
}

beforeEach(() => { vi.clearAllMocks() })

describe("selectTopScheduledDraftCandidate", () => {
  it("deduplicates exact IDs with their maximum score and resolves ties by bytewise ID", () => {
    expect(selectTopScheduledDraftCandidate([
      { jobId: "job-z", score: 8 }, { jobId: "job-z", score: 10 }, { jobId: "job-a", score: 10 },
    ])).toEqual({ jobId: "job-a", score: 10 })
    expect(selectTopScheduledDraftCandidate([{ jobId: "Job-A", score: 8 }, { jobId: "job-a", score: 8 }])).toEqual({ jobId: "Job-A", score: 8 })
  })

  it.each([
    [{ jobId: " job-1", score: 9 }], [{ jobId: "job/1", score: 9 }], [{ jobId: "", score: 9 }],
    [{ jobId: "job-1", score: "9" }], [{ jobId: "job-1", score: Number.NaN }], [{ jobId: "job-1", score: 11 }],
    [{ jobId: "job-1", score: 9, url: "https://untrusted.test" }],
  ])("rejects malformed selector data %#", value => expect(selectTopScheduledDraftCandidate([value])).toBeUndefined())
})

describe("scheduled draft mode markers", () => {
  it("rejects a partial server mode marker instead of falling back to legacy mode", () => {
    const templates = { cover_letter_writer: { role: "writer", context: { scheduledDraftMode: true } }, cover_letter_reviewer: { role: "reviewer", context: {} } } as unknown as Readonly<Record<string, TaskGraphTaskTemplate>>
    expect(() => isScheduledDraftTemplate(templates)).toThrow("scheduled_draft_template_marker_invalid")
  })
  it("rejects Reviewer dependencies beyond its same-Turn Writer", () => {
    const nodes = [
      { key: "writer", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Draft"], dependsOn: [] },
      { key: "reviewer", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review"], dependsOn: ["writer", "analyst"] },
    ]
    let caught: unknown
    try { scheduledDraftPair(nodes, new Set()) } catch (error) { caught = error }
    expect(caught).toMatchObject({ code: "task_graph_scheduled_draft_pair_invalid" })
  })
})

describe("verified scheduled draft candidate lane", () => {
  it("selects only persisted Analyst results after matching direct typed Scout proofs", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    const selected = await selectCandidate(value)
    expect(selected?.candidate).toEqual({ jobId: "db-job", score: 8 })
    expect(selected?.witness).toMatchObject({ graphRevision: 7, candidate: { jobId: "db-job", score: 8 }, analysts: [{ nodeKey: "analyst", taskId: "analyst-task-analyst", attemptCount: 3, scouts: [{ nodeKey: "scout", taskId: "scout-task-analyst", attemptCount: 2 }] }] })
    expect(value.client.query.mock.calls[0]?.[0]).not.toContain("resultProjection")
  })

  it("adds the server-owned candidate mode marker to scheduled child context", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    const selected = await selectCandidate(value)
    expect(scheduledDraftTaskContext({ role: "writer", context: { scheduledDraftMode: true } } as TaskGraphTaskTemplate, selected!))
      .toMatchObject({ scheduledDraftCandidateMode: true, selectedJobPreparation: { jobId: "db-job" }, scheduledDraftCandidateWitness: selected!.witness })
  })

  it("selects a 10-point Analyst source over an omitted 9-point Writer dependency", async () => {
    const value = fixture([
      { key: "analyst-10", scoutKey: "scout-10", findings: [{ jobId: "job-high", score: 10 }] },
      { key: "analyst-9", scoutKey: "scout-9", findings: [{ jobId: "job-low", score: 9 }] },
    ])
    const selected = await selectCandidate(value, ["analyst-9", "analyst-10"])
    expect(selected).toMatchObject({ candidate: { jobId: "job-high", score: 10 }, sourceAnalystKeys: ["analyst-10"], witness: { sourceAnalystKeys: ["analyst-10"] } })
    expect(["analyst-9"].includes(selected!.sourceAnalystKeys[0]!)).toBe(false)
  })

  it("fails closed when the same-graph typed Scout proof is absent", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    vi.mocked(verifyCompletedScoutDependencies).mockResolvedValueOnce(null)
    await expect(selectCandidate(value)).resolves.toBeUndefined()
    expect(value.client.query).not.toHaveBeenCalled()
  })

  it.each([
    ["failed", "status", "failed"], ["foreign owner", "userId", "other-user"], ["wrong role", "role", "scout"],
  ])("rejects a current Analyst row with %s metadata", async (_name, field, replacement) => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    const row = value.rows.get("analyst-task-analyst")!
    row[field!] = replacement
    await expect(selectCandidate(value)).resolves.toBeUndefined()
    expect(verifyCompletedTaskGraphNodeEvidence).not.toHaveBeenCalled()
  })

  it("ignores the public resultProjection even when it names a higher-scoring job", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "persisted-job", score: 6 }] }])
    const selected = await selectCandidate(value)
    expect(selected?.candidate).toEqual({ jobId: "persisted-job", score: 6 })
    expect(selected?.candidate.jobId).not.toBe("model-projection-job")
  })

  it("binds a replay to exact graph revision, attempts, results, and the existing winner", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    const snapshot = addDraftPair(value), selected = await selectCandidate(value, ["analyst"], snapshot)
    expect(selected).toBeDefined()
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 6, "db-job", selected!.witness)).resolves.toBe(false)
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(true)
    value.rows.get("writer-task")!.status = "running"
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(true)
    value.rows.get("writer-task")!.status = "queued"
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 8, "db-job", selected!.witness)).resolves.toBe(true)
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 7, "other-job", selected!.witness)).resolves.toBe(false)
    value.rows.get("analyst-task-analyst")!.attemptCount = 4
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(false)
  })

  it("allows reachable Writer/Reviewer status progress at one revision and rejects regressions or graph changes", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    const snapshot = addDraftPair(value), selected = await selectCandidate(value, ["analyst"], snapshot)
    value.rows.get("writer-task")!.status = "completed"
    value.rows.get("reviewer-task")!.status = "queued"
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(true)
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 8, "db-job", selected!.witness)).resolves.toBe(true)
    value.rows.get("writer-task")!.status = "retrying"
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(false)
    value.rows.get("writer-task")!.status = "completed"
    value.rows.get("reviewer-task")!.status = "retrying"
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(false)
    value.rows.get("reviewer-task")!.status = "queued"
    const appended = parseTaskGraphSnapshot({ ...snapshot, nodes: [...snapshot.nodes,
      { key: "extra-scout", taskId: "extra-task", templateId: "scout", goal: "Find more jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1,
        verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "count", check: { kind: "candidate_count_gte", minimum: 1 } }] } },
    ] })
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, appended, 9, "db-job", selected!.witness)).resolves.toBe(false)
    value.rows.get("analyst-task-analyst")!.status = "failed"
    await expect(validateScheduledDraftCandidateWitness(value.client as never, scope, snapshot, 8, "db-job", selected!.witness)).resolves.toBe(false)
  })

  it("loads identical owner-scoped Writer and Reviewer context bindings for the current graph", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    const preview = parseTaskGraphSnapshot({ ...value.snapshot, nodes: [...value.snapshot.nodes,
      { key: "new-scout", taskId: "subagent-000000000000000000000000000000000002", templateId: "scout", goal: "Find more jobs", successCriteria: ["Find jobs"], dependsOn: [], depth: 1,
        verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "count", check: { kind: "candidate_count_gte", minimum: 1 } }] } },
      { key: "new-analyst", taskId: "subagent-000000000000000000000000000000000003", templateId: "analyst", goal: "Analyze new jobs", successCriteria: ["Return findings"], dependsOn: ["new-scout"], depth: 2,
        verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst", criteria: [{ id: "findings", check: { kind: "finding_count_gte", minimum: 1 } }] } },
      { key: "writer", taskId: "subagent-000000000000000000000000000000000000", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Draft"], dependsOn: ["analyst"], depth: 3 },
      { key: "reviewer", taskId: "subagent-000000000000000000000000000000000001", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review"], dependsOn: ["writer"], depth: 4 },
    ] })
    const addedKeys = ["new-analyst", "new-scout"]
    const selected = await selectCandidate(value, ["analyst"], preview, addedKeys)
    const snapshot = parseTaskGraphSnapshot({ ...preview, nodes: preview.nodes.map(node => node.key === "new-scout" ? { ...node, taskId: "persisted-scout-task" }
      : node.key === "new-analyst" ? { ...node, taskId: "persisted-analyst-task" }
      : node.key === "writer" ? { ...node, taskId: "writer-task" } : node.key === "reviewer" ? { ...node, taskId: "reviewer-task" } : node) })
    expect(preview.nodes.find(node => node.key === "new-scout")?.taskId).not.toBe(snapshot.nodes.find(node => node.key === "new-scout")?.taskId)
    const context = { scheduledDraftCandidateMode: true, selectedJobPreparation: { jobId: "db-job" }, scheduledDraftCandidateWitness: selected!.witness }
    const item = { id: taskGraphItemId(scope.parentTaskId), revision: 7, content: snapshot, sessionId: scope.sessionId,
      turnId: scope.turnId, taskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId }
    const ownerRow = (id: string, role: string, taskContext: unknown, status = "completed") => ({ id, sessionId: scope.sessionId, turnId: scope.turnId,
      rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId, role, context: taskContext, status })
    const tasks = [ownerRow("scout-task-analyst", "scout", {}), ownerRow("analyst-task-analyst", "analyst", {}), ownerRow("persisted-scout-task", "scout", {}, "queued"), ownerRow("persisted-analyst-task", "analyst", {}, "queued"),
      ownerRow("writer-task", "writer", context, "queued"), ownerRow("reviewer-task", "reviewer", context, "waiting")]
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('FROM "agent_items"')) return { rows: [item], rowCount: 1 }
      if (sql.includes('task."attemptCount"')) { const source = value.rows.get(String(values?.[0])); return { rows: source ? [source] : [], rowCount: source ? 1 : 0 } }
      const ids = Array.isArray(values?.[0]) ? values[0] as string[] : [String(values?.[0])], rows = tasks.filter(row => ids.includes(row.id))
      return { rows, rowCount: rows.length }
    }) }
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).resolves.toMatchObject({ status: "bound", jobId: "db-job", graphRevision: 7, snapshot })
    const newScout = tasks.find(row => row.id === "persisted-scout-task")!, newAnalyst = tasks.find(row => row.id === "persisted-analyst-task")!
    newScout.status = "running"
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).resolves.toMatchObject({ status: "bound", jobId: "db-job" })
    await expect(validateScheduledDraftCandidateWitness(client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(true)
    newScout.status = "completed"
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).resolves.toMatchObject({ status: "bound", jobId: "db-job" })
    await expect(validateScheduledDraftCandidateWitness(client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(true)
    const changedSourceId = parseTaskGraphSnapshot({ ...snapshot, nodes: snapshot.nodes.map(node => node.key === "analyst" ? { ...node, taskId: "changed-analyst-task" } : node) })
    await expect(validateScheduledDraftCandidateWitness(client as never, scope, changedSourceId, 7, "db-job", selected!.witness)).resolves.toBe(false)
    newAnalyst.status = "completed"
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).rejects.toThrow("scheduled_draft_candidate_binding_invalid")
    await expect(validateScheduledDraftCandidateWitness(client as never, scope, snapshot, 7, "db-job", selected!.witness)).resolves.toBe(false)
    const rows = client.query.mock.calls.map(call => call[0])
    expect(rows.join("\n")).not.toContain("resultProjection")
  })

  it("rejects mismatched selected-job context instead of loading a different binding", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    const snapshot = parseTaskGraphSnapshot({ ...value.snapshot, nodes: [...value.snapshot.nodes,
      { key: "writer", taskId: "writer-task", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Draft"], dependsOn: ["analyst"], depth: 3 },
      { key: "reviewer", taskId: "reviewer-task", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review"], dependsOn: ["writer"], depth: 4 },
    ] })
    const selected = await selectCandidate(value, ["analyst"], snapshot)
    const item = { id: taskGraphItemId(scope.parentTaskId), revision: 7, content: snapshot, sessionId: scope.sessionId,
      turnId: scope.turnId, taskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId }
    const row = (id: string, role: string, status: string, context: unknown = {}) => ({ id, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId, role, status, context })
    const tasks = [row("scout-task-analyst", "scout", "completed"), row("analyst-task-analyst", "analyst", "completed"),
      row("writer-task", "writer", "queued", { scheduledDraftCandidateMode: true, selectedJobPreparation: { jobId: "other-job" }, scheduledDraftCandidateWitness: selected!.witness }),
      row("reviewer-task", "reviewer", "waiting", { scheduledDraftCandidateMode: true, selectedJobPreparation: { jobId: "db-job" }, scheduledDraftCandidateWitness: selected!.witness })]
    const client = { query: vi.fn(async (sql: string) => sql.includes('FROM "agent_items"') ? { rows: [item], rowCount: 1 } : { rows: tasks, rowCount: tasks.length }) }
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).rejects.toThrow("scheduled_draft_candidate_binding_invalid")
  })

  it("rejects a scheduled Writer/Reviewer pair with no persisted witness", async () => {
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
      { key: "writer", taskId: "writer-task", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Draft"], dependsOn: [], depth: 1 },
      { key: "reviewer", taskId: "reviewer-task", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review"], dependsOn: ["writer"], depth: 2 },
    ] })
    const item = { id: taskGraphItemId(scope.parentTaskId), revision: 7, content: snapshot, sessionId: scope.sessionId,
      turnId: scope.turnId, taskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId }
    const row = (id: string, role: string) => ({ id, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId, role, context: {} })
    const client = { query: vi.fn(async (sql: string) => sql.includes('FROM "agent_items"') ? { rows: [item], rowCount: 1 }
      : { rows: [row("writer-task", "writer"), row("reviewer-task", "reviewer")], rowCount: 2 }) }
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).rejects.toThrow("scheduled_draft_candidate_binding_invalid")
  })

  it("rejects a persisted witness if selectedJobPreparation is missing", async () => {
    const value = fixture([{ key: "analyst", scoutKey: "scout", findings: [{ jobId: "db-job", score: 8 }] }])
    const snapshot = parseTaskGraphSnapshot({ ...value.snapshot, nodes: [...value.snapshot.nodes,
      { key: "writer", taskId: "writer-task", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Draft"], dependsOn: ["analyst"], depth: 3 },
      { key: "reviewer", taskId: "reviewer-task", templateId: "cover_letter_reviewer", goal: "Review", successCriteria: ["Review"], dependsOn: ["writer"], depth: 4 },
    ] })
    const selected = await selectCandidate(value, ["analyst"], snapshot)
    const item = { id: taskGraphItemId(scope.parentTaskId), revision: 7, content: snapshot, sessionId: scope.sessionId,
      turnId: scope.turnId, taskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId }
    const row = (id: string, role: string, status: string) => ({ id, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      parentTaskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId, role, status,
      context: { scheduledDraftCandidateMode: true, scheduledDraftCandidateWitness: selected!.witness } })
    const tasks = [row("scout-task-analyst", "scout", "completed"), row("analyst-task-analyst", "analyst", "completed"),
      row("writer-task", "writer", "queued"), row("reviewer-task", "reviewer", "waiting")]
    const client = { query: vi.fn(async (sql: string) => sql.includes('FROM "agent_items"') ? { rows: [item], rowCount: 1 }
      : { rows: tasks, rowCount: tasks.length }) }
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).rejects.toThrow("scheduled_draft_candidate_binding_invalid")
  })

  it("fails closed when a missing graph has orphan draft rows or plan receipts", async () => {
    for (const orphan of [{ drafts: true, receipts: false }, { drafts: false, receipts: true }]) {
      const client = { query: vi.fn(async (sql: string) => sql.includes('FROM "agent_items"')
        ? { rows: [], rowCount: 0 } : { rows: [orphan], rowCount: 1 }) }
      await expect(readScheduledDraftCandidateBinding(client as never, scope)).rejects.toThrow("scheduled_draft_candidate_binding_invalid")
    }
    const clean = { query: vi.fn(async (sql: string) => sql.includes('FROM "agent_items"')
      ? { rows: [], rowCount: 0 } : { rows: [{ drafts: false, receipts: false }], rowCount: 1 }) }
    await expect(readScheduledDraftCandidateBinding(clean as never, scope)).resolves.toEqual({ status: "absent" })
  })

  it("allows ordinary plan receipts when an existing graph has no scheduled draft pair", async () => {
    const item = { id: taskGraphItemId(scope.parentTaskId), revision: 1,
      content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [] }, sessionId: scope.sessionId,
      turnId: scope.turnId, taskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId }
    const client = { query: vi.fn(async (sql: string) => sql.includes('FROM "agent_items"')
      ? { rows: [item], rowCount: 1 } : { rows: [{ drafts: false, receipts: true }], rowCount: 1 }) }
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).resolves.toEqual({ status: "absent" })
  })

  it("rejects orphan Writer/Reviewer rows when an existing graph has no scheduled pair", async () => {
    const item = { id: taskGraphItemId(scope.parentTaskId), revision: 1, content: { schemaVersion: "agent-harness.v2.task-graph", nodes: [] },
      sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId }
    const client = { query: vi.fn(async (sql: string) => sql.includes('FROM "agent_items"')
      ? { rows: [item], rowCount: 1 } : { rows: [{ drafts: true, receipts: false }], rowCount: 1 }) }
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).rejects.toThrow("scheduled_draft_candidate_binding_invalid")
  })

  it("rejects a partial Writer/Reviewer pair", async () => {
    const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
      { key: "writer", taskId: "writer-task", templateId: "cover_letter_writer", goal: "Draft", successCriteria: ["Draft"], dependsOn: [], depth: 1 },
    ] })
    const item = { id: taskGraphItemId(scope.parentTaskId), revision: 7, content: snapshot, sessionId: scope.sessionId,
      turnId: scope.turnId, taskId: scope.parentTaskId, userId: scope.userId, turnRootTaskId: scope.rootTaskId }
    const client = { query: vi.fn(async () => ({ rows: [item], rowCount: 1 })) }
    await expect(readScheduledDraftCandidateBinding(client as never, scope)).rejects.toThrow("scheduled_draft_candidate_binding_invalid")
  })
})
