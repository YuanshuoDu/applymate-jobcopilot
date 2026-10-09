import { createHash } from "node:crypto"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

import { assertSteeringCapacity, MAX_UNRESOLVED_STEERING_INPUTS, readUnresolvedSteeringCount } from "./steering-capacity"
import { lockOpenSession, type CommandTransaction } from "./transaction"

type Row = Record<string, unknown>
const scope = {
  userId: "user_1", sessionId: "session_1", turnId: "turn_1", rootTaskId: "root_1", parentTaskId: "root_1", stepId: "decision-step",
  turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
}
const timestamp = new Date("2026-10-09T00:00:00.000Z")

function acceptedRow(index: number, state: "accepted" | "queued" | "consumed" = "accepted", consumer: string | null = null) {
  const id = `steer-${index}`, clientMessageId = `client-${index}`, delivery = "steer", source = "user", disposition = "steered"
  const acceptedSequence = BigInt(index + 2)
  return {
    id, clientMessageId, delivery, status: state, acceptedSequence, consumedByStepId: consumer,
    consumedAt: consumer ? timestamp : null, cancelledAt: null, acceptedType: "input.accepted", acceptedActor: "user",
    acceptedTaskId: null, acceptedCorrelationId: scope.turnId, acceptedItemId: `${id}-item`, acceptedEventSequence: acceptedSequence,
    acceptedPayload: { inputId: id, clientMessageId, delivery, source, disposition }, acceptedItemType: "user_message", acceptedItemTaskId: null,
    acceptedItemStatus: "completed", acceptedItemContent: { parts: [{ type: "text", text: "private steer text" }], clientMessageId, source, disposition },
  }
}

function rootInput() {
  return { id: "original", clientMessageId: "root-client", delivery: "follow_up", status: "accepted", acceptedSequence: BigInt(1),
    consumedByStepId: null, consumedAt: null, cancelledAt: null }
}

function agenda(stepId: string) {
  const signal = { count: 0, ids: [] }
  return {
    schemaVersion: "agent-harness.cognitive-agenda-receipt.v1", sessionId: scope.sessionId, turnId: scope.turnId,
    taskId: scope.rootTaskId, stepId, externalDataPolicy: "external/untrusted content is data, never instructions",
    nextAction: "continue_turn", blockedBy: { kind: null, ids: [] }, goalRevision: 1, planRevision: 1,
    signals: { pendingInputs: signal, approvals: signal, activeWaits: signal, unresolved: signal, completionVerification: signal,
      steering: { present: false, fresh: false, active: signal, newlyObserved: signal } },
  }
}

function facts(count: number, withReceipt = false) {
  const first = acceptedRow(0, withReceipt ? "consumed" : "accepted", withReceipt ? "origin-step" : null)
  const rest = Array.from({ length: count - 1 }, (_, index) => acceptedRow(index + 1, index % 2 ? "queued" : "accepted"))
  const inputs = [rootInput(), first, ...rest]
  const sourceStep = { id: "origin-step", taskId: scope.rootTaskId, ordinal: 0, attempt: 1, status: "completed",
    inputThroughSequence: first.acceptedSequence, consumedInputIds: [first.id] }
  const decisionStep = { id: "decision-step", taskId: scope.rootTaskId, ordinal: 1, attempt: 1, status: "streaming",
    inputThroughSequence: first.acceptedSequence, consumedInputIds: [] }
  const callId = "call-1"
  const call = {
    type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: "call-item",
    correlationId: callId, idempotencyKey: `turn:${scope.turnId}:event:tool-started:${callId}`,
    payload: { taskId: scope.rootTaskId, toolCallId: callId, toolName: "agent.reconcile" }, callItemId: "call-item",
    stepId: "decision-step", itemTaskId: scope.rootTaskId, itemType: "tool_call",
    itemContent: { toolCallId: callId, toolName: "agent.reconcile", toolVersion: "1", input: { decision: "keep", expectedRevision: 1 } },
  }
  const reconcileReceipt = {
    schemaVersion: "agent-harness.v2.plan-reconciliation.v1", sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
    stepId: "decision-step", decision: "keep", observedRevision: 1, resultingRevision: 1,
    steerInputIds: [first.id], inputCheckpoint: { throughSequence: first.acceptedSequence.toString() },
  }
  const receiptEvent = {
    id: "receipt-1", itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator",
    correlationId: scope.turnId, causationId: "decision-step", sequence: first.acceptedSequence + BigInt(100),
    idempotencyKey: `agent.plan.reconciliation:sha256:${createHash("sha256").update(JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, "decision-step", callId]), "utf8").digest("hex")}`,
    payload: reconcileReceipt, hasOutbox: false,
  }
  const historyStep = withReceipt ? [sourceStep, decisionStep] : []
  const receiptEvents = withReceipt ? [receiptEvent] : []
  const callRows = withReceipt ? [call] : []
  const agendas = withReceipt ? [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: "decision-step", payload: agenda("decision-step") }] : []
  const queryRaw = vi.fn(async (query: unknown): Promise<Row[]> => {
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ")
      if (sql.includes('SELECT "input", "rootTaskId" FROM "agent_turns"')) return [{ input: { clientMessageId: "root-client" }, rootTaskId: scope.rootTaskId }]
      if (sql.includes('FROM "sub_agent_tasks"')) return [{ id: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId, attemptCount: 1 }]
      if (sql.includes('SELECT "revision" FROM "agent_items"')) return [{ revision: 1 }]
      if (sql.includes('FROM "agent_inputs" AS input')) return inputs
      if (sql.includes("event.\"type\" = 'agent.plan.reconciliation'")) return receiptEvents
      if (sql.includes("event.\"type\" = 'tool_call.started'")) return callRows
      if (sql.includes('FROM "agent_steps"')) return historyStep
      if (sql.includes("event.\"type\" = 'cognitive.agenda'")) return agendas
      throw new Error(`unexpected capacity query: ${sql}`)
    })
  const tx = { $queryRaw: queryRaw } as unknown as CommandTransaction
  return { tx, queryRaw, inputs, receiptEvents, callRows, sourceStep, decisionStep, first }
}

