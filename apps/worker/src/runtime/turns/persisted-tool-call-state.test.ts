import { describe, expect, it } from "vitest"
import { restoreToolCallState as restoreSharedToolCallState } from "@jobcopilot/shared/task-graph-tool-receipt-verification"

import { DEPENDENCY_WAIT_BATCH_REJECTION, DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY, DEPENDENCY_WAIT_BATCH_REJECTION_MARKER } from "./dependency-wait-batch-rejection.js"
import { classifyToolCallRecovery } from "./canonical-runtime-tool-recovery.js"
import { restoreToolCallState } from "./persisted-tool-call-state.js"

const rejectedContent = {
  toolCallId: "call-rejected", toolName: "jobs.search", toolVersion: "1", input: { query: "Dublin" },
  [DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY]: DEPENDENCY_WAIT_BATCH_REJECTION_MARKER,
}
function rejectedCall(status: "started" | "interrupted" | "completed") {
  const content = status === "started" ? { ...rejectedContent } : status === "interrupted"
    ? { ...rejectedContent, status, errorCode: "session_pause_requested" }
    : { ...rejectedContent, status: "failed", errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code }
  return { id: "rejected-call-item", stepId: "step-rejected", taskId: "root-rejected", type: "tool_call", status, revision: 1, content }
}
function rejectedEvents(): Array<Record<string, unknown>> {
  return [
    { id: "rejected-start", idempotencyKey: "rejected-start-key", type: "tool_call.started", itemId: "rejected-call-item", correlationId: "call-rejected", taskId: "root-rejected",
      payload: null },
    { id: "rejected-failed", idempotencyKey: "rejected-failed-key", type: "tool_call.failed", itemId: "rejected-call-item", correlationId: "call-rejected", taskId: "root-rejected",
      payload: { toolCallId: "call-rejected", toolName: "jobs.search", status: "failed", errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code, taskId: "root-rejected" } },
  ]
}

function legacyFailure(phase: "failed" | "cancelled" = "failed") {
  const callId = "call-legacy", taskId = "task-legacy", digest = "a".repeat(24), errorCode = phase === "failed" ? "tool_execution_failed" : "cancelled"
  const payload = { toolCallId: callId, toolName: "jobs.search", toolVersion: "1", status: phase, output: { message: "safe diagnostic" }, errorCode }
  return {
    items: [
      { id: "call-row", stepId: "step-legacy", taskId, type: "tool_call", status: "completed", revision: 1,
        content: { toolCallId: callId, toolName: "jobs.search", toolVersion: "1", status: phase, errorCode } },
      { id: "result-row", stepId: "step-legacy", taskId, type: "tool_result", status: "completed", revision: 1,
        content: { toolCallId: callId, output: null, errorCode } },
    ],
    event: {
      id: `tool-lifecycle:task:${taskId}:${callId}:${phase}:${digest}`, type: "tool_call.failed", actor: "subagent",
      taskId, itemId: null, correlationId: callId, causationId: null,
      idempotencyKey: `task:${taskId}:tool-lifecycle:${callId}:${phase}:${digest}`, payload,
    },
  }
}

