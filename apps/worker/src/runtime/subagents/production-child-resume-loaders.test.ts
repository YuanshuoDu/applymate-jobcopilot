import { beforeEach, describe, expect, it, vi } from "vitest"

const calls = vi.hoisted(() => ({ order: [] as string[], wait: { waitId: "wait-1" }, restored: { durableWait: { waitId: "wait-1" } } }))
vi.mock("./child-resume-consumed-wait-repair.js", () => ({
  repairConsumedChildWaitSources: vi.fn(async () => { calls.order.push("repair") }),
}))
vi.mock("./durable-subagent-wait-resume.js", () => ({
  loadDurableSubagentWaitResume: vi.fn(async () => { calls.order.push("pending"); return calls.wait }),
}))
vi.mock("./child-resume.js", () => ({
  loadChildAttemptResume: vi.fn(async () => { calls.order.push("resume"); return calls.restored }),
}))
vi.mock("./child-mailbox-continuation.js", () => ({
  loadChildSameAttemptContinuation: vi.fn(async () => { calls.order.push("mailbox"); return { previousFinalText: "saved" } }),
}))

import { createProductionChildResumeLoaders } from "./production-child-resume-loaders.js"

describe("production child resume loader ordering", () => {
  beforeEach(() => { calls.order.length = 0 })

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
})
