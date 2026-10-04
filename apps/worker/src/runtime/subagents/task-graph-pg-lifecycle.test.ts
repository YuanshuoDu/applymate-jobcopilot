import { describe, expect, it, vi } from "vitest"
import { AGENT_STREAM_SCHEMA_VERSION } from "@jobcopilot/agent-protocol"
import type pg from "pg"
import { prepareGraphTransition, reconcileGraphDependents } from "./task-graph-pg-lifecycle.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-pg-verification.js"

function fakeGraphClient(status: string, options: { proposalPayloads?: unknown[]; snapshot?: unknown; missingItem?: boolean; taskStatuses?: Record<string, string> } = {}) {
  const snapshot = options.snapshot ?? { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
    key: "child", templateId: "analyst", goal: "Inspect", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "child-1",
  }] }
  const proposalPayloads = options.proposalPayloads ?? [{ kind: "proposal", receipt: {
    revision: 2, nodes: [{ key: "child", taskId: "child-1", status: "queued" }], readyTaskIds: ["child-1"],
  } }]
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: proposalPayloads.map(payload => ({ payload })), rowCount: proposalPayloads.length }
      if (sql.includes('SELECT item."id"')) return options.missingItem ? { rows: [], rowCount: 0 } : { rows: [{
        id: taskGraphItemId("root-1"), revision: 2, content: snapshot, createdAt: new Date("2026-09-01T00:00:00.000Z"),
      }], rowCount: 1 }
      if (sql.includes('SELECT task."id", task."status"')) {
        const ids = params?.[0] as string[]
        return { rows: ids.map(id => ({ id, status: options.taskStatuses?.[id] ?? status, role: "analyst", failureReason: null, result: null })), rowCount: ids.length }
      }
      if (sql.includes('SELECT event."payload"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 0 }
    }),
  }
  return client
}

