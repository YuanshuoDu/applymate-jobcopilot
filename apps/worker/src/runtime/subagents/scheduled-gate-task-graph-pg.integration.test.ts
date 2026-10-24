import { createHash, randomUUID } from "node:crypto"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { once } from "node:events"
import { Queue } from "bullmq"
import Redis from "ioredis"
import { Pool } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { claimTurnLease, releaseTurnLease, type TurnLease } from "../turns/lease.js"
import { createPgTurnEngineStore } from "../turns/turn-engine-store.js"
import { createPgTurnQuestionStore } from "../turns/turn-question-store.js"
import { recoverAnsweredQuestionContext } from "../question-answer-recovery.js"
import { drainAgentWakeups } from "../wakeup/consumer.js"
import { createCanonicalExecutionProjection } from "../canonical-execution-projection.js"
import { createPgRootTaskStore } from "./root-task-store.js"
import { createPgDurableWaitPort } from "./durable-wait-store.js"
import { createPgTaskGraphCommandPort } from "./pg-task-graph-command-port.js"
import { createScheduledAutomationGateContinuation } from "./scheduled-automation-gate-bridge.js"
import { projectScheduledAnalyzePrefix } from "./scheduled-automation-prepare-bridge.js"
import { createScheduledGatePrepareFixture } from "./scheduled-gate-prepare-pg-runner.fixture.js"
import { scheduledGateCandidateSetDigest, scheduledGatePreparedJobIds, type ScheduledGateResult } from "./scheduled-gate-contract.js"
import type { TurnQuestionGateChoiceBinding } from "../turns/turn-question-gate-choice-contract.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { canonicalTaskGraphJson, taskGraphLifecycleKey } from "./task-graph-snapshot.js"
import { buildScheduledPrepareTaskGraphProof, SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA } from "./scheduled-prepare-task-graph-verification.js"
import { loadPersistedScheduledPrepareProof } from "./scheduled-gate-wait-match.js"
import { parseScheduledTaskGraphContinuationReceipt, scheduledTaskGraphStableContinuationKey } from "./scheduled-taskgraph-continuation-receipt.js"
import { currentTaskGraph, loadTaskGraph } from "./task-graph-pg-state.js"

