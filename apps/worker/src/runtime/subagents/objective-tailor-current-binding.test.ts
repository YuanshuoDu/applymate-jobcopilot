import { beforeEach, describe, expect, it, vi } from "vitest"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT } from "@jobcopilot/agent-protocol"
import { taskGraphItemId, parseTaskGraphSnapshot, taskGraphState } from "./task-graph-snapshot.js"
import { bindObjectiveTailorCandidateWitness, makeObjectiveTailorCandidateSelection } from "./objective-tailor-witness.js"
import { objectiveTailorNodeKeysForCandidate, objectiveTailorPlan } from "./objective-task-graph-child-authority.js"
import { readCurrentObjectiveTailorBinding } from "./objective-tailor-current-binding.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"

const mocks = vi.hoisted(() => ({ revalidate: vi.fn(), materialize: vi.fn() }))
vi.mock("./objective-tailor-candidate.js", async importOriginal => ({
  ...await importOriginal<typeof import("./objective-tailor-candidate.js")>(), revalidateObjectiveTailorCandidateWitness: mocks.revalidate,
}))
vi.mock("./task-graph-dependency-context.js", async importOriginal => ({
  ...await importOriginal<typeof import("./task-graph-dependency-context.js")>(), materializeTaskGraphDependencyContext: mocks.materialize,
}))

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479", digest = "a".repeat(64)
const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [{ id: "membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-node" } }] }
const selection = makeObjectiveTailorCandidateSelection({ scope, sourceGraphRevision: 4,
  sourceGraphDigest: digest, sourceStatusDigest: "b".repeat(64), analystProofDigest: "c".repeat(64),
  candidate: { jobId, score: 8, materialDigest: `sha256:${"d".repeat(64)}` }, sourceAnalystKeys: ["analyst-node"] })!
const witness = bindObjectiveTailorCandidateWitness(selection, {
  ...objectiveTailorNodeKeysForCandidate(selection.candidateRef)!, admittedRevision: 5,
})!

function fixture() {
  const plan = objectiveTailorPlan(witness)!
  const analyst = { key: "analyst-node", taskId: "analyst-task", templateId: "analyst", goal: "Verify a candidate",
    successCriteria: ["Verify source"], dependsOn: ["scout-node"], depth: 2, verificationDisposition: "typed", verification }
  const scout = { key: "scout-node", taskId: "scout-task", templateId: "scout", goal: "Find a candidate",
    successCriteria: ["Find one"], dependsOn: [], depth: 1, verificationDisposition: "typed",
    verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
      criteria: [{ id: "count", check: { kind: "candidate_count_gte", minimum: 1 } }] } }
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
    scout, analyst, { ...plan.proposal.nodes[0]!, taskId: "writer-task", depth: 3 }, { ...plan.proposal.nodes[1]!, taskId: "reviewer-task", depth: 4 },
  ] })
  const statuses = new Map(snapshot.nodes.map(node => [node.taskId, { status: node.taskId === "reviewer-task" ? "waiting" as const
    : node.taskId === "writer-task" ? "queued" as const : "completed" as const, failureReason: null }]))
  const tasks = new Map(snapshot.nodes.map(node => [node.taskId, { id: node.taskId, status: statuses.get(node.taskId)!.status,
    role: node.templateId === "cover_letter_writer" ? "writer" : node.templateId === "cover_letter_reviewer" ? "reviewer" : node.templateId,
    taskType: node.templateId === "cover_letter_writer" ? "cover_letter_draft" : node.templateId === "cover_letter_reviewer" ? "cover_letter_review" : node.templateId === "analyst" ? "job_analysis" : "job_discovery",
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: node.templateId === "analyst" ? "analyst" : "scout" },
    failureReason: null, result: { finalItemId: null, finalText: "done", status: "completed", stepCount: 0, toolCallCount: 0,
      structuredResult: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence: [], summary: "" } } }]))
  const dependencyEvidence = { schemaVersion: "agent-harness.v2.task-graph.dependency-evidence", items: [] }
  mocks.materialize.mockReturnValue({ ...plan.templates.cover_letter_writer!.context as object, taskGraphDependencyResults: dependencyEvidence })
  const rows = [
    { id: "writer-task", sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
      userId: scope.userId, role: "writer", taskType: "cover_letter_draft", status: "queued",
      context: { ...plan.templates.cover_letter_writer!.context as object, taskGraphDependencyResults: dependencyEvidence } },
    { id: "reviewer-task", sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId,
      userId: scope.userId, role: "reviewer", taskType: "cover_letter_review", status: "waiting", context: plan.templates.cover_letter_reviewer!.context },
  ]
  const loaded: LoadedGraph = { rootTaskId: scope.rootTaskId,
    item: { id: taskGraphItemId(scope.parentTaskId), revision: 5, content: snapshot, createdAt: new Date(0) }, snapshot,
    state: taskGraphState(snapshot, 5, statuses, []), tasks, discoveryTurnEligibility: "ordinary" }
  let turn: Record<string, unknown> = { input: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }, source: "user", executionMode: "canonical_task_graph", rootTaskId: scope.rootTaskId }
  const client = { query: vi.fn(async (sql: string) => sql.includes('FROM "sub_agent_tasks" AS task')
    ? { rows, rowCount: rows.length } : { rows: [turn], rowCount: 1 }) }
  return { client, loaded, rows, setTurn(value: Record<string, unknown>) { turn = value } }
}

