import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { PoolClient } from "pg"
import { digestNativeVerificationValue } from "./subagents/native-verification-contract.js"
import type { NativeVerificationEnsureResult, NativeVerificationPort, NativeVerificationRootGoalWitness } from "./subagents/native-verification-port.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./subagents/task-graph-command-port.js"
import type { DurableWaitPort } from "./tools/coordination-types.js"
import { NATIVE_SEMANTIC_NO_PROGRESS, RESET_NATIVE_SEMANTIC_PROGRESS } from "./turns/turn-execution-types.js"
import type { TurnEngineTerminalGuard } from "./turns/turn-engine-terminal-commit.js"
import { createCanonicalNativeVerificationRuntime, createCanonicalRootCompletionGate, createCanonicalTurnTerminalGuard, type NativeVerificationRuntime } from "./canonical-turn-native-verification-runtime.js"

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
const terminalInput = { stepId: "step-1", finalContent: { text: candidate }, response: candidate } as unknown as Parameters<TurnEngineTerminalGuard>[1]

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
function rootSemanticFailure(controlTaskId = "private-control-id"): NativeVerificationEnsureResult {
  return { status: "failed", controlTaskIds: [controlTaskId], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [{
    controlTaskId, targetTaskId: "root-1", disposition: "failed",
    criteria: [{ criterionId: "current-evidence", disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] }],
  }] }
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
    const terminal = { stepId: "step-terminal", finalContent: { text: candidate, final: { response: candidate } }, response: JSON.stringify({ response: candidate }) }
    await expect(runtime.checkTerminal(client, terminal)).resolves.toEqual({ nativeVerificationPassed: true })
    expect(query).toHaveBeenCalledWith(expect.stringContaining('"targetTurnId" = $3'), ["session-1", "user-1", "turn-1"])
    expect(query.mock.invocationCallOrder[0]).toBeLessThan(readTerminalProof.mock.invocationCallOrder[0]!)
    expect(readTerminalProof).toHaveBeenCalledWith(client, { scope: readScope, candidateText: candidate, witness, stepId: "step-terminal" })
  })

  it("keeps legacy terminal calls on exact-no-step selection instead of guessing the latest Step", async () => {
    const readTerminalProof = vi.fn(async () => true), { factory } = runtimeFactory(readTerminalProof)
    const runtime = createCanonicalNativeVerificationRuntime({ pool: {} as pg.Pool, factory,
      coordination: coordination(), durableWaitPort: waitPort, enabled: true })
    await runtime.checkCompletion("step-current", candidate)
    const client = { query: vi.fn(async () => ({ rows: [{ hasPendingSteer: false }] })) } as unknown as Pick<PoolClient, "query">

    await expect(runtime.checkTerminal(client, { finalContent: { text: candidate, final: { response: candidate } },
      response: JSON.stringify({ response: candidate }) })).resolves.toEqual({ nativeVerificationPassed: true })

    expect(readTerminalProof).toHaveBeenCalledWith(client, { scope: readScope, candidateText: candidate, witness, stepId: undefined })
  })

  it("wires the private progress reset hook only onto the root completion gate", () => {
    const reset = vi.fn()
    const gate = createCanonicalRootCompletionGate({
      enabled: true, nativeVerification: { checkCompletion: async () => null, accepted: () => false, resetSemanticProgress: reset },
      onCandidateStart: vi.fn(), checkChildren: () => undefined, selectedJobMode: false,
    })
    expect(gate).toBeDefined()
    gate?.[RESET_NATIVE_SEMANTIC_PROGRESS]?.()
    expect(reset).toHaveBeenCalledOnce()
  })

  it("signals the third distinct strict root rejection while keeping its key private", async () => {
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => ({ status: "passed" as const, controlTaskIds: [], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] })),
      ensureRootGoal: vi.fn(async () => rootSemanticFailure()), readRecoverableGoal: vi.fn(async () => null),
    }
    const factory = vi.fn(() => ({ port, readTerminalProof: vi.fn(async () => true) }))
    const runtime = createCanonicalNativeVerificationRuntime({ pool: {} as pg.Pool, factory, coordination: coordination(), durableWaitPort: waitPort, enabled: true })
    const first = await runtime.checkCompletion("step-1", candidate)
    const replay = await runtime.checkCompletion("step-1", candidate)
    const second = await runtime.checkCompletion("step-2", candidate)
    const third = await runtime.checkCompletion("step-3", candidate)
    expect(first && !first.ok ? first[NATIVE_SEMANTIC_NO_PROGRESS] : undefined).toBeUndefined()
    expect(replay && !replay.ok ? replay[NATIVE_SEMANTIC_NO_PROGRESS] : undefined).toBeUndefined()
    expect(second && !second.ok ? second[NATIVE_SEMANTIC_NO_PROGRESS] : undefined).toBeUndefined()
    if (!third || third.ok) throw new Error("expected a rejected root verification decision")
    expect(third[NATIVE_SEMANTIC_NO_PROGRESS]).toBe(true)
    expect(third.feedback).toContain("criterion=current-evidence status=failed reason=does_not_meet_criterion")
    expect(JSON.stringify(third)).not.toContain("private-control-id")
    expect(JSON.stringify(third)).not.toContain(digestNativeVerificationValue(candidate))
  })

  it("resets after a nonsemantic root result and when the owned binding changes", async () => {
    const failures = [rootSemanticFailure("control-a"), rootSemanticFailure("control-a"),
      { status: "uncertain" as const, controlTaskIds: ["control-a"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] },
      rootSemanticFailure("control-a"), rootSemanticFailure("control-a"), rootSemanticFailure("control-a"),
      rootSemanticFailure("control-b"), rootSemanticFailure("control-b"), rootSemanticFailure("control-b")]
    let index = 0
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async () => ({ status: "passed" as const, controlTaskIds: [], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] })),
      ensureRootGoal: vi.fn(async () => failures[index++] ?? rootSemanticFailure()), readRecoverableGoal: vi.fn(async () => null),
    }
    const runtime = createCanonicalNativeVerificationRuntime({ pool: {} as pg.Pool, factory: () => ({ port, readTerminalProof: vi.fn(async () => true) }),
      coordination: coordination(), durableWaitPort: waitPort, enabled: true })
    const results = []
    for (let step = 1; step <= 9; step += 1) results.push(await runtime.checkCompletion(`step-${step}`, candidate))
    expect(results.slice(0, 5).every(result => !result || result.ok || result[NATIVE_SEMANTIC_NO_PROGRESS] === undefined)).toBe(true)
    expect(results[5] && !results[5].ok ? results[5][NATIVE_SEMANTIC_NO_PROGRESS] : undefined).toBe(true)
    expect(results[6] && !results[6].ok ? results[6][NATIVE_SEMANTIC_NO_PROGRESS] : undefined).toBeUndefined()
    expect(results[7] && !results[7].ok ? results[7][NATIVE_SEMANTIC_NO_PROGRESS] : undefined).toBeUndefined()
    expect(results[8] && !results[8].ok ? results[8][NATIVE_SEMANTIC_NO_PROGRESS] : undefined).toBe(true)
  })

  it.each([
    "pending", "pass", "uncertain", "unavailable", "malformed", "child", "receipt", "exception",
  ] as const)("resets two consecutive root rejects across a real runtime %s outcome", async outcome => {
    type Stage = typeof outcome | "reject"
    let stage: Stage = "reject"
    const childrenPassed: NativeVerificationEnsureResult = {
      status: "passed", controlTaskIds: [], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [],
    }
    const childFailure: NativeVerificationEnsureResult = {
      status: "failed", controlTaskIds: ["child-control"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [{
        controlTaskId: "child-control", targetTaskId: "child-1", disposition: "failed",
        criteria: [{ criterionId: "child-evidence", disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: [] }],
      }],
    }
    const pendingChildren: NativeVerificationEnsureResult = {
      status: "pending", controlTaskIds: ["child-control"], pendingControlTaskIds: ["child-control"],
      pendingTaskIds: ["child-1"], feedback: [],
    }
    const malformedRoot = {
      status: "failed", controlTaskIds: ["control-a"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [{
        controlTaskId: "control-a", targetTaskId: "root-1", disposition: "failed",
        criteria: [{ criterionId: "bad-reason", disposition: "failed", reasonCode: "not_a_reason", evidenceReferenceIds: [] }],
      }],
    } as unknown as NativeVerificationEnsureResult
    const port: NativeVerificationPort = {
      ensureChildren: vi.fn(async (): Promise<NativeVerificationEnsureResult> => {
        if (stage === "pending") return pendingChildren
        if (stage === "child") return childFailure
        return childrenPassed
      }),
      ensureRootGoal: vi.fn(async (): Promise<NativeVerificationEnsureResult> => {
        if (stage === "pass") return {
          status: "passed", controlTaskIds: [witness.controlTaskId], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [],
          rootGoalWitness: witness,
        }
        if (stage === "uncertain") return { status: "uncertain", controlTaskIds: ["control-a"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] }
        if (stage === "unavailable") return { status: "unavailable", controlTaskIds: ["control-a"], pendingControlTaskIds: [], pendingTaskIds: [], feedback: [] }
        if (stage === "malformed") return malformedRoot
        if (stage === "exception") throw new Error("fixture verifier unavailable")
        return rootSemanticFailure("control-a")
      }),
      readRecoverableGoal: vi.fn(async () => null),
    }
    const current = {
      ...coordination(),
      checkNativeGraphCompletion: vi.fn(async () => stage === "receipt"
        ? { ok: false as const, blocker: "task_graph_verification_unverified", feedback: "receipt missing" }
        : null),
    }
    const matrixWaitPort: DurableWaitPort = { wait: vi.fn(async () => ({
      waitId: "matrix-wait", status: "waiting" as const, deadlineAt: "2099-01-01T00:00:00.000Z", matchedTaskIds: [],
    })) }
    const runtime = createCanonicalNativeVerificationRuntime({
      pool: {} as pg.Pool, factory: () => ({ port, readTerminalProof: vi.fn(async () => true) }),
      coordination: current, durableWaitPort: matrixWaitPort, enabled: true,
    })
    let step = 0
    const check = () => runtime.checkCompletion(`matrix-${outcome}-${++step}`, candidate)
    const stopped = (result: Awaited<ReturnType<typeof check>>) =>
      Boolean(result && !result.ok && result[NATIVE_SEMANTIC_NO_PROGRESS] === true)

    expect(stopped(await check())).toBe(false)
    expect(stopped(await check())).toBe(false)
    stage = outcome
    if (outcome === "exception") {
      await expect(check()).rejects.toThrow("fixture verifier unavailable")
    } else {
      const result = await check()
      const blocker = result && !result.ok ? result.blocker : null
      expect(blocker).toBe(outcome === "pass" ? null : outcome === "pending" ? "native_verification_pending" : "task_graph_verification_unverified")
      expect(stopped(result)).toBe(false)
    }
    expect(runtime.accepted()).toBe(outcome === "pass")
    stage = "reject"
    expect(stopped(await check())).toBe(false)
    expect(stopped(await check())).toBe(false)
    expect(stopped(await check())).toBe(true)
    if (outcome === "pending") expect(matrixWaitPort.wait).toHaveBeenCalledOnce()
    if (outcome === "receipt") expect(port.ensureChildren).toHaveBeenCalledTimes(5)
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
