import { describe, expect, it, vi } from "vitest"
import type { Queryable } from "./pg-store-persistence.js"
import { loadScopedTaskGraphDependencyContext } from "./task-graph-pg-dependency-context-loader.js"

describe("loadScopedTaskGraphDependencyContext", () => {
  it("loads the child and projects direct dependencies under the full graph identity scope", async () => {
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
    const resultRows = [
      { id: "dependency-2", status: "completed", role: "analyst", expectedOutputSchema: { role: "analyst" }, result: { result: 2 }, context: {}, ...scope },
      { id: "child-1", status: "waiting", context: { prompt: "analyze these" }, ...scope },
      { id: "dependency-1", status: "completed", role: "scout", expectedOutputSchema: { role: "scout" }, result: { result: 1 }, context: {}, ...scope },
    ]
    const query = vi.fn(async () => ({ rows: resultRows, rowCount: resultRows.length }))
    const loaded = await loadScopedTaskGraphDependencyContext(
      { query } as unknown as Queryable,
      scope,
      "child-1",
      ["first", "second"],
      [{ key: "first", taskId: "dependency-1" }, { key: "second", taskId: "dependency-2" }],
    )

    expect(loaded).toEqual({
      childContext: { prompt: "analyze these" },
      dependencies: [
        {
          key: "first", taskId: "dependency-1", status: "completed", role: "scout",
          expectedOutputSchema: { role: "scout" }, result: { result: 1 },
          userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        },
        {
          key: "second", taskId: "dependency-2", status: "completed", role: "analyst",
          expectedOutputSchema: { role: "analyst" }, result: { result: 2 },
          userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        },
      ],
    })
    const [sql, parameters] = query.mock.calls[0] as unknown as [string, unknown[]]
    expect(sql).toContain('task."sessionId" = $2 AND task."turnId" = $3')
    expect(sql).toContain('task."rootTaskId" = $4 AND task."parentTaskId" = $5')
    expect(sql).toContain('session."userId" = $6 AND turn."userId" = $6')
    expect(parameters).toEqual([["child-1", "dependency-1", "dependency-2"], "session-1", "turn-1", "root-1", "root-1", "user-1"])
  })

  it("fails closed when the child row is absent or no longer waiting", async () => {
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) }

    await expect(loadScopedTaskGraphDependencyContext(
      client as unknown as Queryable, scope, "child-1", [], [],
    )).rejects.toThrow("task_graph_dependency_child_scope_invalid")
  })
})
