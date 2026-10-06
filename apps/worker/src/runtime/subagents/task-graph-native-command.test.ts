import { describe, expect, expectTypeOf, it } from "vitest"

import type {
  TaskGraphCommandPort,
  TaskGraphNativeChildReceipt,
  TaskGraphNativeCommandInput,
  TaskGraphNativeCommandReceipt,
  TaskGraphNativeFollowupRequest,
  TaskGraphNativeSpawnRequest,
} from "./task-graph-command-port.js"

describe("native TaskGraph port contract", () => {
  it("keeps native support optional for existing template-only ports", () => {
    const legacyPort: TaskGraphCommandPort = {
      appendAndSchedule: async () => ({ status: "accepted", revision: 1, nodes: [], readyTaskIds: [] }),
      readCurrent: async () => ({ revision: 0, nodes: [] }),
    }

    expect(legacyPort.appendNativeCoordination).toBeUndefined()
    expectTypeOf<TaskGraphCommandPort["appendNativeCoordination"]>()
      .toEqualTypeOf<((input: TaskGraphNativeCommandInput) => Promise<TaskGraphNativeCommandReceipt>) | undefined>()
  })

  it("preserves native spawn and follow-up inputs and distinguishes stored task state", () => {
    const spawn = {
      kind: "spawn", idempotencyKey: "native-key", role: "auditor", taskType: "audit",
      goal: "Inspect evidence", constraints: ["Stay in scope"], allowedActions: ["read"], context: { hint: "source" },
    } satisfies TaskGraphNativeSpawnRequest
    const followup = {
      kind: "followup", idempotencyKey: "followup-key", sourceTaskId: "source-task", goal: "Refine the finding",
    } satisfies TaskGraphNativeFollowupRequest
    const child = {
      taskId: "child", rootTaskId: "root", parentTaskId: "root", path: "/root/child", depth: 1,
      role: "auditor", taskType: "audit", status: "waiting",
    } satisfies TaskGraphNativeChildReceipt

    expect(spawn.allowedActions).toEqual(["read"])
    expect(followup.sourceTaskId).toBe("source-task")
    expect(child.status).toBe("waiting")
    expectTypeOf<TaskGraphNativeChildReceipt["status"]>().toEqualTypeOf<"queued" | "waiting">()
    expectTypeOf<Extract<TaskGraphNativeChildReceipt["status"], "paused">>().toEqualTypeOf<never>()
    expectTypeOf<TaskGraphNativeCommandReceipt["status"]>().toEqualTypeOf<"accepted" | "duplicate">()
  })
})
