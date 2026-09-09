import { describe, expect, it, vi } from "vitest"

import { loadCanonicalTurnState } from "./canonical-turn-state.js"

const lease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
  leaseStartedAt: new Date("2026-09-09T00:00:00.000Z"), leaseExpiresAt: new Date("2026-09-10T00:01:00.000Z"),
}

function pool(rows: { turn?: Record<string, unknown>; steps?: Record<string, unknown>[]; items?: Record<string, unknown>[]; inputs?: Record<string, unknown>[]; events?: Record<string, unknown>[]; snapshots?: Record<string, unknown>[] }) {
  const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
    if (sql.includes('"input"') && sql.includes('FROM "agent_turns"')) return { rows: rows.turn ? [{ id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt, ...rows.turn }] : [], rowCount: rows.turn ? 1 : 0 }
    if (sql.includes('MAX("ordinal")')) return { rows: [{ maxOrdinal: Math.max(...(rows.steps ?? []).map(step => Number(step.ordinal ?? -1)), -1) }], rowCount: 1 }
    if (sql.includes('FROM "agent_steps"')) return { rows: (rows.steps ?? []).filter(step => step.taskId === undefined || step.taskId === null || step.taskId === values?.[2]), rowCount: rows.steps?.length ?? 0 }
    if (sql.includes('FROM "agent_events"')) return { rows: (rows.events ?? []).filter(event => event.taskId === undefined || event.taskId === null || event.taskId === values?.[2]), rowCount: rows.events?.length ?? 0 }
    if (sql.includes('FROM "agent_items"')) {
      const filtered = sql.includes('item_task') ? (rows.items ?? []).filter(item => item.taskId === undefined || item.taskId === null || item.taskId === "root-1") : (rows.items ?? []).filter(item => item.taskId === undefined || item.taskId === null || item.taskId === values?.[2])
      return { rows: filtered, rowCount: filtered.length }
    }
    if (sql.includes('FROM "agent_context_snapshots"')) return { rows: rows.snapshots ?? [], rowCount: rows.snapshots?.length ?? 0 }
    if (sql.includes('FROM "agent_inputs"')) return { rows: rows.inputs ?? [], rowCount: rows.inputs?.length ?? 0 }
    return { rows: [], rowCount: 0 }
  }), release: vi.fn() }
  return { connect: vi.fn(async () => client), client } as unknown as Pick<import("pg").Pool, "connect"> & { client: typeof client }
}

