import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TaskGraphExecutionScope } from "../subagents/task-graph-command-port.js"
import type { RootTaskHistoryCandidate } from "./root-task-history-source-store.js"

const historyMocks = vi.hoisted(() => ({
  candidates: vi.fn(),
  fence: vi.fn(),
  graph: vi.fn(),
  client: { query: vi.fn() },
}))

vi.mock("./root-task-history-fence.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./root-task-history-fence.js")>()
  return {
    ...actual,
    readRootTaskHistoryFence: historyMocks.fence,
    withRootTaskHistoryTransaction: async (_pool: unknown, _userId: string, work: (client: typeof historyMocks.client) => Promise<unknown>) =>
      work(historyMocks.client),
  }
})
vi.mock("./root-task-history-source-store.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./root-task-history-source-store.js")>()
  return { ...actual, readRootTaskHistoryCandidates: historyMocks.candidates }
})
vi.mock("../subagents/task-graph-pg-state.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../subagents/task-graph-pg-state.js")>()
  return { ...actual, loadTaskGraph: historyMocks.graph }
})

import { createPgRootTaskHistoryResultPageStore } from "./root-task-history-result-page-store.js"

const scope: TaskGraphExecutionScope = {
  userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root",
  stepId: "step", turnLeaseOwner: "worker", turnLeaseVersion: 2, parentLeaseOwner: "worker", parentAttemptCount: 1,
}

describe("historical discovery result-page store guards", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    historyMocks.fence.mockResolvedValue({ currentStartSequence: 100n, objectiveDigest: "a".repeat(64) })
    historyMocks.candidates.mockResolvedValue([])
    historyMocks.graph.mockResolvedValue({ rootTaskId: "root", item: null, snapshot: null, state: null, tasks: new Map() })
  })

  it("rejects invalid and unbound continuation requests before opening a transaction", async () => {
    const connect = vi.fn()
    const store = createPgRootTaskHistoryResultPageStore({ connect } as unknown as Pick<pg.Pool, "connect">)

    await expect(store.read(scope, { offset: 3 })).rejects.toThrow("task_graph_historical_discovery_request_invalid")
    await expect(store.read(scope, { offset: 25, sourceToken: "a".repeat(64) }))
      .rejects.toThrow("task_graph_historical_discovery_request_invalid")
    expect(connect).not.toHaveBeenCalled()
  })

  it("rejects non-root and owner-mismatched scopes before reading history", async () => {
    const connect = vi.fn()
    const store = createPgRootTaskHistoryResultPageStore({ connect } as unknown as Pick<pg.Pool, "connect">)

    await expect(store.read({ ...scope, parentTaskId: "child" }, { offset: 0 })).rejects.toThrow("task_graph_scope_invalid")
    await expect(store.read({ ...scope, parentLeaseOwner: "different-worker" }, { offset: 0 })).rejects.toThrow("task_graph_scope_invalid")
    expect(connect).not.toHaveBeenCalled()
  })

  it("caps canonical graph reloads at eight even when more bounded roots are returned", async () => {
    const sources: RootTaskHistoryCandidate[] = Array.from({ length: 12 }, (_, index) => ({
      sessionId: "session", turnId: `source-turn-${index}`, rootTaskId: `source-root-${index}`, terminalSequence: BigInt(90 - index),
    }))
    historyMocks.candidates.mockResolvedValue(sources)
    const store = createPgRootTaskHistoryResultPageStore({ connect: vi.fn() } as unknown as Pick<pg.Pool, "connect">)

    const page = await store.read(scope, { offset: 0 })

    expect(page).toMatchObject({ availability: "unavailable", reason: "no_source" })
    expect(historyMocks.candidates).toHaveBeenCalledOnce()
    expect(historyMocks.graph).toHaveBeenCalledTimes(8)
    expect(historyMocks.graph.mock.calls.map(call => call[1].rootTaskId)).toEqual(sources.slice(0, 8).map(source => source.rootTaskId))
  })
})
