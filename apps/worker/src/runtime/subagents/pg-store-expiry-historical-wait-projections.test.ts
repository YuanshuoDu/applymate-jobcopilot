import { beforeEach, describe, expect, it, vi } from "vitest"
import { createHash } from "node:crypto"
import { buildCognitiveActionAgenda } from "../turns/cognitive-action-agenda.js"
import { buildCognitiveAgendaReceipt, cognitiveAgendaReceiptIdempotencyKey } from "../turns/cognitive-agenda-receipt.js"
import type { StepContext } from "../context/step-context-builder.js"

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), chain: vi.fn(), prefix: vi.fn(), pairDiagnostic: vi.fn() }))
vi.mock("./child-resume-source-wait-lifecycle.js", () => ({ inspectChildWaitSourceLifecycle: mocks.inspect }))
vi.mock("./pg-store-expiry-step-tool-chain-proof.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pg-store-expiry-step-tool-chain-proof.js")>()
  return { ...actual, readCanonicalWaitStepToolChain: mocks.chain }
})
vi.mock("./pg-store-expiry-historical-source-step-prefix.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pg-store-expiry-historical-source-step-prefix.js")>()
  return { ...actual, readCanonicalHistoricalSourceStepPrefix: mocks.prefix }
})
vi.mock("./pg-store-expiry-historical-wait-result-pair.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pg-store-expiry-historical-wait-result-pair.js")>()
  return { ...actual, diagnoseWaitResultPair: (...args: Parameters<typeof actual.diagnoseWaitResultPair>) => {
    mocks.pairDiagnostic(...args)
    return actual.diagnoseWaitResultPair(...args)
  } }
})

import { DurableSubagentWaitError, safeSubagentWaitJson } from "./durable-subagent-wait-store.js"
import { MAX_HISTORICAL_SOURCE_WAITS, diagnoseChildWaitTerminalCallProjections, readChildWaitTerminalCallProjections } from "./pg-store-expiry-historical-wait-projections.js"
import { CHILD_WAIT_RESULT_EVENTS_QUERY_SQL } from "./pg-store-expiry-historical-wait-result-pair.js"
import { CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL } from "./pg-store-expiry-historical-wait-binding.js"

const task = { id: "owner", sessionId: "session", turnId: "turn", rootTaskId: "root", userId: "user", leaseOwner: "lease-owner",
  attemptCount: 3, leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z") }
const unparenthesizedJsonExtractionAfterConcat = /\|\|\s*(?:[a-z_][\w]*\.)?(?:"[^"]+"|[a-z_][\w]*)(?:\s*->>?\s*(?:'[^']+'|"[^"]+"))+/i

function wait(index: number, sourceWaitCount = 1) {
  const taskIds = [`child-${index}`], deadlineAt = new Date("2099-01-01T00:00:00.000Z")
  const outcome = { waitId: `wait-${index}`, status: "ready", taskIds, deadlineAt: deadlineAt.toISOString(), matchedTaskIds: taskIds,
    tasks: [{ taskId: taskIds[0], status: "completed", role: "analyst", result: null, failureReason: null }] }
  return { id: `wait-${index}`, parentTaskId: task.id, sessionId: task.sessionId, turnId: task.turnId, userId: task.userId,
    stepId: `source-step-${index}`, mode: "any", status: "ready", deadlineAt, resolvedAt: new Date("2026-01-01T00:00:00.000Z"),
    consumedAt: new Date(), suspendedAt: new Date(), matchedTaskIds: taskIds, targetTaskIds: taskIds, idempotencyKey: `source-key-${index}`,
    sourceWaitCount, sourceCallItemId: `source-call-item-${index}`, sourceCallId: `source-call-${index}`,
    sourceStepStatus: "waiting_for_tool" as string, sourceStepOrdinal: 0,
    result: { request: { targetTaskIds: taskIds, mode: "any", timeoutMs: 100 }, outcome,
      sourceLifecycleRecovery: { resultItemId: `source-result-${index}`, ownerId: "historical-source-owner" } } }
}