const databaseUrl = disposableDatabaseUrl()
const redisUrl = disposableRedisUrl()
const describeWithServices = databaseUrl && redisUrl ? describe : describe.skip
const workerFixture = fileURLToPath(new URL("./scheduled-gate-task-graph-restart.fixture.mjs", import.meta.url))
const workerCwd = fileURLToPath(new URL("../../..", import.meta.url))
const zeroUsage = { inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
const prepareGoal = "Prepare application materials using the persisted scheduled Analyze checkpoint."
const prepareCriteria = [
  "Prepare only jobs and 0-100 scores from the verified scheduled Analyze checkpoint.",
  "Persist immutable owner-fenced material references and return no resume or letter bodies.",
]
const rootActions = [...new Set([
  ...TASK_GRAPH_TEMPLATES.scout.allowedActions,
  ...TASK_GRAPH_TEMPLATES.analyst.allowedActions,
  ...TASK_GRAPH_TEMPLATES.prepare.allowedActions,
])]

type Marker = Record<string, unknown>
type WorkerProcess = { child: ChildProcess; lines: string[]; partial: string; waiters: Array<{ marker: string; resolve(value: Marker): void; reject(error: Error): void }> }
type GateFixture = Awaited<ReturnType<typeof createScheduledGatePrepareFixture>>

let pool: Pool | undefined
let queue: Queue | undefined
let queueRedis: Redis | undefined
let queueName: string | undefined
let child: WorkerProcess | undefined
let webDb: { db: { $disconnect(): Promise<void> } } | undefined
let priorDatabaseUrl: string | undefined
let priorAgentWebUrl: string | undefined
let priorWorkerSecret: string | undefined
const fixtureUsers: string[] = []

describeWithServices("scheduled Gate durable questions across real Worker restarts", () => {
  beforeAll(() => {
    pool = new Pool({ connectionString: databaseUrl!, max: 8 })
    priorDatabaseUrl = process.env.DATABASE_URL
    priorAgentWebUrl = process.env.AGENT_WEB_URL
    priorWorkerSecret = process.env.AGENT_WORKER_SECRET
    const prismaUrl = new URL(databaseUrl!)
    prismaUrl.searchParams.set("application_name", `scheduled-gate-pg-${randomUUID()}`)
    process.env.DATABASE_URL = prismaUrl.toString()
  })

  afterAll(async () => {
    await stopWorker(child).catch(() => undefined)
    if (queue) await queue.obliterate({ force: true }).catch(() => undefined)
    await queue?.close()
    await queueRedis?.quit()
    if (pool && fixtureUsers.length) await pool.query(`DELETE FROM "User" WHERE "id" = ANY($1::text[])`, [fixtureUsers])
    await pool?.end()
    await webDb?.db.$disconnect()
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL
    else process.env.DATABASE_URL = priorDatabaseUrl
    if (priorAgentWebUrl === undefined) delete process.env.AGENT_WEB_URL
    else process.env.AGENT_WEB_URL = priorAgentWebUrl
    if (priorWorkerSecret === undefined) delete process.env.AGENT_WORKER_SECRET
    else process.env.AGENT_WORKER_SECRET = priorWorkerSecret
  })

  it("answers four distinct prepared weak-letter questions and completes the same Gate at attempt five", async () => {
    pool ??= new Pool({ connectionString: databaseUrl!, max: 8 })
    const fixture = await createScheduledGatePrepareFixture(pool, redisUrl!, { jobCount: 4 })
    fixtureUsers.push(fixture.ids.userId)
    expect(fixture.preparedJobIds).toHaveLength(4)
    const prepareLeaseVersion = fixture.prepareProof.receipt.owner.turnLeaseVersion
    expect(fixture.owner.turnLeaseVersion).toBe(prepareLeaseVersion)
    const released = await releaseTurnLease(pool, fixture.turnLease, "queued")
    expect(released).toBe(true)
    let lease = await claimTurnLease(pool, { turnId: fixture.ids.turnId, sessionId: fixture.ids.sessionId,
      ownerId: `scheduled-gate-root-${randomUUID()}` })
    expect(lease.leaseVersion).toBeGreaterThan(prepareLeaseVersion)

    const questionStore = createPgTurnQuestionStore(pool as never)
    const turnStore = createPgTurnEngineStore(pool as never)
    const rootStore = createPgRootTaskStore(pool as never)
    const execution = createCanonicalExecutionProjection(pool)
    const durableWait = createPgDurableWaitPort(pool)
    const command = createPgTaskGraphCommandPort(pool as never)
    const fetchCalls: Array<Record<string, unknown>> = []
    const executeFetcher: typeof fetch = async (url, init = {}) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      fetchCalls.push(body)
      expect(String(url)).toBe("http://scheduled-gate-parent.invalid/api/internal/agent-runtime/scheduled-pipeline")
      expect(init.method).toBe("POST")
      expect(new Headers(init.headers).get("x-agent-worker-secret")).toBe("scheduled-gate-parent-fixture-secret")
      expect(body.action).toBe("execute")
      expect(body).not.toHaveProperty("validatedChoice")
      expect(body).not.toHaveProperty("priorChoices")
      return new Response(JSON.stringify({ status: "completed", report: {
        processed: 0, applied: 0, queued: 0, pending: 0, skipped: 4, failed: 0, durationMs: 0,
      } }), { status: 200, headers: { "content-type": "application/json" } })
    }
    const continuation = createScheduledAutomationGateContinuation({ pool, commandPort: command, waitPort: durableWait,
      questionStore, nativeQuestionWaitEnabled: true, fetcher: executeFetcher })
    queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    queueName = `scheduled-gate-${randomUUID()}`
    queue = new Queue(queueName, { connection: queueRedis })
    process.env.AGENT_WEB_URL = "http://scheduled-gate-parent.invalid"
    process.env.AGENT_WORKER_SECRET = "scheduled-gate-parent-fixture-secret"

    const preparedProof = fixture.prepareProof as never
    const handoff = fixture.handoff as never
    let owner = { ...fixture.owner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
    let attestation = await fixture.reattestCurrentTurn(lease)
    expect(attestation.owner.turnLeaseVersion).toBe(lease.leaseVersion)
    expect(attestation.owner.turnLeaseVersion).not.toBe(prepareLeaseVersion)
    expect([attestation.owner.userId, attestation.owner.sessionId, attestation.owner.turnId,
      attestation.owner.rootTaskId, attestation.owner.rootAttemptCount]).toEqual([
      fixture.prepareProof.receipt.owner.userId, fixture.prepareProof.receipt.owner.sessionId,
      fixture.prepareProof.receipt.owner.turnId, fixture.prepareProof.receipt.owner.rootTaskId,
      fixture.prepareProof.receipt.owner.rootAttemptCount,
    ])
    await adoptRootLease(fixture, lease, rootStore, execution)

    await assertPrepareProofPreflight(pool, fixture, "four-job-initial-append")
    const firstStep = await startStep(fixture, lease, turnStore)
    const initial = await continuation({ owner, executionOwner: turnFence(lease, fixture.ids.rootTaskId), attestation,
      handoff, prepareProof: preparedProof, scheduledWaitId: fixture.prepareChoiceWaitId,
      finalStepId: firstStep, signal: new AbortController().signal })
    expect(initial.status).toBe("waiting_for_dependency")
    if (initial.status !== "waiting_for_dependency") throw new Error("scheduled_gate_initial_wait_missing")
    await suspendRoot(fixture, lease, firstStep, initial.waitId, turnStore, durableWait)

    const generations: number[] = []
    const completedQuestionItems: Array<{ itemId: string; answer: string; attempt: number; binding: TurnQuestionGateChoiceBinding }> = []
    const gateTaskId = await findGateTaskId(pool, fixture.ids.rootTaskId)
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      if (attempt === 5) {
        const beforeFinal = await pool.query<{ status: string; attemptCount: number; maxAttempts: number }>(
          `SELECT "status", "attemptCount", "maxAttempts" FROM "sub_agent_tasks" WHERE "id"=$1 AND "sessionId"=$2`,
          [gateTaskId, fixture.ids.sessionId])
        expect(beforeFinal.rows[0]).toMatchObject({ status: "queued", attemptCount: 4, maxAttempts: 3 })
      }
      const plan = responsePlan(fixture.preparedJobIds)
      child = startWorker(queueName, gateTaskId, plan)
      await nextMarker(child, "READY")
      expect(await dispatchPendingOutbox(pool as never, queue as never, fixture.ids.sessionId)).toBe(1)
      const finished = await nextMarker(child, "TASK_FINISHED", 120_000)
      expect(finished).toMatchObject({ taskId: gateTaskId, attempt, generation: (attempt - 1) * 2,
        status: attempt === 5 ? "completed" : "waiting_for_user" })
      generations.push(Number(finished.generation))
      expect(await dispatchState(pool, fixture.ids.sessionId, gateTaskId)).toEqual({
        count: 1, attemptCount: attempt * 2 - 1, published: true,
      })
      await stopWorker(child)
      child = undefined

      if (attempt === 5) break
      const reconciled = await durableWait.reconcile({ batchSize: 50 })
      expect(reconciled.woken).toBeGreaterThanOrEqual(1)
      expect(await drainAgentWakeups(pool, 10)).toBeGreaterThanOrEqual(1)
      lease = await claimTurnLease(pool, { turnId: fixture.ids.turnId, sessionId: fixture.ids.sessionId,
        ownerId: `scheduled-gate-root-resume-${attempt}-${randomUUID()}` })
      await adoptRootLease(fixture, lease, rootStore, execution)
      owner = { ...fixture.owner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
      attestation = await fixture.reattestCurrentTurn(lease)

      const questionStep = await startStep(fixture, lease, turnStore)
      const next = await continuation({ owner, executionOwner: turnFence(lease, fixture.ids.rootTaskId), attestation,
        handoff, prepareProof: preparedProof, scheduledWaitId: fixture.prepareChoiceWaitId,
        finalStepId: questionStep, signal: new AbortController().signal })
      expect(next.status).toBe("waiting_for_choice")
      if (next.status !== "waiting_for_choice") throw new Error("scheduled_gate_question_missing")
      expect(next.binding).toMatchObject({ gateAttempt: attempt, kind: "weak_cover_letter", jobIds: [fixture.preparedJobIds[attempt - 1]] })
      const question = await questionStore.waitForQuestion({ owner: turnFence(lease, fixture.ids.rootTaskId), stepId: questionStep,
        toolCallId: null, gateChoiceBinding: next.binding, gateChoiceQuestion: next.question, expectedWaitId: next.waitId,
        finishReason: "stop", usage: zeroUsage, now: new Date() })
      expect(question).toMatchObject({ status: "waiting_for_user", disposition: "created", waitId: next.waitId,
        toolCallId: null, itemId: `agent-wait:question:${next.waitId}` })
      await answerWebQuestion(fixture, question.waitId, question.nextTurnRevision, "skip")
      completedQuestionItems.push({ itemId: question.itemId, answer: "skip", attempt, binding: next.binding })
      await assertGateQuestionIsPrivate(fixture, lease, question.itemId, "skip")
      await finishUserWait(fixture, lease, questionStep, question.waitId, rootStore, execution)
      expect(await drainAgentWakeups(pool, 10)).toBeGreaterThanOrEqual(1)
      lease = await claimTurnLease(pool, { turnId: fixture.ids.turnId, sessionId: fixture.ids.sessionId,
        ownerId: `scheduled-gate-root-answered-${attempt}-${randomUUID()}` })
      await adoptRootLease(fixture, lease, rootStore, execution)
      owner = { ...fixture.owner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
      attestation = await fixture.reattestCurrentTurn(lease)

      const readChoice = questionStore.readScheduledGateChoice
      if (!readChoice) throw new Error("scheduled_gate_choice_reader_unavailable")
      const resumedChoice = await readChoice.call(questionStore, { owner: turnFence(lease, fixture.ids.rootTaskId),
        binding: next.binding, now: new Date() })
      expect(resumedChoice).toMatchObject({ status: "answered", validatedChoice: {
        kind: "weak_cover_letter", jobIds: [fixture.preparedJobIds[attempt - 1]], choiceId: "skip",
      } })
      const resumeStep = await startStep(fixture, lease, turnStore)
      const resumed = await continuation({ owner, executionOwner: turnFence(lease, fixture.ids.rootTaskId), attestation,
        handoff, prepareProof: preparedProof, scheduledWaitId: fixture.prepareChoiceWaitId,
        finalStepId: resumeStep, signal: new AbortController().signal })
      expect(resumed.status).toBe("waiting_for_dependency")
      if (resumed.status !== "waiting_for_dependency") throw new Error("scheduled_gate_answer_resume_missing")
      await assertResumeReplayFences(pool, command, fixture, lease, owner, resumeStep, question, attempt)
      await assertPrivateAcknowledgement(pool, question.itemId, gateTaskId, attempt, question.waitId)
      await suspendRoot(fixture, lease, resumeStep, resumed.waitId, turnStore, durableWait)
    }

    const finalReconcile = await durableWait.reconcile({ batchSize: 50 })
    expect(finalReconcile.woken).toBeGreaterThanOrEqual(1)
    expect(await drainAgentWakeups(pool, 10)).toBeGreaterThanOrEqual(1)
    lease = await claimTurnLease(pool, { turnId: fixture.ids.turnId, sessionId: fixture.ids.sessionId,
      ownerId: `scheduled-gate-root-complete-${randomUUID()}` })
    await adoptRootLease(fixture, lease, rootStore, execution)
    owner = { ...fixture.owner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
    attestation = await fixture.reattestCurrentTurn(lease)
    const completionStep = await startStep(fixture, lease, turnStore)
    const completed = await continuation({ owner, executionOwner: turnFence(lease, fixture.ids.rootTaskId), attestation,
      handoff, prepareProof: preparedProof, scheduledWaitId: fixture.prepareChoiceWaitId,
      finalStepId: completionStep, signal: new AbortController().signal })
    expect(completed).toEqual({ status: "completed" })

    expect(generations).toEqual([0, 2, 4, 6, 8])
    expect(completedQuestionItems.map(item => item.attempt)).toEqual([1, 2, 3, 4])
    expect(new Set(completedQuestionItems.map(item => item.itemId)).size).toBe(4)
    expect(fetchCalls).toHaveLength(1)
    const gate = await pool.query<{ status: string; attemptCount: number; maxAttempts: number; result: Record<string, unknown> }>(
      `SELECT "status", "attemptCount", "maxAttempts", "result" FROM "sub_agent_tasks" WHERE "id"=$1 AND "sessionId"=$2`, [gateTaskId, fixture.ids.sessionId])
    expect(gate.rows[0]).toMatchObject({ status: "completed", attemptCount: 5, maxAttempts: 3,
      result: { status: "completed", stepCount: 0, toolCallCount: 0, structuredResult: {
        status: "completed", approvedJobIds: [], pendingJobIds: [], skippedJobIds: [...fixture.preparedJobIds].sort(),
        counts: { approved: 0, pending: 0, skipped: 4 },
      } } })
    await assertPublicGateProjection(fixture, gateTaskId)
  }, 600_000)

  it("cancels an unanswered Gate question through Web Stop and fences stale answer/resume", async () => {
    pool ??= new Pool({ connectionString: databaseUrl!, max: 8 })
    const fixture = await createScheduledGatePrepareFixture(pool, redisUrl!, { jobCount: 1 })
    fixtureUsers.push(fixture.ids.userId)
    expect(fixture.preparedJobIds).toHaveLength(1)
    const prepareLeaseVersion = fixture.prepareProof.receipt.owner.turnLeaseVersion
    expect(await releaseTurnLease(pool, fixture.turnLease, "queued")).toBe(true)
    let lease = await claimTurnLease(pool, { turnId: fixture.ids.turnId, sessionId: fixture.ids.sessionId,
      ownerId: `scheduled-gate-cancel-root-${randomUUID()}` })
    expect(lease.leaseVersion).toBeGreaterThan(prepareLeaseVersion)

    const questionStore = createPgTurnQuestionStore(pool as never)
    const turnStore = createPgTurnEngineStore(pool as never)
    const rootStore = createPgRootTaskStore(pool as never)
    const execution = createCanonicalExecutionProjection(pool)
    const durableWait = createPgDurableWaitPort(pool)
    const command = createPgTaskGraphCommandPort(pool as never)
    const continuation = createScheduledAutomationGateContinuation({ pool, commandPort: command, waitPort: durableWait,
      questionStore, nativeQuestionWaitEnabled: true, fetcher: async () => { throw new Error("gate_cancel_test_unexpected_execute") } })
    if (!queueRedis) queueRedis = new Redis(redisUrl!, { maxRetriesPerRequest: null })
    if (!queueName) {
      queueName = `scheduled-gate-cancel-${randomUUID()}`
      queue = new Queue(queueName, { connection: queueRedis })
    }
    process.env.AGENT_WEB_URL = "http://scheduled-gate-parent.invalid"
    process.env.AGENT_WORKER_SECRET = "scheduled-gate-parent-fixture-secret"
    let owner = { ...fixture.owner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
    await assertPrepareProofPreflight(pool, fixture, "one-job-reattest")
    let attestation = await fixture.reattestCurrentTurn(lease)
    await adoptRootLease(fixture, lease, rootStore, execution)
    const firstStep = await startStep(fixture, lease, turnStore)
    const initial = await continuation({ owner, executionOwner: turnFence(lease, fixture.ids.rootTaskId), attestation,
      handoff: fixture.handoff as never, prepareProof: fixture.prepareProof as never,
      scheduledWaitId: fixture.prepareChoiceWaitId, finalStepId: firstStep, signal: new AbortController().signal })
    expect(initial.status).toBe("waiting_for_dependency")
    if (initial.status !== "waiting_for_dependency") throw new Error("scheduled_gate_cancel_initial_wait_missing")
    await suspendRoot(fixture, lease, firstStep, initial.waitId, turnStore, durableWait)

    const gateTaskId = await findGateTaskId(pool, fixture.ids.rootTaskId)
    child = startWorker(queueName, gateTaskId, singleQuestionPlan(fixture.preparedJobIds[0]!))
    await nextMarker(child, "READY")
    expect(await dispatchPendingOutbox(pool as never, queue as never, fixture.ids.sessionId)).toBe(1)
    await expect(nextMarker(child, "TASK_FINISHED", 120_000)).resolves.toMatchObject({
      taskId: gateTaskId, attempt: 1, status: "waiting_for_user", generation: 0,
    })
    await stopWorker(child)
    child = undefined

    expect((await durableWait.reconcile({ batchSize: 50 })).woken).toBeGreaterThanOrEqual(1)
    expect(await drainAgentWakeups(pool, 10)).toBeGreaterThanOrEqual(1)
    lease = await claimTurnLease(pool, { turnId: fixture.ids.turnId, sessionId: fixture.ids.sessionId,
      ownerId: `scheduled-gate-cancel-question-${randomUUID()}` })
    await adoptRootLease(fixture, lease, rootStore, execution)
    owner = { ...fixture.owner, turnLeaseOwnerId: lease.ownerId, turnLeaseVersion: lease.leaseVersion }
    attestation = await fixture.reattestCurrentTurn(lease)
    const questionStep = await startStep(fixture, lease, turnStore)
    const candidate = await continuation({ owner, executionOwner: turnFence(lease, fixture.ids.rootTaskId), attestation,
      handoff: fixture.handoff as never, prepareProof: fixture.prepareProof as never,
      scheduledWaitId: fixture.prepareChoiceWaitId, finalStepId: questionStep, signal: new AbortController().signal })
    expect(candidate.status).toBe("waiting_for_choice")
    if (candidate.status !== "waiting_for_choice") throw new Error("scheduled_gate_cancel_question_missing")
    expect(candidate.binding).toMatchObject({ gateAttempt: 1, kind: "weak_cover_letter", jobIds: [fixture.preparedJobIds[0]] })
    const question = await questionStore.waitForQuestion({ owner: turnFence(lease, fixture.ids.rootTaskId), stepId: questionStep,
      toolCallId: null, gateChoiceBinding: candidate.binding, gateChoiceQuestion: candidate.question, expectedWaitId: candidate.waitId,
      finishReason: "stop", usage: zeroUsage, now: new Date() })
    expect(question).toMatchObject({ status: "waiting_for_user", disposition: "created", toolCallId: null })

    const dbModule = "@/lib/db"
    const commandsModule = "@/lib/agent/control-plane/commands/agent-command-service"
    const webDatabase = await import(dbModule) as unknown as { db: { $disconnect(): Promise<void> } }
    webDb = webDatabase
    const commands = await import(commandsModule) as unknown as { AgentCommandService: new(db: unknown) => {
      interrupt(input: { sessionId: string; userId: string; clientMessageId: string; source: "user";
        expectedTurnId: string; expectedRevision: number }): Promise<{ turnId: string; disposition: string }>
    } }
    const stopped = await new commands.AgentCommandService(webDatabase.db).interrupt({
      sessionId: fixture.ids.sessionId, userId: fixture.ids.userId, clientMessageId: `scheduled-gate-stop-${randomUUID()}`,
      source: "user", expectedTurnId: fixture.ids.turnId, expectedRevision: question.nextTurnRevision,
    })
    expect(stopped).toMatchObject({ turnId: fixture.ids.turnId, disposition: "interrupted" })

    const before = await resumeCounts(pool, fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId, gateTaskId, 1)
    const answerModule = "@/lib/agent/broker/store"
    const broker = await import(answerModule) as unknown as { answerQuestion(db: unknown, input: {
      sessionId: string; userId: string; waitId: string; clientMessageId: string; expectedTurnId: string;
      expectedRevision: number; answer: string; now: Date
    }): Promise<unknown> }
    await expect(broker.answerQuestion(webDatabase.db, { sessionId: fixture.ids.sessionId, userId: fixture.ids.userId,
      waitId: question.waitId, clientMessageId: `scheduled-gate-stale-answer-${randomUUID()}`, expectedTurnId: fixture.ids.turnId,
      expectedRevision: question.nextTurnRevision, answer: "skip", now: new Date() })).rejects.toBeDefined()

    const resume = command.resumeScheduledGateChoice
    if (!resume) throw new Error("scheduled_gate_resume_command_unavailable")
    const scope = { ...fixture.graphScope, stepId: questionStep, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
      parentLeaseOwner: lease.ownerId, parentAttemptCount: owner.rootAttemptCount }
    await expect(resume.call(command, { scope,
      executionOwner: { executionId: fixture.executionOwner.executionId, executionAttemptCount: fixture.executionOwner.executionAttemptCount },
      gateTaskId, requestAttemptCount: 1, waitId: question.waitId, now: new Date() })).rejects.toBeDefined()
    expect(before).toEqual({ events: 0, eventOutbox: 0, dispatchCount: 1, dispatchAttemptCount: 1, dispatchPublished: true })
    expect(await resumeCounts(pool, fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId, gateTaskId, 1)).toEqual(before)
    const persisted = await pool.query<{ turnStatus: string; taskStatus: string; attemptCount: number; itemStatus: string;
      content: Record<string, unknown>; resumedEvents: string }>(`SELECT turn.status AS "turnStatus", task.status AS "taskStatus",
        task."attemptCount", item.status AS "itemStatus", item.content,
        (SELECT COUNT(*)::text FROM "agent_events" event WHERE event."turnId"=turn.id AND event."type"='task.gate_choice_resumed') AS "resumedEvents"
      FROM "agent_turns" turn JOIN "sub_agent_tasks" task ON task."turnId"=turn.id
      JOIN "agent_items" item ON item."id"=$3 WHERE turn.id=$1 AND task.id=$2`, [fixture.ids.turnId, gateTaskId, question.itemId])
    expect(persisted.rows[0]).toMatchObject({ turnStatus: "interrupted", taskStatus: "interrupted", attemptCount: 1,
      itemStatus: "interrupted", content: { answer: null, answerAvailable: false, cancelled: true }, resumedEvents: "0" })
  }, 600_000)
})

async function adoptRootLease(fixture: GateFixture, lease: TurnLease,
  rootStore: ReturnType<typeof createPgRootTaskStore>, execution: ReturnType<typeof createCanonicalExecutionProjection>): Promise<void> {
  const root = await rootStore.ensure({ lease,
    goal: "Complete the scheduled application review safely", allowedActions: rootActions })
  expect(root).toMatchObject({ id: fixture.ids.rootTaskId, status: "running", leaseOwner: lease.ownerId })
  await execution.start({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId })
}

type PrepareProofTaskRow = Readonly<{
  id: string; userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string
  role: string; taskType: string; status: string; attemptCount: number; failureReason: string | null
  expectedOutputSchema: unknown; allowedActions: unknown; result: unknown
}>
type PrepareProofWaitRow = Readonly<{
  id: string; userId: string; sessionId: string; turnId: string; parentTaskId: string; stepId: string
  idempotencyKey: string; targetTaskIds: unknown; mode: string; status: string; matchedTaskIds: unknown; result: unknown
}>

async function assertPrepareProofPreflight(database: Pool, fixture: GateFixture, label: string): Promise<void> {
  const loaded = await loadTaskGraph(database, fixture.graphScope, false)
  const current = currentTaskGraph(loaded), nodes = loaded.snapshot?.nodes ?? []
  const taskRows = await database.query<PrepareProofTaskRow>(`SELECT task."id", session."userId" AS "userId", task."sessionId", task."turnId",
    task."rootTaskId", task."parentTaskId", task."role", task."taskType", task."status", task."attemptCount", task."failureReason",
    task."expectedOutputSchema", task."allowedActions", task."result"
    FROM "sub_agent_tasks" task JOIN "agent_sessions" session ON session."id"=task."sessionId"
    WHERE task."id"=ANY($1::text[])`, [nodes.map(node => node.taskId)])
  const prepareNode = nodes.find(node => node.key === "prepare")
  const analystNodes = nodes.filter(node => node.taskId === fixture.ids.analystTaskId)
  const analystNode = analystNodes[0]
  const prepareCurrent = current.nodes.find(node => node.key === "prepare")
  const prepareTask = taskRows.rows.find(row => row.id === fixture.ids.prepareTaskId)
  const outer = record(prepareTask?.result), facts = record(outer?.taskGraphScheduledPrepareProofFacts)
  const receipt = parseScheduledTaskGraphContinuationReceipt(facts?.receipt), completion = record(facts?.completion)
  const taskProjection = loaded.snapshot && projectScheduledAnalyzePrefix(loaded.snapshot, current, taskRows.rows)
  const waitRows = await database.query<PrepareProofWaitRow>(`SELECT "id", "userId", "sessionId", "turnId", "parentTaskId", "stepId",
    "idempotencyKey", "targetTaskIds", "mode", "status", "matchedTaskIds", "result"
    FROM "agent_wait_conditions" WHERE "id"=$1`, [fixture.prepareWaitId])
  const wait = waitRows.rows[0], request = record(record(wait?.result)?.request)
  const stepRows = await database.query<{ id: string; sessionId: string; turnId: string; taskId: string | null; attempt: number; status: string }>(
    `SELECT "id", "sessionId", "turnId", "taskId", "attempt", "status" FROM "agent_steps" WHERE "id"=$1`, [wait?.stepId ?? ""])
  const step = stepRows.rows[0]
  const targets = parseJson(wait?.targetTaskIds), matched = parseJson(wait?.matchedTaskIds)
  const expectedAttempt = fixture.prepareProof.result.attemptCount
  const built = facts && wait ? buildScheduledPrepareTaskGraphProof(facts, { waitId: wait.id, status: wait.status,
    mode: wait.mode, targetTaskIds: targets, matchedTaskIds: matched }) : null
  const proofScope = { userId: fixture.owner.userId, sessionId: fixture.owner.sessionId,
    turnId: fixture.owner.turnId, rootTaskId: fixture.owner.rootTaskId }
  const reloaded = await loadPersistedScheduledPrepareProof(database, proofScope, fixture.ids.prepareTaskId,
    prepareTask?.result, fixture.prepareProof.receipt.continuationKey, fixture.prepareWaitId)
  const preparedIds = reloaded && scheduledGatePreparedJobIds(reloaded)
  const completionNodes = completion?.nodes
  const expectedCompletionNodes = fixture.prepareProof.completion.nodes
  const analyze = nodes.slice(0, 2).map(node => {
    const live = current.nodes.find(value => value.key === node.key)
    const task = taskRows.rows.find(row => row.id === node.taskId)
    const result = record(task?.result), report = record(result?.taskGraphVerificationReport)
    const currentReport = record(live?.verificationReport)
    return { key: node.key, taskFound: !!task, taskIdentityMatches: !!task && task.userId === fixture.ids.userId
        && task.sessionId === fixture.ids.sessionId && task.turnId === fixture.ids.turnId
        && task.rootTaskId === fixture.ids.rootTaskId && task.parentTaskId === fixture.ids.rootTaskId,
      role: task?.role, taskType: task?.taskType, taskStatus: task?.status, currentStatus: live?.status,
      attemptCount: task?.attemptCount, taskFailure: task?.failureReason, currentFailure: live?.failureReason,
      envelopeKeys: Object.keys(result ?? {}).sort(), envelopeStatus: result?.status,
      reportStatus: report?.status, reportHasDigests: !!report?.resultDigest && !!report?.evidenceDigest,
      currentReportStatus: currentReport?.status, resultDigestMatchesCurrent: report?.resultDigest === currentReport?.resultDigest,
      evidenceDigestMatchesCurrent: report?.evidenceDigest === currentReport?.evidenceDigest }
  })
  const summary = {
    graph: { revision: current.revision, nodeCount: nodes.length, currentNodeCount: current.nodes.length,
      taskCount: taskRows.rows.length, analyzePrefixAccepted: !!taskProjection, analystNodeCount: analystNodes.length,
      analystTaskIdMatches: analystNode?.taskId === fixture.ids.analystTaskId,
      proofScopeMatchesGraphScope: proofScope.userId === fixture.graphScope.userId && proofScope.sessionId === fixture.graphScope.sessionId
        && proofScope.turnId === fixture.graphScope.turnId && proofScope.rootTaskId === fixture.graphScope.rootTaskId },
    analyze,
    prepare: {
      node: { key: prepareNode?.key, templateId: prepareNode?.templateId, depth: prepareNode?.depth,
        dependsOn: prepareNode?.dependsOn, dependsOnAnalyst: !!analystNode && sameCanonical(prepareNode?.dependsOn, [analystNode.key]),
        goalMatchesExpected: prepareNode?.goal === prepareGoal,
        successCriteriaCount: Array.isArray(prepareNode?.successCriteria) ? prepareNode.successCriteria.length : -1,
        successCriteriaMatch: sameCanonical(prepareNode?.successCriteria, prepareCriteria),
        specialized: prepareNode?.verificationDisposition === "specialized" },
      current: { present: !!prepareCurrent, taskMatches: prepareCurrent?.taskId === fixture.ids.prepareTaskId,
        status: prepareCurrent?.status, failureReason: prepareCurrent?.failureReason },
      task: { present: !!prepareTask, identityMatches: !!prepareTask && prepareTask.userId === fixture.ids.userId
          && prepareTask.sessionId === fixture.ids.sessionId && prepareTask.turnId === fixture.ids.turnId
          && prepareTask.rootTaskId === fixture.ids.rootTaskId && prepareTask.parentTaskId === fixture.ids.rootTaskId,
        role: prepareTask?.role, taskType: prepareTask?.taskType, status: prepareTask?.status, attemptCount: prepareTask?.attemptCount,
        failureReason: prepareTask?.failureReason, schemaMatches: sameCanonical(prepareTask?.expectedOutputSchema, TASK_GRAPH_TEMPLATES.prepare.expectedOutputSchema),
        actionsMatch: sameCanonical(prepareTask?.allowedActions, TASK_GRAPH_TEMPLATES.prepare.allowedActions) },
      envelope: { status: outer?.status, structuredStatus: record(outer?.structuredResult)?.status,
        factsPresent: !!facts, factKeysExact: sameKeys(facts, ["schemaVersion", "receipt", "completion", "result"]),
        schemaMatches: facts?.schemaVersion === SCHEDULED_PREPARE_PROOF_FACTS_SCHEMA,
        factsResultMatchesStructured: sameCanonical(facts?.result, outer?.structuredResult) },
      facts: { receiptParsed: !!receipt,
        receiptKeyValid: !!receipt && scheduledTaskGraphStableContinuationKey(receipt) === receipt.continuationKey,
        receiptOwnerMatches: !!receipt && receipt.owner.userId === fixture.ids.userId
          && receipt.owner.sessionId === fixture.ids.sessionId && receipt.owner.turnId === fixture.ids.turnId
          && receipt.owner.rootTaskId === fixture.ids.rootTaskId,
        receiptMatchesFixture: sameCanonical(receipt, fixture.prepareProof.receipt),
        analyzeRevision: receipt?.analyzeGraphRevision, prepareScheduleRevision: receipt?.prepareScheduleRevision,
        completionRevision: completion?.graphRevision, expectedCompletionRevision: fixture.prepareProof.completion.graphRevision,
        completionRevisionMatches: completion?.graphRevision === fixture.prepareProof.completion.graphRevision,
        completionNodeCount: Array.isArray(completionNodes) ? completionNodes.length : -1,
        completionNodes: summarizeCompletionNodes(completionNodes),
        expectedCompletionNodes: summarizeCompletionNodes(expectedCompletionNodes),
        completionNodesMatch: sameCanonical(completionNodes, expectedCompletionNodes) },
      wait: { count: waitRows.rows.length, identityMatches: wait?.id === fixture.prepareWaitId
          && fixture.prepareProof.completion.wait.waitId === fixture.prepareWaitId,
        ownerMatches: !!wait && wait.userId === fixture.ids.userId && wait.sessionId === fixture.ids.sessionId && wait.turnId === fixture.ids.turnId,
        parentMatches: wait?.parentTaskId === fixture.ids.rootTaskId,
        stepMatches: wait?.stepId === fixture.rootQuestionStepId,
        keyMatches: !!wait && wait.idempotencyKey === prepareDependencyKey(fixture.prepareProof.receipt.continuationKey, wait.stepId),
        status: wait?.status, mode: wait?.mode, targetMatches: sameCanonical(targets, [fixture.ids.prepareTaskId]),
        matchedMatches: sameCanonical(matched, [fixture.ids.prepareTaskId]),
        requestKeysExact: sameKeys(request, ["targetTaskIds", "mode", "timeoutMs"]), requestMode: request?.mode,
        timeoutMs: request?.timeoutMs, requestTargetsMatch: sameCanonical(request?.targetTaskIds, [fixture.ids.prepareTaskId]) },
      step: { count: stepRows.rows.length, identityMatches: !!wait && !!step && step.id === wait.stepId
          && step.sessionId === fixture.ids.sessionId && step.turnId === fixture.ids.turnId,
        rootTaskMatches: step?.taskId === fixture.ids.rootTaskId, attempt: step?.attempt, status: step?.status },
      proof: { builderAccepted: !!built, builderMatchesFixture: sameCanonical(built, fixture.prepareProof),
        loaderAccepted: !!reloaded, loaderMatchesFixture: sameCanonical(reloaded, fixture.prepareProof),
        preparedCount: preparedIds?.length ?? -1, preparedIdsMatch: sameCanonical(preparedIds, fixture.preparedJobIds),
        expectedAttempt },
    },
  }
  expect(summary, `Prepare proof preflight ${label}: ${JSON.stringify(summary)}`).toMatchObject({
    graph: { nodeCount: 3, currentNodeCount: 3, taskCount: 3, analyzePrefixAccepted: true },
    prepare: {
      node: { key: "prepare", templateId: "prepare", depth: 3, dependsOnAnalyst: true,
        goalMatchesExpected: true, successCriteriaCount: 2, successCriteriaMatch: true, specialized: true },
      current: { present: true, taskMatches: true, status: "completed", failureReason: null },
      task: { present: true, identityMatches: true, role: TASK_GRAPH_TEMPLATES.prepare.role,
        taskType: TASK_GRAPH_TEMPLATES.prepare.taskType, status: "completed", attemptCount: expectedAttempt,
        failureReason: null, schemaMatches: true, actionsMatch: true },
      envelope: { status: "completed", structuredStatus: "completed", factsPresent: true, factKeysExact: true,
        schemaMatches: true, factsResultMatchesStructured: true },
      facts: { receiptMatchesFixture: true, completionRevisionMatches: true, completionNodeCount: 3, completionNodesMatch: true },
      wait: { count: 1, identityMatches: true, ownerMatches: true, parentMatches: true, stepMatches: true,
        keyMatches: true, status: "ready", mode: "all", targetMatches: true, matchedMatches: true,
        requestKeysExact: true, requestMode: "all", timeoutMs: 86_400_000, requestTargetsMatch: true },
      step: { count: 1, identityMatches: true, rootTaskMatches: true, attempt: 1 },
      proof: { builderAccepted: true, builderMatchesFixture: true, loaderAccepted: true, loaderMatchesFixture: true,
        preparedCount: fixture.preparedJobIds.length, preparedIdsMatch: true, expectedAttempt },
    },
  })
}

function record(value: unknown): Record<string, unknown> | null {
  const parsed = parseJson(value)
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
}
function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try { return JSON.parse(value) as unknown } catch { return null }
}
function sameKeys(value: Record<string, unknown> | null, expected: readonly string[]): boolean {
  return !!value && Object.keys(value).sort().join(",") === [...expected].sort().join(",")
}
function sameCanonical(left: unknown, right: unknown): boolean {
  try { return canonicalTaskGraphJson(left) === canonicalTaskGraphJson(right) } catch { return false }
}
function summarizeCompletionNodes(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.map(entry => {
    const node = record(entry)
    const dependencies = node?.dependsOnTaskIds
    return { taskId: node?.taskId, role: node?.role, taskType: node?.taskType, attemptCount: node?.attemptCount,
      status: node?.status, verification: node?.verification,
      dependsOnTaskIds: Array.isArray(dependencies) ? dependencies.filter((dependency): dependency is string => typeof dependency === "string") : null,
      hasResultDigest: typeof node?.resultDigest === "string" && node.resultDigest.length > 0 }
  })
}
function prepareDependencyKey(continuationKey: string, stepId: string): string {
  return `scheduled-prepare-dependency:${createHash("sha256").update(`${continuationKey}\0${stepId}`, "utf8").digest("hex")}`
}

async function startStep(fixture: GateFixture, lease: TurnLease,
  store: ReturnType<typeof createPgTurnEngineStore>): Promise<string> {
  const result = await pool!.query<{ ordinal: number | string }>(`SELECT COALESCE(MAX("ordinal"), -1) + 1 AS "ordinal"
    FROM "agent_steps" WHERE "sessionId"=$1 AND "turnId"=$2`, [fixture.ids.sessionId, fixture.ids.turnId])
  const ordinal = Number(result.rows[0]?.ordinal)
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new Error("scheduled_gate_root_step_ordinal_invalid")
  const stepId = `scheduled-gate-root-step-${randomUUID()}`
  const owner = turnFence(lease, fixture.ids.rootTaskId)
  await store.startStep({ owner, stepId, ordinal, attempt: 1, inputThroughSequence: 0n,
    consumedInputIds: [], modelProfileSnapshot: { provider: "fixture", model: "scheduled-gate-root" }, now: new Date() })
  return stepId
}

async function suspendRoot(fixture: GateFixture, lease: TurnLease, stepId: string, waitId: string,
  turnStore: ReturnType<typeof createPgTurnEngineStore>, durableWait: ReturnType<typeof createPgDurableWaitPort>): Promise<void> {
  await turnStore.updateStep({ owner: turnFence(lease, fixture.ids.rootTaskId), stepId, status: "waiting_for_tool",
    finishReason: "stop", errorCode: null, ...zeroUsage, now: new Date() })
  await expect(durableWait.suspendAndRelease({ lease, waitId, now: new Date() })).resolves.toMatchObject({
    waitId, handoff: "suspended", waitStatus: "waiting",
  })
}

async function finishUserWait(fixture: GateFixture, lease: TurnLease, stepId: string, waitId: string,
  rootStore: ReturnType<typeof createPgRootTaskStore>, execution: ReturnType<typeof createCanonicalExecutionProjection>): Promise<void> {
  await rootStore.finish({ lease, rootTaskId: fixture.ids.rootTaskId,
    result: { status: "waiting_for_user", stepCount: 1, toolCallCount: 0, waitId } })
  await execution.finish({ userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    result: { status: "waiting_for_user" } })
  expect(await releaseTurnLease(pool!, lease, "waiting_for_user")).toBe(true)
  const step = await pool!.query<{ status: string }>(`SELECT "status" FROM "agent_steps" WHERE "id"=$1`, [stepId])
  expect(step.rows[0]?.status).toBe("waiting_for_user")
  expect(fixture.ids.turnId).toBe(lease.turnId)
}

async function answerWebQuestion(fixture: GateFixture, waitId: string, expectedRevision: number, answer: string): Promise<void> {
  const dbModule = "@/lib/db"
  const brokerModule = "@/lib/agent/broker/store"
  const webDatabase = await import(dbModule) as unknown as { db: { $disconnect(): Promise<void> } }
  webDb = webDatabase
  const broker = await import(brokerModule) as unknown as {
    answerQuestion(db: unknown, input: { sessionId: string; userId: string; waitId: string; clientMessageId: string;
      expectedTurnId: string; expectedRevision: number; answer: string; now: Date }): Promise<{
        disposition: string; status: string; waitId: string; turnId: string; nextTurnRevision: number
      }>
  }
  const command = { sessionId: fixture.ids.sessionId, userId: fixture.ids.userId, waitId,
    clientMessageId: `scheduled-gate-answer-${waitId}`, expectedTurnId: fixture.ids.turnId,
    expectedRevision, answer, now: new Date() }
  await expect(broker.answerQuestion(webDatabase.db, command)).resolves.toMatchObject({ disposition: "resolved", status: "answered",
    waitId, turnId: fixture.ids.turnId, nextTurnRevision: expectedRevision + 1 })
  await expect(broker.answerQuestion(webDatabase.db, command)).resolves.toMatchObject({ disposition: "duplicate", status: "answered", waitId })
  await expect(broker.answerQuestion(webDatabase.db, { ...command, clientMessageId: `${command.clientMessageId}-stale` }))
    .rejects.toBeDefined()
}

async function assertGateQuestionIsPrivate(fixture: GateFixture, lease: TurnLease, itemId: string, answer: string): Promise<void> {
  const client = await pool!.connect()
  try {
    await client.query("BEGIN READ ONLY")
    await client.query("SELECT set_config('app.user_id', $1, true)", [fixture.ids.userId])
    const steps = await client.query(`SELECT "id", "taskId", "ordinal" FROM "agent_steps" WHERE "sessionId"=$1 AND "turnId"=$2 ORDER BY "ordinal"`,
      [fixture.ids.sessionId, fixture.ids.turnId])
    const items = await client.query(`SELECT "id", "sessionId", "turnId", "stepId", "taskId", "type", "content" FROM "agent_items" WHERE "sessionId"=$1 AND "turnId"=$2 ORDER BY "createdAt", "id"`,
      [fixture.ids.sessionId, fixture.ids.turnId])
    const recovered = await recoverAnsweredQuestionContext(client, { lease, rootTaskId: fixture.ids.rootTaskId,
      steps: steps.rows, toolItems: items.rows, existingHistory: [] })
    const history = JSON.stringify(recovered.history)
    expect(history).not.toContain(`agent-question:${itemId}:question`)
    expect(history).not.toContain(`agent-question:${itemId}:answer`)
    expect(history).not.toContain("scheduledGateChoiceBinding")
    expect(history).not.toContain("scheduledGateChoiceResumeAcknowledgement")
    const privateItem = items.rows.find(row => row.id === itemId) as { content?: Record<string, unknown> } | undefined
    expect(privateItem?.content).toMatchObject({ stage: "scheduled_gate", answer, answerAvailable: true })
    await client.query("COMMIT")
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined)
    throw error
  } finally { client.release() }
}

async function assertResumeReplayFences(clientPool: Pool, command: ReturnType<typeof createPgTaskGraphCommandPort>, fixture: GateFixture,
  lease: TurnLease, owner: GateFixture["owner"], stepId: string,
  question: { waitId: string; itemId: string }, requestAttemptCount: number): Promise<void> {
  const gateTaskId = fixture.ids.gateTaskId ?? await findGateTaskId(clientPool, fixture.ids.rootTaskId)
  const scope = { ...fixture.graphScope, stepId, turnLeaseOwner: lease.ownerId, turnLeaseVersion: lease.leaseVersion,
    parentLeaseOwner: lease.ownerId, parentAttemptCount: owner.rootAttemptCount }
  const executionOwner = { executionId: fixture.executionOwner.executionId, executionAttemptCount: fixture.executionOwner.executionAttemptCount }
  const resume = command.resumeScheduledGateChoice
  if (!resume) throw new Error("scheduled_gate_resume_command_unavailable")
  const before = await resumeCounts(clientPool, fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId, gateTaskId, requestAttemptCount)
  expect(before).toEqual({ events: 1, eventOutbox: 1, dispatchCount: 1,
    dispatchAttemptCount: requestAttemptCount * 2, dispatchPublished: false })
  await expect(resume.call(command, { scope, executionOwner, gateTaskId, requestAttemptCount,
    waitId: question.waitId, now: new Date() })).resolves.toMatchObject({ status: "duplicate", taskId: gateTaskId,
      requestAttemptCount, resumedAttemptCount: requestAttemptCount + 1, readyTaskIds: [gateTaskId] })
  await expect(resume.call(command, { scope, executionOwner, gateTaskId, requestAttemptCount: requestAttemptCount + 1,
    waitId: question.waitId, now: new Date() })).rejects.toBeDefined()
  expect(await resumeCounts(clientPool, fixture.ids.sessionId, fixture.ids.turnId, fixture.ids.rootTaskId, gateTaskId, requestAttemptCount)).toEqual(before)
}

async function assertPrivateAcknowledgement(clientPool: Pool, itemId: string, gateTaskId: string, attempt: number, expectedWaitId: string): Promise<void> {
  const result = await clientPool.query<{ content: Record<string, unknown> }>(`SELECT "content" FROM "agent_items" WHERE "id"=$1`, [itemId])
  const content = result.rows[0]?.content
  expect(content?.scheduledGateChoiceBinding).toMatchObject({ gateTaskId, gateAttempt: attempt, kind: "weak_cover_letter" })
  expect(content?.answer).toBe("skip")
  expect(content?.questionId).toBe(expectedWaitId)
  expect(content?.scheduledGateChoiceResumeAcknowledgement).toMatchObject({ gateTaskId, requestAttemptCount: attempt,
    waitId: expectedWaitId, itemId, resumedAttemptCount: attempt + 1 })
  expect(Object.keys(content?.scheduledGateChoiceResumeAcknowledgement as object).sort())
    .toEqual(["gateTaskId", "itemId", "requestAttemptCount", "resumedAttemptCount", "waitId"])
}

async function resumeCounts(clientPool: Pool, sessionId: string, turnId: string, rootTaskId: string,
  gateTaskId: string, attempt: number): Promise<{ events: number; eventOutbox: number; dispatchCount: number;
    dispatchAttemptCount: number | null; dispatchPublished: boolean }> {
  const lifecycleKey = taskGraphLifecycleKey(rootTaskId, "gate", attempt, "task.gate_choice_resumed")
  const events = await clientPool.query<{ count: string }>(`SELECT COUNT(*)::text AS "count" FROM "agent_events"
    WHERE "sessionId"=$1 AND "turnId"=$2 AND "taskId"=$3 AND "type"='item.delta' AND "idempotencyKey"=$4
      AND "payload"->>'kind'='lifecycle' AND "payload"->'event'->>'type'='task.gate_choice_resumed'
      AND "payload"->'event'->>'gateTaskId'=$5 AND "payload"->'event'->>'requestAttemptCount'=$6
      AND "payload"->'event'->>'resumedAttemptCount'=$7`,
  [sessionId, turnId, rootTaskId, lifecycleKey, gateTaskId, String(attempt), String(attempt + 1)])
  const eventOutbox = await clientPool.query<{ count: string }>(`SELECT COUNT(*)::text AS "count" FROM "agent_outbox"
    WHERE "aggregateId"=$1 AND "topic"='agent.session.event' AND "payload"->>'idempotencyKey'=$2
      AND "payload"->>'type'='item.delta' AND "payload"->>'taskId'=$3 AND "payload"->>'turnId'=$4`,
  [sessionId, lifecycleKey, rootTaskId, turnId])
  const dispatch = await dispatchState(clientPool, sessionId, gateTaskId)
  return { events: Number(events.rows[0]?.count ?? 0), eventOutbox: Number(eventOutbox.rows[0]?.count ?? 0),
    dispatchCount: dispatch.count, dispatchAttemptCount: dispatch.attemptCount, dispatchPublished: dispatch.published }
}

async function dispatchState(clientPool: Pool, sessionId: string, gateTaskId: string): Promise<{
  count: number; attemptCount: number | null; published: boolean
}> {
  const result = await clientPool.query<{ count: string; attemptCount: number | null; published: boolean | null }>(`SELECT
      COUNT(*)::text AS "count", MAX("attemptCount")::int AS "attemptCount", BOOL_OR("publishedAt" IS NOT NULL) AS "published"
    FROM "agent_outbox" WHERE "aggregateId"=$1 AND "topic"='agent.subagent.dispatch'
      AND "idempotencyKey"=$2 AND "payload"->>'taskId'=$3`, [sessionId, `subagent-dispatch:${gateTaskId}`, gateTaskId])
  return { count: Number(result.rows[0]?.count ?? 0), attemptCount: result.rows[0]?.attemptCount ?? null,
    published: result.rows[0]?.published ?? false }
}

async function assertPublicGateProjection(fixture: GateFixture, gateTaskId: string): Promise<void> {
  const events = await pool!.query<{ id: string; payload: unknown }>(`SELECT "id", "payload" FROM "agent_events"
    WHERE "sessionId"=$1 AND "turnId"=$2 AND ("type"='agent.plan.scheduled_gate_binding'
      OR ("type"='item.delta' AND "payload"->'event'->>'type'='task.gate_choice_resumed'))`,
  [fixture.ids.sessionId, fixture.ids.turnId])
  const outbox = await pool!.query<{ payload: unknown }>(`SELECT "payload" FROM "agent_outbox"
    WHERE "aggregateId"=$1 AND "topic"='agent.session.event' AND "payload"->>'eventId'=ANY($2::text[])`,
  [fixture.ids.sessionId, events.rows.map(row => row.id)])
  const graph = await pool!.query<{ content: unknown }>(`SELECT "content" FROM "agent_items" WHERE "id"=$1`,
    [`agent-taskgraph:${fixture.ids.rootTaskId}`])
  const task = await pool!.query<{ result: unknown }>(`SELECT "result" FROM "sub_agent_tasks" WHERE "id"=$1`, [gateTaskId])
  for (const value of [events.rows, outbox.rows, graph.rows, task.rows]) {
    const serialized = JSON.stringify(value)
    expect(serialized).not.toContain("scheduledGateChoiceBinding")
    expect(serialized).not.toContain("scheduledGateChoiceResumeAcknowledgement")
    expect(serialized).not.toContain('"choiceId"')
  }
}

async function dispatchPendingOutbox(clientPool: Pool, targetQueue: Queue, sessionId: string): Promise<number> {
  const queueModulePath = "../../queue/subagent-queue.js"
  const queueModule = await import(queueModulePath) as unknown as {
    dispatchPendingSubagentOutbox(pool: never, queue: never, limit: number, sessionId: string): Promise<number>
  }
  return queueModule.dispatchPendingSubagentOutbox(clientPool as never, targetQueue as never, 10, sessionId)
}

function responsePlan(jobIds: readonly string[]): Record<string, ScheduledGateResult> {
  const plan: Record<string, ScheduledGateResult> = {}
  for (let current = 1; current <= 4; current += 1) {
    const jobId = jobIds[current - 1]
    if (!jobId) throw new Error("scheduled_gate_prepared_job_missing")
    plan[String(current)] = { status: "question_required", kind: "weak_cover_letter", jobIds: [jobId],
      candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", [jobId]),
      allowedChoiceIds: ["continue", "review", "skip"] }
  }
  plan["5"] = { status: "completed", nextStage: "execute", approvedJobIds: [], pendingJobIds: [],
    skippedJobIds: [...jobIds].sort(), counts: { approved: 0, pending: 0, skipped: jobIds.length } }
  return plan
}

function singleQuestionPlan(jobId: string): Record<string, ScheduledGateResult> {
  return { "1": { status: "question_required", kind: "weak_cover_letter", jobIds: [jobId],
    candidateSetDigest: scheduledGateCandidateSetDigest("weak_cover_letter", [jobId]),
    allowedChoiceIds: ["continue", "review", "skip"] } }
}

function startWorker(queueName: string, taskId: string, plan: Record<string, ScheduledGateResult>): WorkerProcess {
  const env = { ...process.env, CI: "true", AGENT_RUNTIME_PG_TEST_URL: databaseUrl!,
    AGENT_TURN_REDIS_TEST_URL: redisUrl!, AGENT_RUNTIME_PG_TEST_DISPOSABLE: "true", AGENT_TURN_REDIS_TEST_DISPOSABLE: "true" }
  const processHandle = spawn(process.execPath, ["--import", "tsx", workerFixture, "gate-worker", queueName, taskId, JSON.stringify(plan)],
    { cwd: workerCwd, env, stdio: ["ignore", "pipe", "pipe"] })
  const handle: WorkerProcess = { child: processHandle, lines: [], partial: "", waiters: [] }
  processHandle.stdout?.on("data", chunk => collect(handle, String(chunk)))
  processHandle.stderr?.on("data", chunk => collect(handle, String(chunk)))
  processHandle.once("error", error => failWaiters(handle, error))
  processHandle.once("exit", (code, signal) => {
    if (code !== null && code !== 0 || signal && signal !== "SIGKILL") failWaiters(handle, new Error(`gate_worker_exit_${code ?? signal}`))
  })
  return handle
}

function collect(handle: WorkerProcess, chunk: string): void {
  const segments = `${handle.partial}${chunk}`.split(/\r?\n/)
  handle.partial = segments.pop() ?? ""
  for (const line of segments) {
    const waiterIndex = handle.waiters.findIndex(waiter => line.startsWith(`${waiter.marker} `))
    if (waiterIndex >= 0) {
      const [waiter] = handle.waiters.splice(waiterIndex, 1)
      try { waiter!.resolve(JSON.parse(line.slice(waiter!.marker.length + 1)) as Marker) }
      catch { waiter!.reject(new Error("gate_worker_marker_invalid")) }
    } else if (line.startsWith("ERROR ")) {
      failWaiters(handle, new Error(`gate_worker_${String((JSON.parse(line.slice(6)) as Marker).code ?? "failed")}`))
    } else if (line.trim()) handle.lines.push(line)
  }
}

function nextMarker(handle: WorkerProcess, marker: string, timeoutMs = 30_000): Promise<Marker> {
  const index = handle.lines.findIndex(line => line.startsWith(`${marker} `))
  if (index >= 0) {
    const [line] = handle.lines.splice(index, 1)
    return Promise.resolve(JSON.parse(line!.slice(marker.length + 1)) as Marker)
  }
  return new Promise((resolve, reject) => {
    const waiter = { marker, resolve, reject }
    handle.waiters.push(waiter)
    const timer = setTimeout(() => {
      const index = handle.waiters.indexOf(waiter)
      if (index >= 0) handle.waiters.splice(index, 1)
      reject(new Error(`gate_worker_marker_timeout_${marker}`))
    }, timeoutMs)
    const originalResolve = waiter.resolve, originalReject = waiter.reject
    waiter.resolve = value => { clearTimeout(timer); originalResolve(value) }
    waiter.reject = error => { clearTimeout(timer); originalReject(error) }
  })
}

function failWaiters(handle: WorkerProcess, error: Error): void {
  for (const waiter of handle.waiters.splice(0)) waiter.reject(error)
}

async function stopWorker(handle: WorkerProcess | undefined): Promise<void> {
  if (!handle) return
  if (handle.child.exitCode === null && handle.child.signalCode === null) {
    handle.child.kill("SIGKILL")
    const [, signal] = await once(handle.child, "exit") as [number | null, NodeJS.Signals | null]
    expect(signal).toBe("SIGKILL")
  } else expect(handle.child.signalCode).toBe("SIGKILL")
}

async function findGateTaskId(clientPool: Pool, rootTaskId: string): Promise<string> {
  const result = await clientPool.query<{ id: string }>(`SELECT "id" FROM "sub_agent_tasks" WHERE "rootTaskId"=$1 AND "taskType"='scheduled_taskgraph_gate'`, [rootTaskId])
  if (result.rows.length !== 1) throw new Error("scheduled_gate_task_identity_missing")
  return result.rows[0]!.id
}

function turnFence(lease: TurnLease, rootTaskId: string) {
  return { kind: "turn" as const, userId: lease.userId, sessionId: lease.sessionId, turnId: lease.turnId,
    taskId: rootTaskId, rootTaskId, ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt }
}

function disposableDatabaseUrl(): string | null {
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (!value || process.env.CI !== "true" || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") return null
  const url = new URL(value)
  return url.protocol === "postgresql:" && url.hostname === "127.0.0.1" && url.port === "5432"
    && url.username === "postgres" && url.password === "postgres" && url.pathname === "/applymate_agent_brain_ci"
    && !url.search && !url.hash ? value : null
}

function disposableRedisUrl(): string | null {
  const value = process.env.AGENT_TURN_REDIS_TEST_URL
  if (!value || process.env.CI !== "true" || process.env.AGENT_TURN_REDIS_TEST_DISPOSABLE !== "true") return null
  const url = new URL(value)
  return url.protocol === "redis:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
    && url.port === "6379" && url.pathname === "/15" && !url.username && !url.password && !url.search && !url.hash ? value : null
}
