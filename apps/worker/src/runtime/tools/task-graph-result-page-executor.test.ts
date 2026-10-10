import { describe, expect, it, vi } from "vitest"
import type { TaskGraphCommandPort, TaskGraphReadScope } from "../subagents/task-graph-command-port.js"
import type { CoordinationExecutorOptions } from "./coordination-executors.js"
import type { ToolExecutionContext } from "./types.js"
import { executeAgentList } from "./task-graph-result-page-executor.js"
import { TASK_GRAPH_RESULT_PAGE_SCHEMA, type TaskGraphResultPage } from "../subagents/task-graph-result-page-contract.js"

const request = { nodeKey: "candidate-node", expectedRevision: 4, offset: 3 }
const jobId = "00000000-0000-4000-8000-000000000000"
const available: TaskGraphResultPage = {
  schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 4,
  role: "analyst", taskStatus: "failed", resultStatus: "partial", totalCount: 4, evidenceCount: 5,
  offset: 3, nextOffset: null, items: [{ jobId, score: 8.5, evidenceKinds: ["job"] }],
}
const unavailable: TaskGraphResultPage = {
  schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "unavailable",
  graphRevision: 5, reason: "revision_mismatch",
}
function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    taskId: "root-1", rootTaskId: "root-1", actorRole: "orchestrator", toolCallId: "call-1",
    signal: new AbortController().signal, capabilities: [], reportProgress: vi.fn(async () => undefined), ...overrides,
  }
}
function options(readPage?: (scope: TaskGraphReadScope, input: typeof request) => Promise<unknown>, enabled = true): CoordinationExecutorOptions {
  const store = { appendActivity: vi.fn(async () => undefined), listTasks: vi.fn(async () => []) }
  const commandPort = { readCurrent: vi.fn(), ...(readPage ? { readCurrentResultPage: vi.fn(readPage) } : {}) }
  return { manager: {} as never, store: store as never,
    nativeCoordination: { enabled, commandPort: commandPort as unknown as TaskGraphCommandPort,
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 7, parentLeaseOwner: "parent-owner", parentAttemptCount: () => 2 } }
}

describe("current TaskGraph result-page executor", () => {
  it("reads only through the server-owned Root lease scope and validates the request cursor", async () => {
    const readPage = vi.fn(async () => available)
    const runtime = options(readPage)
    await expect(executeAgentList(context(), request, runtime)).resolves.toEqual(available)
    const command = runtime.nativeCoordination?.commandPort as TaskGraphCommandPort & { readCurrentResultPage: ReturnType<typeof vi.fn> }
    expect(command.readCurrentResultPage).toHaveBeenCalledWith({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 7, parentLeaseOwner: "parent-owner", parentAttemptCount: 2,
    }, request)
    expect(runtime.store.appendActivity).toHaveBeenCalledWith(expect.objectContaining({
      taskId: null, operation: "agent.list_page", data: { count: 1, revision: 4 },
    }))
  })

  it.each([
    ["disabled planning", { enabled: false }, {}],
    ["child actor", {}, { taskId: "child-1", actorRole: "subagent" }],
    ["non-root task", {}, { taskId: "child-1", rootTaskId: "root-1" }],
    ["wrong actor", {}, { actorRole: "reviewer" }],
  ])("fails closed for %s", async (_name, optionChange, contextChange) => {
    const readPage = vi.fn(async () => available)
    const base = options(readPage)
    const runtime = { ...base, nativeCoordination: { ...base.nativeCoordination!, ...(optionChange as object) } }
    await expect(executeAgentList(context(contextChange as Partial<ToolExecutionContext>), request, runtime))
      .rejects.toMatchObject({ code: "coordination_task_graph_page_unavailable" })
    expect(readPage).not.toHaveBeenCalled()
  })

  it("does not fall back when the page port is absent or page input is malformed", async () => {
    const runtime = options()
    await expect(executeAgentList(context(), request, runtime)).rejects.toMatchObject({ code: "coordination_task_graph_page_unavailable" })
    await expect(executeAgentList(context(), { ...request, taskId: "forged" }, runtime)).rejects.toMatchObject({ code: "coordination_invalid_input" })
    expect(runtime.store.listTasks).not.toHaveBeenCalled()
  })

  it.each([
    ["revision", { ...available, graphRevision: 5 }],
    ["offset", { ...available, offset: 0 }],
  ])("rejects a forged available-page %s", async (_label, page) => {
    await expect(executeAgentList(context(), request, options(async () => page))).rejects.toMatchObject({ code: "coordination_task_graph_page_invalid" })
  })

  it("returns a stale-page envelope with the current revision", async () => {
    await expect(executeAgentList(context(), request, options(async () => unavailable))).resolves.toEqual(unavailable)
  })

  it("keeps the exact legacy empty-input list behavior", async () => {
    const legacyStore = { listTasks: vi.fn(async () => []), appendActivity: vi.fn(async () => undefined) }
    const runtime = { manager: {} as never, store: legacyStore as never }
    await expect(executeAgentList(context({ taskId: undefined, rootTaskId: undefined }), {}, runtime)).resolves.toEqual({ tasks: [] })
    expect(legacyStore.listTasks).toHaveBeenCalledWith({ userId: "user-1", sessionId: "session-1", rootTaskId: undefined, includeTerminal: false })
  })
})