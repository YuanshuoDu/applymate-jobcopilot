import { describe, expect, it, vi } from "vitest"
import type { Queryable } from "./pg-store-persistence.js"
import { hasUnsettledExternalCall } from "./external-call-state.js"

describe("unsettled external call recovery fence", () => {
  it.each([
    ["tool_call.started", ["tool_call.completed", "tool_call.failed"]],
    ["model.started", ["model.completed", "model.failed"]],
  ])("blocks recovery for an unmatched %s", async (startedType, terminalTypes) => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [{ id: "started-event" }], rowCount: 1 }))
    await expect(hasUnsettledExternalCall({ query } as unknown as Queryable, "session-1", "task-1")).resolves.toBe(true)
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain(`started."type" = '${startedType}'`)
    expect(terminalTypes.every(type => sql.includes(`'${type}'`))).toBe(true)
    expect(query.mock.calls[0]?.[1]).toEqual(["session-1", "task-1"])
  })

  it("allows recovery when a started tool call has a durable interruption event", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      const hasInterruptionTerminal = sql.includes("'tool_call.interrupted'")
      return { rows: hasInterruptionTerminal ? [] : [{ id: "started-event" }], rowCount: hasInterruptionTerminal ? 0 : 1 }
    })

    await expect(hasUnsettledExternalCall({ query } as unknown as Queryable, "session-1", "task-1")).resolves.toBe(false)
    expect(String(query.mock.calls[0]?.[0])).toContain("'tool_call.interrupted'")
  })

  it("allows recovery only when no unmatched start exists", async () => {
    const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }))
    await expect(hasUnsettledExternalCall({ query } as unknown as Queryable, "session-1", "task-1")).resolves.toBe(false)
  })
})
