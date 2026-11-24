import { beforeEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { createPostgresReadToolDataSource } from "../tools/read-data-source.js"
import { taskGraphItemId, parseTaskGraphSnapshot, taskGraphState } from "./task-graph-snapshot.js"
import { scheduledDraftJobMaterialDigest } from "./scheduled-draft-job-material.js"
import { buildObjectiveTailorCandidateCatalog, resolveObjectiveTailorCandidate, revalidateObjectiveTailorCandidateWitness } from "./objective-tailor-candidate.js"
import { bindObjectiveTailorCandidateWitness } from "./objective-tailor-witness.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"

const mocks = vi.hoisted(() => ({ proof: vi.fn(), dataSource: vi.fn(), getJob: vi.fn(), digest: vi.fn() }))
vi.mock("./scheduled-draft-candidate-analyst-proof.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-draft-candidate-analyst-proof.js")>(), readScheduledDraftAnalystProof: mocks.proof,
}))
vi.mock("../tools/read-data-source.js", () => ({ createPostgresReadToolDataSource: mocks.dataSource }))
vi.mock("./scheduled-draft-job-material.js", () => ({ scheduledDraftJobMaterialDigest: mocks.digest }))

const scope: GraphIdentityScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const jobId = "f47ac10b-58cc-4372-a567-0e02b2c3d479", material = `sha256:${"d".repeat(64)}`
const digest = "a".repeat(64)
const verification = (role: "scout" | "analyst") => ({ schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role,
  criteria: [{ id: "proof", check: role === "scout" ? { kind: "candidate_count_gte", minimum: 1 }
    : { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-node" } }] })

function graph(): LoadedGraph {
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
    { key: "scout-node", taskId: "scout-task", templateId: "scout", goal: "Find candidate", successCriteria: ["One candidate"], dependsOn: [], depth: 1, verificationDisposition: "typed", verification: verification("scout") },
    { key: "analyst-node", taskId: "analyst-task", templateId: "analyst", goal: "Analyze candidate", successCriteria: ["Verify candidate"], dependsOn: ["scout-node"], depth: 2, verificationDisposition: "typed", verification: verification("analyst") },
  ] })
  const statuses = new Map(snapshot.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }]))
  const tasks = new Map(snapshot.nodes.map(node => [node.taskId, { id: node.taskId, status: "completed" as const,
    role: node.templateId, taskType: node.templateId, failureReason: null, result: null }]))
  return { rootTaskId: scope.rootTaskId, item: { id: taskGraphItemId(scope.rootTaskId), revision: 4, content: snapshot, createdAt: new Date(0) },
    snapshot, state: taskGraphState(snapshot, 4, statuses, []), tasks, discoveryTurnEligibility: "ordinary" }
}
function proof(findings: readonly Readonly<{ jobId: string; score: number }>[], key = "analyst-node", materialDigest: string | null = material) {
  const binding = { nodeKey: key, taskId: `${key}-task`, attemptCount: 1, resultDigest: digest,
    evidenceDigest: "b".repeat(64), reportDigest: "c".repeat(64), scouts: [] }
  const digests = materialDigest ? new Map(findings.map(item => [item.jobId, materialDigest])) : new Map()
  return { result: { findings } as never, materialDigests: digests, binding } as never
}
function job(id = jobId) { return { id, company: "Acme", role: "Software Engineer", location: null, status: "saved",
  score: 8, url: "https://example.test/job", source: "manual", salary: null, description: "Role details", keywords: null } }
function setup(findings: readonly Readonly<{ jobId: string; score: number }>[]) {
  const loaded = graph(), client = { query: vi.fn() }
  mocks.proof.mockResolvedValue(proof(findings))
  mocks.getJob.mockResolvedValue(job())
  mocks.dataSource.mockReturnValue({ getJob: mocks.getJob })
  mocks.digest.mockReturnValue(material)
  return { loaded, client }
}
beforeEach(() => { vi.clearAllMocks() })

