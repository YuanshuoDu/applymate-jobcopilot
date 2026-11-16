import { describe, expect, it } from "vitest"

import { TASK_GRAPH_TEMPLATES } from "./task-graph-template-definitions.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

describe("server-owned TaskGraph template definitions", () => {
  it("registers only Scout, Analyst, and scheduled Prepare with bounded actions", () => {
    expect(TASK_GRAPH_TEMPLATES.scout).toMatchObject({
      role: "scout", taskType: "job_discovery",
      allowedActions: ["jobs.search", "jobs.get", "jobs.discover", "tool_results.read"],
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    })
    expect(TASK_GRAPH_TEMPLATES.analyst).toMatchObject({
      role: "analyst", taskType: "job_analysis",
      allowedActions: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"],
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" },
    })
    expect(TASK_GRAPH_TEMPLATES.prepare).toMatchObject({
      role: "prepare", taskType: "scheduled_application_prepare",
      allowedActions: ["scheduled.application.prepare"],
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare" },
    })
    expect(TASK_GRAPH_TEMPLATES.prepare.constraints?.join(" ")).toContain("specialized scheduled continuation")
    expect(Object.keys(TASK_GRAPH_TEMPLATES)).toEqual(["scout", "analyst", "prepare"])
    for (const template of Object.values(TASK_GRAPH_TEMPLATES)) {
      expect(template.allowedActions).not.toContain("agent.plan")
      expect(template.allowedActions.some(action => /submit|send|publish|delete|mutate|execute/i.test(action))).toBe(false)
    }
  })
})