async function invokeWorkerReader(fixture: ReturnType<typeof facts>): Promise<number> {
  type WorkerReader = {
    readSteeringReconciliationState(client: { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> }, scope: {
      userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string;
      turnLeaseOwner: string; turnLeaseVersion: number; parentLeaseOwner: string; parentAttemptCount: number;
    }): Promise<{ unresolvedInputs: readonly unknown[] }>
  }
  const workerRoot = resolve(process.cwd(), "../../apps/worker/src/runtime/subagents")
  const readerPath = resolve(workerRoot, "steering-reconciliation-read.ts")
  const graphStatePath = resolve(workerRoot, "task-graph-pg-state.ts")
  vi.doMock(graphStatePath, () => ({ lockTaskGraphScope: async () => ({}) }))
  try {
    // Load the real Worker reader only at test runtime, outside Web's static TypeScript module graph.
    const reader = await vi.importActual<WorkerReader>(readerPath)
    const client = {
      async query(sql: string): Promise<{ rows: Row[] }> {
        if (sql.includes('SELECT turn."input" FROM "agent_turns"')) return { rows: [{ input: { clientMessageId: "root-client" } }] }
        if (sql.includes('FROM "agent_inputs" WHERE')) return { rows: fixture.inputs.map(({ id, clientMessageId, delivery, status, acceptedSequence, consumedByStepId, consumedAt, cancelledAt }) =>
          ({ id, clientMessageId, delivery, status, acceptedSequence, consumedByStepId, consumedAt, cancelledAt })) }
        if (sql.includes('LEFT JOIN "agent_events"')) return { rows: (fixture.inputs as Row[])
          .filter(row => row.delivery === "steer" && ["accepted", "queued", "consumed"].includes(String(row.status))) }
        if (sql.includes('SELECT item."revision"')) return { rows: [{ revision: 1 }] }
        if (sql.includes('FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3')) {
          return { rows: fixture.receiptEvents.map(row => ({ ...row, hasOutbox: false })) }
        }
        if (sql.includes('event."type" = \'tool_call.started\'')) return { rows: fixture.callRows }
        if (sql.includes('FROM "agent_steps"') && sql.includes('"consumedInputIds"')) return { rows: fixture.sourceStep ? [fixture.sourceStep] : [] }
        if (sql.includes('FROM "agent_steps"')) return { rows: fixture.decisionStep ? [fixture.decisionStep] : [] }
        if (sql.includes('event."type" = \'cognitive.agenda\'')) return { rows: fixture.receiptEvents.length
          ? [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: "decision-step", payload: agenda("decision-step") }] : [] }
        throw new Error(`unexpected Worker reader query: ${sql}`)
      },
    }
    const state = await reader.readSteeringReconciliationState(client, {
      userId: scope.userId, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId,
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "root-owner", parentAttemptCount: 1,
    })
    return state.unresolvedInputs.length
  } finally {
    vi.doUnmock(graphStatePath)
    vi.resetModules()
  }
}

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolvePromise => { release = resolvePromise })
  return { promise, release }
}

