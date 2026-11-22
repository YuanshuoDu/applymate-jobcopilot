import { createHash } from "node:crypto"
import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { loadVerifiedPriorScoutDiscoveryReceipts } from "./task-graph-pg-verified-scout-history.js"
import type { TaskGraphVerificationScope } from "./task-graph-pg-verification-receipt-validation.js"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"

const scope: TaskGraphVerificationScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  parentTaskId: "root-1", taskId: "scout-1", attemptCount: 3,
}
const node = { key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: [], dependsOn: [], depth: 1,
  taskId: scope.taskId, verificationDisposition: "typed", verification: { role: "scout" } } as unknown as StoredTaskGraphNode
const task = { role: "scout", taskType: "job_discovery", context: {}, allowedActions: ["jobs.discover", "tool_results.read"] }
const jobId = `c${"a".repeat(24)}`
const jobUrl = `https://jobs.example.test/${jobId}`
const rawDiscovery = {
  jobs: [{ id: jobId, title: "Engineer", company: "Example", location: "Dublin", url: jobUrl, description: "", fullDescription: "",
    salary: null, logo: null, source: "greenhouse", evidenceRefs: ["source-ref"] }],
  evidence: [{ evidenceId: "source-ref", jobId, kind: "source", source: "greenhouse", url: jobUrl, summary: "Listing" }],
  nextCursor: null,
  usage: { toolName: "jobs.discover", toolVersion: "1", requests: 1, jobsProcessed: 1, jobsSucceeded: 1,
    jobsFailed: 0, aiCalls: 0, providers: ["fixture"], estimatedCostUsd: 0, durationMs: 1 },
}
const rawBytes = Buffer.from(JSON.stringify(rawDiscovery), "utf8")
const reference = { $ref: "tool-result-00000000-0000-4000-8000-000000000001", sizeBytes: rawBytes.length,
  sha256: createHash("sha256").update(rawBytes).digest("hex") }
const chunk = { ref: reference.$ref, sha256: reference.sha256, byteCount: reference.sizeBytes,
  chunk: rawBytes.toString("utf8"), nextCursor: null }

function pair(attempt: number, ordinal: number, toolName: string, input: unknown, output: unknown) {
  const callId = `call-${attempt}-${ordinal}`, stepId = `step-${attempt}-${ordinal}`, callItemId = `${callId}-item`
  const common = { sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.taskId, stepId, joinedStepId: stepId,
    rootTaskId: scope.rootTaskId, turnRootTaskId: scope.rootTaskId, stepStatus: "completed", attempt, ordinal }
  const call = { ...common, id: callItemId, type: "tool_call", status: "completed", revision: 2,
    content: { toolCallId: callId, toolName, toolVersion: "1", input, status: "completed", errorCode: null } }
  const result = { ...common, id: `${callId}-result`, type: "tool_result", status: "completed", revision: 1,
    content: { toolCallId: callId, output, errorCode: null } }
  const eventCommon = { itemId: callItemId, taskId: scope.taskId, correlationId: callId }
  const events = [
    { id: `${callId}-started`, ...eventCommon, type: "tool_call.started", sequence: ordinal * 2 + 1,
      payload: { taskId: scope.taskId, toolCallId: callId, toolName } },
    { id: `${callId}-completed`, ...eventCommon, type: "tool_call.completed", sequence: ordinal * 2 + 2,
      payload: { taskId: scope.taskId, toolCallId: callId, toolName, status: "completed", errorCode: null } },
  ]
  return { items: [call, result], events }
}

function history(attempt: number, incomplete = false) {
  const pairs = incomplete
    ? [pair(attempt, 0, "jobs.search", {}, { jobs: [{ id: jobId, source: "greenhouse" }] })]
    : [pair(attempt, 0, "jobs.search", {}, { jobs: [{ id: jobId, source: "greenhouse" }] }),
      pair(attempt, 1, "jobs.discover", {}, reference),
      pair(attempt, 2, "tool_results.read", { referenceId: reference.$ref }, chunk)]
  return { items: pairs.flatMap(value => value.items), events: pairs.flatMap(value => value.events) }
}

