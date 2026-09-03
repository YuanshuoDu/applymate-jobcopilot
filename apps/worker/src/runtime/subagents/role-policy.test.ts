import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { describe, expect, it } from "vitest"

import { getSubagentRolePolicy, preflightSubagentTool, visibleSubagentTools, visibleToolPolicy } from "./role-policy.js"
import type { RuntimeToolDefinition } from "../tools/types.js"

function tool(name: string, risk: RuntimeToolDefinition["risk"], domain: RuntimeToolDefinition["domain"]): RuntimeToolDefinition {
  return {
    schemaVersion, name, version: "1", description: name, capabilities: [risk === "read" ? "read" : "external_write"],
    inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Object({}, { additionalProperties: false }),
    risk, domain, idempotency: risk === "read" ? "read_only" : "non_repeatable", timeoutMs: 1_000, requiredCapabilities: [],
    execute: async () => ({}),
  }
}

describe("subagent role policy", () => {
  it("gives Auditor a read-only evidence policy", () => {
    expect(getSubagentRolePolicy("auditor")).toMatchObject({ allowedRisks: ["read"], externalWritesEnabled: false })
    expect(visibleToolPolicy("auditor", tool("events.read", "read", "coordination")).visible).toBe(true)
    expect(visibleToolPolicy("auditor", tool("application.submit", "external_write", "application")).reason).toBe("external_write_disabled")
  })

  it("keeps Executor visibility dynamic but never exposes external writes", () => {
    const definitions = [tool("application.get_state", "read", "application"), tool("application.submit", "external_write", "application"), tool("gmail.send", "external_write", "gmail")]
    const mislabeled = tool("application.submit", "read", "application")
    const receipt = { toolName: "application.submit", toolVersion: "1", expiresAt: new Date(Date.now() + 30_000).toISOString() }
    expect(visibleSubagentTools("executor", definitions).map(item => item.name)).toEqual(["application.get_state"])
    expect(visibleSubagentTools("executor", definitions, receipt).map(item => item.name)).toEqual(["application.get_state"])
    expect(preflightSubagentTool("executor", definitions[1], receipt)).toMatchObject({ allowed: false, execute: false, externalWriteBlocked: true, reasonCode: "external_write_disabled" })
    expect(preflightSubagentTool("executor", mislabeled)).toMatchObject({ allowed: false, execute: false, externalWriteBlocked: true, reasonCode: "external_write_disabled" })
  })

  it("fails closed for an unknown role and missing tools", () => {
    expect(visibleSubagentTools("future-role", [tool("jobs.search", "read", "jobs")])).toEqual([])
    expect(preflightSubagentTool("executor", null)).toMatchObject({ allowed: false, execute: false })
  })
})
