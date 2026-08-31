import { describe, expect, it, vi } from "vitest"

import { createReadOnlyTools, type ReadToolDataSource } from "./read-tools.js"

function source(): ReadToolDataSource {
  return {
    searchJobs: vi.fn(async () => ({ jobs: [], page: 1, hasMore: false })),
    getJob: vi.fn(async () => null),
    retrievePersona: vi.fn(async () => ({ facts: [] })),
    getBaseResume: vi.fn(async () => ({ resume: null })),
    getApplicationState: vi.fn(async () => ({ job: null, task: null, approvals: [] })),
  }
}

describe("read-only tool definitions", () => {
  it("registers the four domain capabilities without exposing a model userId", async () => {
    const dataSource = source()
    const tools = createReadOnlyTools(dataSource)
    const context = { scope: { userId: "owner-a" }, sessionId: "session", turnId: "turn", stepId: "step", signal: new AbortController().signal, capabilities: [], reportProgress: vi.fn(async () => {}) }

    expect(tools.map((tool) => tool.name)).toEqual(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base", "application.get_state"])
    expect(tools.every((tool) => tool.risk === "read" && tool.capabilities.includes("read") && tool.idempotency === "read_only")).toBe(true)
    await tools[0].execute(context, {})
    await tools[1].execute(context, { jobId: "job-1" })
    await tools[2].execute(context, {})
    await tools[3].execute(context, {})
    await tools[4].execute(context, { jobId: "job-1" })
    for (const method of Object.values(dataSource)) expect(method).toHaveBeenCalledWith("owner-a", expect.anything())
  })
})
