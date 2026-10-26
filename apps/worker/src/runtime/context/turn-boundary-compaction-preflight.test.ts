import { describe, expect, it, vi } from "vitest"
import type { HarnessModelRequest, ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import type pg from "pg"
import type { CompactionItemRecord, CompactionSource } from "./context-compaction-types.js"
import type { TurnExecutionOwnerFence } from "../execution-owner.js"
import type { TurnLease } from "../turns/lease.js"
import type { CanonicalTurnState } from "../canonical-turn-state.js"
import { projectSelectedJobMemory } from "./selected-job-memory.js"
import { collectCompactionState } from "./context-compaction-collector.js"
import { estimateDiscoveryPersonaContextTokens, estimateMaximumDiscoveryPersonaContextTokens } from "./discovery-persona-context-blocks.js"

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
const compactionSourceCalls: unknown[][] = []
const publishedItemIds: string[] = []
const startedItemIds: string[] = []
const compactionPort = {
  loadLatest: vi.fn(async (): Promise<{ id: string; sessionId: string; throughSequence: bigint; version: number } | null> => null),
  recordStarted: vi.fn(async (item: CompactionItemRecord) => { startedItemIds.push(item.id) }),
  publishAtomically: vi.fn(async (input: { startedItem: { id: string }; draft: { state: { throughSequence: bigint } } }) => {
    publishedItemIds.push(input.startedItem.id)
    return { id: "snapshot-2", sessionId: "session-1", throughSequence: input.draft.state.throughSequence, version: 2 }
  }),
  recordFailed: vi.fn(async () => undefined),
}

vi.mock("./context-compaction-pg-source.js", () => ({ createPgCompactionSource: (...args: unknown[]) => {
  compactionSourceCalls.push(args)
  return { load: loadSource }
} }))
vi.mock("./context-snapshot-compaction-pg.js", () => ({ createPgContextSnapshotCompactionPort: () => compactionPort }))

import { createTurnBoundaryMemoryPreflight, runTurnBoundaryCompactionPreflight, runTurnBoundaryContextCompaction } from "./turn-boundary-compaction-preflight.js"
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

const selectedJobMemory = projectSelectedJobMemory({
  jobId: "job-1", sourceTurnId: "turn-1", sourceRootTaskId: "root-1", throughSequence: "100",
  graph: { revision: 2, nodes: [{ key: "scout-key", taskId: "scout-task", templateId: "scout", status: "completed", readiness: "terminal" }] },
})
if (!selectedJobMemory) throw new Error("Invalid selected-job memory fixture")
const itemThresholdSourceWithMemory: CompactionSource = {
  ...itemThresholdSource,
  state: { ...itemThresholdSource.state, selectedJobMemories: [selectedJobMemory] },
}

function historyAtInputTokens(tokens: number): CompactionSource {
  const targetCharacters = tokens * 4
  const firstPrefix = "[100] agent_message "
  const secondPrefix = "[101] agent_message "
  const firstRenderedLength = 20_000
  const secondContentLength = targetCharacters - firstRenderedLength - 1 - secondPrefix.length
  return {
    ...source,
    items: [
      { id: "large-history-1", sessionId: "session-1", turnId: "turn-1", sequence: 100n,
        type: "agent_message", status: "completed", content: "x".repeat(firstRenderedLength - firstPrefix.length) },
      { id: "large-history-2", sessionId: "session-1", turnId: "turn-1", sequence: 101n,
        type: "agent_message", status: "completed", content: "y".repeat(secondContentLength) },
    ],
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
  it("uses accepted discovery memory size when wiring boundary compaction", async () => {
    const readMemory = vi.fn(async () => ({ kind: "accepted" as const, estimatedTokens: 37 }))
    const runner = vi.fn(async () => ({ status: "compacted" }))
    const preflight = createTurnBoundaryMemoryPreflight({
      enabled: true, signal: new AbortController().signal,
      pool: { connect: vi.fn() } as unknown as Pick<pg.Pool, "connect">,
      scope: { userId: "user-1" }, owner, lease, rootTaskId: "root-1", rootAttemptCount: 1,
      discoveryPersonaMemoryEnabled: true, model: model(), runner, readMemory, reload: async () => state(),
    })

    await expect(preflight.compact()).resolves.toEqual({ status: "compacted" })
    expect(readMemory).toHaveBeenCalledOnce()
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({ additionalInputTokens: 37 }))
  })

  it("uses the bounded reserve only when the discovery snapshot is absent", async () => {
    const readMemory = vi.fn(async () => ({ kind: "absent" as const }))
    const runner = vi.fn(async () => ({ status: "compacted" }))
    const preflight = createTurnBoundaryMemoryPreflight({
      enabled: true, signal: new AbortController().signal,
      pool: { connect: vi.fn() } as unknown as Pick<pg.Pool, "connect">,
      scope: { userId: "user-1" }, owner, lease, rootTaskId: "root-1", rootAttemptCount: 1,
      discoveryPersonaMemoryEnabled: true, model: model(), runner, readMemory, reload: async () => state(),
    })

    await preflight.compact()
    expect(runner).toHaveBeenCalledWith(expect.objectContaining({
      additionalInputTokens: estimateMaximumDiscoveryPersonaContextTokens(),
    }))
  })

  it("keeps overflow fail-closed and avoids memory reads when ineligible", async () => {
    const overflowRead = vi.fn(async () => ({ kind: "overflow" as const }))
    const skippedRunner = vi.fn(async () => ({ status: "compacted" }))
    const overflow = createTurnBoundaryMemoryPreflight({
      enabled: true, signal: new AbortController().signal,
      pool: { connect: vi.fn() } as unknown as Pick<pg.Pool, "connect">,
      scope: { userId: "user-1" }, owner, lease, rootTaskId: "root-1", rootAttemptCount: 1,
      discoveryPersonaMemoryEnabled: true, model: model(), runner: skippedRunner, readMemory: overflowRead, reload: async () => state(),
    })
    await expect(overflow.compact()).resolves.toEqual({ status: "skipped" })
    expect(skippedRunner).not.toHaveBeenCalled()

    const ineligibleRead = vi.fn(async () => ({ kind: "accepted" as const, estimatedTokens: 37 }))
    const ineligibleRunner = vi.fn(async () => ({ status: "compacted" }))
    const ineligible = createTurnBoundaryMemoryPreflight({
      enabled: true, signal: new AbortController().signal,
      pool: { connect: vi.fn() } as unknown as Pick<pg.Pool, "connect">,
      scope: { userId: "user-1" }, owner, lease, rootTaskId: "root-1", rootAttemptCount: 1,
      discoveryPersonaMemoryEnabled: false, model: model(), runner: ineligibleRunner, readMemory: ineligibleRead, reload: async () => state(),
    })
    await ineligible.compact()
    expect(ineligibleRead).not.toHaveBeenCalled()
    expect(ineligibleRunner).toHaveBeenCalledWith(expect.not.objectContaining({ additionalInputTokens: expect.anything() }))
  })

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
    loadSource.mockReset().mockResolvedValueOnce(itemThresholdSource).mockResolvedValueOnce(itemThresholdSourceWithMemory)
    compactionSourceCalls.length = 0
    publishedItemIds.length = 0; startedItemIds.length = 0
    const requests: HarnessModelRequest[] = []
    const pool = { connect: vi.fn() }
    const taskGraphCommandPort = { readCurrent: vi.fn(), readCurrentWithClient: vi.fn() }
    const result = await runTurnBoundaryContextCompaction({
      pool, scope: { userId: "user-1" }, owner, lease, taskGraphCommandPort: taskGraphCommandPort as never,
      model: model(undefined, requests), signal: new AbortController().signal,
    })
    expect(result).toMatchObject({ status: "compacted", trigger: { reason: "item_count" } })
    expect(loadSource).toHaveBeenCalledWith({ scope: { userId: "user-1" }, owner })
    expect(compactionSourceCalls).toEqual([[pool], [pool, taskGraphCommandPort]])
    expect(requests).toHaveLength(1)
    expect(compactionPort.recordStarted).toHaveBeenCalledOnce()
    expect(compactionPort.publishAtomically).toHaveBeenCalledOnce()
    expect(publishedItemIds).toEqual(["context-compaction:turn-1:2:100"])
    expect(compactionPort.publishAtomically).toHaveBeenCalledWith(expect.objectContaining({
      draft: expect.objectContaining({ state: expect.objectContaining({ selectedJobMemories: [selectedJobMemory] }) }),
    }))
    expect(createPgContextSnapshotCompactionPort).toBeDefined()
  })

  it("does not summarize or publish nonempty history below both thresholds", async () => {
    loadSource.mockReset().mockResolvedValue(source)
    compactionSourceCalls.length = 0
    compactionPort.loadLatest.mockClear(); compactionPort.recordStarted.mockClear()
    compactionPort.publishAtomically.mockClear(); compactionPort.recordFailed.mockClear()
    publishedItemIds.length = 0; startedItemIds.length = 0
    const requests: HarnessModelRequest[] = []
    const pool = { connect: vi.fn() }
    const taskGraphCommandPort = { readCurrent: vi.fn(), readCurrentWithClient: vi.fn() }

    const result = await runTurnBoundaryContextCompaction({
      pool, scope: { userId: "user-1" }, owner, lease, taskGraphCommandPort: taskGraphCommandPort as never,
      model: model(undefined, requests), signal: new AbortController().signal,
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
    expect(compactionSourceCalls).toEqual([[pool]])
    expect(taskGraphCommandPort.readCurrent).not.toHaveBeenCalled()
    expect(taskGraphCommandPort.readCurrentWithClient).not.toHaveBeenCalled()
  })

  it("adds the actual discovery-memory reserve only to the input-token threshold", async () => {
    const history = historyAtInputTokens(11_990)
    expect(collectCompactionState(history).beforeInputTokens).toBe(11_990)
    expect(history.items).toHaveLength(2)
    const projection = {
      schemaVersion: "applymate.discovery-persona-projection.v1", purpose: "discovery",
      facts: [{ factId: "fact-1", key: "preferred_location", label: "Preferred location", category: "preferences",
        source: "manual", value: "Dublin", normalizedValue: "dublin", updatedAt: "2026-10-24T12:00:00.000Z" }],
    } as const
    const reserve = estimateDiscoveryPersonaContextTokens(projection)
    expect(estimateMaximumDiscoveryPersonaContextTokens()).toBeGreaterThanOrEqual(reserve)
    expect(11_990 + reserve).toBeGreaterThanOrEqual(12_000)

    loadSource.mockReset().mockResolvedValue(history)
    compactionSourceCalls.length = 0
    compactionPort.loadLatest.mockClear(); compactionPort.recordStarted.mockClear()
    compactionPort.publishAtomically.mockClear(); compactionPort.recordFailed.mockClear()
    const requests: HarnessModelRequest[] = []
    const pool = { connect: vi.fn() }

    const withoutReserve = await runTurnBoundaryContextCompaction({
      pool, scope: { userId: "user-1" }, owner, lease, additionalInputTokens: 0,
      model: model(undefined, requests), signal: new AbortController().signal,
    })
    expect(withoutReserve.status).toBe("skipped")
    if (withoutReserve.status !== "skipped") throw new Error("Expected history alone to stay below the input threshold")
    if (!("trigger" in withoutReserve)) throw new Error("Expected a below-threshold trigger decision")
    expect(withoutReserve.trigger).toEqual({ shouldCompact: false, reason: null })
    expect(requests).toHaveLength(0)

    const withReserve = await runTurnBoundaryContextCompaction({
      pool, scope: { userId: "user-1" }, owner, lease, additionalInputTokens: reserve,
      model: model(undefined, requests), signal: new AbortController().signal,
    })
    expect("trigger" in withReserve ? withReserve.trigger : null).toEqual({ shouldCompact: true, reason: "input_tokens" })
    expect(compactionSourceCalls).toEqual([[pool], [pool]])
    expect(requests).toHaveLength(1)
    const summarizedHistory = requests[0]?.messages[1]?.content[0]
    if (summarizedHistory?.type !== "text") throw new Error("Expected history-only narrative input")
    expect(summarizedHistory.text).not.toContain("Dublin")
    expect(summarizedHistory.text).not.toContain("confirmed_persona_facts")
    expect(compactionPort.recordStarted).toHaveBeenCalledOnce()
    expect(compactionPort.recordStarted).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ reason: "input_tokens", sourceItemCount: 2 }),
    }), { userId: "user-1" })
    expect(compactionPort.publishAtomically).toHaveBeenCalledOnce()
    expect(compactionPort.recordFailed).not.toHaveBeenCalled()
  })

  it.each([-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.MAX_SAFE_INTEGER])("fails closed for invalid additional input tokens: %s", async additionalInputTokens => {
    loadSource.mockReset().mockResolvedValue(source)
    compactionPort.recordStarted.mockClear(); compactionPort.publishAtomically.mockClear()
    compactionPort.recordFailed.mockClear()
    const requests: HarnessModelRequest[] = []
    await expect(runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner, lease, additionalInputTokens,
      model: model(undefined, requests), signal: new AbortController().signal,
    })).rejects.toThrow(additionalInputTokens === Number.MAX_SAFE_INTEGER
      ? "input token estimate exceeds the safe integer range"
      : "additionalInputTokens must be a non-negative safe integer")
    expect(requests).toHaveLength(0)
    expect(compactionPort.recordStarted).not.toHaveBeenCalled()
    expect(compactionPort.publishAtomically).not.toHaveBeenCalled()
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
      state: { ...source.state, throughSequence: 199n },
      items: [
        { id: "context-compaction-summary:snapshot-prior", sessionId: "session-1", turnId: "turn-1", sequence: 100n, type: "compaction_summary", status: "completed", content: "Prior narrative summary" },
        ...Array.from({ length: 99 }, (_, index) => ({
          id: `fresh-tail-${index + 1}`, sessionId: "session-1", turnId: "turn-1", sequence: BigInt(index + 101),
          type: "agent_message", status: "completed", content: `Fresh tail sentinel ${index + 1} ${"x".repeat(280)}`,
        })),
      ],
    }
    loadSource.mockReset().mockResolvedValue(sourceWithTail)
    compactionPort.loadLatest.mockReset().mockResolvedValue(null).mockResolvedValueOnce({ id: "snapshot-prior", sessionId: "session-1", throughSequence: 100n, version: 1 })
    compactionPort.publishAtomically.mockReset().mockImplementation(async input => {
      publishedItemIds.push(input.startedItem.id)
      return { id: "snapshot-2", sessionId: "session-1", throughSequence: input.draft.state.throughSequence, version: 2 }
    })
    compactionPort.recordStarted.mockClear()
    startedItemIds.length = 0; publishedItemIds.length = 0
    const requests: HarnessModelRequest[] = []

    const result = await runTurnBoundaryContextCompaction({
      pool: { connect: vi.fn() }, scope: { userId: "user-1" }, owner, lease, model: model(undefined, requests), signal: new AbortController().signal,
    })
    const narrative = requests[0]?.messages[1]?.content[0]

    expect(result).toMatchObject({ status: "compacted", trigger: { reason: "item_count" } })
    expect(narrative).toMatchObject({ type: "text" })
    if (narrative?.type === "text") {
      expect(narrative.text).toContain("Prior narrative summary")
      expect(narrative.text).toContain("Fresh tail sentinel")
      expect(narrative.text.split("Prior narrative summary")).toHaveLength(2)
      expect(narrative.text.split("Fresh tail sentinel").length).toBeGreaterThan(2)
    }
    const published = (compactionPort.publishAtomically as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      draft: { sourceItemIds: readonly string[]; state: { throughSequence: bigint } }
    }
    expect(published.draft.sourceItemIds.length).toBeLessThan(100)
    expect(published.draft.state.throughSequence).toBeGreaterThan(100n)
    expect(published.draft.state.throughSequence).toBeLessThan(sourceWithTail.state.throughSequence)
    if (result.status !== "compacted") throw new Error("Expected the preflight compaction to publish a snapshot")
    expect(result.snapshot?.throughSequence).toBe(published.draft.state.throughSequence)
    expect(published.draft.sourceItemIds).toEqual(sourceWithTail.items
      .filter(item => item.sequence <= published.draft.state.throughSequence).map(({ id }) => id))
    expect(compactionPort.publishAtomically).toHaveBeenCalledOnce()
    expect(publishedItemIds).toEqual(["context-compaction:turn-1:2:199"])
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
