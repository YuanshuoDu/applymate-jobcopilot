import { describe, expect, it, vi } from "vitest"
import type { Queryable } from "./pg-store-persistence.js"
import type { SubagentLease } from "./types.js"
import {
  composeDiscoveryAttemptObservers, createChildDiscoveryObservers, readRegisteredOrdinaryScoutProvenance,
} from "./child-discovery-observers.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { DiscoveryAttemptLifecycleEvent } from "../tools/lifecycle.js"

const actions = ["jobs.search", "jobs.get", "jobs.discover", "tool_results.read"]
const schema = { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" }
const verification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
}
const envelope = { role: "scout", taskType: "job_discovery", expectedOutputSchema: schema, allowedActions: actions }
const lease = (overrides: Record<string, unknown> = {}) => ({
  id: "task-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  role: "scout", taskType: "job_discovery", status: "running", allowedActions: actions, expectedOutputSchema: schema, context: {},
  attemptCount: 2, leaseOwner: "worker-1", ownerId: "worker-1", leaseExpiresAt: new Date(Date.now() + 60_000), interruptRequestedAt: null,
  ...overrides,
}) as SubagentLease
function scoutNode(overrides: Record<string, unknown> = {}) {
  return {
    key: "scout-node", templateId: "scout", goal: "Find roles", successCriteria: ["Return sourced jobs"], dependsOn: [], depth: 1,
    taskId: "task-1", verification, verificationDisposition: "typed", registeredScoutEnvelope: envelope, ...overrides,
  }
}
function snapshot(nodes: readonly Record<string, unknown>[] = [scoutNode()]) {
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes }
}
function dbRow(overrides: Record<string, unknown> = {}) {
  return { turnStatus: "in_progress", revision: 3, content: snapshot(), role: "scout", taskType: "job_discovery", allowedActions: actions,
    expectedOutputSchema: schema, context: {}, ...overrides }
}
function client(rows: readonly unknown[] = [dbRow()]): Queryable {
  return { query: vi.fn(async () => ({ rows })) } as unknown as Queryable
}
function tenantPool(rows: readonly unknown[] = [dbRow()], failProvenance = false) {
  const statements: string[] = []
  const parameters: Array<readonly unknown[] | undefined> = []
  const query = vi.fn(async (sql: string, values?: readonly unknown[]) => {
    statements.push(sql)
    parameters.push(values)
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql === "SELECT set_config($1, $2, true)") return { rows: [] }
    if (failProvenance) throw new Error("database unavailable")
    return { rows }
  })
  const release = vi.fn()
  const connection = { query, release }
  return { pool: { connect: vi.fn(async () => connection) } as never, statements, parameters, query, release }
}
const fence = { taskId: "task-1", rootTaskId: "root-1", sessionId: "session-1", turnId: "turn-1", attemptCount: 2 }
const lifecycleCall = { id: "discover-1", toolName: "jobs.discover", toolVersion: "1", sessionId: "session-1", turnId: "turn-1",
  stepId: "step-1", taskId: "task-1", rootTaskId: "root-1" }
const emptyReceipt = {
  jobs: [], evidence: [], nextCursor: null,
  usage: { ledgerKey: "ledger", toolName: "jobs.discover", toolVersion: "1", toolCallId: "discover-1", sessionId: "session-1",
    turnId: "turn-1", stepId: "step-1", requests: 1, jobsProcessed: 0, jobsSucceeded: 0, jobsFailed: 0,
    aiCalls: 0, providers: [], estimatedCostUsd: 0, durationMs: 1 },
}

