import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type { CompactionSource } from "./context-compaction-types.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnLease } from "../turns/lease.js"
import type { CanonicalTurnState } from "../canonical-turn-state.js"

const source: CompactionSource = {
  state: {
    ownerId: "user-1", sessionId: "session-1", throughSequence: 100n, goal: "Find roles", userConstraints: [],
    approvals: [], answers: [], artifacts: [], openTasks: [], doNotRepeat: [], facts: [],
  },
  items: [{ id: "item-1", sessionId: "session-1", turnId: "turn-1", sequence: 100n, type: "agent_message", status: "completed", content: "history ".repeat(800) }],
}
const itemThresholdSource: CompactionSource = {
  ...source,
  items: Array.from({ length: 100 }, (_, index) => ({
    id: `item-${index + 1}`, sessionId: "session-1", turnId: "turn-1", sequence: BigInt(index + 1),
    type: "agent_message", status: "completed", content: "history item",
  })),
}
const loadSource = vi.fn(async () => source)
const publishedItemIds: string[] = []
const startedItemIds: string[] = []
const compactionPort = {
  loadLatest: vi.fn(async () => null),
  recordStarted: vi.fn(async (item: { id: string }) => { startedItemIds.push(item.id) }),
  publishAtomically: vi.fn(async (input: { startedItem: { id: string } }) => {
    publishedItemIds.push(input.startedItem.id)
    return { id: "snapshot-2", sessionId: "session-1", throughSequence: 100n, version: 2 }
  }),
  recordFailed: vi.fn(async () => undefined),
}

vi.mock("./context-compaction-pg-source.js", () => ({ createPgCompactionSource: () => ({ load: loadSource }) }))
vi.mock("./context-snapshot-compaction-pg.js", () => ({ createPgContextSnapshotCompactionPort: () => compactionPort }))