describe("ordinary Objective tailor candidate admission", () => {
  it("projects only bounded public fields and resolves an opaque current candidate on the same client", async () => {
    const { loaded, client } = setup([{ jobId, score: 8.5 }])
    const catalog = await buildObjectiveTailorCandidateCatalog(client as never, scope, loaded)
    expect(catalog).toMatchObject({ schemaVersion: "agent-harness.v2.objective-tailor-candidate-catalog.v1", graphRevision: 4 })
    expect(catalog?.candidates).toHaveLength(1)
    expect(catalog?.candidates[0]).toMatchObject({ title: "Software Engineer", company: "Acme", score: 8.5 })
    expect(JSON.stringify(catalog?.candidates)).not.toContain(jobId)
    expect(createPostgresReadToolDataSource).toHaveBeenCalledWith(client)
    const selection = await resolveObjectiveTailorCandidate(client as never, scope, loaded, 4, catalog!.candidates[0]!.candidateRef)
    expect(selection).toMatchObject({ candidate: { jobId, score: 8.5, materialDigest: material }, sourceAnalystKeys: ["analyst-node"] })
    expect(await resolveObjectiveTailorCandidate(client as never, scope, loaded, 3, catalog!.candidates[0]!.candidateRef)).toBeUndefined()
    expect(await resolveObjectiveTailorCandidate(client as never, scope, loaded, 4, "otc1_unknown")).toBeUndefined()
  })

  it.each(["scheduled", "unknown"] as const)("fails closed when graph provenance is %s", async eligibility => {
    const { loaded, client } = setup([{ jobId, score: 8 }])
    const result = await buildObjectiveTailorCandidateCatalog(client as never, scope, { ...loaded, discoveryTurnEligibility: eligibility })
    expect(result).toBeUndefined()
    expect(mocks.proof).not.toHaveBeenCalled()
  })

  it("does not expose candidates while any pre-pair graph task is active", async () => {
    const { loaded, client } = setup([{ jobId, score: 8 }])
    const tasks = new Map(loaded.tasks).set("scout-task", { ...loaded.tasks.get("scout-task")!, status: "running" as const })
    const statuses = new Map(loaded.snapshot!.nodes.map(node => [node.taskId, {
      status: (node.taskId === "scout-task" ? "running" : "completed") as "running" | "completed", failureReason: null,
    }]))
    expect(await buildObjectiveTailorCandidateCatalog(client as never, scope, { ...loaded, tasks,
      state: taskGraphState(loaded.snapshot!, 4, statuses, []) })).toBeUndefined()
    expect(mocks.proof).not.toHaveBeenCalled()
  })

  it("ignores verified Analysts without the required Scout-membership evidence", async () => {
    const { loaded, client } = setup([{ jobId, score: 8 }])
    const unrelated = { key: "analyst-unrelated", taskId: "analyst-unrelated-task", templateId: "analyst", goal: "Count findings",
      successCriteria: ["One finding"], dependsOn: [], depth: 1, verificationDisposition: "typed",
      verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
        criteria: [{ id: "count", check: { kind: "finding_count_gte", minimum: 1 } }] } }
    const snapshot = parseTaskGraphSnapshot({ ...loaded.snapshot, nodes: [...loaded.snapshot!.nodes, unrelated] })
    const statuses = new Map(snapshot.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }]))
    const tasks = new Map(loaded.tasks).set("analyst-unrelated-task", { id: "analyst-unrelated-task", status: "completed" as const,
      role: "analyst", taskType: "analyst", failureReason: null, result: null })
    const catalog = await buildObjectiveTailorCandidateCatalog(client as never, scope, { ...loaded,
      item: { ...loaded.item!, content: snapshot }, snapshot, state: taskGraphState(snapshot, 4, statuses, []), tasks })
    expect(catalog?.candidates).toHaveLength(1)
    expect(mocks.proof).toHaveBeenCalledTimes(1)
    expect(mocks.proof.mock.calls[0]?.[3]).toMatchObject({ key: "analyst-node" })
  })

  it("rejects a graph whose revision, item identity, task status, or node map is not exact", async () => {
    const { loaded, client } = setup([{ jobId, score: 8 }])
    expect(await buildObjectiveTailorCandidateCatalog(client as never, scope, { ...loaded, item: { ...loaded.item!, revision: 5 } })).toBeUndefined()
    expect(await buildObjectiveTailorCandidateCatalog(client as never, scope, { ...loaded, item: { ...loaded.item!, id: "foreign" } })).toBeUndefined()
    const task = loaded.tasks.get("analyst-task")!
    const wrongTasks = new Map(loaded.tasks).set("analyst-task", { ...task, status: "failed" as const })
    expect(await buildObjectiveTailorCandidateCatalog(client as never, scope, { ...loaded, tasks: wrongTasks })).toBeUndefined()
    expect(await buildObjectiveTailorCandidateCatalog(client as never, { ...scope, parentTaskId: "other-root" }, loaded)).toBeUndefined()
  })

  it("omits conflicting Analyst claims and stale or missing current material", async () => {
    const twoAnalysts = graph()
    const secondNode = { ...twoAnalysts.snapshot!.nodes[1]!, key: "analyst-two", taskId: "analyst-two-task" }
    const snapshot = parseTaskGraphSnapshot({ ...twoAnalysts.snapshot, nodes: [...twoAnalysts.snapshot!.nodes, secondNode] })
    const states = new Map(snapshot.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }]))
    const tasks = new Map(snapshot.nodes.map(node => [node.taskId, { id: node.taskId, status: "completed" as const,
      role: node.templateId, taskType: node.templateId, failureReason: null, result: null }]))
    const loaded = { ...twoAnalysts, snapshot, item: { ...twoAnalysts.item!, content: snapshot }, state: taskGraphState(snapshot, 4, states, []), tasks }
    mocks.proof.mockImplementation(async (_client: unknown, _scope: unknown, _snapshot: unknown, node: { key: string }) =>
      proof([{ jobId, score: node.key === "analyst-two" ? 7 : 8 }], node.key, node.key === "analyst-two" ? material : `sha256:${"e".repeat(64)}`))
    mocks.getJob.mockResolvedValue(job())
    mocks.dataSource.mockReturnValue({ getJob: mocks.getJob })
    mocks.digest.mockReturnValue(material)
    const latestWins = await buildObjectiveTailorCandidateCatalog({ query: vi.fn() } as never, scope, loaded)
    expect(latestWins?.candidates).toMatchObject([{ score: 7 }])
    const staleLatest = { ...loaded, snapshot, item: { ...loaded.item!, content: snapshot },
      state: taskGraphState(snapshot, 4, states, []), tasks }
    mocks.proof.mockImplementation(async (_client: unknown, _scope: unknown, _snapshot: unknown, node: { key: string }) =>
      proof([{ jobId, score: 7 }], node.key, node.key === "analyst-two" ? `sha256:${"e".repeat(64)}` : material))
    const noHistoricalFallback = await buildObjectiveTailorCandidateCatalog({ query: vi.fn() } as never, scope, staleLatest)
    expect(noHistoricalFallback?.candidates).toEqual([])
    mocks.proof.mockImplementation(async (_client: unknown, _scope: unknown, _snapshot: unknown, node: { key: string }) =>
      proof([{ jobId, score: 7 }], node.key, node.key === "analyst-two" ? null : material))
    const missingLatestReceipt = await buildObjectiveTailorCandidateCatalog({ query: vi.fn() } as never, scope, staleLatest)
    expect(missingLatestReceipt?.candidates).toEqual([])
    mocks.proof.mockImplementation(async (_client: unknown, _scope: unknown, _snapshot: unknown, node: { key: string }) =>
      proof(node.key === "analyst-two" ? [{ jobId, score: 7 }, { jobId, score: 8 }] : [{ jobId, score: 8 }], node.key))
    const sameAttemptConflict = await buildObjectiveTailorCandidateCatalog({ query: vi.fn() } as never, scope, staleLatest)
    expect(sameAttemptConflict?.candidates).toEqual([])
    const one = setup([{ jobId, score: 8 }])
    mocks.digest.mockReturnValue(`sha256:${"e".repeat(64)}`)
    const stale = await buildObjectiveTailorCandidateCatalog(one.client as never, scope, one.loaded)
    expect(stale?.candidates).toEqual([])
  })

  it("revalidates the accepted proof after Root lease release from the current graph and source", async () => {
    const initial = setup([{ jobId, score: 8 }])
    const catalog = await buildObjectiveTailorCandidateCatalog(initial.client as never, scope, initial.loaded)
    const selection = await resolveObjectiveTailorCandidate(initial.client as never, scope, initial.loaded, 4, catalog!.candidates[0]!.candidateRef)
    const witness = bindObjectiveTailorCandidateWitness(selection!, { writerNodeKey: "tailor-writer", reviewerNodeKey: "tailor-reviewer", admittedRevision: 5 })!
    const original = initial.loaded.snapshot!
    const snapshot = parseTaskGraphSnapshot({ ...original, nodes: [...original.nodes,
      { key: witness.writerNodeKey, taskId: "writer-task", templateId: "cover_letter_writer", goal: "Tailor current candidate",
        successCriteria: ["Use verified evidence"], dependsOn: [...witness.sourceAnalystKeys], depth: 3 },
      { key: witness.reviewerNodeKey, taskId: "reviewer-task", templateId: "cover_letter_reviewer", goal: "Review tailored draft",
        successCriteria: ["Check source fidelity"], dependsOn: [witness.writerNodeKey], depth: 4 },
    ] })
    const statuses = new Map(snapshot.nodes.map(node => [node.taskId, {
      status: (node.taskId === "reviewer-task" ? "queued" : "completed") as "queued" | "completed", failureReason: null,
    }]))
    const tasks = new Map([...initial.loaded.tasks, ["writer-task", { id: "writer-task", role: "writer", status: "completed" as const, failureReason: null, result: null }],
      ["reviewer-task", { id: "reviewer-task", role: "reviewer", status: "queued" as const, failureReason: null, result: null }]])
    const current: LoadedGraph = { ...initial.loaded, item: { ...initial.loaded.item!, revision: 5, content: snapshot }, snapshot,
      state: taskGraphState(snapshot, 5, statuses, []), tasks }
    expect(await revalidateObjectiveTailorCandidateWitness(initial.client as never, scope, current, witness)).toMatchObject({ candidateRef: witness.candidateRef })
    const suffixSnapshot = parseTaskGraphSnapshot({ ...snapshot, nodes: [...snapshot.nodes,
      { key: "later-scout", taskId: "later-scout-task", templateId: "scout", goal: "Explore another branch",
        successCriteria: ["Report findings"], dependsOn: [], depth: 1 },
    ] })
    const suffixTasks = new Map(tasks).set("later-scout-task", { id: "later-scout-task", role: "scout", status: "queued" as const, failureReason: null, result: null })
    const suffixStatuses = new Map(suffixSnapshot.nodes.map(node => [node.taskId, {
      status: (node.taskId === "later-scout-task" ? "queued" : node.taskId === "reviewer-task" ? "queued" : "completed") as "queued" | "completed", failureReason: null,
    }]))
    const withUnrelatedAppend: LoadedGraph = { ...current, item: { ...current.item!, revision: 6, content: suffixSnapshot }, snapshot: suffixSnapshot,
      state: taskGraphState(suffixSnapshot, 6, suffixStatuses, []), tasks: suffixTasks }
    expect(await revalidateObjectiveTailorCandidateWitness(initial.client as never, scope, withUnrelatedAppend, witness))
      .toMatchObject({ candidateRef: witness.candidateRef })
    const sourceChanged = parseTaskGraphSnapshot({ ...snapshot, nodes: snapshot.nodes.map(node =>
      node.key === "analyst-node" ? { ...node, goal: "Changed source analysis" } : node) })
    const changedSource: LoadedGraph = { ...current, item: { ...current.item!, content: sourceChanged }, snapshot: sourceChanged,
      state: taskGraphState(sourceChanged, 5, statuses, []) }
    expect(await revalidateObjectiveTailorCandidateWitness(initial.client as never, scope, changedSource, witness)).toBeUndefined()
    const staleMaterial = `sha256:${"e".repeat(64)}`
    mocks.digest.mockReturnValue(staleMaterial)
    expect(await revalidateObjectiveTailorCandidateWitness(initial.client as never, scope, current, witness)).toBeUndefined()
    mocks.digest.mockReturnValue(material)
    const wrongPair = { ...current, snapshot: parseTaskGraphSnapshot({ ...snapshot, nodes: snapshot.nodes.map(node =>
      node.key === witness.reviewerNodeKey ? { ...node, dependsOn: ["scout-node"] } : node) }) }
    expect(await revalidateObjectiveTailorCandidateWitness(initial.client as never, scope, wrongPair, witness)).toBeUndefined()
  })
})
