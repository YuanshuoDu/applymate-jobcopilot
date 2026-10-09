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

function queryData(query: unknown) {
  const values: unknown[] = []
  function render(value: unknown): string {
    if (!value || typeof value !== "object") return String(value)
    const sql = value as { strings?: readonly string[]; values?: readonly unknown[] }
    if (!Array.isArray(sql.strings) || !Array.isArray(sql.values) || sql.strings.length !== sql.values.length + 1) return String(value)
    let text = sql.strings[0] ?? ""
    for (let index = 0; index < sql.values.length; index++) {
      const nested = sql.values[index]
      if (nested && typeof nested === "object" && Array.isArray((nested as { strings?: unknown }).strings)) text += render(nested)
      else { values.push(nested); text += `$${values.length}` }
      text += sql.strings[index + 1]
    }
    return text
  }
  return { sql: render(query), values }
}

function sortableSequence(value: unknown): bigint | null {
  if (typeof value === "bigint") return value
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value)
  if (typeof value === "string" && /^(0|[1-9][0-9]{0,18})$/.test(value)) return BigInt(value)
  return null
}

function keysetPage(rows: Row[], query: unknown, marker: string, sequenceKey: string, cursorStart: number, extra?: (row: Row, sql: string, values: readonly unknown[]) => boolean) {
  const { sql, values } = queryData(query), hasCursor = sql.includes(marker)
  const cursorSequence = hasCursor ? BigInt(values[cursorStart] as bigint) : null
  const cursorId = hasCursor ? String(values[cursorStart + 2]) : null
  const pageSize = Number(values[values.length - 1])
  return rows.filter(row => {
    const rowSequence = sortableSequence(row[sequenceKey])
    if (rowSequence === null) return true
    const afterCursor = cursorSequence === null || rowSequence > cursorSequence || rowSequence === cursorSequence && String(row.id ?? row.eventId) > cursorId!
    return afterCursor && (!extra || extra(row, sql, values))
  }).sort((left, right) => {
    const a = sortableSequence(left[sequenceKey]), b = sortableSequence(right[sequenceKey])
    if (a === null || b === null) return a === null ? b === null ? 0 : 1 : -1
    return a === b ? String(left.id ?? left.eventId).localeCompare(String(right.id ?? right.eventId)) : a < b ? -1 : 1
  }).slice(0, pageSize)
}

function capacityQueryMock(data: { inputs: Row[]; receiptEvents: Row[]; callRows: Row[]; historyStep: Row[]; agendas: Row[] }) {
  return vi.fn(async (query: unknown): Promise<Row[]> => {
    const { sql, values } = queryData(query)
    if (sql.includes('SELECT "input", "rootTaskId" FROM "agent_turns"')) return [{ input: { clientMessageId: "root-client" }, rootTaskId: scope.rootTaskId }]
    if (sql.includes('FROM "sub_agent_tasks"')) return [{ id: scope.rootTaskId, sessionId: scope.sessionId, turnId: scope.turnId, attemptCount: 1 }]
    if (sql.includes('SELECT "revision" FROM "agent_items"')) return [{ revision: 1 }]
    if (sql.includes('FROM "agent_inputs" AS input')) return keysetPage(data.inputs, query, 'input."acceptedSequence" >', "acceptedSequence", 3, (row, text, params) =>
      !text.includes('input."acceptedSequence" <=') || BigInt(row.acceptedSequence as bigint) <= BigInt(params[3 + (text.includes('input."acceptedSequence" >') ? 3 : 0)] as bigint))
    if (sql.includes("event.\"type\" = 'agent.plan.reconciliation'")) return keysetPage(data.receiptEvents, query, 'event."sequence" >', "sequence", 2)
    if (sql.includes("event.\"type\" = 'tool_call.started'")) {
      const ids = values.find(Array.isArray) as string[] | undefined
      return keysetPage(data.callRows.filter(row => ids?.includes(String(row.stepId))), query, 'event."sequence" >', "eventSequence", 5)
    }
    if (sql.includes('FROM "agent_steps"')) {
      const ids = values.find(Array.isArray) as string[] | undefined
      return data.historyStep.filter(row => ids?.includes(String(row.id)))
    }
    if (sql.includes("event.\"type\" = 'cognitive.agenda'")) {
      const ids = values.find(Array.isArray) as string[] | undefined
      return keysetPage(data.agendas.filter(row => ids?.includes(String(row.correlationId))), query, 'event."sequence" >', "sequence", 4)
    }
    throw new Error(`unexpected capacity query: ${sql}`)
  })
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
    eventId: "call-event", eventSequence: first.acceptedSequence + BigInt(50),
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
  const agendas = withReceipt ? [{ id: "agenda-decision-step", sequence: first.acceptedSequence + BigInt(60), actor: "orchestrator", itemId: null, taskId: scope.rootTaskId, correlationId: "decision-step", payload: agenda("decision-step") }] : []
  const queryRaw = capacityQueryMock({ inputs, receiptEvents, callRows, historyStep, agendas })
  const tx = { $queryRaw: queryRaw } as unknown as CommandTransaction
  return { tx, queryRaw, inputs, receiptEvents, callRows, sourceStep, decisionStep, first }
}

