import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import { hasPendingSteerOrInvalidResult, hasUnresolvedPlanningSteering } from "./canonical-turn-steering-reconciliation.js"
import { SessionPauseRequestedError } from "./session-gate.js"

const { readState, readTerminalState, lockRoot, admitTerminal, revokeAdmissions } = vi.hoisted(() => ({
  readState: vi.fn(), readTerminalState: vi.fn(), lockRoot: vi.fn(), admitTerminal: vi.fn(), revokeAdmissions: vi.fn(),
}))
vi.mock("./subagents/steering-reconciliation-read.js", async importOriginal => ({
  ...await importOriginal<typeof import("./subagents/steering-reconciliation-read.js")>(),
  readSteeringReconciliationState: readState,
  readSteeringReconciliationStateForTerminal: readTerminalState,
}))
vi.mock("./subagents/task-graph-pg-state.js", async importOriginal => ({
  ...await importOriginal<typeof import("./subagents/task-graph-pg-state.js")>(),
  lockTaskGraphScope: lockRoot,
}))
vi.mock("./session-gate.js", async importOriginal => ({
  ...await importOriginal<typeof import("./session-gate.js")>(),
  assertSessionTerminalAdmission: admitTerminal,
  revokeSessionTerminalAdmissionsForClient: revokeAdmissions,
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

  it("uses the exact terminal ledger only for a locked derived Fill planner step", async () => {
    const terminalReceipt = Object.freeze({})
    const plannerRoot = { id: scope.rootTaskId, rootTaskId: scope.rootTaskId, parentTaskId: null,
      role: "orchestrator", taskType: "root", allowedActions: ["agent.plan"] }
    readState.mockReset()
    readTerminalState.mockReset().mockResolvedValueOnce({ unresolvedInputs: [{ id: "private-id" }] })
    lockRoot.mockReset().mockRejectedValueOnce(new SessionPauseRequestedError()).mockResolvedValueOnce(plannerRoot)
    admitTerminal.mockReset().mockResolvedValueOnce(terminalReceipt)
    revokeAdmissions.mockReset()
    const fixture = poolFixture(async sql => {
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: scope.stepId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ source: "user", executionMode: "canonical_task_graph" }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })

    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).resolves.toBe(true)

    expect(lockRoot.mock.calls).toEqual([[fixture.client, scope, true], [fixture.client, scope, false]])
    expect(fixture.query.mock.calls.find(([sql]) => String(sql).includes('FROM "agent_steps"'))?.[1]).toEqual([
      scope.stepId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentAttemptCount,
    ])
    const turnRead = fixture.query.mock.calls.find(([sql]) => String(sql).includes('FROM "agent_turns"'))
    expect(turnRead?.[1]).toEqual([scope.turnId, scope.sessionId, scope.userId, scope.rootTaskId,
      scope.turnLeaseOwner, scope.turnLeaseVersion])
    expect(admitTerminal).toHaveBeenCalledWith(fixture.client, { sessionId: scope.sessionId, userId: scope.userId,
      turnId: scope.turnId, rootTaskId: scope.rootTaskId, source: "user", executionMode: "canonical_task_graph" })
    expect(readState).not.toHaveBeenCalled()
    expect(readTerminalState).toHaveBeenCalledWith(fixture.client, scope, terminalReceipt)
    expect(revokeAdmissions).toHaveBeenCalledWith(fixture.client)
    expect(fixture.release).toHaveBeenCalledOnce()
    expect(revokeAdmissions.mock.invocationCallOrder[0]).toBeLessThan(fixture.release.mock.invocationCallOrder[0]!)
  })

  it("does not use terminal admission for a non-planner or a legacy unowned Step", async () => {
    const plannerRoot = { id: scope.rootTaskId, rootTaskId: scope.rootTaskId, parentTaskId: null,
      role: "orchestrator", taskType: "root", allowedActions: ["agent.plan"] }
    readTerminalState.mockReset()
    lockRoot.mockReset().mockRejectedValueOnce(new SessionPauseRequestedError()).mockResolvedValueOnce({
      ...plannerRoot, allowedActions: ["jobs.search"],
    })
    admitTerminal.mockReset()
    let fixture = poolFixture()
    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(admitTerminal).not.toHaveBeenCalled()

    lockRoot.mockReset().mockRejectedValueOnce(new SessionPauseRequestedError()).mockResolvedValueOnce(plannerRoot)
    fixture = poolFixture(async sql => sql.includes('FROM "agent_turns"')
      ? { rows: [{ source: "user", executionMode: null }], rowCount: 1 }
      : { rows: [], rowCount: 0 })
    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(admitTerminal).not.toHaveBeenCalled()
    expect(readTerminalState).not.toHaveBeenCalled()
  })

  it("preserves the pause classification when a paused Root has malformed planning actions", async () => {
    readTerminalState.mockReset()
    lockRoot.mockReset().mockRejectedValueOnce(new SessionPauseRequestedError()).mockResolvedValueOnce({
      id: scope.rootTaskId, rootTaskId: scope.rootTaskId, parentTaskId: null,
      role: "orchestrator", taskType: "root", allowedActions: null,
    })
    admitTerminal.mockReset()
    const fixture = poolFixture()

    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(admitTerminal).not.toHaveBeenCalled()
    expect(readTerminalState).not.toHaveBeenCalled()
    expect(fixture.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK")
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("does not recover a stale owner lock or a denied terminal admission", async () => {
    readTerminalState.mockReset()
    lockRoot.mockReset().mockRejectedValueOnce(new Error("task_graph_step_fenced"))
    admitTerminal.mockReset()
    let fixture = poolFixture()
    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).rejects.toThrow("task_graph_step_fenced")
    expect(lockRoot).toHaveBeenCalledOnce()
    expect(admitTerminal).not.toHaveBeenCalled()

    const plannerRoot = { id: scope.rootTaskId, rootTaskId: scope.rootTaskId, parentTaskId: null,
      role: "orchestrator", taskType: "root", allowedActions: ["agent.plan"] }
    lockRoot.mockReset().mockRejectedValueOnce(new SessionPauseRequestedError()).mockResolvedValueOnce(plannerRoot)
    admitTerminal.mockReset().mockRejectedValueOnce(new SessionPauseRequestedError())
    fixture = poolFixture(async sql => {
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: scope.stepId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"')) return { rows: [{ source: "user", executionMode: null }], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })
    await expect(hasUnresolvedPlanningSteering(fixture.pool, scope)).rejects.toBeInstanceOf(SessionPauseRequestedError)
    expect(readTerminalState).not.toHaveBeenCalled()
    expect(fixture.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK")
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