describe("prepareGraphTransition", () => {
  it("reduces a lifecycle receipt from the current persisted status and revision", async () => {
    const client = fakeGraphClient("running")
    const transition = await prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.completed", attemptCount: 1,
    })
    if (!transition || "blocked" in transition) throw new Error("expected prepared graph transition")

    expect(transition).toMatchObject({ expectedRevision: 2, state: { revision: 3, nodes: [{ key: "child", status: "completed" }] }, duplicate: false })
    expect(transition?.event).toMatchObject({ type: "task.completed", expectedRevision: 2, nodeKey: "child" })
  })

  it("sanitizes failure details before the reducer receipt is prepared", async () => {
    const client = fakeGraphClient("running")
    const transition = await prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.failed", attemptCount: 1,
      failureReason: "authorization: Bearer abcdefghijklmnop user@example.com",
    })
    if (!transition || "blocked" in transition) throw new Error("expected prepared graph transition")

    expect(transition?.event.type).toBe("task.failed")
    if (transition?.event.type !== "task.failed") throw new Error("expected task.failed event")
    expect(transition.event.failureReason).not.toContain("abcdefghijklmnop")
    expect(transition.event.failureReason).not.toContain("user@example.com")
  })

  it("fails closed for a persisted graph child when its item is missing", async () => {
    const client = fakeGraphClient("queued", { missingItem: true })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.started",
    })).rejects.toThrow("task_graph_state_missing")
    const membership = client.query.mock.calls.find(([sql]) => sql.includes("event.\"payload\"->>'kind' = 'proposal'"))
    expect(membership?.[0]).toContain('event."sessionId" = $1 AND event."turnId" = $2 AND event."itemId" = $3 AND event."taskId" = $4')
    expect(membership?.[0]).toContain('session."userId" = $5 AND turn."userId" = $5')
    expect(membership?.[1]).toEqual(["session-1", "turn-1", taskGraphItemId("root-1"), "root-1", "user-1"])
    expect(client.query.mock.calls.every(([sql]) => sql.trimStart().startsWith("SELECT"))).toBe(true)
  })

  it("fails closed when a persisted graph child has a corrupt snapshot", async () => {
    const client = fakeGraphClient("queued", { snapshot: { schemaVersion: "invalid", nodes: [] } })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.started",
    })).rejects.toThrow("task_graph_snapshot_invalid")
  })

  it("fails closed when a persisted graph child is absent from a valid snapshot", async () => {
    const client = fakeGraphClient("queued", { snapshot: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [{
      key: "other", templateId: "analyst", goal: "Inspect", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "other-child",
    }] } })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.started",
    })).rejects.toThrow("task_graph_child_missing")
  })

  it("fails closed for an unreadable proposal receipt instead of treating it as a legacy child", async () => {
    const client = fakeGraphClient("queued", { proposalPayloads: [{ kind: "proposal", receipt: { revision: 2, nodes: "invalid", readyTaskIds: [] } }] })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "legacy-child", sessionId: "session-1", type: "task.started",
    })).rejects.toThrow("task_graph_receipt_invalid")
    expect(client.query.mock.calls.some(([sql]) => sql.includes('SELECT item."id"'))).toBe(false)
  })

  it("keeps a same-root child on the legacy path when no proposal receipt contains it", async () => {
    const client = fakeGraphClient("queued", { proposalPayloads: [] })
    await expect(prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "legacy-child", sessionId: "session-1", type: "task.started",
    })).resolves.toBeNull()
    expect(client.query.mock.calls.some(([sql]) => sql.includes('SELECT item."id"'))).toBe(false)
  })

  it("blocks start and retry through a completed typed intermediary with a legacy-unverified ancestor", async () => {
    const verification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
    }
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { key: "source", templateId: "analyst", goal: "Analyze", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "source-1", verificationDisposition: "legacy_unverified" },
      { key: "intermediary", templateId: "analyst", goal: "Verify", successCriteria: ["done"], dependsOn: ["source"], depth: 2, taskId: "intermediary-1", verificationDisposition: "typed", verification },
      { key: "child", templateId: "analyst", goal: "Continue", successCriteria: ["done"], dependsOn: ["intermediary"], depth: 3, taskId: "child-1", verificationDisposition: "typed", verification },
    ] }
    const client = fakeGraphClient("queued", { snapshot, taskStatuses: { "source-1": "completed", "intermediary-1": "completed", "child-1": "queued" } })
    const transition = await prepareGraphTransition(client as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.started",
    })
    const retryClient = fakeGraphClient("running", { snapshot, taskStatuses: { "source-1": "completed", "intermediary-1": "completed", "child-1": "running" } })
    const retryTransition = await prepareGraphTransition(retryClient as unknown as Pick<pg.PoolClient, "query">, {
      taskId: "child-1", sessionId: "session-1", type: "task.retrying",
    })

    expect(transition).toEqual({ blocked: true })
    expect(retryTransition).toEqual({ blocked: true })
    expect(client.query.mock.calls.every(([sql]) => sql.trimStart().startsWith("SELECT"))).toBe(true)
  })
})

