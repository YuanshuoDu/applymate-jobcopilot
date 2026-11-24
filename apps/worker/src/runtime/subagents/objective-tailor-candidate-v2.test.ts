import { beforeEach, describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot, taskGraphItemId, taskGraphState } from "./task-graph-snapshot.js"
import { buildObjectiveTailorWaveCandidateCatalog, resolveObjectiveTailorWaveCandidates } from "./objective-tailor-candidate-v2.js"
import type { GraphIdentityScope, LoadedGraph } from "./task-graph-pg-state.js"

const mocks = vi.hoisted(() => ({ inventory: vi.fn(), proof: vi.fn(), getJob: vi.fn(), material: vi.fn() }))
vi.mock("./objective-tailor-wave-inventory.js", () => ({ readObjectiveTailorWaveInventory: mocks.inventory }))
vi.mock("./scheduled-draft-candidate-analyst-proof.js", async importOriginal => ({
  ...await importOriginal<typeof import("./scheduled-draft-candidate-analyst-proof.js")>(),
  readScheduledDraftAnalystProof: mocks.proof,
}))
vi.mock("./scheduled-draft-job-material.js", () => ({ scheduledDraftJobMaterialDigest: mocks.material }))
vi.mock("../tools/read-data-source.js", () => ({ createPostgresReadToolDataSource: () => ({ getJob: mocks.getJob }) }))

