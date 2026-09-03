import { describe, expect, it } from "vitest"

import { AgentTreeManager } from "../subagents/manager.js"
import { ToolRegistry } from "./registry.js"
import { ToolSchemaValidator } from "./schema-validator.js"
import { createCoordinationTools } from "./coordination-tools.js"
import type { CoordinationStore } from "./coordination-types.js"

const options = {
  manager: {} as unknown as AgentTreeManager,
  store: {} as unknown as CoordinationStore,
}

describe("coordination tool definitions", () => {
  it("exposes the six AH2-030 tools with coordination metadata and manager fencing", () => {
    const definitions = createCoordinationTools(options)
    expect(definitions.map(definition => definition.name)).toEqual([
      "spawn_subagent", "send_message", "wait_subagents", "list_subagents", "interrupt_subagent", "close_subagent",
    ])
    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "coordination", requiredCapabilities: ["canManageChildren"] }),
    ]))
    expect(definitions.filter(definition => definition.risk === "internal_write")).toHaveLength(5)
    expect(definitions.find(definition => definition.name === "list_subagents")).toMatchObject({ risk: "read", capabilities: ["read", "coordination"] })
    expect(new ToolRegistry(definitions).list(["canManageChildren"]).map(definition => definition.name)).toEqual([
      "spawn_subagent", "send_message", "wait_subagents", "list_subagents", "interrupt_subagent", "close_subagent",
    ])
    expect(new ToolRegistry(definitions).list(["other"])).toHaveLength(0)
  })

  it("rejects forged tenant, ownership, lineage, and unknown fields before execution", () => {
    const registry = new ToolRegistry(createCoordinationTools(options))
    const valid = { idempotencyKey: "spawn-1", role: "scout", taskType: "inspect", goal: "Inspect the job" }
    expect(registry.validateArguments("spawn_subagent", valid)).toBe(true)
    for (const key of ["userId", "sessionId", "ownerId", "path", "rootTaskId"]) {
      expect(registry.validateArguments("spawn_subagent", { ...valid, [key]: "forged" })).not.toBe(true)
    }
    expect(registry.validateArguments("spawn_subagent", { ...valid, extra: true })).not.toBe(true)
    expect(registry.validateArguments("wait_subagents", { idempotencyKey: "wait-1", taskIds: ["task-1"], mode: "any", timeoutMs: 30_001 })).not.toBe(true)
  })

  it("validates every required idempotency key and strict object shape", () => {
    const validator = new ToolSchemaValidator()
    const definitions = createCoordinationTools(options)
    const invalidInputs: Record<string, Record<string, unknown>> = {
      spawn_subagent: { role: "scout", taskType: "inspect", goal: "Inspect" },
      send_message: { taskId: "task-1", kind: "result", payload: {} },
      wait_subagents: { taskIds: ["task-1"], mode: "all", timeoutMs: 1000 },
      list_subagents: { unexpected: true },
      interrupt_subagent: {},
      close_subagent: {},
    }
    for (const definition of definitions) {
      expect(() => validator.validate(definition.inputSchema, invalidInputs[definition.name], `${definition.name} input`)).toThrow(/schema validation/)
    }
  })
})
