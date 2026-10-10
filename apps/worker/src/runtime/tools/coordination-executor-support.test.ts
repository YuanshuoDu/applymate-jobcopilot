import { describe, expect, it, vi } from "vitest"

import { DurableWaitStoreError } from "../subagents/durable-wait-store.js"
import { digestNativeVerificationValue, NATIVE_VERIFICATION_REPORT_SCHEMA } from "../subagents/native-verification-contract.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "../subagents/task-graph-verification-report.js"
import type { CoordinationStore, CoordinationTaskView, DurableWaitPort } from "./coordination-types.js"
import { createWorkerToolRuntime } from "./index.js"
import { InMemoryToolLifecycleSink } from "./lifecycle.js"
import { PolicyEngine } from "../policy/engine.js"
import {
  activity,
  assertSpawnReplay,
  boundedFailureReason,
  currentTurnTask,
  taskOutput,
  waitResult,
  toolSafeDurableWaitPort,
} from "./coordination-executor-support.js"
import { CoordinationError } from "./coordination-types.js"
import type { ToolExecutionContext } from "./types.js"

const context = (overrides: Record<string, unknown> = {}) => ({
  scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1", toolCallId: "call-1",
  reportProgress: vi.fn().mockResolvedValue(undefined), ...overrides,
}) as unknown as ToolExecutionContext

const task: CoordinationTaskView = {
  id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null,
  path: "/root-1/task-1", depth: 1, role: "scout", taskType: "research", status: "completed", goal: "inspect",
  attemptCount: 1, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
  result: null, failureReason: null,
}

function routedWaitRuntime(wait: DurableWaitPort) {
  const sink = new InMemoryToolLifecycleSink()
  const store = { getTask: vi.fn(async () => task), appendActivity: vi.fn(async () => undefined) } as unknown as CoordinationStore
  const policy = new PolicyEngine({ snapshot: { version: "policy.v1", rules: [{
    id: "allow-agent-wait-test", roles: ["orchestrator"], tools: ["agent.wait"], risks: ["internal_write"],
    domains: ["coordination"], outcome: "allow", reasonCode: "wait_test_allowed", reason: "Test-only wait permission",
  }] } })
  const runtime = createWorkerToolRuntime({} as never, { sink }, policy, {
    manager: {} as never, store, wait: toolSafeDurableWaitPort(wait),
  })
  return { runtime, sink }
}

