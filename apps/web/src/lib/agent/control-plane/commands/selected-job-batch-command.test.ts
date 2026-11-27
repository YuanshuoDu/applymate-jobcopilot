import { describe, expect, it, vi } from "vitest"
import { TASK_GRAPH_SCHEMA_VERSION, VERIFIED_SHORTLIST_SELECTION_SCHEMA } from "@jobcopilot/agent-protocol"
import type { PrismaClient } from "@prisma/client"

import { canonicalTaskGraphItemId } from "@/lib/agent/session/final-task-graph-source-detail"
import type { CommandTransaction } from "./transaction"
import { SelectedJobBatchCommandService } from "./selected-job-batch-command"
import { AgentCommandError } from "./errors"

type Row = Record<string, unknown>
const owner = { sessionId: "session-1", userId: "user-1" }
const source = { sessionId: owner.sessionId, sourceTurnId: "source-turn", rootTaskId: "source-root",
  graphItemId: canonicalTaskGraphItemId("source-root"), graphRevision: 4 }
const selected = ["job-1", "job-2"]
const binding = { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, source, selectedJobIds: selected }
const shortlist = { schemaVersion: 1, status: "completed", items: [
  { jobId: "job-1", score: 9, evidenceIds: ["read:job:job-1"] },
  { jobId: "job-2", score: 8, evidenceIds: ["read:job:job-2"] },
  { jobId: "job-3", score: 7, evidenceIds: ["read:job:job-3"] },
], failures: [] }
const sourceTurn = { id: source.sourceTurnId, ...owner, source: "user", status: "completed", rootTaskId: source.rootTaskId,
  executionMode: null, input: { intent: { kind: "interactive_discovery_shortlist", version: 1 } } }
const sourceRoot = { id: source.rootTaskId, sessionId: owner.sessionId, turnId: source.sourceTurnId, rootTaskId: source.rootTaskId,
  parentTaskId: null, role: "orchestrator", taskType: "root", status: "completed", failureReason: null,
  result: { status: "completed", stepCount: 3, toolCallCount: 4, finalItemId: "item-final", waitId: null,
    structuredResult: { interactiveDiscoveryShortlist: shortlist } } }
