import { Type } from "@sinclair/typebox"
import { describe, expect, it, vi } from "vitest"

import { InMemoryToolLifecycleSink, ToolLifecycle } from "./lifecycle.js"
import { PolicyEngine, type RuntimePolicyDecision } from "../policy/engine.js"
import { ToolRegistry } from "./registry.js"
import { InMemoryToolResultReferenceStore } from "./redaction.js"
import { ToolRouter, type RuntimePolicyDecisionRecorder } from "./router.js"
import { ToolExecutionError, type RuntimeToolDefinition } from "./types.js"
import { SessionPauseRequestedError } from "../session-gate.js"
import type { ExecutionOwner, ExecutionOwnerFence } from "../execution-owner.js"
import { durablePolicyDecisionRecorder } from "../turns/canonical-runtime-tool-recovery.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import type { ToolResultReferenceRepository } from "./tool-result-reference-types.js"

const context = { scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a" }

function makeRouter(
  execute: RuntimeToolDefinition["execute"] = async () => ({ result: "ok" }),
  timeoutMs = 100,
  requiredCapabilities: readonly string[] = [],
  policy = new PolicyEngine(),
  recordPolicyDecision?: RuntimePolicyDecisionRecorder,
) {
  const sink = new InMemoryToolLifecycleSink()
  const registry = new ToolRegistry([{
    schemaVersion: "agent-harness.v2", name: "test.read", version: "1", description: "test",
    capabilities: ["read"], domain: "jobs", inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }), risk: "read", idempotency: "read_only", timeoutMs, requiredCapabilities, execute,
  }])
  const router = new ToolRouter(
    registry,
    new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" }),
    policy,
    recordPolicyDecision,
  )
  return { router, sink }
}

function policyForOutcome(outcome: "allow" | "deny" | "require_approval" | "require_user_input"): PolicyEngine {
  return new PolicyEngine({ snapshot: { version: "policy.v1", rules: [{
    id: "test-policy", roles: ["orchestrator"], tools: ["test.read"], outcome,
    reasonCode: "test_policy", reason: `Test policy ${outcome}`,
  }] } })
}

const request = { id: "call-1", toolName: "test.read", toolVersion: "1", input: { query: "jobs" } }

