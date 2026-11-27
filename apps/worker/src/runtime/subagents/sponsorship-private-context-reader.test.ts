import { beforeEach, describe, expect, it, vi } from "vitest"
import { SPONSORSHIP_OBSERVATION_SCHEMA, sponsorshipRoleDigest, type SponsorshipObservation } from "./sponsorship-observation-contract.js"
import { readPrivateSponsorshipContext, type SponsorshipPrivateContextFence } from "./sponsorship-private-context-reader.js"
import { projectDurableWaitOutcome } from "./durable-wait-dependency-revalidation.js"
import { toRepositoryJson } from "../turns/turn-engine-types.js"

const harness = vi.hoisted(() => ({ lock: vi.fn(), load: vi.fn(), bind: vi.fn(), redact: vi.fn() }))
vi.mock("./task-graph-pg-state.js", () => ({ lockTaskGraphScope: harness.lock }))
vi.mock("./task-graph-pg-verification-receipts.js", () => ({ loadTaskGraphVerificationReceipts: harness.load }))
vi.mock("./sponsorship-observation-binder-core.js", () => ({
  readSponsorshipTaskObservationsWithClient: harness.bind,
  sponsorshipCandidateJobIds: (task: { result?: { structuredResult?: { candidates?: Array<{ jobId: string }> } } }) =>
    task.result?.structuredResult?.candidates?.map(candidate => candidate.jobId) ?? null,
}))
vi.mock("../tools/durable-wait-output-redaction.js", () => ({ redactDurableWaitOutput: harness.redact }))

const userId = "user-1", sessionId = "session-1", turnId = "turn-1", rootTaskId = "root-1"
const childId = "subagent-12345678-1234-4234-9234-123456789012", jobId = "c123456789012345678901234"
const child2Id = "subagent-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const jobId2 = "caaaaaaaaaaaaaaaaaaaaaaaa"
const waitId = "wait-12345678-1234-4234-9234-123456789012"
const fence: SponsorshipPrivateContextFence = { userId, sessionId, turnId, taskId: rootTaskId, rootTaskId,
  rootAttemptCount: 2, turnLeaseOwner: "worker-1", turnLeaseVersion: 7, stepId: "step-current" }
const role = "Backend Engineer"
const binding = { bindingDigest: `sha256:${"1".repeat(64)}`, sourceReceiptDigest: `sha256:${"2".repeat(64)}`,
  materialDigest: `sha256:${"3".repeat(64)}`, roleDigest: sponsorshipRoleDigest(role), targetCountryCode: null }
const observation: SponsorshipObservation = {
  schemaVersion: SPONSORSHIP_OBSERVATION_SCHEMA, status: "inconclusive", reason: "interpretation_unverified", binding,
  sourceContext: { source: "greenhouse", sourceUrl: "https://jobs.example", company: "Example Ltd", role,
    location: "Dublin", descriptionExcerpt: "Sponsorship may be considered.", descriptionExcerptStartByte: 0 },
}
const waitCall = { type: "tool_call", id: "wait-call-item", taskId: rootTaskId, stepId: "step-wait", attempt: 1, ordinal: 1, content: { toolCallId: "wait-call", toolName: "agent.wait", toolVersion: "1",
  status: "completed", errorCode: null, input: { idempotencyKey: "wait-key-1", taskIds: [childId], mode: "all", timeoutMs: 30_000 } } }
const waitResult = { type: "tool_result", id: "wait-result-item", taskId: rootTaskId, stepId: "step-wait", attempt: 1, ordinal: 1, content: { toolCallId: "wait-call", errorCode: null,
  output: { waitId, status: "ready", taskIds: [childId], deadlineAt: "2026-11-27T12:00:00.000Z",
    matchedTaskIds: [childId], tasks: [{ taskId: childId, status: "completed", role: "scout", result: {}, failureReason: null }] } } }
const child = { id: childId, userId, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId,
  role: "scout", taskType: "job_discovery", status: "completed", attemptCount: 1,
  context: {}, result: { status: "completed", structuredResult: { candidates: [{ jobId }] } } }

