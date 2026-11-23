import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import type { TaskGraphVerificationContract } from "../planning/task-graph-verification.js"
import type { TaskGraphVerificationReceipts } from "./task-graph-pg-verification-receipts.js"
import {
  taskGraphJobDescriptionConflict,
  taskGraphJobDescriptionDependencyNodeKeys,
  taskGraphJobDescriptionWitnesses,
  type TaskGraphJobDescriptionWitnesses as Witnesses,
} from "./task-graph-job-description-proof.js"

const JOB_A = "11111111-1111-4111-8111-111111111111"
const JOB_B = "22222222-2222-4222-8222-222222222222"
const JOB_REF = "tool-result-33333333-3333-4333-8333-333333333333"

type Pair = Readonly<{ id: string; name: string; input: unknown; output: unknown }>

function receipts(pairs: readonly Pair[]): TaskGraphVerificationReceipts {
  const items: Record<string, unknown>[] = []
  const outcomes = new Map<string, "completed" | "failed">()
  for (const [ordinal, pair] of pairs.entries()) {
    items.push({ type: "tool_call", id: `call-item-${ordinal}`, taskId: "task", stepId: `step-${ordinal}`,
      attempt: 1, ordinal, content: { toolCallId: pair.id, toolName: pair.name, input: pair.input, status: "completed", errorCode: null } })
    items.push({ type: "tool_result", id: `result-item-${ordinal}`, taskId: "task", stepId: `step-${ordinal}`,
      attempt: 1, ordinal, content: { toolCallId: pair.id, output: pair.output, status: "completed", errorCode: null } })
    outcomes.set(pair.id, "completed")
  }
  return { items, outcomes, replayReceipts: [], evidenceObservations: [] }
}

function discover(description: string, fullDescription = description): Record<string, unknown> {
  return { jobs: [{ id: JOB_A, title: "Engineer", company: "Example", location: "Dublin", url: "https://jobs.example/1",
    description, fullDescription, salary: null, logo: null, source: "greenhouse", evidenceRefs: ["source-evidence"] }],
  evidence: [{ evidenceId: "source-evidence", jobId: JOB_A, kind: "source", source: "greenhouse", url: "https://jobs.example/1", summary: "Listing" }],
  nextCursor: null, usage: { toolName: "jobs.discover", toolVersion: "1", requests: 1, jobsProcessed: 1, jobsSucceeded: 1,
    jobsFailed: 0, aiCalls: 0, providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 1 } }
}

function getJob(description: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { job: { id: JOB_A, company: "Example", role: "Engineer", location: "Dublin", status: "saved", score: 8,
    url: "https://jobs.example/1", source: "greenhouse", salary: null, description, keywords: "TypeScript", ...overrides } }
}

