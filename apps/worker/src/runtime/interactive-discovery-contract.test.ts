import { describe, expect, it } from "vitest"

import {
  failedInteractiveDiscoveryShortlist, interactiveDiscoveryRootToolAllowed, parseInteractiveDiscoveryShortlist,
  rootToolNames, rootToolSurface, terminalInteractiveDiscoveryShortlist, validInteractiveDiscoveryShortlist, validTerminalInteractiveDiscoveryShortlist,
} from "./interactive-discovery-contract.js"

const completed = { schemaVersion: 1, status: "completed", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }], failures: [] }

describe("interactive discovery contract", () => {
  it("accepts only a bounded, ordered, evidence-bearing result", () => {
    expect(parseInteractiveDiscoveryShortlist(completed)).toEqual(completed)
    expect(validInteractiveDiscoveryShortlist(completed)).toBe(true)
    expect(parseInteractiveDiscoveryShortlist({ ...completed, rawOutput: "private" })).toBeUndefined()
    expect(parseInteractiveDiscoveryShortlist({ ...completed, items: [{ ...completed.items[0], evidenceIds: [] }] })).toBeUndefined()
  })

  it("restricts the root tools and preserves accepted items as partial on terminal failure", () => {
    expect(["agent.plan", "agent.wait", "agent.list", "list_subagents"].every(interactiveDiscoveryRootToolAllowed)).toBe(true)
    expect(interactiveDiscoveryRootToolAllowed("jobs.search")).toBe(false)
    const tools = [{ name: "agent.plan" }, { name: "jobs.search" }, { name: "selected.read" }]
    expect(rootToolNames(rootToolSurface(tools, false, true, tool => tool.name === "selected.read"))).toEqual(["agent.plan"])
    expect(rootToolNames(rootToolSurface(tools, true, false, tool => tool.name === "selected.read"))).toEqual(["selected.read"])
    expect(terminalInteractiveDiscoveryShortlist("failed", completed)).toEqual({
      ...completed, status: "partial", failures: ["discovery_runtime_failed"],
    })
    expect(terminalInteractiveDiscoveryShortlist("waiting_for_dependency", completed)).toBeUndefined()
  })

  it("creates explicit safe terminal failures without converting them to success", () => {
    const failed = failedInteractiveDiscoveryShortlist("discovery_runtime_unavailable")
    expect(validTerminalInteractiveDiscoveryShortlist(failed)).toBe(true)
    expect(validInteractiveDiscoveryShortlist(failed)).toBe(false)
    expect(parseInteractiveDiscoveryShortlist({ ...failed, items: [completed.items[0]] })).toBeUndefined()
  })

  it("accepts bounded role-specific task failure codes", () => {
    const failed = {
      schemaVersion: 1, status: "failed", items: [], failures: ["scout_task_failed", "analyst_task_incomplete"],
    }
    expect(parseInteractiveDiscoveryShortlist(failed)).toEqual(failed)
    expect(validTerminalInteractiveDiscoveryShortlist(failed)).toBe(true)
  })
})
