import { describe, expect, it, vi } from "vitest"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import type { Queryable } from "./pg-store-persistence.js"
import { SCHEDULED_AUDIT_TEMPLATE_ID } from "./scheduled-audit-contract.js"
import { scheduleTaskGraph } from "./pg-task-graph-command-port-schedule.js"

const scope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  stepId: "step-1", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
} as const

function inputFor(templateId: string, key = templateId): TaskGraphScheduleInput {
  return {
    scope,
    proposal: { expectedRevision: 0, nodes: [{ key, templateId, goal: "Private scheduled work", successCriteria: [], dependsOn: [] }] },
    templates: { [templateId]: { role: "analyst", taskType: "analysis", allowedActions: [] } },
  }
}

describe("scheduleTaskGraph private scheduled nodes", () => {
  it.each([
    ["scheduled Gate", "gate", "scheduled_gate_private"],
    ["scheduled Audit", SCHEDULED_AUDIT_TEMPLATE_ID, "scheduled_audit_private"],
  ])("rejects the %s before database work", async (_name, templateId, code) => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Queryable

    await expect(scheduleTaskGraph(client, inputFor(templateId))).rejects.toMatchObject({ code })
    expect(query).not.toHaveBeenCalled()
  })
})
