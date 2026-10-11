import { describe, expect, it, vi } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"

import { createPgRootTaskStore } from "./root-task-store.js"
import { TASK_GRAPH_ITEM_TYPE, TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "./task-graph-snapshot.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION, TASK_GRAPH_NATIVE_TEMPLATE_ID } from "./task-graph-native-state.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 3,
  leaseStartedAt: new Date("2026-09-07T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-07T00:01:00.000Z"),
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "root-turn-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-turn-1", parentTaskId: null,
    path: "/root-turn-1", depth: 0, role: "orchestrator", taskType: "root", status: "waiting", goal: "Find jobs",
    constraints: [], successCriteria: [], allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {}, result: null,
    failureReason: null, attemptCount: 1, maxAttempts: 1, leaseOwner: "old-worker", leaseExpiresAt: new Date("2026-09-06T23:59:00.000Z"),
    interruptRequestedAt: null, budgetSnapshot: { limits: { maxSteps: 2 } }, toolPolicySnapshot: { role: "orchestrator" }, ...overrides,
  }
}

function fakePool(existing: Record<string, unknown> | null = null, updateCount = 1, sessionStatus = "running", sessionUserId = "user-1", turnRootTaskId: string | null = "root-turn-1") {
  const calls: string[] = []
  let rootStatus = String(existing?.status ?? row().status)
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return sessionStatus === "missing" || ["aborted", "archived"].includes(sessionStatus) || sessionUserId !== "user-1" ? { rows: [], rowCount: 0 } : { rows: [{ id: "session-1", userId: sessionUserId, status: sessionStatus }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns" AS turn')) return turnRootTaskId === values?.[3]
        ? { rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", rootTaskId: turnRootTaskId, status: "in_progress", leaseOwnerId: "worker-1", leaseVersion: 3 }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "rootTaskId" FROM "agent_turns"')) return { rows: [{ rootTaskId: existing?.id ? "root-turn-1" : null }], rowCount: 1 }
      if (sql.includes('SELECT "id", "rootTaskId" FROM "agent_turns"')) return turnRootTaskId === values?.[5]
        ? { rows: [{ id: "turn-1", rootTaskId: turnRootTaskId }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
      if (sql.includes("INSERT INTO \"sub_agent_tasks\"")) return { rows: [], rowCount: 1 }
      if (sql.includes('UPDATE "agent_turns"')) return { rows: [], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ ...(existing ?? row()), status: rootStatus }], rowCount: 1 }
      if (sql.includes('SELECT "id" FROM "agent_turns"') && sql.includes('"rootTaskId" = $5')) return turnRootTaskId === values?.[4] ? { rows: [{ id: "turn-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [{ id: "turn-1" }], rowCount: 1 }
      if (sql.includes('UPDATE "sub_agent_tasks"')) {
        if (values?.[4] === "root-turn-1") rootStatus = String(values[0])
        return { rows: [], rowCount: updateCount }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as never, calls, client }
}

function completionPool(descendants: Array<Record<string, unknown>>, owned = true, hasTaskGraphProposal = false) {
  const calls: string[] = []
  const client = {
    query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
      if (sql.includes('SELECT "id", "rootTaskId" FROM "agent_turns"')) return owned ? { rows: [{ id: "turn-1", rootTaskId: "root-turn-1" }], rowCount: 1 } : { rows: [], rowCount: 0 }
      if (sql.includes('SELECT task."id", task."status"')) return { rows: descendants, rowCount: descendants.length }
      if (sql.includes('SELECT 1 FROM "agent_events" AS event') && sql.includes("'proposal'")) {
        return hasTaskGraphProposal ? { rows: [{}], rowCount: 1 } : { rows: [], rowCount: 0 }
      }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as never, calls, client }
}

function terminalPool(root: Record<string, unknown> | null) {
  const calls: Array<{ sql: string; values?: unknown[] }> = []
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "sub_agent_tasks" AS task') && sql.includes('task."id" = task."rootTaskId"')) return { rows: root ? [root] : [], rowCount: root ? 1 : 0 }
      return { rows: [], rowCount: 1 }
    }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn(async () => client) } as never, calls, client }
}

function graphTerminalPool(hasProposal = true) {
  const ids = ["queued-child", "retrying-child", "waiting-child", "waiting-user-child", "running-child"]
  const statuses = new Map(ids.map((id, index) => [id, ["queued", "retrying", "waiting", "waiting_for_user", "running"][index]!] as const))
  const nodes = ids.map((taskId, index) => ({
    key: `node-${index + 1}`, templateId: "analyst", goal: `Inspect ${taskId}`, successCriteria: ["Find evidence"],
    dependsOn: [], depth: 1, taskId,
  }))
  const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes }
  const itemId = taskGraphItemId("root-turn-1")
  const createdAt = new Date("2026-09-07T00:00:00.000Z")
  const proposal = {
    kind: "proposal", fingerprint: "f".repeat(64), revision: 1,
    receipt: {
      status: "accepted", revision: 1,
      nodes: nodes.map((node, index) => ({ key: node.key, taskId: node.taskId, status: index === 2 || index === 3 ? "waiting" : "queued" })),
      readyTaskIds: [ids[0], ids[1], ids[4]],
    },
    item: {
      schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: "session-1", turnId: "turn-1", stepId: null,
      taskId: "root-turn-1", type: TASK_GRAPH_ITEM_TYPE, status: "streaming", phase: null, revision: 1,
      content: snapshot, startedAt: createdAt.toISOString(), completedAt: null,
      createdAt: createdAt.toISOString(), updatedAt: createdAt.toISOString(),
    },
    content: snapshot,
  }
  const tasks = new Map<string, Record<string, unknown>>([
    ...ids.map((id, index) => [id, {
      id, status: statuses.get(id), role: "analyst", failureReason: null, result: null,
      sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-turn-1", parentTaskId: "root-turn-1", userId: "user-1",
    }] as const),
    ["same-root-legacy", {
      id: "same-root-legacy", status: "queued", role: "analyst", failureReason: null, result: null,
      sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-turn-1", parentTaskId: "root-turn-1", userId: "user-1",
    }],
  ])
  const dispatches = new Map<string, { publishedAt: Date | null }>([
    ...ids.map(id => [`subagent-dispatch:${id}`, { publishedAt: id === "waiting-user-child" ? createdAt : null }] as const),
    ["subagent-dispatch:same-root-legacy", { publishedAt: null }],
  ])
  const calls: Array<[string, unknown[]?]> = []
  const lifecycleReceipts: Array<Record<string, unknown>> = []
  let revision = 1
  let eventSequence = 0
  const rootTask = row({ status: "running", leaseOwner: "worker-1" })
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    calls.push([sql, values])
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql) || sql.includes("set_config")) return { rows: [], rowCount: 0 }
    if (sql.startsWith("SELECT") && sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1", userId: "user-1", status: "running" }], rowCount: 1 }
    if (sql.includes('SELECT turn."id"') && sql.includes('FROM "agent_turns" AS turn')) return { rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", rootTaskId: "root-turn-1", status: "in_progress", leaseOwnerId: "worker-1", leaseVersion: 3 }], rowCount: 1 }
    if (sql.startsWith("SELECT") && sql.includes('FROM "agent_turns"')) return { rows: [{ id: "turn-1", rootTaskId: "root-turn-1" }], rowCount: 1 }
    if (sql.includes('event."payload"->>\'kind\' = \'proposal\'')) return { rows: hasProposal ? [{ payload: proposal }] : [], rowCount: hasProposal ? 1 : 0 }
    if (sql.includes('SELECT item."id"')) return { rows: hasProposal ? [{ id: itemId, revision, content: snapshot, createdAt }] : [], rowCount: hasProposal ? 1 : 0 }
    if (sql.includes('SELECT task."turnId"')) return { rows: [{
      turnId: "turn-1", rootTaskId: "root-turn-1", parentTaskId: "root-turn-1", attemptCount: 1, userId: "user-1",
    }], rowCount: 1 }
    if (sql.includes('SELECT task."id", task."status", task."attemptCount"') && sql.includes("FOR UPDATE OF task")) {
      const requested = values?.[0] as string[]
      return { rows: requested.flatMap(id => {
        const task = tasks.get(id)
        return task ? [{ id, status: statuses.get(id) ?? task.status, attemptCount: 1 }] : []
      }), rowCount: requested.length }
    }
    if (sql.includes('SELECT task."id", task."status", task."role", task."taskType", task."expectedOutputSchema"')
      && sql.includes('task."id" = ANY($1::text[])') && sql.includes('task."parentTaskId" = $5')) {
      const requested = values?.[0] as string[]
      return { rows: requested.flatMap(id => {
        const task = tasks.get(id)
        return task ? [{ id, status: statuses.get(id) ?? task.status, role: task.role, taskType: task.taskType ?? "research",
          expectedOutputSchema: task.expectedOutputSchema ?? {}, failureReason: task.failureReason ?? null, result: task.result ?? null }] : []
      }), rowCount: requested.length }
    }
    if (sql.includes('SELECT event."type", event."itemId", event."taskId", event."idempotencyKey", event."payload"')
      && sql.includes('event."taskId" = $4')) {
      const [sessionId, turnId, graphItemId, parentTaskId, userId] = values ?? []
      const belongsToGraph = sessionId === "session-1" && turnId === "turn-1" && graphItemId === itemId && parentTaskId === "root-turn-1" && userId === "user-1"
      return { rows: belongsToGraph ? [{ type: "item.delta", itemId, taskId: "root-turn-1", idempotencyKey: `${itemId}:proposal:1`, payload: proposal }] : [], rowCount: belongsToGraph ? 1 : 0 }
    }
    if (sql.includes('SELECT event."type", event."itemId", event."taskId", event."idempotencyKey", event."payload"')) {
      return { rows: [], rowCount: 0 }
    }
    if (sql.startsWith('UPDATE "agent_items"')) {
      revision = Number(values?.[5])
      return { rows: [{ stepId: null, status: "streaming", phase: null, startedAt: createdAt, completedAt: null, createdAt }], rowCount: 1 }
    }
    if (sql.includes('UPDATE "agent_sessions" AS session') && sql.includes('RETURNING "eventSequence"')) {
      eventSequence += 1
      return { rows: [{ eventSequence: String(eventSequence) }], rowCount: 1 }
    }
    if (sql.includes('INSERT INTO "agent_events"')) {
      lifecycleReceipts.push(JSON.parse(String(values?.[10])) as Record<string, unknown>)
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('DELETE FROM "agent_outbox"')) {
      const key = String(values?.[1])
      if (dispatches.get(key)?.publishedAt === null) dispatches.delete(key)
      return { rows: [], rowCount: 1 }
    }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
    if (sql.startsWith('UPDATE "sub_agent_tasks"')) {
      if (sql.includes('WHERE "id" = $5') && values?.[4] === "root-turn-1") { rootTask.status = String(values[0]); return { rows: [], rowCount: 1 } }
      const id = [...tasks.keys()].find(candidate => values?.includes(candidate))
      if (id && tasks.has(id)) {
        if (sql.includes('"interruptRequestedAt"')) tasks.get(id)!.interruptRequestedAt = values?.[6]
        else if (sql.includes('"status"')) statuses.set(id, sql.includes("= 'cancelled'") || values?.includes("cancelled") ? "cancelled" : String(values?.[2]))
        return { rows: [], rowCount: 1 }
      }
    }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [rootTask], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as never, calls, statuses, tasks, dispatches, lifecycleReceipts, rootTask }
}

function verificationCompletionPool(nodes: readonly Record<string, unknown>[]) {
  const content = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes }
  const rows = new Map(nodes.map(node => [String(node.taskId), {
    id: String(node.taskId), status: "completed", role: node.nativeDelegation ? "scout" : "analyst",
    taskType: node.nativeDelegation ? "research" : "analysis", expectedOutputSchema: {}, failureReason: null, result: null,
  }] as const))
  const client = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
    if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
    if (sql.includes('SELECT "id", "rootTaskId" FROM "agent_turns"')) return { rows: [{ id: "turn-1", rootTaskId: "root-turn-1" }], rowCount: 1 }
    if (sql.includes('SELECT task."id", task."status", task."sessionId"')) return { rows: [], rowCount: 0 }
    if (sql.includes('SELECT item."id"')) return { rows: [{ id: taskGraphItemId("root-turn-1"), revision: 1, content, createdAt: new Date() }], rowCount: 1 }
    if (sql.includes('task."id" = ANY($1::text[])') && sql.includes('task."parentTaskId" = $5')) {
      const requested = values?.[0] as string[]
      return { rows: requested.flatMap(id => rows.has(id) ? [rows.get(id)] : []), rowCount: requested.length }
    }
    if (sql.includes('SELECT event."type", event."itemId"')) return { rows: [], rowCount: 0 }
    return { rows: [], rowCount: 1 }
  }), release: vi.fn() }
  return { pool: { connect: vi.fn().mockResolvedValue(client) } as never, client }
}

