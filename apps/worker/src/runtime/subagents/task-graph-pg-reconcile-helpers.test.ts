import { describe, expect, it, vi } from "vitest"
import { deleteGraphDispatch, hasCompletedLegacyAncestor, isActiveGraphStatus } from "./task-graph-pg-reconcile-helpers.js"
import type { GraphTaskRow } from "./task-graph-pg-state.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"

function node(key: string, disposition: "typed" | "legacy_unverified" | "specialized", dependsOn: string[] = []): StoredTaskGraphNode {
  return { key, taskId: `${key}-task`, verificationDisposition: disposition, dependsOn } as unknown as StoredTaskGraphNode
}

describe("TaskGraph reconciliation helpers", () => {
  it("finds completed legacy ancestry only through typed dependency nodes", () => {
    const nodes = new Map([node("legacy", "legacy_unverified"), node("typed", "typed", ["legacy"]), node("special", "specialized", ["legacy"])].map(value => [value.key, value]))
    const tasks = new Map<string, GraphTaskRow>([["legacy-task", { status: "completed" } as GraphTaskRow]])
    expect(hasCompletedLegacyAncestor("typed", nodes, tasks)).toBe(true)
    expect(hasCompletedLegacyAncestor("special", nodes, tasks)).toBe(false)
    tasks.set("legacy-task", { status: "failed" } as GraphTaskRow)
    expect(hasCompletedLegacyAncestor("typed", nodes, tasks)).toBe(false)
  })

  it("recognizes every active lifecycle status and excludes terminal rows", () => {
    for (const status of ["queued", "running", "retrying", "waiting", "waiting_for_user"]) expect(isActiveGraphStatus(status)).toBe(true)
    for (const status of ["completed", "failed", "interrupted", "cancelled", "closed"]) expect(isActiveGraphStatus(status)).toBe(false)
  })

  it("deletes only unpublished dispatch rows for the exact task", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] })
    await deleteGraphDispatch({ query } as never, "session", "child")
    expect(query).toHaveBeenCalledWith(expect.stringContaining('AND "publishedAt" IS NULL'), ["session", "subagent-dispatch:child"])
  })
})
