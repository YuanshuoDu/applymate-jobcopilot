import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { PoolClient } from "pg"
import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import type { NativeVerificationEnsureResult, NativeVerificationPort, NativeVerificationRootGoalWitness } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitPort } from "./tools/coordination-types.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import { createCanonicalNativeVerificationRuntime, createCanonicalTurnTerminalGuard, type NativeVerificationRuntime } from "./canonical-turn-native-verification-runtime.js"

const candidate = "A current root answer with verified evidence."
const scope: TaskGraphExecutionScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "worker-1", turnLeaseVersion: 2, parentLeaseOwner: "worker-1", parentAttemptCount: 3, stepId: "step-1",
}
const readScope: TaskGraphReadScope = { ...scope }
const witness: NativeVerificationRootGoalWitness = {
  controlTaskId: "control-1", controlOperationId: "operation-1", currentControlAttempt: 1,
  candidateDigest: digestNativeVerificationValue(candidate), childBindingSetDigest: "a".repeat(64), goalDigest: "b".repeat(64),
  criteriaDigest: "c".repeat(64), evidencePacketDigest: "d".repeat(64), reportDigest: "e".repeat(64),
}
const waitPort: DurableWaitPort = { wait: vi.fn(async () => { throw new Error("unexpected wait") }) }
const terminalInput = { finalContent: { text: candidate }, response: candidate } as unknown as Parameters<TurnEngineTerminalGuard>[1]

function coordination() {
  return {
    readScope: () => readScope,
    executionScope: (stepId: string) => ({ ...scope, stepId }),
    hasNativeTasks: vi.fn(async () => true),
    checkNativeGraphCompletion: vi.fn(async () => null),
  }
}
function runtimeFactory(readTerminalProof: NativeVerificationRuntime["readTerminalProof"]) {
  const port: NativeVerificationPort = {
    ensureChildren: vi.fn(async (): Promise<NativeVerificationEnsureResult> => ({ status: "passed", controlTaskIds: [], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] })),
    ensureRootGoal: vi.fn(async (): Promise<NativeVerificationEnsureResult> => ({ status: "passed", controlTaskIds: ["control-1"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [], rootGoalWitness: witness })),
    readRecoverableGoal: vi.fn(async () => null),
  }
  return { port, factory: vi.fn(() => ({ port, readTerminalProof })) }
}