const sourceGraph = { id: source.graphItemId, sessionId: owner.sessionId, turnId: source.sourceTurnId, taskId: source.rootTaskId,
  type: "task_graph", revision: source.graphRevision, content: { schemaVersion: TASK_GRAPH_SCHEMA_VERSION, nodes: [
    { key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Save evidence"], dependsOn: [], depth: 1, taskId: "scout-1" },
    { key: "analyst", templateId: "analyst", goal: "Score jobs", successCriteria: ["Compare jobs"], dependsOn: ["scout"], depth: 2, taskId: "analyst-1" },
  ] } }

function makeDb(options: { sessionStatus?: string; active?: boolean; failDispatch?: boolean; invalidRoot?: boolean } = {}) {
  let sessionStatus = options.sessionStatus ?? "running"
  let turns: Row[] = [sourceTurn]
  let inputs: Row[] = []
  let items: Row[] = []
  let events: Row[] = []
  let outbox: Row[] = []
  const rawQueries: unknown[] = [], operations: string[] = []
  let sequence = BigInt(0)
  let active = options.active ? { id: "active-turn", sessionId: owner.sessionId, userId: owner.userId, status: "in_progress" } : null
  let step: Row | null = null
  const tx = {
    $queryRaw: vi.fn(async (query: unknown) => {
      rawQueries.push(query)
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ")
      if (sql.includes('SELECT "id", "status" FROM "agent_sessions"')) {
        operations.push("session_lock")
        return [{ id: owner.sessionId, status: sessionStatus }]
      }
      if (sql.includes('UPDATE "agent_sessions"')) {
        operations.push("sequence")
        sequence += BigInt(1)
        return [{ eventSequence: sequence }]
      }
      return []
    }),
    agentTurn: {
      findFirst: vi.fn(async (args: unknown) => {
        operations.push("turn_read")
        const where = ((args as { where?: Row }).where ?? {})
        if (where.id) return turns.find(row => row.id === where.id && row.sessionId === where.sessionId
          && row.userId === where.userId && (where.source === undefined || row.source === where.source)
          && (where.status === undefined || row.status === where.status) && (where.rootTaskId === undefined || row.rootTaskId === where.rootTaskId)) ?? null
        const statuses = (where.status as { in?: string[] } | undefined)?.in
        return active && (!statuses || statuses.includes(String(active.status))) ? active : null
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Row }).data
        turns.push({ ...data, status: "queued", revision: 0 })
        return { id: data.id }
      }),
    },
    subAgentTask: { findFirst: vi.fn(async () => options.invalidRoot ? { ...sourceRoot, status: "failed" } : sourceRoot) },
    agentItem: { findFirst: vi.fn(async () => sourceGraph), create: vi.fn(async (args: unknown) => {
      const data = (args as { data: Row }).data
      items.push(data)
      return data
    }) },
    job: { findMany: vi.fn(async ({ where }: { where: { id: { in: string[] }; userId: string } }) =>
      where.userId === owner.userId ? where.id.in.map(id => ({ id })) : []) },
    agentInput: {
      findFirst: vi.fn(async (args: unknown) => {
        operations.push("input_read")
        const where = ((args as { where?: Row }).where ?? {})
        return inputs.find(row => row.sessionId === where.sessionId && row.clientMessageId === where.clientMessageId
          && (where.id === undefined || row.id === where.id) && (where.userId === undefined || row.userId === where.userId)) ?? null
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Row }).data
        const row = { consumedByStepId: null, consumedAt: null, cancelledAt: null, ...data }
        inputs.push(row)
        return row
      }),
    },
    agentEvent: {
      findFirst: vi.fn(async (args: unknown) => {
        const where = ((args as { where?: Row }).where ?? {})
        return events.find(row => row.sessionId === where.sessionId && row.idempotencyKey === where.idempotencyKey) ?? null
      }),
      create: vi.fn(async (args: unknown) => {
        const data = (args as { data: Row }).data
        events.push(data)
        return data
      }),
    },
    agentOutbox: { create: vi.fn(async (args: unknown) => {
      const data = (args as { data: Row }).data
      if (options.failDispatch && data.topic === "agent.turn.dispatch") throw new Error("dispatch unavailable")
      outbox.push(data)
      return data
    }) },
    agentStep: { findFirst: vi.fn(async (args: unknown) => {
      const where = ((args as { where?: Row }).where ?? {})
      return step && step.id === where.id && step.sessionId === where.sessionId && step.turnId === where.turnId ? step : null
    }) },
    agentApproval: { create: vi.fn(), findFirst: vi.fn() },
  }
  const transaction = vi.fn(async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => {
    const before = { turns: [...turns], inputs: [...inputs], items: [...items], events: [...events], outbox: [...outbox], sequence }
    try { return await work(tx) } catch (error: unknown) {
      turns = before.turns; inputs = before.inputs; items = before.items; events = before.events; outbox = before.outbox; sequence = before.sequence
      throw error
    }
  })
  const db = { $transaction: transaction } as unknown as PrismaClient
  return {
    db, tx, rawQueries, operations,
    state: {
      get turns() { return turns }, get inputs() { return inputs }, get items() { return items },
      get events() { return events }, get outbox() { return outbox },
      setConsumed(stepOverrides: Row = {}) {
        const input = inputs[0]!
        input.status = "consumed"
        input.consumedByStepId = "step-1"
        input.consumedAt = new Date("2026-11-20T12:00:00.000Z")
        step = { id: "step-1", sessionId: owner.sessionId, turnId: input.targetTurnId,
          inputThroughSequence: input.acceptedSequence, consumedInputIds: [input.id], ...stepOverrides }
        const turn = turns.find(row => row.id === input.targetTurnId)!
        const inputData = turn.input as Row
        turn.input = { verifiedShortlistSelection: inputData.verifiedShortlistSelection, intent: inputData.intent,
          clientMessageId: inputData.clientMessageId, goal: inputData.goal, content: [{ text: (inputData.content as Row[])[0]?.text, type: "text" }] }
        input.content = [{ text: (input.content as Row[])[0]?.text, type: "text" }]
      },
      setSessionStatus(value: string) { sessionStatus = value },
    },
  }
}