async function routeWait(runtime: ReturnType<typeof createWorkerToolRuntime>) {
  return runtime.router.execute({
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    capabilities: ["canManageChildren"],
  }, {
    id: "call-wait", toolName: "agent.wait", toolVersion: "1",
    input: { idempotencyKey: "wait-request", taskIds: ["task-1"], mode: "any", timeoutMs: 1000 },
  })
}
describe("coordination executor support", () => {
  it("keeps task evidence scoped to the current Turn and rejects mismatched lineage", () => {
    expect(currentTurnTask(context(), task)).toBe(task)
    expect(() => currentTurnTask(context({ turnId: "turn-other" }), task)).toThrowError(CoordinationError)
    expect(() => assertSpawnReplay({ ...task, parentTaskId: "parent-other" }, context(), { parentTaskId: null, rootTaskId: "root-1" }))
      .toThrowError("Spawn replay does not match the current runtime lineage")
  })

  it("removes foreign identity keys from bounded wait results", () => {
    expect(waitResult({ taskId: "private-task", sessionId: "private-session", result: { safe: true } })).toEqual({ result: { safe: true } })
    expect(waitResult(null)).toBeNull()
  })

  it("projects native proof receipts to bounded feedback before exposing task results", () => {
    const nativeVerificationReport = {
      schemaVersion: NATIVE_VERIFICATION_REPORT_SCHEMA, controlOperationId: "verify-op", controlTaskId: "verify-task", controlAttempt: 1,
      owner: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: null },
      target: { kind: "root_goal", candidateDigest: "a".repeat(64), childBindingSetDigest: "b".repeat(64) },
      goalDigest: "c".repeat(64), criteriaDigest: "d".repeat(64), evidencePacketDigest: "e".repeat(64), disposition: "passed",
      criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["target-ref"] }],
    }
    const result = waitResult({ status: "completed", nativeVerificationReport })
    expect(result).toEqual({
      status: "completed",
      nativeVerificationFeedback: {
        disposition: "passed",
        criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion", evidenceReferenceIds: ["target-ref"] }],
      },
    })
    expect(JSON.stringify(result)).not.toContain("controlOperationId")
    expect(JSON.stringify(result)).not.toContain("candidateDigest")
  })

  it("projects terminal agent.list results to the closed public TaskGraph report without changing storage", () => {
    const storedReport = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
      criteria: [{ criterionId: "findings-from-scout", status: "passed", reasonCode: "criteria_met" }],
      evidenceDigest: "a".repeat(64), resultDigest: "b".repeat(64),
      dependencyBindings: [{ nodeKey: "scout-private", taskId: "task-private-source", attemptCount: 2,
        nodeDigest: "c".repeat(64), resultDigest: "d".repeat(64), evidenceDigest: "e".repeat(64), reportDigest: "f".repeat(64) }],
    }
    const storedResult = { structuredResult: { status: "completed", summary: "Findings are supported" }, taskGraphVerificationReport: storedReport }
    const terminalTask = { ...task, result: storedResult }

    const output = taskOutput(terminalTask)
    const publicResult = output.result as Record<string, unknown>
    const publicReport = publicResult.taskGraphVerificationReport as Record<string, unknown>
    expect(Object.keys(publicReport).sort()).toEqual([
      "criteria", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion",
    ])
    expect(publicReport).toMatchObject({ status: "passed", criteria: storedReport.criteria })
    expect(JSON.stringify(output)).not.toContain("task-private-source")
    expect(JSON.stringify(output)).not.toContain("dependencyBindings")
    for (const digest of ["c", "d", "e", "f"]) expect(JSON.stringify(output)).not.toContain(digest.repeat(64))
    expect(terminalTask.result).toEqual(storedResult)
    expect(storedReport.dependencyBindings).toHaveLength(1)
  })

  it("omits malformed serialized private TaskGraph results from terminal list and wait output", () => {
    const rawResult = String.raw`  {"taskGraph\u0056erificationReport":{"dependency\u0042indings":[{"taskId":"private-source","digest":"${"c".repeat(64)}"}]}`
    const rawDigest = digestNativeVerificationValue(rawResult)
    const terminalTask = { ...task, result: rawResult }
    const output = taskOutput(terminalTask)
    const waited = waitResult(rawResult)
    const visible = JSON.stringify({ output, waited })

    expect(output.result).toBeNull()
    expect(waited).toBeNull()
    expect(visible).not.toContain("taskGraphVerificationReport")
    expect(visible).not.toContain("dependencyBindings")
    expect(visible).not.toContain("private-source")
    expect(visible).not.toContain("c".repeat(64))
    expect(visible).not.toContain(rawDigest)
    expect(terminalTask.result).toBe(rawResult)
    expect(waitResult("ordinary task result")).toBe("ordinary task result")
  })

  it("bounds failure previews by UTF-8 bytes", () => {
    const result = boundedFailureReason(`${"a".repeat(499)}€`)
    expect(Buffer.byteLength(result ?? "", "utf8")).toBeLessThanOrEqual(500)
    expect(result).toBe("a".repeat(499))
  })

  it("passes successful durable wait values through unchanged with one port call", async () => {
    const expected = { waitId: "wait-11111111-1111-4111-8111-111111111111", status: "waiting" as const, deadlineAt: "2026-10-04T12:00:00.000Z", matchedTaskIds: [] }
    const wait = { wait: vi.fn(async () => expected) } satisfies DurableWaitPort
    const wrapped = toolSafeDurableWaitPort(wait)
    const input = {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1", taskId: null, rootTaskId: null,
      targetTaskIds: ["task-1"], mode: "any" as const, timeoutMs: 1000, idempotencyKey: "wait-request",
    }
    await expect(wrapped.wait(input)).resolves.toBe(expected)
    expect(wait.wait).toHaveBeenCalledOnce()
  })
  it.each([
    ["wait_invalid", "Durable wait request is invalid"],
    ["wait_scope_error", "Durable wait scope is unavailable"],
    ["wait_conflict", "Durable wait request conflicts with an existing request"],
    ["wait_not_found", "Durable wait is unavailable"],
  ] as const)("routes known durable wait error %s with a safe stable code", async (code, safeMessage) => {
    const sentinel = "raw-store-detail user-private task-private"
    const failure = new DurableWaitStoreError(code, sentinel)
    const { runtime, sink } = routedWaitRuntime({ wait: vi.fn().mockRejectedValue(failure) } as unknown as DurableWaitPort)
    const result = await routeWait(runtime)
    expect(result).toMatchObject({ status: "failed", errorCode: code })
    expect(JSON.stringify({ result, events: sink.events })).not.toContain(sentinel)
    expect(JSON.stringify(sink.events.at(-1))).toContain(safeMessage)
  })

  it("keeps unknown database failures generic and omits their raw detail through the router", async () => {
    const sentinel = "driver-detail user-private task-private"
    const failure = Object.assign(new Error(sentinel), { code: "23505" })
    const { runtime, sink } = routedWaitRuntime({ wait: vi.fn().mockRejectedValue(failure) } as unknown as DurableWaitPort)
    const result = await routeWait(runtime)
    expect(result).toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })
    expect(JSON.stringify({ result, events: sink.events })).not.toContain(sentinel)
    expect(JSON.stringify(sink.events.at(-1))).toContain("Durable wait operation failed")
  })

  it("does not invoke accessors while classifying thrown wait errors", async () => {
    let getterRead = false
    const failure = new Error("private accessor detail")
    Object.defineProperty(failure, "code", { get() { getterRead = true; return "wait_conflict" } })
    const { runtime } = routedWaitRuntime({ wait: vi.fn().mockRejectedValue(failure) } as unknown as DurableWaitPort)
    await expect(routeWait(runtime)).resolves.toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })
    expect(getterRead).toBe(false)
  })
  it("persists activity even when the progress sink is unavailable", async () => {
    const appendActivity = vi.fn().mockResolvedValue(undefined)
    const reportProgress = vi.fn().mockRejectedValue(new Error("disconnected"))
    const options = { store: { appendActivity } } as unknown as Parameters<typeof activity>[1]
    await expect(activity(context({ reportProgress }), options, "spawn_subagent", "task-1", { status: "queued" }, "idem-1")).resolves.toBeUndefined()
    expect(appendActivity).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "idem-1:spawn_subagent", taskId: "task-1" }))
    expect(reportProgress).toHaveBeenCalledOnce()
  })
})
