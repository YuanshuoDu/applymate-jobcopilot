import { describe, expect, it, vi } from "vitest"

import { OUTCOME_JOB_SOURCES, createReadOnlyTools, type ApplicationOutcomesSummaryResult, type ReadToolDataSource } from "./read-tools.js"

const expectedOutcomeSources = ["adzuna", "agent", "ashby", "ats", "cleanjobdata", "fantasticjobs", "gmail", "greenhouse", "indeed", "irishjobs", "jsearch", "lever", "linkedin", "manual", "other_or_unknown", "personio", "smartrecruiters", "workday"] as const

const emptySummary: ApplicationOutcomesSummaryResult = {
  schemaVersion: 2, advisoryOnly: true,
  coverage: { basis: "latest_100_jobs_by_updatedAt", jobCount: 0, truncated: false },
  jobStatusCounts: { saved: 0, applied: 0, interview: 0, offer: 0, rejected: 0 },
  linkedJobsByGmailKind: { application_received: 0, interview_invitation: 0, offer: 0, rejection: 0, application_update: 0 },
  gmailSemantics: { classification: "heuristic_advisory_only", matchConfidence: "job_linkage_only" },
  sourceBreakdown: { basis: "same_latest_100_jobs_by_updatedAt", minimumAppliedOrBeyondJobCount: 10, groups: [], suppressedGroupCount: 0, semantics: "descriptive_source_association_only" },
}

function source(): ReadToolDataSource & Required<Pick<ReadToolDataSource, "getOutcomesSummary">> {
  return {
    searchJobs: vi.fn(async () => ({ jobs: [], page: 1, hasMore: false })),
    getJob: vi.fn(async () => null),
    retrievePersona: vi.fn(async () => ({ facts: [] })),
    getBaseResume: vi.fn(async () => ({ resume: null })),
    getApplicationState: vi.fn(async () => ({ job: null, task: null, approvals: [] })),
    getOutcomesSummary: vi.fn(async () => emptySummary),
  }
}

const rootContext = {
  scope: { userId: "owner-a" }, actorRole: "orchestrator" as const,
  sessionId: "session", turnId: "turn", stepId: "step", signal: new AbortController().signal,
  capabilities: [], reportProgress: vi.fn(async () => {}),
}

