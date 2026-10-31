import { describe, expect, it, vi } from "vitest"

import type { DurableWaitControlInvocation } from "../tools/coordination-types.js"
import type { TurnExecutionIdentity } from "./turn-execution-types.js"
import { archivedWaitInvocation, lookupArchivedWaitControl, parseArchivedWaitReference } from "./durable-wait-control.js"

const waitId = "wait-00000000-0000-4000-8000-000000000001"
const now = new Date("2026-10-11T12:00:00.000Z")
const identity: TurnExecutionIdentity = {
  kind: "turn", userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 4, leaseExpiresAt: new Date("2026-10-11T12:01:00.000Z"),
}
const request = { idempotencyKey: "wait-key", taskIds: ["child-b", "child-a"], mode: "all", timeoutMs: 10_000 }
const reference = { $ref: "tool-result-00000000-0000-4000-8000-000000000002", sizeBytes: 128, sha256: "a".repeat(64) }

function invocation(): DurableWaitControlInvocation {
  return {
    userId: identity.userId, sessionId: identity.sessionId, turnId: identity.turnId, stepId: "step-1",
    taskId: identity.rootTaskId, rootTaskId: identity.rootTaskId, ownerId: identity.ownerId, leaseVersion: identity.leaseVersion ?? 4,
    now, targetTaskIds: ["child-a", "child-b"], mode: "all", timeoutMs: 10_000, idempotencyKey: "wait-key",
  }
}

describe("archived durable wait control", () => {
  it("accepts the exact archived envelope even when a caller uses a smaller inline lifecycle cap", () => {
    expect(parseArchivedWaitReference(reference)).toEqual(reference)
    expect(parseArchivedWaitReference({ ...reference, sizeBytes: 8_191 })).toMatchObject({ sizeBytes: 8_191 })
  })

  it.each([
    ["zero bytes", { ...reference, sizeBytes: 0 }],
    ["oversized bytes", { ...reference, sizeBytes: 1_048_577 }],
    ["extra key", { ...reference, waitId }],
    ["foreign digest", { ...reference, sha256: "z".repeat(64) }],
    ["non-reference object", { status: "waiting" }],
  ])("rejects or ignores %s without widening the envelope", (_label, value) => {
    if (Object.hasOwn(value, "$ref")) expect(() => parseArchivedWaitReference(value)).toThrowError(expect.objectContaining({ code: "invalid_output" }))
    else expect(parseArchivedWaitReference(value)).toBeNull()
  })

  it("rejects accessor and symbol extras", () => {
    const accessor = Object.defineProperty({ ...reference }, "sizeBytes", { enumerable: true, get: () => 128 })
    expect(() => parseArchivedWaitReference(accessor)).toThrowError(expect.objectContaining({ code: "invalid_output" }))
    const symbolExtra = { ...reference, [Symbol("private")]: true }
    expect(() => parseArchivedWaitReference(symbolExtra)).toThrowError(expect.objectContaining({ code: "invalid_output" }))
  })

  it("binds only known wait tools to the exact server-owned invocation", () => {
    expect(archivedWaitInvocation({ toolName: "agent.wait", input: request, stepId: "step-1", identity, now })).toEqual(invocation())
    expect(archivedWaitInvocation({ toolName: "wait_subagents", input: request, stepId: "step-1", identity, now })).toEqual(invocation())
    expect(archivedWaitInvocation({ toolName: "jobs.search", input: request, stepId: "step-1", identity, now })).toBeNull()
    expect(archivedWaitInvocation({ toolName: "agent.wait", input: { ...request, extra: true }, stepId: "step-1", identity, now })).toBeNull()
    expect(archivedWaitInvocation({ toolName: "agent.wait", input: request, stepId: "step-1", identity: { ...identity, taskId: "child-a" }, now })).toBeNull()
  })

  it("reads only a bounded control and fails closed when the fenced reader is absent or invalid", async () => {
    const readByInvocation = vi.fn(async (value: DurableWaitControlInvocation, admission: string) => {
      expect(value).toEqual(invocation())
      expect(admission).toBe("fresh_streaming_root")
      return { waitId, status: "ready" as const }
    })
    await expect(lookupArchivedWaitControl({ toolName: "agent.wait", input: request, stepId: "step-1", output: reference, identity, now,
      reader: { readByInvocation }, stepAdmission: "fresh_streaming_root" })).resolves.toEqual({ waitId, status: "ready" })
    await expect(lookupArchivedWaitControl({ toolName: "wait_subagents", input: request, stepId: "step-1", output: reference, identity, now,
      reader: { readByInvocation }, stepAdmission: "fresh_streaming_root" })).resolves.toEqual({ waitId, status: "ready" })
    expect(readByInvocation).toHaveBeenCalledTimes(2)
    await expect(lookupArchivedWaitControl({ toolName: "agent.wait", input: request, stepId: "step-1", output: reference, identity, now,
      stepAdmission: "fresh_streaming_root" }))
      .rejects.toMatchObject({ code: "persistence_conflict" })
    await expect(lookupArchivedWaitControl({ toolName: "agent.wait", input: request, stepId: "step-1", output: reference, identity, now,
      reader: { readByInvocation: async () => ({ waitId: "foreign", status: "ready" }) }, stepAdmission: "fresh_streaming_root" }))
      .rejects.toMatchObject({ code: "persistence_conflict" })
  })

  it("keeps interrupted archived controls behind canonical-recovery-only opt-in", async () => {
    const readByInvocation = vi.fn(async (_value: DurableWaitControlInvocation, _admission: string) => ({ waitId, status: "interrupted" as const }))
    const reader = { readByInvocation }
    await expect(lookupArchivedWaitControl({ toolName: "agent.wait", input: request, stepId: "step-1", output: reference,
      identity, now, reader, stepAdmission: "fresh_streaming_root", allowInterruptedRecovery: true })).rejects.toMatchObject({ code: "persistence_conflict" })
    await expect(lookupArchivedWaitControl({ toolName: "agent.wait", input: request, stepId: "step-1", output: reference,
      identity, now, reader, stepAdmission: "restored_inflight_root", allowInterruptedRecovery: true })).resolves.toEqual({ waitId, status: "interrupted" })
    expect(readByInvocation).toHaveBeenCalledTimes(2)
    expect(readByInvocation.mock.calls.map(([, admission]) => admission)).toEqual(["fresh_streaming_root", "restored_inflight_root"])
  })
})
