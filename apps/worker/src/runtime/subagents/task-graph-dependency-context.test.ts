import { describe, expect, it } from "vitest"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import {
  materializeTaskGraphDependencyContext,
  TASK_GRAPH_DEPENDENCY_CONTEXT_BYTE_LIMIT,
  TASK_GRAPH_DEPENDENCY_RESULT_BYTE_LIMIT,
  writerArtifactReferenceFromTaskContext,
  type ScopedDependencyResult,
} from "./task-graph-dependency-context.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./task-graph-command-port.js"

const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const scoutResult = {
  schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
  candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://example.test/apply?email=person@example.com", evidenceIds: ["job-evidence"] }],
  evidence: [{ id: "job-evidence", kind: "job", ref: "job-1", source: "greenhouse" }],
  summary: "Alice Example found a candidate; https://private.example/apply; contact user@example.com",
}
function dependency(overrides: Partial<ScopedDependencyResult> = {}): ScopedDependencyResult {
  return {
    ...scope, key: "source", taskId: "subagent-database-id", status: "completed", role: "scout",
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, result: envelope(scoutResult),
    ...overrides,
  }
}

function envelope(structuredResult: unknown): Record<string, unknown> {
  return { status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "item-final", finalText: "opaque final text", structuredResult }
}

function manyScoutResult(count: number): Record<string, unknown> {
  const candidates = Array.from({ length: count }, (_, index) => ({
    jobId: `job-${index}`, source: "greenhouse", url: null, evidenceIds: [`job-evidence-${index}`],
  }))
  const evidence = candidates.map((candidate, index) => ({
    id: `job-evidence-${index}`, kind: "job", ref: candidate.jobId, source: "greenhouse",
  }))
  return { ...scoutResult, candidates, evidence }
}

const writerArtifactRef = {
  artifactId: "artifact-1",
  version: 2,
  contentHash: `sha256:${"a".repeat(64)}`,
  sourceDigest: `sha256:${"b".repeat(64)}`,
}

function writerProjection(artifactRef: unknown = writerArtifactRef): Record<string, unknown> {
  return {
    schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA,
    trust: "untrusted",
    availability: "available",
    role: "writer",
    status: "completed",
    artifactRef,
  }
}

function reviewerTaskContext(items: unknown[]): Record<string, unknown> {
  return {
    selectedJobPreparation: { jobId: "job-1" },
    taskGraphDependencyResults: {
      schemaVersion: "agent-harness.v2.task-graph.dependency-evidence",
      items,
    },
  }
}

function writerDependency(result: unknown = writerProjection()): Record<string, unknown> {
  return { dependencyKey: "writer-task", role: "writer", taskStatus: "completed", result }
}

