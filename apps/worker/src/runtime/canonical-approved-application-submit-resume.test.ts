import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { CanonicalTurnState } from "./canonical-turn-state.js"
import type { TurnLease } from "./turns/lease.js"
import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import type { RootTaskStore } from "./subagents/root-task-store.js"
import type { CanonicalExecutionProjection } from "./canonical-execution-projection.js"
import type { CanonicalSessionProjection } from "./canonical-session-projection.js"
import type { CanonicalApprovedApplicationSubmitResumeProof } from "./canonical-approved-application-submit-resume-proof.js"
import { finishApprovedApplicationFillTurn, readCurrentApprovedApplicationSubmitResumeProof } from "./canonical-approved-application-submit-resume.js"
import { TASK_GRAPH_FINAL_SUMMARY_BINDING, type TaskGraphFinalSummaryBinding } from "./subagents/task-graph-final-summary-binding.js"
import { reduceTaskGraphFinalSummary } from "./subagents/task-graph-final-summary.js"
import { taskGraphItemId } from "./subagents/task-graph-snapshot.js"

const { readProof } = vi.hoisted(() => ({ readProof: vi.fn() }))
vi.mock("./canonical-approved-application-submit-resume-proof.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./canonical-approved-application-submit-resume-proof.js")>()
  return { ...actual, readCanonicalApprovedApplicationSubmitResumeProof: readProof }
})

const lease: TurnLease = { turnId: "fill-turn", sessionId: "session-1", userId: "user-1", ownerId: "worker-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-11-22T10:00:00Z"), leaseExpiresAt: new Date("2026-11-22T10:05:00Z") }
const now = () => new Date("2026-11-22T10:01:00Z")
const proof = (state: "form_filled" | "submission_authorized" = "form_filled"): CanonicalApprovedApplicationSubmitResumeProof => ({
  userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-fill", turnOwnerId: lease.ownerId,
  turnLeaseVersion: lease.leaseVersion, turnRevision: 7, applicationTaskId: "app-task", jobId: "job-1",
  fillerTaskId: "filler-1", graphRevision: 4, graphFingerprint: "a".repeat(64), approvalId: "approval-1", waitItemId: "wait-1",
  approvalRevision: 2, resourceHash: "sha256:" + "b".repeat(64), materialHash: "sha256:" + "c".repeat(64),
  answersHash: "sha256:" + "d".repeat(64), state,
  workerTaskId: state === "submission_authorized" ? "worker-task-1" : null,
  outboxId: state === "submission_authorized" ? "outbox-1" : null,
})
const turnState = (overrides: Partial<CanonicalTurnState> = {}): CanonicalTurnState => ({
  scope: { userId: lease.userId }, source: "user", goal: "Fill the approved application form", rootTaskId: "root-fill",
  modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {},
  snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
  resume: { nextOrdinal: 2, stepCount: 2, toolCallCount: 1, inputThroughSequence: 8n, consumedInputIds: ["input-1"],
    usage: { inputTokens: 23, outputTokens: 11, estimatedCostUsd: 0.003 } },
  ...overrides,
})
const graphBinding = (): TaskGraphFinalSummaryBinding => ({
  rootTaskId: "root-fill", graphItemId: taskGraphItemId("root-fill"), graphRevision: 4,
  members: [{ nodeIndex: 0, nodeKey: "application-fill", templateId: "application_filler", taskId: "filler-1",
    role: "application_filler", taskType: "application_fill_for_review", taskStatus: "completed", kind: "business" }],
  summary: reduceTaskGraphFinalSummary({ graphRevision: 4, nodes: [{ kind: "business", taskId: "filler-1",
    role: "application_filler", taskStatus: "completed" }] }),
})

