import { Type } from "@sinclair/typebox"
import { describe, expect, it } from "vitest"

import { ToolRegistry, ToolRegistryError } from "./registry.js"
import type { RuntimeToolDefinition } from "./types.js"

function definition(name = "test.read"): RuntimeToolDefinition {
  return {
    schemaVersion: "agent-harness.v2",
    name,
    version: "1",
    description: "A read-only test tool",
    capabilities: ["read"],
    inputSchema: Type.Object({ value: Type.String() }, { additionalProperties: false }),
    outputSchema: Type.Object({ ok: Type.Boolean() }, { additionalProperties: false }),
    risk: "read",
    idempotency: "read_only",
    timeoutMs: 100,
    requiredCapabilities: [],
    execute: async () => ({ ok: true }),
  }
}

describe("ToolRegistry", () => {
  it("resolves exact versions and exposes only model-safe metadata", () => {
    const registry = new ToolRegistry([definition()])
    expect(registry.resolve("test.read", "1").name).toBe("test.read")
    expect(registry.list()[0]).not.toHaveProperty("execute")
    expect(registry.list()[0]).toMatchObject({ name: "test.read", version: "1", risk: "read" })
    expect(registry.validateArguments("test.read", { value: "ok" })).toBe(true)
    expect(registry.validateArguments("test.read", { value: 7 })).toMatch(/failed schema validation/)
    expect(registry.validateArguments("test.read", { value: "ok", userId: "other" })).toMatch(/runtime scope/)
  })

  it("rejects duplicates, unknown names, version drift, and invalid read metadata", () => {
    expect(() => new ToolRegistry([definition(), definition()])).toThrowError(ToolRegistryError)
    const registry = new ToolRegistry([definition()])
    expect(() => registry.resolve("missing", "1")).toThrowError(/not registered/)
    expect(() => registry.resolve("test.read", "2")).toThrowError(/does not support version/)
    expect(() => new ToolRegistry([{ ...definition(), capabilities: ["write"] }])).toThrowError(/must declare read capability/)
  })
})
