import { describe, expect, it } from "vitest"
import { projectSelectedJobMemory, type SelectedJobMemoryRecord } from "./selected-job-memory.js"
import { revalidateSelectedJobHistoryGraph } from "./selected-job-history-graph.js"
import { currentTaskGraph, loadTaskGraph, type GraphIdentityScope } from "../subagents/task-graph-pg-state.js"
import type pg from "pg"

const scope: GraphIdentityScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-old", rootTaskId: "root-old", parentTaskId: "root-old",
}
const itemContent = {
  schemaVersion: "agent-harness.v2.task-graph",
  nodes: [{ key: "scout", templateId: "scout", goal: "Find jobs", successCriteria: ["Find one role"], dependsOn: [], depth: 1, taskId: "child-scout" }],
}

function graphClient(options: { revision?: number; content?: unknown; databaseError?: Error } = {}) {
  const queries: Array<{ sql: string; values?: readonly unknown[] }> = []
  const client = {
    async query(sql: string, values?: readonly unknown[]) {
      queries.push({ sql, values })
      if (options.databaseError && sql.includes('FROM "agent_items"')) throw options.databaseError
      if (sql.includes('FROM "agent_items"')) return { rows: [{ id: "graph-item", revision: options.revision ?? 1, content: options.content ?? itemContent }] }
      if (sql.includes("ANY($1::text[])")) return { rows: [{ id: "child-scout", status: "completed", role: "scout", taskType: "scout", expectedOutputSchema: {}, failureReason: null, result: null }] }
      if (sql.includes('FROM "agent_events"')) return { rows: [] }
      throw new Error(`unexpected query: ${sql}`)
    },
  }
  return { client: client as unknown as Pick<pg.PoolClient, "query">, queries }
}

async function savedRecord(client: Pick<pg.PoolClient, "query">, throughSequence = "70"): Promise<SelectedJobMemoryRecord> {
  const graph = currentTaskGraph(await loadTaskGraph(client, scope, false))
  const record = projectSelectedJobMemory({ jobId: "job-1", sourceTurnId: scope.turnId,
    sourceRootTaskId: scope.rootTaskId, throughSequence, graph })
  if (!record) throw new Error("fixture graph did not project")
  return record
}

describe("selected-job history graph revalidation", () => {
  it("uses the saved source scope and lower-level typed graph loader without locking or relying on the saved digest", async () => {
    const fixture = graphClient()
    const candidate = await savedRecord(fixture.client)
    const before = fixture.queries.length
    const validated = await revalidateSelectedJobHistoryGraph(fixture.client, scope, candidate)

    expect(validated).toEqual(candidate)
    const reads = fixture.queries.slice(before)
    expect(reads[0]?.sql).toContain('item."type" = \'task_graph\'')
    expect(reads[0]?.sql).not.toContain("FOR UPDATE")
    expect(reads[0]?.values).toEqual([expect.any(String), scope.sessionId, scope.turnId, scope.rootTaskId, scope.userId])
  })

  it("reprojects changed persisted graph state so the store can reject stale self-digested history", async () => {
    const initial = graphClient()
    const stale = await savedRecord(initial.client)
    const changed = graphClient({ revision: 2 })

    const rebuilt = await revalidateSelectedJobHistoryGraph(changed.client, scope, stale)

    expect(rebuilt?.graphRevision).toBe(2)
    expect(rebuilt?.graphDigest).not.toBe(stale.graphDigest)
  })

  it("omits known malformed persisted graph data but propagates database failures", async () => {
    const malformed = graphClient({ content: { schemaVersion: "wrong", nodes: [] } })
    const candidate = await savedRecord(graphClient().client)
    await expect(revalidateSelectedJobHistoryGraph(malformed.client, scope, candidate)).resolves.toBeUndefined()

    const databaseError = Object.assign(new Error("read denied"), { code: "42501" })
    const denied = graphClient({ databaseError })
    await expect(revalidateSelectedJobHistoryGraph(denied.client, scope, candidate)).rejects.toBe(databaseError)
  })
})
