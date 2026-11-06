import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ inspect: vi.fn(), chain: vi.fn(), prefix: vi.fn() }))
vi.mock("./child-resume-source-wait-lifecycle.js", () => ({ inspectChildWaitSourceLifecycle: mocks.inspect }))
vi.mock("./pg-store-expiry-step-tool-chain-proof.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pg-store-expiry-step-tool-chain-proof.js")>()
  return { ...actual, readCanonicalWaitStepToolChain: mocks.chain }
})
vi.mock("./pg-store-expiry-historical-source-step-prefix.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./pg-store-expiry-historical-source-step-prefix.js")>()
  return { ...actual, readCanonicalHistoricalSourceStepPrefix: mocks.prefix }
})

import { safeSubagentWaitJson } from "./durable-subagent-wait-store.js"
import { MAX_HISTORICAL_SOURCE_WAITS, readChildWaitTerminalCallProjections } from "./pg-store-expiry-historical-wait-projections.js"
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
    result: { request: { targetTaskIds: taskIds, mode: "any", timeoutMs: 100 }, outcome,
      sourceLifecycleRecovery: { resultItemId: `source-result-${index}` } } }
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

function client(rows: Record<string, unknown>[], claims: ReturnType<typeof completedClaim>[] = []) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql.includes("SELECT wait.*")) return { rows }
    if (sql.includes("FROM unnest($1::text[])")) return { rows: (values[0] as string[]).map(id => ({ id })) }
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
  mocks.inspect.mockImplementation(async (...args: unknown[]) => {
    const row = args.find(value => !!value && typeof value === "object" && "sourceCallId" in value) as Record<string, unknown> | undefined
    return { state: "recovered", toolCallId: row?.sourceCallId, callItemId: row?.sourceCallItemId, sourceAttempt: 1,
      resultItemId: `source-result:${String(row?.sourceCallId).replace("source-call-", "")}` }
  })
  mocks.chain.mockImplementation(async (_client, _scope, input: { stepId: string }) => ({
    stepId: input.stepId, stepCompletedEventId: `step-done:${input.stepId}`, nextEventId: `step-done:${input.stepId}`,
  }))
  mocks.prefix.mockImplementation(async (_client: unknown, _scope: unknown, input: { stepId: string; attempt: number;
    callItemId: string; callId: string; resultItemId: string; waitKind: string }) => ({
    stepId: input.stepId, attempt: input.attempt, sourceCallItemId: input.callItemId, sourceCallId: input.callId,
    sourceResultItemId: input.resultItemId, waitKind: input.waitKind, stepStartedEventId: `step-start:${input.stepId}`,
    stepCompletedEventId: `step-done:${input.stepId}`, events: [], items: [],
  }))
})

describe("bounded historical wait projections", () => {
  it("projects two exact source waits and their independent completed claims", async () => {
    const sources = [wait(1), wait(2)], claims = sources.map((source, index) => completedClaim(source, index + 1))
    const db = client(sources, claims)
    const projections = await readChildWaitTerminalCallProjections(db as never, task)
    const completed = projections.filter(row => row.resultItemId)
    expect(completed.map(row => [row.sourceWait.waitId, row.callItemId, row.sourceWait.claimKeyDigest !== null])).toEqual([
      ["wait-1", "task:owner:item:tool-call:claim-call-1:attempt:3", true],
      ["wait-2", "task:owner:item:tool-call:claim-call-2:attempt:3", true],
    ])
    expect(projections.filter(row => !row.resultItemId).map(row => row.sourceWait.waitId)).toEqual(["wait-1", "wait-2"])
    expect(completed.every(row => row.sourceStepPrefix?.waitKind === "recovered")).toBe(true)
    expect(mocks.prefix).toHaveBeenCalledTimes(2)
    expect(db.query.mock.calls[0]?.[0]).toContain('owner."sessionId" = $2')
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

  it("revalidates the same historical receipt and current owner fence in final SQL", () => {
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('boundWait."id" = proof.value->\'sourceWait\'->>\'waitId\'')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('owner."leaseOwner" = $5')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('boundWait."result"->\'outcome\'->>\'deadlineAt\'')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('boundWait."targetTaskIds" = proof.value->\'sourceWait\'->\'targetTaskIds\'')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain('boundWait."result"->\'sourceLifecycleRecovery\'')
    expect(CHILD_WAIT_HISTORICAL_WAIT_BINDING_SQL).toContain("CASE WHEN jsonb_typeof(boundWait.\"targetTaskIds\") = 'array'")
  })
})