function recoveredHandoffData(source: ReturnType<typeof wait>) {
  const stepId = source.stepId, callItemId = source.sourceCallItemId, resultItemId = `source-result:${String(source.id).slice(5)}`
  const context: StepContext = { schemaVersion: "agent-harness.v2", sessionId: task.sessionId, turnId: task.turnId, stepId,
    inputThroughSequence: 1n, consumedInputIds: [], blocks: [], canonicalJson: "{}" }
  const agenda = buildCognitiveAgendaReceipt({ sessionId: task.sessionId, turnId: task.turnId, taskId: task.id, stepId,
    agenda: buildCognitiveActionAgenda(context) })
  const agendaKey = cognitiveAgendaReceiptIdempotencyKey(stepId)
  if (!agenda || !agendaKey) throw new Error("fixture_agenda_invalid")
  const types = ["step.started", "cognitive.agenda", "model.started", "model.completed", "model.usage", "item.started"]
  const keys = [`task:${task.id}:event:step-started:${stepId}`, `task:${task.id}:event:${agendaKey}`,
    `task:${task.id}:event:model-started:${stepId}`, `task:${task.id}:event:model-completed:${stepId}`,
    `task:${task.id}:event:model-usage:${stepId}`, `task:${task.id}:event:item-started:${callItemId}`]
  const payloads = [{ stepId, ordinal: 0, taskId: task.id }, agenda,
    { taskId: task.id, provider: "fixture", model: "test-model" },
    { taskId: task.id, provider: "fixture", model: "test-model", toolCallCount: 1 },
    { taskId: task.id, provider: "fixture", model: "test-model", usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 } },
    { itemId: callItemId, type: "tool_call", phase: null }]
  const events = types.map((type, index) => ({ id: `handoff-event-${source.id}-${index}`, sequence: String(index + 1), type,
    actor: "subagent", itemId: index === 5 ? callItemId : null, correlationId: stepId,
    causationId: index === 0 ? null : `handoff-event-${source.id}-${index - 1}`, idempotencyKey: keys[index],
    payload: payloads[index], payloadDigest: "a".repeat(64) }))
  return { items: [{ id: callItemId, type: "tool_call" }, { id: resultItemId, type: "tool_result" }], events,
    completed: false, rangeCount: 6 }
}

function mockedRecoveredPrefix(source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) {
  const stepId = source.stepId, resultItemId = `source-result:${String(source.id).slice(5)}`
  if (data.completed || source.sourceStepStatus !== "waiting_for_tool" || data.items.length !== 2 || data.events.length !== 6
    || data.rangeCount !== 6 || data.events.some((event, index) => index > 0
      && (event.causationId !== data.events[index - 1]?.id || Number(event.sequence) <= Number(data.events[index - 1]?.sequence)))) return null
  const completedModel = data.events.find(event => event.type === "model.completed")
  if ((completedModel?.payload as { toolCallCount?: unknown } | undefined)?.toolCallCount !== 1) return null
  const events = data.events.map(({ payload: _payload, ...event }) => event)
  if (new Set(events.map(event => event.idempotencyKey)).size !== 6 || new Set(events.map(event => event.id)).size !== 6) return null
  return { stepId, attempt: 1, sourceCallItemId: source.sourceCallItemId, sourceCallId: source.sourceCallId,
    sourceResultItemId: resultItemId, waitKind: "recovered" as const, terminalMode: "recovered_handoff" as const,
    stepStartedEventId: events[0]!.id, stepCompletedEventId: null, events,
    items: data.items.map(item => ({ id: item.id, type: item.type, status: "completed", revision: 1, phase: null, contentDigest: "a".repeat(64) })) }
}