function digest(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex") }

function scoutWitness(value: string): Witnesses { return new Map([[JOB_A, [digest(value)]]]) }
function analystWitness(value: string): Witnesses { return new Map([[JOB_A, [digest(value)]]]) }

function comparison(scout: Witnesses, analyst: Witnesses, jobId = JOB_A): boolean {
  return taskGraphJobDescriptionConflict({
    analyst: { findings: [{ jobId }] },
    dependencies: new Map([["scout-node", { schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      role: "scout", candidates: [{ jobId: JOB_A, evidenceIds: ["read:job:" + JOB_A] }], evidenceIds: [] }]]),
    requiredScoutNodeKeys: ["scout-node"], scoutWitnesses: new Map([["scout-node", scout]]), analystWitnesses: analyst,
  })
}

describe("TaskGraph Job description proof", () => {
  it("uses only directly typed Scout dependencies referenced by the two supported criteria", () => {
    const contract: TaskGraphVerificationContract = { schemaVersion: "agent-harness.v2.task-graph-verification.v1", role: "analyst", criteria: [
      { id: "direct", check: { kind: "findings_from_scout_dependency", dependencyNodeKey: "scout-direct" } },
      { id: "cover", check: { kind: "findings_cover_each_scout_candidates_gte", dependencyNodeKeys: ["scout-b", "scout-a"], minimumPercent: 100 } },
      { id: "union", check: { kind: "findings_from_scout_union", dependencyNodeKeys: ["scout-union"] } },
    ] }
    expect(taskGraphJobDescriptionDependencyNodeKeys(contract)).toEqual(["scout-a", "scout-b", "scout-direct"])
  })

  it("extracts only bounded fingerprints from exact redacted discovery and get receipts", () => {
    const scoutProof = taskGraphJobDescriptionWitnesses(receipts([
      { id: "discover-call", name: "jobs.discover", input: {}, output: discover("Verified description", "Provider-only detail") },
      { id: "get-call", name: "jobs.get", input: { jobId: JOB_A }, output: getJob("Scout follow-up description") },
    ]), [JOB_A], "scout")
    const analystProof = taskGraphJobDescriptionWitnesses(receipts([
      { id: "discover-call", name: "jobs.discover", input: {}, output: discover("Unrelated analyst discovery") },
      { id: "get-call", name: "jobs.get", input: { jobId: JOB_A }, output: getJob("Verified description", { score: 9, keywords: "Other keywords" }) },
    ]), [JOB_A], "analyst")
    expect(scoutProof.get(JOB_A)).toEqual([digest("Verified description")])
    expect(analystProof.get(JOB_A)).toEqual([digest("Verified description")])
    expect(JSON.stringify(scoutProof)).not.toContain("Verified description")
  })

  it("reassembles a digest-checked durable discovery receipt before fingerprinting", () => {
    const output = discover("Durable verified description")
    const serialized = JSON.stringify(output), sha256 = digest(serialized)
    const reference = { $ref: JOB_REF, sizeBytes: Buffer.byteLength(serialized, "utf8"), sha256 }
    const proof = taskGraphJobDescriptionWitnesses(receipts([
      { id: "discover-call", name: "jobs.discover", input: {}, output: reference },
      { id: "read-call", name: "tool_results.read", input: { referenceId: JOB_REF },
        output: { ref: JOB_REF, sha256, byteCount: reference.sizeBytes, chunk: serialized, nextCursor: null } },
    ]), [JOB_A], "scout")
    expect(proof.get(JOB_A)).toEqual([digest("Durable verified description")])
    expect(JSON.stringify(proof)).not.toContain("Durable verified description")
  })

  it("matches identical descriptions and rejects a changed nonempty description for the same used Job", () => {
    expect(comparison(scoutWitness("Original"), analystWitness("Original"))).toBe(false)
    expect(comparison(scoutWitness("Original"), analystWitness("Changed"))).toBe(true)
  })

  it("does not compare unrelated Jobs or provider-only fields", () => {
    expect(comparison(scoutWitness("Original"), analystWitness("Changed"), JOB_B)).toBe(false)
    const scout = taskGraphJobDescriptionWitnesses(receipts([
      { id: "discover-call", name: "jobs.discover", input: {}, output: discover("Original", "Changed fullDescription") },
      { id: "get-call", name: "jobs.get", input: { jobId: JOB_A }, output: getJob("Original", { score: 7, keywords: "Changed keywords" }) },
    ]), [JOB_A], "scout")
    expect(scout.get(JOB_A)).toEqual([digest("Original")])
  })

  it("treats absent or empty descriptions as noncomparable and detects conflicting repeated reads", () => {
    const sparse = taskGraphJobDescriptionWitnesses(receipts([
      { id: "discover-call", name: "jobs.discover", input: {}, output: discover("") },
      { id: "get-call", name: "jobs.get", input: { jobId: JOB_A }, output: getJob("") },
    ]), [JOB_A], "scout")
    expect(sparse.has(JOB_A)).toBe(false)
    expect(comparison(scoutWitness("Original"), new Map())).toBe(false)
    expect(comparison(new Map(), new Map([[JOB_A, [digest("Changed"), digest("Other")]]]))).toBe(false)
    expect(comparison(new Map([[JOB_A, [digest("Original"), digest("Changed")]]]), analystWitness("Original"))).toBe(true)
    expect(comparison(scoutWitness("Original"), new Map([[JOB_A, [digest("Original"), digest("Changed")]]]))).toBe(true)
  })
})