function largeFacts(receiptCount: number, unresolvedCount = 2) {
  const inputs: Row[] = [rootInput()], receiptEvents: Row[] = [], callRows: Row[] = [], historyStep: Row[] = [], agendas: Row[] = []
  const addCall = (stepId: string, callId: string, eventId: string, eventSequence: bigint): Row => ({
    eventId, eventSequence, type: "tool_call.started", actor: "orchestrator", eventTaskId: scope.rootTaskId, eventItemId: `${callId}-item`,
    correlationId: callId, idempotencyKey: `turn:${scope.turnId}:event:tool-started:${callId}`,
    payload: { taskId: scope.rootTaskId, toolCallId: callId, toolName: "agent.reconcile" }, callItemId: `${callId}-item`, stepId,
    itemTaskId: scope.rootTaskId, itemType: "tool_call", itemContent: { toolCallId: callId, toolName: "agent.reconcile", toolVersion: "1", input: { decision: "keep", expectedRevision: 1 } },
  })
  for (let index = 0; index < receiptCount; index++) {
    const input = acceptedRow(index, "consumed", `consumer-${index}`), sequence = input.acceptedSequence as bigint
    const decisionStepId = `decision-${index}`, callId = `call-${index}`
    inputs.push(input)
    historyStep.push({ id: `consumer-${index}`, taskId: scope.rootTaskId, ordinal: 0, attempt: 1, status: "completed", inputThroughSequence: sequence, consumedInputIds: [input.id] })
    historyStep.push({ id: decisionStepId, taskId: scope.rootTaskId, ordinal: 1, attempt: 1, status: "completed", inputThroughSequence: sequence, consumedInputIds: [] })
    const receipt = { schemaVersion: "agent-harness.v2.plan-reconciliation.v1", sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId,
      stepId: decisionStepId, decision: "keep", observedRevision: 1, resultingRevision: 1, steerInputIds: [input.id], inputCheckpoint: { throughSequence: sequence.toString() } }
    const receiptKey = `agent.plan.reconciliation:sha256:${createHash("sha256").update(JSON.stringify([scope.userId, scope.sessionId, scope.turnId, scope.rootTaskId, decisionStepId, callId]), "utf8").digest("hex")}`
    receiptEvents.push({ id: `receipt-${index}`, itemId: null, taskId: scope.rootTaskId, type: "agent.plan.reconciliation", actor: "orchestrator",
      correlationId: scope.turnId, causationId: decisionStepId, sequence: BigInt(100000 + index), idempotencyKey: receiptKey, payload: receipt, hasOutbox: false })
    callRows.push(addCall(decisionStepId, callId, `call-event-${index}`, BigInt(1000 + index * 2)))
    callRows.push(addCall(decisionStepId, `noise-${index}`, `noise-event-${index}`, BigInt(1001 + index * 2)))
    agendas.push({ id: `agenda-event-${index}`, sequence: BigInt(50000 + index), actor: "orchestrator", itemId: null, taskId: scope.rootTaskId,
      correlationId: decisionStepId, payload: agenda(decisionStepId) })
  }
  for (let index = 0; index < unresolvedCount; index++) inputs.push(acceptedRow(receiptCount + index, index % 2 ? "queued" : "accepted"))
  const queryRaw = capacityQueryMock({ inputs, receiptEvents, callRows, historyStep, agendas })
  return { tx: { $queryRaw: queryRaw } as unknown as CommandTransaction, queryRaw, inputs, receiptEvents, callRows, historyStep, agendas }
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
      async query(sql: string, values?: readonly unknown[]): Promise<{ rows: Row[] }> {
        if (sql.includes('SELECT turn."input" FROM "agent_turns"')) return { rows: [{ input: { clientMessageId: "root-client" } }] }
        if (sql.includes('FROM "agent_inputs" WHERE') && sql.includes('"clientMessageId" = $4')) {
          const matches = fixture.inputs.filter(row => row.clientMessageId === values?.[3]).slice(0, 2)
          return { rows: matches.map(({ id, clientMessageId, delivery, status, acceptedSequence, consumedByStepId, consumedAt, cancelledAt }) =>
            ({ id, clientMessageId, delivery, status, acceptedSequence, consumedByStepId, consumedAt, cancelledAt })) }
        }
        if (sql.includes('FROM "agent_inputs" WHERE') && sql.includes('ORDER BY "acceptedSequence", "id"')) {
          const afterSequence = values?.[3] == null ? null : BigInt(String(values[3])), afterId = String(values?.[4] ?? "")
          const rows = fixture.inputs.filter(row => {
            const sequence = BigInt(String(row.acceptedSequence))
            return afterSequence === null || sequence > afterSequence || sequence === afterSequence && String(row.id) > afterId
          }).sort((left, right) => {
            const a = BigInt(String(left.acceptedSequence)), b = BigInt(String(right.acceptedSequence))
            return a === b ? String(left.id).localeCompare(String(right.id)) : a < b ? -1 : 1
          }).slice(0, 64)
          return { rows: rows.map(({ id, clientMessageId, delivery, status, acceptedSequence, consumedByStepId, consumedAt, cancelledAt }) =>
            ({ id, clientMessageId, delivery, status, acceptedSequence, consumedByStepId, consumedAt, cancelledAt })) }
        }
        if (sql.includes('LEFT JOIN "agent_events"')) {
          const acceptedIds = values?.[3] as string[] | undefined
          return { rows: (fixture.inputs as Row[]).filter(row => acceptedIds?.includes(String(row.id))
            && row.delivery === "steer" && ["accepted", "queued", "consumed"].includes(String(row.status))) }
        }
        if (sql.includes('SELECT item."revision"')) return { rows: [{ revision: 1 }] }
        if (sql.includes('FROM "agent_events" AS event WHERE event."sessionId" = $1 AND event."turnId" = $2 AND event."type" = $3')) {
          const afterSequence = values?.[3] == null ? null : BigInt(String(values[3])), afterId = String(values?.[4] ?? "")
          const rows = fixture.receiptEvents.filter(row => {
            const sequence = BigInt(String(row.sequence))
            return afterSequence === null || sequence > afterSequence || sequence === afterSequence && String(row.id) > afterId
          }).sort((left, right) => {
            const a = BigInt(String(left.sequence)), b = BigInt(String(right.sequence))
            return a === b ? String(left.id).localeCompare(String(right.id)) : a < b ? -1 : 1
          }).slice(0, 64)
          return { rows: rows.map(row => ({ ...row, hasOutbox: false })) }
        }
        if (sql.includes('event."type" = \'tool_call.started\'')) {
          const stepIds = values?.[3] as string[] | undefined, afterId = values?.[4] == null ? null : String(values[4])
          const rows = fixture.callRows.filter(row => stepIds?.includes(String(row.stepId))
            && (afterId === null || String(row.eventId) > afterId))
            .sort((left, right) => String(left.eventId).localeCompare(String(right.eventId))).slice(0, 64)
          return { rows }
        }
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
    receipt.payload = { ...receipt.payload, steerInputIds: ["steer-0", "steer-1"], inputCheckpoint: { throughSequence: through } }
    fixture.decisionStep.inputThroughSequence = unconsumed.acceptedSequence
    await expect(readUnresolvedSteeringCount(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId }))
      .rejects.toMatchObject({ code: "invalid_command", status: 409 })
  })

  it("folds large resolved histories in pages and counts only the current unresolved steers", async () => {
    const fixture = largeFacts(270, 2)
    await expect(readUnresolvedSteeringCount(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId })).resolves.toBe(2)
    const queries = fixture.queryRaw.mock.calls.map(([query]) => queryData(query).sql)
    expect(queries.filter(sql => sql.includes('FROM "agent_inputs" AS input')).length).toBeGreaterThan(4)
    expect(queries.filter(sql => sql.includes("event.\"type\" = 'agent.plan.reconciliation'")).length).toBeGreaterThan(1)
    expect(queries.filter(sql => sql.includes("event.\"type\" = 'tool_call.started'")).length).toBeGreaterThan(1)
  })

  it("fails closed when a receipt deep in paged history is malformed", async () => {
    const fixture = largeFacts(270)
    const row = fixture.receiptEvents[269]!
    row.payload = { ...(row.payload as object), rootTaskId: "other-root" }
    await expect(readUnresolvedSteeringCount(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId }))
      .rejects.toMatchObject({ code: "invalid_command", status: 409 })
  })

  it("fails closed when the historic matching tool call after the old scan cap is malformed", async () => {
    const fixture = largeFacts(270)
    const row = fixture.callRows.find(call => call.eventId === "call-event-269")!
    row.payload = { ...(row.payload as object), toolName: "agent.plan" }
    await expect(readUnresolvedSteeringCount(fixture.tx, { sessionId: scope.sessionId, userId: scope.userId, turnId: scope.turnId }))
      .rejects.toMatchObject({ code: "invalid_command", status: 409 })
  })

  it.each(["missing", "null", "equal", "later"] as const)("fails closed when matching call start is %s relative to the receipt", async ordering => {
    const fixture = facts(2, true)
    const receiptSequence = fixture.receiptEvents[0]!.sequence as bigint
    if (ordering === "missing") fixture.callRows.length = 0
    else if (ordering === "null") Object.assign(fixture.callRows[0]!, { eventSequence: null })
    else fixture.callRows[0]!.eventSequence = ordering === "equal" ? receiptSequence : receiptSequence + BigInt(1)

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
          if (sql.includes('FROM "agent_inputs" AS input')) return keysetPage([rootInput(), ...Array.from({ length: unresolved }, (_, index) => acceptedRow(index))], query,
            'input."acceptedSequence" >', "acceptedSequence", 3, (row, text, params) => !text.includes('input."acceptedSequence" <=')
              || BigInt(row.acceptedSequence as bigint) <= BigInt(params[3 + (text.includes('input."acceptedSequence" >') ? 3 : 0)] as bigint))
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