function completedClaim(source: ReturnType<typeof wait>, index: number, taskIds = source.targetTaskIds) {
  const callId = `claim-call-${index}`, stepId = `claim-step-${index}`
  const callItemId = `task:${task.id}:item:tool-call:${callId}:attempt:${task.attemptCount}`
  const resultItemId = `task:${task.id}:item:tool-result:${callId}:attempt:${task.attemptCount}`
  const input = { idempotencyKey: safeSubagentWaitJson(source.idempotencyKey, 16_384), taskIds, mode: source.mode, timeoutMs: 100 }
  const output = safeSubagentWaitJson(source.result.outcome, 16_384)
  const content = { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input, status: "completed", errorCode: null }
  const terminal = { id: `terminal-${index}`, sequence: "10", type: "tool_call.completed", actor: "subagent", itemId: callItemId,
    correlationId: callId, payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: task.id } }
  const started = { id: `result-start-${index}`, sequence: "11", type: "item.started", actor: "subagent", itemId: resultItemId,
    correlationId: stepId, causationId: terminal.id, idempotencyKey: `task:${task.id}:event:item-started:${resultItemId}`,
    payload: { itemId: resultItemId, type: "tool_result", phase: null } }
  const completed = { id: `result-completed-${index}`, sequence: "12", type: "item.completed", actor: "subagent", itemId: resultItemId,
    correlationId: resultItemId, causationId: started.id,
    idempotencyKey: `task:${task.id}:event:tool-result-completed:${callId}:${resultItemId}:1`,
    payload: { itemId: resultItemId, status: "completed", content: { toolCallId: callId, output, errorCode: null } } }
  const next = { id: `step-done:${stepId}`, sequence: "13", type: "step.completed", actor: "subagent", itemId: null,
    correlationId: stepId, causationId: completed.id, idempotencyKey: `task:${task.id}:event:step-completed:${stepId}`, payload: {} }
  return { waitId: source.id, row: { stepId, attempt: task.attemptCount, stepStatus: "completed", callItemId, callContent: content,
    callStatus: "completed", callRevision: 1, callPhase: null, startEventId: `claim-start:${index}`, startSequence: "8",
    sourceInput: { idempotencyKey: source.idempotencyKey }, resultItemId, resultContent: completed.payload.content,
    resultStatus: "completed", resultRevision: 1, resultPhase: null }, terminal, resultEvents: [started, completed, next] }
}

function client(rows: Record<string, unknown>[], claims: ReturnType<typeof completedClaim>[] = [], handoff?: ReturnType<typeof recoveredHandoffData>) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("SELECT wait.*")) return { rows }
    if (sql.includes("FROM unnest($1::text[])")) return { rows: (values[0] as string[]).map(id => ({ id })) }
    if (sql.includes(`"type" = 'step.completed'`)) return { rows: handoff?.completed ? [{ id: "step-completed" }] : [] }
    if (sql.includes("idempotencyKey\" = ANY($4::text[]) LIMIT 7")) return { rows: handoff?.events ?? [] }
    if (sql.includes("FROM \"agent_items\"") && sql.includes("ORDER BY \"id\" LIMIT 3")) return { rows: handoff?.items ?? [] }
    if (sql.includes("COUNT(*)::int AS \"count\" FROM \"agent_events\"")) return { rows: [{ count: handoff?.rangeCount ?? 0 }] }
    if (sql.startsWith('SELECT "id" FROM "agent_events"')) return { rows: [{ id: `source-start:${values[3] as string}` }] }
    if (sql.includes('SELECT claimStep."id"')) return { rows: claims.filter(claim => claim.waitId === values[8]).map(claim => claim.row) }
    if (sql.includes('idempotencyKey" = $4 LIMIT 2')) {
      const callId = String(values[3]).split(":event:tool-finished:")[1]
      const claim = claims.find(entry => entry.row.callContent && entry.row.callContent.toolCallId === callId)
      return { rows: claim ? [claim.terminal] : [] }
    }
    if (sql.includes("ORDER BY \"sequence\" LIMIT 4")) {
      const claim = claims.find(entry => entry.row.resultItemId === values[3])
      return { rows: claim?.resultEvents ?? [] }
    }
    throw new Error("unexpected_projection_query")
  })
  return { query } as never as { query: typeof query }
}

