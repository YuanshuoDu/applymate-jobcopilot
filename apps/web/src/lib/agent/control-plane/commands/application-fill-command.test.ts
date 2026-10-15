import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

const executionMocks = vi.hoisted(() => ({ interruptActiveTurn: vi.fn() }))
vi.mock("./execution-cancellation", () => ({ interruptActiveTurn: executionMocks.interruptActiveTurn }))

import { startApplicationFillForReview } from "./application-fill-command"

type Row = Record<string, unknown>
type Task = { id: string; userId: string; sessionId: string; jobId: string; resumeId: string | null; coverLetterId: string | null; status: string; checkpoint: string | null; fillTurnId: string | null; fillTurnSessionId: string | null; fillTurnUserId: string | null; confirmedAnswers?: unknown }
type ResumeSeed = { waitEvents?: Row[]; answerEvents?: Row[]; fillers?: Row[]; rootLeaseOwnerId?: string | null; rootLeaseExpiresAt?: Date | null; sessionStatus?: string }
type MaterialSeed = { jobOwned?: boolean; resumeAssociated?: boolean; coverLetterAssociated?: boolean }

function harness(seed: Partial<Task> = {}, failOutbox = false, resume?: ResumeSeed, materialSeed: MaterialSeed = {}) {
  let task: Task = { id: "application_1", userId: "user_1", sessionId: "session_1", jobId: "job_1", resumeId: "resume_1", coverLetterId: null, status: "waiting_for_user", checkpoint: "materials_ready", fillTurnId: null, fillTurnSessionId: null, fillTurnUserId: null, confirmedAnswers: null, ...seed }
  let sessionStatus = resume?.sessionStatus ?? (resume ? "waiting_for_user" : "running")
  let turns: Row[] = seed.fillTurnId ? [{ id: seed.fillTurnId, sessionId: "session_1", userId: "user_1", status: resume ? "waiting_for_user" : "completed", revision: 0, input: {}, leaseOwnerId: resume?.rootLeaseOwnerId ?? null, leaseExpiresAt: resume?.rootLeaseExpiresAt ?? null }] : []
  const fillers = resume?.fillers ?? []
  let inputs: Row[] = []
  let items: Row[] = []
  let events: Row[] = []
  let outbox: Row[] = []
  let eventSequence = BigInt(0)
  let applicationEventRead = 0
  let queue = Promise.resolve()
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ")
      if (sql.includes('FROM "agent_sessions"')) return [{ id: "session_1" }]
      if (sql.includes('FROM "application_tasks" AS app')) {
        if (task.resumeId === null || materialSeed.jobOwned === false || materialSeed.resumeAssociated === false) return []
        return [{ jobId: task.jobId, resumeId: task.resumeId, coverLetterId: task.coverLetterId }]
      }
      if (sql.includes('FROM "CoverLetter" AS cover')) return materialSeed.coverLetterAssociated === false ? [] : [{ id: task.coverLetterId }]
      if (sql.includes('FROM "application_tasks"')) return [{ ...task }]
      if (sql.includes('FROM "application_task_events"')) {
        applicationEventRead += 1
        return applicationEventRead === 1 ? resume?.waitEvents ?? [] : resume?.answerEvents ?? []
      }
      if (sql.includes('FROM "sub_agent_tasks"')) return fillers
      if (sql.includes('UPDATE "agent_sessions"')) return [{ eventSequence: ++eventSequence }]
      return []
    }),
    agentInput: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: Row }).where
        if (where.clientMessageId) return inputs.find(input => input.sessionId === where.sessionId && input.clientMessageId === where.clientMessageId) ?? null
        return inputs.find(input => input.targetTurnId === where.targetTurnId && input.userId === where.userId) ?? null
      }),
      create: vi.fn(async ({ data }: { data: Row }) => { inputs.push(data); return data }),
    },
    agentTurn: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: Row }).where
        if (where.id) return turns.find(turn => turn.id === where.id && turn.sessionId === where.sessionId && turn.userId === where.userId) ?? null
        return turns.find(turn => turn.sessionId === where.sessionId && turn.userId === where.userId && (where.status as { in: string[] }).in.includes(String(turn.status))) ?? null
      }),
      create: vi.fn(async ({ data }: { data: Row }) => { turns.push(data); return { id: data.id } }),
    },
    agentItem: { create: vi.fn(async ({ data }: { data: Row }) => { items.push(data); return data }) },
    agentEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: Row }).where
        return events.find(event => event.sessionId === where.sessionId && event.idempotencyKey === where.idempotencyKey) ?? null
      }),
      create: vi.fn(async ({ data }: { data: Row }) => { const event = { ...data }; events.push(event); return event }),
    },
    agentOutbox: { create: vi.fn(async ({ data }: { data: Row }) => { if (failOutbox) throw new Error("outbox unavailable"); outbox.push(data); return data }) },
    applicationTask: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (task.id !== where.id || task.userId !== where.userId || task.sessionId !== where.sessionId || task.status !== where.status || task.checkpoint !== where.checkpoint || task.fillTurnId !== where.fillTurnId) return { count: 0 }
        task = { ...task, ...data } as Task
        return { count: 1 }
      }),
    },
    agentSession: {
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        if (where.id !== "session_1" || where.userId !== "user_1" || where.status !== sessionStatus) return { count: 0 }
        sessionStatus = String(data.status)
        return { count: 1 }
      }),
    },
  }
  const db = { $transaction: vi.fn(<T>(work: (transaction: typeof tx) => Promise<T>) => {
    const run = queue.then(async () => {
      const before = { task: { ...task }, sessionStatus, turns: turns.map(row => ({ ...row })), inputs: inputs.map(row => ({ ...row })), items: [...items], events: [...events], outbox: [...outbox], fillers: fillers.map(row => ({ ...row })), eventSequence }
      try { return await work(tx) } catch (error) {
        task = before.task; sessionStatus = before.sessionStatus; turns = before.turns; inputs = before.inputs; items = before.items; events = before.events; outbox = before.outbox
        fillers.splice(0, fillers.length, ...before.fillers); eventSequence = before.eventSequence
        throw error
      }
    })
    queue = run.then(() => undefined, () => undefined)
    return run
  }) } as unknown as PrismaClient
  executionMocks.interruptActiveTurn.mockReset().mockImplementation(async (_tx: unknown, _command: unknown, active: Row) => {
    const prior = turns.find(turn => turn.id === active.id)
    if (prior) { prior.status = "interrupted"; prior.revision = Number(prior.revision) + 1 }
    for (const filler of fillers) filler.status = "interrupted"
    return { inputId: "interrupt_input", turnId: active.id, disposition: "interrupted", sequence: "2" }
  })
  return { db, tx, state: { get task() { return task }, get sessionStatus() { return sessionStatus }, get turns() { return turns }, get inputs() { return inputs }, get items() { return items }, get events() { return events }, get outbox() { return outbox } } }
}