describe("loadCanonicalTurnState", () => {
  it("loads the owned turn and initial root input", async () => {
    const fake = pool({ turn: { input: { goal: "Find jobs" }, rootTaskId: null, contextSnapshotId: null, modelProfileSnapshot: { provider: "fixture" }, toolPolicySnapshot: {}, budgetSnapshot: {} }, inputs: [{ id: "input-1" }] })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value).toMatchObject({ goal: "Find jobs", rootInputId: "input-1", scope: { userId: "user-1" } })
    expect(value.snapshot.goal).toEqual({ id: "turn-goal:turn-1", content: "Find jobs" })
    expect(fake.client.query.mock.calls.some(([sql]) => typeof sql === "string" && sql.includes('agent_wait_conditions'))).toBe(false)
  })

  it("rebuilds durable tool observations and usage for resume", async () => {
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: { limits: { maxSteps: 3 } } },
      steps: [{ ordinal: 0, attempt: 1, inputThroughSequence: "4", consumedInputIds: ["input-1"], inputTokens: 5, outputTokens: 2, estimatedCostUsd: 0.01 }],
      items: [{ type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.search", input: { location: "Dublin" }, status: "completed" } }, { type: "tool_result", content: { toolCallId: "call-1", output: { jobs: [] }, errorCode: null } }],
    }), lease)
    expect(value.resume).toMatchObject({ nextOrdinal: 1, stepCount: 1, toolCallCount: 1, inputThroughSequence: 4n, usage: { inputTokens: 5, outputTokens: 2 } })
    expect(value.snapshot.toolObservations).toEqual([expect.objectContaining({ id: "tool-result:call-1", content: expect.objectContaining({ toolName: "jobs.search" }) })])
  })

  it("keeps the tenant setting inside a fenced transaction and restores a private lifecycle receipt", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      items: [{ type: "tool_call", content: { toolCallId: "call-1", toolName: "jobs.search", input: {}, status: "completed" } }, { type: "tool_result", content: { toolCallId: "call-1", outputAvailable: true, errorCode: null } }],
      events: [{ type: "tool_call.completed", payload: { toolCallId: "call-1", output: { jobs: [{ id: "job-1" }] }, errorCode: null } }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations[0]?.content).toMatchObject({ output: { jobs: [{ id: "job-1" }] } })
    expect(fake.client.query.mock.calls[0]?.[0]).toBe("BEGIN")
    expect(fake.client.query.mock.calls[1]?.[0]).toContain("set_config")
    const turnQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_turns"'))?.[0]
    expect(turnQuery).toContain('"leaseExpiresAt" > $6')
    expect(fake.client.query.mock.calls.at(-1)?.[0]).toBe("COMMIT")
  })

  it("restores bounded plan observations once and preserves the snapshot projection", async () => {
    const observationId = "plan-result:proposal-1:read"
    const snapshotContent = {
      schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "0", goal: "Find jobs",
      userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [], references: [], consumedInputIds: [],
      context: { system: [], profile: [], steerHistory: [], toolObservations: [{ id: observationId, content: { marker: "snapshot" } }] },
      tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
    }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      snapshots: [{ throughSequence: "0", version: 1, content: snapshotContent }],
      events: [
        { type: "plan.observation", payload: { observationId, content: { marker: "event" } } },
        { type: "plan.observation", payload: { observationId, content: { marker: "duplicate" } } },
        { type: "plan.observation", payload: { observationId: "oversized", content: "x".repeat(8 * 1024 + 1) } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations).toEqual([{ id: observationId, content: { marker: "snapshot" } }])
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"') && sql.includes("tool_call.completed"))?.[0]
    expect(eventQuery).toContain("'plan.observation'")
    expect(eventQuery).toContain('event_session."userId" = $4')
  })

  it("restores the latest valid plan revision and ignores malformed or foreign receipts", async () => {
    const proposal = { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: { schemaVersion: "agent-harness.plan.v1" }, intents: [] }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "tool_call.completed", payload: { toolCallId: "legacy-plan", toolName: "agent.plan.propose", output: proposal } },
        { type: "plan.revision", payload: { planCallId: "receipt-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } },
        { type: "plan.revision", payload: { planCallId: "foreign", goalRevision: 1, planRevision: 99, basedOnPlanRevision: "bad" }, taskId: "child-1" },
        { type: "plan.revision", payload: { planCallId: "malformed", goalRevision: 1, planRevision: 4, basedOnPlanRevision: 1 } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.planRevision).toBe(2)
    expect(value.snapshot.toolObservations).toEqual(expect.arrayContaining([{ id: "plan-revision:receipt-2", content: { kind: "plan_revision", planCallId: "receipt-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 } }]))
  })

  it("restores bounded semantic proposal hashes in event order and deduplicates them", async () => {
    const hashA = `sha256:${"a".repeat(64)}`
    const hashB = `sha256:${"b".repeat(64)}`
    const value = await loadCanonicalTurnState(pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "plan.revision", payload: { planCallId: "one", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposalHash: hashA } },
        { type: "plan.revision", payload: { planCallId: "two", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: hashB } },
        { type: "plan.revision", payload: { planCallId: "three", goalRevision: 1, planRevision: 3, basedOnPlanRevision: 2, proposalHash: hashB } },
        { type: "plan.revision", payload: { planCallId: "bad", goalRevision: 1, planRevision: 4, basedOnPlanRevision: 3, proposalHash: "bad" } },
      ],
    }), lease)
    expect(value.planRevision).toBe(3)
    expect(value.planProposalHashes).toEqual([hashA, hashB])
  })

  it("restores bounded plan command outcomes with observation deduplication", async () => {
    const command = { planCallId: "plan-1", planRevision: 1, observationId: "plan-result:plan-1:read", content: { kind: "plan_command", status: "completed", output: { found: true } } }
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [
        { type: "plan.command", payload: command },
        { type: "plan.observation", payload: { planCallId: "plan-1", observationId: command.observationId, content: command.content } },
        { type: "plan.command", payload: { ...command, observationId: "foreign", content: { ok: false } }, taskId: "child-1" },
        { type: "plan.command", payload: { ...command, observationId: "bad", content: "raw" } },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.toolObservations).toEqual(expect.arrayContaining([{ id: command.observationId, content: command.content }]))
    expect(value.snapshot.toolObservations.filter(item => item.id === command.observationId)).toHaveLength(1)
    const eventQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_events"') && sql.includes("plan.command"))?.[0]
    expect(eventQuery).toContain("'plan.command'")
  })

  it("falls back to a scoped legacy accepted plan receipt when no revision event exists", async () => {
    const fake = pool({
      turn: { input: { goal: "Find jobs" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      events: [{ type: "tool_call.completed", payload: { toolCallId: "legacy-plan", toolName: "agent.plan.propose", output: { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal: { schemaVersion: "agent-harness.plan.v1" }, intents: [] } } }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.planRevision).toBe(1)
    expect(value.snapshot.toolObservations.some(item => item.id === "plan-revision:legacy-plan")).toBe(true)
  })

  it("uses the latest session snapshot and appends ordered role-tagged history after its cursor", async () => {
    const fake = pool({
      turn: { input: { goal: "Continue" }, rootTaskId: null, contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      inputs: [
        { id: "current-input", targetTurnId: "turn-1", content: [{ type: "text", text: "Continue" }], acceptedSequence: "7" },
        { id: "compacted-input", targetTurnId: "old-turn", content: [{ type: "text", text: "Already summarized" }], acceptedSequence: "3" },
        { id: "new-input", targetTurnId: "old-turn", content: [{ type: "text", text: "Use Dublin" }], acceptedSequence: "5" },
      ],
      items: [
        { id: "old-agent", turnId: "old-turn", type: "agent_message", status: "completed", content: { content: "Earlier reply" }, historyRole: "assistant", historySequence: "2" },
        { id: "new-agent", turnId: "old-turn", type: "agent_message", status: "completed", content: { text: "Current reply" }, historyRole: "assistant", historySequence: "6" },
      ],
      snapshots: [{ throughSequence: "4", version: 2, content: {
        schemaVersion: "agent-harness.context.v1", ownerId: "user-1", sessionId: "session-1", throughSequence: "4", goal: "Continue",
        userConstraints: [], confirmedDecisions: [], completedWork: [], openWork: [], pendingApprovals: [], artifacts: [], facts: [], failedAttempts: [], references: [], consumedInputIds: [],
        context: { system: [], profile: [], steerHistory: [{ id: "snapshot-history", content: "Compacted history" }], toolObservations: [] },
        tokenAccounting: { profiles: [], totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0 },
      } }],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.snapshot.steerHistory).toEqual([
      { id: "snapshot-history", content: "Compacted history" },
      { id: "history:user:new-input", content: { role: "user", text: "Use Dublin" } },
      { id: "history:assistant:new-agent", content: { role: "assistant", text: "Current reply" } },
    ])
  })

  it("restores root rows while excluding child-private records and keeps legacy null rows", async () => {
    const fake = pool({
      turn: { input: { goal: "Continue" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} },
      steps: [
        { taskId: "root-1", ordinal: 2, attempt: 1, inputThroughSequence: "4", consumedInputIds: [], inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0.01 },
        { taskId: "child-1", ordinal: 3, attempt: 1, inputThroughSequence: "9", consumedInputIds: [], inputTokens: 50, outputTokens: 50, estimatedCostUsd: 5 },
        { taskId: null, ordinal: 4, attempt: 1, inputThroughSequence: "5", consumedInputIds: [], inputTokens: 2, outputTokens: 2, estimatedCostUsd: 0.02 },
      ],
      items: [
        { id: "root-message", turnId: "old-turn", taskId: "root-1", type: "agent_message", status: "completed", content: { text: "root history" }, historyRole: "assistant", historySequence: "5" },
        { id: "child-message", turnId: "old-turn", taskId: "child-1", type: "agent_message", status: "completed", content: { text: "private child" }, historySequence: "6" },
      ],
    })
    const value = await loadCanonicalTurnState(fake, lease)
    expect(value.resume).toMatchObject({ nextOrdinal: 5, stepCount: 2, usage: { inputTokens: 3, outputTokens: 3 } })
    expect(value.snapshot.steerHistory).toEqual([{ id: "history:assistant:root-message", content: { role: "assistant", text: "root history" } }])
    expect(JSON.stringify(value.snapshot)).not.toContain("private child")
    const stepQuery = fake.client.query.mock.calls.find(([sql]) => typeof sql === "string" && sql.includes('FROM "agent_steps"') && !sql.includes('MAX'))
    expect(stepQuery?.[0]).toContain('"taskId" IS NULL OR "taskId" = $3')
  })

  it("projects a consumed wait outcome into the next root context", async () => {
    const wait: { id: string; userId: string; sessionId: string; turnId: string; parentTaskId: string; stepId: string; targetTaskIds: string[]; mode: string; status: string; matchedTaskIds: string[]; result: Record<string, unknown>; suspendedAt: Date; consumedAt: Date | null } = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1", stepId: "step-1", targetTaskIds: ["child-1"], mode: "all", status: "ready", matchedTaskIds: ["child-1"], result: { request: { mode: "all" } }, suspendedAt: new Date("2026-09-09T00:00:00.000Z"), consumedAt: null }
    const client = { query: vi.fn(async (sql: string, values?: readonly unknown[]) => {
      if (sql.includes('"input"') && sql.includes('FROM "agent_turns"')) return { rows: [{ id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: lease.ownerId, leaseVersion: lease.leaseVersion, leaseExpiresAt: lease.leaseExpiresAt, input: { goal: "Continue" }, rootTaskId: "root-1", contextSnapshotId: null, modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }], rowCount: 1 }
      if (sql.includes('FROM "agent_wait_conditions"')) return { rows: [wait], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("ANY($1::text[])")) return { rows: [{ id: "child-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1", status: "completed", result: { summary: "done" }, failureReason: null }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "root-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"') && sql.includes('SELECT "ordinal"')) return { rows: [], rowCount: 0 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) { wait.consumedAt = new Date(String(values?.[1])); wait.result = { ...wait.result, outcome: { waitId: "wait-1" } }; return { rows: [{ id: "wait-1" }], rowCount: 1 } }
      if (sql.includes('MAX("ordinal")')) return { rows: [{ maxOrdinal: -1 }], rowCount: 1 }
      if (sql.includes('FROM "agent_items"') || sql.includes('FROM "agent_events"') || sql.includes('FROM "agent_inputs"') || sql.includes('FROM "agent_context_snapshots"')) return { rows: [], rowCount: 0 }
      return { rows: [], rowCount: 1 }
    }), release: vi.fn() }
    const value = await loadCanonicalTurnState({ connect: vi.fn(async () => client) } as never, lease, new Date("2026-09-09T12:00:00.000Z"), { consumeWaitOutcomes: true })
    expect(value.snapshot.toolObservations).toEqual([expect.objectContaining({ id: "wait-result:wait-1", content: expect.objectContaining({ toolCallId: "wait:wait-1", input: { taskIds: ["child-1"], mode: "all" } }) })])
    expect(wait.consumedAt).not.toBeNull()
  })
})
