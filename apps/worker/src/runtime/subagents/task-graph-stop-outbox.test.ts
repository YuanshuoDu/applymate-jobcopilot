import { describe, expect, it } from "vitest"
import type pg from "pg"
import { drainTaskGraphStopOutbox, TASK_GRAPH_STOP_OUTBOX_TOPIC } from "./task-graph-stop-outbox.js"
import { taskGraphLifecycleKey, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import type { PgSubagentPool } from "./types.js"

type NodeFixture = { key: string; taskId: string; dependsOn: string[]; status: string; attemptCount: number; interruptRequestedAt: Date | null }
type EventFixture = { payload: unknown }
type DispatchFixture = { id: string; aggregateId: string; topic: string; idempotencyKey: string; publishedAt: Date | null }

class FakeStopPool {
  readonly queries: Array<{ sql: string; values: unknown[] }> = []
  readonly events: EventFixture[]
  readonly nodes: NodeFixture[]
  readonly dispatchRows: DispatchFixture[]
  readonly deletedDispatches: unknown[][] = []
  private readonly initialLifecycleCount: number
  publishedAt: Date | null = null
  attemptCount = 0
  lastError: string | null = null
  eventSequence = 20n
  readonly sessionStatus: string

  constructor(options: { nodes: NodeFixture[]; events?: EventFixture[]; sessionStatus?: string }) {
    this.nodes = options.nodes
    this.dispatchRows = [
      ...this.nodes.map(node => ({ id: `pending-${node.taskId}`, aggregateId: "session-1", topic: "agent.subagent.dispatch", idempotencyKey: `subagent-dispatch:${node.taskId}`, publishedAt: null })),
      { id: "unrelated-task", aggregateId: "session-1", topic: "agent.subagent.dispatch", idempotencyKey: "subagent-dispatch:other-task", publishedAt: null },
      { id: "unrelated-session", aggregateId: "session-2", topic: "agent.subagent.dispatch", idempotencyKey: "subagent-dispatch:other-session-task", publishedAt: null },
      { id: "unrelated-topic", aggregateId: "session-1", topic: "agent.task-graph.stop", idempotencyKey: "other-topic:child-1", publishedAt: null },
      { id: "published-task", aggregateId: "session-1", topic: "agent.subagent.dispatch", idempotencyKey: "subagent-dispatch:published-task", publishedAt: new Date("2026-09-25T00:00:00.000Z") },
    ]
    this.events = [...(options.events ?? [])]
    this.initialLifecycleCount = this.events.filter(event => (event.payload as { kind?: unknown })?.kind === "lifecycle").length
    this.sessionStatus = options.sessionStatus ?? "aborted"
  }

  async connect(): Promise<pg.PoolClient> {
    return { query: this.query.bind(this), release: () => undefined } as unknown as pg.PoolClient
  }

  private async query<T = unknown>(sql: string, values: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    this.queries.push({ sql, values })
    let rows: unknown[] = []
    let rowCount = 0
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 }
    if (sql.includes('SELECT "id" FROM "agent_outbox"') && sql.includes('"publishedAt" IS NULL')) {
      rows = this.publishedAt === null ? [{ id: "stop-outbox-1" }] : []
    } else if (sql.includes('FROM "agent_outbox"') && sql.includes('"aggregateId"') && sql.includes('"payload"')) {
      rows = [{ id: "stop-outbox-1", aggregateId: "session-1", payload: { sessionId: "session-1", turnId: "turn-1" }, publishedAt: this.publishedAt }]
    } else if (sql.includes('SELECT session."userId", turn."rootTaskId"')) {
      rows = [{ userId: "user-1", rootTaskId: "root-1", turnStatus: "interrupted" }]
    } else if (sql.includes("set_config('app.user_id'")) {
      rows = [{ "set_config": "user-1" }]
    } else if (sql.includes('SELECT item."id", item."revision", item."content"')) {
      rows = [{
        id: "task-graph-item", revision: 4 + this.events.length - this.initialLifecycleCount,
        content: { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: this.nodes.map(node => ({
          key: node.key, templateId: "analyst", goal: `Inspect ${node.key}`, successCriteria: ["done"],
          dependsOn: node.dependsOn, depth: node.dependsOn.length + 1, taskId: node.taskId,
        })) },
        createdAt: new Date("2026-09-25T00:00:00.000Z"),
      }]
    } else if (sql.includes('SELECT task."id", task."status", task."role", task."failureReason", task."result"')) {
      rows = this.nodes.map(node => ({ id: node.taskId, status: node.status, failureReason: null, result: null }))
    } else if (sql.includes('SELECT event."payload"')) {
      rows = this.events
    } else if (sql.includes('SELECT task."id", task."status", task."attemptCount", task."interruptRequestedAt"')) {
      const node = this.nodes.find(candidate => candidate.taskId === values[0])
      rows = node ? [{ id: node.taskId, status: node.status, attemptCount: node.attemptCount, interruptRequestedAt: node.interruptRequestedAt }] : []
    } else if (sql.includes('task."status" = \'interrupted\'') && sql.includes('task."interruptRequestedAt" IS NOT NULL')) {
      const node = this.nodes.find(candidate => candidate.taskId === values[0])
      rows = node?.status === "interrupted" && node.interruptRequestedAt ? [{ id: node.taskId }] : []
    } else if (sql.includes('UPDATE "agent_items" AS item SET "revision"')) {
      rows = [{ stepId: "step-1", status: "streaming", phase: null, startedAt: null, completedAt: null, createdAt: new Date("2026-09-25T00:00:00.000Z") }]
      rowCount = 1
    } else if (sql.includes('UPDATE "agent_sessions" AS session')) {
      this.eventSequence += 1n
      rows = [{ eventSequence: this.eventSequence }]
      rowCount = 1
    } else if (sql.includes('INSERT INTO "agent_events"')) {
      const payload = JSON.parse(String(values[10])) as unknown
      this.events.push({ payload })
      rowCount = 1
    } else if (sql.includes('INSERT INTO "agent_outbox"')) {
      rowCount = 1
    } else if (sql.includes('DELETE FROM "agent_outbox"')) {
      this.deletedDispatches.push(values)
      const before = this.dispatchRows.length
      const [sessionId, idempotencyKey] = values.map(String)
      const remaining = this.dispatchRows.filter(row => !(row.topic === "agent.subagent.dispatch"
        && row.aggregateId === sessionId && row.idempotencyKey === idempotencyKey && row.publishedAt === null))
      this.dispatchRows.splice(0, this.dispatchRows.length, ...remaining)
      rowCount = before - remaining.length
    } else if (sql.includes('UPDATE "agent_outbox"') && sql.includes('SET "publishedAt" = CURRENT_TIMESTAMP')) {
      this.publishedAt = new Date("2026-09-25T00:01:00.000Z")
      this.attemptCount += 1
      this.lastError = null
      rowCount = 1
    } else if (sql.includes('UPDATE "agent_outbox"') && sql.includes('SET "attemptCount" = "attemptCount" + 1')) {
      this.attemptCount += 1
      this.lastError = String(values[1])
      rowCount = 1
    } else if (sql.trim().startsWith("SELECT")) {
      rows = []
    } else {
      throw new Error(`unhandled_fake_query:${sql}`)
    }
    if (sql.includes("FOR UPDATE") || sql.includes("SELECT")) rowCount = rows.length
    return { rows: rows as T[], rowCount }
  }

}