describe("read-only tool definitions", () => {
  it("registers the domain capabilities without exposing a model userId", async () => {
    const dataSource = source()
    const tools = createReadOnlyTools(dataSource)

    expect(tools.map((tool) => tool.name)).toEqual([
      "jobs.search", "jobs.get", "persona.retrieve", "resume.get_base", "application.get_state", "application.outcomes_summary",
    ])
    expect(tools.every((tool) => tool.risk === "read" && tool.capabilities.includes("read") && tool.idempotency === "read_only")).toBe(true)
    await tools[0].execute(rootContext, {})
    await tools[1].execute(rootContext, { jobId: "job-1" })
    await tools[2].execute(rootContext, {})
    await tools[3].execute(rootContext, {})
    await tools[4].execute(rootContext, { jobId: "job-1" })
    await tools[5].execute(rootContext, {})
    for (const method of [dataSource.searchJobs, dataSource.getJob, dataSource.retrievePersona, dataSource.getBaseResume, dataSource.getApplicationState]) {
      expect(method).toHaveBeenCalledWith("owner-a", expect.anything())
    }
    expect(dataSource.getOutcomesSummary).toHaveBeenCalledWith("owner-a")
  })

  it("advertises the strict v2 no-argument contract, fixed semantics, and bounded counts", async () => {
    const tool = createReadOnlyTools(source()).find((item) => item.name === "application.outcomes_summary")
    if (!tool) throw new Error("outcomes_summary_tool_missing")
    expect(tool.description).toContain("general career or application planning")
    expect(tool.description).toContain("advisory only")
    expect(tool.inputSchema).toMatchObject({ type: "object", properties: {}, additionalProperties: false })
    expect(tool.outputSchema).toMatchObject({
      type: "object", additionalProperties: false,
      properties: {
        schemaVersion: { const: 2 }, advisoryOnly: { const: true },
        coverage: { additionalProperties: false, properties: { basis: { const: "latest_100_jobs_by_updatedAt" }, jobCount: { minimum: 0, maximum: 100 } } },
        gmailSemantics: { additionalProperties: false, properties: { classification: { const: "heuristic_advisory_only" }, matchConfidence: { const: "job_linkage_only" } } },
        sourceBreakdown: {
          additionalProperties: false,
          properties: {
            basis: { const: "same_latest_100_jobs_by_updatedAt" },
            minimumAppliedOrBeyondJobCount: { const: 10 },
            groups: { minItems: 0, maxItems: 18 },
            suppressedGroupCount: { minimum: 0, maximum: 18 },
            semantics: { const: "descriptive_source_association_only" },
          },
        },
      },
    })
    const output = await tool.execute(rootContext, {}) as ApplicationOutcomesSummaryResult
    expect(output).toEqual(emptySummary)
    expect(Object.keys(output)).toEqual(["schemaVersion", "advisoryOnly", "coverage", "jobStatusCounts", "linkedJobsByGmailKind", "gmailSemantics", "sourceBreakdown"])
    for (const nested of [tool.outputSchema.properties.coverage, tool.outputSchema.properties.jobStatusCounts, tool.outputSchema.properties.linkedJobsByGmailKind, tool.outputSchema.properties.gmailSemantics, tool.outputSchema.properties.sourceBreakdown]) {
      expect(nested.additionalProperties).toBe(false)
    }
    const sourceBreakdown = tool.outputSchema.properties.sourceBreakdown
    const groupSchema = sourceBreakdown.properties.groups.items
    expect(groupSchema.additionalProperties).toBe(false)
    for (const nested of [groupSchema.properties.jobStatusCounts, groupSchema.properties.linkedJobsByGmailKind]) expect(nested.additionalProperties).toBe(false)
    expect(OUTCOME_JOB_SOURCES).toEqual(expectedOutcomeSources)
    expect(groupSchema.properties.source.anyOf.map((item: { const: string }) => item.const)).toEqual(expectedOutcomeSources)
    for (const counts of [tool.outputSchema.properties.jobStatusCounts, tool.outputSchema.properties.linkedJobsByGmailKind, groupSchema.properties.jobStatusCounts, groupSchema.properties.linkedJobsByGmailKind]) {
      for (const count of Object.values(counts.properties)) expect(count).toMatchObject({ type: "integer", minimum: 0, maximum: 100 })
    }
  })

  it("fails closed for any subagent actor", async () => {
    const dataSource = source()
    const tool = createReadOnlyTools(dataSource).find((item) => item.name === "application.outcomes_summary")
    if (!tool) throw new Error("outcomes_summary_tool_missing")
    await expect(tool.execute({ ...rootContext, actorRole: "subagent" }, {})).rejects.toMatchObject({ code: "application_outcomes_summary_root_only" })
    expect(dataSource.getOutcomesSummary).not.toHaveBeenCalled()
  })

  it("fails closed when the runtime actor role is missing", async () => {
    const dataSource = source()
    const tool = createReadOnlyTools(dataSource).find((item) => item.name === "application.outcomes_summary")
    if (!tool) throw new Error("outcomes_summary_tool_missing")
    const { actorRole: _actorRole, ...context } = rootContext
    await expect(tool.execute(context, {})).rejects.toMatchObject({ code: "application_outcomes_summary_root_only" })
    expect(dataSource.getOutcomesSummary).not.toHaveBeenCalled()
  })

  it("returns an explicit unavailable error when the summary reader is not wired", async () => {
    const dataSource = source() as ReadToolDataSource
    delete dataSource.getOutcomesSummary
    const tool = createReadOnlyTools(dataSource).find((item) => item.name === "application.outcomes_summary")
    if (!tool) throw new Error("outcomes_summary_tool_missing")
    await expect(tool.execute(rootContext, {})).rejects.toMatchObject({ code: "application_outcomes_summary_unavailable" })
  })
})