describe("restoreToolCallState", () => {
  it("turns an internally marked started item into a reconcile receipt before the started event exists", () => {
    const restored = restoreToolCallState([rejectedCall("started")], [])
    expect(restored.pending[0]?.durableResult).toEqual({
      id: "call-rejected", toolName: "jobs.search", toolVersion: "1", status: "failed",
      output: DEPENDENCY_WAIT_BATCH_REJECTION, errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code,
    })
    const classified = classifyToolCallRecovery(restored.pending, () => { throw new Error("must not replay") })
    expect(classified[0]?.action).toBe("reconcile")
  })

  it("reconstructs the fixed output from a failed event before its result item exists", () => {
    const restored = restoreToolCallState([rejectedCall("completed")], rejectedEvents())
    expect(restored.pending[0]?.durableResult).toMatchObject({
      status: "failed", output: DEPENDENCY_WAIT_BATCH_REJECTION, errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code,
    })
    expect(classifyToolCallRecovery(restored.pending, () => { throw new Error("must not replay") })[0]?.action).toBe("reconcile")
  })

  it("accepts recovery-written failures with no original started event", () => {
    const events = rejectedEvents().slice(1)
    events.push({ id: "recovered-failed", idempotencyKey: "recovered-failed-key", type: "tool_call.failed", itemId: "rejected-call-item", correlationId: "call-rejected", taskId: "root-rejected",
      payload: { toolCallId: "call-rejected", toolName: "jobs.search", toolVersion: "1", status: "failed", errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code, taskId: "root-rejected" } })
    const restored = restoreToolCallState([rejectedCall("completed")], events)
    expect(restored.pending[0]?.durableResult).toMatchObject({
      output: DEPENDENCY_WAIT_BATCH_REJECTION, errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code,
    })
  })

  it("preserves no-dispatch recovery after the fixed pause interruption", () => {
    const restored = restoreToolCallState([rejectedCall("interrupted")], [])
    expect(restored.pending[0]?.durableResult).toMatchObject({
      status: "failed", output: DEPENDENCY_WAIT_BATCH_REJECTION, errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code,
    })
    expect(classifyToolCallRecovery(restored.pending, () => { throw new Error("must not replay") })[0]?.action).toBe("reconcile")
  })

  it("keeps the rejection hint on a later restore with matching normal and recovery failure receipts", () => {
    const call = rejectedCall("completed")
    const result = { id: "rejected-result-item", stepId: "step-rejected", taskId: "root-rejected", type: "tool_result", status: "completed", revision: 1,
      content: { toolCallId: "call-rejected", output: DEPENDENCY_WAIT_BATCH_REJECTION, errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code } }
    const events = rejectedEvents()
    events.push({ id: "recovered-failed", idempotencyKey: "recovered-failed-key", type: "tool_call.failed", itemId: "rejected-call-item", correlationId: "call-rejected", taskId: "root-rejected",
      payload: { toolCallId: "call-rejected", toolName: "jobs.search", toolVersion: "1", status: "failed", errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code, taskId: "root-rejected" } })
    const restored = restoreToolCallState([call, result], events)
    expect(restored.pending).toEqual([])
    expect(restored.observations[0]?.content).toMatchObject({
      status: "failed", output: DEPENDENCY_WAIT_BATCH_REJECTION, errorCode: DEPENDENCY_WAIT_BATCH_REJECTION.code,
    })
  })

  it("fails closed for unknown markers and marker data on a result item", () => {
    const unknown = rejectedCall("started")
    ;(unknown.content as Record<string, unknown>)[DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY] = "unknown-version"
    expect(() => restoreToolCallState([unknown], [])).toThrow("tool_result_replay_uncertain")
    const result = { type: "tool_result", content: { toolCallId: "orphan", [DEPENDENCY_WAIT_BATCH_REJECTION_ITEM_KEY]: DEPENDENCY_WAIT_BATCH_REJECTION_MARKER } }
    expect(() => restoreToolCallState([result], [])).toThrow("tool_result_replay_uncertain")
  })

  it("leaves an ordinary read-only pending call on its existing replay path", () => {
    const ordinary = { id: "ordinary-call", stepId: "step-ordinary", type: "tool_call", status: "started", revision: 0,
      content: { toolCallId: "ordinary", toolName: "jobs.search", input: {} } }
    const restored = restoreToolCallState([ordinary], [])
    expect(restored.pending[0]?.durableResult).toBeUndefined()
    expect(classifyToolCallRecovery(restored.pending, () => ({ idempotency: "read_only" }))[0]?.action).toBe("replay")
  })

  it("returns an unfinished persisted call for registry-based restart recovery", () => {
    const items = [
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", input: { location: "Dublin" } } },
    ]
    const events = [{ type: "tool_call.started", payload: { toolCallId: "call-1", toolName: "jobs.search" } }]
    const restored = restoreToolCallState(items, events)
    expect(restored).toEqual(restoreSharedToolCallState(items, events))

    expect(restored.pending).toEqual([{
      call: { id: "call-1", name: "jobs.search", arguments: { location: "Dublin" } }, toolVersion: "1", stepId: "step-0",
      callItem: { id: "call-item", revision: 0 },
    }])
    expect(restored.observations).toEqual([])
  })

  it("uses a durable lifecycle result if it landed before item completion", () => {
    const restored = restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", input: {} } },
    ], [
      { type: "tool_call.completed", payload: { toolCallId: "call-1", toolName: "jobs.search", toolVersion: "1", status: "completed", output: { jobs: ["one"] } } },
      { type: "tool_call.completed", payload: { toolCallId: "call-1", toolName: "jobs.search", status: "completed", taskId: "root-1" } },
    ])

    expect(restored.pending[0]?.durableResult).toMatchObject({ status: "completed", output: { jobs: ["one"] } })
    expect(restored.pending[0]?.callItem).toEqual({ id: "call-item", revision: 0 })
  })

  it("restores event output when the terminal result item stores only a reference marker", () => {
    const restored = restoreToolCallState([
      { type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.search", input: {}, status: "completed" } },
      { type: "tool_result", content: { toolCallId: "call-1", outputAvailable: true, errorCode: null } },
    ], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }])
    expect(restored.observations[0]?.content.output).toEqual({ jobs: [{ id: "job-1" }] })
  })

  it("rejects a terminal event whose payload status contradicts its event type", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }
    expect(() => restoreToolCallState([call], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "failed" } }])).toThrow("tool_result_replay_uncertain")
    expect(() => restoreToolCallState([call], [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "completed" } }])).toThrow("tool_result_replay_uncertain")
  })

  it.each([
    ["terminal status", [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed" } }, { type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed" } }]],
    ["toolVersion", [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", toolVersion: "1" } }, { type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", toolVersion: "2" } }]],
    ["output", [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 1 } } }, { type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 2 } } }]],
    ["errorCode", [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed", errorCode: "first_error" } }, { type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed", errorCode: "second_error" } }]],
  ])("rejects conflicting terminal receipts with different %s", (_label, events) => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }
    expect(() => restoreToolCallState([call], events)).toThrow("tool_result_replay_uncertain")
  })

  it("rejects a terminal event that contradicts persisted tool-result outcome status", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", status: "failed" } }
    const event = { type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 1 } } }
    expect(() => restoreToolCallState([call], [event])).toThrow("tool_result_replay_uncertain")
  })

  it("rejects a completed lifecycle event paired with a failed result item", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }
    const result = { id: "result-item", stepId: "step-0", type: "tool_result", status: "failed", revision: 0, content: { toolCallId: "call-1", errorCode: "tool_execution_failed" } }
    const event = { type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 1 } } }
    expect(() => restoreToolCallState([call, result], [event])).toThrow("tool_result_replay_uncertain")
  })

  it("rejects lifecycle output or error codes that disagree with persisted result content", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed" } }
    const result = { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: { count: 1 }, errorCode: "first_error" } }
    expect(() => restoreToolCallState([call, result], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { count: 2 }, errorCode: "first_error" } }])).toThrow("tool_result_replay_uncertain")
    expect(() => restoreToolCallState([call, result], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { count: 1 }, errorCode: "second_error" } }])).toThrow("tool_result_replay_uncertain")
  })

  it("accepts matching full outputs and ordinary failed tool receipts", () => {
    const successful = restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed" } },
      { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: { count: 1 }, errorCode: null } },
    ], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", status: "completed", output: { count: 1 }, errorCode: null } }])
    expect(successful.observations[0]?.content.output).toEqual({ count: 1 })

    const failed = restoreToolCallState([
      { id: "failed-call", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-2", toolName: "jobs.search", status: "failed", errorCode: "tool_execution_failed" } },
      { id: "failed-result", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-2", output: null, errorCode: "tool_execution_failed" } },
    ], [{ type: "tool_call.failed", payload: { toolCallId: "call-2", status: "failed", errorCode: "tool_execution_failed" } }])
    expect(failed.observations[0]?.content).toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })
  })

  it("preserves an explicit cancelled outcome with its cancellation errorCode", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "cancelled", errorCode: "cancelled" } }
    const result = { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", status: "cancelled", output: null, errorCode: "cancelled" } }
    const restored = restoreToolCallState([call, result], [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "cancelled", output: null, errorCode: "cancelled" } }])
    expect(restored.observations[0]?.content).toMatchObject({ status: "cancelled", errorCode: "cancelled" })

    const recovered = restoreToolCallState([
      { ...call, status: "started", revision: 0 },
      { ...result, status: "completed", revision: 0 },
    ], [])
    expect(recovered.pending[0]?.durableResult).toMatchObject({ status: "cancelled", errorCode: "cancelled" })
  })

  it("rejects explicit event errorCode null against persisted error but accepts an omitted field", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "failed", errorCode: "tool_execution_failed" } }
    const result = { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: null, errorCode: "tool_execution_failed" } }
    expect(() => restoreToolCallState([call, result], [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed", errorCode: null } }])).toThrow("tool_result_replay_uncertain")
    expect(restoreToolCallState([call, result], [{ type: "tool_call.failed", payload: { toolCallId: "call-1", status: "failed" } }]).observations[0]?.content)
      .toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })
  })

  it("rejects disagreeing paired item statuses without a lifecycle event", () => {
    expect(() => restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed" } },
      { id: "result-item", stepId: "step-0", type: "tool_result", status: "failed", revision: 1, content: { toolCallId: "call-1", output: { count: 1 }, errorCode: null } },
    ], [])).toThrow("tool_result_replay_uncertain")
  })

  it("uses legacy event toolName only when a matching persisted call exists", () => {
    const call = { id: "call-item", stepId: "step-0", type: "tool_call", status: "started", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search", input: {} } }
    const restored = restoreToolCallState([call], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { count: 1 } } }])
    expect(restored.pending[0]?.durableResult).toMatchObject({ toolName: "jobs.search", output: { count: 1 } })
    expect(restoreToolCallState([], [{ type: "tool_call.completed", payload: { toolCallId: "orphan", toolName: "jobs.search", output: { count: 1 } } }])).toEqual({ observations: [], pending: [] })
    expect(() => restoreToolCallState([call], [{ type: "tool_call.completed", payload: { toolCallId: "call-1", toolName: "jobs.get", output: { count: 1 } } }])).toThrow("tool_result_replay_uncertain")
  })

  it("keeps a terminal paired tool observation out of the pending recovery set", () => {
    const restored = restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", status: "completed", revision: 1, content: { toolCallId: "call-1", toolName: "jobs.search", input: {}, status: "completed" } },
      { id: "result-item", stepId: "step-0", type: "tool_result", status: "completed", revision: 1, content: { toolCallId: "call-1", output: { count: 1 }, errorCode: null } },
    ], [])

    expect(restored.pending).toEqual([])
    expect(restored.observations).toEqual([{ id: "tool-result:call-1", content: { toolCallId: "call-1", toolName: "jobs.search", input: {}, status: "completed", output: { count: 1 }, errorCode: null } }])
  })

  it("fails closed when an incomplete item has no fenced item identity", () => {
    expect(() => restoreToolCallState([
      { type: "tool_call", status: "started", content: { toolCallId: "call-1", toolName: "jobs.search" } },
    ], [])).toThrow("tool_result_replay_uncertain")
  })

  it.each([
    ["unknown status", [{ id: "call-item", stepId: "step-0", type: "tool_call", status: "processing", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }]],
    ["legacy status without a paired result", [{ id: "call-item", stepId: "step-0", type: "tool_call", revision: 0, content: { toolCallId: "call-1", toolName: "jobs.search" } }]],
  ])("fails closed for %s", (_label, items) => {
    expect(() => restoreToolCallState(items, [])).toThrow("tool_result_replay_uncertain")
  })

  it("accepts a paired legacy terminal result but never infers terminality from status absence alone", () => {
    const legacy = restoreToolCallState([
      { type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed" } },
      { type: "tool_result", content: { toolCallId: "call-1", output: { count: 1 }, errorCode: null } },
    ], [])
    expect(legacy.pending).toEqual([])
    expect(legacy.observations[0]?.content.output).toEqual({ count: 1 })
    expect(() => restoreToolCallState([
      { id: "call-item", stepId: "step-0", type: "tool_call", revision: 0, content: { toolCallId: "call-2", toolName: "jobs.search" } },
    ], [])).toThrow("tool_result_replay_uncertain")
  })

  it.each(["failed", "cancelled"] as const)("ignores only a bound legacy %s diagnostic for an explicit null result", phase => {
    const fixture = legacyFailure(phase)
    const restored = restoreToolCallState(fixture.items, [fixture.event])
    expect(restored.pending).toEqual([])
    expect(restored.observations[0]?.content).toMatchObject({ status: phase, output: null, errorCode: fixture.event.payload.errorCode })
  })

  it("preserves a structured message-shaped output and the existing event-only recovery path", () => {
    const fixture = legacyFailure()
    const fixtureResult = fixture.items[1]!.content as Record<string, unknown>
    fixtureResult.output = { message: "safe diagnostic" }
    expect(restoreToolCallState(fixture.items, [fixture.event]).observations[0]?.content.output).toEqual({ message: "safe diagnostic" })

    const fixturePayload = fixture.event.payload as Record<string, unknown>
    fixturePayload.failureKind = "safe_output"
    const eventOnly = restoreToolCallState([fixture.items[0]!], [fixture.event])
    expect(eventOnly.pending[0]?.durableResult?.output).toEqual({ message: "safe diagnostic" })

    const taggedNull = legacyFailure()
    const taggedPayload = taggedNull.event.payload as Record<string, unknown>
    taggedPayload.failureKind = "safe_output"
    expect(() => restoreToolCallState(taggedNull.items, [taggedNull.event])).toThrow("tool_result_replay_uncertain")

    const mismatched = legacyFailure()
    const mismatchedResult = mismatched.items[1]!.content as Record<string, unknown>
    mismatchedResult.output = { message: "other" }
    expect(() => restoreToolCallState(mismatched.items, [mismatched.event])).toThrow("tool_result_replay_uncertain")
  })

  it("rejects an untagged legacy diagnostic without a complete explicit-null pair", () => {
    const missingResult = legacyFailure()
    expect(() => restoreToolCallState([missingResult.items[0]!], [missingResult.event])).toThrow("tool_result_replay_uncertain")

    const foreignMissingResult = legacyFailure()
    foreignMissingResult.event.id = "foreign-event"
    expect(() => restoreToolCallState([foreignMissingResult.items[0]!], [foreignMissingResult.event])).toThrow("tool_result_replay_uncertain")

    const missingOutput = legacyFailure()
    delete (missingOutput.items[1]!.content as Record<string, unknown>).output
    expect(() => restoreToolCallState(missingOutput.items, [missingOutput.event])).toThrow("tool_result_replay_uncertain")
  })

  it("rejects invalid tagged failure kinds and diagnostic events with non-null output", () => {
    const invalidKind = legacyFailure()
    const invalidPayload = invalidKind.event.payload as Record<string, unknown>
    invalidPayload.failureKind = "unknown"
    expect(() => restoreToolCallState(invalidKind.items, [invalidKind.event])).toThrow("tool_result_replay_uncertain")

    const diagnosticOutput = legacyFailure()
    const payload = diagnosticOutput.event.payload as Record<string, unknown>
    payload.failureKind = "diagnostic"
    payload.failureDetail = { message: "safe diagnostic" }
    expect(() => restoreToolCallState(diagnosticOutput.items, [diagnosticOutput.event])).toThrow("tool_result_replay_uncertain")
  })

  it("uses the legacy v1 tool-version fallback but rejects an explicit mismatch", () => {
    const legacy = legacyFailure()
    delete (legacy.items[0]!.content as Record<string, unknown>).toolVersion
    expect(restoreToolCallState(legacy.items, [legacy.event]).pending).toEqual([])

    const mismatch = legacyFailure()
    const mismatchCall = mismatch.items[0]!.content as Record<string, unknown>
    mismatchCall.toolVersion = "2"
    expect(() => restoreToolCallState(mismatch.items, [mismatch.event])).toThrow("tool_result_replay_uncertain")
  })

  it.each([
    ["foreign origin", (event: Record<string, unknown>) => { event.id = "foreign-event" }],
    ["wrong actor", (event: Record<string, unknown>) => { event.actor = "system" }],
    ["wrong correlation", (event: Record<string, unknown>) => { event.correlationId = "other-call" }],
    ["wrong causal binding", (event: Record<string, unknown>) => { event.causationId = "other-event" }],
    ["wrong idempotency key", (event: Record<string, unknown>) => { event.idempotencyKey = "foreign-key" }],
    ["wrong phase", (event: Record<string, unknown>) => { (event.payload as Record<string, unknown>).status = "cancelled" }],
    ["wrong error code", (event: Record<string, unknown>) => { (event.payload as Record<string, unknown>).errorCode = "other_error" }],
    ["wrong task", (event: Record<string, unknown>) => { event.taskId = "other-task" }],
  ])("rejects a null-result legacy diagnostic with %s provenance", (_label, alter) => {
    const fixture = legacyFailure()
    alter(fixture.event)
    expect(() => restoreToolCallState(fixture.items, [fixture.event])).toThrow("tool_result_replay_uncertain")
  })

  it("rejects duplicate legacy diagnostic authority and a nonterminal pair", () => {
    const fixture = legacyFailure()
    expect(() => restoreToolCallState(fixture.items, [fixture.event, fixture.event])).toThrow("tool_result_replay_uncertain")

    const nonterminal = legacyFailure()
    nonterminal.items[0]!.status = "started"
    expect(() => restoreToolCallState(nonterminal.items, [nonterminal.event])).toThrow("tool_result_replay_uncertain")

    const nonterminalResult = legacyFailure()
    nonterminalResult.items[1]!.status = "started"
    expect(() => restoreToolCallState(nonterminalResult.items, [nonterminalResult.event])).toThrow("tool_result_replay_uncertain")
  })
})