function sharedSessionLock(key: { sessionId: string; userId: string }) {
  type Owner = "web" | "worker"
  const events: Array<{ phase: "requested" | "acquired" | "released"; owner: Owner; sessionId: string; userId: string }> = []
  const queue: Array<{ owner: Owner; resolve: () => void }> = []
  const queuedSignals = new Map<Owner, Array<() => void>>()
  let owner: Owner | null = null
  function grantNext() {
    const next = queue.shift()
    if (!next) return
    owner = next.owner
    events.push({ phase: "acquired", owner, sessionId: key.sessionId, userId: key.userId })
    next.resolve()
  }
  return {
    events,
    async acquire(nextOwner: Owner, sessionId: string, userId: string) {
      if (sessionId !== key.sessionId || userId !== key.userId) throw new Error(`unexpected session lock key: ${sessionId}/${userId}`)
      events.push({ phase: "requested", owner: nextOwner, sessionId, userId })
      await new Promise<void>(resolvePromise => {
        queue.push({ owner: nextOwner, resolve: resolvePromise })
        if (owner === null && queue.length === 1) grantNext()
        else for (const signal of queuedSignals.get(nextOwner) ?? []) signal()
      })
    },
    waitUntilQueued(nextOwner: Owner) {
      if (queue.some(entry => entry.owner === nextOwner)) return Promise.resolve()
      return new Promise<void>(resolvePromise => {
        const signals = queuedSignals.get(nextOwner) ?? []
        signals.push(resolvePromise)
        queuedSignals.set(nextOwner, signals)
      })
    },
    release(nextOwner: Owner) {
      if (owner !== nextOwner) throw new Error(`session lock released by non-owner: ${nextOwner}`)
      events.push({ phase: "released", owner: nextOwner, sessionId: key.sessionId, userId: key.userId })
      owner = null
      grantNext()
    },
  }
}

