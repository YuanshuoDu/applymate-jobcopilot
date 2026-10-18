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
import { selectVerifiedScheduledDraftCandidate } from "./scheduled-draft-candidate.js"

vi.mock("./scheduled-draft-candidate.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./scheduled-draft-candidate.js")>()
  return { ...actual, selectVerifiedScheduledDraftCandidate: vi.fn() }
})

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

type WriterReviewSeed = Readonly<{
  key: string
  templateId: "cover_letter_writer" | "cover_letter_reviewer"
  dependsOn: readonly string[]
  status?: TaskGraphState["nodes"][number]["status"]
}>

const writerReviewTemplates = {
  cover_letter_writer: { role: "writer", taskType: "cover_letter_draft", allowedActions: [] },
  cover_letter_reviewer: { role: "reviewer", taskType: "cover_letter_review", allowedActions: [] },
} as const

function writerReviewNode(seed: WriterReviewSeed): TaskGraphNodeProposal {
  return { key: seed.key, templateId: seed.templateId, goal: "Prepare a selected-job cover letter", successCriteria: ["Complete the task"], dependsOn: seed.dependsOn }
}

function writerReviewState(seeds: readonly WriterReviewSeed[], revision = 1): TaskGraphState {
  const byKey = new Map(seeds.map(seed => [seed.key, seed] as const))
  const depth = (seed: WriterReviewSeed): number => seed.dependsOn.length
    ? Math.max(...seed.dependsOn.map(key => depth(byKey.get(key)!))) + 1 : 1
  return {
    revision, appliedEvents: [],
    nodes: seeds.map(seed => ({ ...writerReviewNode(seed), depth: depth(seed), status: seed.status ?? "completed" })),
  }
}

