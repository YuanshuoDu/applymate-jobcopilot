import { describe, expect, it } from "vitest"
import { scheduledPostGateTaskTemplates } from "./scheduled-post-gate-task-templates.js"
import {
  SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID,
  SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID,
} from "./scheduled-post-gate-contract.js"

describe("scheduled post-Gate TaskGraph templates", () => {
  it("exposes only the fixed, single-attempt Execute and Audit roles", () => {
    const templates = scheduledPostGateTaskTemplates()
    expect(Object.keys(templates)).toEqual([SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID, SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID])
    expect(templates[SCHEDULED_POST_GATE_EXECUTE_TEMPLATE_ID]).toMatchObject({
      role: "executor", taskType: SCHEDULED_POST_GATE_EXECUTE_TASK_TYPE, allowedActions: [], maxAttempts: 1,
    })
    expect(templates[SCHEDULED_POST_GATE_AUDIT_TEMPLATE_ID]).toMatchObject({
      role: "auditor", taskType: SCHEDULED_POST_GATE_AUDIT_TASK_TYPE, allowedActions: [], maxAttempts: 1,
    })
    for (const template of Object.values(templates)) {
      expect(template.allowedActions).toEqual([])
      expect((template.constraints ?? []).join(" ")).toContain("never submit applications or send Gmail")
    }
  })
})
