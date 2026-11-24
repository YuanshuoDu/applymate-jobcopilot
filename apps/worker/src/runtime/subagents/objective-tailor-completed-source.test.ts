import { createHash } from "node:crypto"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PoolClient } from "pg"
import { OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA } from "@jobcopilot/agent-protocol"
import type { ObjectiveTailorWaveCompletionWitness, ObjectiveTailorWaveSlotOutcome } from "../canonical-objective-tailor-wave-completion.js"
import type { ObjectiveTailorWaveInventory } from "./objective-tailor-wave-inventory.js"
import type { LoadedGraph } from "./task-graph-pg-state.js"

const ids = { userId: "owner-1", sessionId: "session-1", reviewTurnId: "review-turn", sourceTurnId: "source-turn", rootTaskId: "root-1",
  graphItemId: "task-graph-" + createHash("sha256").update("root-1").digest("hex"), graphRevision: 6 }
const mocks = vi.hoisted(() => ({ load: vi.fn(), inventory: vi.fn(), verify: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: mocks.load }))
vi.mock("./objective-tailor-wave-inventory.js", () => ({ readObjectiveTailorWaveInventory: mocks.inventory }))
vi.mock("../canonical-objective-tailor-wave-completion.js", () => ({ verifyCompletedObjectiveTailorWaveSlots: mocks.verify }))
import { readCompletedObjectiveTailorSourceEvidence } from "./objective-tailor-completed-source.js"

const nodes = [
  { key: "scout-1", taskId: "scout-row", templateId: "scout", goal: "Search", successCriteria: [], dependsOn: [], verificationDisposition: "typed" },
  { key: "analyst-1", taskId: "analyst-row", templateId: "analyst", goal: "Analyze", successCriteria: [], dependsOn: ["scout-1"], verificationDisposition: "typed" },
]
const tasks = new Map([
  ["scout-row", { id: "scout-row", role: "scout", taskType: "scout", status: "completed", result: { status: "completed" }, failureReason: null }],
  ["analyst-row", { id: "analyst-row", role: "analyst", taskType: "analyst", status: "completed", result: { status: "completed" }, failureReason: null }],
])
const loaded = { rootTaskId: ids.rootTaskId, item: { id: ids.graphItemId, revision: 6, content: {}, createdAt: new Date(0) },
  snapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", nodes, objectiveTailor: { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2, slots: [] } },
  state: { revision: 6, nodes: nodes.map(node => ({ ...node, status: "completed", readiness: "terminal" })), objectiveTailor: { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2, slots: [] } },
  tasks, discoveryTurnEligibility: "ordinary" } as unknown as LoadedGraph
const marker = { schemaVersion: "agent-harness.v2.objective-tailor-graph.v1", sourceNodeCount: 2, slots: [
  { slotId: "tailor-1", sourceAnalystNodeKey: "analyst-1", writerNodeKey: "writer-1", reviewerNodeKey: "reviewer-1" },
  { slotId: "tailor-2", sourceAnalystNodeKey: "analyst-1", writerNodeKey: "writer-2", reviewerNodeKey: "reviewer-2" },
] }
const inventory = { graphRevision: 6, sourceNodeCount: 2, sourceGraphRevision: 2, sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64),
  sourceSnapshot: { schemaVersion: "agent-harness.v2.task-graph.v1", nodes }, occupiedSlots: marker.slots.map((slot, index) => ({
    ...slot, jobId: `job-${index + 1}`, writerTaskId: `writer-row-${index + 1}`, reviewerTaskId: `reviewer-row-${index + 1}`, candidateWitness: {},
  })), occupiedJobIds: ["job-1", "job-2"], marker } as unknown as ObjectiveTailorWaveInventory
const witness = { graphRevision: 6, graphDigest: "c".repeat(64), marker, sourceGraphRevision: 2, sourceGraphDigest: "a".repeat(64), sourceStatusDigest: "b".repeat(64), outcomes: [] } as unknown as ObjectiveTailorWaveCompletionWitness
function outcome(ordinal: number, status: ObjectiveTailorWaveSlotOutcome["status"] = "ready"): ObjectiveTailorWaveSlotOutcome {
  return { slotId: `tailor-${ordinal}`, jobId: `job-${ordinal}`, writerTaskId: `writer-row-${ordinal}`,
    reviewerTaskId: `reviewer-row-${ordinal}`, status, candidateWitness: {} } as ObjectiveTailorWaveSlotOutcome
}
function finalContent(statuses: readonly string[] = ["ready", "stale"], revision = 6) {
  const sourceManifest = { schemaVersion: "agent-harness.v2.task-graph-sources.v1", graphRevision: revision, sources: nodes.map((node, index) => ({
    sourceKey: "src_" + createHash("sha256").update("taskGraphSource:v1\0final-1\0" + revision + "\0" + index).digest("base64url"), nodeIndex: index,
    role: node.templateId, taskStatus: "completed", resultState: "valid", roleResultStatus: "completed",
  })) }
  return { text: "Done", final: { schemaVersion: "agent-harness.v2.final", response: "Done" }, taskGraphSources: sourceManifest,
    objectiveTailorFinalOutcomes: { schemaVersion: OBJECTIVE_TAILOR_FINAL_OUTCOME_SIDECAR_SCHEMA,
      slots: statuses.map((status, index) => ({ ordinal: index + 1, status })) } }
}
function makeClient(overrides: { reviewStatus?: string; sourceStatus?: string; sourceUserId?: string; eventCount?: number; itemCount?: number; content?: unknown } = {}) {
  const content = overrides.content ?? finalContent()
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes('FROM "User"')) return { rows: [{ id: ids.userId }] }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: ids.sessionId }] }
    if (sql.includes('FROM "agent_turns"')) return { rows: [{ id: values[0], status: values[0] === ids.reviewTurnId ? overrides.reviewStatus ?? "in_progress" : overrides.sourceStatus ?? "completed",
      source: "user", rootTaskId: ids.rootTaskId, executionMode: "canonical_task_graph" }] }
    if (sql.includes('task."attemptCount"')) return { rows: [{ id: ids.rootTaskId, attemptCount: 1, result: { status: "completed", finalItemId: "final-1" } }] }
    if (sql.includes('FOR SHARE OF task NOWAIT')) return { rows: [...tasks.values()] }
    if (sql.includes('FROM "agent_events"')) return { rows: Array.from({ length: overrides.eventCount ?? 1 }, () => ({ id: "terminal-event", itemId: "final-1", taskId: ids.rootTaskId,
      actor: "orchestrator", idempotencyKey: "turn:" + ids.sourceTurnId + ":event:turn-completed", payload: { turnId: ids.sourceTurnId, taskId: ids.rootTaskId, finalItemId: "final-1" } })) }
    if (sql.includes('FROM "agent_items"')) return { rows: Array.from({ length: overrides.itemCount ?? 1 }, () => ({ id: "final-1", type: "agent_message", status: "completed", phase: "final_answer", content })) }
    return { rows: [] }
  })
  return { client: { query } as unknown as PoolClient, query }
}
function input(selectedSlotIds: string[] = ["tailor-1"]) { return { ...ids, selectedSlotIds } }

beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue(loaded)
  mocks.inventory.mockResolvedValue(inventory)
  mocks.verify.mockImplementation(async (value: { selectedSlotIds: readonly string[] }) => ({ status: "ready",
    outcomes: value.selectedSlotIds.map(id => outcome(Number(id.slice(7)))), witness }))
})

describe("completed Objective Tailor source reader", () => {
  it("binds a distinct active review Turn to the exact completed source and selected current slot", async () => {
    const { client, query } = makeClient()
    const result = await readCompletedObjectiveTailorSourceEvidence(client, input())
    expect(result).toMatchObject({ sourceTurnId: ids.sourceTurnId, reviewTurnId: ids.reviewTurnId, sourceRootTaskId: ids.rootTaskId,
      graphItemId: loaded.item?.id, graphRevision: 6, finalItemId: "final-1", outcomes: [{ slotId: "tailor-1", status: "ready" }] })
    expect(mocks.verify).toHaveBeenCalledWith({ client, scope: { userId: ids.userId, sessionId: ids.sessionId, turnId: ids.sourceTurnId,
      rootTaskId: ids.rootTaskId, parentTaskId: ids.rootTaskId }, loaded, selectedSlotIds: ["tailor-1"] })
    expect(query.mock.calls[0]?.[0]).toContain('FROM "User"')
    expect(query.mock.calls.map(([sql]) => sql).some(sql => String(sql).includes("FOR SHARE OF task NOWAIT"))).toBe(true)
  })

  it("keeps unselected stale outcomes from blocking a selected ready slot", async () => {
    const { client } = makeClient({ content: finalContent(["ready", "stale"]) })
    await expect(readCompletedObjectiveTailorSourceEvidence(client, input(["tailor-1"]))).resolves.toMatchObject({ outcomes: [{ slotId: "tailor-1", status: "ready" }] })
  })

  it.each([
    ["same source and review Turn", { reviewTurnId: ids.sourceTurnId }],
    ["pending source Turn", { sourceStatus: "in_progress" }],
    ["foreign review Turn", { reviewStatus: "completed" }],
    ["wrong requested root", { rootTaskId: "root-other" }],
    ["wrong requested graph item", { graphItemId: "task-graph-other" }],
    ["wrong requested graph revision", { graphRevision: 5 }],
    ["duplicate terminal event", { eventCount: 2 }],
    ["duplicate final item", { itemCount: 2 }],
    ["invalid selected sidecar outcome", { content: finalContent(["stale", "ready"]) }],
    ["wrong final graph revision", { content: finalContent(["ready", "stale"], 5) }],
  ])("rejects %s", async (name, clientOverrides) => {
    const { client } = makeClient(clientOverrides as Parameters<typeof makeClient>[0])
    const request = name === "same source and review Turn" ? { ...input(), reviewTurnId: ids.sourceTurnId }
      : name === "wrong requested root" ? { ...input(), rootTaskId: "root-other" }
      : name === "wrong requested graph item" ? { ...input(), graphItemId: "task-graph-other" }
          : name === "wrong requested graph revision" ? { ...input(), graphRevision: 5 } : input()
    await expect(readCompletedObjectiveTailorSourceEvidence(client, request)).resolves.toBeUndefined()
  })

  it("rejects incomplete or nonready recomputed selected evidence", async () => {
    const { client } = makeClient()
    mocks.verify.mockResolvedValueOnce({ status: "ready", outcomes: [outcome(1, "stale")], witness })
    await expect(readCompletedObjectiveTailorSourceEvidence(client, input())).resolves.toBeUndefined()
    mocks.verify.mockResolvedValueOnce({ status: "blocked", outcomes: [], witness: undefined })
    await expect(readCompletedObjectiveTailorSourceEvidence(client, input())).resolves.toBeUndefined()
  })
})
