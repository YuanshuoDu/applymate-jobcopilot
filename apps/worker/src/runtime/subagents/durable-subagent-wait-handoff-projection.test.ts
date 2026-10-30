import { describe, expect, it } from "vitest"
import type { DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"
import { safeHandoffWaitResult } from "./durable-subagent-wait-handoff-projection.js"

const targetId = "subagent-00000000-0000-4000-8000-000000000000"
const outcome: DurableSubagentWaitResult = {
  waitId: "wait-1", status: "waiting", taskIds: [targetId], deadlineAt: "2026-10-30T10:00:00.000Z",
  matchedTaskIds: [], tasks: [{ taskId: targetId, status: "running", role: "writer", result: null, failureReason: null }],
}

describe("safeHandoffWaitResult", () => {
  it("preserves validated phone-shaped request IDs and still redacts ordinary prose", () => {
    const safe = safeHandoffWaitResult({
      request: { mode: "any", targetTaskIds: [targetId], timeoutMs: 30_000 },
      note: "Call +353 87 123 4567 or email private@example.test.",
    }, outcome, [targetId]) as { request: { targetTaskIds: string[] }; outcome: DurableSubagentWaitResult; note: string }

    expect(safe.request.targetTaskIds).toEqual([targetId])
    expect(safe.outcome.taskIds).toEqual([targetId])
    expect(safe.note).toContain("[REDACTED_PHONE]")
    expect(safe.note).toContain("[REDACTED_EMAIL]")
    expect(safe.note).not.toContain("+353 87 123 4567")
    expect(safe.note).not.toContain("private@example.test")
  })

  it("fails closed when the persisted request target set differs", () => {
    let error: unknown
    try {
      safeHandoffWaitResult({ request: { mode: "any", targetTaskIds: ["other-child"], timeoutMs: 30_000 } }, outcome, [targetId])
    } catch (caught: unknown) { error = caught }
    expect(error).toMatchObject({ code: "wait_scope_error" })
  })

  it("canonicalizes request order only after validating the exact target set", () => {
    const secondId = "child-2"
    const ids = [targetId, secondId]
    const twoTargets: DurableSubagentWaitResult = {
      ...outcome, taskIds: ids, tasks: [outcome.tasks[0]!, { ...outcome.tasks[0]!, taskId: secondId }],
    }
    const safe = safeHandoffWaitResult({
      request: { mode: "all", targetTaskIds: [secondId, targetId], timeoutMs: 30_000 },
    }, twoTargets, ids) as { request: { targetTaskIds: string[] } }
    expect(safe.request.targetTaskIds).toEqual(ids)
  })
})