function runtime(options: { ordinal?: number; targetRows?: readonly unknown[]; waitRows?: readonly unknown[] } = {}) {
  const queries: string[] = [], values: unknown[][] = []
  const client = { query: vi.fn(async (sql: string, params?: unknown[]) => {
    queries.push(sql)
    values.push(params ?? [])
    if (sql.startsWith("BEGIN") || sql.includes("set_config") || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] }
    if (sql.includes('SELECT step."ordinal"')) return { rows: [{ ordinal: options.ordinal ?? 2, attempt: 1, taskId: rootTaskId, status: "streaming" }] }
    if (sql.includes('SELECT 1 FROM "agent_items"')) return { rows: [{ one: 1 }] }
    if (sql.includes('FROM "agent_wait_conditions" AS wait')) return { rows: options.waitRows ?? [] }
    if (sql.includes('FROM "sub_agent_tasks" AS task JOIN "agent_sessions"')) {
      const requestedIds = params?.[0] as readonly string[] | undefined
      return { rows: (options.targetRows ?? [child]).filter(value => requestedIds?.includes(String((value as { id?: unknown }).id))) }
    }
    throw new Error("unexpected private reader query")
  }), release: vi.fn() }
  return { queries, values, client, pool: { connect: vi.fn(async () => client) } }
}

function receipts(items: readonly unknown[] = [waitCall, waitResult], output: unknown = waitResult.content.output) {
  const rows = [...items]
  const result = rows.find(item => (item as { type?: unknown }).type === "tool_result") as typeof waitResult | undefined
  if (result) rows[rows.indexOf(result)] = { ...result, content: { ...result.content, output } }
  return { items: rows, outcomes: new Map([["wait-call", "completed"]]), replayReceipts: [], evidenceObservations: [] }
}

