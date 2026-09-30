import { describe, expect, it } from "vitest"

import { lifecycleTarget, visibleTask } from "./coordination-visibility.js"
import type { CoordinationStore, CoordinationTaskView } from "./coordination-types.js"
import type { ToolExecutionContext } from "./types.js"

const root: CoordinationTaskView = {
  id: "root", userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root", parentTaskId: null,
  path: "/root", depth: 0, role: "supervisor", taskType: "root", status: "running", goal: "Coordinate",
  attemptCount: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
}
const child: CoordinationTaskView = { ...root, id: "child", parentTaskId: "root", path: "/root/child", depth: 1, role: "scout", taskType: "research" }
const grandchild: CoordinationTaskView = { ...child, id: "grandchild", parentTaskId: "child", path: "/root/child/grandchild", depth: 2 }
const sibling: CoordinationTaskView = { ...root, id: "sibling", parentTaskId: "root", path: "/root/sibling", depth: 1 }
const foreign: CoordinationTaskView = { ...child, id: "foreign", userId: "user-b", sessionId: "session-b", rootTaskId: "foreign", parentTaskId: null, path: "/foreign" }

function executionContext(taskId?: string): ToolExecutionContext {
  return {
    scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a", stepId: "step-a", taskId, rootTaskId: "root",
    signal: new AbortController().signal, capabilities: ["canManageChildren"], reportProgress: async () => undefined,
  }
}

function options(): { store: CoordinationStore } & Record<string, unknown> {
  const tasks = new Map([root, child, grandchild, sibling, foreign].map(task => [task.id, task]))
  return {
    manager: {}, store: { getTask: async ({ userId, sessionId, taskId }: { userId: string; sessionId: string; taskId: string }) => {
      const task = tasks.get(taskId)
      return task?.userId === userId && task.sessionId === sessionId ? task : null
    } } as CoordinationStore,
  }
}

describe("coordination visibility", () => {
  it("fences tenant, session, and root visibility", async () => {
    const runtime = options()
    await expect(visibleTask(executionContext("root"), "child", runtime as never)).resolves.toMatchObject({ id: "child" })
    await expect(visibleTask(executionContext("root"), "foreign", runtime as never)).rejects.toMatchObject({ code: "coordination_task_not_found" })
    await expect(visibleTask({ ...executionContext("root"), rootTaskId: "other-root" }, "child", runtime as never)).rejects.toMatchObject({ code: "coordination_task_not_found" })
  })

  it("allows root self-tree targets and child self-descendants while hiding siblings and ancestors", async () => {
    const runtime = options()
    await expect(lifecycleTarget(executionContext("root"), "grandchild", runtime as never)).resolves.toMatchObject({ id: "grandchild" })
    await expect(lifecycleTarget(executionContext("child"), "child", runtime as never)).resolves.toMatchObject({ id: "child" })
    await expect(lifecycleTarget(executionContext("child"), "grandchild", runtime as never)).resolves.toMatchObject({ id: "grandchild" })
    await expect(lifecycleTarget(executionContext("child"), "sibling", runtime as never)).rejects.toMatchObject({ code: "coordination_task_not_found" })
    await expect(lifecycleTarget(executionContext("child"), "root", runtime as never)).rejects.toMatchObject({ code: "coordination_task_not_found" })
  })
})
