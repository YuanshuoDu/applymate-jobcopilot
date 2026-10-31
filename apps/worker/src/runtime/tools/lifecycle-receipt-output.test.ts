import { describe, expect, it } from "vitest"

import type { ToolResultChunk } from "./tool-result-reference-types.js"
import {
  hasNativeCoordinationEnvelope, prepareOwnerScopedWaitLifecycleOutput, prepareResolvedOwnerWaitLifecycleOutput, prepareVerifiedToolResultChunk,
} from "./lifecycle-receipt-output.js"

function validWaitOutput(waitId: string) {
  const taskId = "subagent-12345678-1234-4234-9234-123456789012"
  return {
    waitId, status: "ready", taskIds: [taskId], deadlineAt: "2026-10-04T12:00:00.000Z", matchedTaskIds: [taskId],
    tasks: [{ taskId, status: "completed", role: "scout", result: { finding: "safe" }, failureReason: null }],
  }
}

function validChunk(): ToolResultChunk {
  return Object.freeze({
    ref: "tool-result-12345678-1234-4234-9234-123456789012",
    sha256: "a".repeat(64), byteCount: 4, chunk: "safe", nextCursor: null,
  })
}

function expectErrorCode(operation: () => unknown, code: string): void {
  let error: unknown
  try { operation() } catch (caught) { error = caught }
  expect(error).toMatchObject({ code })
}

describe("lifecycle receipt output preparation", () => {
  it("preserves only wait IDs admitted by the resolved owner kind", () => {
    const uuid = "12345678-1234-4234-9234-123456789012"
    expect(prepareOwnerScopedWaitLifecycleOutput(validWaitOutput(uuid), "wait_subagents", "task").safe)
      .toMatchObject({ waitId: uuid })
    expect(prepareOwnerScopedWaitLifecycleOutput(validWaitOutput(`wait-${uuid}`), "wait_subagents", "turn").safe)
      .toMatchObject({ waitId: `wait-${uuid}` })
    expect(() => prepareOwnerScopedWaitLifecycleOutput(validWaitOutput(uuid), "wait_subagents", "turn"))
      .toThrow("durable_wait_receipt_invalid")
    expect(() => prepareOwnerScopedWaitLifecycleOutput(validWaitOutput(`wait-${uuid}`), "agent.wait", "task"))
      .toThrow("durable_wait_receipt_invalid")
    expectErrorCode(() => prepareResolvedOwnerWaitLifecycleOutput(validWaitOutput(`wait-${uuid}`), "agent.wait", () => undefined), "durable_wait_receipt_invalid")
    expectErrorCode(() => prepareResolvedOwnerWaitLifecycleOutput(validWaitOutput(`wait-${uuid}`), "agent.wait", () => { throw new Error("owner unavailable") }), "durable_wait_receipt_invalid")
  })

  it("prepares only exact, frozen verified tool-result chunk shapes", () => {
    expect(prepareVerifiedToolResultChunk(validChunk())?.safe).toEqual({
      ref: "tool-result-12345678-1234-4234-9234-123456789012",
      sha256: "a".repeat(64), byteCount: 4, chunk: "safe", nextCursor: null,
    })
    expect(prepareVerifiedToolResultChunk({ ...validChunk() })).toBeNull()
    expect(prepareVerifiedToolResultChunk(Object.freeze({ ...validChunk(), extra: true }) as unknown as ToolResultChunk)).toBeNull()
    expect(prepareVerifiedToolResultChunk(Object.freeze({ ...validChunk(), nextCursor: "01" }) as ToolResultChunk)).toBeNull()
  })

  it("detects native coordination only through an own object field", () => {
    expect(hasNativeCoordinationEnvelope({ nativeCoordination: {} })).toBe(true)
    expect(hasNativeCoordinationEnvelope(Object.create({ nativeCoordination: {} }))).toBe(false)
    expect(hasNativeCoordinationEnvelope(null)).toBe(false)
    expect(hasNativeCoordinationEnvelope([])).toBe(false)
  })
})
