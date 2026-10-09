import { describe, expect, it } from "vitest"

import { AgentTreeManager } from "../subagents/manager.js"
import { ToolRegistry } from "./registry.js"
import { ToolSchemaValidator } from "./schema-validator.js"
import { createCoordinationTools } from "./coordination-tools.js"
import { TASK_GRAPH_RESULT_PAGE_SCHEMA } from "../subagents/task-graph-result-page-contract.js"
import type { CoordinationStore } from "./coordination-types.js"

const options = {
  manager: {} as unknown as AgentTreeManager,
  store: {} as unknown as CoordinationStore,
}

describe("coordination tool definitions", () => {
  it("exposes canonical coordination names with shared metadata and manager fencing", () => {
    const definitions = createCoordinationTools(options)
    expect(definitions.map(definition => definition.name)).toEqual([
      "spawn_subagent", "agent.spawn", "agent.followup", "send_message", "agent.send", "wait_subagents", "agent.wait", "list_subagents", "agent.list", "interrupt_subagent", "agent.interrupt", "close_subagent", "agent.close",
    ])
    expect(definitions).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "coordination", requiredCapabilities: ["canManageChildren"] }),
    ]))
    expect(definitions.filter(definition => definition.risk === "internal_write")).toHaveLength(11)
    const legacySpawn = definitions.find(definition => definition.name === "spawn_subagent")
    const canonicalSpawn = definitions.find(definition => definition.name === "agent.spawn")
    expect(legacySpawn).toBeDefined()
    expect(canonicalSpawn).toMatchObject({
      schemaVersion: legacySpawn?.schemaVersion,
      version: legacySpawn?.version,
      description: legacySpawn?.description,
      capabilities: legacySpawn?.capabilities,
      risk: legacySpawn?.risk,
      domain: legacySpawn?.domain,
      idempotency: legacySpawn?.idempotency,
      timeoutMs: legacySpawn?.timeoutMs,
      requiredCapabilities: legacySpawn?.requiredCapabilities,
    })
    expect(canonicalSpawn?.inputSchema).toBe(legacySpawn?.inputSchema)
    expect(canonicalSpawn?.outputSchema).toBe(legacySpawn?.outputSchema)
    expect(canonicalSpawn?.execute).toBe(legacySpawn?.execute)
    const legacySend = definitions.find(definition => definition.name === "send_message")
    const canonicalSend = definitions.find(definition => definition.name === "agent.send")
    expect(legacySend).toBeDefined()
    expect(canonicalSend).toMatchObject({
      schemaVersion: legacySend?.schemaVersion,
      version: legacySend?.version,
      description: legacySend?.description,
      capabilities: legacySend?.capabilities,
      risk: legacySend?.risk,
      domain: legacySend?.domain,
      idempotency: legacySend?.idempotency,
      timeoutMs: legacySend?.timeoutMs,
      requiredCapabilities: legacySend?.requiredCapabilities,
    })
    expect(canonicalSend?.inputSchema).toBe(legacySend?.inputSchema)
    expect(canonicalSend?.outputSchema).toBe(legacySend?.outputSchema)
    expect(canonicalSend?.execute).toBe(legacySend?.execute)
    const legacyWait = definitions.find(definition => definition.name === "wait_subagents")
    const canonicalWait = definitions.find(definition => definition.name === "agent.wait")
    expect(legacyWait).toBeDefined()
    expect(canonicalWait).toMatchObject({
      schemaVersion: legacyWait?.schemaVersion,
      version: legacyWait?.version,
      description: legacyWait?.description,
      capabilities: legacyWait?.capabilities,
      risk: legacyWait?.risk,
      domain: legacyWait?.domain,
      idempotency: legacyWait?.idempotency,
      timeoutMs: legacyWait?.timeoutMs,
      requiredCapabilities: legacyWait?.requiredCapabilities,
    })
    expect(canonicalWait?.inputSchema).toBe(legacyWait?.inputSchema)
    expect(canonicalWait?.outputSchema).toBe(legacyWait?.outputSchema)
    expect(canonicalWait?.execute).toBe(legacyWait?.execute)
    const legacyInterrupt = definitions.find(definition => definition.name === "interrupt_subagent")
    const canonicalInterrupt = definitions.find(definition => definition.name === "agent.interrupt")
    expect(legacyInterrupt).toBeDefined()
    expect(canonicalInterrupt).toMatchObject({
      schemaVersion: legacyInterrupt?.schemaVersion,
      version: legacyInterrupt?.version,
      description: legacyInterrupt?.description,
      capabilities: legacyInterrupt?.capabilities,
      risk: legacyInterrupt?.risk,
      domain: legacyInterrupt?.domain,
      idempotency: legacyInterrupt?.idempotency,
      timeoutMs: legacyInterrupt?.timeoutMs,
      requiredCapabilities: legacyInterrupt?.requiredCapabilities,
    })
    expect(canonicalInterrupt?.inputSchema).toBe(legacyInterrupt?.inputSchema)
    expect(canonicalInterrupt?.outputSchema).toBe(legacyInterrupt?.outputSchema)
    expect(canonicalInterrupt?.execute).toBe(legacyInterrupt?.execute)
    const legacyList = definitions.find(definition => definition.name === "list_subagents")
    const canonicalList = definitions.find(definition => definition.name === "agent.list")
    expect(legacyList).toBeDefined()
    expect(canonicalList).toMatchObject({
      schemaVersion: legacyList?.schemaVersion,
      version: legacyList?.version,
      description: legacyList?.description,
      capabilities: legacyList?.capabilities,
      risk: legacyList?.risk,
      domain: legacyList?.domain,
      idempotency: legacyList?.idempotency,
      timeoutMs: legacyList?.timeoutMs,
      requiredCapabilities: legacyList?.requiredCapabilities,
    })
    expect(canonicalList?.inputSchema).not.toBe(legacyList?.inputSchema)
    expect(canonicalList?.outputSchema).not.toBe(legacyList?.outputSchema)
    expect(canonicalList?.execute).not.toBe(legacyList?.execute)
    const legacyClose = definitions.find(definition => definition.name === "close_subagent")
    const canonicalClose = definitions.find(definition => definition.name === "agent.close")
    expect(legacyClose).toBeDefined()
    expect(canonicalClose).toMatchObject({
      schemaVersion: legacyClose?.schemaVersion,
      version: legacyClose?.version,
      description: legacyClose?.description,
      capabilities: legacyClose?.capabilities,
      risk: legacyClose?.risk,
      domain: legacyClose?.domain,
      idempotency: legacyClose?.idempotency,
      timeoutMs: legacyClose?.timeoutMs,
      requiredCapabilities: legacyClose?.requiredCapabilities,
    })
    expect(canonicalClose?.inputSchema).toBe(legacyClose?.inputSchema)
    expect(canonicalClose?.outputSchema).toBe(legacyClose?.outputSchema)
    expect(canonicalClose?.execute).toBe(legacyClose?.execute)
    expect(definitions.find(definition => definition.name === "agent.followup")).toMatchObject({ idempotency: "requires_key", risk: "internal_write", requiredCapabilities: ["canManageChildren"] })
    expect(definitions.find(definition => definition.name === "list_subagents")).toMatchObject({ risk: "read", capabilities: ["read", "coordination"] })
    expect(definitions.find(definition => definition.name === "agent.list")).toMatchObject({ risk: "read", capabilities: ["read", "coordination"] })
    expect(new ToolRegistry(definitions).list(["canManageChildren"]).map(definition => definition.name)).toEqual([
      "spawn_subagent", "agent.spawn", "agent.followup", "send_message", "agent.send", "wait_subagents", "agent.wait", "list_subagents", "agent.list", "interrupt_subagent", "agent.interrupt", "close_subagent", "agent.close",
    ])
    const registry = new ToolRegistry(definitions)
    expect(registry.resolve("agent.send", "1").execute).toBe(registry.resolve("send_message", "1").execute)
    expect(registry.resolve("agent.spawn", "1").execute).toBe(registry.resolve("spawn_subagent", "1").execute)
    expect(registry.resolve("agent.wait", "1").execute).toBe(registry.resolve("wait_subagents", "1").execute)
    expect(registry.resolve("agent.interrupt", "1").execute).toBe(registry.resolve("interrupt_subagent", "1").execute)
    expect(registry.resolve("agent.list", "1").execute).not.toBe(registry.resolve("list_subagents", "1").execute)
    expect(registry.resolve("agent.close", "1").execute).toBe(registry.resolve("close_subagent", "1").execute)
    expect(new ToolRegistry(definitions).list(["other"])).toHaveLength(0)
  })

  it("gives only agent.list the strict exclusive current-result page mode", () => {
    const definitions = createCoordinationTools(options)
    const registry = new ToolRegistry(definitions)
    const request = { nodeKey: "candidate-node", expectedRevision: 2, offset: 3 }
    expect(registry.validateArguments("agent.list", request)).toBe(true)
    expect(registry.validateArguments("list_subagents", request)).not.toBe(true)
    expect(registry.validateArguments("agent.list", { ...request, includeTerminal: true })).not.toBe(true)
    expect(registry.validateArguments("agent.list", { ...request, taskId: "forged" })).not.toBe(true)
    const page = {
      schemaVersion: TASK_GRAPH_RESULT_PAGE_SCHEMA, trust: "untrusted", availability: "available", graphRevision: 2,
      role: "scout", taskStatus: "completed", resultStatus: "completed", totalCount: 1, evidenceCount: 1,
      offset: 0, nextOffset: null, items: [{ jobId: "00000000-0000-4000-8000-000000000000", source: "other", evidenceKinds: ["job"] }],
    }
    expect(() => registry.validators.validate(definitions.find(tool => tool.name === "agent.list")!.outputSchema, page, "agent.list output")).not.toThrow()
    expect(() => registry.validators.validate(definitions.find(tool => tool.name === "list_subagents")!.outputSchema, page, "list_subagents output")).toThrow()
  })
  it("rejects forged tenant, ownership, lineage, and unknown fields before execution", () => {
    const registry = new ToolRegistry(createCoordinationTools(options))
    const valid = { idempotencyKey: "spawn-1", role: "scout", taskType: "inspect", goal: "Inspect the job" }
    const followup = { idempotencyKey: "followup-1", taskId: "task-1", goal: "Continue the task" }
    expect(registry.validateArguments("agent.followup", followup)).toBe(true)
    expect(registry.validateArguments("agent.followup", { ...followup, parentTaskId: "forged" })).not.toBe(true)
    expect(registry.validateArguments("spawn_subagent", valid)).toBe(true)
    expect(registry.validateArguments("agent.spawn", valid)).toBe(true)
    const validMessage = { idempotencyKey: "message-1", taskId: "task-1", kind: "result", payload: {} }
    expect(registry.validateArguments("send_message", validMessage)).toBe(true)
    expect(registry.validateArguments("agent.send", validMessage)).toBe(true)
    const validWait = { idempotencyKey: "wait-1", taskIds: ["task-1"], mode: "any", timeoutMs: 1000 }
    expect(registry.validateArguments("wait_subagents", validWait)).toBe(true)
    expect(registry.validateArguments("agent.wait", validWait)).toBe(true)
    const validInterrupt = { taskId: "task-1", reason: "Stop this task" }
    expect(registry.validateArguments("interrupt_subagent", validInterrupt)).toBe(true)
    expect(registry.validateArguments("agent.interrupt", validInterrupt)).toBe(true)
    const validList = {}
    expect(registry.validateArguments("list_subagents", validList)).toBe(true)
    expect(registry.validateArguments("agent.list", validList)).toBe(true)
    const validClose = { taskId: "task-1" }
    expect(registry.validateArguments("close_subagent", validClose)).toBe(true)
    expect(registry.validateArguments("agent.close", validClose)).toBe(true)
    for (const key of ["userId", "sessionId", "ownerId", "path", "rootTaskId", "expectedOutputSchema"]) {
      expect(registry.validateArguments("spawn_subagent", { ...valid, [key]: "forged" })).not.toBe(true)
    }
    expect(registry.validateArguments("spawn_subagent", { ...valid, extra: true })).not.toBe(true)
    expect(registry.validateArguments("wait_subagents", { idempotencyKey: "wait-1", taskIds: ["task-1"], mode: "any", timeoutMs: 30_001 })).not.toBe(true)
  })

  it("requires the explicit unstarted-replacement mode and bounded revision as a pair", () => {
    const registry = new ToolRegistry(createCoordinationTools(options))
    const legacy = { idempotencyKey: "followup-legacy", taskId: "task-1", goal: "Continue" }
    const replacement = { ...legacy, idempotencyKey: "followup-replace", mode: "replace_unstarted", expectedRevision: 0 }

    expect(registry.validateArguments("agent.followup", legacy)).toBe(true)
    expect(registry.validateArguments("agent.followup", { ...replacement, expectedRevision: 2_147_483_644 })).toBe(true)
    expect(registry.validateArguments("agent.followup", { ...legacy, mode: "replace_unstarted" })).not.toBe(true)
    expect(registry.validateArguments("agent.followup", { ...legacy, expectedRevision: 0 })).not.toBe(true)
    for (const expectedRevision of [-1, 1.5, 2_147_483_645, null]) {
      expect(registry.validateArguments("agent.followup", { ...replacement, expectedRevision })).not.toBe(true)
    }
    expect(registry.validateArguments("agent.followup", { ...replacement, mode: null })).not.toBe(true)
    expect(registry.validateArguments("agent.followup", { ...replacement, mode: "replace_any" })).not.toBe(true)
    for (const authorityField of ["ownerId", "rootTaskId", "parentTaskId", "expectedOutputSchema"]) {
      expect(registry.validateArguments("agent.followup", { ...replacement, [authorityField]: "forged" })).not.toBe(true)
    }
    expect(registry.validateArguments("agent.followup", { ...replacement, constraints: ["caller-controlled"] })).not.toBe(true)
    expect(registry.validateArguments("agent.followup", { ...replacement, successCriteria: ["caller-controlled"] })).not.toBe(true)
    expect(registry.list().map(tool => tool.name).filter(name => name.includes("replace"))).toEqual([])
  })

  it("allows server-derived root invocation keys while enforcing explicit keys on other writes", () => {
    const validator = new ToolSchemaValidator()
    const definitions = createCoordinationTools(options)
    const invalidInputs: Record<string, Record<string, unknown>> = {
      send_message: { taskId: "task-1", kind: "result", payload: {} },
      "agent.send": { taskId: "task-1", kind: "result", payload: {} },
      wait_subagents: { taskIds: ["task-1"], mode: "all", timeoutMs: 1000 },
      "agent.wait": { taskIds: ["task-1"], mode: "all", timeoutMs: 1000 },
      list_subagents: { unexpected: true },
      "agent.list": { unexpected: true },
      interrupt_subagent: {},
      "agent.interrupt": {},
      close_subagent: {},
      "agent.close": {},
    }
    for (const definition of definitions) {
      const invalid = invalidInputs[definition.name]
      if (invalid) expect(() => validator.validate(definition.inputSchema, invalid, `${definition.name} input`)).toThrow(/schema validation/)
    }
    expect(() => validator.validate(definitions.find(item => item.name === "agent.spawn")!.inputSchema, { role: "scout", taskType: "inspect", goal: "Inspect" }, "agent.spawn input")).not.toThrow()
    expect(() => validator.validate(definitions.find(item => item.name === "agent.followup")!.inputSchema, { taskId: "task-1", goal: "Continue" }, "agent.followup input")).not.toThrow()
  })
})