function fakeClient(options: { candidateAttempt: number; candidateCount?: number; currentReceipt?: boolean; historyByAttempt?: Record<number, ReturnType<typeof history>> }) {
  const selected = options.historyByAttempt ?? { [options.candidateAttempt]: history(options.candidateAttempt) }
  const allItems = Object.values(selected).flatMap(value => value.items)
  const allEvents = Object.values(selected).flatMap(value => value.events)
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("WITH task_attempt_steps AS")) return { rows: [], rowCount: 0 }
    if (sql.includes('LEFT JOIN "agent_steps" AS step')) return { rows: [], rowCount: 0 }
    if (sql.includes('COUNT(item."id")::int AS "itemCount"')) return { rows: [{ attempt: options.candidateAttempt,
      itemCount: options.candidateCount ?? selected[options.candidateAttempt]?.items.length ?? 0 }], rowCount: 1 }
    if (sql.startsWith('SELECT item."id" FROM "agent_steps" AS step')) return {
      rows: options.currentReceipt ? [{ id: "current-call" }] : [], rowCount: options.currentReceipt ? 1 : 0,
    }
    if (sql.startsWith('SELECT item."id", item."sessionId"')) {
      const attempt = Number(values?.[6]), rows = allItems.filter(item => item.attempt === attempt)
      return { rows, rowCount: rows.length }
    }
    if (sql.startsWith('SELECT event."id", event."itemId"')) {
      const itemIds = Array.isArray(values?.[3]) ? values![3] as string[] : []
      const rows = allEvents.filter(event => itemIds.includes(String(event.itemId)))
      return { rows, rowCount: rows.length }
    }
    throw new Error("unexpected_history_query")
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query }
}

describe("verified prior Scout discovery receipts", () => {
  it("hydrates only the original complete discovery/read group from the newest prior attempt", async () => {
    const old = history(1), data = fakeClient({ candidateAttempt: 1, historyByAttempt: { 1: old } })
    const result = await loadVerifiedPriorScoutDiscoveryReceipts(data.client, scope, node, task)
    expect(result?.items.map(item => (item.content as Record<string, unknown>).toolCallId)).toEqual([
      "call-1-1", "call-1-1", "call-1-2", "call-1-2",
    ])
    expect(result?.items.every(item => item.attempt === 1)).toBe(true)
    expect(result?.evidenceObservations.map(item => item.content.toolName)).toEqual(["jobs.discover", "tool_results.read"])
    expect(result?.replayReceipts).toEqual([])
    const selection = data.query.mock.calls.find(([sql]) => sql.includes('COUNT(item."id")::int AS "itemCount"'))
    expect(selection?.[0]).toContain('step."attempt" < $7')
    expect(selection?.[0]).not.toContain('item."taskId"')
    expect(selection?.[0]).not.toContain('item."status"')
    expect(selection?.[1]).toEqual([scope.taskId, scope.sessionId, scope.turnId, scope.rootTaskId, scope.parentTaskId, scope.userId, 3])
  })

  it("does not skip an incomplete newest receipt attempt to use older discovery history", async () => {
    const data = fakeClient({ candidateAttempt: 2, historyByAttempt: { 1: history(1), 2: history(2, true) } })
    await expect(loadVerifiedPriorScoutDiscoveryReceipts(data.client, scope, node, task)).resolves.toBeUndefined()
    const loaded = data.query.mock.calls.filter(([sql]) => sql.startsWith('SELECT item."id", item."sessionId"'))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.[1]?.[6]).toBe(2)
  })

  it("rejects a misbound sibling receipt included in the selected Step count", async () => {
    const data = fakeClient({ candidateAttempt: 1, candidateCount: 7, historyByAttempt: { 1: history(1) } })
    await expect(loadVerifiedPriorScoutDiscoveryReceipts(data.client, scope, node, task))
      .rejects.toThrow("task_graph_verification_item_invalid")
  })

  it("fails closed for a nonordinary Scout or any current-attempt tool receipt", async () => {
    const specialized = fakeClient({ candidateAttempt: 1, historyByAttempt: { 1: history(1) } })
    await expect(loadVerifiedPriorScoutDiscoveryReceipts(specialized.client, scope, node,
      { ...task, context: { selectedJobPreparation: { jobId: jobId } } })).resolves.toBeUndefined()
    expect(specialized.query.mock.calls.some(([sql]) => sql.includes('COUNT(item."id")::int'))).toBe(false)

    const current = fakeClient({ candidateAttempt: 1, currentReceipt: true, historyByAttempt: { 1: history(1) } })
    await expect(loadVerifiedPriorScoutDiscoveryReceipts(current.client, scope, node, task)).resolves.toBeUndefined()
    expect(current.query.mock.calls.some(([sql]) => sql.includes('COUNT(item."id")::int'))).toBe(false)
  })
})
