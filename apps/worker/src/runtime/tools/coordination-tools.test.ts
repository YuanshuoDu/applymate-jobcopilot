import { describe, expect, it } from "vitest"

import { AgentTreeManager } from "../subagents/manager.js"
import { ToolRegistry } from "./registry.js"
import { ToolSchemaValidator } from "./schema-validator.js"
import { createCoordinationTools } from "./coordination-tools.js"
import { TASK_GRAPH_RESULT_PAGE_SCHEMA } from "../subagents/task-graph-result-page-contract.js"
import { TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA } from "../subagents/task-graph-historical-discovery-page-contract.js"
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
    expect(legacyList?.description).toBe("List visible tasks in the current session and task tree")
    expect(canonicalList).toMatchObject({
      schemaVersion: legacyList?.schemaVersion,
      version: legacyList?.version,
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
    expect(registry.resolve("list_subagents", "1").description).toBe("List visible tasks in the current session and task tree")
    const listDescription = registry.resolve("agent.list", "1").description
    expect(listDescription).toContain("Choose exactly one mode")
    expect(listDescription).toContain("offset 0")
    expect(listDescription).toContain("exact returned nextOffset")
    expect(listDescription).toContain("same nodeKey and expectedRevision")
    expect(listDescription).toContain("exact returned nextOffset on that same nodeKey and expectedRevision while it is non-null")
    expect(listDescription).toContain("at most three items")
    expect(listDescription).toContain("totalCount/evidenceCount describe only this node's source")
    expect(listDescription).toContain("Use those reported counts rather than page length")
    expect(listDescription).toContain("ends paging for this node at this revision only; it does not establish task or verification completion")
    expect(listDescription).toContain("stale or unavailable, refresh current state")
    expect(listDescription).toContain("Never invent offsets, silently switch modes")
    expect(listDescription).toContain("verification proof")
    expect(listDescription).toContain("historical_discovery")
    expect(listDescription).toContain("fresh ordinary Scout must read each through jobs.get")
    expect(listDescription).toContain("truncated=false does not establish historical search completeness")
    expect(listDescription).toContain("Never supply old Turn/task/node IDs")
    const spawnDescription = registry.resolve("agent.spawn", "1").description
    const followupDescription = registry.resolve("agent.followup", "1").description
    expect(spawnDescription).toContain("eight-node lifetime cap separate from active-child concurrency")
    expect(spawnDescription).toContain("task_graph_current.nodeCapacity")
    expect(spawnDescription).toContain("nodeCount, maxNodes, remaining, ordinaryRemaining, reserveActive, and repairRecorded")
    expect(spawnDescription).toContain("leave the final slot for one exact failed-criterion repair")
    expect(spawnDescription).toContain("An accepted repair sets repairRecorded and consumes the reserve")
    expect(followupDescription).toContain("replacement retains its canceled source and appends its successor")
    expect(followupDescription).toContain("An accepted repair relation consumes the one reserve even if queued or failed")
    expect(followupDescription).toContain("does not make its target successful or guarantee another retry")
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

  it("accepts only the source-bound historical discovery mode on agent.list", () => {
    const definitions = createCoordinationTools(options)
    const registry = new ToolRegistry(definitions)
    const token = "a".repeat(64)
    expect(registry.validateArguments("agent.list", { mode: "historical_discovery", offset: 0 })).toBe(true)
    expect(registry.validateArguments("agent.list", { mode: "historical_discovery", offset: 0, sourceToken: token })).toBe(true)
    expect(registry.validateArguments("agent.list", { mode: "historical_discovery", offset: 3, sourceToken: token })).toBe(true)
    for (const invalid of [
      { mode: "historical_discovery", offset: 3 }, { mode: "historical_discovery", offset: 0, sourceToken: "forged" },
      { mode: "historical_discovery", offset: 0, sourceToken: token, turnId: "old-turn" },
      { mode: "historical_discovery", offset: 0, sourceToken: token, taskId: "old-task" },
      { mode: "historical_discovery", offset: 0, sourceToken: token, nodeKey: "old-node" },
    ]) expect(registry.validateArguments("agent.list", invalid)).not.toBe(true)
    expect(registry.validateArguments("list_subagents", { mode: "historical_discovery", offset: 0 })).not.toBe(true)
    const page = {
      schemaVersion: TASK_GRAPH_HISTORICAL_DISCOVERY_PAGE_SCHEMA, trust: "untrusted", availability: "available",
      observation: "historical_discovery", verificationStatus: "unverified", sourceToken: token,
      sourceResultStatus: "completed", offset: 0, nextOffset: null, totalCount: 1, truncated: false,
      items: [{ jobId: "00000000-0000-4000-8000-000000000000" }],
    }
    expect(() => registry.validators.validate(definitions.find(tool => tool.name === "agent.list")!.outputSchema, page, "agent.list output")).not.toThrow()
    expect(() => registry.validators.validate(definitions.find(tool => tool.name === "list_subagents")!.outputSchema, page, "list_subagents output")).toThrow()
  })

  it("accepts exact legacy or complete current wait task outputs with canonical timestamps", () => {
    const registry = new ToolRegistry(createCoordinationTools(options))
    const schema = registry.resolve("agent.wait", "1").outputSchema
    const legacy = {
      waitId: "wait-1", status: "timed_out", taskIds: ["task-1"], deadlineAt: "2026-10-12T10:15:00.000Z",
      matchedTaskIds: [], tasks: [{ taskId: "task-1", status: "retrying", role: "scout", result: null, failureReason: null }],
    }
    const current = {
      ...legacy,
      tasks: [{ ...legacy.tasks[0]!, attemptCount: 2, maxAttempts: 4,
        leaseExpiresAt: "2026-10-12T10:15:30.000Z", interruptRequestedAt: null }],
    }
    expect(() => registry.validators.validate(schema, legacy, "agent.wait output")).not.toThrow()
    expect(() => registry.validators.validate(schema, current, "agent.wait output")).not.toThrow()
    expect(Object.keys(legacy.tasks[0]!)).toHaveLength(5)
    expect(Object.keys(current.tasks[0]!)).toHaveLength(9)

    const extendedTimestamps = [
      new Date(Date.UTC(10_000, 0, 1)).toISOString(),
      new Date("-000001-01-01T00:00:00.000Z").toISOString(),
      new Date("+010000-02-29T00:00:00.000Z").toISOString(),
      new Date("-000004-02-29T00:00:00.000Z").toISOString(),
      new Date("+275760-09-13T00:00:00.000Z").toISOString(),
      new Date("-271821-04-20T00:00:00.000Z").toISOString(),
      new Date("-271821-04-20T00:00:00.001Z").toISOString(),
      new Date("-271821-04-20T12:00:00.000Z").toISOString(),
      new Date("-271821-04-20T23:59:59.999Z").toISOString(),
    ]
    expect(extendedTimestamps).toEqual([
      "+010000-01-01T00:00:00.000Z",
      "-000001-01-01T00:00:00.000Z",
      "+010000-02-29T00:00:00.000Z",
      "-000004-02-29T00:00:00.000Z",
      "+275760-09-13T00:00:00.000Z",
      "-271821-04-20T00:00:00.000Z",
      "-271821-04-20T00:00:00.001Z",
      "-271821-04-20T12:00:00.000Z",
      "-271821-04-20T23:59:59.999Z",
    ])

    for (const field of ["leaseExpiresAt", "interruptRequestedAt"] as const) {
      for (const value of ["2026-10-12T10:15:30.000Z", "2024-02-29T10:15:30.000Z", "2000-02-29T10:15:30.000Z", ...extendedTimestamps, null]) {
        const task = { ...current.tasks[0]!, [field]: value }
        expect(() => registry.validators.validate(schema, { ...current, tasks: [task] }, "agent.wait output")).not.toThrow()
      }
      for (const value of [
        "not-a-date",
        "2026-10-12T10:15:30Z",
        "2026-10-12T10:15:30.000+00:00",
        "2026-10-12T10:15:30.000Z\n",
        "+000001-01-01T00:00:00.000Z",
        "-000000-01-01T00:00:00.000Z",
        "+010000-02-30T00:00:00.000Z",
        "+275761-01-01T00:00:00.000Z",
        "+275760-09-13T00:00:00.001Z",
        "-271822-04-20T00:00:00.000Z",
        "-271821-04-19T23:59:59.999Z",
        "2026-02-30T10:15:30.000Z",
        "2026-02-29T10:15:30.000Z",
        "1900-02-29T10:15:30.000Z",
      ]) {
        const task = { ...current.tasks[0]!, [field]: value }
        expect(() => registry.validators.validate(schema, { ...current, tasks: [task] }, "agent.wait output")).toThrow()
      }
    }

    for (const task of [
      { ...current.tasks[0]!, interruptRequestedAt: undefined },
      { ...current.tasks[0]!, attemptCount: -1 },
      { ...current.tasks[0]!, maxAttempts: 0 },
      { ...current.tasks[0]!, leaseExpiresAt: 123 },
      { ...current.tasks[0]!, leaseOwner: "private-lease-owner" },
    ]) {
      expect(() => registry.validators.validate(schema, { ...current, tasks: [task] }, "agent.wait output")).toThrow()
    }
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