const command = (clientMessageId: string, retry = false, resumeAfterUserInput = false) => ({ sessionId: "session_1", userId: "user_1", applicationTaskId: "application_1", clientMessageId, ...(retry ? { retry: true } : {}), ...(resumeAfterUserInput ? { resumeAfterUserInput: true } : {}) })

function readyToResume() {
  const waitAt = new Date("2026-10-15T10:00:00.000Z")
  return {
    waitEvents: [{ id: "wait_event_1", createdAt: waitAt }],
    answerEvents: [{ id: "answer_event_1", createdAt: new Date("2026-10-15T10:00:01.000Z"), answeredFieldCount: "1" }],
    fillers: [{ id: "subagent_fill_1", status: "waiting_for_user", leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null }],
  }
}

describe("startApplicationFillForReview", () => {
  it("atomically binds one canonical Turn, accepted input, task claim, and dispatch outbox", async () => {
    const fake = harness()
    const result = await startApplicationFillForReview(fake.db, command("fill_start_1"))
    expect(result).toMatchObject({ disposition: "started" })
    expect(fake.state.task).toMatchObject({ fillTurnId: result.turnId, fillTurnSessionId: "session_1", fillTurnUserId: "user_1", status: "filling", checkpoint: "taskgraph_fill_queued" })
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.events.map(event => event.type)).toEqual(["turn.started", "input.accepted"])
    expect(fake.state.outbox.filter(entry => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
    const preflightIndex = fake.tx.$queryRaw.mock.calls.findIndex(([query]) => ((query as { strings?: readonly string[] }).strings ?? []).join(" ").includes('FROM "application_tasks" AS app'))
    expect(preflightIndex).toBeGreaterThanOrEqual(0)
    expect(fake.tx.agentTurn.create.mock.invocationCallOrder[0]).toBeGreaterThan(fake.tx.$queryRaw.mock.invocationCallOrder[preflightIndex] ?? Number.POSITIVE_INFINITY)
  })

  it.each([
    ["job ownership", { jobOwned: false }, { coverLetterId: null }],
    ["required resume association", { resumeAssociated: false }, { coverLetterId: null }],
    ["referenced cover-letter ownership and association", { coverLetterAssociated: false }, { coverLetterId: "cover_1" }],
  ])("rejects missing or mismatched persisted %s before creating fill work", async (_label, materialSeed, taskSeed) => {
    const fake = harness(taskSeed, false, undefined, materialSeed)

    await expect(startApplicationFillForReview(fake.db, command("fill_invalid_material")))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(fake.state.task).toMatchObject({ status: "waiting_for_user", checkpoint: "materials_ready", fillTurnId: null })
    expect(fake.state.turns).toHaveLength(0)
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("returns the same Turn for duplicate and concurrent requests", async () => {
    const fake = harness()
    const [first, replay, concurrent] = await Promise.all([
      startApplicationFillForReview(fake.db, command("fill_start_1")),
      startApplicationFillForReview(fake.db, command("fill_start_1")),
      startApplicationFillForReview(fake.db, command("fill_start_other_key")),
    ])
    expect(new Set([first.turnId, replay.turnId, concurrent.turnId])).toHaveLength(1)
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.inputs).toHaveLength(1)
    expect(fake.state.outbox.filter(entry => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
  })

  it("rolls back the task claim and Turn if dispatch outbox creation fails", async () => {
    const fake = harness({}, true)
    await expect(startApplicationFillForReview(fake.db, command("fill_outbox_failure"))).rejects.toThrow("outbox unavailable")
    expect(fake.state.task).toMatchObject({ status: "waiting_for_user", checkpoint: "materials_ready", fillTurnId: null })
    expect(fake.state.turns).toHaveLength(0)
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("requires the explicit persisted-answer resume path for an unbound form-answer wait", async () => {
    const fake = harness({ status: "waiting_for_user", checkpoint: "form_answer_required" })
    await expect(startApplicationFillForReview(fake.db, command("fill_start_without_resume")))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(fake.state.task).toMatchObject({ fillTurnId: null, status: "waiting_for_user", checkpoint: "form_answer_required" })
    expect(fake.state.turns).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("only creates a new Turn after an explicit retry of a safe terminal failure", async () => {
    const fake = harness({ status: "failed", checkpoint: "fill_prestart_failed", fillTurnId: "turn_previous", fillTurnSessionId: "session_1", fillTurnUserId: "user_1" })
    const result = await startApplicationFillForReview(fake.db, command("fill_retry_1", true))
    expect(result.disposition).toBe("started")
    expect(result.turnId).not.toBe("turn_previous")
    expect(fake.state.task).toMatchObject({ fillTurnId: result.turnId, status: "filling", checkpoint: "taskgraph_fill_queued" })
    expect(fake.state.turns).toHaveLength(2)
  })

  it("does not auto-retry an ambiguous or non-terminal previous attempt", async () => {
    const fake = harness({ status: "waiting_for_user", checkpoint: "fill_outcome_uncertain", fillTurnId: "turn_previous", fillTurnSessionId: "session_1", fillTurnUserId: "user_1" })
    await expect(startApplicationFillForReview(fake.db, command("fill_retry_ambiguous", true)))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.task.checkpoint).toBe("fill_outcome_uncertain")
  })

  it("resumes only after persisted answers and a lease-free application-filler wait, preserving the old Turn", async () => {
    const fake = harness({ status: "waiting_for_user", checkpoint: "form_answer_required", fillTurnId: "turn_previous", fillTurnSessionId: "session_1", fillTurnUserId: "user_1", confirmedAnswers: { location: "Dublin" } }, false, readyToResume())
    const result = await startApplicationFillForReview(fake.db, command("application-fill-resume:application_1", false, true))

    expect(result.disposition).toBe("started")
    expect(result.turnId).not.toBe("turn_previous")
    expect(fake.state.task).toMatchObject({ fillTurnId: result.turnId, status: "filling", checkpoint: "taskgraph_fill_queued" })
    expect(fake.state.sessionStatus).toBe("running")
    expect(fake.state.turns.find(turn => turn.id === "turn_previous")?.status).toBe("interrupted")
    expect(fake.state.turns).toHaveLength(2)
    expect(fake.state.inputs.find(input => input.targetTurnId === result.turnId)?.clientMessageId).toMatch(/^application-fill-resume:application_1:/)
    expect(fake.state.outbox.filter(entry => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(executionMocks.interruptActiveTurn).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ expectedTurnId: "turn_previous", expectedRevision: 0 }),
      expect.objectContaining({ id: "turn_previous" }),
      { taskGraphFillCancellation: "preserve" },
    )
  })

  it("rejects invalid persisted materials before interrupting a resumable fill Turn", async () => {
    const fake = harness({ status: "waiting_for_user", checkpoint: "form_answer_required", fillTurnId: "turn_previous", fillTurnSessionId: "session_1", fillTurnUserId: "user_1", confirmedAnswers: { location: "Dublin" } }, false, readyToResume(), { resumeAssociated: false })

    await expect(startApplicationFillForReview(fake.db, command("application-fill-resume:application_1", false, true)))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(executionMocks.interruptActiveTurn).not.toHaveBeenCalled()
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.turns[0]?.status).toBe("waiting_for_user")
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("returns the currently bound resumed Turn for duplicate and concurrent requests", async () => {
    const fake = harness({ status: "waiting_for_user", checkpoint: "form_answer_required", fillTurnId: "turn_previous", fillTurnSessionId: "session_1", fillTurnUserId: "user_1", confirmedAnswers: { location: "Dublin" } }, false, readyToResume())
    const first = await startApplicationFillForReview(fake.db, command("application-fill-resume:application_1", false, true))
    const [replay, concurrent] = await Promise.all([
      startApplicationFillForReview(fake.db, command("application-fill-resume:application_1", false, true)),
      startApplicationFillForReview(fake.db, command("application-fill-resume:application_1", false, true)),
    ])
    expect(replay).toMatchObject({ turnId: first.turnId, disposition: "duplicate" })
    expect(concurrent).toMatchObject({ turnId: first.turnId, disposition: "duplicate" })
    expect(fake.state.turns).toHaveLength(2)
    expect(fake.state.outbox.filter(entry => entry.topic === "agent.turn.dispatch")).toHaveLength(1)
  })

  const unsafeResumeCases: Array<[string, Partial<Task>, ResumeSeed]> = [
    ["uncertain fill outcome", { status: "waiting_for_user", checkpoint: "fill_outcome_uncertain" }, readyToResume()],
    ["missing persisted answer event", { status: "waiting_for_user", checkpoint: "form_answer_required", confirmedAnswers: { location: "Dublin" } }, { ...readyToResume(), answerEvents: [] }],
    ["active browser lease", { status: "waiting_for_user", checkpoint: "form_answer_required", confirmedAnswers: { location: "Dublin" } }, { ...readyToResume(), fillers: [{ id: "subagent_fill_1", status: "running", leaseOwner: "worker_1", leaseExpiresAt: new Date("2026-10-15T10:05:00.000Z"), interruptRequestedAt: null }] }],
    ["active Turn lease", { status: "waiting_for_user", checkpoint: "form_answer_required", confirmedAnswers: { location: "Dublin" } }, { ...readyToResume(), rootLeaseOwnerId: "turn_worker_1", rootLeaseExpiresAt: new Date("2026-10-15T10:05:00.000Z") }],
  ]
  it.each(unsafeResumeCases)("does not resume when %s", async (_label, taskSeed, resumeSeed) => {
    const fake = harness({ ...taskSeed, fillTurnId: "turn_previous", fillTurnSessionId: "session_1", fillTurnUserId: "user_1" }, false, resumeSeed)
    await expect(startApplicationFillForReview(fake.db, command("application-fill-resume:application_1", false, true)))
      .rejects.toMatchObject({ code: "retry_target_invalid", status: 409 })
    expect(fake.state.task.fillTurnId).toBe("turn_previous")
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.outbox).toHaveLength(0)
    expect(executionMocks.interruptActiveTurn).not.toHaveBeenCalled()
  })

  it("rolls back old-Turn terminalization and the task claim if the new dispatch outbox fails", async () => {
    const fake = harness({ status: "waiting_for_user", checkpoint: "form_answer_required", fillTurnId: "turn_previous", fillTurnSessionId: "session_1", fillTurnUserId: "user_1", confirmedAnswers: { location: "Dublin" } }, true, readyToResume())
    await expect(startApplicationFillForReview(fake.db, command("application-fill-resume:application_1", false, true))).rejects.toThrow("outbox unavailable")
    expect(fake.state.task).toMatchObject({ fillTurnId: "turn_previous", status: "waiting_for_user", checkpoint: "form_answer_required" })
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.turns[0].status).toBe("waiting_for_user")
    expect(fake.state.sessionStatus).toBe("waiting_for_user")
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("does not resume a fill while its Agent session is no longer waiting for user input", async () => {
    const fake = harness({ status: "waiting_for_user", checkpoint: "form_answer_required", fillTurnId: "turn_previous", fillTurnSessionId: "session_1", fillTurnUserId: "user_1", confirmedAnswers: { location: "Dublin" } }, false, { ...readyToResume(), sessionStatus: "paused" })
    await expect(startApplicationFillForReview(fake.db, command("application-fill-resume:application_1", false, true)))
      .rejects.toMatchObject({ code: "retry_active_conflict", status: 409 })
    expect(fake.state.task.fillTurnId).toBe("turn_previous")
    expect(fake.state.sessionStatus).toBe("paused")
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.outbox).toHaveLength(0)
  })
})