function node(key: string, taskId: string, dependsOn: string[] = []): NodeFixture {
  return { key, taskId, dependsOn, status: "interrupted", attemptCount: 1, interruptRequestedAt: new Date("2026-09-25T00:00:00.000Z") }
}

function lifecycle(type: string, nodeKey: string, expectedRevision = 3): EventFixture {
  return { payload: { kind: "lifecycle", event: {
    type, nodeKey, expectedRevision,
    idempotencyKey: `existing:${nodeKey}:${type}`,
    ...(type === "task.failed" ? { failureReason: "failed" } : {}),
  } } }
}

const pool = (fake: FakeStopPool) => fake as unknown as PgSubagentPool

function expectDispatchDeletions(fake: FakeStopPool, taskIds: readonly string[]): void {
  const deletes = fake.queries.filter(query => query.sql.includes('DELETE FROM "agent_outbox"'))
  expect(deletes).toHaveLength(taskIds.length)
  expect(deletes.map(query => query.values)).toEqual(taskIds.map(taskId => ["session-1", `subagent-dispatch:${taskId}`]))
  for (const query of deletes) {
    expect(query.sql).toContain("'agent.subagent.dispatch'")
    expect(query.sql).toContain('"aggregateId" = $1')
    expect(query.sql).toContain('"idempotencyKey" = $2')
    expect(query.sql).toContain('"publishedAt" IS NULL')
  }
}