describe("private sponsorship context reader", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    harness.load.mockResolvedValue(receipts())
    harness.redact.mockImplementation((value: unknown) => value)
    harness.bind.mockResolvedValue([{ jobId, observation }])
  })

  it("rechecks a same-step Root wait under the exact owner and lease fence and emits untrusted model context only", async () => {
    const f = runtime()
    const result = await readPrivateSponsorshipContext(f.pool as never, fence)
    expect(harness.lock).toHaveBeenCalledWith(f.client, expect.objectContaining({ userId, sessionId, turnId, rootTaskId,
      parentTaskId: rootTaskId, turnLeaseOwner: fence.turnLeaseOwner, turnLeaseVersion: fence.turnLeaseVersion,
      parentLeaseOwner: fence.turnLeaseOwner, parentAttemptCount: fence.rootAttemptCount, stepId: fence.stepId }))
    expect(harness.load).toHaveBeenCalledWith(f.client, expect.objectContaining({ userId, sessionId, turnId,
      rootTaskId, parentTaskId: rootTaskId, taskId: rootTaskId, attemptCount: 1 }))
    expect(harness.bind).toHaveBeenCalledWith(f.client, expect.objectContaining({ id: childId, userId, sessionId, turnId,
      rootTaskId, parentTaskId: rootTaskId, attemptCount: 1 }))
    const rootWaitQuery = f.client.query.mock.calls.find(([sql]) => sql.includes('SELECT 1 FROM "agent_items"'))?.[0]
    expect(rootWaitQuery).toContain('task."parentTaskId" IS NULL')
    expect(result).toHaveLength(1)
    expect(result?.[0]).toMatchObject({ jobId, observation: { status: "inconclusive",
      sourceContext: { trustBoundary: "untrusted_saved_job_listing", descriptionExcerpt: "Sponsorship may be considered." } } })
    const frame = JSON.stringify(result?.[0]?.observation)
    expect(frame).not.toContain(jobId)
    expect(frame).not.toContain("bindingDigest")
    expect(frame).not.toContain("sourceReceiptDigest")
    expect(frame).not.toContain("materialDigest")
    expect(f.queries.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
    expect(f.client.release).toHaveBeenCalledOnce()
  })

  it("fails closed if the wait is not the immediate previous step or its returned IDs differ", async () => {
    const stale = runtime()
    harness.load.mockResolvedValueOnce(receipts([{ ...waitCall, ordinal: 0 }, { ...waitResult, ordinal: 0 }]))
    expect(await readPrivateSponsorshipContext(stale.pool as never, fence)).toBeUndefined()
    expect(harness.bind).not.toHaveBeenCalled()

    vi.clearAllMocks(); harness.load.mockResolvedValue(receipts()); harness.redact.mockImplementation((value: unknown) => value)
    const mismatch = runtime()
    const wrongTargets = { ...waitResult.content.output, taskIds: [child2Id], matchedTaskIds: [child2Id],
      tasks: [{ taskId: child2Id, status: "completed", role: "scout", result: {}, failureReason: null }] }
    harness.load.mockResolvedValueOnce(receipts([waitCall, waitResult], wrongTargets))
    expect(await readPrivateSponsorshipContext(mismatch.pool as never, fence)).toBeUndefined()
    expect(harness.bind).not.toHaveBeenCalled()
  })

  it("uses only validated matched targets for a ready any-wait and excludes later completions", async () => {
    const secondCall = { ...waitCall, content: { ...waitCall.content, input: { ...waitCall.content.input,
      taskIds: [childId, child2Id], mode: "any" } } }
    const output = { ...waitResult.content.output, taskIds: [childId, child2Id], matchedTaskIds: [childId], tasks: [
      { taskId: childId, status: "completed", role: "scout", result: {}, failureReason: null },
      { taskId: child2Id, status: "running", role: "scout", result: null, failureReason: null },
    ] }
    const f = runtime()
    harness.load.mockResolvedValueOnce(receipts([secondCall, waitResult], output))
    const result = await readPrivateSponsorshipContext(f.pool as never, fence)
    expect(result).toHaveLength(1)
    expect(harness.bind).toHaveBeenCalledOnce()
    expect(harness.bind.mock.calls[0]?.[1]).toMatchObject({ id: childId })
    expect(f.values.find((params, index) => f.queries[index]?.includes('FROM "sub_agent_tasks" AS task JOIN "agent_sessions"')))
      .toEqual([[childId], sessionId, turnId, rootTaskId, userId])
  })

  it("rebinds a consumed async any-wait to its exact original call, stored projection, and current matched child", async () => {
    const ids = [childId, child2Id]
    const waitingOutput = { ...waitResult.content.output, status: "waiting", taskIds: ids, matchedTaskIds: [], tasks: ids.map(taskId => ({
      taskId, status: "running", role: "scout", result: null, failureReason: null,
    })) }
    const asyncCall = { ...waitCall, content: { ...waitCall.content, input: { ...waitCall.content.input, taskIds: ids, mode: "any" } } }
    const asyncResult = { ...waitResult, content: { ...waitResult.content, output: waitingOutput } }
    const outcome = { waitId, status: "ready", targetTaskIds: ids, matchedTaskIds: [childId], tasks: [
      { taskId: childId, status: "completed", role: "scout", result: { rawSourceMaterial: "old result must not be injected" }, failureReason: null },
      { taskId: child2Id, status: "running", role: "scout", result: null, failureReason: null },
    ] }
    const waitRow = { waitId, userId, sessionId, turnId, parentTaskId: rootTaskId, stepId: "step-wait", idempotencyKey: "wait-key-1",
      targetTaskIds: ids, mode: "any", status: "ready", deadlineAt: new Date("2026-11-27T12:00:00.000Z"), matchedTaskIds: [childId],
      waitResult: { request: { targetTaskIds: ids, mode: "any", timeoutMs: 30_000 }, outcome },
      suspendedAt: new Date("2026-11-27T11:59:00.000Z"), consumedAt: new Date("2026-11-27T12:01:00.000Z"),
      stepOrdinal: 1, stepAttempt: 1, stepStatus: "waiting_for_tool" }
    const projection = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(outcome), taskIds: ids, mode: "any" })
    const laterCompletedChild = { ...child, id: child2Id, status: "completed" }
    const f = runtime({ targetRows: [child, laterCompletedChild], waitRows: [waitRow] })
    harness.load.mockResolvedValueOnce(receipts([asyncCall, asyncResult], waitingOutput))
    const result = await readPrivateSponsorshipContext(f.pool as never, fence, [projection])
    expect(result).toHaveLength(1)
    expect(harness.bind).toHaveBeenCalledOnce()
    expect(harness.bind.mock.calls[0]?.[1]).toMatchObject({ id: childId, status: "completed", role: "scout" })
    const waitQueryIndex = f.queries.findIndex(sql => sql.includes('FROM "agent_wait_conditions" AS wait'))
    expect(f.values[waitQueryIndex]).toEqual([waitId, userId, sessionId, turnId, rootTaskId, "wait-key-1", "any", 1, 1,
      fence.rootAttemptCount, fence.turnLeaseOwner, fence.turnLeaseVersion])
    expect(f.queries[waitQueryIndex]).toContain('wait."consumedAt" IS NOT NULL')
    expect(f.queries[waitQueryIndex]).toContain('step."status" = \'waiting_for_tool\'')
    expect(f.queries[waitQueryIndex]).toContain('root."parentTaskId" IS NULL')
    const childReadIndex = f.queries.findIndex(sql => sql.includes('FROM "sub_agent_tasks" AS task JOIN "agent_sessions"'))
    expect(f.values[childReadIndex]?.[0]).toEqual([childId])
    const privateObservation = JSON.stringify(result)
    expect(privateObservation).not.toContain("old result must not be injected")
    expect(privateObservation).not.toContain(waitId)
    expect(privateObservation).not.toContain("bindingDigest")
    expect(privateObservation).toContain("Sponsorship may be considered.")
    expect(f.queries.some(sql => /^\s*(INSERT|UPDATE|DELETE)\b/i.test(sql))).toBe(false)
  })

  it("accepts a consumed all-wait when the original waiting snapshot lags a matched child completion", async () => {
    const ids = [childId, child2Id]
    const initialResult = { structuredResult: { candidates: [{ jobId }] } }
    const secondResult = { structuredResult: { candidates: [{ jobId: jobId2 }] } }
    const waitingOutput = { ...waitResult.content.output, status: "waiting", taskIds: ids, matchedTaskIds: [childId], tasks: [
      // Root gathered these snapshots before the durable wait transaction saw childId complete.
      { taskId: childId, status: "running", role: "scout", result: null, failureReason: null },
      { taskId: child2Id, status: "running", role: "scout", result: null, failureReason: null },
    ] }
    const asyncCall = { ...waitCall, content: { ...waitCall.content, input: { ...waitCall.content.input, taskIds: ids, mode: "all" } } }
    const asyncResult = { ...waitResult, content: { ...waitResult.content, output: waitingOutput } }
    const outcome = { waitId, status: "ready", targetTaskIds: ids, matchedTaskIds: ids, tasks: [
      { taskId: childId, status: "completed", role: "scout", result: initialResult, failureReason: null,
        verificationReport: { verdict: "pass" } },
      { taskId: child2Id, status: "completed", role: "scout", result: secondResult, failureReason: null,
        repairReceipt: { status: "repaired" } },
    ] }
    const waitRow = { waitId, userId, sessionId, turnId, parentTaskId: rootTaskId, stepId: "step-wait", idempotencyKey: "wait-key-1",
      targetTaskIds: ids, mode: "all", status: "ready", deadlineAt: new Date("2026-11-27T12:00:00.000Z"), matchedTaskIds: ids,
      waitResult: { request: { targetTaskIds: ids, mode: "all", timeoutMs: 30_000 }, outcome },
      suspendedAt: new Date("2026-11-27T11:59:00.000Z"), consumedAt: new Date("2026-11-27T12:01:00.000Z"),
      stepOrdinal: 1, stepAttempt: 1, stepStatus: "waiting_for_tool" }
    const projection = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(outcome), taskIds: ids, mode: "all" })
    const currentChildren = [child, { ...child, id: child2Id, status: "completed", result: secondResult }]
    const f = runtime({ targetRows: currentChildren, waitRows: [waitRow] })
    harness.load.mockResolvedValueOnce(receipts([asyncCall, asyncResult], waitingOutput))
    let boundJob = 0
    harness.bind.mockImplementation(async () => [{ jobId: [jobId, jobId2][boundJob++]!, observation }])

    const result = await readPrivateSponsorshipContext(f.pool as never, fence, [projection])
    expect(result).toHaveLength(2)
    expect(result?.map(entry => entry.jobId)).toEqual([jobId, jobId2])
    expect(harness.bind.mock.calls.map(([, task]) => task.id)).toEqual(ids)
  })

  it("fails closed on async wait projection, identity, request, or terminal mismatches", async () => {
    const ids = [childId, child2Id], matched = [childId]
    const waitingOutput = { ...waitResult.content.output, status: "waiting", taskIds: ids, matchedTaskIds: [], tasks: ids.map(taskId => ({
      taskId, status: "running", role: "scout", result: null, failureReason: null,
    })) }
    const asyncCall = { ...waitCall, content: { ...waitCall.content, input: { ...waitCall.content.input, taskIds: ids, mode: "any" } } }
    const asyncResult = { ...waitResult, content: { ...waitResult.content, output: waitingOutput } }
    const outcome = { waitId, status: "ready", targetTaskIds: ids, matchedTaskIds: matched, tasks: [
      { taskId: childId, status: "completed", role: "scout", result: { stable: true }, failureReason: null,
        verificationReport: { verdict: "pass" } },
      { taskId: child2Id, status: "running", role: "scout", result: null, failureReason: null,
        repairReceipt: { status: "repaired" } },
    ] }
    const partialAllProjection = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(outcome), taskIds: ids, mode: "all" })
    const row = { waitId, userId, sessionId, turnId, parentTaskId: rootTaskId, stepId: "step-wait", idempotencyKey: "wait-key-1",
      targetTaskIds: ids, mode: "any", status: "ready", deadlineAt: new Date("2026-11-27T12:00:00.000Z"), matchedTaskIds: matched,
      waitResult: { request: { targetTaskIds: ids, mode: "any", timeoutMs: 30_000 }, outcome }, suspendedAt: new Date(), consumedAt: new Date(),
      stepOrdinal: 1, stepAttempt: 1, stepStatus: "waiting_for_tool" }
    const projection = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(outcome), taskIds: ids, mode: "any" })
    const projectionContent = projection.content as Record<string, unknown>
    const projectionOutput = projectionContent.output as Record<string, unknown>
    const projectedTasks = projectionOutput.tasks as Array<Record<string, unknown>>
    const scenarios = [
      { label: "wrong projection identity", row, projection: { ...projection, id: "wait-result:foreign" }, receiptOutput: waitingOutput },
      { label: "wrong projected source call", row, projection: { ...projection, content: { ...projectionContent, toolCallId: "wait-call" } }, receiptOutput: waitingOutput },
      { label: "missing projection", row, projection: null, receiptOutput: waitingOutput },
      { label: "wrong projected targets", row, projection: { ...projection, content: { ...projectionContent, input: { taskIds: [childId], mode: "any" } } }, receiptOutput: waitingOutput },
      { label: "wrong projected result", row, projection: { ...projection, content: { ...projectionContent, output: { ...projectionOutput,
        tasks: [{ ...projectedTasks[0], result: { stable: false } }, projectedTasks[1]] } } }, receiptOutput: waitingOutput },
      { label: "wrong projected failure reason", row, projection: { ...projection, content: { ...projectionContent, output: { ...projectionOutput,
        tasks: [{ ...projectedTasks[0], failureReason: "stale" }, projectedTasks[1]] } } }, receiptOutput: waitingOutput },
      { label: "wrong projected verification report", row, projection: { ...projection, content: { ...projectionContent, output: { ...projectionOutput,
        tasks: [{ ...projectedTasks[0], verificationReport: { verdict: "fail" } }, projectedTasks[1]] } } }, receiptOutput: waitingOutput },
      { label: "wrong projected repair receipt", row, projection: { ...projection, content: { ...projectionContent, output: { ...projectionOutput,
        tasks: [projectedTasks[0], { ...projectedTasks[1], repairReceipt: { status: "rejected" } }] } } }, receiptOutput: waitingOutput },
      { label: "wrong wait id", row: { ...row, waitId: "wait-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, projection, receiptOutput: waitingOutput },
      { label: "wrong idempotency", row: { ...row, idempotencyKey: "another-wait" }, projection, receiptOutput: waitingOutput },
      { label: "wrong mode", row: { ...row, mode: "all" }, projection, receiptOutput: waitingOutput },
      { label: "wrong target set", row: { ...row, targetTaskIds: [childId] }, projection, receiptOutput: waitingOutput },
      { label: "wrong request timeout", row: { ...row, waitResult: { ...row.waitResult, request: { ...row.waitResult.request, timeoutMs: 29_999 } } }, projection, receiptOutput: waitingOutput },
      { label: "non-numeric request timeout", row: { ...row, waitResult: { ...row.waitResult, request: { ...row.waitResult.request, timeoutMs: "30000" } } }, projection, receiptOutput: waitingOutput },
      { label: "wrong previous step", row: { ...row, stepOrdinal: 0 }, projection, receiptOutput: waitingOutput },
      { label: "wrong root attempt", row: { ...row, stepAttempt: 2 }, projection, receiptOutput: waitingOutput },
      { label: "unsuspended", row: { ...row, suspendedAt: null }, projection, receiptOutput: waitingOutput },
      { label: "unconsumed", row: { ...row, consumedAt: null }, projection, receiptOutput: waitingOutput },
      { label: "missing matched target", row: { ...row, matchedTaskIds: [] }, projection, receiptOutput: waitingOutput },
      { label: "partial all wait", row: { ...row, mode: "all", waitResult: { request: { ...row.waitResult.request, mode: "all" }, outcome } }, projection: partialAllProjection, receiptOutput: waitingOutput },
      { label: "matched nonterminal", row: { ...row, waitResult: { ...row.waitResult, outcome: { ...outcome, tasks: [
        { ...outcome.tasks[0], status: "running" }, outcome.tasks[1],
      ] } } }, projection, receiptOutput: waitingOutput },
      { label: "wrong original wait id", row, projection, receiptOutput: { ...waitingOutput, waitId: "wait-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
      { label: "current child changed", row, projection, receiptOutput: waitingOutput, children: [{ ...child, status: "running" }] },
    ]
    for (const scenario of scenarios) {
      vi.clearAllMocks(); harness.load.mockResolvedValue(receipts([asyncCall, asyncResult], scenario.receiptOutput))
      harness.redact.mockImplementation((value: unknown) => value); harness.bind.mockResolvedValue([{ jobId, observation }])
      const f = runtime({ waitRows: [scenario.row], targetRows: scenario.children ?? [child] })
      const actual = await readPrivateSponsorshipContext(f.pool as never, fence, scenario.projection ? [scenario.projection] : [])
      expect(actual, scenario.label).toBeUndefined()
      expect(harness.bind, scenario.label).not.toHaveBeenCalled()
    }
  })

  it("rejects ready waits whose mode, matched set, and terminal task snapshots disagree", async () => {
    const secondCall = { ...waitCall, content: { ...waitCall.content, input: { ...waitCall.content.input,
      taskIds: [childId, child2Id], mode: "all" } } }
    const f = runtime()
    const partialAllOutput = { ...waitResult.content.output, taskIds: [childId, child2Id], matchedTaskIds: [childId], tasks: [
      { taskId: childId, status: "completed", role: "scout", result: {}, failureReason: null },
      { taskId: child2Id, status: "running", role: "scout", result: null, failureReason: null },
    ] }
    harness.load.mockResolvedValueOnce(receipts([secondCall, waitResult], partialAllOutput))
    expect(await readPrivateSponsorshipContext(f.pool as never, fence)).toBeUndefined()
    expect(harness.bind).not.toHaveBeenCalled()

    vi.clearAllMocks(); harness.load.mockResolvedValue(receipts()); harness.redact.mockImplementation((value: unknown) => value)
    const terminalMismatch = runtime()
    const wrongTaskStatus = { ...waitResult.content.output, tasks: [{ ...waitResult.content.output.tasks[0], status: "running" }] }
    harness.load.mockResolvedValueOnce(receipts([waitCall, waitResult], wrongTaskStatus))
    expect(await readPrivateSponsorshipContext(terminalMismatch.pool as never, fence)).toBeUndefined()
    expect(harness.bind).not.toHaveBeenCalled()
  })

  it("rejects duplicate, foreign, or failed child/source receipts without breaking the caller", async () => {
    const duplicateWait = runtime()
    harness.load.mockResolvedValueOnce(receipts([waitCall, waitResult, { ...waitCall, content: { ...waitCall.content, toolCallId: "wait-call-2" } }]))
    expect(await readPrivateSponsorshipContext(duplicateWait.pool as never, fence)).toBeUndefined()

    vi.clearAllMocks(); harness.load.mockResolvedValue(receipts()); harness.redact.mockImplementation((value: unknown) => value)
    const foreignChild = runtime({ targetRows: [{ ...child, userId: "other-user" }] })
    expect(await readPrivateSponsorshipContext(foreignChild.pool as never, fence)).toBeUndefined()
    expect(harness.bind).not.toHaveBeenCalled()

    vi.clearAllMocks(); harness.load.mockResolvedValue(receipts()); harness.redact.mockImplementation((value: unknown) => value)
    harness.bind.mockRejectedValueOnce(new Error("private database detail"))
    const failedSource = runtime()
    await expect(readPrivateSponsorshipContext(failedSource.pool as never, fence)).resolves.toBeUndefined()
    expect(failedSource.client.query).toHaveBeenCalledWith("ROLLBACK")
    expect(JSON.stringify(failedSource.queries)).not.toContain("private database detail")
  })

  it("rejects malformed Root identity before opening a connection", async () => {
    const f = runtime()
    expect(await readPrivateSponsorshipContext(f.pool as never, { ...fence, taskId: "child-task" })).toBeUndefined()
    expect(f.pool.connect).not.toHaveBeenCalled()
  })
})