const scope: GraphIdentityScope = { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root" }
const ids = [
  "f47ac10b-58cc-4372-a567-0e02b2c3d471", "f47ac10b-58cc-4372-a567-0e02b2c3d472",
  "f47ac10b-58cc-4372-a567-0e02b2c3d473",
]
const digests = ids.map((_, index) => `sha256:${String(index + 1).repeat(64)}`)
const sourceSnapshot = parseTaskGraphSnapshot({ schemaVersion: "agent-harness.v2.task-graph", nodes: [
  { key: "scout", taskId: "scout-task", templateId: "scout", goal: "Find jobs", successCriteria: ["Find jobs"], dependsOn: [],
    depth: 1, verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
      role: "scout", criteria: [{ id: "count", check: { kind: "candidate_count_gte", minimum: 1 } }] } },
  { key: "analyst", taskId: "analyst-task", templateId: "analyst", goal: "Verify jobs", successCriteria: ["Verify jobs"], dependsOn: ["scout"],
    depth: 2, verificationDisposition: "typed", verification: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
      role: "analyst", criteria: [{ id: "membership", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout" } }] } },
] })
const statuses = new Map(sourceSnapshot.nodes.map(node => [node.taskId, { status: "completed" as const, failureReason: null }]))
const loaded: LoadedGraph = { rootTaskId: scope.rootTaskId,
  item: { id: taskGraphItemId(scope.rootTaskId), revision: 12, content: sourceSnapshot, createdAt: new Date(0) },
  snapshot: sourceSnapshot, state: taskGraphState(sourceSnapshot, 12, statuses, []),
  tasks: new Map(sourceSnapshot.nodes.map(node => [node.taskId, { id: node.taskId, status: "completed", role: node.templateId,
    taskType: node.templateId === "analyst" ? "job_analysis" : "job_discovery", failureReason: null, result: null }])),
  discoveryTurnEligibility: "ordinary" }
const inventoryBase = { graphRevision: 12, sourceGraphRevision: 4, sourceGraphDigest: "a".repeat(64),
  sourceStatusDigest: "b".repeat(64), sourceNodeCount: 2, sourceSnapshot, occupiedSlots: [], occupiedJobIds: [], marker: null }
const proofBinding = { nodeKey: "analyst", taskId: "analyst-task", attemptCount: 1, resultDigest: "c".repeat(64),
  evidenceDigest: "d".repeat(64), reportDigest: "e".repeat(64), scouts: [] }

function currentJob(jobId: string, digest: string) { return { id: jobId, role: "Software Engineer", company: "Example Ltd", materialDigest: digest } }
function configure(options: { graphRevision?: number; occupied?: readonly string[]; findings?: readonly { jobId: string; score: number }[];
  receiptDigests?: ReadonlyMap<string, string> } = {}) {
  mocks.inventory.mockResolvedValue({ ...inventoryBase, graphRevision: options.graphRevision ?? 12,
    occupiedJobIds: options.occupied ?? [] })
  const findings = options.findings ?? [{ jobId: ids[0]!, score: 9 }, { jobId: ids[1]!, score: 8 }]
  const receiptDigests = options.receiptDigests ?? new Map(findings.map(({ jobId }) => [jobId, digests[ids.indexOf(jobId)]!]))
  mocks.proof.mockResolvedValue({ result: { findings }, materialDigests: receiptDigests, binding: proofBinding })
  const jobs = new Map(findings.map(({ jobId }) => [jobId, currentJob(jobId, receiptDigests.get(jobId)!)]))
  mocks.getJob.mockImplementation(async (_userId: string, jobId: string) => jobs.get(jobId) ?? null)
  mocks.material.mockImplementation((job: unknown) => (job as { materialDigest?: string } | null)?.materialDigest ?? null)
  return jobs
}

beforeEach(() => vi.clearAllMocks())

describe("Objective Tailor V2 catalog", () => {
  it("keeps candidate references stable across unrelated graph revisions and exposes only bounded cards", async () => {
    configure()
    const first = await buildObjectiveTailorWaveCandidateCatalog({ query: vi.fn() } as never, scope, loaded)
    mocks.inventory.mockResolvedValue({ ...inventoryBase, graphRevision: 13, occupiedJobIds: [ids[2]] })
    mocks.proof.mockResolvedValue({ result: { findings: [{ jobId: ids[0]!, score: 9 }, { jobId: ids[1]!, score: 8 },
      { jobId: ids[2]!, score: 7 }] }, materialDigests: new Map(ids.map((id, index) => [id, digests[index]!])), binding: proofBinding })
    const next = await buildObjectiveTailorWaveCandidateCatalog({ query: vi.fn() } as never, scope, loaded)
    expect(first?.graphRevision).toBe(12)
    expect(next?.graphRevision).toBe(13)
    expect(first?.candidates.map(card => card.candidateRef)).toEqual(next?.candidates.map(card => card.candidateRef))
    expect(JSON.stringify(next)).not.toContain(ids[0]!)
    expect(JSON.stringify(next)).not.toContain("materialDigest")
  })

  it("filters stale high-ranked material before applying the candidate cap", async () => {
    const candidates = Array.from({ length: 9 }, (_, index) => `f47ac10b-58cc-4372-a567-${index.toString(16).padStart(12, "0")}`)
    const findings = candidates.map((jobId, index) => ({ jobId, score: 9 - index }))
    const receipts = new Map(candidates.map((jobId, index) => [jobId, `sha256:${String(index + 1).repeat(64)}`]))
    configure({ findings, receiptDigests: receipts })
    const jobs = new Map(candidates.map((jobId, index) => [jobId, currentJob(jobId,
      index === 0 ? `sha256:${"f".repeat(64)}` : receipts.get(jobId)!)]))
    mocks.getJob.mockImplementation(async (_userId: string, id: string) => jobs.get(id) ?? null)
    const catalog = await buildObjectiveTailorWaveCandidateCatalog({ query: vi.fn() } as never, scope, loaded)
    expect(mocks.getJob.mock.calls.map(([, id]) => id)).toEqual(candidates)
    expect(catalog?.candidates).toHaveLength(8)
    expect(catalog?.candidates.map(card => card.score)).toEqual([8, 7, 6, 5, 4, 3, 2, 1])
  })

  it("keeps stale occupied Jobs occupied while resolving valid siblings", async () => {
    const findings = ids.map((jobId, index) => ({ jobId, score: 10 - index }))
    configure({ findings, occupied: [ids[0]], receiptDigests: new Map(ids.map((id, index) => [id, digests[index]!])) })
    const catalog = await buildObjectiveTailorWaveCandidateCatalog({ query: vi.fn() } as never, scope, loaded)
    expect(mocks.getJob.mock.calls.map(([, id]) => id)).not.toContain(ids[0])
    expect(catalog?.candidates).toHaveLength(2)
    const selected = catalog!.candidates.map(card => card.candidateRef)
    expect(await resolveObjectiveTailorWaveCandidates({ query: vi.fn() } as never, scope, loaded, 12, selected)).toHaveLength(2)
    expect(await resolveObjectiveTailorWaveCandidates({ query: vi.fn() } as never, scope, loaded, 11, selected)).toBeUndefined()
  })

  it("rejects malformed, duplicate, sparse, or oversized refs before inventory reads", async () => {
    configure()
    const client = { query: vi.fn() }
    for (const refs of [["otc2_bad"], ["otc2_" + "a".repeat(64), "otc2_" + "a".repeat(64)], new Array(1),
      Array.from({ length: 5 }, (_, index) => `otc2_${String(index).repeat(64)}`)]) {
      expect(await resolveObjectiveTailorWaveCandidates(client as never, scope, loaded, 12, refs)).toBeUndefined()
    }
    expect(mocks.inventory).not.toHaveBeenCalled()
  })
})