describe("TaskGraph stop outbox projection", () => {
  it("uses the latest persisted active lifecycle event and writes a closed-session receipt", async () => {
    const fake = new FakeStopPool({ nodes: [node("child", "child-1")], events: [lifecycle("task.waiting_for_user", "child")] })

    await expect(drainTaskGraphStopOutbox(pool(fake))).resolves.toBe(1)

    const written = fake.events.map(event => event.payload as { kind?: string; event?: { type?: string; expectedRevision?: number; idempotencyKey?: string } })
      .find(event => event.kind === "lifecycle" && event.event?.type === "task.interrupted")
    expect(written?.event).toMatchObject({
      type: "task.interrupted", expectedRevision: 4,
      idempotencyKey: taskGraphLifecycleKey("root-1", "child", 1, "task.interrupted"),
    })
    expect(fake.queries.find(query => query.sql.includes('UPDATE "agent_sessions" AS session'))?.values[2]).toBe(true)
    expect(fake.publishedAt).toBeInstanceOf(Date)
    expect(TASK_GRAPH_STOP_OUTBOX_TOPIC).toBe("agent.task-graph.stop")
  })

  it("falls back to queued roots and waiting dependency nodes when no lifecycle event exists", async () => {
    const fake = new FakeStopPool({ nodes: [node("root", "child-1"), node("after", "child-2", ["root"])] })

    await expect(drainTaskGraphStopOutbox(pool(fake))).resolves.toBe(1)

    const written = fake.events.map(event => (event.payload as { kind?: string; event?: { nodeKey?: string; expectedRevision?: number } }))
      .filter(event => event.kind === "lifecycle" && event.event?.expectedRevision !== undefined)
      .map(event => event.event)
    expect(written).toEqual([
      expect.objectContaining({ nodeKey: "root", expectedRevision: 4 }),
      expect.objectContaining({ nodeKey: "after", expectedRevision: 5 }),
    ])
    expectDispatchDeletions(fake, ["child-1", "child-2"])
    expect(fake.deletedDispatches).toEqual([
      ["session-1", "subagent-dispatch:child-1"], ["session-1", "subagent-dispatch:child-2"],
    ])
    expect(fake.dispatchRows.map(row => row.id)).toEqual(["unrelated-task", "unrelated-session", "unrelated-topic", "published-task"])
  })

  it("retries instead of projecting over a conflicting terminal receipt", async () => {
    const fake = new FakeStopPool({ nodes: [node("child", "child-1")], events: [lifecycle("task.completed", "child")] })

    await expect(drainTaskGraphStopOutbox(pool(fake))).resolves.toBe(0)

    expect(fake.publishedAt).toBeNull()
    expect(fake.attemptCount).toBe(1)
    expect(fake.lastError).toBe("processing_error")
    expect(fake.events).toHaveLength(1)
  })

  it("leaves running tasks to their existing lease and interrupt path", async () => {
    const running = { ...node("child", "child-1"), status: "running" }
    const fake = new FakeStopPool({ nodes: [running] })

    await expect(drainTaskGraphStopOutbox(pool(fake))).resolves.toBe(1)

    expect(fake.events).toHaveLength(0)
    expect(fake.publishedAt).toBeInstanceOf(Date)
    expectDispatchDeletions(fake, ["child-1"])
    expect(fake.deletedDispatches).toEqual([["session-1", "subagent-dispatch:child-1"]])
    expect(fake.dispatchRows.map(row => row.id)).toEqual(["unrelated-task", "unrelated-session", "unrelated-topic", "published-task"])
  })
})
