import { describe, expect, it } from "vitest"

import { followupContext, graphItem, intersectTaskActions, nativePgObject, taskActions,
  withVerifiedDependencyContext, type TaskGraphNativeSource } from "./task-graph-native-pg-context.js"

const provenance = {
  taskId: "source-1", rootTaskId: "root-1", parentTaskId: "root-1", turnId: "turn-1",
  role: "analyst", taskType: "analysis", status: "completed" as const, attemptCount: 2,
  resultDigest: "sha256:result", graphNodeKey: "analysis", origin: "task_graph" as const,
}
const source: TaskGraphNativeSource = {
  context: { scope: "private" }, result: { status: "waiting", structuredResult: { answer: 42 } }, provenance,
}

describe("native TaskGraph PostgreSQL context helpers", () => {
  it("preserves caller, source context, and source provenance for a follow-up", () => {
    expect(followupContext({ request: true }, source)).toMatchObject({
      callerContext: { request: true }, sourceContext: { scope: "private" },
      provenance: { kind: "agent.followup", sourceTaskId: "source-1", sourceStatus: "completed", sourceAttemptCount: 2 },
    })
  })

  it("keeps dependency enrichment inert when the source is not a typed completed graph node", async () => {
    const query = async () => { throw new Error("unexpected_query") }
    await expect(withVerifiedDependencyContext({ query } as never, {} as never, {} as never, undefined, { original: true }))
      .resolves.toEqual({ context: { original: true } })
  })

  it("parses source allowlists and intersects them without widening parent authority", () => {
    expect(taskActions('["jobs.search", "jobs.get"]')).toEqual(["jobs.search", "jobs.get"])
    expect(intersectTaskActions(["jobs.get", "jobs.search"], ["jobs.search"])).toEqual(["jobs.search"])
    expect(() => taskActions(["jobs.search", " "] )).toThrowError("native_policy_invalid")
  })

  it("serializes stream metadata with one timestamp and rejects non-record JSON", () => {
    const input = { scope: { sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1" } } as never
    const item = graphItem(input, "graph-1", { revision: 3 }, 3, new Date("2026-10-26T12:00:00.000Z"))
    expect(item).toMatchObject({
      id: "graph-1", stepId: null, revision: 3, startedAt: "2026-10-26T12:00:00.000Z",
      createdAt: "2026-10-26T12:00:00.000Z", updatedAt: "2026-10-26T12:00:00.000Z",
    })
    expect(nativePgObject('{"ok":true}')).toEqual({ ok: true })
    expect(nativePgObject('[]')).toBeNull()
  })
})
