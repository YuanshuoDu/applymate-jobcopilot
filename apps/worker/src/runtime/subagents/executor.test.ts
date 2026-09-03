import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"

import { ExecutorHandler, createExecutorTaskSpec } from "./executor.js"
import type { RuntimeToolDefinition } from "../tools/types.js"

function readTool(): RuntimeToolDefinition {
  return {
    schemaVersion, name: "application.get_state", version: "1", description: "read state", capabilities: ["read"],
    inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Object({}, { additionalProperties: false }),
    risk: "read", domain: "application", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: [], execute: vi.fn(async () => ({ state: "ready" })),
  }
}

function externalTool(): RuntimeToolDefinition {
  return { ...readTool(), name: "application.submit", capabilities: ["external_write"], risk: "external_write", idempotency: "non_repeatable", execute: vi.fn(async () => ({ submitted: true })) }
}

describe("Executor preflight handler", () => {
  it("never invokes a tool executor, including when a receipt hint exists", async () => {
    const handler = new ExecutorHandler()
    const external = externalTool()
    const result = await handler.runPreflight(external, { toolName: external.name, toolVersion: external.version }, { toolName: external.name, toolVersion: "1", expiresAt: new Date(Date.now() + 30_000).toISOString() })
    expect(result).toMatchObject({ status: "completed", result: { mode: "preflight_only", preflight: { allowed: false, execute: false, externalWriteBlocked: true } } })
    expect(external.execute).not.toHaveBeenCalled()
  })

  it("returns observable allow/deny preflight evidence without running reads", async () => {
    const handler = new ExecutorHandler()
    const read = readTool()
    await expect(handler.runPreflight(read, { toolName: read.name, toolVersion: read.version })).resolves.toMatchObject({ result: { preflight: { allowed: true, execute: false, reasonCode: "role_allowed" } } })
    expect(read.execute).not.toHaveBeenCalled()
  })

  it("uses a typed preflight-only task contract", () => {
    expect(createExecutorTaskSpec({ userId: "user-a", sessionId: "session-a", taskType: "apply", goal: "prepare application" })).toMatchObject({
      role: "executor", allowedActions: ["inspect_application_state", "inspect_resume_state", "preflight_action"], toolPolicySnapshot: { mode: "preflight_only", externalWrites: false },
    })
  })
})
