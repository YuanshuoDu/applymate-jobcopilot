import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { buildTaskGraphFinalSummaryBinding } from "./task-graph-final-summary-binding.js"
import { buildTaskGraphFinalSourceManifest } from "./task-graph-final-source-manifest.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { taskGraphItemId, type TaskGraphSnapshot } from "./task-graph-snapshot.js"

function graph(rows: readonly GraphTaskRow[]): LoadedGraph {
  const nodes = rows.map((task, nodeIndex) => ({ key: `private-node-${nodeIndex}`, templateId: task.taskType!, taskId: task.id }))
  return { rootTaskId: "private-root-id", item: { id: taskGraphItemId("private-root-id"), revision: 7, content: {}, createdAt: new Date(0) },
    snapshot: { nodes } as unknown as TaskGraphSnapshot, state: { revision: 7 } as LoadedGraph["state"],
    tasks: new Map(rows.map(task => [task.id, task])) } as LoadedGraph
}

function task(id: string, role: string, taskType: string, structuredResult?: unknown): GraphTaskRow {
  return { id, role, taskType, status: "completed", failureReason: null,
    result: structuredResult === undefined ? { status: "completed" } : { status: "completed", structuredResult } }
}

const scoutResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence: [], summary: "PRIVATE_TEXT" }

describe("TaskGraph final source manifest", () => {
  it("emits every business outcome in graph order using final-item-bound opaque keys", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([
      task("private-scout-task", "scout", "research", scoutResult),
      task("private-native-control", "auditor", "native_verification"),
      task("private-unknown-task", "odd-role", "custom"),
    ]))!
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")
    const digest = createHash("sha256").update(`taskGraphSource:v1\0private-final-item\0${binding.graphRevision}\0${0}`).digest("base64url")

    expect(manifest).toEqual({ schemaVersion: "agent-harness.v2.task-graph-sources.v1", graphRevision: 7, sources: [
      { sourceKey: `src_${digest}`, nodeIndex: 0, role: "scout", taskStatus: "completed", resultState: "valid", roleResultStatus: "completed" },
      { sourceKey: expect.stringMatching(/^src_[A-Za-z0-9_-]{43}$/), nodeIndex: 2, role: "unsupported", taskStatus: "completed", resultState: "unsupported_role" },
    ] })
    expect(JSON.stringify(manifest)).not.toMatch(/private-root-id|private-final-item|private-scout-task|private-native-control|private-unknown-task|PRIVATE_TEXT/)
    expect(buildTaskGraphFinalSourceManifest(binding, "another-final-item")?.sources[0]?.sourceKey).not.toBe(manifest?.sources[0]?.sourceKey)
  })

  it("fails closed when business outcomes are missing, duplicated, or no longer match their graph member", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([task("private-scout-task", "scout", "research", scoutResult)]))!
    const missing = { ...binding, summary: { ...binding.summary, taskOutcomes: [] } }
    const duplicate = { ...binding, summary: { ...binding.summary, taskOutcomes: [...binding.summary.taskOutcomes, binding.summary.taskOutcomes[0]!] } }
    const wrongRole = { ...binding, summary: { ...binding.summary, taskOutcomes: binding.summary.taskOutcomes.map(item => ({ ...item, role: "analyst" as const })) } }
    const missingMember = { ...binding, members: [] }
    const duplicateMember = { ...binding, members: [...binding.members!, { ...binding.members![0]!, nodeIndex: 1 }] }
    const wrongGraph = { ...binding, graphItemId: "task-graph-other-root" }

    for (const invalid of [missing, duplicate, wrongRole, missingMember, duplicateMember, wrongGraph]) {
      expect(() => buildTaskGraphFinalSourceManifest(invalid, "final-item")).toThrow()
    }
  })

  it("keeps a current control-only graph free of user-facing source entries", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([task("private-native-control", "auditor", "native_verification")]))!
    expect(buildTaskGraphFinalSourceManifest(binding, "private-final-item")).toBeNull()
  })

  it("supports the full eight-node disclosure bound without dropping a business outcome", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph(Array.from({ length: 8 }, (_, index) =>
      task(`private-task-${index}`, "unregistered", "custom"))))!
    const manifest = buildTaskGraphFinalSourceManifest(binding, "private-final-item")
    expect(manifest?.sources).toHaveLength(8)
    expect(manifest?.sources.map(source => source.nodeIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(new Set(manifest?.sources.map(source => source.sourceKey)).size).toBe(8)
  })

  it("rejects legacy summary-only bindings and malformed final item identities", () => {
    const binding = buildTaskGraphFinalSummaryBinding(graph([task("private-scout-task", "scout", "research", scoutResult)]))!
    expect(() => buildTaskGraphFinalSourceManifest({ graphRevision: binding.graphRevision, summary: binding.summary }, "final-item"))
      .toThrow("task_graph_final_source_binding_invalid")
    expect(() => buildTaskGraphFinalSourceManifest(binding, "bad\0item")).toThrow("task_graph_final_source_binding_invalid")
  })
})
