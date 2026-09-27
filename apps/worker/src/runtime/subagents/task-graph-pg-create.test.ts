import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { createGraphTasks } from "./task-graph-pg-create.js"
import type { TaskGraphScheduleInput } from "./task-graph-command-port.js"
import { createInitialTaskGraphState, TASK_GRAPH_LIMITS, type TaskGraphNodeProposal, type TaskGraphState } from "../planning/task-graph.js"
import { parseTaskGraphSnapshot, taskGraphSnapshot } from "./task-graph-snapshot.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

describe("createGraphTasks", () => {
  it("persists scoped completed direct prerequisite evidence before dispatching a ready child", async () => {
    const scoutResult = {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["job-evidence"] }],
      evidence: [{ id: "job-evidence", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Found one job",
    }
    let createdContext: unknown
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{
        id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running",
        allowedActions: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"],
        modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }], rowCount: 1 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('JOIN "agent_turns" AS turn')) return { rows: [{
        id: "source-1", status: "completed", role: "scout",
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
        result: { status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "item-source", finalText: "Found one job", structuredResult: scoutResult },
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) {
        createdContext = JSON.parse(String(values?.[13])) as unknown
        return { rows: [{ id: "child-2" }], rowCount: 1 }
      }
      if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: {
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        stepId: "step-2", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
      },
      proposal: { expectedRevision: 1, nodes: [{ key: "analysis", templateId: "analyst", goal: "Analyze source", successCriteria: ["done"], dependsOn: ["source"] }] },
      templates: { analyst: {
        role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"],
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" },
      } },
    }
    const current: TaskGraphState = {
      revision: 1, nodes: [{ key: "source", templateId: "scout", goal: "Find source", successCriteria: ["done"], dependsOn: [], depth: 1, status: "completed" }], appliedEvents: [],
    }

    const receipt = await createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, current, new Map([["source", "source-1"]]))

    const stored = createdContext as Record<string, unknown>
    const dependencyEvidence = stored.taskGraphDependencyResults as Record<string, unknown>
    expect(receipt.readyTaskIds).toEqual(["child-2"])
    expect(dependencyEvidence.items).toMatchObject([{
      dependencyKey: "source", role: "scout", taskStatus: "completed",
      result: {
        availability: "available", trust: "untrusted", role: "scout", status: "completed",
        candidateCount: 1, evidenceCount: 1,
        candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] }],
      },
    }])
    expect(JSON.stringify(dependencyEvidence)).not.toContain("job-evidence")
    expect(query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBeDefined()
  })

  it("allows a new bounded plan after an earlier child completed", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      calls.push({ sql, values })
      if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{
        id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running", allowedActions: [],
        modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }], rowCount: 1 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: "child-2" }], rowCount: 1 }
      if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const current: TaskGraphState = {
      revision: 1,
      nodes: [{ key: "first", templateId: "analyst", goal: "Inspect prior result", successCriteria: ["done"], dependsOn: [], depth: 1, status: "completed" }],
      appliedEvents: [],
    }
    const input: TaskGraphScheduleInput = {
      scope: {
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        stepId: "step-2", turnLeaseOwner: "turn-owner", turnLeaseVersion: 1, parentLeaseOwner: "parent-owner", parentAttemptCount: 1,
      },
      proposal: { expectedRevision: 1, nodes: [{ key: "second", templateId: "analyst", goal: "Continue after prior result", successCriteria: ["done"], dependsOn: [] }] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }

    const result = await createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, current, new Map([["first", "child-1"]]))

    expect(result.state.nodes).toHaveLength(2)
    expect(result.created).toMatchObject([{ key: "second", taskId: "child-2", status: "queued" }])
    expect(calls.filter(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toHaveLength(1)
    expect(calls.find(call => call.sql.includes("COUNT(*)::int"))?.sql).toContain("NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')")
  })

  it("keeps a single proposal within the active fan-out cap", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 1, nodes: [
        { key: "second", templateId: "analyst", goal: "one", successCriteria: ["done"], dependsOn: [] },
        { key: "third", templateId: "analyst", goal: "two", successCriteria: ["done"], dependsOn: [] },
      ] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    } satisfies TaskGraphScheduleInput

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, { revision: 1, nodes: [], appliedEvents: [] }, new Map()))
      .rejects.toThrow("task_graph_proposal_fan_out_limit")
    expect(query).not.toHaveBeenCalled()
  })

  it("keeps the proposal cap at 32,000 UTF-8 bytes", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const proposal = {
      expectedRevision: 0,
      nodes: Array.from({ length: 8 }, (_, index) => ({
        key: `node-${index}`,
        templateId: "analyst",
        goal: "😀".repeat(600),
        successCriteria: Array.from({ length: 8 }, () => "😀".repeat(160)),
        dependsOn: index === 0 ? [] : [`node-${index - 1}`],
      })),
    }
    expect(Buffer.byteLength(JSON.stringify(proposal), "utf8")).toBeGreaterThan(TASK_GRAPH_LIMITS.maxProposalBytes)
    const input = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal,
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    } satisfies TaskGraphScheduleInput

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }, createInitialTaskGraphState(), new Map()))
      .rejects.toThrow("task_graph_proposal_too_large")
    expect(query).not.toHaveBeenCalled()
  })

  it("checks the 40,000-byte snapshot cap before inserting child tasks", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const keys = Array.from({ length: 7 }, (_, index) => `prior-${index}`)
    const current: TaskGraphState = {
      revision: 7,
      nodes: keys.map((key, index) => ({
        key,
        templateId: "analyst",
        goal: "😀".repeat(400),
        successCriteria: Array.from({ length: 8 }, () => "😀".repeat(120)),
        dependsOn: index === 0 ? [] : [keys[index - 1]!],
        depth: index + 1,
        status: "completed",
      })),
      appliedEvents: [],
    }
    const priorIds = new Map(keys.map((key, index) => [key, `subagent-prior-${index}`] as const))
    expect(() => taskGraphSnapshot(current, priorIds)).not.toThrow()
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 7, nodes: [{
        key: "next", templateId: "analyst", goal: "g".repeat(1200),
        successCriteria: Array.from({ length: 8 }, () => "c".repeat(320)), dependsOn: [keys[6]!],
      }] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }, current, priorIds))
      .rejects.toThrow("task_graph_snapshot_too_large")
    expect(query).not.toHaveBeenCalled()
  })

  it("rejects a new node whose prerequisite already failed", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 2, nodes: [{ key: "next", templateId: "analyst", goal: "continue", successCriteria: ["done"], dependsOn: ["failed"] }] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }
    const current: TaskGraphState = {
      revision: 2, nodes: [{ key: "failed", templateId: "analyst", goal: "prior", successCriteria: ["done"], dependsOn: [], depth: 1, status: "failed" }], appliedEvents: [],
    }

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, current, new Map([["failed", "child-1"]])))
      .rejects.toThrow("task_graph_dependency_blocked")
    expect(query).not.toHaveBeenCalled()
  })

  it("rejects direct persistence inputs outside the canonical snapshot bounds before any database write", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const oversizedTemplateId = "t".repeat(129)
    const templates = {
      analyst: { role: "analyst", taskType: "research", allowedActions: [] },
      [oversizedTemplateId]: { role: "analyst", taskType: "research", allowedActions: [] },
    }
    const valid: TaskGraphNodeProposal = { key: "bounded", templateId: "analyst", goal: "valid", successCriteria: ["valid"], dependsOn: [] }
    const invalidNodes: TaskGraphNodeProposal[] = [
      { ...valid, goal: "g".repeat(1201) },
      { ...valid, successCriteria: ["c".repeat(321)] },
      { ...valid, successCriteria: Array.from({ length: 9 }, (_, index) => `criterion ${index}`) },
      { ...valid, key: "k".repeat(129) },
      { ...valid, templateId: oversizedTemplateId },
    ]
    const parent = { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 8, maxAttempts: 2 } } }
    const initial = createInitialTaskGraphState()

    for (const node of invalidNodes) {
      const input: TaskGraphScheduleInput = {
        scope: {
          userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
          stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1,
        },
        proposal: { expectedRevision: 0, nodes: [node] },
        templates,
      }
      await expect(createGraphTasks(client, input, parent, initial, new Map())).rejects.toThrow()
    }

    expect(query).not.toHaveBeenCalled()
  })

  it("round-trips a maximum valid proposal through the persisted snapshot parser", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{
        id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running", allowedActions: [],
        modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }], rowCount: 1 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: "child-1" }], rowCount: 1 }
      if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const node: TaskGraphNodeProposal = {
      key: "k".repeat(128), templateId: "analyst", goal: "g".repeat(1200),
      successCriteria: Array.from({ length: 8 }, () => "c".repeat(320)), dependsOn: [],
    }
    const input: TaskGraphScheduleInput = {
      scope: {
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1,
      },
      proposal: { expectedRevision: 0, nodes: [node] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }
    const result = await createGraphTasks(client, input, {
      budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } },
    }, createInitialTaskGraphState(), new Map())

    expect(parseTaskGraphSnapshot(result.snapshot)).toEqual(result.snapshot)
  })
})

function taskRow() {
  return {
    id: "child-2", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    path: "/root-1/child-2", depth: 1, role: "analyst", taskType: "research", status: "queued", goal: "Continue after prior result",
    constraints: [], successCriteria: ["done"], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null,
    attemptCount: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
    budgetSnapshot: {}, modelProfileSnapshot: {}, toolPolicySnapshot: {},
  }
}
