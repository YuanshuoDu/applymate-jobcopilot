import { beforeEach, describe, expect, it, vi } from "vitest"

const { prepareTransition, loadGraph, specializedEnvelope } = vi.hoisted(() => ({
  prepareTransition: vi.fn(),
  loadGraph: vi.fn(),
  specializedEnvelope: vi.fn(),
}))

vi.mock("./task-graph-pg-lifecycle.js", () => ({ prepareGraphTransition: prepareTransition }))
vi.mock("./task-graph-pg-state.js", () => ({ loadTaskGraph: loadGraph }))
vi.mock("./task-graph-pg-specialized-envelope.js", () => ({ isScheduledTaskGraphSpecializedEnvelope: specializedEnvelope }))

import { prepareScheduledPostGateFinish } from "./pg-scheduled-post-gate-lifecycle.js"
import { SCHEDULED_POST_GATE_AUDIT_ROLE, SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_ROLE, SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID } from "./scheduled-post-gate-contract.js"

describe("prepareScheduledPostGateFinish", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it("fails a completed Execute task closed when its persisted graph is unavailable", async () => {
    const failedGraph = { event: { type: "task.failed" } }
    prepareTransition.mockResolvedValue(failedGraph)
    const finalize = vi.fn((value: unknown, status: string) => ({ value, status }))

    const result = await prepareScheduledPostGateFinish({} as never, null, undefined, {
      taskId: "execute-task", sessionId: "session-1", attemptCount: 1,
      taskRole: "executor", taskType: "scheduled_taskgraph_execute", status: "completed",
    }, { queued: [], failed: [] }, finalize)

    expect(result).toMatchObject({
      graph: failedGraph, status: "failed", failureReason: "scheduled_post_gate_execute_result_invalid",
      result: { value: { queued: [], failed: [] }, status: "failed" },
    })
    expect(prepareTransition).toHaveBeenCalledWith(expect.anything(), {
      taskId: "execute-task", sessionId: "session-1", type: "task.failed", attemptCount: 1,
      failureReason: "scheduled_post_gate_execute_result_invalid",
    })
    expect(loadGraph).not.toHaveBeenCalled()
  })

  it.each([
    { kind: "execute" as const, templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID,
      role: SCHEDULED_POST_GATE_EXECUTE_ROLE, taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE },
    { kind: "audit" as const, templateId: SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
      role: SCHEDULED_POST_GATE_AUDIT_ROLE, taskType: SCHEDULED_POST_GATE_AUDIT_TASK_TYPE },
  ])("keeps the validated scheduled post-Gate $kind result at its current attempt", async ({ kind, templateId, role, taskType }) => {
    const taskId = `${kind}-task`, node = { key: templateId, templateId, taskId, verificationDisposition: "specialized" }
    const graph = { scope: { rootTaskId: "root-1" }, event: { type: "task.completed" } }
    const task = { id: taskId, status: "running", attemptCount: 2 }
    loadGraph.mockResolvedValue({ snapshot: { nodes: [node] }, tasks: new Map([[taskId, task]]) })
    specializedEnvelope.mockReturnValue(kind)
    const resultEnvelope = { finalItemId: null, finalText: "", status: "completed", stepCount: 0, toolCallCount: 0,
      taskGraphVerificationReport: null, structuredResult: kind === "execute" ? { queued: [], failed: [] } : {
        processed: 0, applied: 0, queued: 0, pending: 0, skipped: 0, failed: 0, durationMs: 0,
      } }
    const finalize = vi.fn((value: unknown) => value)

    await expect(prepareScheduledPostGateFinish({} as never, graph as never, node as never, {
      taskId, sessionId: "session-1", attemptCount: 2, taskRole: role, taskType, status: "completed",
    }, resultEnvelope, finalize)).resolves.toEqual({ graph, status: "completed", result: resultEnvelope, reconcileDependents: true })
    expect(loadGraph).toHaveBeenCalledWith(expect.anything(), graph.scope, true)
    expect(specializedEnvelope).toHaveBeenCalledOnce()
    expect(finalize).toHaveBeenCalledWith(resultEnvelope, "completed")
  })

  it("rejects a stale completed child attempt before trusting its specialized envelope", async () => {
    const failedGraph = { event: { type: "task.failed" } }
    prepareTransition.mockResolvedValue(failedGraph)
    loadGraph.mockResolvedValue({ snapshot: { nodes: [{ key: "execute", templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID,
      taskId: "execute-task", verificationDisposition: "specialized" }] },
      tasks: new Map([["execute-task", { id: "execute-task", status: "running", attemptCount: 2 }]]) })
    const finalize = vi.fn((value: unknown, status: string) => ({ value, status }))
    const result = await prepareScheduledPostGateFinish({} as never, { scope: { rootTaskId: "root-1" } } as never,
      { key: "execute", templateId: SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, taskId: "execute-task",
        verificationDisposition: "specialized" } as never,
      { taskId: "execute-task", sessionId: "session-1", attemptCount: 1, taskRole: SCHEDULED_POST_GATE_EXECUTE_ROLE,
        taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, status: "completed" }, { queued: [], failed: [] }, finalize)

    expect(result).toMatchObject({ status: "failed", failureReason: "scheduled_post_gate_execute_result_invalid" })
    expect(specializedEnvelope).not.toHaveBeenCalled()
    expect(prepareTransition).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      taskId: "execute-task", type: "task.failed", attemptCount: 1,
    }))
  })

  it("leaves unrelated task completions to the existing lifecycle", async () => {
    const finalize = vi.fn((value: unknown) => value)
    const result = await prepareScheduledPostGateFinish({} as never, null, undefined, {
      taskId: "ordinary-task", sessionId: "session-1", attemptCount: 1, taskType: "job_discovery", status: "completed",
    }, { findings: [] }, finalize)

    expect(result).toBeNull()
    expect(prepareTransition).not.toHaveBeenCalled()
    expect(loadGraph).not.toHaveBeenCalled()
  })
})