describe("canonical native verification runtime composition", () => {
  it("uses the PostgreSQL verifier by default", () => {
    const created = createCanonicalNativeVerificationRuntime({
      pool: {} as pg.Pool, coordination: coordination(), durableWaitPort: waitPort, enabled: true,
    })
    expect(created.port).toBeDefined()
    expect(typeof created.port.ensureChildren).toBe("function")
    expect(typeof created.port.ensureRootGoal).toBe("function")
  })

  it("runs the native gate and validates exact persisted bytes with the terminal transaction client", async () => {
    const current = coordination()
    const query = vi.fn(async (_sql: unknown, _params: unknown) => ({ rows: [{ hasPendingSteer: false }] }))
    const client = { query } as unknown as Pick<PoolClient, "query">
    const readTerminalProof = vi.fn(async () => true)
    const { port, factory } = runtimeFactory(readTerminalProof)
    const runtime = createCanonicalNativeVerificationRuntime({
      pool: {} as pg.Pool, factory, coordination: current, durableWaitPort: waitPort, enabled: true,
    })

    await expect(runtime.checkCompletion("step-1", candidate)).resolves.toBeNull()
    expect(current.checkNativeGraphCompletion).toHaveBeenCalledOnce()
    expect(port.ensureChildren).toHaveBeenCalledOnce()
    expect(port.ensureRootGoal).toHaveBeenCalledWith({ scope, candidateText: candidate })
    expect(runtime.accepted()).toBe(true)
    const terminal = { finalContent: { text: candidate, final: { response: candidate } }, response: JSON.stringify({ response: candidate }) }
    await expect(runtime.checkTerminal(client, terminal)).resolves.toEqual({ nativeVerificationPassed: true })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"targetTurnId" = $3'), ["session-1", "user-1", "turn-1"])
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(readTerminalProof.mock.invocationCallOrder[0]!)
    expect(readTerminalProof).toHaveBeenCalledWith(client, { scope: readScope, candidateText: candidate, witness })
  })

  it("denies a changed terminal candidate before querying native proof", async () => {
    const readTerminalProof = vi.fn(async () => true)
    const { factory } = runtimeFactory(readTerminalProof)
    const runtime = createCanonicalNativeVerificationRuntime({
      pool: {} as pg.Pool, factory, coordination: coordination(), durableWaitPort: waitPort, enabled: true,
    })
    await runtime.checkCompletion("step-1", candidate)

    const changed = "A changed final answer."
    const terminal = { finalContent: { text: changed, final: { response: changed } }, response: JSON.stringify({ response: changed }) }
    const result = await runtime.checkTerminal({ query: vi.fn(async () => ({ rows: [{ hasPendingSteer: false }] })) } as unknown as Pick<PoolClient, "query">, terminal)

    expect(result.denial).toMatchObject({ ok: false, blocker: "task_graph_verification_unverified" })
    expect(readTerminalProof).not.toHaveBeenCalled()
  })

  it("blocks terminal proof when an owned Turn has accepted steering input", async () => {
    const query = vi.fn(async (_sql: unknown, _params: unknown) => ({ rows: [{ hasPendingSteer: true }] }))
    const client = { query } as unknown as Pick<PoolClient, "query">
    const readTerminalProof = vi.fn(async () => true)
    const { factory } = runtimeFactory(readTerminalProof)
    const runtime = createCanonicalNativeVerificationRuntime({
      pool: {} as pg.Pool, factory, coordination: coordination(), durableWaitPort: waitPort, enabled: true,
    })
    await runtime.checkCompletion("step-1", candidate)

    const result = await runtime.checkTerminal(client, terminalInput)

    expect(result).toMatchObject({
      nativeVerificationPassed: false,
      denial: {
        ok: false, blocker: "task_graph_verification_unverified",
        feedback: expect.stringContaining("new steering instruction"),
      },
    })
    expect(query).toHaveBeenCalledOnce()
    const sql = String(query.mock.calls[0]?.[0])
    expect(sql).toContain('"sessionId" = $1 AND "userId" = $2 AND "targetTurnId" = $3')
    expect(sql).toContain('"delivery" = \'steer\' AND "status" IN (\'accepted\', \'queued\')')
    expect(sql).toContain('"consumedByStepId" IS NULL AND "consumedAt" IS NULL AND "cancelledAt" IS NULL')
    expect(sql).not.toContain('"content"')
    expect(readTerminalProof).not.toHaveBeenCalled()
  })

  it("treats malformed pending-steer query results as pending and propagates query failures", async () => {
    const readTerminalProof = vi.fn(async () => true)
    const { factory } = runtimeFactory(readTerminalProof)
    const runtime = createCanonicalNativeVerificationRuntime({
      pool: {} as pg.Pool, factory, coordination: coordination(), durableWaitPort: waitPort, enabled: true,
    })
    await runtime.checkCompletion("step-1", candidate)

    const malformed = { query: vi.fn(async () => ({ rows: [{ hasPendingSteer: "false" }] })) } as unknown as Pick<PoolClient, "query">
    await expect(runtime.checkTerminal(malformed, terminalInput)).resolves.toMatchObject({
      nativeVerificationPassed: false,
      denial: { ok: false, blocker: "task_graph_verification_unverified" },
    })
    const unavailable = { query: vi.fn(async () => { throw new Error("database unavailable") }) } as unknown as Pick<PoolClient, "query">
    await expect(runtime.checkTerminal(unavailable, terminalInput)).rejects.toThrow("database unavailable")
    expect(readTerminalProof).not.toHaveBeenCalled()
  })

  it("leaves ordinary planner-disabled completion independent of TaskGraph command-port scope", async () => {
    const current = {
      readScope: () => { throw new Error("command port unavailable") },
      executionScope: () => { throw new Error("command port unavailable") },
      hasNativeTasks: vi.fn(async () => { throw new Error("native graph lookup must be skipped") }),
      checkNativeGraphCompletion: vi.fn(async () => null),
    }
    const { factory } = runtimeFactory(vi.fn(async () => true))
    const runtime = createCanonicalNativeVerificationRuntime({
      pool: {} as pg.Pool, factory, coordination: current, durableWaitPort: waitPort, enabled: false,
    })

    await expect(runtime.checkCompletion("step-1", candidate)).resolves.toBeNull()
    const query = vi.fn()
    await expect(runtime.checkTerminal({ query } as unknown as Pick<PoolClient, "query">, terminalInput)).resolves.toEqual({ nativeVerificationPassed: false })
    expect(current.checkNativeGraphCompletion).toHaveBeenCalledOnce()
    expect(current.hasNativeTasks).not.toHaveBeenCalled()
    expect(query).not.toHaveBeenCalled()
  })

  it("preserves an existing root-graph denial after a valid native proof", async () => {
    const client = { query: vi.fn() } as unknown as PoolClient
    const rootDenial = { ok: false as const, blocker: "typed_repair_unverified", feedback: "Repair evidence is still missing." }
    const checkTerminal = vi.fn(async () => ({ nativeVerificationPassed: true }))
    const checkRootGraph = vi.fn(async (actualClient: PoolClient, nativeVerificationPassed: boolean) => {
      expect(actualClient).toBe(client)
      expect(nativeVerificationPassed).toBe(true)
      return rootDenial
    })
    const finalizeSelectedJob = vi.fn(async () => ({ ok: true as const }))
    const guard = createCanonicalTurnTerminalGuard({
      enabled: true, nativeVerification: { checkTerminal }, checkRootGraph, finalizeSelectedJob,
    })
    if (!guard) throw new Error("terminal guard was not enabled")

    await expect(guard(client, terminalInput)).resolves.toBe(rootDenial)
    expect(checkRootGraph).toHaveBeenCalledOnce()
    expect(finalizeSelectedJob).not.toHaveBeenCalled()
  })

  it("fails closed when the current root-graph check has no result", async () => {
    const client = { query: vi.fn() } as unknown as PoolClient
    const finalizeSelectedJob = vi.fn(async () => ({ ok: true as const }))
    const guard = createCanonicalTurnTerminalGuard({
      enabled: true,
      nativeVerification: { checkTerminal: vi.fn(async () => ({ nativeVerificationPassed: true })) },
      checkRootGraph: vi.fn(async () => undefined), finalizeSelectedJob,
    })
    if (!guard) throw new Error("terminal guard was not enabled")

    await expect(guard(client, terminalInput)).resolves.toMatchObject({
      ok: false, blocker: "task_graph_verification_unverified",
    })
    expect(finalizeSelectedJob).not.toHaveBeenCalled()
  })

  it("keeps selected-job finalization authoritative after native and root proof", async () => {
    const client = { query: vi.fn() } as unknown as PoolClient
    const selectedJobDenial = { ok: false as const, blocker: "selected_job_draft_review_required", feedback: "The current draft is not approved." }
    const checkRootGraph = vi.fn(async (actualClient: PoolClient, nativeVerificationPassed: boolean) => {
      expect(actualClient).toBe(client)
      expect(nativeVerificationPassed).toBe(true)
      return { ok: true as const }
    })
    const finalizeSelectedJob = vi.fn(async (actualClient: PoolClient) => {
      expect(actualClient).toBe(client)
      return selectedJobDenial
    })
    const guard = createCanonicalTurnTerminalGuard({
      enabled: true,
      nativeVerification: { checkTerminal: vi.fn(async () => ({ nativeVerificationPassed: true })) },
      checkRootGraph, finalizeSelectedJob,
    })
    if (!guard) throw new Error("terminal guard was not enabled")

    await expect(guard(client, terminalInput)).resolves.toBe(selectedJobDenial)
    expect(finalizeSelectedJob).toHaveBeenCalledOnce()
  })
})
