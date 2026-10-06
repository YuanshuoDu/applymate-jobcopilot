import { describe, expect, it, vi } from "vitest"

import { SessionPauseRequestedError } from "../session-gate.js"
import type { TaskGraphNativeCommandInput, TaskGraphNativeCommandReceipt } from "../subagents/task-graph-command-port.js"
import { appendNativeCoordination, nativeCoordinationKey, nativeCoordinationOutput, parseNativeCoordinationReceipt } from "./task-graph-coordination-bridge.js"
import type { ToolExecutionContext } from "./types.js"

const digest = "a".repeat(64)
const rawReceipt: TaskGraphNativeCommandReceipt = {
  status: "accepted", replay: false, operationId: "operation-1", requestFingerprint: digest, graphRevision: 2,
  nodeKey: "node-1", dispatchDisposition: "pending",
  child: { taskId: "child-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1, role: "scout", taskType: "research", status: "queued" },
}

function context(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
    taskId: "root-1", rootTaskId: "root-1", actorRole: "orchestrator", signal: new AbortController().signal,
    capabilities: ["canManageChildren"], reportProgress: async () => undefined, ...overrides,
  }
}

function fixture(append = vi.fn(async (_input: TaskGraphNativeCommandInput) => rawReceipt)) {
  const commandPort = { appendAndSchedule: vi.fn(), appendNativeCoordination: append, readCurrent: vi.fn() } as never
  const options = { enabled: true, commandPort, turnLeaseOwner: "worker-1", turnLeaseVersion: 7, parentLeaseOwner: "worker-1", parentAttemptCount: () => 3 }
  return { append, options }
}

describe("native TaskGraph coordination bridge", () => {
  it("passes the authoritative root fence, normalized request and runtime-owned schema marker", async () => {
    const current = fixture()
    const output = await appendNativeCoordination({
      context: context({ delegateOutputSchemaMarker: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" } }),
      options: current.options,
      request: { kind: "spawn", idempotencyKey: "explicit-key", role: "scout", taskType: "research", goal: "Find evidence", constraints: ["EU"], successCriteria: ["Cite sources"], allowedActions: ["jobs.search"], context: { query: "Berlin" }, parentTaskId: "root-1" },
      outputSchemaMarker: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" },
    })

    expect(current.append).toHaveBeenCalledWith(expect.objectContaining({
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", rootTaskId: "root-1", parentTaskId: "root-1", turnLeaseOwner: "worker-1", turnLeaseVersion: 7, parentLeaseOwner: "worker-1", parentAttemptCount: 3 },
      request: expect.objectContaining({ idempotencyKey: "explicit-key", parentTaskId: "root-1", constraints: ["EU"], context: { query: "Berlin" } }),
      outputSchemaMarker: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" },
    }))
    expect(output.rootTaskId).toBe("root-1")
  })

  it("derives stable invocation keys that differ across distinct tool calls and preserves explicit keys", () => {
    const first = context({ toolCallId: "call-one" })
    const replay = context({ toolCallId: "call-one" })
    const other = context({ toolCallId: "call-two" })
    expect(nativeCoordinationKey(first, "spawn")).toBe(nativeCoordinationKey(replay, "spawn"))
    expect(nativeCoordinationKey(first, "spawn")).not.toBe(nativeCoordinationKey(other, "spawn"))
    expect(nativeCoordinationKey(first, "spawn", "caller-key")).toBe("caller-key")
    expect(nativeCoordinationKey(first, "spawn")).not.toBe(nativeCoordinationKey(first, "followup"))
  })

  it("fails closed when the native command is unavailable or its admission is rejected", async () => {
    const unavailable = fixture()
    const unavailableOptions = { ...unavailable.options, commandPort: undefined }
    await expect(appendNativeCoordination({ context: context(), options: unavailableOptions, request: { kind: "spawn", idempotencyKey: "key", role: "scout", taskType: "research", goal: "Inspect" } }))
      .rejects.toMatchObject({ code: "coordination_task_graph_native_coordination_unavailable" })
    expect(unavailable.append).not.toHaveBeenCalled()

    const reject = fixture(vi.fn(async () => { throw Object.assign(new Error("rejected"), { code: "task_graph_owner_mismatch" }) }))
    await expect(appendNativeCoordination({ context: context(), options: reject.options, request: { kind: "spawn", idempotencyKey: "key", role: "scout", taskType: "research", goal: "Inspect" } }))
      .rejects.toMatchObject({ code: "coordination_task_graph_owner_mismatch" })
  })

  it("preserves the canonical pause discriminator at the real command boundary", async () => {
    const pause = new SessionPauseRequestedError()
    const current = fixture(vi.fn(async () => { throw pause }))
    await expect(appendNativeCoordination({ context: context(), options: current.options, request: { kind: "spawn", idempotencyKey: "key", role: "scout", taskType: "research", goal: "Inspect" } }))
      .rejects.toBe(pause)
  })

  it("rejects inconsistent revisions, replay bits, dispatch states, depth and follow-up provenance", async () => {
    const source = { taskId: "source-1", rootTaskId: "root-1", parentTaskId: "root-1", turnId: "turn-1", role: "scout", taskType: "research", status: "cancelled", attemptCount: 0, resultDigest: digest, graphNodeKey: "source-node", origin: "task_graph" }
    const invalidReceipts = [
      { ...rawReceipt, graphRevision: 0 },
      { ...rawReceipt, replay: true },
      { ...rawReceipt, child: { ...rawReceipt.child, status: "waiting" } },
      { ...rawReceipt, child: { ...rawReceipt.child, depth: 9 } },
      { ...rawReceipt, source: { ...source, role: "analyst" } },
      { ...rawReceipt, source: { ...source, taskType: "analysis" } },
      { ...rawReceipt, source: { ...source, turnId: "other-turn" } },
      { ...rawReceipt, source: { ...source, origin: "native_legacy" } },
      { ...rawReceipt, source },
    ]
    for (const receipt of invalidReceipts) {
      const current = fixture(vi.fn(async () => receipt as never))
      await expect(appendNativeCoordination({
        context: context(), options: current.options,
        request: { kind: "spawn", idempotencyKey: "key", role: "scout", taskType: "research", goal: "Inspect" },
      })).rejects.toMatchObject({ code: "coordination_native_admission_failed" })
    }
  })

  it("builds and strictly parses a safe receipt while allowing current child status to advance later", () => {
    const output = nativeCoordinationOutput("spawn", "root-1", rawReceipt)
    expect(parseNativeCoordinationReceipt(output.nativeCoordination)).toEqual(output.nativeCoordination)
    expect(parseNativeCoordinationReceipt({ ...output.nativeCoordination, child: { ...output.nativeCoordination.child, context: { secret: true } } })).toBeUndefined()
    expect(parseNativeCoordinationReceipt({ ...output.nativeCoordination, graphRevision: 0 })).toBeUndefined()
    expect(parseNativeCoordinationReceipt({ ...output.nativeCoordination, status: "duplicate" })).toBeUndefined()
    expect(parseNativeCoordinationReceipt({ ...output.nativeCoordination, dispatchDisposition: "not_ready" })).toBeUndefined()
    expect(parseNativeCoordinationReceipt({ ...output.nativeCoordination, child: { ...output.nativeCoordination.child, depth: 9 } })).toBeUndefined()
  })
})
