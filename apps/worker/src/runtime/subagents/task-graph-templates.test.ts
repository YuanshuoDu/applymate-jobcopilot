import { describe, expect, it } from "vitest"
import { TASK_GRAPH_TEMPLATES, taskGraphRuntimeOptions, taskGraphTemplatesForSelectedJob } from "./task-graph-templates.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import type { TaskGraphCommandPort } from "./task-graph-command-port.js"

describe("TaskGraph server-owned templates", () => {
  it("registers structured read-only Scout and Analyst roles for evidence chaining", () => {
    expect(TASK_GRAPH_TEMPLATES.scout).toMatchObject({
      role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search", "jobs.get"],
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

  it("adds scoped Writer and Reviewer templates only for a server-selected job", () => {
    expect(Object.keys(taskGraphTemplatesForSelectedJob(undefined))).toEqual(["scout", "analyst"])
    const templates = taskGraphTemplatesForSelectedJob({ jobId: "job-1" })
    expect(templates.cover_letter_writer).toMatchObject({
      role: "writer", taskType: "cover_letter_draft",
      allowedActions: ["jobs.get", "persona.retrieve", "resume.get_base", "cover_letter.draft"],
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
      expect(template.allowedActions).not.toContain("agent.plan")
      expect(template.allowedActions).not.toContain("application.submit")
      expect(template.allowedActions.some(action => /send|gmail|browser|submit/i.test(action))).toBe(false)
    }
  })
})
