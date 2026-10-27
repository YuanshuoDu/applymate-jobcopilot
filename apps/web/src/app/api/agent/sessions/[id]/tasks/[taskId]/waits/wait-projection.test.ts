import { describe, expect, it } from "vitest"

import { projectCurrentAgentTaskWait, type WaitProjectionScope } from "./wait-projection"

const scope: WaitProjectionScope = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "parent_1", stepId: "step_1",
}
const wait = (overrides: Record<string, unknown> = {}) => ({
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", parentTaskId: "parent_1", stepId: "step_1",
  targetTaskIds: ["child_2", "child_1"], matchedTaskIds: [], mode: "all", status: "waiting",
  deadlineAt: new Date("2026-10-27T12:00:00.000Z"), suspendedAt: new Date("2026-10-27T11:00:00.000Z"), consumedAt: null,
  ...overrides,
})
const targets = [
  { id: "child_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "parent_1", role: "scout", taskType: "job_search", status: "completed" },
  { id: "child_2", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "parent_1", role: "analyst", taskType: "analysis", status: "running" },
]

describe("projectCurrentAgentTaskWait", () => {
  it("projects each validated direct child in persisted target order using resolver terminal semantics", () => {
    const projection = projectCurrentAgentTaskWait(wait(), targets, scope)
    expect(projection).toEqual({
      mode: "all", status: "waiting", deadlineAt: "2026-10-27T12:00:00.000Z", parentDeadlineAt: null,
      targets: [
        { taskId: "child_2", label: "analyst", status: "running", matched: false },
        { taskId: "child_1", label: "scout", status: "completed", matched: true },
      ],
    })
  })

  it.each(["completed", "failed", "interrupted", "cancelled", "closed", "passed", "skipped"])(
    "treats resolver terminal status %s as matched even when a partial all-wait matched list is empty",
    (status) => {
      const rows = targets.map((target) => target.id === "child_2" ? { ...target, status } : target)
      expect(projectCurrentAgentTaskWait(wait({ mode: "any" }), rows, scope)?.targets[0]?.matched).toBe(true)
    },
  )

  it("keeps an expired wait deadline visible for the client deadline display", () => {
    const projection = projectCurrentAgentTaskWait(wait({ deadlineAt: new Date("2020-01-01T00:00:00.000Z") }), targets, scope)
    expect(projection?.status).toBe("waiting")
    expect(projection?.deadlineAt).toBe("2020-01-01T00:00:00.000Z")
  })

  it.each([
    ["earlier than the wait", new Date("2026-10-27T11:30:00.000Z")],
    ["later than the wait", new Date("2026-10-27T13:00:00.000Z")],
  ] as const)("keeps a parent deadline %s separate from the persisted wait deadline", (_label, parentDeadlineAt) => {
    const projection = projectCurrentAgentTaskWait(wait(), targets, scope, parentDeadlineAt)
    expect(projection).toMatchObject({
      deadlineAt: "2026-10-27T12:00:00.000Z", parentDeadlineAt: parentDeadlineAt.toISOString(),
    })
  })

  it("projects a null parent deadline and rejects a non-null invalid one", () => {
    expect(projectCurrentAgentTaskWait(wait(), targets, scope, null)?.parentDeadlineAt).toBeNull()
    expect(projectCurrentAgentTaskWait(wait(), targets, scope, new Date(Number.NaN))).toBeNull()
  })

  it.each([
    ["foreign user", { userId: "other_user" }],
    ["foreign session", { sessionId: "other_session" }],
    ["foreign turn", { turnId: "other_turn" }],
    ["foreign parent", { parentTaskId: "other_parent" }],
    ["foreign step", { stepId: "other_step" }],
    ["resolved wait", { status: "ready" }],
    ["invalid mode", { mode: "sometimes" }],
    ["missing suspension", { suspendedAt: null }],
    ["consumed wait", { consumedAt: new Date() }],
    ["nullable deadline", { deadlineAt: null }],
    ["malformed deadline", { deadlineAt: "not-a-date" }],
    ["unknown private field", { result: { SECRET: "do-not-project" } }],
  ] as const)("fails closed for %s", (_label, override) => {
    expect(projectCurrentAgentTaskWait(wait(override), targets, scope)).toBeNull()
  })

  it.each([
    ["too many targets", Array.from({ length: 9 }, (_, index) => `child_${index}`), []],
    ["duplicate targets", ["child_1", "child_1"], []],
    ["empty targets", [], []],
    ["non-string target", ["child_1", 4], []],
    ["untrimmed target", [" child_1"], []],
    ["oversized target", ["x".repeat(257)], []],
    ["duplicate matched ids", ["child_1", "child_1"], []],
    ["matched id outside target set", ["other_child"], []],
    ["more than eight matched ids", Array.from({ length: 9 }, (_, index) => `child_${index}`), []],
  ] as const)("fails closed for %s", (_label, targetTaskIds, matchedTaskIds) => {
    const projection = projectCurrentAgentTaskWait(wait({ targetTaskIds, matchedTaskIds }), targets, scope)
    expect(projection).toBeNull()
  })

  it.each([
    ["missing target", [targets[0]]],
    ["foreign session", [{ ...targets[0], sessionId: "other_session" }, targets[1]]],
    ["foreign turn", [{ ...targets[0], turnId: "other_turn" }, targets[1]]],
    ["foreign root", [{ ...targets[0], rootTaskId: "other_root" }, targets[1]]],
    ["foreign parent", [{ ...targets[0], parentTaskId: "other_parent" }, targets[1]]],
    ["duplicate task row", [targets[0], targets[0]]],
    ["unknown private field", [{ ...targets[0], result: "PRIVATE" }, targets[1]]],
  ] as const)("fails closed for %s", (_label, rows) => {
    expect(projectCurrentAgentTaskWait(wait(), rows, scope)).toBeNull()
  })

  it("redacts unknown statuses and unsafe labels without exposing user text", () => {
    const rows = targets.map((target) => target.id === "child_2"
      ? { ...target, role: "PRIVATE USER GOAL", taskType: "https://secret.invalid", status: "PRIVATE_STATUS" }
      : target)
    const projected = projectCurrentAgentTaskWait(wait(), rows, scope)
    expect(projected?.targets[0]).toEqual({ taskId: "child_2", label: null, status: "unknown", matched: false })
    expect(JSON.stringify(projected)).not.toContain("PRIVATE")
    expect(JSON.stringify(projected)).not.toContain("secret.invalid")
  })

  it("uses only closed server-owned role and task-type labels", () => {
    const knownRole = targets.map((target) => target.id === "child_2" ? { ...target, role: "auditor" } : target)
    const roleProjection = projectCurrentAgentTaskWait(wait(), knownRole, scope)
    expect(roleProjection?.targets[0]?.label).toBe("auditor")

    const knownType = targets.map((target) => target.id === "child_2"
      ? { ...target, role: "model_generated_label", taskType: "job_discovery" }
      : target)
    const typeProjection = projectCurrentAgentTaskWait(wait(), knownType, scope)
    expect(typeProjection?.targets[0]?.label).toBe("job_discovery")
  })

  it.each([
    ["arbitrary ASCII token", "private_context", "model_generated_label"],
    ["numeric string", "1234567890", "987654321"],
    ["free-form goal text", "Find the user's password", "Need CV and phone number"],
  ])("redacts an unknown %s role and task type", (_label, role, taskType) => {
    const rows = targets.map((target) => target.id === "child_2" ? { ...target, role, taskType } : target)
    const projected = projectCurrentAgentTaskWait(wait(), rows, scope)
    expect(projected?.targets[0]?.label).toBeNull()
    expect(JSON.stringify(projected)).not.toContain(role)
    expect(JSON.stringify(projected)).not.toContain(taskType)
  })
})
