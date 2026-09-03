import { Type } from "@sinclair/typebox"
import { describe, expect, it, vi } from "vitest"

import { InMemoryToolLifecycleSink, ToolLifecycle } from "./lifecycle.js"
import { PolicyEngine } from "../policy/engine.js"
import { ToolRegistry } from "./registry.js"
import { InMemoryToolResultReferenceStore } from "./redaction.js"
import { ToolRouter } from "./router.js"
import type { RuntimeToolDefinition } from "./types.js"

const context = { scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a" }

function makeRouter(execute: RuntimeToolDefinition["execute"] = async () => ({ result: "ok" }), timeoutMs = 100, requiredCapabilities: readonly string[] = []) {
  const sink = new InMemoryToolLifecycleSink()
  const registry = new ToolRegistry([{
    schemaVersion: "agent-harness.v2", name: "test.read", version: "1", description: "test",
    capabilities: ["read"], domain: "jobs", inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }), risk: "read", idempotency: "read_only", timeoutMs, requiredCapabilities, execute,
  }])
  const router = new ToolRouter(registry, new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" }))
  return { router, sink }
}

const request = { id: "call-1", toolName: "test.read", toolVersion: "1", input: { query: "jobs" } }

describe("ToolRouter", () => {
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

  it("executes only the safe input produced by a policy rewrite", async () => {
    const execute = vi.fn(async (_toolContext, input) => ({ result: (input as { query: string }).query }))
    const sink = new InMemoryToolLifecycleSink()
    const registry = new ToolRegistry([{
      schemaVersion: "agent-harness.v2", name: "test.read", version: "1", description: "test",
      capabilities: ["read"], domain: "jobs", inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({ result: Type.String() }, { additionalProperties: false }), risk: "read", idempotency: "read_only", timeoutMs: 100, requiredCapabilities: [], execute,
    }])
    const router = new ToolRouter(
      registry,
      new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" }),
      new PolicyEngine({ hooks: [{ name: "normalize-location", order: 10, stage: "before_tool_use", evaluate: () => ({ outcome: "rewrite_input", rewrite: { safeInput: { query: "Dublin" } } }) }] }),
    )
    await expect(router.execute(context, request)).resolves.toMatchObject({ status: "completed", output: { result: "Dublin" } })
    expect(execute).toHaveBeenCalledWith(expect.anything(), { query: "Dublin" })
  })
})