describe("ordinary Scout discovery provenance", () => {
  it("accepts one current registered generic Scout binding in one fenced read", async () => {
    const queryClient = client()
    expect(() => parseTaskGraphSnapshot(snapshot())).not.toThrow()
    const eligible = await readRegisteredOrdinaryScoutProvenance(queryClient, lease())
    expect(queryClient.query).toHaveBeenCalledTimes(1)
    expect(eligible).toBe(true)
    const [sql, values] = vi.mocked(queryClient.query).mock.calls[0]!
    expect(sql).toContain('item."id" = $1')
    expect(sql).toContain('turn."status" IN (\'queued\', \'in_progress\', \'waiting_for_dependency\', \'waiting_for_approval\', \'waiting_for_user\')')
    expect(sql).not.toContain('turn."status" NOT IN')
    expect(sql).not.toContain('turn."leaseExpiresAt"')
    expect(sql).toContain('task."attemptCount" = $9')
    expect(values).toEqual([expect.stringMatching(/^task-graph-/), "session-1", "turn-1", "root-1", "task-1", "root-1", "user-1", "worker-1", 2])
  })

  it("rejects an unknown Turn status even if the query adapter returns a matching row", async () => {
    expect(await readRegisteredOrdinaryScoutProvenance(client([dbRow({ turnStatus: "future_state" })]), lease())).toBe(false)
  })

  it.each(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])(
    "accepts the canonical nonterminal Turn status %s", async turnStatus => {
      expect(await readRegisteredOrdinaryScoutProvenance(client([dbRow({ turnStatus })]), lease())).toBe(true)
    },
  )

  it.each([
    ["selected context", dbRow({ context: { selectedJobPreparation: { jobId: "job-1" } } })],
    ["different row role", dbRow({ role: "analyst" })],
    ["different task type", dbRow({ taskType: "selected_job_discovery" })],
    ["different action binding", dbRow({ allowedActions: ["jobs.get"] })],
    ["different output schema", dbRow({ expectedOutputSchema: { ...schema, role: "analyst" } })],
    ["missing ordinary envelope", dbRow({ content: snapshot([scoutNode({ registeredScoutEnvelope: undefined })]) })],
  ])("rejects an ineligible server binding: %s", async (_name, row) => {
    expect(await readRegisteredOrdinaryScoutProvenance(client([row]), lease())).toBe(false)
  })

  it("rejects native, repair, duplicate, stale owner/attempt, and invalid live lease bindings", async () => {
    const nativeDelegation = {
      schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "native-operation",
      requestFingerprint: "a".repeat(64), callerTaskId: "root-1", role: "scout", taskType: "job_discovery",
      contextDigest: "b".repeat(64), contextBytes: 0,
    }
    const native = {
      key: "native-node", templateId: "native", goal: "Find roles", successCriteria: ["Return roles"], dependsOn: [], depth: 1,
      taskId: "task-1", verificationDisposition: "legacy_unverified", nativeDelegation,
    }
    const target = { ...scoutNode(), key: "prior", taskId: "task-prior" }
    const repair = scoutNode({ key: "repair", repairOf: { graphRootTaskId: "root-1", nodeKey: "prior", taskId: "task-prior", criterionIds: ["candidate-count"] } })
    const duplicate = [scoutNode(), { ...scoutNode(), key: "duplicate" }]
    const cases: Array<[Queryable, SubagentLease]> = [
      [client([dbRow({ content: snapshot([native]) })]), lease()],
      [client([dbRow({ content: snapshot([target, repair]) })]), lease()],
      [client([dbRow({ content: snapshot(duplicate) })]), lease()],
      [client([]), lease({ attemptCount: 3 })],
      [client([]), lease({ ownerId: "other-worker" })],
      [client([]), lease({ status: "queued" })],
      [client([]), lease({ leaseExpiresAt: new Date(Date.now() - 1) })],
      [client([]), lease({ interruptRequestedAt: new Date() })],
      [client([]), lease({ parentTaskId: "other-root" })],
    ]
    for (const [queryClient, taskLease] of cases) expect(await readRegisteredOrdinaryScoutProvenance(queryClient, taskLease)).toBe(false)
    expect(cases[3]![0].query).toHaveBeenCalledTimes(1)
  })

  it("fails closed on ambiguous reads and lets database errors reach transaction cleanup", async () => {
    expect(await readRegisteredOrdinaryScoutProvenance(client([dbRow(), dbRow()]), lease())).toBe(false)
    const broken = { query: vi.fn(async () => { throw new Error("database unavailable") }) } as unknown as Queryable
    await expect(readRegisteredOrdinaryScoutProvenance(broken, lease())).rejects.toThrow("database unavailable")
  })

  it("awaits tenant-scoped provenance before exposing recovery", async () => {
    const fixture = tenantPool([dbRow()]), observers = await createChildDiscoveryObservers(fixture.pool, lease(), fence)
    expect(fixture.statements).toEqual([
      "BEGIN", "SELECT set_config($1, $2, true)", expect.stringContaining('FROM "agent_items" AS item'), "COMMIT",
    ])
    expect(fixture.parameters[1]).toEqual(["app.user_id", "user-1"])
    expect(fixture.release).toHaveBeenCalledOnce()
    const started: DiscoveryAttemptLifecycleEvent = { phase: "started", call: lifecycleCall }
    const completed: DiscoveryAttemptLifecycleEvent = { phase: "completed", call: lifecycleCall, output: emptyReceipt }
    observers.observeLifecycleEvent(started)
    observers.observeLifecycleEvent(completed)
    expect(observers.discoveryRecoverySidecar()).toMatchObject({ jobIds: [], attemptCount: 2 })
    expect(observers.discoveryAttemptSidecar()).toMatchObject({ attemptCount: 2, health: { completedCalls: 1 } })

    const noProvenancePool = tenantPool([]), noProvenance = await createChildDiscoveryObservers(noProvenancePool.pool, lease(), fence)
    noProvenance.observeLifecycleEvent(started)
    noProvenance.observeLifecycleEvent(completed)
    expect(noProvenance.discoveryRecoverySidecar()).toBeUndefined()
    expect(noProvenance.discoveryAttemptSidecar()).toMatchObject({ attemptCount: 2, health: { completedCalls: 1 } })
    expect(noProvenancePool.release).toHaveBeenCalledOnce()
  })

  it("rolls back and releases on provenance read failure without disabling health", async () => {
    const fixture = tenantPool([], true), observers = await createChildDiscoveryObservers(fixture.pool, lease(), fence)
    observers.observeLifecycleEvent({ phase: "started", call: lifecycleCall })
    observers.observeLifecycleEvent({ phase: "completed", call: lifecycleCall, output: emptyReceipt })
    expect(observers.discoveryRecoverySidecar()).toBeUndefined()
    expect(observers.discoveryAttemptSidecar()).toMatchObject({ attemptCount: 2, health: { completedCalls: 1 } })
    expect(fixture.statements).toEqual([
      "BEGIN", "SELECT set_config($1, $2, true)", expect.stringContaining('FROM "agent_items" AS item'), "ROLLBACK",
    ])
    expect(fixture.release).toHaveBeenCalledOnce()
  })

  it("guards the two observers independently", () => {
    let healthCalls = 0, recoveryCalls = 0
    const observer = composeDiscoveryAttemptObservers(() => { healthCalls += 1; throw new Error("health failed") }, () => { recoveryCalls += 1 })
    observer({ phase: "started", call: lifecycleCall })
    expect(healthCalls).toBe(1)
    expect(recoveryCalls).toBe(1)
  })
})
