import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ match: vi.fn() }))
vi.mock("./scheduled-gate-wait-match.js", () => ({ matchScheduledGateWaitTarget: mocks.match }))

import { hasScheduledGateResumeAcknowledgement, SCHEDULED_GATE_RESUMABLE_SQL } from "./scheduled-gate-resume-admission.js"

const input = { taskId: "gate-task", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", userId: "user-1", attemptCount: 3 }

function queryClient(stepIds: readonly string[]) {
  const query = vi.fn(async () => ({ rows: stepIds.map(stepId => ({ stepId })), rowCount: stepIds.length }))
  return { client: { query } as never, query }
}

beforeEach(() => mocks.match.mockReset())

describe("scheduled Gate resume admission", () => {
  it("exposes only a bounded task-alias candidate predicate for exact acknowledged Gate resumes", () => {
    expect(SCHEDULED_GATE_RESUMABLE_SQL).toContain('task."taskType" = \'scheduled_taskgraph_gate\'')
    expect(SCHEDULED_GATE_RESUMABLE_SQL).toContain('task."attemptCount" <= task."maxAttempts" + 50')
    expect(SCHEDULED_GATE_RESUMABLE_SQL).toContain('item."content"->\'scheduledGateChoiceResumeAcknowledgement\'->>\'resumedAttemptCount\' = (task."attemptCount" + 1)::text')
    expect(SCHEDULED_GATE_RESUMABLE_SQL).toContain('step."status" = \'waiting_for_user\'')
  })

  it.each([
    { label: "missing", stepIds: [] },
    { label: "duplicate", stepIds: ["root-step-1", "root-step-2"] },
  ])("rejects $label answered Gate steps", async ({ stepIds }) => {
    const { client, query } = queryClient(stepIds)
    await expect(hasScheduledGateResumeAcknowledgement(client, input)).resolves.toBe(false)
    expect(query).toHaveBeenCalledWith(expect.stringContaining('SELECT DISTINCT item."stepId"'),
      ["session-1", "turn-1", "root-1", "gate-task", "3", "4"])
    expect(mocks.match).not.toHaveBeenCalled()
  })

  it("admits only a unique exact N-to-N+1 acknowledgement whose wait target is still pending", async () => {
    const { client, query } = queryClient(["root-step-3"])
    mocks.match.mockResolvedValue("pending")
    await expect(hasScheduledGateResumeAcknowledgement(client, input)).resolves.toBe(true)
    expect(query).toHaveBeenCalledTimes(1)
    expect(mocks.match).toHaveBeenCalledWith(client, { userId: "user-1", sessionId: "session-1", turnId: "turn-1",
      rootTaskId: "root-1", stepId: "root-step-3", gateTaskId: "gate-task", requestAttemptCount: 3 })
  })

  it.each(["matched", "stale", null])("rejects an acknowledgement with matcher disposition %s", async disposition => {
    const { client } = queryClient(["root-step-3"])
    mocks.match.mockResolvedValue(disposition)
    await expect(hasScheduledGateResumeAcknowledgement(client, input)).resolves.toBe(false)
  })

  it("rejects a malformed step identity before invoking the matcher", async () => {
    const { client } = queryClient(["  "])
    await expect(hasScheduledGateResumeAcknowledgement(client, input)).resolves.toBe(false)
    expect(mocks.match).not.toHaveBeenCalled()
  })
})
