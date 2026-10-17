import { beforeEach, describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

const mocks = vi.hoisted(() => ({
  acceptInputFacts: vi.fn(),
  createRootTurn: vi.fn(),
  lockOpenSession: vi.fn(),
  verifyAndCancelSubmissionJob: vi.fn(),
}))
vi.mock("./transaction", () => ({
  acceptInputFacts: mocks.acceptInputFacts,
  createRootTurn: mocks.createRootTurn,
  lockOpenSession: mocks.lockOpenSession,
}))
vi.mock("@/lib/apply-queue-client", async importOriginal => ({
  ...await importOriginal<typeof import("@/lib/apply-queue-client")>(),
  verifyAndCancelSubmissionJob: mocks.verifyAndCancelSubmissionJob,
}))

import { confirmSubmissionNotReceived } from "./application-submission-recovery-command"

type Row = Record<string, unknown>
const command = {
  sessionId: "session_1", userId: "user_1", applicationTaskId: "application_1",
  requestId: "confirm_12345678", confirmedNotReceived: true as const,
}

function harness(options: {
  task?: Partial<Row>; turn?: Partial<Row>; job?: Partial<Row>; fillers?: Row[]; queuedEvents?: Row[]; approvals?: Row[]
  executionEvents?: Row[]
  submissionAttempt?: Partial<Row>; attemptMissing?: boolean; fillMaterials?: Row[]; coverLetters?: Row[]
  duplicate?: Row[]; terminalEvents?: Row[]; queueMissing?: boolean; unsafeQueue?: boolean; activeTurn?: Row | null; notFound?: boolean
} = {}) {
  const task: Row = {
    id: "application_1", userId: "user_1", sessionId: "session_1", jobId: "job_1",
    status: "waiting_for_user", checkpoint: "submission_uncertain", fillTurnId: "turn_old",
    fillTurnSessionId: "session_1", fillTurnUserId: "user_1", workerTaskId: "bull_old", ...options.task,
  }
  const turn: Row = { id: "turn_old", status: "completed", leaseOwnerId: null, leaseExpiresAt: null, ...options.turn }
  const filler: Row = { id: "filler_1", status: "completed", leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
    role: "application_filler", taskType: "application_fill_for_review" }
  const queued: Row = { id: "queue_event_1", data: {
    applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1",
    fillTurnId: "turn_old", approvalId: "approval_1", constraintHash: "constraint_1", workerTaskId: "bull_old",
  } }
  const executionData = { executionId: "execution_old", workerTaskId: task.workerTaskId, applicationTaskId: task.id,
    userId: task.userId, jobId: task.jobId, sessionId: task.sessionId, fillTurnId: task.fillTurnId,
    approvalId: "approval_1", constraintHash: "constraint_1" }
  const executionEvents = options.executionEvents ?? [
    { type: "submission_execution_started", actor: "worker", data: executionData },
    { type: "submission_execution_settled", actor: "worker", data: { ...executionData } },
  ]
  const approval: Row = { id: "approval_1", sessionId: "session_1", userId: "user_1", turnId: "turn_old", jobId: "job_1",
    type: "submit_application", status: "consumed", scopeHash: "constraint_1", payload: { applicationTaskId: "application_1", jobId: "job_1" } }
  const submissionAttempt: Row = { userId: "user_1", jobId: "job_1", receiptId: "approval_1", constraintHash: "constraint_1", state: "reserved", ...options.submissionAttempt }
  const fillMaterial: Row = { jobId: "job_1", resumeId: "resume_1", coverLetterId: null }
  const job: Row = { id: "job_1", userId: "user_1", status: "saved", workflowState: "submitting", appliedAt: null, ...options.job }
  const taskEvents: Row[] = []
  const turns: Row[] = [turn]
  const inputs: Row[] = []
  let sessionStatus = "waiting_for_user"
  const query = vi.fn(async (sql: unknown) => {
    const text = ((sql as { strings?: readonly string[] }).strings ?? []).join(" ")
    if (text.includes("COUNT(DISTINCT") && text.includes("submission_execution_started")) {
      const scoped = executionEvents.filter(event => {
        const data = event.data as Row
        return data.fillTurnId === task.fillTurnId || data.workerTaskId === task.workerTaskId
      })
      const starts = scoped.filter(event => event.type === "submission_execution_started")
      const settled = scoped.filter(event => event.type === "submission_execution_settled")
      const start = starts[0]?.data as Row | undefined
      const terminal = settled[0]?.data as Row | undefined
      const expected = { applicationTaskId: task.id, userId: task.userId, jobId: task.jobId,
        sessionId: task.sessionId, fillTurnId: task.fillTurnId, workerTaskId: task.workerTaskId,
        approvalId: "approval_1", constraintHash: "constraint_1" }
      const matches = (data?: Row) => data && Object.entries(expected).every(([key, value]) => data[key] === value)
        && typeof data.executionId === "string" && data.executionId.length > 0
      const exactPair = scoped.length === 2 && starts.length === 1 && settled.length === 1
        && scoped.every(event => event.actor === "worker") && matches(start) && matches(terminal)
        && start?.executionId === terminal?.executionId
      return [{ safe: scoped.length === 0 || exactPair }]
    }
    if (text.includes('FROM "application_task_events"') && text.includes("submission_not_received_confirmed")) return options.duplicate ?? []
    if (text.includes('FROM "application_task_events"') && text.includes("submission_terminal_observed")) return options.terminalEvents ?? []
    if (text.includes('FROM "application_task_events"') && text.includes("submission_queued")) return options.queuedEvents ?? [queued]
    if (text.includes('FROM "submission_attempt"')) return options.attemptMissing ? [] : [{ ...submissionAttempt }]
    if (text.includes('FROM "agent_approvals"')) return options.approvals ?? [approval]
    if (text.includes('FROM "Job"')) return [{ ...job }]
    if (text.includes('INNER JOIN "Resume"')) return options.fillMaterials ?? [fillMaterial]
    if (text.includes('FROM "CoverLetter"')) return options.coverLetters ?? [{ id: "cover_1" }]
    if (text.includes('FROM "agent_turns"')) return [turn]
    if (text.includes('FROM "sub_agent_tasks"')) return options.fillers ?? [filler]
    if (text.includes('FROM "application_tasks"')) return options.notFound ? [] : [{ ...task }]
    return []
  })
  const tx = {
    $queryRaw: query,
    agentTurn: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: Row }).where
        if (where.id) return turns.find(row => row.id === where.id && row.sessionId === where.sessionId && row.userId === where.userId) ?? null
        return options.activeTurn ?? null
      }),
      create: vi.fn(async ({ data }: { data: Row }) => { turns.push(data); return { id: data.id } }),
    },
    agentInput: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = (args as { where: Row }).where
        return inputs.find(row => row.targetTurnId === where.targetTurnId && row.userId === where.userId && row.clientMessageId === where.clientMessageId) ?? null
      }),
      create: vi.fn(async ({ data }: { data: Row }) => { inputs.push(data); return data }),
    },
    applicationTask: { updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const matches = Object.entries(where).every(([key, value]) => task[key] === value)
      if (!matches) return { count: 0 }
      Object.assign(task, data)
      return { count: 1 }
    }) },
    applicationTaskEvent: { create: vi.fn(async ({ data }: { data: Row }) => { taskEvents.push(data); return data }) },
    job: { updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      const matches = Object.entries(where).every(([key, value]) => job[key] === value)
      if (!matches) return { count: 0 }
      Object.assign(job, data)
      return { count: 1 }
    }) },
    agentSession: { updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
      if (where.id !== "session_1" || where.userId !== "user_1" || where.status !== sessionStatus) return { count: 0 }
      sessionStatus = String(data.status)
      return { count: 1 }
    }) },
  }
  const db = { $transaction: vi.fn(async <T>(work: (client: typeof tx) => Promise<T>) => {
    const beforeTask = { ...task }, beforeJob = { ...job }, beforeTurns = turns.map(row => ({ ...row }))
    const beforeInputs = [...inputs], beforeEvents = [...taskEvents], beforeSessionStatus = sessionStatus
    try { return await work(tx) } catch (error) {
      Object.assign(task, beforeTask); Object.assign(job, beforeJob)
      turns.splice(0, turns.length, ...beforeTurns); inputs.splice(0, inputs.length, ...beforeInputs)
      taskEvents.splice(0, taskEvents.length, ...beforeEvents); sessionStatus = beforeSessionStatus
      throw error
    }
  }) } as unknown as PrismaClient
  mocks.lockOpenSession.mockResolvedValue(undefined)
  mocks.createRootTurn.mockImplementation(async () => {
    const newTurn = { id: "turn_new", sessionId: "session_1", userId: "user_1", status: "queued" }
    turns.push(newTurn)
    return newTurn
  })
  mocks.acceptInputFacts.mockResolvedValue({ inputId: "input_new", turnId: "turn_new", sequence: "42" })
  mocks.verifyAndCancelSubmissionJob.mockImplementation(async (input: { allowMissingTerminalProof?: boolean; withExactAttemptFence: (remove: () => Promise<boolean>) => Promise<boolean> }) => {
    return options.unsafeQueue || (options.queueMissing && input.allowMissingTerminalProof !== true)
      ? false : input.withExactAttemptFence(async () => true)
  })
  return { db, tx, query, task, job, turns, inputs, taskEvents, get sessionStatus() { return sessionStatus } }
}