describe("approved application fill Turn resume", () => {
  beforeEach(() => readProof.mockReset())

  it("reads the exact active root and proof in one tenant-scoped read transaction", async () => {
    const client = { query: vi.fn(async (sql: string) => sql.includes('SELECT turn."rootTaskId"')
      ? { rows: [{ rootTaskId: "root-fill" }], rowCount: 1 } : { rows: [], rowCount: 0 }), release: vi.fn() }
    const pool = { connect: vi.fn(async () => client) } as unknown as Pick<pg.Pool, "connect">
    readProof.mockResolvedValue(proof())

    await expect(readCurrentApprovedApplicationSubmitResumeProof({ pool, lease, now: now() })).resolves.toEqual({ rootTaskId: "root-fill", proof: proof() })
    expect(client.query).toHaveBeenCalledWith("SELECT set_config($1, $2, true)", ["app.user_id", lease.userId])
    expect(readProof).toHaveBeenCalledWith(client, { lease, rootTaskId: "root-fill", now: now() })
    expect(client.query).toHaveBeenCalledWith("COMMIT")
    expect(client.release).toHaveBeenCalledOnce()
    expect(client.query.mock.calls.some(([sql]) => /INSERT|UPDATE|DELETE/i.test(sql))).toBe(false)
  })

  it("finishes the exact filled Turn with no model call and rechecks proof plus TaskGraph in the terminal transaction", async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }
    const binding = graphBinding()
    const completion = { ok: true as const, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: binding }
    const finalizationGuardCalls: unknown[] = []
    const appended: Parameters<TurnEngineStore["appendEvent"]>[0][] = []
    const startedOrdinals: number[] = []
    const storeFactory = (_pool: pg.Pool, guard?: NonNullable<Parameters<typeof import("./turns/turn-engine-store.js").createPgTurnEngineStore>[1]>) => ({
      appendEvent: vi.fn(async (input: Parameters<TurnEngineStore["appendEvent"]>[0]) => { appended.push(input); return { id: input.id } }),
      startStep: vi.fn(async (input: { stepId: string; ordinal: number }) => {
        startedOrdinals.push(input.ordinal)
        return { id: input.stepId, ordinal: input.ordinal }
      }),
      updateStep: vi.fn(async () => undefined),
      recordFinalResponse: vi.fn(async input => {
        const terminal = { ...input.terminal!, owner: input.owner, response: input.response, now: input.now }
        const result = await guard!(client as never, terminal as never, undefined)
        finalizationGuardCalls.push({ terminal, result })
        return result.ok ? { status: "completed" as const, finalItemId: terminal.finalItemId, events: [] } : undefined
      }),
    } as unknown as TurnEngineStore)
    const rootTasks = { checkCompletion: vi.fn(async () => completion), finish: vi.fn(async () => undefined) } as unknown as RootTaskStore
    const execution = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) } as unknown as CanonicalExecutionProjection
    const session = { start: vi.fn(async () => undefined), finish: vi.fn(async () => undefined) } as unknown as CanonicalSessionProjection
    const filled = proof("form_filled")
    readProof.mockResolvedValue(proof("submission_authorized"))

    const result = await finishApprovedApplicationFillTurn({ pool: {} as pg.Pool, lease, state: turnState(), rootTaskId: "root-fill",
      proof: filled, signal: new AbortController().signal, rootTasks, executionProjection: execution, sessionProjection: session, now,
      storeFactory: storeFactory as never })

    expect(result).toEqual({ status: "completed" })
    expect(readProof).toHaveBeenCalledWith(client, { lease, rootTaskId: "root-fill", now: now() })
    expect(rootTasks.checkCompletion).toHaveBeenCalledWith(expect.objectContaining({ lease, rootTaskId: "root-fill",
      taskGraphVerification: true, nativeVerificationPassed: false, requireTaskGraph: true }))
    expect(rootTasks.checkCompletion).toHaveBeenCalledWith(expect.objectContaining({ lease, rootTaskId: "root-fill",
      taskGraphVerification: true, nativeVerificationPassed: false, requireTaskGraph: true, client }))
    expect((finalizationGuardCalls[0] as { result: unknown }).result).toEqual({ ok: true })
    expect(rootTasks.finish).toHaveBeenCalledWith(expect.objectContaining({ rootTaskId: "root-fill",
      result: expect.objectContaining({ status: "completed", stepCount: 3, toolCallCount: 1 }) }))
    const started = appended.find(event => event.type === "turn.started")
    expect(started).toMatchObject({ id: expect.stringMatching(/^turn:fill-turn:event:turn-started:[0-9a-f-]{36}$/),
      itemId: null, correlationId: lease.turnId, causationId: null, idempotencyKey: `turn:${lease.turnId}:event:turn-started`,
      payload: { goal: turnState().goal, taskId: "root-fill", rootTaskId: "root-fill" } })
    expect(startedOrdinals).toEqual([2])
    expect(appended.find(event => event.type === "step.started")?.causationId).toBe(started?.id)
    const finalResponse = JSON.parse(String((finalizationGuardCalls[0] as { terminal: { response: string } }).terminal.response)) as { response: string }
    expect(finalResponse.response).toContain("do not confirm that an application was submitted")
    expect((finalizationGuardCalls[0] as { terminal: { [TASK_GRAPH_FINAL_SUMMARY_BINDING]?: TaskGraphFinalSummaryBinding } })
      .terminal[TASK_GRAPH_FINAL_SUMMARY_BINDING]).toEqual(binding)
    expect((finalizationGuardCalls[0] as { result: { ok: boolean } }).result.ok).toBe(true)
    expect(execution.start).toHaveBeenCalledOnce()
    expect(execution.finish).toHaveBeenCalledWith(expect.objectContaining({ result: { status: "completed" } }))
    expect(session.finish).toHaveBeenCalledWith(expect.objectContaining({ result: { status: "completed" } }))
  })

  it("denies a changed witness before the terminal receipt and root completion", async () => {
    const client = { query: vi.fn(async () => ({ rows: [], rowCount: 1 })) }
    const completion = { ok: true as const, [TASK_GRAPH_FINAL_SUMMARY_BINDING]: graphBinding() }
    const storeFactory = (_pool: pg.Pool, guard?: NonNullable<Parameters<typeof import("./turns/turn-engine-store.js").createPgTurnEngineStore>[1]>) => ({
      appendEvent: vi.fn(async input => ({ id: input.id })), startStep: vi.fn(async input => ({ id: input.stepId, ordinal: input.ordinal })),
      updateStep: vi.fn(async () => undefined), recordFinalResponse: vi.fn(async input => {
        const terminal = { ...input.terminal!, owner: input.owner, response: input.response, now: input.now }
        const decision = await guard!(client as never, terminal as never, undefined)
        return decision.ok ? { status: "completed" as const, finalItemId: terminal.finalItemId, events: [] } : undefined
      }),
    } as unknown as TurnEngineStore)
    const rootTasks = { checkCompletion: vi.fn(async () => completion), finish: vi.fn(async () => undefined) } as unknown as RootTaskStore
    readProof.mockResolvedValue({ ...proof(), materialHash: "sha256:" + "e".repeat(64) })

    await expect(finishApprovedApplicationFillTurn({ pool: {} as pg.Pool, lease, state: turnState(), rootTaskId: "root-fill",
      proof: proof(), signal: new AbortController().signal, rootTasks,
      executionProjection: { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalExecutionProjection,
      sessionProjection: { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalSessionProjection, now, storeFactory: storeFactory as never,
    })).rejects.toThrow("approved_application_fill_resume_terminal_receipt_missing")
    expect(rootTasks.checkCompletion).toHaveBeenCalledOnce()
    expect(rootTasks.finish).not.toHaveBeenCalled()
  })

  it("requires a restored continuation ordinal instead of restarting at zero", async () => {
    const rootTasks = { checkCompletion: vi.fn(), finish: vi.fn() } as unknown as RootTaskStore
    const storeFactory = vi.fn(() => ({} as TurnEngineStore))
    await expect(finishApprovedApplicationFillTurn({ pool: {} as pg.Pool, lease,
      state: turnState({ resume: undefined }), rootTaskId: "root-fill", proof: proof(),
      signal: new AbortController().signal, rootTasks,
      executionProjection: { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalExecutionProjection,
      sessionProjection: { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalSessionProjection, now,
      storeFactory: storeFactory as never,
    })).rejects.toThrow("approved_application_fill_resume_count_invalid")
    expect(storeFactory).not.toHaveBeenCalled()
    expect(rootTasks.checkCompletion).not.toHaveBeenCalled()
  })

  it("fails closed when a required same-transaction root completion check is unavailable", async () => {
    await expect(finishApprovedApplicationFillTurn({ pool: {} as pg.Pool, lease, state: turnState(), rootTaskId: "root-fill",
      proof: proof(), signal: new AbortController().signal, rootTasks: { finish: vi.fn() } as unknown as RootTaskStore,
      executionProjection: { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalExecutionProjection,
      sessionProjection: { start: vi.fn(), finish: vi.fn() } as unknown as CanonicalSessionProjection, now,
    })).rejects.toThrow("approved_application_fill_resume_scope_invalid")
  })
})