beforeEach(() => {
  mocks.inspect.mockClear()
  mocks.chain.mockReset()
  mocks.prefix.mockReset()
  mocks.pairDiagnostic.mockClear()
  mocks.inspect.mockImplementation(async (...args: unknown[]) => {
    const row = args.find(value => !!value && typeof value === "object" && "sourceCallId" in value) as Record<string, unknown> | undefined
    return { state: "recovered", toolCallId: row?.sourceCallId, callItemId: row?.sourceCallItemId, sourceAttempt: 1,
      resultItemId: `source-result:${String(row?.sourceCallId).replace("source-call-", "")}` }
  })
  mocks.chain.mockImplementation(async (_client, _scope, input: { stepId: string }) => ({
    stepId: input.stepId, attempt: task.attemptCount, waitCallItemId: `claim-item:${input.stepId}`, waitCallId: `claim-call:${input.stepId}`,
    waitResultItemId: `claim-result:${input.stepId}`, stepStartedEventId: `step-start:${input.stepId}`, stepStartedPayload: {},
    agendaEventId: `agenda:${input.stepId}`, agendaReceipt: {}, modelStartedEventId: `model-start:${input.stepId}`,
    modelCompletedEventId: `model-done:${input.stepId}`, modelUsageEventId: `model-usage:${input.stepId}`,
    stepCompletedEventId: `step-done:${input.stepId}`, nextEventId: `step-done:${input.stepId}`,
    events: [{ id: `step-start:${input.stepId}`, sequence: "1", type: "step.started" }],
    calls: [{ callItemId: `claim-item:${input.stepId}`, resultItemId: `claim-result:${input.stepId}` }],
  }))
  mocks.prefix.mockImplementation(async (_client: unknown, _scope: unknown, input: { stepId: string; terminalMode?: string }) => {
    if (input.terminalMode !== "recovered_handoff") return null
    const index = Number(input.stepId.slice("source-step-".length)), source = wait(index)
    return mockedRecoveredPrefix(source, recoveredHandoffData(source))
  })
})