describe("confirmSubmissionNotReceived", () => {
  beforeEach(() => vi.clearAllMocks())

  it("cancels only the exact submit job, records attestation, and starts one no-submit review Turn", async () => {
    const test = harness()
    await expect(confirmSubmissionNotReceived(test.db, command)).resolves.toEqual({
      inputId: "input_new", turnId: "turn_new", sequence: "42", disposition: "started",
    })
    expect(mocks.verifyAndCancelSubmissionJob).toHaveBeenCalledWith(expect.objectContaining({
      workerTaskId: "bull_old",
      expected: { applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1",
        fillTurnId: "turn_old", receiptId: "approval_1", constraintHash: "constraint_1" },
    }))
    expect(test.tx.applicationTask.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ fillTurnId: "turn_old", workerTaskId: "bull_old", checkpoint: "submission_uncertain" }),
      data: expect.objectContaining({ fillTurnId: "turn_new", workerTaskId: null, status: "filling", checkpoint: "taskgraph_fill_queued" }),
    }))
    expect(test.job).toMatchObject({ status: "saved", workflowState: "ready_to_apply", appliedAt: null })
    expect(test.taskEvents[0]).toMatchObject({ taskId: "application_1", type: "submission_not_received_confirmed", actor: "user",
      data: { oldFillTurnId: "turn_old", approvalId: "approval_1", workerTaskId: "bull_old", newFillTurnId: "turn_new", confirmedNotReceived: true } })
    expect(test.sessionStatus).toBe("running")
    expect(mocks.createRootTurn).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ clientMessageId: expect.stringContaining(command.requestId) }),
      [{ type: "text", text: "Fill the server-bound application form for user review. Never submit it." }])
    expect(test.taskEvents).toHaveLength(1)
  })

  it("allows a never-started execution only after exact queue verification", async () => {
    const test = harness({ executionEvents: [] })
    await expect(confirmSubmissionNotReceived(test.db, command)).resolves.toMatchObject({ disposition: "started" })
    expect(mocks.verifyAndCancelSubmissionJob).toHaveBeenCalledOnce()
    expect(mocks.createRootTurn).toHaveBeenCalledOnce()
  })

  it("keeps an absent queue job blocked without exact Worker terminal evidence", async () => {
    const test = harness({ queueMissing: true })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).toHaveBeenCalledWith(expect.objectContaining({ allowMissingTerminalProof: false }))
    expect(test.turns).toHaveLength(1)
  })

  it("accepts a pruned queue job only with exact final Worker terminal evidence", async () => {
    const evidence = { applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1",
      fillTurnId: "turn_old", workerTaskId: "bull_old", approvalId: "approval_1", receiptId: "approval_1",
      constraintHash: "constraint_1", terminalState: "completed", attemptsMade: 2, attempts: 3 }
    const test = harness({ queueMissing: true, terminalEvents: [{ id: "terminal_1", data: evidence }] })
    await expect(confirmSubmissionNotReceived(test.db, command)).resolves.toMatchObject({ disposition: "started" })
    expect(mocks.verifyAndCancelSubmissionJob).toHaveBeenCalledWith(expect.objectContaining({ allowMissingTerminalProof: true }))
  })

  it("accepts a final failed proof after all Worker attempts are exhausted", async () => {
    const evidence = { applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1",
      fillTurnId: "turn_old", workerTaskId: "bull_old", approvalId: "approval_1", receiptId: "approval_1",
      constraintHash: "constraint_1", terminalState: "failed", attemptsMade: 3, attempts: 3 }
    const test = harness({ queueMissing: true, terminalEvents: [{ id: "terminal_1", data: evidence }] })
    await expect(confirmSubmissionNotReceived(test.db, command)).resolves.toMatchObject({ disposition: "started" })
    expect(mocks.verifyAndCancelSubmissionJob).toHaveBeenCalledWith(expect.objectContaining({ allowMissingTerminalProof: true }))
  })

  it.each([
    ["mismatched identity", { applicationTaskId: "another_task" }],
    ["retryable failure", { terminalState: "failed", attemptsMade: 1, attempts: 3 }],
  ])("rejects pruned queue evidence with %s", async (_label, mismatch) => {
    const evidence = { applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1",
      fillTurnId: "turn_old", workerTaskId: "bull_old", approvalId: "approval_1", receiptId: "approval_1",
      constraintHash: "constraint_1", terminalState: "completed", attemptsMade: 2, attempts: 3, ...mismatch }
    const test = harness({ queueMissing: true, terminalEvents: [{ id: "terminal_1", data: evidence }] })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it("ignores settled execution evidence from an older fill Turn", async () => {
    const oldExecution = { executionId: "execution_prior", workerTaskId: "bull_prior", applicationTaskId: "application_1",
      userId: "user_1", jobId: "job_1", sessionId: "session_1", fillTurnId: "turn_prior", approvalId: "approval_prior", constraintHash: "prior_hash" }
    const test = harness({ executionEvents: [
      { type: "submission_execution_started", actor: "worker", data: oldExecution },
      { type: "submission_execution_settled", actor: "worker", data: { ...oldExecution } },
    ] })
    await expect(confirmSubmissionNotReceived(test.db, command)).resolves.toMatchObject({ disposition: "started" })
    expect(mocks.verifyAndCancelSubmissionJob).toHaveBeenCalledOnce()
  })

  it.each([
    ["missing terminal event", [{ type: "submission_execution_started", actor: "worker", data: { executionId: "execution_old", workerTaskId: "bull_old" } }]],
    ["stale redelivery terminal event", [
      { type: "submission_execution_started", actor: "worker", data: { executionId: "execution_old", workerTaskId: "bull_old" } },
      { type: "submission_execution_settled", actor: "worker", data: { executionId: "execution_redelivery", workerTaskId: "bull_old" } },
    ]],
  ])("rejects recovery with %s", async (_label, executionEvents) => {
    const test = harness({ executionEvents })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it.each([
    ["unbound task", { fillTurnId: null }], ["wrong owner", { fillTurnUserId: "user_2" }],
    ["stale checkpoint", { checkpoint: "form_filled" }], ["submitted task", { status: "submitted" }],
  ])("rejects a %s without queue verification or a new Turn", async (_label, taskSeed) => {
    const test = harness({ task: taskSeed })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it("does not recover across users", async () => {
    const test = harness({ notFound: true })
    await expect(confirmSubmissionNotReceived(test.db, { ...command, userId: "user_2" })).rejects.toMatchObject({ status: 404 })
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it.each([
    ["missing event", []], ["ambiguous event", [
      { id: "queue_event_1", data: { applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1", fillTurnId: "turn_old", approvalId: "approval_1", constraintHash: "constraint_1", workerTaskId: "bull_old" } },
      { id: "queue_event_2", data: { applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1", fillTurnId: "turn_old", approvalId: "approval_2", constraintHash: "constraint_2", workerTaskId: "bull_old" } },
    ]],
  ])("fails closed on %s", async (_label, events) => {
    const test = harness({ queuedEvents: events })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it("rejects duplicate attempt events even when one matches the mutable Worker task pointer", async () => {
    const first = { id: "queue_event_1", data: { applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1", fillTurnId: "turn_old", approvalId: "approval_1", constraintHash: "constraint_1", workerTaskId: "bull_old" } }
    const second = { id: "queue_event_2", data: { ...first.data, workerTaskId: "bull_other" } }
    const test = harness({ queuedEvents: [first, second] })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it("rejects a durable submitted attempt even while the Job still says submitting", async () => {
    const test = harness({ job: { workflowState: "submitting" }, submissionAttempt: { state: "submitted" } })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
    expect(test.task.fillTurnId).toBe("turn_old")
    expect(test.job.workflowState).toBe("submitting")
  })

  it.each([
    ["mismatched user", { userId: "user_2" }], ["mismatched job", { jobId: "job_2" }],
    ["mismatched receipt", { receiptId: "approval_2" }], ["mismatched hash", { constraintHash: "other" }],
    ["unknown state", { state: "unknown" }],
  ])("fails closed for a submission attempt with %s", async (_label, submissionAttempt) => {
    const test = harness({ submissionAttempt })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it.each([
    ["missing resume", { fillMaterials: [] }],
    ["stale cover letter", { fillMaterials: [{ jobId: "job_1", resumeId: "resume_1", coverLetterId: "cover_1" }], coverLetters: [] }],
  ])("fails closed for %s before creating a successor Turn", async (_label, materials) => {
    const test = harness(materials)
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
    expect(test.task.fillTurnId).toBe("turn_old")
  })

  it("fails closed when the task pointer, approval, or approval hash conflicts with the history event", async () => {
    const staleEvent = { id: "queue_event_1", data: { applicationTaskId: "application_1", userId: "user_1", jobId: "job_1", sessionId: "session_1", fillTurnId: "turn_old", approvalId: "approval_1", constraintHash: "constraint_1", workerTaskId: "bull_other" } }
    const cases = [
      harness({ queuedEvents: [staleEvent] }),
      harness({ approvals: [] }),
      harness({ approvals: [{ id: "approval_1", sessionId: "session_1", userId: "user_1", turnId: "turn_old", jobId: "job_1", type: "submit_application", status: "consumed", scopeHash: "other", payload: { applicationTaskId: "application_1", jobId: "job_1" } }] }),
    ]
    for (const test of cases) {
      await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
      expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
      expect(mocks.createRootTurn).not.toHaveBeenCalled()
      mocks.verifyAndCancelSubmissionJob.mockClear()
      mocks.createRootTurn.mockClear()
    }
  })

  it.each([
    ["active old Turn", { turn: { status: "in_progress", leaseOwnerId: "worker_1" } }],
    ["leased filler", { fillers: [{ id: "filler_1", role: "application_filler", taskType: "application_fill_for_review", status: "completed", leaseOwner: "worker_1", leaseExpiresAt: new Date(), interruptRequestedAt: null }] }],
    ["live queue job", { unsafeQueue: true }],
    ["another active session Turn", { activeTurn: { id: "turn_concurrent", status: "in_progress" } }],
  ])("does not bind a successor while %s", async (_label, options) => {
    const test = harness(options)
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(test.task.fillTurnId).toBe("turn_old")
    expect(test.turns).toHaveLength(1)
    expect(test.taskEvents).toHaveLength(0)
    expect(test.job.workflowState).toBe("submitting")
    if ("unsafeQueue" in options && options.unsafeQueue) expect(mocks.verifyAndCancelSubmissionJob).toHaveBeenCalledOnce()
    else expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
  })

  it.each([
    ["submitted workflow", { workflowState: "submitted" }],
    ["applied status", { status: "applied", appliedAt: new Date() }],
    ["interview status", { status: "interview" }],
    ["offer status", { status: "offer" }],
    ["rejected status", { status: "rejected" }],
  ])("rejects recovery when the locked Job has a %s", async (_label, jobSeed) => {
    const test = harness({ job: jobSeed })
    await expect(confirmSubmissionNotReceived(test.db, command)).rejects.toMatchObject({ status: 409 })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it("returns the same successor for a repeated confirmation request", async () => {
    const event = { id: "attestation_1", data: { userId: "user_1", sessionId: "session_1", applicationTaskId: "application_1", requestId: command.requestId, newFillTurnId: "turn_new" } }
    const test = harness({ duplicate: [event] })
    test.turns.push({ id: "turn_new", sessionId: "session_1", userId: "user_1", status: "queued" })
    test.inputs.push({ id: "input_new", targetTurnId: "turn_new", userId: "user_1", clientMessageId: `application-submit-recovery:application_1:${command.requestId}`, acceptedSequence: BigInt(42) })
    await expect(confirmSubmissionNotReceived(test.db, command)).resolves.toEqual({
      inputId: "input_new", turnId: "turn_new", sequence: "42", disposition: "duplicate", originalDisposition: "started",
    })
    expect(mocks.verifyAndCancelSubmissionJob).not.toHaveBeenCalled()
    expect(mocks.createRootTurn).not.toHaveBeenCalled()
  })

  it("takes the session, Turn, filler, application task, and approval locks in Worker order", async () => {
    const test = harness()
    await confirmSubmissionNotReceived(test.db, command)
    const sql = test.query.mock.calls.map(([query]) => ((query as { strings?: readonly string[] }).strings ?? []).join(" "))
    const turnLock = sql.findIndex(value => value.includes('FROM "agent_turns"'))
    const fillerLock = sql.findIndex(value => value.includes('FROM "sub_agent_tasks"'))
    const taskReads = sql.flatMap((value, index) => value.includes('FROM "application_tasks"') && !value.includes('INNER JOIN "Resume"') ? [index] : [])
    const jobLock = sql.findIndex(value => value.includes('FROM "Job"'))
    const submissionHistory = sql.findIndex(value => value.includes("submission_queued"))
    const submissionAttemptLock = sql.findIndex(value => value.includes('FROM "submission_attempt"'))
    const approvalLock = sql.findIndex(value => value.includes('FROM "agent_approvals"'))
    expect(taskReads).toHaveLength(2)
    expect(turnLock).toBeLessThan(fillerLock)
    expect(fillerLock).toBeLessThan(taskReads[1] ?? Number.POSITIVE_INFINITY)
    expect(taskReads[1]).toBeLessThan(jobLock)
    expect(jobLock).toBeLessThan(submissionHistory)
    expect(submissionHistory).toBeLessThan(submissionAttemptLock)
    expect(submissionAttemptLock).toBeLessThan(approvalLock)
  })
})