describe("TaskGraph dependency result context", () => {
  it("resolves the exact completed Writer artifact reference for the selected job", () => {
    expect(writerArtifactReferenceFromTaskContext(reviewerTaskContext([writerDependency()]), "job-1"))
      .toEqual(writerArtifactRef)
  })

  it.each([
    ["missing graph context", { selectedJobPreparation: { jobId: "job-1" } }, "job-1", "task_graph_reviewer_writer_dependency_missing"],
    ["missing Writer item", reviewerTaskContext([]), "job-1", "task_graph_reviewer_writer_dependency_missing"],
    ["duplicate Writer items", reviewerTaskContext([writerDependency(), writerDependency()]), "job-1", "task_graph_reviewer_writer_dependency_missing"],
    ["selected job mismatch", reviewerTaskContext([writerDependency()]), "job-2", "task_graph_reviewer_writer_dependency_missing"],
    ["malformed artifact digest", reviewerTaskContext([writerDependency({ ...writerProjection(), artifactRef: { ...writerArtifactRef, contentHash: "sha256:invalid" } })]), "job-1", "task_graph_reviewer_writer_dependency_invalid"],
  ])("fails closed for %s", (_label, context, expectedJobId, error) => {
    expect(() => writerArtifactReferenceFromTaskContext(context, expectedJobId as string)).toThrow(error as string)
  })

  it("projects only a scoped completed direct result, keeps deterministic counts, and removes URLs and freeform names", () => {
    const context = materializeTaskGraphDependencyContext({ query: "Dublin" }, scope, ["source"], [dependency()]) as Record<string, unknown>
    const evidence = context.taskGraphDependencyResults as Record<string, unknown>
    expect(evidence.schemaVersion).toBe("agent-harness.v2.task-graph.dependency-evidence")
    expect(evidence.items).toEqual([{
      dependencyKey: "source", role: "scout", taskStatus: "completed",
      result: {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
        role: "scout", status: "completed", candidateCount: 1, evidenceCount: 1,
        candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] }],
      },
    }])
    const encoded = JSON.stringify(context)
    expect(encoded).not.toContain("subagent-database-id")
    expect(encoded).not.toContain("user-1")
    expect(encoded).not.toContain("session-1")
    expect(encoded).not.toContain("email=person")
    expect(encoded).not.toContain("private.example")
    expect(encoded).not.toContain("Alice Example")
    expect(encoded).not.toContain("opaque final text")
    expect(encoded).not.toMatch(/lease|owner|budget|permission|capabilit/i)
  })

  it("normalizes unrecognized model-authored sources before exposing them", () => {
    const unsafeResult = {
      ...scoutResult,
      candidates: [{
        jobId: "job-1", source: "Alice Example https://private.example/source", url: "https://private.example/apply",
        evidenceIds: ["job-evidence"],
      }],
      evidence: [{ id: "job-evidence", kind: "job", ref: "job-1", source: "Alice Example" }],
    }
    const context = materializeTaskGraphDependencyContext({}, scope, ["source"], [dependency({ result: envelope(unsafeResult) })]) as Record<string, unknown>
    const encoded = JSON.stringify(context)
    const result = (((context.taskGraphDependencyResults as { items: Array<{ result: Record<string, unknown> }> }).items[0])?.result)

    expect(result).toMatchObject({
      candidates: [{ jobId: "job-1", source: "other", evidenceKinds: ["job"] }],
      candidateCount: 1, evidenceCount: 1,
    })
    expect(result).not.toHaveProperty("evidence")
    expect(encoded).not.toContain("private.example")
    expect(encoded).not.toContain("Alice Example")
  })

  it("preserves a one-to-one dependency-key mapping for multiple completed predecessors", () => {
    const second = dependency({ key: "other-source", taskId: "subagent-2" })
    const context = materializeTaskGraphDependencyContext({}, scope, ["other-source", "source"], [dependency(), second]) as Record<string, unknown>
    const evidence = context.taskGraphDependencyResults as { items: Array<{ dependencyKey: string }> }
    expect(evidence.items.map(item => item.dependencyKey)).toEqual(["other-source", "source"])
  })

  it.each([
    ["another tenant", dependency({ userId: "user-2" }), "task_graph_dependency_scope_mismatch"],
    ["another session", dependency({ sessionId: "session-2" }), "task_graph_dependency_scope_mismatch"],
    ["another turn", dependency({ turnId: "turn-2" }), "task_graph_dependency_scope_mismatch"],
    ["another root", dependency({ rootTaskId: "root-2", parentTaskId: "root-2" }), "task_graph_dependency_scope_mismatch"],
    ["another parent", dependency({ parentTaskId: "other-parent" }), "task_graph_dependency_scope_mismatch"],
    ["not completed", dependency({ status: "running" }), "task_graph_dependency_not_completed"],
    ["bad result marker", dependency({ expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" } }), "task_graph_dependency_result_contract_invalid"],
  ])("rejects %s evidence", (_label, source, error) => {
    expect(() => materializeTaskGraphDependencyContext({}, scope, ["source"], [source as ScopedDependencyResult])).toThrow(error as string)
  })

  it("bounds each projected result and an eight-node dependency aggregate", () => {
    expect(() => materializeTaskGraphDependencyContext({}, scope, ["source"], [dependency({ result: "x".repeat(16 * 1024 + 1) })]))
      .toThrow("task_graph_dependency_source_too_large")
    const many = Array.from({ length: 8 }, (_, index) => dependency({
      key: `dep-${index}`,
      result: envelope(manyScoutResult(18)),
    }))
    const context = materializeTaskGraphDependencyContext({}, scope, many.map(item => item.key), many) as Record<string, unknown>
    const evidence = context.taskGraphDependencyResults as { items: Array<{ result: Record<string, unknown> }> }
    expect(evidence.items[0]?.result).toMatchObject({
      candidateCount: 18,
      candidates: expect.arrayContaining([expect.objectContaining({ evidenceKinds: ["job"] })]),
    })
    expect(TASK_GRAPH_DEPENDENCY_CONTEXT_BYTE_LIMIT).toBe(8192)
    expect(Buffer.byteLength(JSON.stringify(evidence), "utf8")).toBeLessThanOrEqual(TASK_GRAPH_DEPENDENCY_CONTEXT_BYTE_LIMIT)
    expect(evidence.items.every(item => Buffer.byteLength(JSON.stringify(item.result), "utf8") <= TASK_GRAPH_DEPENDENCY_RESULT_BYTE_LIMIT)).toBe(true)
    const projected = JSON.stringify(evidence)
    expect(projected).not.toContain("Alice Example")
    expect(projected).not.toContain("private.example")
    expect(projected).not.toContain("job-evidence-0")
    expect(projected).not.toContain("opaque final text")
  })

  it("rejects missing, duplicate, and template-reserved graph dependencies", () => {
    expect(() => materializeTaskGraphDependencyContext({}, scope, ["missing"], [dependency()])).toThrow("task_graph_dependency_missing")
    expect(() => materializeTaskGraphDependencyContext({}, scope, ["source", "source"], [dependency(), dependency()])).toThrow("task_graph_dependency_set_invalid")
    expect(() => materializeTaskGraphDependencyContext({ taskGraphDependencyResults: "forged" }, scope, ["source"], [dependency()]))
      .toThrow("task_graph_dependency_context_reserved_key")
  })

  it("requires an exact completed worker result envelope before reading structuredResult", () => {
    expect(() => materializeTaskGraphDependencyContext({}, scope, ["source"], [dependency({ result: scoutResult })]))
      .toThrow("task_graph_dependency_result_invalid")
    expect(() => materializeTaskGraphDependencyContext({}, scope, ["source"], [dependency({
      result: { ...envelope(scoutResult), ownerId: "forbidden" },
    })])).toThrow("task_graph_dependency_result_invalid")
  })
})