describe("steer acceptance capacity", () => {
  it("counts accepted and queued user steers, and rejects the next one at 128 before writes", async () => {
    const full = facts(MAX_UNRESOLVED_STEERING_INPUTS)
    const count = await readUnresolvedSteeringCount(full.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })
    expect(count).toBe(MAX_UNRESOLVED_STEERING_INPUTS)
    expect(await invokeWorkerReader(full)).toBe(count)
    const error = await assertSteeringCapacity(full.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })
      .then(() => null, value => value as Error & { details?: Record<string, unknown> })
    expect(error).toMatchObject({ name: "AgentCommandError", code: "invalid_command", status: 409, details: { capacity: 128, unresolvedCount: 128 } })
    expect(error?.message).not.toContain("private steer text")
    expect(JSON.stringify(error?.details)).not.toContain("steer-")

    const below = facts(MAX_UNRESOLVED_STEERING_INPUTS - 1)
    await expect(assertSteeringCapacity(below.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })).resolves.toBeUndefined()
  })

  it("reclaims capacity only for a complete validated receipt and agrees with the Worker unresolved reader", async () => {
    const fixture = facts(MAX_UNRESOLVED_STEERING_INPUTS, true)
    const count = await readUnresolvedSteeringCount(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })
    expect(count).toBe(MAX_UNRESOLVED_STEERING_INPUTS - 1)
    await expect(assertSteeringCapacity(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })).resolves.toBeUndefined()
    const workerCount = await invokeWorkerReader(fixture)
    expect(workerCount).toBe(MAX_UNRESOLVED_STEERING_INPUTS - 1)
    expect(count).toBe(workerCount)
  })

  it("does not let an unconsumed input be covered by a receipt", async () => {
    const fixture = facts(2, true)
    const receipt = fixture.receiptEvents[0]!
    const unconsumed = fixture.inputs[2]!
    const through = String(unconsumed.acceptedSequence)
    fixture.queryRaw.mockImplementation(async (query: unknown) => {
      const sql = ((query as { strings?: readonly string[] }).strings ?? []).join(" ")
      if (sql.includes("event.\"type\" = 'agent.plan.reconciliation'")) return [{ ...receipt, payload: { ...(receipt.payload as object), steerInputIds: ["steer-0", "steer-1"], inputCheckpoint: { throughSequence: through } } }]
      if (sql.includes("event.\"type\" = 'tool_call.started'")) return fixture.callRows
      if (sql.includes('FROM "agent_steps"')) return [fixture.sourceStep, { ...fixture.decisionStep, inputThroughSequence: unconsumed.acceptedSequence }]
      if (sql.includes("event.\"type\" = 'cognitive.agenda'")) return [{ actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: "decision-step", payload: agenda("decision-step") }]
      if (sql.includes('SELECT "input", "rootTaskId" FROM "agent_turns"')) return [{ input: { clientMessageId: "root-client" }, rootTaskId: scope.rootTaskId }]
      if (sql.includes('FROM "sub_agent_tasks"')) return [{ id: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId, attemptCount: 1 }]
      if (sql.includes('SELECT "revision" FROM "agent_items"')) return [{ revision: 1 }]
      if (sql.includes('FROM "agent_inputs" AS input')) return fixture.inputs
      throw new Error(`unexpected capacity query: ${sql}`)
    })
    await expect(readUnresolvedSteeringCount(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId }))
      .rejects.toMatchObject({ code: "invalid_command", status: 409 })
  })

  it("serializes Web steer acceptance with Worker reconciliation on the same Session row", async () => {
    type WorkerGraphLock = {
      lockTaskGraphScope(client: { query(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> }, scope: {
        userId: string; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string;
        turnLeaseOwner: string; turnLeaseVersion: number; parentLeaseOwner: string; parentAttemptCount: number;
      }, requireWorkAdmission?: boolean): Promise<Row>
    }
    const workerRoot = resolve(process.cwd(), "../../apps/worker/src/runtime/subagents")
    const graphStatePath = resolve(workerRoot, "task-graph-pg-state.ts")
    const workerGraph = await vi.importActual<WorkerGraphLock>(graphStatePath)
    const persistedKey = { sessionId: "session_1", userId: scope.userId }
    const graphScope = {
      userId: persistedKey.userId, sessionId: persistedKey.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.rootTaskId,
      turnLeaseOwner: scope.turnLeaseOwner, turnLeaseVersion: scope.turnLeaseVersion, parentLeaseOwner: scope.parentLeaseOwner, parentAttemptCount: 1,
    }

    async function race(first: "web" | "worker") {
      const lock = sharedSessionLock(persistedKey)
      let unresolved = MAX_UNRESOLVED_STEERING_INPUTS
      let maximum = unresolved
      let accepted = false
      let observedError: unknown
      const webLocked = gate(), webChecked = gate(), webRelease = gate()
      const workerLocked = gate(), workerRelease = gate()
      let webLockSql = ""
      let webLockValues: readonly unknown[] = []
      const webTx = {
        async $queryRaw(query: unknown): Promise<Row[]> {
          const value = query as { strings?: readonly string[]; values?: readonly unknown[] }
          const sql = (value.strings ?? []).join(" ")
          if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
            webLockSql = sql
            webLockValues = value.values ?? []
            await lock.acquire("web", String(value.values?.[0]), String(value.values?.[1]))
            return [{ id: persistedKey.sessionId }]
          }
          if (sql.includes('SELECT "input", "rootTaskId" FROM "agent_turns"')) return [{ input: { clientMessageId: "root-client" }, rootTaskId: null }]
          if (sql.includes('FROM "agent_inputs" AS input')) return [rootInput(), ...Array.from({ length: unresolved }, (_, index) => acceptedRow(index))]
          if (sql.includes('event."type" = \'agent.plan.reconciliation\'')) return []
          throw new Error(`unexpected Web acceptance query: ${sql}`)
        },
      } as unknown as CommandTransaction
      const workerQueries: Array<{ sql: string; sessionId: string; userId: string }> = []
      const workerClient = {
        async query(sql: string, values: readonly unknown[] = []): Promise<{ rows: Row[] }> {
          workerQueries.push({ sql, sessionId: String(values[0]), userId: String(values[1]) })
          if (sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE")) {
            await lock.acquire("worker", String(values[0]), String(values[1]))
            return { rows: [{ id: persistedKey.sessionId }] }
          }
          if (sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE")) return { rows: [{ id: scope.turnId }] }
          if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("FOR UPDATE OF task")) return { rows: [{ id: scope.rootTaskId }] }
          if (sql.includes("WITH wall_clock AS MATERIALIZED")) return { rows: [{ turnLeaseValid: true, parentLeaseValid: true }] }
          throw new Error(`unexpected Worker lock query: ${sql}`)
        },
      }
      const webAcceptance = async () => {
        await lockOpenSession(webTx, persistedKey.sessionId, persistedKey.userId)
        webLocked.release()
        try {
          await assertSteeringCapacity(webTx, { sessionId: persistedKey.sessionId, userId: persistedKey.userId, turnId: scope.turnId })
          // Model the accepted input write that follows the guard in AgentCommandService.
          unresolved += 1
          maximum = Math.max(maximum, unresolved)
          accepted = true
        } catch (error: unknown) {
          observedError = error
        }
        webChecked.release()
        await webRelease.promise
        lock.release("web")
      }
      const workerReconciliation = async () => {
        await workerGraph.lockTaskGraphScope(workerClient, graphScope, false)
        workerLocked.release()
        await workerRelease.promise
        // Model a receipt commit while the actual Worker TaskGraph locks remain held.
        unresolved -= 1
        maximum = Math.max(maximum, unresolved)
        lock.release("worker")
      }
      let webTask: Promise<void>
      let workerTask: Promise<void>

      if (first === "worker") {
        workerTask = workerReconciliation()
        await workerLocked.promise
        webTask = webAcceptance()
        const webQueued = lock.waitUntilQueued("web")
        await webQueued
        expect(lock.events.filter(event => event.phase === "acquired").map(event => event.owner)).toEqual(["worker"])
        expect(unresolved).toBe(MAX_UNRESOLVED_STEERING_INPUTS)
        workerRelease.release()
        await webLocked.promise
        await webChecked.promise
        webRelease.release()
      } else {
        webTask = webAcceptance()
        await webLocked.promise
        await webChecked.promise
        workerTask = workerReconciliation()
        const workerQueued = lock.waitUntilQueued("worker")
        await workerQueued
        expect(lock.events.filter(event => event.phase === "acquired").map(event => event.owner)).toEqual(["web"])
        expect(unresolved).toBe(MAX_UNRESOLVED_STEERING_INPUTS)
        webRelease.release()
        await workerLocked.promise
        workerRelease.release()
      }
      await Promise.all([webTask, workerTask])
      return { accepted, observedError, unresolved, maximum, events: lock.events, webLockSql, webLockValues, workerQueries }
    }

    for (const first of ["web", "worker"] as const) {
      const result = await race(first)
      const owners = result.events.filter(event => event.phase === "acquired").map(event => event.owner)
      expect(owners).toEqual(first === "web" ? ["web", "worker"] : ["worker", "web"])
      expect(result.events.filter(event => event.phase === "requested").map(event => [event.sessionId, event.userId]))
        .toEqual([[persistedKey.sessionId, persistedKey.userId], [persistedKey.sessionId, persistedKey.userId]])
      expect(result.webLockSql).toContain('FROM "agent_sessions"')
      expect(result.webLockSql).toContain("FOR UPDATE")
      expect(result.webLockValues.slice(0, 2)).toEqual([persistedKey.sessionId, persistedKey.userId])
      expect(result.workerQueries[0]?.sql).toContain('FROM "agent_sessions"')
      expect(result.workerQueries[0]?.sql).toContain("FOR UPDATE")
      expect([result.workerQueries[0]?.sessionId, result.workerQueries[0]?.userId]).toEqual([persistedKey.sessionId, persistedKey.userId])
      expect(result.workerQueries[1]?.sql).toContain('FROM "agent_turns"')
      expect(result.workerQueries[1]?.sql).toContain("FOR UPDATE")
      expect(result.workerQueries[2]?.sql).toContain('FROM "sub_agent_tasks"')
      expect(result.workerQueries[2]?.sql).toContain("FOR UPDATE OF task")
      expect(result.workerQueries[3]?.sql).toContain("WITH wall_clock AS MATERIALIZED")
      expect(result.maximum).toBe(MAX_UNRESOLVED_STEERING_INPUTS)
      expect(result.unresolved).toBe(first === "web" ? MAX_UNRESOLVED_STEERING_INPUTS - 1 : MAX_UNRESOLVED_STEERING_INPUTS)
      expect(result.accepted).toBe(first === "worker")
      if (first === "web") expect(result.observedError).toMatchObject({ code: "invalid_command", status: 409 })
    }
  })
})
