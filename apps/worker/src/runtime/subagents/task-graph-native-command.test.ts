import { describe, expect, expectTypeOf, it } from "vitest"

import type {
  TaskGraphCommandPort,
  TaskGraphNativeChildReceipt,
  TaskGraphNativeCommandInput,
  TaskGraphNativeCommandReceipt,
  TaskGraphNativeFollowupRequest,
  TaskGraphNativeNodeView,
  TaskGraphNativeResultReceipt,
  TaskGraphNativeSpawnRequest,
  TaskGraphCurrentNode,
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
    const marker = { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" } satisfies NonNullable<TaskGraphNativeCommandInput["outputSchemaMarker"]>
    const node: TaskGraphNativeNodeView = {
      operationKind: "followup", operationId: "op-1", requestFingerprint: "f".repeat(64), callerTaskId: "root",
      role: "auditor", taskType: "audit", contextDigest: "c".repeat(64),
      source: { taskId: "source", rootTaskId: "root", parentTaskId: "root", turnId: "turn", role: "auditor", taskType: "audit", status: "completed", attemptCount: 1, resultDigest: "d".repeat(64), graphNodeKey: "source-node", origin: "task_graph" },
    }
    const result: TaskGraphNativeResultReceipt = {
      schemaVersion: "agent-harness.v2.task-graph.native-result.v1", role: "auditor", taskStatus: "completed",
      disposition: "opaque", resultDigest: "d".repeat(64),
    }

    expect(spawn.allowedActions).toEqual(["read"])
    expect(followup.sourceTaskId).toBe("source-task")
    expect(child.status).toBe("waiting")
    expect(marker.role).toBe("scout")
    expect(node.source?.taskId).toBe("source")
    expect(result.taskStatus).toBe("completed")
    expectTypeOf<TaskGraphNativeCommandInput["outputSchemaMarker"]>().toEqualTypeOf<Readonly<{ schemaVersion: "agent-harness.v2.subagent.result"; role: "scout" | "analyst" }> | undefined>()
    expectTypeOf<TaskGraphCurrentNode["native"]>().toEqualTypeOf<TaskGraphNativeNodeView | undefined>()
    expectTypeOf<TaskGraphCurrentNode["nativeResult"]>().toEqualTypeOf<TaskGraphNativeResultReceipt | undefined>()
    expectTypeOf<TaskGraphNativeChildReceipt["status"]>().toEqualTypeOf<"queued" | "waiting">()
    expectTypeOf<Extract<TaskGraphNativeChildReceipt["status"], "paused">>().toEqualTypeOf<never>()
    expectTypeOf<TaskGraphNativeCommandReceipt["status"]>().toEqualTypeOf<"accepted" | "duplicate">()
  })
})
