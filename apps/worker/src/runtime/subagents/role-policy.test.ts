import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import { describe, expect, it } from "vitest"

import { APPLICATION_FILLER_ROLE, APPLICATION_FILLER_TASK_TYPE, APPLICATION_FILLER_TEMPLATE_ID, getSubagentRolePolicy, isApplicationFillerTemplate, isHarnessSubagentRole, preflightSubagentTool, visibleSubagentTools, visibleToolPolicy } from "./role-policy.js"
import type { RuntimeToolDefinition } from "../tools/types.js"

function tool(name: string, risk: RuntimeToolDefinition["risk"], domain: RuntimeToolDefinition["domain"]): RuntimeToolDefinition {
  return {
    schemaVersion, name, version: "1", description: name, capabilities: [risk === "read" ? "read" : "external_write"],
    inputSchema: Type.Object({}, { additionalProperties: false }), outputSchema: Type.Object({}, { additionalProperties: false }),
    risk, domain, idempotency: risk === "read" ? "read_only" : "non_repeatable", timeoutMs: 1_000, requiredCapabilities: [],
    execute: async () => ({}),
  }
}

function discoverTool(overrides: Partial<RuntimeToolDefinition> = {}): RuntimeToolDefinition {
  return {
    ...tool("jobs.discover", "internal_write", "jobs"),
    version: "1", capabilities: ["read", "write"], requiredCapabilities: ["read"], idempotency: "requires_key",
    ...overrides,
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

  it.each(["scout", "analyst", "prepare", "writer", "reviewer", "auditor", "executor"] as const)("denies outcome summaries to the %s role", role => {
    const outcomes = tool("application.outcomes_summary", "read", "application")
    expect(visibleToolPolicy(role, outcomes)).toEqual({ visible: false, reason: "root_only_tool" })
    expect(visibleSubagentTools(role, [outcomes])).toEqual([])
    expect(preflightSubagentTool(role, outcomes)).toMatchObject({ allowed: false, execute: false, reasonCode: "root_only_tool" })
  })

  it("fails closed for an unknown role and missing tools", () => {
    expect(visibleSubagentTools("future-role", [tool("jobs.search", "read", "jobs")])).toEqual([])
    expect(preflightSubagentTool("executor", null)).toMatchObject({ allowed: false, execute: false })
  })

  it("allows only the exact jobs.discover internal-write tuple to generic Scout", () => {
    const discover = discoverTool()
    expect(visibleToolPolicy("scout", discover)).toEqual({ visible: true, reason: "role_allowed" })
    expect(preflightSubagentTool("scout", discover)).toMatchObject({ allowed: true, execute: false, reasonCode: "role_allowed" })

    for (const role of ["analyst", "writer", "reviewer", "auditor", "executor"] as const) {
      expect(visibleToolPolicy(role, discover).visible).toBe(false)
      expect(visibleSubagentTools(role, [discover])).toEqual([])
    }
    for (const invalid of [
      { ...discover, version: "2" },
      { ...discover, risk: "read" as const },
      { ...discover, domain: "persona" as const },
      { ...discover, capabilities: ["read"] as const },
      { ...discover, capabilities: ["read", "external_write"] as const },
      { ...discover, requiredCapabilities: ["read", "write"] },
      { ...discover, name: "jobs.lookup" },
    ]) {
      expect(visibleToolPolicy("scout", invalid).visible).toBe(false)
    }
    expect(visibleToolPolicy("scout", discoverTool({ name: "jobs.search" })).visible).toBe(false)
  })

  it("registers Application Filler as a server-owned role with no model-visible tools", () => {
    expect(getSubagentRolePolicy(APPLICATION_FILLER_ROLE)).toMatchObject({
      role: APPLICATION_FILLER_ROLE, actorRole: "subagent", capabilities: [], allowedRisks: [], allowedDomains: [],
      canManageChildren: false, externalWritesEnabled: false,
    })
    expect(isHarnessSubagentRole(APPLICATION_FILLER_ROLE)).toBe(false)
    expect(isApplicationFillerTemplate(APPLICATION_FILLER_TEMPLATE_ID, APPLICATION_FILLER_ROLE, APPLICATION_FILLER_TASK_TYPE)).toBe(true)
    expect(isApplicationFillerTemplate("caller_template", APPLICATION_FILLER_ROLE, APPLICATION_FILLER_TASK_TYPE)).toBe(false)
    expect(visibleSubagentTools(APPLICATION_FILLER_ROLE, [tool("application.get_state", "read", "application")])).toEqual([])
  })

  it("hides every canonical and legacy coordination tool from children", () => {
    const names = [
      "spawn_subagent", "agent.spawn", "agent.followup", "send_message", "agent.send",
      "wait_subagents", "agent.wait", "list_subagents", "agent.list",
      "interrupt_subagent", "agent.interrupt", "close_subagent", "agent.close",
    ]
    for (const name of names) {
      const risk = name === "list_subagents" || name === "agent.list" ? "read" : "internal_write"
      expect(visibleToolPolicy("reviewer", tool(name, risk, "coordination"))).toMatchObject({ visible: false, reason: "coordination_disabled" })
    }
    expect(visibleToolPolicy("reviewer", tool("jobs.search", "read", "jobs")).visible).toBe(true)
  })

  it.each(["root", "orchestrator", "admin", "elevated", "future-role", "toString", "constructor", "__proto__"])("rejects unsupported harness role %s", role => {
    expect(isHarnessSubagentRole(role)).toBe(false)
    expect(getSubagentRolePolicy(role)).toBeNull()
  })

  it("hides coordination tools even when their domain is otherwise visible", () => {
    expect(visibleToolPolicy("reviewer", tool("spawn_subagent", "internal_write", "coordination")).reason).toBe("coordination_disabled")
    expect(visibleToolPolicy("reviewer", tool("wait_subagents", "read", "coordination")).visible).toBe(false)
  })

  it("allows only the versioned Reviewer artifact.review receipt through draft_write", () => {
    const review = {
      ...tool("artifact.review", "draft_write", "resume"),
      version: "1",
      capabilities: ["read", "write"] as const,
      idempotency: "requires_key" as const,
      requiredCapabilities: [],
    }
    expect(visibleToolPolicy("reviewer", review)).toEqual({ visible: true, reason: "bounded_review_receipt_allowed" })
    expect(preflightSubagentTool("reviewer", review)).toMatchObject({
      allowed: true, execute: false, externalWriteBlocked: false, reasonCode: "bounded_review_receipt_allowed",
    })

    for (const other of [
      { ...review, name: "cover_letter.draft" },
      { ...review, version: "2" },
      { ...review, domain: "application" as const },
      { ...review, capabilities: ["read", "write", "external_write"] },
    ]) {
      expect(visibleToolPolicy("reviewer", other).visible).toBe(false)
    }
    expect(visibleToolPolicy("writer", review).visible).toBe(false)
  })

  it("allows the exact scheduled application preparation write only to Prepare", () => {
    const prepare = {
      ...tool("scheduled.application.prepare", "draft_write", "resume"),
      version: "1", capabilities: ["read", "write"] as const, idempotency: "requires_key" as const, requiredCapabilities: [],
    }
    expect(getSubagentRolePolicy("prepare")).toMatchObject({
      role: "prepare", capabilities: ["read"], allowedRisks: [], allowedDomains: ["resume"], externalWritesEnabled: false,
    })
    expect(isHarnessSubagentRole("prepare")).toBe(true)
    expect(visibleToolPolicy("prepare", prepare)).toEqual({ visible: true, reason: "role_allowed" })
    expect(preflightSubagentTool("prepare", prepare)).toMatchObject({ allowed: true, execute: false, externalWriteBlocked: false })

    for (const role of ["scout", "analyst", "writer", "reviewer", "auditor", "executor"] as const) {
      expect(visibleToolPolicy(role, prepare).visible).toBe(false)
    }
    for (const invalid of [
      { ...prepare, version: "2" },
      { ...prepare, risk: "read" as const },
      { ...prepare, domain: "application" as const },
      { ...prepare, capabilities: ["read"] as const },
      { ...prepare, capabilities: ["read", "write", "external_write"] as const },
      { ...prepare, requiredCapabilities: ["read"] },
    ]) {
      expect(visibleToolPolicy("prepare", invalid).visible).toBe(false)
    }
    expect(visibleSubagentTools("prepare", [
      prepare,
      { ...prepare, name: "cover_letter.draft" },
      { ...prepare, name: "artifact.review" },
      tool("application.get_state", "read", "application"),
    ]).map(item => item.name)).toEqual(["scheduled.application.prepare"])
  })

  it("keeps Reviewer actions limited to reads and the internal review receipt", () => {
    const review = {
      ...tool("artifact.review", "draft_write", "resume"),
      version: "1", capabilities: ["read", "write"] as const, idempotency: "requires_key" as const, requiredCapabilities: [],
    }
    const definitions = [
      review,
      tool("artifact.version.read", "read", "resume"),
      { ...review, name: "cover_letter.draft" },
      tool("application.submit", "external_write", "application"),
      tool("gmail.send", "external_write", "unknown"),
    ]
    expect(visibleSubagentTools("reviewer", definitions).map(item => item.name)).toEqual([
      "artifact.review", "artifact.version.read",
    ])
  })
})
