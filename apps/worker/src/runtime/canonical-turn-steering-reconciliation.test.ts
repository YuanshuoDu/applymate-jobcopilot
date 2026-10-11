import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { hasPendingSteerOrInvalidResult, hasUnresolvedPlanningSteering } from "./canonical-turn-steering-reconciliation.js"

const { readState, lockRoot } = vi.hoisted(() => ({ readState: vi.fn(), lockRoot: vi.fn() }))
vi.mock("./subagents/steering-reconciliation-read.js", async importOriginal => ({
  ...await importOriginal<typeof import("./subagents/steering-reconciliation-read.js")>(),
  readSteeringReconciliationState: readState,
}))
vi.mock("./subagents/task-graph-pg-state.js", async importOriginal => ({
  ...await importOriginal<typeof import("./subagents/task-graph-pg-state.js")>(),
  lockTaskGraphScope: lockRoot,
}))

const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "worker-1", turnLeaseVersion: 2, parentLeaseOwner: "worker-1", parentAttemptCount: 1, stepId: "step-1",
}
const readScope: TaskGraphReadScope = { ...scope }

function poolFixture(queryImpl?: (sql: string, params?: readonly unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>) {
  const query = vi.fn(queryImpl ?? (async () => ({ rows: [], rowCount: 0 })))
  const release = vi.fn()
  const client = { query, release } as unknown as pg.PoolClient
  const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
  return { pool, client, query, release }
}

describe("canonical Root steering reconciliation preflight", () => {
  it("reads the current owned Step in a scoped transaction and releases it after a pending result", async () => {
    readState.mockReset().mockResolvedValueOnce({ unresolvedInputs: [{ id: "private-id" }] })
    lockRoot.mockReset().mockResolvedValueOnce({ allowedActions: ["agent.plan"] })
    const fixture = poolFixture()

    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).resolves.toBe(true)

    expect(fixture.query.mock.calls.map(call => call[0])).toEqual(["BEGIN ISOLATION LEVEL READ COMMITTED", "SELECT set_config($1, $2, true)", "COMMIT"])
    expect(fixture.query.mock.calls[1]?.[1]).toEqual(["app.user_id", scope.userId])
    expect(lockRoot).toHaveBeenCalledWith(fixture.client, scope, true)
    expect(readState).toHaveBeenCalledWith(fixture.client, scope)
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("does not steer a Root whose server-owned actions omit agent.plan", async () => {
    readState.mockReset().mockResolvedValueOnce({ unresolvedInputs: [{ id: "private-id" }] })
    lockRoot.mockReset().mockResolvedValueOnce({ allowedActions: ["jobs.search"] })
    const fixture = poolFixture()

    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).resolves.toBe(false)
    expect(readState).not.toHaveBeenCalled()
    expect(lockRoot).toHaveBeenCalledOnce()
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("fails closed when the locked Root planning action row is malformed", async () => {
    readState.mockReset().mockResolvedValueOnce({ unresolvedInputs: [{ id: "private-id" }] })
    lockRoot.mockReset().mockResolvedValueOnce({ allowedActions: null })
    const fixture = poolFixture()

    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).rejects.toThrow("steering_reconciliation_planning_root_invalid")
    expect(fixture.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK")
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("rolls back and releases when the owner-scoped reader fails closed", async () => {
    readState.mockReset().mockRejectedValueOnce(new Error("steering_reconciliation_step_fenced"))
    lockRoot.mockReset().mockResolvedValueOnce({ allowedActions: ["agent.plan"] })
    const fixture = poolFixture()

    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).rejects.toThrow("steering_reconciliation_step_fenced")

    expect(fixture.query.mock.calls.map(call => call[0])).toEqual([
      "BEGIN ISOLATION LEVEL READ COMMITTED", "SELECT set_config($1, $2, true)", "ROLLBACK",
    ])
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("keeps the terminal pending-input check on its supplied transaction client", async () => {
    const query = vi.fn(async () => ({ rows: [{ hasPendingSteer: false }], rowCount: 1 }))

    await expect(hasPendingSteerOrInvalidResult({ query } as never, readScope)).resolves.toBe(false)

    expect(query).toHaveBeenCalledWith(expect.stringContaining('"targetTurnId" = $3'), [scope.sessionId, scope.userId, scope.turnId])
    expect(query).toHaveBeenCalledOnce()
  })

  it("treats malformed terminal query results as pending", async () => {
    const query = vi.fn(async () => ({ rows: [{ hasPendingSteer: false, extra: true }], rowCount: 1 }))

    await expect(hasPendingSteerOrInvalidResult({ query } as never, readScope)).resolves.toBe(true)
  })
})