describe("ToolRouter", () => {
  it.each([
    { outcome: "allow" as const, status: "completed", errorCode: null },
    { outcome: "deny" as const, status: "failed", errorCode: "policy_denied" },
    { outcome: "require_approval" as const, status: "failed", errorCode: "policy_requires_approval" },
    { outcome: "require_user_input" as const, status: "failed", errorCode: "policy_requires_user_input" },
  ])("records the terminal $outcome decision before its result", async ({ outcome, status, errorCode }) => {
    const execute = vi.fn(async () => ({ result: "ok" }))
    const recordPolicyDecision = vi.fn(async (_decision: RuntimePolicyDecision) => undefined)
    const { router } = makeRouter(execute, 100, [], policyForOutcome(outcome), recordPolicyDecision)

    await expect(router.execute(context, request)).resolves.toMatchObject({ status, errorCode })

    expect(recordPolicyDecision).toHaveBeenCalledOnce()
    expect(recordPolicyDecision.mock.calls[0]?.[0]).toMatchObject({ outcome })
    if (outcome === "allow") expect(execute).toHaveBeenCalledOnce()
    else expect(execute).not.toHaveBeenCalled()
  })

  it("awaits the policy recorder before execution", async () => {
    const order: string[] = []
    let recordingStarted!: () => void
    let finishRecording!: () => void
    const started = new Promise<void>((resolve) => { recordingStarted = resolve })
    const recordingGate = new Promise<void>((resolve) => { finishRecording = resolve })
    const execute = vi.fn(async () => { order.push("execute"); return { result: "ok" } })
    const recordPolicyDecision = vi.fn(async () => {
      order.push("record-start")
      recordingStarted()
      await recordingGate
      order.push("record-finish")
    })
    const { router } = makeRouter(execute, 100, [], policyForOutcome("allow"), recordPolicyDecision)
    const pending = router.execute(context, request)

    await started
    expect(order).toEqual(["record-start"])
    expect(execute).not.toHaveBeenCalled()
    finishRecording()

    await expect(pending).resolves.toMatchObject({ status: "completed" })
    expect(order).toEqual(["record-start", "record-finish", "execute"])
  })

  it("awaits the policy recorder before returning an approval gate", async () => {
    let recordingStarted!: () => void
    let finishRecording!: () => void
    const started = new Promise<void>((resolve) => { recordingStarted = resolve })
    const recordingGate = new Promise<void>((resolve) => { finishRecording = resolve })
    const execute = vi.fn(async () => ({ result: "must not execute" }))
    const recordPolicyDecision = vi.fn(async () => {
      recordingStarted()
      await recordingGate
    })
    const { router } = makeRouter(execute, 100, [], policyForOutcome("require_approval"), recordPolicyDecision)
    let settled = false
    const pending = router.execute(context, request).finally(() => { settled = true })

    await started
    expect(settled).toBe(false)
    expect(execute).not.toHaveBeenCalled()
    finishRecording()

    await expect(pending).resolves.toMatchObject({ status: "failed", errorCode: "policy_requires_approval" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("fails closed when the policy recorder rejects", async () => {
    const execute = vi.fn(async () => ({ result: "must not execute" }))
    const recordPolicyDecision = vi.fn(async () => { throw new Error("policy recorder unavailable") })
    const { router, sink } = makeRouter(execute, 100, [], policyForOutcome("allow"), recordPolicyDecision)

    await expect(router.execute(context, request)).resolves.toMatchObject({ status: "failed", errorCode: "tool_execution_failed" })

    expect(recordPolicyDecision).toHaveBeenCalledOnce()
    expect(execute).not.toHaveBeenCalled()
    expect(sink.events.map((event) => event.phase)).toEqual(["started", "failed"])
  })

  it("fails closed when a denied policy decision cannot be recorded", async () => {
    const execute = vi.fn(async () => ({ result: "must not execute" }))
    const recordPolicyDecision = vi.fn(async (_decision: RuntimePolicyDecision) => { throw new Error("policy recorder unavailable") })
    const { router } = makeRouter(execute, 100, [], policyForOutcome("deny"), recordPolicyDecision)

    await expect(router.execute(context, request)).resolves.toMatchObject({ status: "failed" })

    expect(recordPolicyDecision).toHaveBeenCalledOnce()
    expect(recordPolicyDecision.mock.calls[0]?.[0]).toMatchObject({ outcome: "deny" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("validates, executes once for duplicate calls, and returns lifecycle output", async () => {
    const execute = vi.fn(async () => ({ result: "ok" }))
    const { router, sink } = makeRouter(execute)
    const first = await router.execute(context, request)
    const second = await router.execute(context, request)
    expect(first).toMatchObject({ status: "completed", output: { result: "ok" } })
    expect(second).toEqual(first)
    expect(execute).toHaveBeenCalledOnce()
    expect(sink.events.map((event) => event.phase)).toEqual(["started", "completed"])
  })

  it("rejects unknown/version/schema and model-supplied tenant scope before execution", async () => {
    const execute = vi.fn(async () => ({ result: "ok" }))
    const { router } = makeRouter(execute)
    await expect(router.execute(context, { ...request, toolName: "missing" })).resolves.toMatchObject({ status: "failed", errorCode: "tool_not_found" })
    await expect(router.execute({ ...context, stepId: "step-2" }, { ...request, id: "call-2", toolVersion: "2" })).resolves.toMatchObject({ status: "failed", errorCode: "tool_version_mismatch" })
    await expect(router.execute({ ...context, stepId: "step-3" }, { ...request, id: "call-3", input: { query: 42 } })).resolves.toMatchObject({ status: "failed", errorCode: "schema_error" })
    await expect(router.execute({ ...context, stepId: "step-4" }, { ...request, id: "call-4", input: { query: "jobs", userId: "user-b" } })).resolves.toMatchObject({ status: "failed", errorCode: "runtime_scope_error" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("enforces capabilities, conflicts on reused call IDs, and handles timeout/cancel", async () => {
    const gated = makeRouter(async () => ({ result: "ok" }), 100, ["browser.read"])
    await expect(gated.router.execute({ ...context, capabilities: ["other"] }, request)).resolves.toMatchObject({ status: "failed", errorCode: "capability_denied" })
    const { router } = makeRouter(async () => ({ result: "ok" }))
    await expect(router.execute({ ...context, capabilities: ["other"] }, request)).resolves.toMatchObject({ errorCode: null })
    await expect(router.execute(context, { ...request, input: { query: "different" } })).resolves.toMatchObject({ errorCode: "idempotency_conflict" })

    const timed = makeRouter(async (toolContext) => new Promise((_, reject) => toolContext.signal.addEventListener("abort", () => reject(new Error("aborted")))), 5)
    await expect(timed.router.execute(context, { ...request, id: "call-timeout" })).resolves.toMatchObject({ status: "cancelled", errorCode: "timeout" })
    const controller = new AbortController()
    const cancelled = makeRouter(async (toolContext) => new Promise((_, reject) => toolContext.signal.addEventListener("abort", () => reject(new Error("aborted")))))
    const pending = cancelled.router.execute({ ...context, signal: controller.signal }, { ...request, id: "call-cancel" })
    controller.abort()
    await expect(pending).resolves.toMatchObject({ status: "cancelled", errorCode: "cancelled" })
  })

  it("rejects a tool that resolves after its per-call timeout signal aborts", async () => {
    let resolveTool!: (output: { result: string }) => void
    let signalAbort!: () => void
    const output = new Promise<{ result: string }>((resolve) => { resolveTool = resolve })
    const aborted = new Promise<void>((resolve) => { signalAbort = resolve })
    const timed = makeRouter(async (toolContext) => {
      toolContext.signal.addEventListener("abort", signalAbort, { once: true })
      return output
    }, 5)
    const pending = timed.router.execute(context, { ...request, id: "call-timeout-late" })

    await aborted
    resolveTool({ result: "late success" })

    await expect(pending).resolves.toMatchObject({ status: "cancelled", errorCode: "timeout" })
    expect(timed.sink.events.map((event) => event.phase)).toEqual(["started", "cancelled"])
    expect(timed.sink.events.some((event) => event.eventType === "tool_call.completed")).toBe(false)
  })

  it("cancels completion when the root aborts during durable result persistence", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const owner = {} as unknown as ExecutionOwner
    let signalPutStarted!: () => void
    let releasePut!: () => void
    const putStarted = new Promise<void>((resolve) => { signalPutStarted = resolve })
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    const durableResults = {
      put: vi.fn(async () => {
        signalPutStarted()
        await putGate
        return { id: "tool-result-00000000-0000-4000-8000-000000000001", byteCount: 9_000, sha256: "a".repeat(64) }
      }),
    } as unknown as ToolResultReferenceRepository
    const registry = new ToolRegistry([{
      schemaVersion: "agent-harness.v2", name: "test.read", version: "1", description: "test",
      capabilities: ["read"], domain: "jobs", inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }), risk: "read", idempotency: "read_only", timeoutMs: 5_000, requiredCapabilities: [],
      execute: async () => ({ result: "x".repeat(9_000) }),
    }])
    const lifecycle = new ToolLifecycle({
      sink, durableResults, resolveOwner: () => owner, maxEventBytes: 256,
    })
    const router = new ToolRouter(registry, lifecycle)
    const controller = new AbortController()
    const pending = router.execute({ ...context, signal: controller.signal }, request)

    await putStarted
    controller.abort()
    releasePut()

    await expect(pending).resolves.toMatchObject({ status: "cancelled", errorCode: "cancelled" })
    expect(sink.events.map((event) => event.phase)).toEqual(["started", "cancelled"])
    expect(sink.events.some((event) => event.eventType === "tool_call.completed")).toBe(false)
  })

  it("keeps the per-call timeout active during durable result persistence", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const owner = {} as unknown as ExecutionOwner
    let signalAbort!: () => void
    let signalPutStarted!: () => void
    let releasePut!: () => void
    const aborted = new Promise<void>((resolve) => { signalAbort = resolve })
    const putStarted = new Promise<void>((resolve) => { signalPutStarted = resolve })
    const putGate = new Promise<void>((resolve) => { releasePut = resolve })
    const durableResults = {
      put: vi.fn(async () => {
        signalPutStarted()
        await putGate
        return { id: "tool-result-00000000-0000-4000-8000-000000000002", byteCount: 9_000, sha256: "b".repeat(64) }
      }),
    } as unknown as ToolResultReferenceRepository
    const registry = new ToolRegistry([{
      schemaVersion: "agent-harness.v2", name: "test.read", version: "1", description: "test",
      capabilities: ["read"], domain: "jobs", inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }), risk: "read", idempotency: "read_only", timeoutMs: 20, requiredCapabilities: [],
      execute: async (toolContext) => {
        toolContext.signal.addEventListener("abort", signalAbort, { once: true })
        return { result: "x".repeat(9_000) }
      },
    }])
    const lifecycle = new ToolLifecycle({ sink, durableResults, resolveOwner: () => owner, maxEventBytes: 256 })
    const router = new ToolRouter(registry, lifecycle)
    const pending = router.execute(context, { ...request, id: "call-timeout-during-put" })

    await putStarted
    await aborted
    releasePut()

    await expect(pending).resolves.toMatchObject({ status: "cancelled", errorCode: "timeout" })
    expect(sink.events.map((event) => event.phase)).toEqual(["started", "cancelled"])
    expect(sink.events.some((event) => event.eventType === "tool_call.completed")).toBe(false)
  })

  it("does not emit a started event or invoke a tool after the root is stopped", async () => {
    const execute = vi.fn(async () => ({ result: "should-not-run" }))
    const { router, sink } = makeRouter(execute)
    const controller = new AbortController()
    controller.abort()
    await expect(router.execute({ ...context, signal: controller.signal }, { ...request, id: "pre-stopped" })).resolves.toMatchObject({ status: "cancelled", errorCode: "cancelled" })
    expect(execute).not.toHaveBeenCalled()
    expect(sink.events.map((event) => event.phase)).toEqual(["cancelled"])
  })

  it("rejects malformed inputs and outputs without invoking an unsafe result", async () => {
    const execute = vi.fn(async () => ({ result: "ok" }))
    const { router } = makeRouter(execute)
    for (const [index, input] of [null, [], { query: "ok", extra: true }, { query: 7 }].entries()) {
      await expect(router.execute({ ...context, stepId: `fuzz-${index}` }, { ...request, id: `fuzz-${index}`, input })).resolves.toMatchObject({ status: "failed", errorCode: "schema_error" })
    }
    const badOutput = makeRouter(async () => ({ result: 42 }))
    await expect(badOutput.router.execute(context, { ...request, id: "bad-output" })).resolves.toMatchObject({ status: "failed", errorCode: "schema_error" })
  })

  it("sanitizes structured thrown results while preserving small shapes and bounding large ones", async () => {
    const small = makeRouter(async () => {
      throw new ToolExecutionError("tool_failed", "raw failure detail", { result: "safe", password: "secret" })
    })
    await expect(small.router.execute(context, { ...request, id: "structured-small" })).resolves.toMatchObject({
      status: "failed",
      errorCode: "tool_failed",
      output: { result: "safe", password: "[REDACTED]" },
    })
    expect(JSON.stringify(small.sink.events)).not.toContain("secret")

    const large = makeRouter(async () => {
      throw new ToolExecutionError("tool_failed", "raw failure detail", { result: "x".repeat(9000), password: "secret" })
    })
    await expect(large.router.execute(context, { ...request, id: "structured-large" })).resolves.toMatchObject({
      status: "failed",
      errorCode: "tool_failed",
      output: { $truncated: true, sizeBytes: expect.any(Number) },
    })
    expect(JSON.stringify(large.sink.events)).not.toContain("secret")
  })

  it("forces every executable read call through the deterministic policy hook", async () => {
    const execute = vi.fn(async () => ({ result: "ok" }))
    const sink = new InMemoryToolLifecycleSink()
    const registry = new ToolRegistry([{
      schemaVersion: "agent-harness.v2", name: "test.read", version: "1", description: "test",
      capabilities: ["read"], domain: "jobs", inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }), risk: "read", idempotency: "read_only", timeoutMs: 100, requiredCapabilities: [], execute,
    }])
    const router = new ToolRouter(
      registry,
      new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" }),
      new PolicyEngine({ snapshot: { version: "policy.v1", rules: [] } }),
    )
    await expect(router.execute(context, request)).resolves.toMatchObject({ status: "failed", errorCode: "policy_denied" })
    expect(execute).not.toHaveBeenCalled()
    expect(sink.events.at(-1)?.payload).toMatchObject({ errorCode: "policy_denied" })
  })

  it("denies an external write when no explicit policy is configured", async () => {
    const execute = vi.fn(async () => ({ ok: true }))
    const sink = new InMemoryToolLifecycleSink()
    const registry = new ToolRegistry([{
      schemaVersion: "agent-harness.v2", name: "application.submit", version: "1", description: "test write",
      capabilities: ["external_write"], domain: "application", inputSchema: Type.Object({ jobId: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }), risk: "external_write", idempotency: "non_repeatable", timeoutMs: 100, requiredCapabilities: [], execute,
    }])
    const router = new ToolRouter(
      registry,
      new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" }),
    )
    await expect(router.execute(context, { id: "submit-1", toolName: "application.submit", toolVersion: "1", input: { jobId: "job-1" } })).resolves.toMatchObject({ status: "failed", errorCode: "policy_denied" })
    expect(execute).not.toHaveBeenCalled()
  })

  it("settles the started lifecycle before rethrowing the typed session pause", async () => {
    const pause = new SessionPauseRequestedError()
    const { router, sink } = makeRouter(async () => { throw pause })

    await expect(router.execute(context, request)).rejects.toBe(pause)

    expect(sink.events.map(event => event.phase)).toEqual(["started", "failed"])
    expect(sink.events.at(-1)?.payload).toMatchObject({ errorCode: "session_pause_requested", output: { message: "Session work is fenced by a durable pause request" } })
  })

  it("executes only the safe input produced by a policy rewrite", async () => {
    const execute = vi.fn(async (_toolContext, input) => ({ result: (input as { query: string }).query }))
    const sink = new InMemoryToolLifecycleSink()
    const persistedPolicyDecisions: unknown[] = []
    const decisionSink = { append: (decision: unknown) => { persistedPolicyDecisions.push(decision) } }
    const recordedDecisions: RuntimePolicyDecision[] = []
    const recordPolicyDecision = vi.fn(async (decision: RuntimePolicyDecision) => { recordedDecisions.push(decision) })
    const registry = new ToolRegistry([{
      schemaVersion: "agent-harness.v2", name: "test.read", version: "1", description: "test",
      capabilities: ["read"], domain: "jobs", inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }), risk: "read", idempotency: "read_only", timeoutMs: 100, requiredCapabilities: [], execute,
    }])
    const router = new ToolRouter(
      registry,
      new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" }),
      new PolicyEngine({
        hooks: [{ name: "normalize-location", order: 10, stage: "before_tool_use", evaluate: () => ({ outcome: "rewrite_input", rewrite: { safeInput: { query: "Dublin" } } }) }],
        decisionSink,
      }),
      recordPolicyDecision,
    )
    await expect(router.execute(context, request)).resolves.toMatchObject({ status: "completed", output: { result: "Dublin" } })
    expect(execute).toHaveBeenCalledWith(expect.anything(), { query: "Dublin" })
    expect(recordedDecisions[0]).toMatchObject({ outcome: "allow", safeInput: { query: "Dublin" } })
    expect(persistedPolicyDecisions[0]).toMatchObject({ outcome: "allow" })
    expect(persistedPolicyDecisions[0]).not.toHaveProperty("safeInput")
  })

  it("durably records an invalid policy rewrite before denying execution", async () => {
    const execute = vi.fn(async () => ({ result: "must not execute" }))
    const owner: ExecutionOwnerFence = {
      kind: "turn", userId: "user-a", sessionId: "session-a", turnId: "turn-a",
      taskId: "root-a", rootTaskId: "root-a", ownerId: "worker-a", leaseVersion: 1,
      leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
    }
    const store = {
      appendEvent: vi.fn(async () => ({ id: "policy-event-1" })),
    } as unknown as TurnEngineStore
    const recordPolicyDecision = durablePolicyDecisionRecorder(store, owner, 1)
    const policy = new PolicyEngine({
      hooks: [{
        name: "malicious-rewrite", order: 10, stage: "before_tool_use",
        evaluate: () => ({ outcome: "rewrite_input" }),
      }],
    })
    const { router } = makeRouter(execute, 100, [], policy, recordPolicyDecision)

    await expect(router.execute(context, request)).resolves.toMatchObject({
      status: "failed", errorCode: "policy_denied",
    })

    expect(store.appendEvent).toHaveBeenCalledOnce()
    expect(store.appendEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: "policy.decision",
      payload: expect.objectContaining({ outcome: "deny", reasonCode: "rewrite_invalid" }),
    }))
    expect(execute).not.toHaveBeenCalled()
  })
})