function command(overrides: Partial<Parameters<SelectedJobBatchCommandService["start"]>[0]> = {}) {
  return { sessionId: owner.sessionId, userId: owner.userId, clientMessageId: "batch-once", source: "user" as const,
    sourceIdentity: source, selectedJobIds: ["job-2", "job-1"], ...overrides }
}

describe("selected-job batch command", () => {
  it("revalidates under the Session lock and atomically writes the bound canonical Turn and one dispatch", async () => {
    const fake = makeDb(), result = await new SelectedJobBatchCommandService(fake.db).start(command())
    expect(result).toMatchObject({ disposition: "started", turnId: expect.any(String), inputId: expect.any(String) })
    expect(fake.operations[0]).toBe("session_lock")
    const turn = fake.state.turns.find(row => row.id === result.turnId)!
    expect(turn).toMatchObject({ source: "user", executionMode: "canonical_task_graph" })
    expect(turn.input).toMatchObject({ intent: { kind: "selected_job_batch_preparation", version: 1 },
      verifiedShortlistSelection: { schemaVersion: VERIFIED_SHORTLIST_SELECTION_SCHEMA, selectedJobIds: selected } })
    expect(turn.input).not.toHaveProperty("selectedJobPreparation")
    expect(fake.tx.agentTurn.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: {
      id: source.sourceTurnId, sessionId: owner.sessionId, userId: owner.userId, source: "user", status: "completed", rootTaskId: source.rootTaskId,
    } }))
    expect(fake.state.outbox.filter(row => row.topic === "agent.turn.dispatch")).toHaveLength(1)
    expect(fake.tx.agentApproval.create).not.toHaveBeenCalled()
  })

  it("replays the exact accepted input after Worker consumption and JSONB key reordering without another outbox", async () => {
    const fake = makeDb(), service = new SelectedJobBatchCommandService(fake.db)
    const started = await service.start(command()), outboxCount = fake.state.outbox.length
    fake.state.setConsumed()

    const replay = await service.start(command())

    expect(replay).toMatchObject({ disposition: "duplicate", originalDisposition: "started",
      turnId: started.turnId, inputId: started.inputId, sequence: started.sequence })
    expect(fake.state.outbox).toHaveLength(outboxCount)
    expect(fake.tx.agentStep.findFirst).toHaveBeenCalledWith({ where: {
      id: "step-1", sessionId: owner.sessionId, turnId: started.turnId,
    }, select: { id: true, sessionId: true, turnId: true, inputThroughSequence: true, consumedInputIds: true } })
  })

  it.each([
    ["cancelled", (fake: ReturnType<typeof makeDb>) => { fake.state.inputs[0]!.status = "cancelled" }],
    ["foreign Step", (fake: ReturnType<typeof makeDb>) => fake.state.setConsumed({ sessionId: "foreign-session" })],
    ["fabricated Step checkpoint", (fake: ReturnType<typeof makeDb>) => fake.state.setConsumed({ consumedInputIds: [] })],
  ])("rejects replay for a %s receipt without creating work", async (_label, corrupt) => {
    const fake = makeDb(), service = new SelectedJobBatchCommandService(fake.db)
    await service.start(command())
    corrupt(fake)
    const writes = { turns: fake.tx.agentTurn.create.mock.calls.length, outbox: fake.state.outbox.length }

    await expect(service.start(command())).rejects.toMatchObject({ code: "objective_start_idempotency_conflict", status: 409 })
    expect(fake.tx.agentTurn.create).toHaveBeenCalledTimes(writes.turns)
    expect(fake.state.outbox).toHaveLength(writes.outbox)
  })

  it("rejects changed selection and cross-command replay without writes", async () => {
    const changed = makeDb(), service = new SelectedJobBatchCommandService(changed.db)
    await service.start(command())
    const counts = { turns: changed.state.turns.length, inputs: changed.state.inputs.length, outbox: changed.state.outbox.length }
    await expect(service.start(command({ selectedJobIds: ["job-1", "job-3"] })))
      .rejects.toMatchObject({ code: "objective_start_idempotency_conflict", status: 409 })
    await expect(service.start(command({ sourceIdentity: { ...source, sourceTurnId: "other-source" } })))
      .rejects.toMatchObject({ code: "objective_start_idempotency_conflict", status: 409 })
    expect(changed.state.turns).toHaveLength(counts.turns)
    expect(changed.state.inputs).toHaveLength(counts.inputs)
    expect(changed.state.outbox).toHaveLength(counts.outbox)

    const foreign = makeDb()
    foreign.state.turns.push({ id: "ordinary-turn", sessionId: owner.sessionId, userId: owner.userId, source: "user",
      status: "queued", executionMode: "legacy", input: { goal: "Other command", content: [], clientMessageId: "batch-once" } })
    foreign.state.inputs.push({ id: "ordinary-input", userId: owner.userId, sessionId: owner.sessionId, targetTurnId: "ordinary-turn",
      clientMessageId: "batch-once", delivery: "follow_up", status: "accepted", content: [{ type: "text", text: "Other command" }], acceptedSequence: BigInt(1) })
    const before = foreign.state.outbox.length
    await expect(new SelectedJobBatchCommandService(foreign.db).start(command()))
      .rejects.toMatchObject({ code: "objective_start_idempotency_conflict", status: 409 })
    expect(foreign.state.outbox).toHaveLength(before)
    expect(foreign.tx.agentTurn.create).not.toHaveBeenCalled()
  })

  it.each([
    ["paused", { sessionStatus: "paused" }],
    ["active", { active: true }],
    ["stale source", { invalidRoot: true }],
  ])("denies a fresh batch when the Session is %s or proof is unavailable", async (_label, options) => {
    const fake = makeDb(options)
    await expect(new SelectedJobBatchCommandService(fake.db).start(command())).rejects.toBeInstanceOf(AgentCommandError)
    expect(fake.tx.agentTurn.create).not.toHaveBeenCalled()
    expect(fake.tx.agentInput.create).not.toHaveBeenCalled()
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("rolls back Turn, accepted input, events and outbox if dispatch creation fails", async () => {
    const fake = makeDb({ failDispatch: true })
    await expect(new SelectedJobBatchCommandService(fake.db).start(command())).rejects.toThrow("dispatch unavailable")
    expect(fake.state.turns).toHaveLength(1)
    expect(fake.state.inputs).toHaveLength(0)
    expect(fake.state.items).toHaveLength(0)
    expect(fake.state.events).toHaveLength(0)
    expect(fake.state.outbox).toHaveLength(0)
  })

  it("rejects automation and malformed selection before opening the transaction", async () => {
    const fake = makeDb(), service = new SelectedJobBatchCommandService(fake.db)
    await expect(service.start(command({ source: "automation" }))).rejects.toMatchObject({ code: "invalid_command" })
    await expect(service.start(command({ selectedJobIds: ["job-1", "job-1"] }))).rejects.toMatchObject({ code: "invalid_command" })
    expect(fake.tx.$queryRaw).not.toHaveBeenCalled()
  })
})
