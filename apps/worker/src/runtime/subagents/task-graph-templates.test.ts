import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_TEMPLATES, taskGraphRuntimeForTurn, taskGraphRuntimeOptions, taskGraphTemplatesForApplicationFill, taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { TaskGraphCommandPort } from "./task-graph-command-port.js"

describe("TaskGraph server-owned templates", () => {
  it("registers structured read-only Scout and Analyst roles for evidence chaining", () => {
    expect(TASK_GRAPH_TEMPLATES.scout).toMatchObject({
      role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search", "jobs.get", "jobs.discover", "tool_results.read"],
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    })
    expect(TASK_GRAPH_TEMPLATES.analyst).toMatchObject({
      role: "analyst", taskType: "job_analysis",
      allowedActions: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"],
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" },
    })
    for (const template of Object.values(TASK_GRAPH_TEMPLATES)) {
      expect(template.allowedActions).not.toContain("agent.plan")
      expect(template.allowedActions.some(action => /submit|send|publish|delete|mutate|execute/i.test(action))).toBe(false)
    }
  })

  it("passes the shared typed registry into canonical TaskGraph composition", () => {
    const commandPort = {} as TaskGraphCommandPort
    const runtimeOptions = taskGraphRuntimeOptions(commandPort)
    expect(runtimeOptions).toEqual({ taskGraphCommandPort: commandPort, taskGraphTemplates: TASK_GRAPH_TEMPLATES })
    expect(runtimeOptions.taskGraphTemplates.scout.expectedOutputSchema).toEqual({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout",
    })
    expect(runtimeOptions.taskGraphTemplates.analyst.expectedOutputSchema).toEqual({
      schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst",
    })
  })

  it("keeps selected-job evidence roles plannable without search and adds scoped Writer and Reviewer roles", () => {
    expect(Object.keys(taskGraphTemplatesForSelectedJob(undefined))).toEqual(["scout", "analyst"])
    const templates = taskGraphTemplatesForSelectedJob({ jobId: "job-1" })
    expect(templates.scout).toMatchObject({
      role: "scout", taskType: "job_discovery", allowedActions: ["jobs.get"],
      context: { selectedJobPreparation: { jobId: "job-1" } },
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    })
    expect(templates.scout.allowedActions).toEqual(["jobs.get"])
    expect(templates.analyst).toMatchObject({
      role: "analyst", taskType: "job_analysis",
      allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base"],
      context: { selectedJobPreparation: { jobId: "job-1" } },
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" },
    })
    expect(Object.keys(templates)).toEqual(["scout", "analyst", "cover_letter_writer", "cover_letter_reviewer"])
    expect(templates.scout.allowedActions).not.toContain("jobs.search")
    expect(templates.scout.allowedActions).not.toContain("jobs.discover")
    expect(templates.analyst.allowedActions).not.toContain("jobs.search")
    expect(templates.analyst.allowedActions).not.toContain("jobs.discover")
    expect(templates.cover_letter_writer).toMatchObject({
      role: "writer", taskType: "cover_letter_draft",
      allowedActions: ["cover_letter.draft"],
      context: { selectedJobPreparation: { jobId: "job-1" } },
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" },
    })
    expect(templates.cover_letter_reviewer).toMatchObject({
      role: "reviewer", taskType: "cover_letter_review",
      allowedActions: ["artifact.version.read", "artifact.review"],
      context: { selectedJobPreparation: { jobId: "job-1" } },
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer" },
    })
    for (const id of ["cover_letter_writer", "cover_letter_reviewer"]) {
      const template = templates[id]!
      expect(template.allowedActions).not.toContain("jobs.get")
      expect(template.allowedActions).not.toContain("persona.retrieve")
      expect(template.allowedActions).not.toContain("resume.get_base")
      expect(template.allowedActions).not.toContain("agent.plan")
      expect(template.allowedActions).not.toContain("application.submit")
      expect(template.allowedActions.some(action => /send|gmail|browser|submit/i.test(action))).toBe(false)
    }
  })

  it("returns selected-job mode only when the server-side preparation loader finds a selection", async () => {
    const base = {
      pool: {} as never, lease: {} as never, now: () => new Date(), enabled: true,
      applicationFillPreparationLoader: async () => undefined,
    }
    const selected = await taskGraphRuntimeForTurn({ ...base, selectedJobPreparationLoader: async () => ({ jobId: "job-1" }) })
    const generic = await taskGraphRuntimeForTurn({ ...base, selectedJobPreparationLoader: async () => undefined })

    expect(selected).toMatchObject({ enabled: true, selectedJobMode: true, selectedJobPreparation: { jobId: "job-1" } })
    expect(generic).toMatchObject({ enabled: true, selectedJobMode: false, selectedJobPreparation: undefined })
  })

  it("adds only the fixed identity-free Application Filler template after exact preparation", () => {
    const base = { scout: TASK_GRAPH_TEMPLATES.scout }
    const templates = taskGraphTemplatesForApplicationFill(base, { available: true })

    expect(Object.keys(templates ?? {})).toEqual(["scout", "application_filler"])
    expect(templates?.scout).toBe(base.scout)
    expect(templates?.application_filler).toMatchObject({
      role: "application_filler", taskType: "application_fill_for_review", allowedActions: [],
    })
    expect(templates?.application_filler).not.toHaveProperty("context")
    expect(templates?.application_filler).not.toHaveProperty("expectedOutputSchema")
    expect(templates?.application_filler?.allowedActions).toEqual([])
    expect(JSON.stringify(templates?.application_filler)).not.toMatch(/applicationTaskId|taskId|userId|sessionId|turnId/)
  })

  it("keeps generic templates unchanged and strips the reserved filler key without exact preparation", () => {
    const base = { scout: TASK_GRAPH_TEMPLATES.scout }
    expect(taskGraphTemplatesForApplicationFill(base, undefined)).toBe(base)
    const callerControlled = {
      ...base,
      application_filler: { role: "writer", taskType: "cover_letter_draft", allowedActions: ["cover_letter.draft"] },
    }
    const templates = taskGraphTemplatesForApplicationFill(callerControlled, undefined)
    expect(Object.keys(templates ?? {})).toEqual(["scout"])
  })

  it("uses the lease-fenced fill preparation loader and keeps generic templates when no fill is bound", async () => {
    const baseTemplates = { scout: TASK_GRAPH_TEMPLATES.scout }
    const base = {
      pool: {} as never, lease: {} as never, now: () => new Date(), enabled: true,
      taskGraphTemplates: baseTemplates,
      selectedJobPreparationLoader: async () => undefined,
    }
    const loader = vi.fn(async () => ({ available: true as const }))
    const available = await taskGraphRuntimeForTurn({ ...base, applicationFillPreparationLoader: loader })
    const absent = await taskGraphRuntimeForTurn({ ...base, applicationFillPreparationLoader: async () => undefined })

    expect(loader).toHaveBeenCalledWith(base.pool, base.lease, expect.any(Date))
    expect(available.templates?.application_filler).toMatchObject({ role: "application_filler", taskType: "application_fill_for_review", allowedActions: [] })
    expect(absent.templates).toBe(baseTemplates)
  })

  it("propagates invalid bound-fill or loader failures before runtime root creation", async () => {
    const base = {
      pool: {} as never, lease: {} as never, now: () => new Date(), enabled: true,
      taskGraphTemplates: { scout: TASK_GRAPH_TEMPLATES.scout },
      selectedJobPreparationLoader: async () => undefined,
      applicationFillPreparationLoader: async () => { throw new Error("application_fill_material_unavailable") },
    }

    await expect(taskGraphRuntimeForTurn(base)).rejects.toThrow("application_fill_material_unavailable")
  })
})
