import { describe, expect, it, vi } from "vitest"

import type { LeasePool } from "../runtime/turns/lease.js"
import { pinAgentRunMode, type AgentRunExecutionMode } from "./agent-run-mode.js"

function fixture(input: { mode?: string | null; dispatch?: unknown; legacy?: boolean; owner?: string } = {}) {
  const state = {
    mode: input.mode ?? null,
    dispatch: input.dispatch ?? null,
    legacy: input.legacy ?? false,
    owner: input.owner ?? "user-1",
  }
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) {
        return values?.[0] === "session-1" && values?.[1] === state.owner
          ? { rows: [{ id: "session-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) {
        return values?.[0] === "turn-1" && values?.[1] === "session-1" && values?.[2] === state.owner
          ? { rows: [{ executionMode: state.mode }], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "agent_outbox"')) {
        return state.dispatch ? { rows: [state.dispatch], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      if (sql.includes('FROM "agent_items"')) return { rows: [{ present: state.legacy }], rowCount: 1 }
      if (sql.startsWith('UPDATE "agent_turns"')) {
        state.mode = String(values?.[3])
        return { rows: [], rowCount: 1 }
      }
      throw new Error(`unexpected query: ${sql}`)
    }),
    release: vi.fn(),
  }
  return { state, client, pool: { connect: vi.fn().mockResolvedValue(client) } as unknown as LeasePool }
}

const identity = { userId: "user-1", sessionId: "session-1", turnId: "turn-1" }
const dispatch = {
  topic: "agent.turn.dispatch", aggregateId: "session-1",
  payload: { turnId: "turn-1", sessionId: "session-1", ownerId: "agent-run:turn-1" },
}

describe("AgentRun execution mode pin", () => {
  it.each([
    [true, "canonical_task_graph"],
    [false, "legacy_pipeline_adapter"],
  ] as const)("uses the server flag only when no durable evidence exists", async (enabled, expected) => {
    const fake = fixture()
    await expect(pinAgentRunMode(fake.pool, identity, enabled)).resolves.toBe(expected)
    expect(fake.state.mode).toBe(expected)
    expect(fake.client.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "agent_turns"'))).toBe(true)
  })

  it("resolves an exact canonical dispatch intent regardless of the flag", async () => {
    const fake = fixture({ dispatch })
    await expect(pinAgentRunMode(fake.pool, identity, false)).resolves.toBe("canonical_task_graph")
  })

  it("resolves a persisted started pipeline.run call as legacy regardless of the flag", async () => {
    const fake = fixture({ legacy: true })
    await expect(pinAgentRunMode(fake.pool, identity, true)).resolves.toBe("legacy_pipeline_adapter")
  })

  it("returns a valid stored mode without consulting the live flag", async () => {
    const fake = fixture({ mode: "legacy_pipeline_adapter" })
    await expect(pinAgentRunMode(fake.pool, identity, true)).resolves.toBe("legacy_pipeline_adapter")
    expect(fake.client.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "agent_turns"'))).toBe(false)
  })

  it("keeps a persisted canonical mode on retry after the flag flips off", async () => {
    const fake = fixture()
    await expect(pinAgentRunMode(fake.pool, identity, true)).resolves.toBe("canonical_task_graph")
    await expect(pinAgentRunMode(fake.pool, identity, false)).resolves.toBe("canonical_task_graph")

    expect(fake.state.mode).toBe("canonical_task_graph")
    expect(fake.client.query.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE "agent_turns"'))).toHaveLength(1)
  })

  it("fails closed on conflicting durable evidence", async () => {
    const fake = fixture({ dispatch, legacy: true })
    await expect(pinAgentRunMode(fake.pool, identity, true)).rejects.toMatchObject({ code: "conflicting_evidence" })
    expect(fake.client.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "agent_turns"'))).toBe(false)
  })

  it("fails closed when stored mode conflicts with runner evidence", async () => {
    const fake = fixture({ mode: "canonical_task_graph", legacy: true })
    await expect(pinAgentRunMode(fake.pool, identity, true)).rejects.toMatchObject({ code: "conflicting_evidence" })
  })

  it("fails closed on a malformed stored mode", async () => {
    const fake = fixture({ mode: "unknown" })
    await expect(pinAgentRunMode(fake.pool, identity, true)).rejects.toMatchObject({ code: "invalid_stored_mode" })
  })

  it("fails closed when the requested Turn is not owned by the supplied user and session", async () => {
    const fake = fixture({ owner: "different-user" })
    await expect(pinAgentRunMode(fake.pool, identity, true)).rejects.toMatchObject({ code: "owner_mismatch" })
    expect(fake.client.query.mock.calls.some(([sql]) => String(sql).startsWith('UPDATE "agent_turns"'))).toBe(false)
  })

  it("fails closed when a reserved dispatch key has a mismatched identity", async () => {
    const fake = fixture({ dispatch: { ...dispatch, aggregateId: "other-session" } })
    await expect(pinAgentRunMode(fake.pool, identity, true)).rejects.toMatchObject({ code: "conflicting_evidence" })
  })

  it("keeps the two supported values as the complete mode type", () => {
    const supported: AgentRunExecutionMode[] = ["canonical_task_graph", "legacy_pipeline_adapter"]
    expect(supported).toHaveLength(2)
  })
})
