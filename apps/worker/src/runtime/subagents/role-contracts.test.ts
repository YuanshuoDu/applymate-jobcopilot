import { describe, expect, it, vi } from "vitest"

import { ANALYST_ROLE_CONTRACT, SCOUT_ROLE_CONTRACT, assertRoleActionAllowed, assertRoleToolAllowed, ROLE_TOOL_CONTRACTS } from "./role-contracts.js"

describe("migrated role contracts", () => {
  it("keeps Scout and Analyst on explicit read-only allowlists", () => {
    expect(SCOUT_ROLE_CONTRACT.allowedTools).toEqual(["jobs.search", "jobs.get"])
    expect(ANALYST_ROLE_CONTRACT.allowedTools).toEqual(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"])
    expect(SCOUT_ROLE_CONTRACT.forbiddenCapabilities).toEqual(["write", "external_write", "browser"])
    expect(Object.values(ROLE_TOOL_CONTRACTS).every(tool => tool.risk === "read" && tool.capabilities.includes("read"))).toBe(true)
  })

  it("rejects capability-positive actions for both roles", () => {
    expect(() => assertRoleActionAllowed("analyst", { name: "application.submit", risk: "external_write", capabilities: ["external_write", "browser"] })).toThrow(/cannot use/)
    expect(() => assertRoleToolAllowed("scout", { ...ROLE_TOOL_CONTRACTS["persona.retrieve"] })).toThrow(/cannot use persona.retrieve/)
    expect(() => assertRoleActionAllowed("scout", { name: "browser.fill", risk: "internal_write", capabilities: ["browser", "write"] })).toThrow()
  })

  it("does not invoke a downstream executor after a denied action", async () => {
    const executor = vi.fn(async () => undefined)
    expect(() => assertRoleActionAllowed("analyst", { name: "resume.draft", risk: "draft_write", capabilities: ["write"] })).toThrow()
    expect(executor).not.toHaveBeenCalled()
  })
})
