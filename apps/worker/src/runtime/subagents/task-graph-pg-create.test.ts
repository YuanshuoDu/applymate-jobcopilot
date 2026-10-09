import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import { createGraphTasks } from "./task-graph-pg-create.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, type TaskGraphScheduleInput } from "./task-graph-command-port.js"
import { createInitialTaskGraphState, TASK_GRAPH_LIMITS, type TaskGraphNodeProposal, type TaskGraphState } from "../planning/task-graph.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { parseTaskGraphSnapshot, taskGraphSnapshot } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFIER_VERSION } from "./task-graph-pg-verification.js"
import { taskGraphResultDigest } from "./task-graph-pg-verification.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"

const analystVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [{ id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } }],
} as const
const scoutVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout",
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }],
} as const

function plannedNode(node: Omit<TaskGraphNodeProposal, "verification">): TaskGraphNodeProposal {
  return { ...node, verification: analystVerification }
}

function ownedTurnScopeRow(sql: string, values?: unknown[]) {
  if (sql.startsWith('SELECT "rootTaskId", "turnId" FROM "sub_agent_tasks"')) {
    return values?.[0] === "root-1" && values?.[1] === "session-1"
      ? { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  if (sql.startsWith('SELECT root."id", root."turnId"') && sql.includes("FOR UPDATE")) {
    return values?.[0] === "root-1" && values?.[1] === "session-1"
      ? { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  if (sql.startsWith('SELECT "id", "rootTaskId", "path", "depth"') && sql.includes("FOR UPDATE")) {
    return values?.[0] === "root-1" && values?.[1] === "session-1"
      ? { rows: [{
        id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running",
        allowedActions: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"],
        modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  if (sql.startsWith('SELECT "id" FROM "agent_turns"') && sql.includes("FOR UPDATE")) {
    return values?.[0] === "turn-1" && values?.[1] === "session-1" && values?.[2] === "user-1"
      ? { rows: [{ id: "turn-1" }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  if (sql.startsWith('SELECT session."id" FROM "agent_sessions"')) {
    return values?.[0] === "session-1" && values?.[1] === "user-1" && values?.[2] === "turn-1"
      ? { rows: [{ id: "session-1" }], rowCount: 1 }
      : { rows: [], rowCount: 0 }
  }
  return undefined
}

describe("createGraphTasks", () => {
  it("persists scoped completed direct prerequisite evidence before dispatching a ready child", async () => {
    const scoutResult = {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["job-evidence"] }],
      evidence: [{ id: "job-evidence", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Found one job",
    }
    let createdContext: unknown
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const admission = ownedTurnScopeRow(sql, values)
      if (admission) return admission
      if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{
        id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running",
        allowedActions: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"],
        modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }], rowCount: 1 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('JOIN "agent_turns" AS turn')) return { rows: [{
        id: "source-1", status: "completed", role: "scout",
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
        result: {
          status: "completed", stepCount: 2, toolCallCount: 1, finalItemId: "item-source", finalText: "Found one job", structuredResult: scoutResult,
          taskGraphVerificationReport: {
            verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met",
            criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }],
            evidenceDigest: "a".repeat(64), resultDigest: taskGraphResultDigest(scoutResult),
          },
        },
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
      proposal: { expectedRevision: 1, nodes: [plannedNode({ key: "analysis", templateId: "analyst", goal: "Analyze source", successCriteria: ["done"], dependsOn: ["source"] })] },
      templates: { analyst: {
        role: "analyst", taskType: "job_analysis", allowedActions: ["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"],
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" },
      } },
    }
    const current: TaskGraphState = {
      revision: 1, nodes: [{ key: "source", templateId: "scout", goal: "Find source", successCriteria: ["done"], dependsOn: [], depth: 1, status: "completed", verificationDisposition: "typed", verification: scoutVerification }], appliedEvents: [],
    }

    const receipt = await createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, current, new Map([["source", "source-1"]]), new Map([["source", "predates_current_inputs"]]))

    const stored = createdContext as Record<string, unknown>
    const dependencyEvidence = stored.taskGraphDependencyResults as Record<string, unknown>
    expect(receipt.readyTaskIds).toEqual(["child-2"])
    expect(dependencyEvidence.items).toMatchObject([{
      dependencyKey: "source", role: "scout", taskStatus: "completed",
      sourceIntent: { trust: "untrusted", goal: "Find source", successCriteria: ["done"], inputRelation: "predates_current_inputs" },
      result: {
        availability: "available", trust: "untrusted", role: "scout", status: "completed",
        candidateCount: 1, evidenceCount: 1,
        candidates: [{ jobId: "job-1", source: "greenhouse", evidenceKinds: ["job"] }],
      },
    }])
    expect(JSON.stringify(dependencyEvidence)).not.toContain("job-evidence")
    expect(query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBeDefined()
    const turnLock = query.mock.calls.findIndex(([sql]) => sql.startsWith('SELECT "id" FROM "agent_turns"') && sql.includes("FOR UPDATE"))
    const admissionCheck = query.mock.calls.findIndex(([sql]) => sql.startsWith('SELECT session."id" FROM "agent_sessions"'))
    const taskInsert = query.mock.calls.findIndex(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))
    expect(turnLock).toBeGreaterThanOrEqual(0)
    expect(turnLock).toBeLessThan(admissionCheck)
    expect(admissionCheck).toBeLessThan(taskInsert)
  })

  it("rejects a plan transitively dependent on a completed legacy-unverified source", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{
        id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running", allowedActions: [],
        modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }], rowCount: 1 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: "child-2" }], rowCount: 1 }
      if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.includes('SET "status" = \'waiting\'')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 1, nodes: [
        plannedNode({ key: "after-next", templateId: "analyst", goal: "Continue again", successCriteria: ["done"], dependsOn: ["next"] }),
        plannedNode({ key: "next", templateId: "analyst", goal: "Continue", successCriteria: ["done"], dependsOn: ["source"] }),
      ] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }
    const current: TaskGraphState = {
      revision: 1, nodes: [{ key: "source", templateId: "scout", goal: "Find source", successCriteria: ["done"], dependsOn: [], depth: 1, status: "completed", verificationDisposition: "legacy_unverified" }], appliedEvents: [],
    }

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 2, maxAttempts: 2 } } }, current, new Map([["source", "source-1"]])))
      .rejects.toThrow("task_graph_dependency_unverified")

    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("rejects a proposal depending on a completed typed node tainted by a legacy source", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 1 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 2, nodes: [plannedNode({ key: "follow-up", templateId: "analyst", goal: "Continue", successCriteria: ["done"], dependsOn: ["typed-intermediary"] })] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }
    const current: TaskGraphState = {
      revision: 2, nodes: [
        { key: "legacy-source", templateId: "scout", goal: "Find source", successCriteria: ["done"], dependsOn: [], depth: 1, status: "completed", verificationDisposition: "legacy_unverified" },
        { key: "typed-intermediary", templateId: "analyst", goal: "Analyze source", successCriteria: ["done"], dependsOn: ["legacy-source"], depth: 2, status: "completed", verificationDisposition: "typed", verification: analystVerification },
      ], appliedEvents: [],
    }

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, current,
      new Map([["legacy-source", "source-1"], ["typed-intermediary", "intermediary-1"]])))
      .rejects.toThrow("task_graph_dependency_unverified")

    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("allows a typed follow-up across a specialized boundary after a tainted typed node", async () => {
    const artifactRef = {
      artifactId: "artifact-1", version: 1,
      contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}`,
    }
    const writerResult = { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef }
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const admission = ownedTurnScopeRow(sql, values)
      if (admission) return admission
      if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{
        id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running", allowedActions: [],
        modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }], rowCount: 1 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('task."expectedOutputSchema"')) return { rows: [{
        id: "writer-1", status: "completed", role: "writer", failureReason: null,
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" },
        result: { status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: "item-writer", finalText: "Draft saved", structuredResult: writerResult },
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: "follow-up-1" }], rowCount: 1 }
      if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [{ ...taskRow(), id: "follow-up-1" }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 3, nodes: [plannedNode({ key: "follow-up", templateId: "analyst", goal: "Continue from the reviewed draft", successCriteria: ["done"], dependsOn: ["specialized-boundary"] })] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }
    const current: TaskGraphState = {
      revision: 3, nodes: [
        { key: "legacy-source", templateId: "scout", goal: "Find source", successCriteria: ["done"], dependsOn: [], depth: 1, status: "completed", verificationDisposition: "legacy_unverified" },
        { key: "typed-intermediary", templateId: "analyst", goal: "Analyze source", successCriteria: ["done"], dependsOn: ["legacy-source"], depth: 2, status: "completed", verificationDisposition: "typed", verification: analystVerification },
        { key: "specialized-boundary", templateId: "cover_letter_writer", goal: "Save draft", successCriteria: ["Persist draft"], dependsOn: ["typed-intermediary"], depth: 3, status: "completed", verificationDisposition: "specialized" },
      ], appliedEvents: [],
    }

    const receipt = await createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, current,
      new Map([["legacy-source", "source-1"], ["typed-intermediary", "intermediary-1"], ["specialized-boundary", "writer-1"]]))

    expect(receipt.created).toMatchObject([{ key: "follow-up", taskId: "follow-up-1", status: "queued" }])
    expect(receipt.readyTaskIds).toEqual(["follow-up-1"])
  })

  it("rejects a typed completed source when its persisted passed report is missing", async () => {
    const scoutResult = {
      schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
      candidates: [{ jobId: "job-1", source: "greenhouse", url: null, evidenceIds: ["job-evidence"] }],
      evidence: [{ id: "job-evidence", kind: "job", ref: "job-1", source: "greenhouse" }], summary: "Found one job",
    }
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{
        id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running", allowedActions: [],
        modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {},
      }], rowCount: 1 }
      if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
      if (sql.includes('JOIN "agent_turns" AS turn')) return { rows: [{
        id: "source-1", status: "completed", role: "scout", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
        result: { status: "completed", stepCount: 1, toolCallCount: 1, finalItemId: "item-source", finalText: "Found one job", structuredResult: scoutResult },
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      }], rowCount: 1 }
      if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: "child-2" }], rowCount: 1 }
      if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [taskRow()], rowCount: 1 }
      if (sql.includes('SET "status" = \'waiting\'')) return { rows: [], rowCount: 1 }
      return { rows: [], rowCount: 1 }
    })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 1, nodes: [plannedNode({ key: "next", templateId: "analyst", goal: "Continue", successCriteria: ["done"], dependsOn: ["source"] })] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }
    const current: TaskGraphState = {
      revision: 1, nodes: [{ key: "source", templateId: "scout", goal: "Find source", successCriteria: ["done"], dependsOn: [], depth: 1, status: "completed", verificationDisposition: "typed", verification: scoutVerification }], appliedEvents: [],
    }

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, current, new Map([["source", "source-1"]])))
      .rejects.toThrow("task_graph_dependency_result_invalid")

    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("allows a new bounded plan after an earlier child completed", async () => {
    const calls: Array<{ sql: string; values?: unknown[] }> = []
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const admission = ownedTurnScopeRow(sql, values)
      if (admission) return admission
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
      proposal: { expectedRevision: 1, nodes: [plannedNode({ key: "second", templateId: "analyst", goal: "Continue after prior result", successCriteria: ["done"], dependsOn: [] })] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }

    const result = await createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, current, new Map([["first", "child-1"]]))

    expect(result.state.nodes).toHaveLength(2)
    expect(result.created).toMatchObject([{ key: "second", taskId: "child-2", status: "queued" }])
    expect(result.snapshot.nodes).toMatchObject([
      { key: "first", verificationDisposition: "legacy_unverified" },
      { key: "second", verificationDisposition: "typed", verification: analystVerification },
    ])
    expect(calls.filter(call => call.sql.startsWith('INSERT INTO "agent_outbox"'))).toHaveLength(1)
    expect(calls.find(call => call.sql.includes("COUNT(*)::int"))?.sql).toContain("NOT IN ('completed', 'failed', 'interrupted', 'cancelled', 'closed')")
  })

  it("keeps a single proposal within the active fan-out cap", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 1, nodes: [
        plannedNode({ key: "second", templateId: "analyst", goal: "one", successCriteria: ["done"], dependsOn: [] }),
        plannedNode({ key: "third", templateId: "analyst", goal: "two", successCriteria: ["done"], dependsOn: [] }),
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
      })).map(node => plannedNode(node)),
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
      proposal: { expectedRevision: 7, nodes: [plannedNode({
        key: "next", templateId: "analyst", goal: "g".repeat(1200),
        successCriteria: Array.from({ length: 8 }, () => "c".repeat(320)), dependsOn: [keys[6]!],
      })] },
      templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
    }

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }, current, priorIds))
      .rejects.toThrow("task_graph_snapshot_too_large")
    expect(query).not.toHaveBeenCalled()
  })

  it("rejects a registered unsupported template before creating or scheduling a child", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: {
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1,
      },
      proposal: { expectedRevision: 0, nodes: [{
        key: "custom", templateId: "custom_agent", goal: "Do custom work", successCriteria: ["Complete custom work"], dependsOn: [],
      }] },
      templates: { custom_agent: { role: "analyst", taskType: "research", allowedActions: [] } },
    }

    await expect(createGraphTasks(client, input, {
      budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } },
    }, createInitialTaskGraphState(), new Map()))
      .rejects.toThrow("task_graph_snapshot_template_unsupported")
    expect(query).not.toHaveBeenCalled()
  })

  it("rejects a new node whose prerequisite already failed", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 2, nodes: [plannedNode({ key: "next", templateId: "analyst", goal: "continue", successCriteria: ["done"], dependsOn: ["failed"] })] },
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
    const valid: TaskGraphNodeProposal = plannedNode({ key: "bounded", templateId: "analyst", goal: "valid", successCriteria: ["valid"], dependsOn: [] })
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
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const admission = ownedTurnScopeRow(sql, values)
      if (admission) return admission
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
    const node: TaskGraphNodeProposal = plannedNode({
      key: "k".repeat(128), templateId: "analyst", goal: "g".repeat(1200),
      successCriteria: Array.from({ length: 8 }, () => "c".repeat(320)), dependsOn: [],
    })
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
    expect(result.snapshot.nodes[0]).toMatchObject({ verificationDisposition: "typed", verification: analystVerification })
    expect(result.state.nodes[0]?.verification).toEqual(analystVerification)
  })

  it("locks the exact failed target and schedules a repair only for unresolved criteria", async () => {
    const fixture = repairFixture()
    const result = await createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds)
    const targetLock = fixture.query.mock.calls.findIndex(([sql]) => sql.includes('task."failureReason"') && sql.includes("FOR UPDATE OF task"))
    const insert = fixture.query.mock.calls.findIndex(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))
    expect(result.created).toMatchObject([{ key: "repair-next", status: "queued" }])
    expect(targetLock).toBeGreaterThan(-1)
    expect(insert).toBeGreaterThan(targetLock)
  })

  it("rejects a criterion already passed by the failed target report", async () => {
    const fixture = repairFixture({ resolved: true })
    await expect(createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds))
      .rejects.toThrow("task_graph_repair_criteria_resolved")
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("rejects a target row outside the exact user/session/turn/root scope", async () => {
    const fixture = repairFixture({ targetMissing: true })
    await expect(createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds))
      .rejects.toThrow("task_graph_repair_target_unresolved")
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("rejects a stale graph-root relation before child writes", async () => {
    const fixture = repairFixture({ rootId: "root-foreign" })
    await expect(createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds))
      .rejects.toThrow("task_graph_repair_target_unresolved")
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("rejects criteria already resolved by a prior server-authored repair receipt", async () => {
    const fixture = repairFixture({ priorReceipt: true })
    await expect(createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds))
      .rejects.toThrow("task_graph_repair_criteria_resolved")
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })

  it("queues a newly planned dependent with the receipt-backed composite while the original row stays failed", async () => {
    const fixture = repairFixture({ priorReceipt: true, scheduleDependent: true })
    const result = await createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds)
    expect(result.created).toMatchObject([{ key: "after-target", status: "queued" }])
    expect(result.state.nodes.find(node => node.key === "target")?.status).toBe("failed")
    const insert = fixture.query.mock.calls.find(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))
    const context = JSON.parse(String(insert?.[1]?.[13])) as Record<string, unknown>
    const evidence = context.taskGraphDependencyResults as { items: Array<Record<string, unknown>> }
    expect(evidence.items[0]).toMatchObject({ dependencyKey: "target", taskStatus: "completed", repairLineage: [{ criterionIds: ["finding-count"] }] })
    expect(evidence.items[0]?.result).toMatchObject({ role: "analyst", findingCount: 1, evidenceCount: 1 })
  })
})

const repairVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [
    { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
    { id: "evidence-count", check: { kind: "evidence_count_gte", minimum: 1 } },
  ],
} as const
type RepairFixtureOptions = { resolved?: boolean; targetMissing?: boolean; rootId?: string; priorReceipt?: boolean; scheduleDependent?: boolean }
function repairFixture(options: RepairFixtureOptions = {}) {
  const relation = { graphRootTaskId: options.rootId ?? "root-1", nodeKey: "target", taskId: "target-1", criterionIds: ["finding-count"] }
  const report = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
    criteria: [
      { criterionId: "finding-count", status: options.resolved ? "passed" : "failed", reasonCode: options.resolved ? "criteria_met" : "criterion_not_met" },
      { criterionId: "evidence-count", status: "failed", reasonCode: "criterion_not_met" },
    ], evidenceDigest: "a".repeat(64), resultDigest: "e".repeat(64),
  }
  const target = { key: "target", templateId: "analyst", goal: "Find evidence", successCriteria: ["find evidence"], dependsOn: [], depth: 1, status: "failed" as const, taskId: "target-1", verificationDisposition: "typed" as const, verification: repairVerification }
  const priorRepair = { key: "repair-old", templateId: "analyst", goal: "Repair finding", successCriteria: ["repair"], dependsOn: [], depth: 1, status: "completed" as const, taskId: "repair-old-1", verificationDisposition: "typed" as const, verification: analystVerification, repairOf: { ...relation, graphRootTaskId: "root-1" } }
  const current: TaskGraphState = { revision: options.priorReceipt ? 2 : 1, nodes: options.priorReceipt ? [target, priorRepair] : [target], appliedEvents: [], repairSatisfiedNodeKeys: options.priorReceipt ? ["target"] : [] }
  const taskIds = new Map<string, string>([["target", "target-1"], ...(options.priorReceipt ? [["repair-old", "repair-old-1"] as [string, string]] : [])])
  const snapshot = taskGraphSnapshot(current, taskIds)
  const repairNode = { key: "repair-next", templateId: "analyst", goal: "Repair the missing finding", successCriteria: ["Resolve the finding"], dependsOn: [], verification: analystVerification, repairOf: relation }
  const input: TaskGraphScheduleInput = {
    scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
    proposal: { expectedRevision: current.revision, nodes: [options.scheduleDependent
      ? plannedNode({ key: "after-target", templateId: "analyst", goal: "Continue from repaired evidence", successCriteria: ["done"], dependsOn: ["target"] })
      : repairNode] },
    templates: { analyst: { role: "analyst", taskType: "research", allowedActions: [] } },
  }
  const evidence = [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }]
  const targetStructured = { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence, summary: "Original incomplete result" }
  const repairStructured = { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 7, evidenceIds: ["read:job:job-1"] }], evidence, summary: "Repair result" }
  const receipt = { schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: "root-1", targetNodeKey: "target", targetTaskId: "target-1", criterionIds: ["finding-count"], repairNodeKey: "repair-old", repairTaskId: "repair-old-1", verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: "b".repeat(64) }
  const priorResult = {
    finalItemId: "repair-item", finalText: "Repair result", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: repairStructured,
    taskGraphVerificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met", criteria: analystVerification.criteria.map(item => ({ criterionId: item.id, status: "passed", reasonCode: "criteria_met" })), evidenceDigest: "b".repeat(64), resultDigest: taskGraphResultDigest(repairStructured) },
    taskGraphRepairReceipt: receipt,
  }
  const targetResult = {
    finalItemId: "target-item", finalText: "Incomplete", status: "completed", stepCount: 1, toolCallCount: 1, structuredResult: targetStructured,
    taskGraphVerificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met", criteria: [
      { criterionId: "finding-count", status: "failed", reasonCode: "criterion_not_met" }, { criterionId: "evidence-count", status: "passed", reasonCode: "criteria_met" },
    ], evidenceDigest: "a".repeat(64), resultDigest: taskGraphResultDigest(targetStructured) },
  }
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const admission = ownedTurnScopeRow(sql, values)
    if (admission) return admission
    if (sql.includes('SELECT item."content"')) return { rows: [{ content: snapshot }], rowCount: 1 }
    if (sql.includes("ANY($1::text[])")) return options.scheduleDependent
      ? { rows: [
        { id: "target-1", status: "failed", failureReason: "task_graph_verification_failed", role: "analyst", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, result: targetResult, ...input.scope, userId: "user-1" },
        { id: "repair-old-1", status: "completed", failureReason: null, role: "analyst", expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst" }, result: priorResult, ...input.scope, userId: "user-1" },
      ], rowCount: 2 }
      : { rows: [{ id: "repair-old-1", status: "completed", result: priorResult }], rowCount: 1 }
    if (sql.includes('task."failureReason"')) return { rows: options.targetMissing ? [] : [{ id: "target-1", status: "failed", role: "analyst", failureReason: "task_graph_verification_failed", result: { taskGraphVerificationReport: report }, rootTaskId: "root-1", parentTaskId: "root-1", sessionId: "session-1", turnId: "turn-1" }], rowCount: options.targetMissing ? 0 : 1 }
    if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: "repair-next-1" }], rowCount: 1 }
    if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [{ ...taskRow(), id: "repair-next-1", goal: repairNode.goal }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [{ id: "outbox-1" }], rowCount: 1 }
    if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{ id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running", allowedActions: [], modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {} }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query, input, current, taskIds, parent: { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 4, maxAttempts: 2 } } } }
}

function taskRow() {
  return {
    id: "child-2", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    path: "/root-1/child-2", depth: 1, role: "analyst", taskType: "research", status: "queued", goal: "Continue after prior result",
    constraints: [], successCriteria: ["done"], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null,
    attemptCount: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
    budgetSnapshot: {}, modelProfileSnapshot: {}, toolPolicySnapshot: {},
  }
}
