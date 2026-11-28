import { beforeEach, describe, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({ order: [] as string[], wait: { waitId: "wait-1" }, restored: { durableWait: { waitId: "wait-1" } }, resumeFailure: undefined as unknown }))
vi.mock("./child-resume-consumed-wait-repair.js", () => ({
  repairConsumedChildWaitSources: vi.fn(async () => { calls.order.push("repair") }),
}))
vi.mock("./durable-subagent-wait-resume.js", () => ({
  loadDurableSubagentWaitResume: vi.fn(async () => { calls.order.push("pending"); return calls.wait }),
}))
vi.mock("./child-resume.js", () => ({
  loadChildAttemptResume: vi.fn(async () => {
    calls.order.push("resume")
    if (calls.resumeFailure !== undefined) throw calls.resumeFailure
    return calls.restored
  }),
}))
vi.mock("./child-mailbox-continuation.js", () => ({
  loadChildSameAttemptContinuation: vi.fn(async () => { calls.order.push("mailbox"); return { previousFinalText: "saved" } }),
}))

import { createProductionChildResumeLoaders } from "./production-child-resume-loaders.js"
import { repairConsumedChildWaitSources } from "./child-resume-consumed-wait-repair.js"

describe("production child resume loader ordering", () => {
  beforeEach(() => { calls.order.length = 0; calls.resumeFailure = undefined })

  it("repairs historical consumed sources before the ordinary resume readers", async () => {
    const loaders = createProductionChildResumeLoaders({ connect: vi.fn() } as never)
    const lease = { id: "child-1" } as never
    await expect(loaders.resumeLoader?.(lease)).resolves.toEqual(calls.restored)
    expect(calls.order).toEqual(["repair", "pending", "resume"])
  })

  it("repairs historical consumed sources before same-attempt mailbox reads", async () => {
    const loaders = createProductionChildResumeLoaders({ connect: vi.fn() } as never)
    const lease = { id: "child-1" } as never
    await expect(loaders.sameAttemptContinuationLoader?.(lease)).resolves.toMatchObject({ previousFinalText: "saved" })
    expect(calls.order).toEqual(["repair", "mailbox"])
  })

  it("keeps the original failure when the bounded resume observer throws", async () => {
    const original = Object.assign(new Error("private wait text"), {
      code: "wait_scope_error", resumeValidationStage: "source_call_count", taskId: "private-task-id",
    })
    vi.mocked(repairConsumedChildWaitSources).mockRejectedValueOnce(original)
    const observer = vi.fn(() => { throw new Error("private observer text") })
    const loaders = createProductionChildResumeLoaders({ connect: vi.fn() } as never, observer)

    await expect(loaders.resumeLoader?.({ id: "child-1" } as never)).rejects.toBe(original)
    expect(observer).toHaveBeenCalledWith({
      stage: "repair_consumed_wait_sources", category: "wait_scope_error", validationStage: "source_call_count",
    })
    expect(JSON.stringify(observer.mock.calls)).not.toContain("private")
    expect(JSON.stringify(observer.mock.calls)).not.toContain("taskId")
  })

  it.each([
    ["child_resume_observation_limit", "child_resume_observation_limit"],
    ["child_resume_delegate_receipt_unavailable", "child_resume_delegate_receipt_unavailable"],
    ["child_resume_item_lineage", "child_resume_item_lineage"],
    ["child_resume_invalid_tool_call", "child_resume_invalid_tool_call"],
    ["child_resume_wait_lineage", "child_resume_wait_lineage"],
    ["child_resume_tool_call_conflict", "child_resume_tool_call_conflict"],
    ["child_resume_tool_item_conflict", "child_resume_tool_item_conflict"],
    ["child_resume_tool_result_conflict", "child_resume_tool_result_conflict"],
    ["child_resume_invalid_dynamic_key", "child_resume_invalid_shape"],
  ] as const)("classifies fixed history failure %s without exposing its error text", async (message, category) => {
    calls.resumeFailure = new Error(message)
    const observer = vi.fn()
    const loaders = createProductionChildResumeLoaders({ connect: vi.fn() } as never, observer)

    await expect(loaders.resumeLoader?.({ id: "child-1" } as never)).rejects.toThrow(message)
    expect(observer).toHaveBeenCalledWith({ stage: "load_attempt_history", category, validationStage: null })
    expect(observer.mock.calls).toEqual([[{ stage: "load_attempt_history", category, validationStage: null }]])
  })

  it("keeps unknown history failures in the closed other category", async () => {
    calls.resumeFailure = new Error("private provider response")
    const observer = vi.fn()
    const loaders = createProductionChildResumeLoaders({ connect: vi.fn() } as never, observer)

    await expect(loaders.resumeLoader?.({ id: "child-1" } as never)).rejects.toThrow("private provider response")
    expect(observer).toHaveBeenCalledWith({ stage: "load_attempt_history", category: "other", validationStage: null })
    expect(JSON.stringify(observer.mock.calls)).not.toContain("private")
  })
})