import { runTurnBoundaryCompactionPreflight, runTurnBoundaryContextCompaction } from "./turn-boundary-compaction-preflight.js"
import { createPgCompactionSource } from "./context-compaction-pg-source.js"
import { createPgContextSnapshotCompactionPort } from "./context-snapshot-compaction-pg.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", userId: "user-1", ownerId: "worker-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-09-07T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-07T00:01:00.000Z"),
}
const owner: TurnExecutionOwnerFence = { kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1", ownerId: "worker-1", leaseExpiresAt: lease.leaseExpiresAt, leaseVersion: 2 }

function state(overrides: Partial<CanonicalTurnState> = {}): CanonicalTurnState {
  return {
    scope: { userId: "user-1" }, goal: "Find roles", modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
    snapshot: {
      system: [], profile: [], steerHistory: [], businessRefs: [],
      goal: { id: "turn-goal", content: "Find roles" },
      toolObservations: [{ id: "wait-result:wait-1", content: { toolName: "agent.wait", output: { status: "ready" } } }],
    },
    ...overrides,
  }
}

function model(
  events: ModelStreamEvent[] = [{ type: "text_delta", text: "Short narrative" }, { type: "completed", finishReason: "stop" }],
  requests: HarnessModelRequest[] = [],
): ModelAdapter {
  return {
    id: "fixture", profile: {
      provider: "fixture", model: "fixture", nativeTools: false, structuredOutput: false, streaming: true, continuationCursor: false,
      supportsParallelTools: false, supportsStreamingToolArgs: false, supportsReasoningSummary: false, supportsResponseContinuation: false,
      supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low",
    },
    async *stream(request) { requests.push(request); expect(request.metadata.stepId).toContain("context-compaction:turn-1:"); yield* events },
  }
}

describe("turn-boundary context compaction preflight", () => {
  it.each([
    ["disabled", { enabled: false, state: state() }],
    ["pinned", { enabled: true, state: state({ contextSnapshotPinned: true }) }],
    ["unknown pin state", { enabled: true, state: state() }],
  ])("does not compact when %s", async (_label, input) => {
    const compact = vi.fn(async () => ({ status: "compacted" }))
    const reload = vi.fn(async () => state())
    const result = await runTurnBoundaryCompactionPreflight({ ...input, signal: new AbortController().signal, compact, reload })
    expect(result.compacted).toBe(false)
    expect(compact).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it("does not start when already interrupted", async () => {
    const controller = new AbortController(); controller.abort()
    const compact = vi.fn(async () => ({ status: "compacted" }))
    await runTurnBoundaryCompactionPreflight({ enabled: true, state: state(), signal: controller.signal, compact, reload: async () => state() })
    expect(compact).not.toHaveBeenCalled()
  })

  it("reloads after compaction while retaining the current goal and first-read wait result", async () => {
    const initial = state({ contextSnapshotPinned: false })
    const refreshed = state({ contextSnapshotPinned: false, snapshot: { ...state().snapshot, goal: { id: "new-goal", content: "stale" }, toolObservations: [
      { id: "wait-result:wait-1", content: { toolName: "agent.wait", output: { status: "stale" } } },
      { id: "new-tail", content: { fresh: true } },
    ] } })
    const reload = vi.fn(async () => refreshed)
    const result = await runTurnBoundaryCompactionPreflight({
      enabled: true, state: initial, signal: new AbortController().signal,
      compact: async () => ({ status: "compacted" }), reload,
    })
    expect(reload).toHaveBeenCalledOnce()
    expect(result.compacted).toBe(true)
    expect(result.state.goal).toBe("Find roles")
    expect(result.state.snapshot.goal).toEqual(initial.snapshot.goal)
    expect(result.state.snapshot.toolObservations).toEqual([
      { id: "wait-result:wait-1", content: { toolName: "agent.wait", output: { status: "ready" } } },
      { id: "new-tail", content: { fresh: true } },
    ])
  })

  it("evaluates thresholds at the turn boundary and compacts at the item-count threshold", async () => {
    loadSource.mockClear(); compactionPort.publishAtomically.mockClear(); compactionPort.recordFailed.mockClear()
    compactionPort.recordStarted.mockClear(); compactionPort.loadLatest.mockClear()
    loadSource.mockReset().mockResolvedValue(itemThresholdSource)
    publishedItemIds.length = 0; startedItemIds.length = 0
    const requests: HarnessModelRequest[] = []
    const result = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner, lease, model: model(undefined, requests), signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ status: "compacted", trigger: { reason: "item_count" } })
    expect(loadSource).toHaveBeenCalledWith({ scope: { userId: "user-1" }, owner })
    expect(requests).toHaveLength(1)
    expect(compactionPort.recordStarted).toHaveBeenCalledOnce()
    expect(compactionPort.publishAtomically).toHaveBeenCalledOnce()
    expect(publishedItemIds).toEqual(["context-compaction:turn-1:2:100"])
    expect(createPgCompactionSource).toBeDefined()
    expect(createPgContextSnapshotCompactionPort).toBeDefined()
  })

  it("does not summarize or publish nonempty history below both thresholds", async () => {
    loadSource.mockReset().mockResolvedValue(source)
    compactionPort.loadLatest.mockClear(); compactionPort.recordStarted.mockClear()
    compactionPort.publishAtomically.mockClear(); compactionPort.recordFailed.mockClear()
    publishedItemIds.length = 0; startedItemIds.length = 0
    const requests: HarnessModelRequest[] = []

    const result = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner, lease, model: model(undefined, requests), signal: new AbortController().signal,
    })

    expect(result.status).toBe("skipped")
    expect(source.items).toHaveLength(1)
    expect(requests).toHaveLength(0)
    expect(compactionPort.loadLatest).not.toHaveBeenCalled()
    expect(compactionPort.recordStarted).not.toHaveBeenCalled()
    expect(compactionPort.publishAtomically).not.toHaveBeenCalled()
    expect(compactionPort.recordFailed).not.toHaveBeenCalled()
    expect(startedItemIds).toEqual([])
    expect(publishedItemIds).toEqual([])
  })

  it("retries a failed item under a new lease while keeping IDs stable within each lease", async () => {
    loadSource.mockReset().mockResolvedValue(itemThresholdSource)
    loadSource.mockClear(); compactionPort.recordStarted.mockClear(); compactionPort.recordFailed.mockClear()
    startedItemIds.length = 0; publishedItemIds.length = 0
    compactionPort.publishAtomically.mockReset()
      .mockImplementationOnce(async input => { publishedItemIds.push(input.startedItem.id); throw new Error("transient publish failure") })
      .mockImplementationOnce(async input => {
        publishedItemIds.push(input.startedItem.id)
        return { id: "snapshot-2", sessionId: "session-1", throughSequence: 100n, version: 2 }
      })

    const first = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner, lease, model: model(), signal: new AbortController().signal,
    })
    const retryLease: TurnLease = { ...lease, leaseVersion: lease.leaseVersion + 1 }
    const retryOwner: TurnExecutionOwnerFence = { ...owner, leaseVersion: owner.leaseVersion + 1 }
    const retried = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner: retryOwner, lease: retryLease, model: model(), signal: new AbortController().signal,
    })

    expect(first.status).toBe("failed")
    expect(retried.status).toBe("compacted")
    expect(compactionPort.recordFailed).toHaveBeenCalledOnce()
    expect(startedItemIds).toEqual(["context-compaction:turn-1:2:100", "context-compaction:turn-1:3:100"])
    expect(publishedItemIds).toEqual(["context-compaction:turn-1:2:100", "context-compaction:turn-1:3:100"])
  })

  it("does not summarize or publish the committed cursor again after a new lease restart", async () => {
    const priorSummary: CompactionSource = {
      ...itemThresholdSource,
      items: [{
        id: "context-compaction-summary:snapshot-2", sessionId: "session-1", turnId: "turn-1", sequence: 100n,
        type: "compaction_summary", status: "completed", content: "Previous narrative summary",
      }],
    }
    loadSource.mockReset().mockResolvedValueOnce(itemThresholdSource).mockResolvedValueOnce(priorSummary)
    compactionPort.recordStarted.mockClear(); compactionPort.recordFailed.mockClear()
    compactionPort.publishAtomically.mockReset().mockImplementation(async input => {
      publishedItemIds.push(input.startedItem.id)
      return { id: "snapshot-2", sessionId: "session-1", throughSequence: 100n, version: 2 }
    })
    startedItemIds.length = 0; publishedItemIds.length = 0
    const requests: HarnessModelRequest[] = []

    const first = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner, lease, model: model(undefined, requests), signal: new AbortController().signal,
    })
    const retryLease: TurnLease = { ...lease, leaseVersion: lease.leaseVersion + 1 }
    const retryOwner: TurnExecutionOwnerFence = { ...owner, leaseVersion: owner.leaseVersion + 1 }
    const restarted = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner: retryOwner, lease: retryLease, model: model(undefined, requests), signal: new AbortController().signal,
    })

    expect(first.status).toBe("compacted")
    expect(restarted.status).toBe("skipped")
    expect(requests).toHaveLength(1)
    expect(compactionPort.recordStarted).toHaveBeenCalledOnce()
    expect(compactionPort.publishAtomically).toHaveBeenCalledOnce()
    expect(startedItemIds).toEqual(["context-compaction:turn-1:2:100"])
    expect(publishedItemIds).toEqual(["context-compaction:turn-1:2:100"])
  })

  it("keeps the prior summary when a real post-cursor tail needs compaction", async () => {
    const sourceWithTail: CompactionSource = {
      ...source,
      state: { ...source.state, throughSequence: 110n },
      items: [
        { id: "context-compaction-summary:snapshot-2", sessionId: "session-1", turnId: "turn-1", sequence: 100n, type: "compaction_summary", status: "completed", content: "Prior narrative summary" },
        { id: "fresh-tail", sessionId: "session-1", turnId: "turn-1", sequence: 110n, type: "agent_message", status: "completed", content: "Fresh tail sentinel ".repeat(2_400) },
      ],
    }
    loadSource.mockReset().mockResolvedValue(sourceWithTail)
    compactionPort.recordStarted.mockClear(); compactionPort.publishAtomically.mockClear()
    startedItemIds.length = 0; publishedItemIds.length = 0
    const requests: HarnessModelRequest[] = []

    const result = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner, lease, model: model(undefined, requests), signal: new AbortController().signal,
    })
    const narrative = requests[0]?.messages[1]?.content[0]

    expect(result.status).toBe("compacted")
    expect(narrative).toMatchObject({ type: "text" })
    if (narrative?.type === "text") {
      expect(narrative.text).toContain("Prior narrative summary")
      expect(narrative.text).toContain("Fresh tail sentinel")
      expect(narrative.text.split("Prior narrative summary")).toHaveLength(2)
      expect(narrative.text.split("Fresh tail sentinel").length).toBeGreaterThan(2)
    }
    expect(compactionPort.publishAtomically).toHaveBeenCalledOnce()
    expect(publishedItemIds).toEqual(["context-compaction:turn-1:2:110"])
  })

  it("skips an empty source tail", async () => {
    loadSource.mockReset().mockResolvedValue({ ...source, items: [] })
    compactionPort.recordStarted.mockClear(); compactionPort.publishAtomically.mockClear()
    const requests: HarnessModelRequest[] = []

    const result = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner, lease, model: model(undefined, requests), signal: new AbortController().signal,
    })

    expect(result.status).toBe("skipped")
    expect(requests).toHaveLength(0)
    expect(compactionPort.recordStarted).not.toHaveBeenCalled()
    expect(compactionPort.publishAtomically).not.toHaveBeenCalled()
  })
})
