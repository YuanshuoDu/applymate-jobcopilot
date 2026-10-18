import { describe, expect, it } from "vitest"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_TEMPLATES } from "../subagents/task-graph-templates.js"
import type { LoadedGraph, GraphTaskRow } from "../subagents/task-graph-pg-state.js"
import { taskGraphLifecycleKey, parseTaskGraphSnapshot, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphState } from "../subagents/task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "../subagents/role-results.js"
import type { RootTaskHistoryCandidate } from "./root-task-history-source-store.js"
import { projectHistoricalDiscoveryPage, selectHistoricalScoutSource, type HistoricalDiscoveryBinding } from "./root-task-history-result-page-selection.js"

const ROOT = "current-root", NODE = "scout-node", TASK = "scout-task"
const JOB_IDS = Array.from({ length: 30 }, (_, index) => `c${String(index).padStart(24, "0")}`)
const source: RootTaskHistoryCandidate = { sessionId: "old-session", turnId: "old-turn", rootTaskId: "old-root", terminalSequence: 42n,
  terminalAt: new Date("2026-10-10T10:00:00.000Z") }
const binding: HistoricalDiscoveryBinding = { userId: "user", sessionId: "current-session", turnId: "current-turn", rootTaskId: ROOT,
  turnLeaseOwner: "turn-owner", turnLeaseVersion: 3, parentLeaseOwner: "root-owner", parentAttemptCount: 4, objectiveDigest: "d".repeat(64) }
const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] } as const
const registeredScoutEnvelope = { role: TASK_GRAPH_TEMPLATES.scout.role, taskType: TASK_GRAPH_TEMPLATES.scout.taskType,
  expectedOutputSchema: TASK_GRAPH_TEMPLATES.scout.expectedOutputSchema, allowedActions: [...TASK_GRAPH_TEMPLATES.scout.allowedActions] }

function node(key: string, taskId: string, overrides: Record<string, unknown> = {}) {
  return { key, taskId, templateId: "scout", goal: "Find matching jobs", successCriteria: ["Find jobs for this search"], dependsOn: [], depth: 1,
    verificationDisposition: "typed", verification, registeredScoutEnvelope, ...overrides }
}

function roleResult(jobIds: readonly string[], status: "completed" | "partial" = "completed") {
  const evidence = [...new Set(jobIds)].map(jobId => ({ id: `e-${jobId}`, kind: "job", ref: jobId, source: "greenhouse" }))
  return { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status, summary: "advisory result",
    candidates: jobIds.map(jobId => ({ jobId, source: "greenhouse", url: null, evidenceIds: [`e-${jobId}`] })), evidence }
}

function loadedGraph(options: { nodes?: readonly Record<string, unknown>[]; taskResults?: ReadonlyMap<string, unknown>; statuses?: ReadonlyMap<string, "completed" | "failed">;
  attempts?: ReadonlyMap<string, number>; receipts?: readonly { nodeKey: string; attempt: number; type: "task.started" | "task.completed" }[] } = {}) {
  const definitions = options.nodes ?? [node(NODE, TASK)]
  const snapshot = parseTaskGraphSnapshot({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: definitions })
  const tasks = new Map<string, GraphTaskRow>()
  for (const stored of snapshot.nodes) {
    const status = options.statuses?.get(stored.taskId) ?? "completed"
    const result = options.taskResults?.get(stored.taskId) ?? { structuredResult: roleResult(JOB_IDS.slice(0, 3)) }
    tasks.set(stored.taskId, { id: stored.taskId, status, role: "scout", taskType: "job_discovery",
      expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }, failureReason: null, result })
  }
  const receipts = options.receipts ?? snapshot.nodes.flatMap(stored => [
    { nodeKey: stored.key, attempt: 2, type: "task.started" as const },
    { nodeKey: stored.key, attempt: 2, type: "task.completed" as const },
  ])
  const events = receipts.map(({ nodeKey, attempt, type }) => ({ nodeKey, type,
    idempotencyKey: taskGraphLifecycleKey(ROOT, nodeKey, attempt, type), expectedRevision: 1 }))
  const statuses = new Map([...tasks].map(([id, task]) => [id, { status: task.status, failureReason: task.failureReason }] as const))
  const state = taskGraphState(snapshot, 7, statuses, events)
  const loaded: LoadedGraph = { rootTaskId: ROOT, snapshot, state, tasks,
    item: { id: "private-graph-item", revision: 7, content: snapshot, createdAt: new Date(0) } }
  return { loaded, attempts: options.attempts ?? new Map(snapshot.nodes.map(stored => [stored.taskId, 2])) }
}