function writerReviewInput(nodes: readonly WriterReviewSeed[], expectedRevision: number): TaskGraphScheduleInput {
  return {
    scope: {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
      stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1,
    },
    proposal: { expectedRevision, nodes: nodes.map(writerReviewNode) },
    templates: writerReviewTemplates,
  }
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
  it("strictly rejects an initial plan missing one canonical requirement before database work", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 0, nodes: [plannedNode({ key: "analysis", templateId: "analyst", goal: "Analyze results", successCriteria: ["done"], dependsOn: [] })] },
      templates: {
        analyst: { role: "analyst", taskType: "analysis", allowedActions: [] },
        scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] },
      },
      verificationRequirements: { status: "valid", requirements: [
        { id: "finding-count", kind: "finding_count_gte", minimum: 1 },
        { id: "candidate-count", kind: "candidate_count_gte", minimum: 2 },
      ] },
    }
    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 4, maxAttempts: 2 } } }, createInitialTaskGraphState(), new Map()))
      .rejects.toMatchObject({ code: "task_graph_objective_coverage_incomplete", requirements: [
        { id: "candidate-count", kind: "candidate_count_gte", role: "scout", minimum: 2 },
      ] })
    expect(query).not.toHaveBeenCalled()
  })

  it("rejects an uncovered revision after locking its repair target and before any writes", async () => {
    const fixture = repairFixture()
    const input: TaskGraphScheduleInput = { ...fixture.input, verificationRequirements: { status: "valid", requirements: [
      { id: "finding-count", kind: "finding_count_gte", minimum: 1 },
      { id: "candidate-count", kind: "candidate_count_gte", minimum: 1 },
    ] } }
    await expect(createGraphTasks(fixture.client, input, fixture.parent, fixture.current, fixture.taskIds))
      .rejects.toMatchObject({ code: "task_graph_objective_coverage_incomplete", requirements: [
        { id: "candidate-count", kind: "candidate_count_gte", role: "scout", minimum: 1 },
      ] })
    expect(fixture.query.mock.calls.some(([sql]) => sql.includes('task."failureReason"'))).toBe(true)
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
  })

  it("preserves the filler template's empty actions while generic roles keep parent action inheritance", async () => {
    const create = async (templateId: string, role: string, taskType: string) => {
      let insertedActions: unknown
      const query = vi.fn(async (sql: string, values?: unknown[]) => {
        const admission = ownedTurnScopeRow(sql, values)
        if (admission) return admission
        if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
        if (sql.startsWith('SELECT "rootTaskId", "turnId"')) return { rows: [{ rootTaskId: "root-1", turnId: "turn-1" }], rowCount: 1 }
        if (sql.startsWith('SELECT root."id", root."turnId"')) return { rows: [{ id: "root-1", turnId: "turn-1", status: "running", interruptRequestedAt: null }], rowCount: 1 }
        if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) { insertedActions = JSON.parse(String(values?.[12])) as unknown; return { rows: [{ id: "child-1" }], rowCount: 1 } }
        if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [{ ...taskRow(), role, taskType, allowedActions: insertedActions }], rowCount: 1 }
        return { rows: [], rowCount: 1 }
      })
      const input: TaskGraphScheduleInput = {
        scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
        proposal: { expectedRevision: 0, nodes: [role === "analyst"
          ? plannedNode({ key: "work", templateId, goal: "Do bounded work", successCriteria: ["done"], dependsOn: [] })
          : { key: "work", templateId, goal: "Do bounded work", successCriteria: ["done"], dependsOn: [] }] },
        templates: { [templateId]: { role, taskType, allowedActions: [] } },
      }
      await createGraphTasks({ query } as unknown as Pick<pg.PoolClient, "query">, input,
        { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 2, maxAttempts: 2 } } }, createInitialTaskGraphState(), new Map())
      return insertedActions
    }

    await expect(create("application_filler", "application_filler", "application_fill_for_review")).resolves.toEqual([])
    await expect(create("analyst", "analyst", "research")).resolves.toEqual(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"])
  })

  it("rejects a second application filler across the existing Turn graph and new proposal before database access", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const fillerNode = (key: string) => ({
      key, templateId: "application_filler", goal: "Prepare application for review",
      successCriteria: ["Review checkpoint is ready"], dependsOn: [],
    })
    const inputFor = (nodes: TaskGraphNodeProposal[], expectedRevision: number): TaskGraphScheduleInput => ({
      scope: {
        userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
        stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1,
      },
      proposal: { expectedRevision, nodes },
      templates: { application_filler: { role: "application_filler", taskType: "application_fill_for_review", allowedActions: [] } },
    })
    const parent = { budgetSnapshot: { subagentPolicy: { maxConcurrency: 4, maxDepth: 4, maxFanOut: 4, maxAttempts: 2 } } }
    const initial = createInitialTaskGraphState()

    await expect(createGraphTasks(client, inputFor([fillerNode("fill-a"), fillerNode("fill-b")], 0), parent, initial, new Map()))
      .rejects.toMatchObject({ code: "task_graph_application_filler_limit" })

    const priorFill: TaskGraphState = {
      revision: 1,
      nodes: [{ ...fillerNode("fill-old"), depth: 1, status: "failed" }],
      appliedEvents: [],
    }
    await expect(createGraphTasks(client, inputFor([fillerNode("fill-new")], 1), parent, priorFill, new Map([["fill-old", "task-old"]])))
      .rejects.toMatchObject({ code: "task_graph_application_filler_limit" })

    expect(query).not.toHaveBeenCalled()
  })

  it("rejects one Reviewer reused by multiple Writers in the same proposal before database access", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input = writerReviewInput([
      { key: "writer-v1", templateId: "cover_letter_writer", dependsOn: [] },
      { key: "reviewer-v1", templateId: "cover_letter_reviewer", dependsOn: ["writer-v1"] },
      { key: "writer-v2", templateId: "cover_letter_writer", dependsOn: ["reviewer-v1"] },
      { key: "writer-v3", templateId: "cover_letter_writer", dependsOn: ["reviewer-v1"] },
    ], 0)

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }, createInitialTaskGraphState(), new Map()))
      .rejects.toMatchObject({ code: "task_graph_writer_review_conflict" })
    expect(query).not.toHaveBeenCalled()
  })

  it.each(["queued", "running", "retrying", "waiting", "waiting_for_user", "completed", "failed", "interrupted", "cancelled", "closed"] as const)(
    "rejects reusing a Reviewer across proposals when the prior Writer is %s", async status => {
      const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
      const client = { query } as unknown as Pick<pg.PoolClient, "query">
      const current = writerReviewState([
        { key: "writer-v1", templateId: "cover_letter_writer", dependsOn: [] },
        { key: "reviewer-v1", templateId: "cover_letter_reviewer", dependsOn: ["writer-v1"] },
        { key: "writer-v2", templateId: "cover_letter_writer", dependsOn: ["reviewer-v1"], status },
      ])
      const input = writerReviewInput([
        { key: "writer-v3", templateId: "cover_letter_writer", dependsOn: ["reviewer-v1"] },
      ], current.revision)

      await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }, current,
        new Map([["writer-v1", "task-writer-v1"], ["reviewer-v1", "task-reviewer-v1"], ["writer-v2", "task-writer-v2"]])))
        .rejects.toMatchObject({ code: "task_graph_writer_review_conflict" })
      expect(query).not.toHaveBeenCalled()
    },
  )

  it("allows a later Writer after a fresh direct Reviewer", async () => {
    const query = vi.fn(async () => { throw new Error("expected_database_read") })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const current = writerReviewState([
      { key: "writer-v1", templateId: "cover_letter_writer", dependsOn: [] },
      { key: "reviewer-v1", templateId: "cover_letter_reviewer", dependsOn: ["writer-v1"] },
      { key: "writer-v2", templateId: "cover_letter_writer", dependsOn: ["reviewer-v1"] },
      { key: "reviewer-v2", templateId: "cover_letter_reviewer", dependsOn: ["writer-v2"] },
    ])
    const input = writerReviewInput([
      { key: "writer-v3", templateId: "cover_letter_writer", dependsOn: ["reviewer-v2"] },
    ], current.revision)
    const priorIds = new Map(current.nodes.map(node => [node.key, `task-${node.key}`] as const))

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }, current, priorIds))
      .rejects.toThrow("expected_database_read")
    expect(query).toHaveBeenCalledTimes(1)
  })

  it("rejects a Writer with multiple direct Reviewer prerequisites before database access", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input = writerReviewInput([
      { key: "writer-v1", templateId: "cover_letter_writer", dependsOn: [] },
      { key: "reviewer-v1", templateId: "cover_letter_reviewer", dependsOn: ["writer-v1"] },
      { key: "reviewer-v2", templateId: "cover_letter_reviewer", dependsOn: ["writer-v1"] },
      { key: "writer-v2", templateId: "cover_letter_writer", dependsOn: ["reviewer-v1", "reviewer-v2"] },
    ], 0)

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }, createInitialTaskGraphState(), new Map()))
      .rejects.toMatchObject({ code: "task_graph_writer_review_conflict" })
    expect(query).not.toHaveBeenCalled()
  })

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
      proposal: { expectedRevision: 7, nodes: [{
        key: "next", templateId: "cover_letter_writer", goal: "g".repeat(1200),
        successCriteria: Array.from({ length: 8 }, () => "c".repeat(320)), dependsOn: [keys[6]!],
      }] },
      templates: { cover_letter_writer: { role: "writer", taskType: "cover_letter_draft", allowedActions: [] } },
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

  it.each([
    ["wrong task type", "application_filler", "application_filler", "application_fill", []],
    ["caller-controlled action", "application_filler", "application_filler", "application_fill_for_review", ["application.fill"]],
    ["caller template id", "caller_template", "application_filler", "application_fill_for_review", []],
    ["reserved id with another role", "application_filler", "analyst", "application_fill_for_review", []],
  ] as const)("rejects Application Filler template admission with %s before database access", async (_reason, templateId, role, taskType, allowedActions) => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 0 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 0, nodes: [{ key: "fill", templateId, goal: "Prepare the application for review", successCriteria: ["Form is ready for user review"], dependsOn: [] }] },
      templates: { [templateId]: { role, taskType, allowedActions } },
    }

    await expect(createGraphTasks(client, input, { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 1, maxAttempts: 2 } } }, createInitialTaskGraphState(), new Map()))
      .rejects.toThrow("task_graph_template_policy_rejected")
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

  it("rejects ordinary growth at seven typed nodes before database reads", async () => {
    const fixture = repairFixture({ additionalTypedNodes: 6, ordinaryOnly: true })
    await expect(createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds))
      .rejects.toMatchObject({ code: "node_limit" })
    const fullTypedInput: TaskGraphScheduleInput = {
      ...fixture.input,
      proposal: { expectedRevision: 0, nodes: Array.from({ length: 8 }, (_, index) => plannedNode({
        key: `typed-${index}`, templateId: "analyst", goal: `Analyze ${index}`, successCriteria: ["done"], dependsOn: [],
      })) },
    }
    const fullPlanParent = { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }
    await expect(createGraphTasks(fixture.client, fullTypedInput, fullPlanParent, createInitialTaskGraphState(), new Map()))
      .rejects.toMatchObject({ code: "node_limit" })
    expect(fixture.query).not.toHaveBeenCalled()
  })

  it("admits a mixed first-repair batch through the reserved eighth position", async () => {
    const fixture = repairFixture({ additionalTypedNodes: 5, mixedBatch: true })
    const result = await createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds)
    expect(result.state.nodes).toHaveLength(8)
    expect(result.state.nodes.find(node => node.key === "repair-next")?.repairOf).toMatchObject({
      graphRootTaskId: "root-1", nodeKey: "target", taskId: "target-1", criterionIds: ["finding-count"],
    })
    expect(result.created.map(node => node.key)).toEqual(["repair-next", "ordinary-next"])
    expect(fixture.query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toHaveLength(2)

    const reversed = repairFixture({ additionalTypedNodes: 5, mixedBatch: true, repairLast: true })
    const reversedResult = await createGraphTasks(reversed.client, reversed.input, reversed.parent, reversed.current, reversed.taskIds)
    expect(reversedResult.state.nodes).toHaveLength(8)
    expect(reversedResult.created.map(node => node.key)).toEqual(["ordinary-next", "repair-next"])
  })

  it("rejects an invalid repair mixed with ordinary work before child or outbox inserts", async () => {
    const fixture = repairFixture({ rootId: "root-foreign", additionalTypedNodes: 5, mixedBatch: true })
    await expect(createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds))
      .rejects.toThrow("task_graph_repair_target_unresolved")
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
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

  it("rejects an overlapping in-flight repair before any database write with a fixed code", async () => {
    const fixture = repairFixture({ priorRepairStatus: "running", mixedBatch: true })
    await expect(createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds))
      .rejects.toMatchObject({ code: "task_graph_repair_conflict" })
    expect(fixture.query).not.toHaveBeenCalled()
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
    expect(fixture.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "agent_outbox"'))).toBe(false)
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

  it("allows a one-node failed-target repair while retaining the other canonical objective requirement", async () => {
    const fixture = repairFixture({ scoutRepair: true, analystRequirement: true })
    const input: TaskGraphScheduleInput = {
      ...fixture.input,
      verificationRequirements: { status: "valid", requirements: [
        { id: "candidate-count", kind: "candidate_count_gte", minimum: 1 },
        { id: "finding-count", kind: "finding_count_gte", minimum: 1 },
      ] },
    }
    const result = await createGraphTasks(fixture.client, input, fixture.parent, fixture.current, fixture.taskIds)
    expect(result.created).toMatchObject([{ key: "repair-next", status: "queued" }])
    expect(result.snapshot.nodes.some(node => node.key === "analyst-source")).toBe(true)
  })

  it("allows an unsuccessful terminal repair to be retried against the same target", async () => {
    const fixture = repairFixture({ priorRepairStatus: "failed" })
    const result = await createGraphTasks(fixture.client, fixture.input, fixture.parent, fixture.current, fixture.taskIds)
    expect(result.created).toMatchObject([{ key: "repair-next", status: "queued" }])
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

  it("rejects a Writer that omits the server-selected 10-point source in favor of its 9-point dependency", async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [], rowCount: 1 }))
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    const current: TaskGraphState = { revision: 2, appliedEvents: [], nodes: [10, 9].map(score => ({
      key: `analyst-${score}`, templateId: "analyst", taskId: `task-${score}`, goal: `Analyze ${score}`,
      successCriteria: ["Return findings"], dependsOn: [], depth: 1, status: "completed" as const,
      verificationDisposition: "typed" as const, verification: analystVerification,
    })) }
    vi.mocked(selectVerifiedScheduledDraftCandidate).mockResolvedValueOnce({
      candidate: { jobId: "job-high", score: 10 }, sourceAnalystKeys: ["analyst-10"], witness: {} as never,
    })
    const input: TaskGraphScheduleInput = {
      scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
      proposal: { expectedRevision: 2, nodes: [
        { key: "new-analyst", templateId: "analyst", goal: "Analyze the new batch", successCriteria: ["Return findings"], dependsOn: [], verification: analystVerification },
        writerReviewNode({ key: "writer", templateId: "cover_letter_writer", dependsOn: ["analyst-9"] }),
        writerReviewNode({ key: "reviewer", templateId: "cover_letter_reviewer", dependsOn: ["writer"] }),
      ] },
      templates: {
        analyst: { role: "analyst", taskType: "research", allowedActions: [] },
        cover_letter_writer: { role: "writer", taskType: "cover_letter_draft", allowedActions: [], context: { scheduledDraftMode: true } },
        cover_letter_reviewer: { role: "reviewer", taskType: "cover_letter_review", allowedActions: [], context: { scheduledDraftMode: true } },
      },
    }
    const parent = { budgetSnapshot: { subagentPolicy: { maxConcurrency: 8, maxDepth: 8, maxFanOut: 8, maxAttempts: 2 } } }
    const priorIds = new Map([["analyst-10", "task-10"], ["analyst-9", "task-9"]])
    await expect(createGraphTasks(client, input, parent, current, priorIds)).rejects.toMatchObject({ code: "task_graph_scheduled_draft_candidate_dependency_missing" })
    expect(vi.mocked(selectVerifiedScheduledDraftCandidate).mock.calls[0]?.[4]).toEqual(["analyst-10", "analyst-9"])
    expect(vi.mocked(selectVerifiedScheduledDraftCandidate).mock.calls[0]?.[6]).toEqual(["new-analyst"])
    expect(query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO "sub_agent_tasks"'))).toBe(false)
  })
})

const repairVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "analyst",
  criteria: [
    { id: "finding-count", check: { kind: "finding_count_gte", minimum: 1 } },
    { id: "evidence-count", check: { kind: "evidence_count_gte", minimum: 1 } },
  ],
} as const
type RepairFixtureOptions = { resolved?: boolean; targetMissing?: boolean; rootId?: string; priorReceipt?: boolean; priorRepairStatus?: TaskGraphState["nodes"][number]["status"]; scheduleDependent?: boolean; additionalTypedNodes?: number; mixedBatch?: boolean; repairLast?: boolean; ordinaryOnly?: boolean; scoutRepair?: boolean; analystRequirement?: boolean }
function repairFixture(options: RepairFixtureOptions = {}) {
  const repairTemplateId = options.scoutRepair ? "scout" : "analyst"
  const repairCriterionId = options.scoutRepair ? "candidate-count" : "finding-count"
  const targetVerification = options.scoutRepair ? scoutVerification : repairVerification
  const repairNodeVerification = options.scoutRepair ? scoutVerification : analystVerification
  const relation = { graphRootTaskId: options.rootId ?? "root-1", nodeKey: "target", taskId: "target-1", criterionIds: [repairCriterionId] }
  const report = {
    verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met",
    criteria: targetVerification.criteria.map(item => ({
      criterionId: item.id,
      status: item.id === repairCriterionId && options.resolved ? "passed" : "failed",
      reasonCode: item.id === repairCriterionId && options.resolved ? "criteria_met" : "criterion_not_met",
    })), evidenceDigest: "a".repeat(64), resultDigest: "e".repeat(64),
  }
  const target = { key: "target", templateId: repairTemplateId, goal: "Find evidence", successCriteria: ["find evidence"], dependsOn: [], depth: 1, status: "failed" as const, taskId: "target-1", verificationDisposition: "typed" as const, verification: targetVerification }
  const priorRepair = { key: "repair-old", templateId: repairTemplateId, goal: "Repair finding", successCriteria: ["repair"], dependsOn: [], depth: 1, status: options.priorRepairStatus ?? "completed", taskId: "repair-old-1", verificationDisposition: "typed" as const, verification: repairNodeVerification, repairOf: { ...relation, graphRootTaskId: "root-1" } }
  const fillers = Array.from({ length: options.additionalTypedNodes ?? 0 }, (_, index) => ({
    key: `filler-${index}`, templateId: "analyst", goal: "Prior typed work", successCriteria: ["done"], dependsOn: [],
    depth: 1, status: "completed" as const, taskId: `filler-task-${index}`, verificationDisposition: "typed" as const, verification: analystVerification,
  }))
  const analyst = options.analystRequirement ? {
    key: "analyst-source", templateId: "analyst", goal: "Analyze candidates", successCriteria: ["Return findings"], dependsOn: [],
    depth: 1, status: "completed" as const, taskId: "analyst-task", verificationDisposition: "typed" as const, verification: analystVerification,
  } : undefined
  const hasPriorRepair = options.priorReceipt || options.priorRepairStatus !== undefined
  const currentNodes = [target, ...fillers, ...(analyst ? [analyst] : []), ...(hasPriorRepair ? [priorRepair] : [])]
  const current: TaskGraphState = { revision: hasPriorRepair ? 2 : 1, nodes: currentNodes, appliedEvents: [], repairSatisfiedNodeKeys: options.priorReceipt ? ["target"] : [] }
  const taskIds = new Map<string, string>(currentNodes.map(node => [node.key, node.taskId!] as const))
  const snapshot = taskGraphSnapshot(current, taskIds)
  const repairNode = { key: "repair-next", templateId: repairTemplateId, goal: "Repair the missing finding", successCriteria: ["Resolve the finding"], dependsOn: [], verification: repairNodeVerification, repairOf: relation }
  const ordinaryNode = plannedNode({ key: "ordinary-next", templateId: "analyst", goal: "Continue bounded analysis", successCriteria: ["done"], dependsOn: [] })
  const input: TaskGraphScheduleInput = {
    scope: { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", stepId: "step", turnLeaseOwner: "turn", turnLeaseVersion: 1, parentLeaseOwner: "parent", parentAttemptCount: 1 },
    proposal: { expectedRevision: current.revision, nodes: options.scheduleDependent
      ? [plannedNode({ key: "after-target", templateId: "analyst", goal: "Continue from repaired evidence", successCriteria: ["done"], dependsOn: ["target"] })]
      : options.ordinaryOnly ? [plannedNode({ key: "ordinary-next", templateId: "analyst", goal: "Continue bounded analysis", successCriteria: ["done"], dependsOn: [] })]
        : options.mixedBatch ? options.repairLast ? [ordinaryNode, repairNode] : [repairNode, ordinaryNode]
          : [repairNode] },
    templates: {
      analyst: { role: "analyst", taskType: "research", allowedActions: [] },
      ...(options.scoutRepair ? { scout: { role: "scout", taskType: "job_discovery", allowedActions: ["jobs.search"] } } : {}),
    },
  }
  const evidence = [{ id: "read:job:job-1", kind: "job", ref: "job-1", source: "greenhouse" }]
  const targetStructured = repairTemplateId === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [], evidence, summary: "Original incomplete result" }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [], evidence, summary: "Original incomplete result" }
  const repairStructured = repairTemplateId === "scout"
    ? { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed", candidates: [{ jobId: "job-1", evidenceIds: ["read:job:job-1"] }], evidence, summary: "Repair result" }
    : { schemaVersion: ROLE_RESULT_SCHEMA, role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 7, evidenceIds: ["read:job:job-1"] }], evidence, summary: "Repair result" }
  const receipt = { schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: "root-1", targetNodeKey: "target", targetTaskId: "target-1", criterionIds: ["finding-count"], repairNodeKey: "repair-old", repairTaskId: "repair-old-1", verifierVersion: TASK_GRAPH_VERIFIER_VERSION, evidenceDigest: "b".repeat(64) }
  const priorResult = {
    finalItemId: "repair-item", finalText: "Repair result", status: "completed", stepCount: 1, toolCallCount: 1,
    structuredResult: repairStructured,
    taskGraphVerificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "passed", reasonCode: "criteria_met", criteria: repairNodeVerification.criteria.map(item => ({ criterionId: item.id, status: "passed", reasonCode: "criteria_met" })), evidenceDigest: "b".repeat(64), resultDigest: taskGraphResultDigest(repairStructured) },
    taskGraphRepairReceipt: receipt,
  }
  const targetResult = {
    finalItemId: "target-item", finalText: "Incomplete", status: "completed", stepCount: 1, toolCallCount: 1, structuredResult: targetStructured,
    taskGraphVerificationReport: { verifierVersion: TASK_GRAPH_VERIFIER_VERSION, status: "failed", reasonCode: "criterion_not_met", criteria: targetVerification.criteria.map(item => ({
      criterionId: item.id, status: item.id === repairCriterionId ? "failed" : "passed",
      reasonCode: item.id === repairCriterionId ? "criterion_not_met" : "criteria_met",
    })), evidenceDigest: "a".repeat(64), resultDigest: taskGraphResultDigest(targetStructured) },
  }
  let insertedChildren = 0
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const admission = ownedTurnScopeRow(sql, values)
    if (admission) return admission
    if (sql.includes('SELECT item."content"')) return { rows: [{ content: snapshot }], rowCount: 1 }
    if (sql.includes("ANY($1::text[])")) return options.scheduleDependent
      ? { rows: [
        { id: "target-1", status: "failed", failureReason: "task_graph_verification_failed", role: repairTemplateId, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: repairTemplateId }, result: targetResult, ...input.scope, userId: "user-1" },
        { id: "repair-old-1", status: "completed", failureReason: null, role: repairTemplateId, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: repairTemplateId }, result: priorResult, ...input.scope, userId: "user-1" },
      ], rowCount: 2 }
      : { rows: [{ id: "repair-old-1", status: options.priorRepairStatus ?? "completed", result: options.priorReceipt ? priorResult : { ...priorResult, taskGraphRepairReceipt: undefined } }], rowCount: 1 }
    if (sql.includes('task."failureReason"')) return { rows: options.targetMissing ? [] : [{ id: "target-1", status: "failed", role: repairTemplateId, failureReason: "task_graph_verification_failed", result: { taskGraphVerificationReport: report }, rootTaskId: "root-1", parentTaskId: "root-1", sessionId: "session-1", turnId: "turn-1" }], rowCount: options.targetMissing ? 0 : 1 }
    if (sql.includes("COUNT(*)::int")) return { rows: [{ count: 0 }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "sub_agent_tasks"')) return { rows: [{ id: `repair-next-${++insertedChildren}` }], rowCount: 1 }
    if (sql.startsWith('SELECT task.*, session."userId"')) return { rows: [{ ...taskRow(repairTemplateId), id: `repair-next-${insertedChildren}`, goal: insertedChildren === 1 ? repairNode.goal : "Continue bounded analysis" }], rowCount: 1 }
    if (sql.startsWith('INSERT INTO "agent_outbox"')) return { rows: [{ id: "outbox-1" }], rowCount: 1 }
    if (sql.includes('SELECT "id", "rootTaskId", "path"')) return { rows: [{ id: "root-1", rootTaskId: "root-1", path: "/root-1", depth: 0, status: "running", allowedActions: [], modelProfileSnapshot: {}, budgetSnapshot: {}, toolPolicySnapshot: {} }], rowCount: 1 }
    return { rows: [], rowCount: 1 }
  })
  return { client: { query } as unknown as Pick<pg.PoolClient, "query">, query, input, current, taskIds, parent: { budgetSnapshot: { subagentPolicy: { maxConcurrency: 2, maxDepth: 4, maxFanOut: 4, maxAttempts: 2 } } } }
}

function taskRow(role: "analyst" | "scout" = "analyst") {
  return {
    id: "child-2", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    path: "/root-1/child-2", depth: 1, role, taskType: role === "scout" ? "job_discovery" : "research", status: "queued", goal: "Continue after prior result",
    constraints: [], successCriteria: ["done"], allowedActions: role === "scout" ? ["jobs.search"] : [], context: {}, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role }, result: null, failureReason: null,
    attemptCount: 0, maxAttempts: 2, leaseOwner: null, leaseExpiresAt: null, interruptRequestedAt: null,
    budgetSnapshot: {}, modelProfileSnapshot: {}, toolPolicySnapshot: {},
  }
}
