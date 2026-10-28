import { describe, expect, it, vi } from "vitest"
import type { Queryable } from "./pg-store-persistence.js"
import { scheduledScoutPlanCapacityAllowed } from "./scheduled-taskgraph-plan-capacity.js"

const scope = { userId: "user", sessionId: "session", turnId: "turn" }
const nodes = (scouts: number) => Array.from({ length: scouts }, (_, index) => ({ templateId: "scout", key: `scout-${index}` }))

describe("scheduled TaskGraph source capacity", () => {
  it("allows up to four Scouts without querying persisted Turn state", async () => {
    const query = vi.fn()
    await expect(scheduledScoutPlanCapacityAllowed({ query } as unknown as Queryable, scope, nodes(4))).resolves.toBe(true)
    expect(query).not.toHaveBeenCalled()
  })

  it("blocks a fifth Scout only for the locked scheduled canonical Turn", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ source: "automation", executionMode: "canonical_task_graph",
      input: { automationRunMode: "scheduled" } }] })
    await expect(scheduledScoutPlanCapacityAllowed({ query } as unknown as Queryable, scope, nodes(5))).resolves.toBe(false)
    expect(query.mock.calls[0]?.[1]).toEqual([scope.turnId, scope.sessionId, scope.userId])
    expect(String(query.mock.calls[0]?.[0])).toContain('FROM "agent_turns"')
  })

  it("leaves ordinary and manual canonical Turns at the graph-wide node limit", async () => {
    for (const row of [
      { source: "user", executionMode: "canonical_task_graph", input: { automationRunMode: "scheduled" } },
      { source: "automation", executionMode: "canonical_task_graph", input: { automationRunMode: "manual" } },
    ]) {
      const query = vi.fn().mockResolvedValue({ rows: [row] })
      await expect(scheduledScoutPlanCapacityAllowed({ query } as unknown as Queryable, scope, nodes(5))).resolves.toBe(true)
    }
  })

  it("fails closed when the owned Turn cannot be proven", async () => {
    for (const rows of [[], [{ source: "automation", executionMode: "canonical_task_graph", input: {} },
      { source: "automation", executionMode: "canonical_task_graph", input: {} }]]) {
      const query = vi.fn().mockResolvedValue({ rows })
      await expect(scheduledScoutPlanCapacityAllowed({ query } as unknown as Queryable, scope, nodes(5))).resolves.toBe(false)
    }
  })
})