describe("historical Scout discovery page selection", () => {
  it("selects a nonempty lexical ordinary Scout and returns only bounded, token-pinned IDs", () => {
    const test = loadedGraph({ nodes: [node("z-scout", "z-task"), node("a-empty", "empty-task")],
      taskResults: new Map([["z-task", { structuredResult: roleResult([...JOB_IDS, JOB_IDS[0]!], "partial") }],
        ["empty-task", { structuredResult: roleResult([]) }]]) })
    const selected = selectHistoricalScoutSource({ source, loaded: test.loaded, attemptCounts: test.attempts })
    expect(selected).toMatchObject({ nodeKey: "z-scout", taskId: "z-task", resultStatus: "partial", truncated: true })
    expect(selected?.jobIds).toEqual(JOB_IDS.slice(0, 24))
    const first = projectHistoricalDiscoveryPage(selected!, binding, { mode: "historical_discovery", offset: 0 })
    expect(first).toMatchObject({ availability: "available", observation: "historical_discovery", verificationStatus: "unverified",
      totalCount: 24, truncated: true, sourceResultStatus: "partial", offset: 0, nextOffset: 3,
      items: JOB_IDS.slice(0, 3).map(jobId => ({ jobId })) })
    if (first.availability !== "available") throw new Error("page_unavailable")
    const continuation = projectHistoricalDiscoveryPage(selected!, binding, { mode: "historical_discovery", offset: 3, sourceToken: first.sourceToken })
    expect(continuation).toMatchObject({ availability: "available", sourceToken: first.sourceToken, offset: 3, nextOffset: 6,
      items: JOB_IDS.slice(3, 6).map(jobId => ({ jobId })) })
    expect(JSON.stringify(first)).not.toMatch(/private-graph-item|old-root|greenhouse|advisory result/)
  })

  it("pins initial tokens when supplied, rejects changed sources and out-of-range offsets", () => {
    const loaded = loadedGraph()
    const selected = selectHistoricalScoutSource({ source, loaded: loaded.loaded, attemptCounts: loaded.attempts })!
    const initial = projectHistoricalDiscoveryPage(selected, binding, { mode: "historical_discovery", offset: 0 })
    if (initial.availability !== "available") throw new Error("page_unavailable")
    expect(projectHistoricalDiscoveryPage(selected, binding, { mode: "historical_discovery", offset: 0, sourceToken: initial.sourceToken }))
      .toEqual(initial)
    expect(projectHistoricalDiscoveryPage(selected, { ...binding, parentAttemptCount: 5 }, { mode: "historical_discovery", offset: 0, sourceToken: initial.sourceToken }))
      .toMatchObject({ availability: "unavailable", reason: "source_changed" })
    expect(projectHistoricalDiscoveryPage(selected, binding, { mode: "historical_discovery", offset: 3, sourceToken: initial.sourceToken }))
      .toMatchObject({ availability: "unavailable", reason: "offset_out_of_range" })
    expect(projectHistoricalDiscoveryPage(selected, binding, { mode: "historical_discovery", offset: 1 }))
      .toMatchObject({ availability: "unavailable", reason: "no_source" })
  })

  it("requires a persisted completion receipt for the current attempt and a valid canonical result", () => {
    const stale = loadedGraph({ attempts: new Map([[TASK, 3]]) })
    expect(selectHistoricalScoutSource({ source, loaded: stale.loaded, attemptCounts: stale.attempts })).toBeUndefined()
    const missingStart = loadedGraph({ receipts: [{ nodeKey: NODE, attempt: 2, type: "task.completed" }] })
    expect(selectHistoricalScoutSource({ source, loaded: missingStart.loaded, attemptCounts: missingStart.attempts })).toBeUndefined()
    const failed = loadedGraph({ statuses: new Map([[TASK, "failed"]]) })
    expect(selectHistoricalScoutSource({ source, loaded: failed.loaded, attemptCounts: failed.attempts })).toBeUndefined()
    const malformed = loadedGraph({ taskResults: new Map([[TASK, { structuredResult: roleResult(["not-a-canonical-id"]) }]]) })
    expect(selectHistoricalScoutSource({ source, loaded: malformed.loaded, attemptCounts: malformed.attempts })).toBeUndefined()
  })

  it("rejects oversized whole persisted result envelopes before parsing or traversing their payload", () => {
    const oversizedObject = loadedGraph({ taskResults: new Map([[TASK, {
      finalText: "private".repeat(50_000), structuredResult: roleResult([JOB_IDS[0]!]),
    }]]) })
    expect(selectHistoricalScoutSource({ source, loaded: oversizedObject.loaded, attemptCounts: oversizedObject.attempts })).toBeUndefined()
    const oversizedString = loadedGraph({ taskResults: new Map([[TASK, `${JSON.stringify({ structuredResult: roleResult([JOB_IDS[0]!]) })}${"x".repeat(256 * 1024)}`]]) })
    expect(selectHistoricalScoutSource({ source, loaded: oversizedString.loaded, attemptCounts: oversizedString.attempts })).toBeUndefined()
  })

  it("skips failed repair work and nodes without the registered ordinary Scout envelope", () => {
    const repairOf = { graphRootTaskId: ROOT, nodeKey: "base", taskId: "base-task", criterionIds: ["candidate-count"] }
    const repaired = loadedGraph({ nodes: [node("base", "base-task"), node("repair", "repair-task", { repairOf })],
      statuses: new Map([["base-task", "failed"], ["repair-task", "completed"]]),
      taskResults: new Map([["base-task", { structuredResult: roleResult([JOB_IDS[0]!]) }], ["repair-task", { structuredResult: roleResult([JOB_IDS[1]!]) }]]),
      receipts: [{ nodeKey: "base", attempt: 2, type: "task.started" }, { nodeKey: "base", attempt: 2, type: "task.completed" },
        { nodeKey: "repair", attempt: 2, type: "task.started" }, { nodeKey: "repair", attempt: 2, type: "task.completed" }] })
    expect(selectHistoricalScoutSource({ source, loaded: repaired.loaded, attemptCounts: repaired.attempts })).toBeUndefined()
    const wrongEnvelope = loadedGraph({ nodes: [node(NODE, TASK, { registeredScoutEnvelope: {
      ...registeredScoutEnvelope, allowedActions: ["jobs.get"],
    } })] })
    expect(selectHistoricalScoutSource({ source, loaded: wrongEnvelope.loaded, attemptCounts: wrongEnvelope.attempts })).toBeUndefined()
  })
})