describe("reconcileGraphDependents", () => {
  it("does not queue an already queued node again when its dependency is healthy", async () => {
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { key: "source", templateId: "cover_letter_writer", goal: "Write", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "source-1", verificationDisposition: "specialized" },
      { key: "child", templateId: "cover_letter_writer", goal: "Review", successCriteria: ["done"], dependsOn: ["source"], depth: 2, taskId: "child-1", verificationDisposition: "specialized" },
    ] }
    const proposalPayloads = [{ kind: "proposal", receipt: {
      revision: 2, nodes: [{ key: "source", taskId: "source-1", status: "queued" }, { key: "child", taskId: "child-1", status: "waiting" }], readyTaskIds: ["source-1"],
    } }]
    const client = fakeGraphClient("queued", { snapshot, proposalPayloads, taskStatuses: { "source-1": "completed", "child-1": "queued" } })

    await expect(reconcileGraphDependents(client as unknown as Pick<pg.PoolClient, "query">, scope, new Date("2026-09-02T00:00:00.000Z"))).resolves.toBeUndefined()

    expect(client.query.mock.calls.every(([sql]) => sql.trimStart().startsWith("SELECT"))).toBe(true)
  })

  it.each(["waiting", "queued"] as const)("cancels a %s dependent after an unverified typed prerequisite failure", async dependentStatus => {
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
    const verification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
    }
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [
      { key: "prerequisite", templateId: "analyst", goal: "Analyze", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "prerequisite-1", verificationDisposition: "typed", verification },
      { key: "dependent", templateId: "analyst", goal: "Continue", successCriteria: ["done"], dependsOn: ["prerequisite"], depth: 2, taskId: "dependent-1", verificationDisposition: "typed", verification },
    ] }
    const report = {
      verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "unverified", reasonCode: "result_invalid",
      criteria: [{ criterionId: "finding-count", status: "unverified", reasonCode: "result_invalid" }],
      evidenceDigest: null, resultDigest: null,
    }
    const tasks = new Map([
      ["prerequisite-1", { id: "prerequisite-1", status: "failed", role: "analyst", failureReason: "task_graph_verification_unverified", result: { taskGraphVerificationReport: report }, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, userId: scope.userId, attemptCount: 1 }],
      ["dependent-1", { id: "dependent-1", status: dependentStatus, role: "analyst", failureReason: null, result: null, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, userId: scope.userId, attemptCount: 0 }],
    ])
    const itemId = taskGraphItemId(scope.rootTaskId)
    const proposalPayload = { kind: "proposal", fingerprint: "fixture-proposal", revision: 2, receipt: {
      status: "accepted", revision: 2,
      nodes: [
        { key: "prerequisite", taskId: "prerequisite-1", status: "queued" },
        { key: "dependent", taskId: "dependent-1", status: dependentStatus },
      ],
      readyTaskIds: ["prerequisite-1", ...(dependentStatus === "queued" ? ["dependent-1"] : [])],
    } }
    const events: Array<{ type: string; payload: unknown }> = []
    let revision = 2
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('SELECT task."turnId"')) {
          const row = tasks.get(String(values?.[0]))
          return { rows: row ? [{ turnId: row.turnId, rootTaskId: row.rootTaskId, parentTaskId: row.parentTaskId, attemptCount: row.attemptCount, userId: row.userId }] : [], rowCount: row ? 1 : 0 }
        }
        if (sql.includes("event.\"payload\"->>'kind' = 'proposal'")) return { rows: [{ payload: proposalPayload }], rowCount: 1 }
        if (sql.includes('SELECT item."id"')) return { rows: [{
          id: itemId, revision, content: snapshot, createdAt: new Date("2026-09-01T00:00:00.000Z"),
        }], rowCount: 1 }
        if (sql.includes('SELECT task."id", task."status"')) {
          const ids = values?.[0] as string[]
          return { rows: ids.map(id => tasks.get(id)).filter(Boolean), rowCount: ids.length }
        }
        if (sql.includes('SELECT event."type", event."payload"')) return { rows: events, rowCount: events.length }
        if (sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = \'cancelled\'')) {
          const row = tasks.get(String(values?.[0]))
          if (row) row.status = "cancelled"
          return { rows: [], rowCount: row ? 1 : 0 }
        }
        if (sql.startsWith('UPDATE "agent_items" AS item')) {
          revision = Number(values?.[5])
          return { rows: [{ stepId: null, status: "streaming", phase: null, startedAt: new Date("2026-09-01T00:00:00.000Z"), completedAt: null, createdAt: new Date("2026-09-01T00:00:00.000Z") }], rowCount: 1 }
        }
        if (sql.startsWith('UPDATE "agent_sessions" AS session')) return { rows: [{ eventSequence: "11" }], rowCount: 1 }
        if (sql.startsWith('INSERT INTO "agent_events"')) {
          events.push({ type: String(values?.[6]), payload: JSON.parse(String(values?.[10])) as unknown })
          return { rows: [], rowCount: 1 }
        }
        if (sql.startsWith('INSERT INTO "agent_outbox"') || sql.startsWith('DELETE FROM "agent_outbox"')) return { rows: [], rowCount: 1 }
        return { rows: [], rowCount: 0 }
      }),
    }

    await reconcileGraphDependents(client as unknown as Pick<pg.PoolClient, "query">, scope, new Date("2026-09-02T00:00:00.000Z"))

    expect(tasks.get("dependent-1")?.status).toBe("cancelled")
    expect(events).toContainEqual(expect.objectContaining({ type: "item.delta", payload: expect.objectContaining({ kind: "lifecycle", event: expect.objectContaining({ type: "task.cancelled", nodeKey: "dependent" }) }) }))
    expect(client.query.mock.calls.some(([sql, params]) => sql.startsWith('DELETE FROM "agent_outbox"') && params?.[1] === "subagent-dispatch:dependent-1")).toBe(true)
    expect(client.query.mock.calls.some(([sql, params]) => sql.startsWith('UPDATE "sub_agent_tasks" SET "status" = \'cancelled\'') && params?.[0] === "dependent-1" && params?.[7] === dependentStatus)).toBe(true)
  })

  it.each([
    ["legacy-unverified completion", "legacy_unverified", { status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: "item-source", finalText: "done", structuredResult: { schemaVersion: "agent-harness.v2.role-result.v1", role: "analyst", status: "completed", findings: [], evidence: [], summary: "done" } }, "waiting", "waiting", false],
    ["typed completion without verifier proof", "typed", { status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: "item-source", finalText: "done", structuredResult: { schemaVersion: "agent-harness.v2.role-result.v1", role: "analyst", status: "completed", findings: [], evidence: [], summary: "done" } }, "waiting", "waiting", false],
    ["legacy-unverified queued dependent", "legacy_unverified", { status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: "item-source", finalText: "done", structuredResult: { schemaVersion: "agent-harness.v2.role-result.v1", role: "analyst", status: "completed", findings: [], evidence: [], summary: "done" } }, "queued", "waiting", false],
    ["legacy-unverified queued dependent and descendant", "legacy_unverified", { status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: "item-source", finalText: "done", structuredResult: { schemaVersion: "agent-harness.v2.role-result.v1", role: "analyst", status: "completed", findings: [], evidence: [], summary: "done" } }, "queued", "queued", false],
    ["completed typed intermediary with a legacy ancestor", "legacy_unverified", { status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: "item-source", finalText: "done", structuredResult: { schemaVersion: "agent-harness.v2.role-result.v1", role: "analyst", status: "completed", findings: [], evidence: [], summary: "done" } }, "queued", "queued", true],
  ] as const)("cancels the dependent and its descendant after %s", async (_label, disposition, sourceResult, dependentStatus, descendantStatus, throughIntermediary) => {
    const scope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
    const sourceVerification = {
      schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
      criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
    }
    const source = {
      key: "source", templateId: "analyst", goal: "Analyze", successCriteria: ["done"], dependsOn: [], depth: 1, taskId: "source-1",
      verificationDisposition: disposition, ...(disposition === "typed" ? { verification: sourceVerification } : {}),
    }
    const intermediary = {
      key: "intermediary", templateId: "analyst", goal: "Verify", successCriteria: ["done"], dependsOn: ["source"], depth: 2,
      taskId: "intermediary-1", verificationDisposition: "typed", verification: sourceVerification,
    }
    const parentKey = throughIntermediary ? "intermediary" : "source"
    const dependentDepth = throughIntermediary ? 3 : 2
    const snapshot = {
      schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
      nodes: [source, ...(throughIntermediary ? [intermediary] : []), {
        key: "dependent", templateId: "analyst", goal: "Continue", successCriteria: ["done"], dependsOn: [parentKey], depth: dependentDepth,
        taskId: "dependent-1", verificationDisposition: "typed", verification: sourceVerification,
      }, {
        key: "descendant", templateId: "analyst", goal: "Continue again", successCriteria: ["done"], dependsOn: ["dependent"], depth: dependentDepth + 1,
        taskId: "descendant-1", verificationDisposition: "typed", verification: sourceVerification,
      }],
    }
    const rowsById = new Map<string, { id: string; status: string; role: string; failureReason: string | null; result: unknown; expectedOutputSchema: string; context: unknown; sessionId: string; turnId: string; rootTaskId: string; parentTaskId: string; userId: string }>([
      ["source-1", { id: "source-1", status: "completed", role: "analyst", failureReason: null, result: sourceResult, expectedOutputSchema: "agent-harness.v2.role-result.v1", context: {}, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, userId: scope.userId }],
      ["intermediary-1", { id: "intermediary-1", status: throughIntermediary ? "completed" : "waiting", role: "analyst", failureReason: null, result: null, expectedOutputSchema: "agent-harness.v2.role-result.v1", context: {}, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, userId: scope.userId }],
      ["dependent-1", { id: "dependent-1", status: dependentStatus, role: "analyst", failureReason: null, result: null, expectedOutputSchema: "agent-harness.v2.role-result.v1", context: {}, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, userId: scope.userId }],
      ["descendant-1", { id: "descendant-1", status: descendantStatus, role: "analyst", failureReason: null, result: null, expectedOutputSchema: "agent-harness.v2.role-result.v1", context: {}, sessionId: scope.sessionId, turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, userId: scope.userId }],
    ])
    let revision = 2
    const itemId = taskGraphItemId("root-1")
    const item = { schemaVersion: AGENT_STREAM_SCHEMA_VERSION, id: itemId, sessionId: scope.sessionId, turnId: scope.turnId, stepId: null, taskId: scope.rootTaskId, type: "task_graph", status: "streaming", phase: null, revision, content: snapshot, startedAt: "2026-09-01T00:00:00.000Z", completedAt: null, createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-01T00:00:00.000Z" }
    const proposalPayload = {
      kind: "proposal", fingerprint: "fingerprint", revision,
      receipt: { status: "accepted", revision, nodes: snapshot.nodes.map(node => ({
        key: node.key, taskId: node.taskId,
        status: node.key === "source" || node.key === "dependent" && dependentStatus === "queued" ? "queued" : "waiting",
      })), readyTaskIds: ["source-1", ...(dependentStatus === "queued" ? ["dependent-1"] : [])] },
      item, content: snapshot,
    }
    const events: Array<{ type: string; payload: unknown }> = [{ type: "item.delta", payload: proposalPayload }]
    let sequence = 0
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT task."turnId"')) return { rows: [{ turnId: scope.turnId, rootTaskId: scope.rootTaskId, parentTaskId: scope.parentTaskId, attemptCount: 0, userId: scope.userId }], rowCount: 1 }
      if (sql.includes('SELECT event."payload"')) return { rows: [{ payload: proposalPayload }], rowCount: 1 }
      if (sql.includes('SELECT item."id"')) return { rows: [{ id: itemId, revision, content: snapshot, createdAt: new Date("2026-09-01T00:00:00.000Z") }], rowCount: 1 }
      if (sql.includes('SELECT task."id", task."status"')) {
        const ids = values?.[0] as string[]
        return { rows: ids.map(id => rowsById.get(id)).filter(Boolean), rowCount: ids.length }
      }
      if (sql.includes('SELECT event."type"')) return { rows: events, rowCount: events.length }
      if (sql.includes('UPDATE "sub_agent_tasks" SET "status" = \'cancelled\'')) {
        const row = rowsById.get(String(values?.[0]))!
        row.status = "cancelled"
        row.failureReason = sql.includes('"failureReason" = $6') ? String(values?.[5]) : "Prerequisite results could not be safely materialized."
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_items" AS item')) {
        revision = Number(values?.[5])
        return { rows: [{ stepId: null, status: "streaming", phase: null, startedAt: new Date("2026-09-01T00:00:00.000Z"), completedAt: null, createdAt: new Date("2026-09-01T00:00:00.000Z") }], rowCount: 1 }
      }
      if (sql.includes('UPDATE "agent_sessions" AS session')) return { rows: [{ eventSequence: String(++sequence) }], rowCount: 1 }
      if (sql.includes('INSERT INTO "agent_events"')) {
        events.push({ type: String(values?.[6]), payload: JSON.parse(String(values?.[10])) as unknown })
        return { rows: [], rowCount: 1 }
      }
      if (sql.includes('INSERT INTO "agent_outbox"') || sql.includes('DELETE FROM "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 0 }
    })

    await reconcileGraphDependents({ query } as unknown as Pick<pg.PoolClient, "query">, scope, new Date("2026-09-02T00:00:00.000Z"))

    expect(rowsById.get("dependent-1")?.status).toBe("cancelled")
    expect(rowsById.get("dependent-1")?.failureReason).toBe(disposition === "legacy_unverified" ? "A prerequisite task was not verified." : "Prerequisite results could not be safely materialized.")
    expect(rowsById.get("descendant-1")?.status).toBe("cancelled")
    expect(events.filter(event => (event.payload as { kind?: unknown }).kind === "lifecycle")).toHaveLength(2)
    expect(query.mock.calls.some(([sql]) => sql.includes('SET "context"'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))).toBe(true)
    expect(query.mock.calls.some(([sql, params]) => sql.startsWith('DELETE FROM "agent_outbox"') && params?.[1] === "subagent-dispatch:dependent-1")).toBe(true)
    if (dependentStatus === "queued") {
      expect(query.mock.calls.some(([sql, params]) => sql.includes('AND "status" = $8') && params?.[0] === "dependent-1" && params?.[7] === dependentStatus)).toBe(true)
    }
    if (descendantStatus === "queued") {
      expect(query.mock.calls.some(([sql, params]) => sql.includes('AND "status" = $8') && params?.[0] === "descendant-1" && params?.[7] === descendantStatus)).toBe(true)
    }
  })
})