describe("bounded historical wait projections", () => {
  it("reports only fixed bounded stages when a claim row is absent", async () => {
    const source = wait(1), diagnostic = await diagnoseChildWaitTerminalCallProjections(client([source]) as never, task)
    expect(diagnostic).toEqual({ sourceProjectionCount: 1, claimProjectionCount: 0,
      claimStages: [{ candidateOrdinal: 1, stage: "claim_rows_missing" }] })
    expect(JSON.stringify(diagnostic)).not.toContain(source.idempotencyKey)
  })

  it("reports the canonical step-chain gate without exposing persisted values", async () => {
    const source = wait(1)
    mocks.chain.mockResolvedValue(null)
    const diagnostic = await diagnoseChildWaitTerminalCallProjections(client([source], [completedClaim(source, 1)]) as never, task)
    expect(diagnostic).toEqual({ sourceProjectionCount: 1, claimProjectionCount: 0,
      claimStages: [{ candidateOrdinal: 1, stage: "claim_step_tool_chain_invalid" }] })
    expect(JSON.stringify(diagnostic)).not.toContain(source.idempotencyKey)
  })

  it("reports result-pair rejection gates without persisted IDs or payloads", async () => {
    const source = wait(1), claim = completedClaim(source, 1)
    claim.resultEvents = [claim.resultEvents[0]!, { ...claim.resultEvents[0]!, id: "duplicate-start" }, claim.resultEvents[1]!]
    const diagnostic = await diagnoseChildWaitTerminalCallProjections(client([source], [claim]) as never, task)
    expect(mocks.pairDiagnostic).toHaveBeenCalledTimes(1)
    expect(diagnostic.claimStages).toEqual([{ candidateOrdinal: 1, stage: "claim_result_pair_invalid", resultPair: {
      eventCount: 3, startedKeyMatches: 2, completedKeyMatches: 1, otherKeyMatches: 0,
      partitionValid: false, canonicalPairValid: false, eventIdsValid: false, startedIdentity: false, completedIdentity: true,
      startedPayload: false, completedPayload: true, startedCausation: false, completedCausation: false, numericOrder: false,
    } }])
    const serialized = JSON.stringify(diagnostic)
    expect(serialized).not.toContain(source.idempotencyKey)
    expect(serialized).not.toContain(claim.row.resultItemId)
    expect(serialized).not.toContain(JSON.stringify(claim.row.resultContent))
  })

  it("projects two exact source waits and their independent completed claims", async () => {
    const sources = [wait(1), wait(2)], claims = sources.map((source, index) => completedClaim(source, index + 1))
    const db = client(sources, claims)
    const projections = await readChildWaitTerminalCallProjections(db as never, task)
    const completed = projections.filter(row => row.resultItemId)
    expect(completed.map(row => [row.sourceWait.waitId, row.callItemId, row.sourceWait.claimKeyDigest !== null])).toEqual([
      ["wait-1", "task:owner:item:tool-call:claim-call-1:attempt:3", true],
      ["wait-2", "task:owner:item:tool-call:claim-call-2:attempt:3", true],
    ])
    expect(completed[0]?.stepToolChain).toEqual(expect.objectContaining({
      nextEventId: expect.any(String), events: expect.any(Array), calls: expect.any(Array),
    }))
    expect(completed[0]).not.toHaveProperty("stepToolChainProof")
    expect(JSON.parse(JSON.stringify(completed[0]))).toHaveProperty("stepToolChain.nextEventId")
    expect(projections.filter(row => !row.resultItemId).map(row => row.sourceWait.waitId)).toEqual(["wait-1", "wait-2"])
    expect(completed.every(row => row.sourceStepHandoff?.sourceStepPrefix.waitKind === "recovered")).toBe(true)
    expect(completed.every(row => !row.sourceStepPrefix && row.sourceStepHandoff)).toBe(true)
    expect(mocks.prefix).toHaveBeenCalledTimes(4)
    expect(db.query.mock.calls[0]?.[0]).toContain('owner."sessionId" = $2')
    expect(db.query.mock.calls.some(([sql]) => sql === CHILD_WAIT_RESULT_EVENTS_QUERY_SQL)).toBe(true)
    const acceptedDiagnostic = await diagnoseChildWaitTerminalCallProjections(client(sources, claims) as never, task)
    expect(acceptedDiagnostic.claimStages).toEqual([
      { candidateOrdinal: 1, stage: "claim_accepted" }, { candidateOrdinal: 2, stage: "claim_accepted" },
    ])
    expect(mocks.pairDiagnostic).not.toHaveBeenCalled()
    expect(db.query.mock.calls[0]?.[0]).toContain(`LIMIT ${MAX_HISTORICAL_SOURCE_WAITS + 1}`)
    expect(db.query.mock.calls.map(([sql]) => sql).join("\n")).not.toMatch(unparenthesizedJsonExtractionAfterConcat)
  })

  it("keeps an ambiguous duplicate claim and a misassociated claim unprojected", async () => {
    const first = wait(1), second = wait(2)
    const db = client([first, second], [completedClaim(first, 1), completedClaim(first, 3), completedClaim(second, 2, ["other-child"])])
    const projections = await readChildWaitTerminalCallProjections(db as never, task)
    expect(projections.filter(row => row.resultItemId)).toEqual([])
    expect(projections.filter(row => !row.resultItemId).map(row => row.sourceWait.waitId)).toEqual(["wait-1", "wait-2"])
  })

  it("fails closed before projecting any rows beyond the fixed history bound", async () => {
    const db = client(Array.from({ length: MAX_HISTORICAL_SOURCE_WAITS + 1 }, (_, index) => wait(index)))
    await expect(readChildWaitTerminalCallProjections(db as never, task)).resolves.toEqual([])
    expect(db.query).toHaveBeenCalledTimes(1)
  })

  it("leaves a source step with duplicate wait rows unprojected", async () => {
    const db = client([wait(1, 2)])
    await expect(readChildWaitTerminalCallProjections(db as never, task)).resolves.toEqual([])
    expect(mocks.inspect).not.toHaveBeenCalled()
  })

  it("carries recovered handoff source evidence without replacing the independent claim chain", async () => {
    const source = wait(1), handoff = recoveredHandoffData(source)
    mocks.prefix.mockImplementation(async (_client: unknown, _scope: unknown, input: { terminalMode?: string }) =>
      input.terminalMode === "recovered_handoff" ? mockedRecoveredPrefix(source, handoff) : null)
    const projections = await readChildWaitTerminalCallProjections(client([source], [completedClaim(source, 1)], handoff) as never, task)
    const sourceProjection = projections.find(row => row.callItemId === source.sourceCallItemId)
    const claimProjection = projections.find(row => row.sourceWait.claimKeyDigest !== null)
    expect(sourceProjection?.sourceStepHandoff).toMatchObject({ schemaVersion: "recovered_wait_handoff.v1",
      waitId: source.id, stepId: source.stepId, sourceCallItemId: source.sourceCallItemId, events: expect.any(Array) })
    expect(sourceProjection).not.toHaveProperty("sourceStepPrefix")
    expect(claimProjection?.sourceStepHandoff).toEqual(sourceProjection?.sourceStepHandoff)
    expect(claimProjection?.stepToolChain).toEqual(expect.objectContaining({ nextEventId: expect.any(String), calls: expect.any(Array) }))
    expect(claimProjection?.resultCompletedEventId).toEqual(expect.any(String))
  })

  it("does not hand off a receipt rejected by the source lifecycle validator", async () => {
    const source = wait(1)
    source.result = { ...source.result, sourceLifecycleRecovery: { resultItemId: "forged-result", ownerId: "forged-owner" } }
    mocks.prefix.mockResolvedValue(null)
    mocks.inspect.mockRejectedValue(new DurableSubagentWaitError("wait_scope_error", "invalid source marker"))
    await expect(readChildWaitTerminalCallProjections(client([source], [], recoveredHandoffData(source)) as never, task)).resolves.toEqual([])
  })

  it("detects a marker owner swap after projection without exposing the owner value", async () => {
    const source = wait(1), projections = await readChildWaitTerminalCallProjections(client([source]) as never, task)
    const proof = projections[0]?.sourceWait, originalDigest = proof?.sourceLifecycleRecoveryOwnerDigest
    expect(originalDigest).toBe(createHash("sha256").update("historical-source-owner").digest("hex"))
    expect(JSON.stringify(projections)).not.toContain("historical-source-owner")
    source.result.sourceLifecycleRecovery.ownerId = "different-valid-historical-owner"
    expect(createHash("sha256").update(source.result.sourceLifecycleRecovery.ownerId).digest("hex")).not.toBe(originalDigest)
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain("sourceLifecycleRecoveryOwnerDigest' = encode(sha256(convert_to(")
  })

  it.each([
    ["streaming source step", (source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => { source.sourceStepStatus = "streaming" }],
    ["completed source step", (source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => { source.sourceStepStatus = "completed" }],
    ["extra source tool call", (_source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => { data.items.push({ id: "extra-call", type: "tool_call" }) }],
    ["step completion", (_source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => { data.completed = true }],
    ["missing anchor", (_source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => { data.events.splice(2, 1) }],
    ["duplicate anchor", (_source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => { data.events.push({ ...data.events[0]!, id: "duplicate-anchor" }) }],
    ["broken causation", (_source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => { data.events[5]!.causationId = "detached" }],
    ["extra event in prelude", (_source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => { data.rangeCount += 1 }],
    ["multiple model calls", (_source: ReturnType<typeof wait>, data: ReturnType<typeof recoveredHandoffData>) => {
      Object.assign(data.events[3]!, { payload: { ...(data.events[3]!.payload as Record<string, unknown>), toolCallCount: 2 } })
    }],
  ])("fails closed on %s in the recovered handoff", async (_label, corrupt) => {
    const source = wait(1), handoff = recoveredHandoffData(source)
    corrupt(source, handoff)
    mocks.prefix.mockImplementation(async (_client: unknown, _scope: unknown, input: { terminalMode?: string }) =>
      input.terminalMode === "recovered_handoff" ? mockedRecoveredPrefix(source, handoff) : null)
    await expect(readChildWaitTerminalCallProjections(client([source], [], handoff) as never, task)).resolves.toEqual([])
  })

  it("revalidates the same historical receipt and current owner fence in final SQL", () => {
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('boundWait."id" = proof.value->\'sourceWait\'->>\'waitId\'')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('owner."leaseOwner" = $5')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('boundWait."result"->\'outcome\'->>\'deadlineAt\'')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('boundWait."targetTaskIds" = proof.value->\'sourceWait\'->\'targetTaskIds\'')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('boundWait."result"->\'sourceLifecycleRecovery\'')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain("CASE WHEN jsonb_typeof(boundWait.\"targetTaskIds\") = 'array'")
  })
})
