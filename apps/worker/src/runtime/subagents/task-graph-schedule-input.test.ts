import { describe, expect, it } from "vitest"
import type { TaskGraphScheduleInput, TaskGraphScheduleNode, TaskGraphScheduleReceipt, TaskGraphScheduledPrepareReceipt } from "./task-graph-schedule-input.js"
import type {
  TaskGraphScheduleNode as CommandPortScheduleNode,
  TaskGraphScheduleReceipt as CommandPortScheduleReceipt,
  TaskGraphScheduledPrepareReceipt as CommandPortScheduledPrepareReceipt,
} from "./task-graph-command-port.js"

describe("TaskGraph schedule input", () => {
  it("preserves schedule receipt types through the command-port public exports", () => {
    const node: TaskGraphScheduleNode = { key: "analysis", taskId: "task-analysis", status: "queued" }
    const publicNode: CommandPortScheduleNode = node
    const receipt: TaskGraphScheduleReceipt = { status: "accepted", revision: 2, nodes: [node], readyTaskIds: [node.taskId] }
    const publicReceipt: CommandPortScheduleReceipt = receipt
    const prepareReceipt: TaskGraphScheduledPrepareReceipt = {
      status: "accepted", revision: 2, nodes: [node], readyTaskIds: [node.taskId],
      choice: { required: true, status: "answered", waitId: "wait-1" },
    }
    const publicPrepareReceipt: CommandPortScheduledPrepareReceipt = prepareReceipt

    expect(publicNode).toEqual(node)
    expect(publicReceipt).toEqual(receipt)
    expect(publicPrepareReceipt).toEqual(prepareReceipt)
  })

  it("carries exactly the parsed operational failure mapping as a separate mode", () => {
    const replaceOperationalFailure = {
      root: { nodeKey: "analyst-old", taskId: "task-old" },
      sources: [{ nodeKey: "analyst-old", taskId: "task-old", replacementKey: "analyst-new" }],
    } as const
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user", sessionId: "session", turnId: "turn", rootTaskId: "root", parentTaskId: "root",
        stepId: "step", turnLeaseOwner: "worker", turnLeaseVersion: 1, parentLeaseOwner: "worker", parentAttemptCount: 1 },
      proposal: { expectedRevision: 4, nodes: [] }, templates: {}, replaceOperationalFailure,
    }
    expect(input.replaceOperationalFailure).toEqual(replaceOperationalFailure)
    expect(input.replaceBranch).toBeUndefined()
    expect(input.replaceUnstarted).toBeUndefined()
  })
})