beforeEach(() => { vi.clearAllMocks(); mocks.revalidate.mockResolvedValue({ candidateRef: witness.candidateRef }) })

describe("current Objective tailor binding", () => {
  it("binds the exact pair and source proof without requiring a live Root lease", async () => {
    const { client, loaded } = fixture()
    const result = await readCurrentObjectiveTailorBinding(client as never, scope, loaded)
    expect(result).toEqual({ status: "bound", witness, writerTaskId: "writer-task", reviewerTaskId: "reviewer-task" })
    expect(mocks.revalidate).toHaveBeenCalledWith(client, scope, loaded, witness)
  })

  it("returns absent for an ordinary legacy graph with no Objective markers", async () => {
    const { client, loaded, rows, setTurn } = fixture()
    rows.splice(0)
    const snapshot = parseTaskGraphSnapshot({ ...loaded.snapshot!, nodes: loaded.snapshot!.nodes.filter(node =>
      node.templateId !== "cover_letter_writer" && node.templateId !== "cover_letter_reviewer") })
    setTurn({ input: { selectedJobPreparation: { jobId } }, source: "user", executionMode: "canonical_task_graph", rootTaskId: scope.rootTaskId })
    await expect(readCurrentObjectiveTailorBinding(client as never, scope, { ...loaded, snapshot,
      item: { ...loaded.item!, content: snapshot } })).resolves.toEqual({ status: "absent" })
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })

  it("does not reinterpret a legacy selected-job Writer/Reviewer pair as an Objective binding", async () => {
    const { client, loaded, rows, setTurn } = fixture()
    rows.splice(0)
    setTurn({ input: { selectedJobPreparation: { jobId } }, source: "user", executionMode: "canonical_task_graph", rootTaskId: scope.rootTaskId })
    await expect(readCurrentObjectiveTailorBinding(client as never, scope, loaded)).resolves.toEqual({ status: "absent" })
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })

  it("returns absent for an Objective graph before a tailor pair exists", async () => {
    const { client, loaded, rows } = fixture()
    rows.splice(0)
    const snapshot = parseTaskGraphSnapshot({ ...loaded.snapshot!, nodes: loaded.snapshot!.nodes.filter(node =>
      node.templateId !== "cover_letter_writer" && node.templateId !== "cover_letter_reviewer") })
    await expect(readCurrentObjectiveTailorBinding(client as never, scope, { ...loaded, snapshot,
      item: { ...loaded.item!, content: snapshot } })).resolves.toEqual({ status: "absent" })
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })

  it.each(["missing Turn", "wrong Turn root"]) ("does not return absence for a %s", async failure => {
    const { client, loaded, rows } = fixture()
    rows.splice(0)
    const snapshot = parseTaskGraphSnapshot({ ...loaded.snapshot!, nodes: loaded.snapshot!.nodes.filter(node =>
      node.templateId !== "cover_letter_writer" && node.templateId !== "cover_letter_reviewer") })
    client.query.mockImplementation(async (sql: string) => sql.includes('FROM "sub_agent_tasks" AS task')
      ? { rows, rowCount: 0 }
      : failure === "missing Turn" ? { rows: [], rowCount: 0 }
        : { rows: [{ input: { selectedJobPreparation: { jobId } }, source: "user", executionMode: "canonical_task_graph", rootTaskId: "other-root" }], rowCount: 1 })
    await expect(readCurrentObjectiveTailorBinding(client as never, scope, { ...loaded, snapshot,
      item: { ...loaded.item!, content: snapshot } })).resolves.toEqual({ status: "invalid" })
  })

  it("rejects an Objective Writer/Reviewer pair when both private markers are missing", async () => {
    const { client, loaded, rows } = fixture()
    rows.splice(0)
    await expect(readCurrentObjectiveTailorBinding(client as never, scope, loaded)).resolves.toEqual({ status: "invalid" })
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })

  it.each([
    "partial pair", "orphan marker", "misparented marker", "wrong root task", "foreign task owner", "wrong task type", "mixed witness", "missing mode marker",
  ])("fails closed for %s", async failure => {
    const { client, loaded, rows } = fixture()
    if (failure === "partial pair") rows.pop()
    if (failure === "orphan marker") rows.push({ ...rows[0]!, id: "orphan-task", role: "writer", taskType: "cover_letter_draft" })
    if (failure === "misparented marker") rows[1]!.parentTaskId = "other-parent"
    if (failure === "wrong root task") rows[1]!.rootTaskId = "other-root"
    if (failure === "foreign task owner") rows[0]!.userId = "user-foreign"
    if (failure === "wrong task type") rows[0]!.taskType = "other"
    if (failure === "mixed witness") rows[1]!.context = { ...(rows[1]!.context as Record<string, unknown>), objectiveTailorCandidateWitness: { ...witness, sourceGraphRevision: 2 } }
    if (failure === "missing mode marker") rows[0]!.context = { ...(rows[0]!.context as Record<string, unknown>), objectiveTailorCandidateMode: false }
    expect(await readCurrentObjectiveTailorBinding(client as never, scope, loaded)).toEqual({ status: "invalid" })
    expect(mocks.revalidate).not.toHaveBeenCalled()
  })

  it("rejects noncanonical intent and stale source evidence", async () => {
    const { client, loaded, rows } = fixture()
    client.query.mockImplementation(async (sql: string) => sql.includes('FROM "sub_agent_tasks" AS task')
      ? { rows, rowCount: rows.length }
      : { rows: [{ input: { intent: { version: 1, kind: "different" } }, source: "user", executionMode: "canonical_task_graph", rootTaskId: scope.rootTaskId }], rowCount: 1 })
    const invalidIntent = await readCurrentObjectiveTailorBinding(client as never, scope, loaded)
    expect(invalidIntent).toEqual({ status: "invalid" })
    client.query.mockImplementation(async (sql: string) => sql.includes('FROM "sub_agent_tasks" AS task')
      ? { rows, rowCount: rows.length }
      : { rows: [{ input: { intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT }, source: "user", executionMode: "canonical_task_graph", rootTaskId: scope.rootTaskId }], rowCount: 1 })
    mocks.revalidate.mockResolvedValue(undefined)
    expect(await readCurrentObjectiveTailorBinding(client as never, scope, loaded)).toEqual({ status: "invalid" })
  })
})