function nativeGraphNode(taskId = "native-child") {
  return {
    key: "native-node", templateId: TASK_GRAPH_NATIVE_TEMPLATE_ID, goal: "Inspect delegated evidence", successCriteria: [],
    dependsOn: [], depth: 1, taskId, verificationDisposition: "legacy_unverified",
    nativeDelegation: {
      schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "native-operation",
      requestFingerprint: "a".repeat(64), callerTaskId: "root-turn-1", role: "scout", taskType: "research",
      contextDigest: "b".repeat(64), contextBytes: 12,
    },
  }
}

function legacyGraphNode() {
  return {
    key: "legacy-node", templateId: "analyst", goal: "Inspect legacy evidence", successCriteria: ["Return one finding"],
    dependsOn: [], depth: 1, taskId: "legacy-child", verificationDisposition: "legacy_unverified",
  }
}

describe("createPgRootTaskStore", () => {
  it("creates a scoped root with explicit allowed actions and keeps secrets out", async () => {
    const fake = fakePool()
    const root = await createPgRootTaskStore(fake.pool).ensure({
      lease, goal: "Find jobs", allowedActions: ["jobs.search"], modelProfileSnapshot: { provider: "fixture", model: "fixture" },
      toolPolicySnapshot: { role: "orchestrator" }, budgetSnapshot: { limits: { maxSteps: 2 } },
    })
    expect(root).toMatchObject({ id: "root-turn-1", status: "waiting" })
    const insert = fake.client.query.mock.calls.find(([sql]) => sql.includes("INSERT INTO \"sub_agent_tasks\""))
    expect(insert?.[1]).not.toContain(expect.objectContaining({ apiKey: expect.anything() }))
    expect(insert?.[1]).toContain(JSON.stringify(["jobs.search"]))
    expect(fake.calls.findIndex(sql => sql.includes('FROM "agent_sessions"'))).toBeLessThan(fake.calls.findIndex(sql => sql.includes('FROM "agent_turns"')))
  })

  it.each(["running", "paused", "waiting_for_user"])("keeps %s sessions compatible with root admission", async (sessionStatus) => {
    await expect(createPgRootTaskStore(fakePool(null, 1, sessionStatus).pool).ensure({ lease, goal: "Find jobs" })).resolves.toBeDefined()
  })

  it("rebinds a stale waiting root before resume", async () => {
    const fake = fakePool(row())
    await createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs", allowedActions: ["jobs.search", "jobs.get"] })
    const update = fake.client.query.mock.calls.find(([sql]) => sql.includes("SET \"status\" = 'running'"))
    expect(update?.[1]).toContain("worker-1")
    expect(update?.[1]).toContain(JSON.stringify(["jobs.search", "jobs.get"]))
  })

  it("rejects a secret bearing snapshot", async () => {
    const fake = fakePool()
    await expect(createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs", toolPolicySnapshot: { apiKey: "secret" } })).rejects.toThrow("tool_policy_contains_secret")
  })

  it("requires the current turn fence while finishing", async () => {
    const fake = fakePool()
    await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 1, toolCallCount: 0 } })
    expect(fake.calls.some(sql => sql.includes('"leaseVersion" = $5') && sql.includes('"leaseExpiresAt" > CURRENT_TIMESTAMP'))).toBe(true)
    const taskUpdate = fake.calls.find(sql => sql.includes('UPDATE "sub_agent_tasks" SET'))
    expect(taskUpdate).toContain('"attemptCount" = 1')
    expect(taskUpdate).not.toContain('"leaseExpiresAt" > CURRENT_TIMESTAMP')
    const serialized = fake.client.query.mock.calls.find(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))?.[1]?.[1]
    expect(serialized).toBe(JSON.stringify({ status: "completed", stepCount: 1, toolCallCount: 0, finalItemId: null, waitId: null }))
  })

  it.each(["completed", "failed"] as const)("settles a %s result only for the exact linked root", async status => {
    const fake = fakePool(null, 1, "running", "user-1", "root-turn-1")
    const result = status === "completed"
      ? { status, stepCount: 1, toolCallCount: 0 }
      : { status, errorCode: "turn_failed", stepCount: 1, toolCallCount: 0 }

    await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result })

    const turnLock = fake.client.query.mock.calls.find(([sql]) => sql.includes('SELECT "id", "rootTaskId" FROM "agent_turns"'))
    expect(turnLock?.[0]).toContain('"rootTaskId" = $6')
    expect(turnLock?.[1]).toEqual([lease.turnId, lease.sessionId, lease.userId, lease.ownerId, lease.leaseVersion, "root-turn-1"])
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))).toBe(true)
  })

  it.each([null, "root-turn-other"] as const)("rejects root settlement when the same Turn links to %s", async linkedRootTaskId => {
    const fake = fakePool(null, 1, "running", "user-1", linkedRootTaskId)

    await expect(createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "failed", errorCode: "turn_failed", stepCount: 1, toolCallCount: 0 },
    })).rejects.toThrow("root_turn_fenced")

    const sessionLock = fake.client.query.mock.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const turnLock = fake.client.query.mock.calls.findIndex(([sql]) => sql.includes('SELECT "id", "rootTaskId" FROM "agent_turns"'))
    expect(sessionLock).toBeGreaterThanOrEqual(0)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))).toBe(false)
  })
  it("cancels only active persisted graph members when a root fails", async () => {
    const fake = graphTerminalPool()
    await createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "failed", errorCode: "turn_failed", stepCount: 2, toolCallCount: 1 },
    })

    expect(fake.rootTask.status).toBe("failed")
    expect(Object.fromEntries(fake.statuses)).toEqual({
      "queued-child": "cancelled", "retrying-child": "cancelled", "waiting-child": "cancelled",
      "waiting-user-child": "cancelled", "running-child": "running",
    })
    expect(fake.lifecycleReceipts.map(receipt => (receipt.event as Record<string, unknown>).nodeKey).sort())
      .toEqual(["node-1", "node-2", "node-3", "node-4"])
    expect(fake.lifecycleReceipts.every(receipt => (receipt.event as Record<string, unknown>).type === "task.cancelled")).toBe(true)
    expect(fake.tasks.get("running-child")?.interruptRequestedAt).toBeDefined()
    expect(fake.dispatches.has("subagent-dispatch:queued-child")).toBe(false)
    expect(fake.dispatches.has("subagent-dispatch:retrying-child")).toBe(false)
    expect(fake.dispatches.has("subagent-dispatch:waiting-child")).toBe(false)
    expect(fake.dispatches.has("subagent-dispatch:waiting-user-child")).toBe(true)
    expect(fake.dispatches.has("subagent-dispatch:same-root-legacy")).toBe(true)

    const sessionLock = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_sessions"') && sql.includes("FOR UPDATE"))
    const turnLock = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_turns"') && sql.includes("FOR UPDATE"))
    const rootLock = fake.calls.findIndex(([sql, values]) => sql.includes('UPDATE "sub_agent_tasks"') && values?.[4] === "root-turn-1")
    const graphRead = fake.calls.findIndex(([sql]) => sql.includes('FROM "agent_items"') || sql.includes('FROM "agent_events"'))
    expect(sessionLock).toBeGreaterThanOrEqual(0)
    expect(sessionLock).toBeLessThan(turnLock)
    expect(turnLock).toBeLessThan(rootLock)
    expect(rootLock).toBeLessThan(graphRead)
    expect(fake.calls.filter(([sql]) => sql === "BEGIN")).toHaveLength(1)
    expect(fake.calls.filter(([sql]) => sql === "COMMIT")).toHaveLength(1)
  })

  it("forwards the independent native proof only for native nodes and keeps legacy nodes fail-closed", async () => {
    const nativeOnly = createPgRootTaskStore(verificationCompletionPool([nativeGraphNode()]).pool)
    await expect(nativeOnly.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, nativeVerificationPassed: true }))
      .resolves.toEqual({ ok: true })
    await expect(nativeOnly.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, nativeVerificationPassed: false }))
      .resolves.toMatchObject({ ok: false, blocker: "task_graph_verification_unverified", feedback: expect.stringContaining("issue=legacy_unverified") })

    const mixed = createPgRootTaskStore(verificationCompletionPool([nativeGraphNode(), legacyGraphNode()]).pool)
    await expect(mixed.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, nativeVerificationPassed: true }))
      .resolves.toMatchObject({ ok: false, blocker: "task_graph_verification_unverified", feedback: expect.stringContaining("issue=legacy_unverified") })
  })

  it("does not authorize TaskGraph cleanup when failed root persistence is rejected", async () => {
    const fake = fakePool(null, 0)
    await expect(createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "failed", errorCode: "turn_failed", stepCount: 1, toolCallCount: 0 },
    })).rejects.toThrow("root_task_fenced")
    expect(fake.calls.some(sql => sql.includes('FROM "agent_items"'))).toBe(false)
    expect(fake.calls.some(sql => sql.includes("task.cancelled"))).toBe(false)
    expect(fake.calls).toContain("ROLLBACK")
  })

  it("leaves same-root descendants alone when no durable TaskGraph proposal exists", async () => {
    const fake = graphTerminalPool(false)
    await createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "failed", errorCode: "turn_failed", stepCount: 2, toolCallCount: 1 },
    })

    expect(fake.rootTask.status).toBe("failed")
    expect(Object.fromEntries(fake.statuses)).toEqual({
      "queued-child": "queued", "retrying-child": "retrying", "waiting-child": "waiting",
      "waiting-user-child": "waiting_for_user", "running-child": "running",
    })
    expect(fake.lifecycleReceipts).toHaveLength(0)
    expect(fake.dispatches.size).toBe(6)
  })

  it("does not clean graph children for a wait or successful root settlement", async () => {
    for (const result of [
      { status: "waiting_for_dependency" as const, stepCount: 1, toolCallCount: 0, waitId: "wait-1" },
      { status: "completed" as const, stepCount: 1, toolCallCount: 0 },
    ]) {
      const fake = fakePool()
      await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result })
      expect(fake.calls.some(sql => sql.includes("task.cancelled") || sql.includes("'cancelled'"))).toBe(false)
    }
  })

  it("atomically persists only a bounded validated discovery shortlist under structuredResult", async () => {
    const fake = fakePool()
    const shortlist = { schemaVersion: 1 as const, status: "partial" as const, items: [{ jobId: "job-1", score: 8.5, evidenceIds: ["read:job:job-1"] }], failures: ["scout_result_partial" as const] }
    await createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 2, toolCallCount: 1 },
      metadata: { interactiveDiscoveryShortlist: shortlist },
    })
    const update = fake.client.query.mock.calls.find(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))
    const saved = JSON.parse(String(update?.[1]?.[1])) as unknown
    expect(saved).toEqual({
      status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: null, waitId: null,
      structuredResult: { interactiveDiscoveryShortlist: shortlist },
    })
  })

  it.each([
    { schemaVersion: 1, status: "completed", items: [], failures: [] },
    { schemaVersion: 1, status: "failed", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }], failures: ["no_common_candidates"] },
    { schemaVersion: 1, status: "completed", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"], url: "https://model.test" }], failures: [] },
  ])("rejects invalid or model-shaped discovery metadata before root settlement", async shortlist => {
    const fake = fakePool()
    await expect(createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 1, toolCallCount: 0 },
      metadata: { interactiveDiscoveryShortlist: shortlist as never },
    })).rejects.toThrow("root_terminal_discovery_shortlist_invalid")
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))).toBe(false)
  })

  it("requires a failed shortlist marker for terminal discovery failure", async () => {
    const fake = fakePool()
    await expect(createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "failed", errorCode: "turn_failed", stepCount: 1, toolCallCount: 0 },
      metadata: { interactiveDiscoveryShortlist: { schemaVersion: 1, status: "partial", items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }], failures: ["scout_result_partial"] } },
    })).rejects.toThrow("root_terminal_discovery_status_mismatch")
  })

  it("preserves a verified shortlist as partial when the root fails after ranking", async () => {
    const fake = fakePool()
    const shortlist = { schemaVersion: 1 as const, status: "partial" as const, items: [{ jobId: "job-1", score: 8, evidenceIds: ["read:job:job-1"] }], failures: ["discovery_runtime_failed" as const] }
    await createPgRootTaskStore(fake.pool).finish({
      lease, rootTaskId: "root-turn-1", result: { status: "failed", errorCode: "turn_failed", stepCount: 2, toolCallCount: 1 },
      metadata: { interactiveDiscoveryShortlist: shortlist },
    })
    const update = fake.client.query.mock.calls.find(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))
    expect(JSON.parse(String(update?.[1]?.[1]))).toMatchObject({
      status: "failed", structuredResult: { interactiveDiscoveryShortlist: shortlist },
    })
  })

  it("accepts an already-committed matching root receipt without rewriting terminal identity", async () => {
    const calls: string[] = []
    const result = { status: "completed" as const, stepCount: 2, toolCallCount: 1, finalItemId: "final-item" }
    const client = { query: vi.fn(async (sql: string) => {
      calls.push(sql)
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_sessions"')) return { rows: [{ id: lease.sessionId }], rowCount: 1 }
      if (sql.includes('FROM "agent_turns"') && sql.includes("status")) return sql.includes(`"status" = 'completed'`)
        ? { rows: [{ id: lease.turnId }], rowCount: 1 }
        : { rows: [], rowCount: 0 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes('"status", "result"')) return { rows: [{ status: "completed", result, failureReason: null }], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const pool = { connect: vi.fn(async () => client) } as never

    await expect(createPgRootTaskStore(pool).finish({ lease, rootTaskId: "root-turn-1", result })).resolves.toBeUndefined()

    expect(calls.findIndex(sql => sql.includes('FROM "agent_sessions"'))).toBeLessThan(calls.findIndex(sql => sql.includes('FROM "agent_turns"')))
    expect(calls.findIndex(sql => sql.includes('FROM "agent_turns"') && sql.includes(`"status" = 'completed'`))).toBeLessThan(calls.findIndex(sql => sql.includes('FROM "sub_agent_tasks"') && sql.includes('"status", "result"')))
    expect(calls.some(sql => sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("finishes when copied root-task expiry is stale but the Turn lease is current", async () => {
    const fake = fakePool(row({ leaseExpiresAt: new Date("2026-09-07T00:00:30.000Z") }))
    await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 1, toolCallCount: 0 }, now: new Date("2026-09-07T00:02:00.000Z") })
    const taskUpdate = fake.calls.find(sql => sql.includes('UPDATE "sub_agent_tasks" SET'))
    expect(taskUpdate).toBeDefined()
    expect(taskUpdate).not.toContain('"leaseExpiresAt" > CURRENT_TIMESTAMP')
  })

  it("rejects a stale or expired actual Turn owner before root settlement", async () => {
    const calls: string[] = []
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push(sql)
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT "id" FROM "agent_sessions"')) return { rows: [{ id: "session-1" }], rowCount: 1 }
        if (sql.includes('SELECT "id" FROM "agent_turns"')) return { rows: [], rowCount: 0 }
        return { rows: [], rowCount: 1 }
      }),
      release: vi.fn(),
    }
    const pool = { connect: vi.fn(async () => client) } as never
    await expect(createPgRootTaskStore(pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "completed", stepCount: 1, toolCallCount: 0 } })).rejects.toThrow("root_turn_fenced")
    expect(calls.some(sql => sql.includes('UPDATE "sub_agent_tasks"'))).toBe(false)
  })

  it("does not rebind a terminal root task", async () => {
    const fake = fakePool(row({ status: "completed" }), 0)
    await expect(createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs" })).rejects.toThrow("root_task_terminal")
  })

  it("releases the root lease when a turn enters a wait state", async () => {
    const fake = fakePool()
    await createPgRootTaskStore(fake.pool).finish({ lease, rootTaskId: "root-turn-1", result: { status: "waiting_for_dependency", stepCount: 1, toolCallCount: 0, waitId: "wait-1" } })
    expect(fake.calls.some(sql => sql.includes('"leaseOwner" = NULL') && sql.includes('"leaseExpiresAt" = NULL'))).toBe(true)
    const taskUpdate = fake.client.query.mock.calls.find(([sql]) => sql.includes('UPDATE "sub_agent_tasks" SET'))?.[0] ?? ""
    expect(taskUpdate).toContain("THEN $4::timestamp(3) ELSE NULL::timestamp(3) END")
    expect(taskUpdate).toContain('"updatedAt" = $4::timestamp(3)')
    expect(fake.client.query.mock.calls.some(([, values]) => String(values?.[1]).includes('"waitId":"wait-1"'))).toBe(true)
  })

  it.each([
    ["completed", "completed", null],
    ["waiting", "waiting_for_dependency", "wait-1"],
  ] as const)("reconciles a persisted %s root without rebinding it", async (rootStatus, turnStatus, waitId) => {
    const fake = terminalPool(row({ status: rootStatus, result: { status: turnStatus, stepCount: 2, toolCallCount: 1, waitId } }))
    const result = await createPgRootTaskStore(fake.pool).reconcileTerminal!({ lease, now: new Date("2026-09-07T00:00:10.000Z") })

    expect(result).toEqual({ rootTaskId: "root-turn-1", result: { status: turnStatus, ...(waitId ? { waitId } : {}) } })
    const query = fake.calls.find(call => call.sql.includes('FROM "sub_agent_tasks" AS task'))?.sql ?? ""
    expect(query).toContain('session."userId" = $3')
    expect(query).toContain('turn."leaseOwnerId" = $4')
    expect(query).toContain('turn."leaseVersion" = $5')
    expect(query).toContain('turn."status" = \'in_progress\'')
  })

  it("reconciles a persisted failed result with its bounded failure code", async () => {
    const fake = terminalPool(row({ status: "failed", result: { status: "failed", stepCount: 1, toolCallCount: 2 }, failureReason: "provider_error" }))
    await expect(createPgRootTaskStore(fake.pool).reconcileTerminal!({ lease })).resolves.toEqual({ rootTaskId: "root-turn-1", result: { status: "failed", summary: "provider_error" } })
  })

  it("returns no terminal root when the leased turn has none", async () => {
    const fake = terminalPool(null)
    await expect(createPgRootTaskStore(fake.pool).reconcileTerminal!({ lease })).resolves.toBeNull()
  })

  it("fails closed when a terminal root result is malformed", async () => {
    const fake = terminalPool(row({ status: "completed", result: { status: "failed", stepCount: 1, toolCallCount: 0 } }))
    await expect(createPgRootTaskStore(fake.pool).reconcileTerminal!({ lease })).rejects.toThrow("root_terminal_status_mismatch")
  })

  it.each(["queued", "running", "waiting"]) ("blocks completion while a %s child remains", async (childStatus) => {
    const fake = completionPool([{ id: "child-1", sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status: childStatus }])
    await expect(createPgRootTaskStore(fake.pool).checkCompletion!({ lease, rootTaskId: "root-turn-1" })).resolves.toMatchObject({ ok: false, blocker: "child_tasks_pending" })
    expect(fake.calls.some(sql => sql.includes("FOR UPDATE"))).toBe(true)
  })

  it("allows completion when every descendant is terminal", async () => {
    const fake = completionPool(["completed", "failed", "interrupted", "cancelled", "closed"].map((status, index) => ({ id: `child-${index}`, sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status })))
    await expect(createPgRootTaskStore(fake.pool).checkCompletion!({ lease, rootTaskId: "root-turn-1" })).resolves.toEqual({ ok: true })
  })

  it("checks durable graph proof on the caller transaction without opening a nested transaction", async () => {
    const fake = completionPool([])
    const store = createPgRootTaskStore(fake.pool)
    await expect(store.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, client: fake.client as never })).resolves.toEqual({ ok: true })
    expect(fake.calls).not.toContain("BEGIN")
    expect(fake.calls).not.toContain("COMMIT")
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes('FROM "agent_items" AS item'))).toBe(true)
    expect(fake.client.query.mock.calls.some(([sql]) => sql.includes("payload"))).toBe(true)
  })

  it("surfaces the recoverable TaskGraph blocker before a pending descendant blocker", async () => {
    const fake = completionPool([{
      id: "child-1", sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status: "waiting",
    }], true, true)
    const store = createPgRootTaskStore(fake.pool)

    await expect(store.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, client: fake.client as never }))
      .resolves.toMatchObject({ ok: false, blocker: "task_graph_verification_unverified" })
    expect(fake.calls.some(sql => sql.includes("'proposal'"))).toBe(true)
  })

  it("keeps the generic pending-descendant blocker when TaskGraph verification has no graph to block", async () => {
    const fake = completionPool([{
      id: "child-1", sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status: "waiting",
    }])
    const store = createPgRootTaskStore(fake.pool)

    await expect(store.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, client: fake.client as never }))
      .resolves.toMatchObject({ ok: false, blocker: "child_tasks_pending" })
  })

  it.each(["queued", "retrying", "running", "waiting_for_user"])("keeps the child blocker ahead of TaskGraph recovery for %s descendants", async (status) => {
    const fake = completionPool([{
      id: "child-1", sessionId: lease.sessionId, turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status,
    }], true, true)
    const store = createPgRootTaskStore(fake.pool)

    await expect(store.checkCompletion!({ lease, rootTaskId: "root-turn-1", taskGraphVerification: true, client: fake.client as never }))
      .resolves.toMatchObject({ ok: false, blocker: "child_tasks_pending" })
  })

  it("fails closed for a stale owner or foreign descendant row", async () => {
    const stale = completionPool([], false)
    await expect(createPgRootTaskStore(stale.pool).checkCompletion!({ lease, rootTaskId: "root-turn-1" })).rejects.toThrow("root_turn_fenced")
    const foreign = completionPool([{ id: "child-1", sessionId: "other-session", turnId: lease.turnId, rootTaskId: "root-turn-1", userId: lease.userId, status: "running" }])
    await expect(createPgRootTaskStore(foreign.pool).checkCompletion!({ lease, rootTaskId: "root-turn-1" })).rejects.toThrow("root_task_fenced")
  })

  it.each(["missing", "aborted", "archived"])("rejects %s sessions before root writes", async (sessionStatus) => {
    const fake = fakePool(null, 1, sessionStatus)
    await expect(createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs" })).rejects.toThrow("root_session_fenced")
    expect(fake.calls.some(sql => sql.includes("INSERT INTO"))).toBe(false)
    expect(fake.calls.some(sql => sql.includes('UPDATE "agent_turns"'))).toBe(false)
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
  })

  it("rejects a cross-user session before the Turn lock", async () => {
    const fake = fakePool(null, 1, "running", "user-2")
    await expect(createPgRootTaskStore(fake.pool).ensure({ lease, goal: "Find jobs" })).rejects.toThrow("root_session_fenced")
    expect(fake.calls.some(sql => sql.includes('FROM "agent_turns"'))).toBe(false)
    expect(fake.calls.some(sql => sql.includes("INSERT INTO"))).toBe(false)
    expect(fake.calls.some(sql => sql === "ROLLBACK")).toBe(true)
  })
})
