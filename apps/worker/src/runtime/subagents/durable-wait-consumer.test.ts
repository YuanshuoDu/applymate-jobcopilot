import { describe, expect, it } from "vitest"

import { consumeDurableWaitOutcomes } from "./durable-wait-consumer.js"
import type { TurnLease } from "../turns/lease.js"
import { TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION } from "./task-graph-command-port.js"

const lease: TurnLease = {
  turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 2,
  leaseStartedAt: new Date("2026-09-09T10:00:00.000Z"), leaseExpiresAt: new Date("2026-09-09T11:00:00.000Z"),
}
const turn = { id: "turn-1", sessionId: "session-1", userId: "user-1", status: "in_progress", leaseOwnerId: "worker-1", leaseVersion: 2, leaseExpiresAt: lease.leaseExpiresAt, rootTaskId: "root-1" }
const now = new Date("2026-09-09T10:30:00.000Z")
const SESSION_FENCE = 'session."status" NOT IN (\'aborted\', \'archived\')'
type OutcomeOutput = { waitId: string; status: string; targetTaskIds: string[]; matchedTaskIds: string[]; tasks: Array<{ taskId: string; status: string; result?: unknown; failureReason?: string | null; verificationReport?: unknown; repairReceipt?: unknown }> }
function outputOf(content: unknown): OutcomeOutput {
  if (!content || typeof content !== "object" || Array.isArray(content) || !("output" in content)) throw new Error("missing output")
  const output = content.output
  if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("invalid output")
  return output as OutcomeOutput
}

function fixture(input: { waitStatus?: string; mode?: "any" | "all"; matchedTaskIds?: string[]; archivedMatchedTaskIds?: string[]; consumed?: boolean; corruptConsumed?: boolean; missingConsumedOutcome?: boolean; storedReport?: unknown; storedReceipt?: unknown; snapshot?: unknown; targetStatus?: string; targetStatuses?: string[]; targetResults?: unknown[]; targetFailureReasons?: Array<string | null>; targetRole?: string; foreign?: boolean; failUpdate?: boolean; large?: boolean; targetCount?: number; malformed?: boolean; sessionStatus?: string; sessionSource?: string; closeBeforeUpdate?: boolean } = {}) {
  const targetIds = Array.from({ length: input.targetCount ?? 1 }, (_, index) => `child-${index + 1}`)
  const mode = input.mode ?? "all"
  const matchedTaskIds = input.matchedTaskIds ?? targetIds
  const outcome = { waitId: input.corruptConsumed ? "wait-other" : "wait-1", status: "ready", targetTaskIds: targetIds, matchedTaskIds: input.archivedMatchedTaskIds ?? matchedTaskIds, tasks: targetIds.map((taskId, index) => ({ taskId, status: input.targetStatuses?.[index] ?? "completed", result: null, failureReason: null, ...(input.storedReport ? { verificationReport: input.storedReport } : {}), ...(input.storedReceipt ? { repairReceipt: input.storedReceipt } : {}) })) }
  const result: Record<string, unknown> = input.consumed ? { request: { mode }, ...(input.missingConsumedOutcome ? {} : { outcome }) } : { request: { mode } }
  const wait: Record<string, unknown> = { id: "wait-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", parentTaskId: "root-1", stepId: "step-1", targetTaskIds: targetIds, mode, status: input.waitStatus ?? "ready", matchedTaskIds, result, suspendedAt: now, consumedAt: input.consumed ? now : null }
  const state: { wait: Record<string, unknown>; consumedAt: Date | null; result: Record<string, unknown>; updates: number; sessionStatus: string; sessionSource: string } = { wait, consumedAt: input.consumed ? now : null, result, updates: 0, sessionStatus: input.sessionStatus ?? "running", sessionSource: input.sessionSource ?? "automation" }
  const calls: string[] = []
  const client = {
    query: async (sql: string, values: readonly unknown[] = []) => {
      calls.push(sql)
      if (sql.includes('FROM "agent_wait_conditions"')) {
        if (state.sessionStatus === "aborted" || state.sessionStatus === "archived") {
          if (!sql.includes(SESSION_FENCE)) throw new Error("missing session-state fence")
          return { rows: [], rowCount: 0 }
        }
        return { rows: [state.wait], rowCount: 1 }
      }
      if (sql.includes('FROM "sub_agent_tasks"') && sql.includes("ANY($1::text[])")) return { rows: input.foreign ? [] : targetIds.map((id, index) => {
        const status = input.targetStatuses?.[index] ?? input.targetStatus ?? "completed"
        const defaultResult = input.malformed ? (() => { const value: Record<string, unknown> = { bigint: BigInt(1) }; value.circular = value; return value })() : { safe: input.large ? "x".repeat(10_000) : true, secret: "hide-me" }
        return { id, rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1", role: input.targetRole ?? "scout", status, result: input.targetResults?.[index] ?? defaultResult, failureReason: input.targetFailureReasons?.[index] ?? (status === "failed" ? "provider failed" : null) }
      }), rowCount: input.foreign ? 0 : targetIds.length }
      if (sql.includes('FROM "agent_items"')) return { rows: [{ content: input.snapshot ?? legacyWaitSnapshot(targetIds) }], rowCount: 1 }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [{ id: "root-1", rootTaskId: "root-1", turnId: "turn-1", sessionId: "session-1", userId: "user-1" }], rowCount: 1 }
      if (sql.includes('FROM "agent_steps"')) return { rows: [{ id: "step-1", taskId: "root-1", attempt: 1, status: "waiting_for_tool" }], rowCount: 1 }
      if (sql.includes('UPDATE "agent_wait_conditions"')) {
        if (input.failUpdate) throw new Error("update failed")
        if (input.closeBeforeUpdate) { state.sessionStatus = "aborted"; return { rows: [], rowCount: 0 } }
        state.consumedAt = now; state.result = { ...state.result, outcome: JSON.parse(String(values[0])) as unknown }; state.wait = { ...state.wait, consumedAt: now, result: state.result }; state.updates += 1
        return { rows: [{ id: "wait-1" }], rowCount: 1 }
      }
      return { rows: [], rowCount: 1 }
    },
  }
  return { client, state, calls }
}

const scoutVerification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }] } as const
const waitVerificationReport = { verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "failed", reasonCode: "criterion_not_met", criteria: [{ criterionId: "candidate-count", status: "failed", reasonCode: "criterion_not_met" }], evidenceDigest: "c".repeat(64), resultDigest: "e".repeat(64) } as const
function waitSnapshot(targetIds: readonly string[], verification: unknown = scoutVerification) {
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: targetIds.map((taskId, index) => ({
    key: index === 0 ? "child" : `child-${index + 1}`, taskId, templateId: "scout", goal: "Search",
    successCriteria: ["Find relevant jobs"], dependsOn: [], depth: 1, verification, verificationDisposition: "typed",
  })) }
}
function legacyWaitSnapshot(targetIds: readonly string[]) {
  return { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: targetIds.map((taskId, index) => ({
    key: index === 0 ? "child" : `child-${index + 1}`, taskId, templateId: "scout", goal: "Search",
    successCriteria: ["Find relevant jobs"], dependsOn: [], depth: 1,
  })) }
}

describe("durable wait outcome consumer", () => {
  it("projects a ready all result and consumes it once", async () => {
    const fake = fixture()
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections[0]).toMatchObject({ id: "wait-result:wait-1", content: { toolCallId: "wait:wait-1", toolName: "agent.wait", input: { taskIds: ["child-1"], mode: "all" }, status: "completed", output: { status: "ready", matchedTaskIds: ["child-1"] } } })
    expect(fake.state.consumedAt).toBe(now)
    expect(fake.state.result).toMatchObject({ request: { mode: "all" }, outcome: { waitId: "wait-1" } })
    expect(fake.state.updates).toBe(1)
    expect(fake.calls.some(sql => sql.includes(SESSION_FENCE))).toBe(true)
    expect(fake.calls.find(sql => sql.includes('UPDATE "agent_wait_conditions"'))).toContain(SESSION_FENCE)
  })

  it("only includes terminal child details in a ready any receipt", async () => {
    const fake = fixture({ mode: "any", targetCount: 2, matchedTaskIds: ["child-1"], targetStatuses: ["completed", "queued"], targetResults: [{ current: "completed-result" }, { stale: "prior-attempt-result" }], targetFailureReasons: [null, "prior-attempt-error"] })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    const output = outputOf(projections[0]!.content)
    expect(output.matchedTaskIds).toEqual(["child-1"])
    expect(output.tasks).toMatchObject([
      { taskId: "child-1", status: "completed", result: { current: "completed-result" } },
      { taskId: "child-2", status: "queued", result: null, failureReason: null },
    ])
    expect(fake.state.wait.matchedTaskIds).toEqual(["child-1"])
    expect(JSON.stringify(output)).not.toContain("prior-attempt-result")
    expect(JSON.stringify(output)).not.toContain("prior-attempt-error")
  })

  it("projects the server-owned target role", async () => {
    const fake = fixture({ targetRole: "analyst" })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections[0]?.content).toMatchObject({ output: { tasks: [{ taskId: "child-1", role: "analyst" }] } })
  })

  it("projects only a strict bounded report whose criteria match the immutable snapshot", async () => {
    const snapshot = waitSnapshot(["child-1"])
    const valid = fixture({ snapshot, targetStatus: "failed", targetResults: [{ taskGraphVerificationReport: waitVerificationReport, raw: "must-not-surface" }] })
    const outcome = outputOf((await consumeDurableWaitOutcomes({ client: valid.client as never, lease, turn, now }))[0]!.content)
    expect(outcome.tasks[0]).toMatchObject({ verificationReport: waitVerificationReport })
    expect(Object.keys(outcome.tasks[0]!.verificationReport as object).sort()).toEqual(["criteria", "evidenceDigest", "reasonCode", "resultDigest", "status", "verifierVersion"])
    expect(JSON.stringify(outcome)).not.toContain("must-not-surface")

    const malformed = fixture({ snapshot, targetStatus: "failed", targetResults: [{ taskGraphVerificationReport: { ...waitVerificationReport, criteria: [{ ...waitVerificationReport.criteria[0], criterionId: "foreign" }], raw: "must-not-surface" } }] })
    await expect(consumeDurableWaitOutcomes({ client: malformed.client as never, lease, turn, now })).rejects.toThrow("wait_consume_verification_report_invalid")
    expect(malformed.state.updates).toBe(0)
  })

  it("revalidates a consumed report against the snapshot before replay", async () => {
    const snapshot = waitSnapshot(["child-1"])
    const fake = fixture({ consumed: true, snapshot, targetStatuses: ["failed"], storedReport: waitVerificationReport })
    const outcome = outputOf((await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now }))[0]!.content)
    expect(outcome.tasks[0]).toMatchObject({ verificationReport: waitVerificationReport })
    expect(fake.state.updates).toBe(0)
    const corrupt = fixture({ consumed: true, snapshot, targetStatuses: ["failed"], storedReport: { ...waitVerificationReport, criteria: [] } })
    await expect(consumeDurableWaitOutcomes({ client: corrupt.client as never, lease, turn, now })).rejects.toThrow("wait_consume_outcome_invalid")
  })

  it("rejects a terminal typed task with a missing server report and keeps legacy snapshots compatible", async () => {
    const typed = fixture({ snapshot: waitSnapshot(["child-1"]), targetStatus: "completed" })
    await expect(consumeDurableWaitOutcomes({ client: typed.client as never, lease, turn, now })).rejects.toThrow("wait_consume_verification_report_invalid")
    expect(typed.state.updates).toBe(0)
    const legacy = fixture({ targetStatus: "completed" })
    await expect(consumeDurableWaitOutcomes({ client: legacy.client as never, lease, turn, now })).resolves.toHaveLength(1)
    expect(legacy.state.updates).toBe(1)
  })

  it("projects a passing repair receipt separately from the target's failed report", async () => {
    const nodes = waitSnapshot(["child-1", "child-2"]).nodes
    const repairOf = { graphRootTaskId: "root-1", nodeKey: "child", taskId: "child-1", criterionIds: ["candidate-count"] }
    const snapshot = { schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [nodes[0], { ...nodes[1]!, repairOf }] }
    const passed = { ...waitVerificationReport, status: "passed", reasonCode: "criteria_met", criteria: [{ criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" }], evidenceDigest: "d".repeat(64) }
    const receipt = {
      schemaVersion: TASK_GRAPH_REPAIR_RECEIPT_SCHEMA_VERSION, graphRootTaskId: "root-1", targetNodeKey: "child", targetTaskId: "child-1", criterionIds: ["candidate-count"],
      repairNodeKey: "child-2", repairTaskId: "child-2", verifierVersion: "agent-harness.v2.task-graph-verifier.v1", evidenceDigest: passed.evidenceDigest,
    }
    const fake = fixture({ snapshot, targetCount: 2, targetStatuses: ["failed", "completed"], targetResults: [
      { taskGraphVerificationReport: waitVerificationReport }, { taskGraphVerificationReport: passed, taskGraphRepairReceipt: receipt },
    ] })
    const outcome = outputOf((await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now }))[0]!.content)
    expect(outcome.tasks[0]).toMatchObject({ verificationReport: waitVerificationReport })
    expect(outcome.tasks[0]).not.toHaveProperty("repairReceipt")
    expect(outcome.tasks[1]).toMatchObject({ verificationReport: passed, repairReceipt: receipt })
  })

  it("persists and replays the maximum eight-child by eight-criterion report set without raw outputs", async () => {
    const targetIds = Array.from({ length: 8 }, (_, index) => `child-${index + 1}`)
    const criterionIds = Array.from({ length: 8 }, (_, index) => `criterion-${index}-${"x".repeat(52)}`)
    const verification = { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role: "scout", criteria: criterionIds.map(id => ({ id, check: { kind: "candidate_count_gte", minimum: 1 } })) }
    const report = {
      verifierVersion: "agent-harness.v2.task-graph-verifier.v1", status: "unverified", reasonCode: "canonical_evidence_missing",
      criteria: criterionIds.map(criterionId => ({ criterionId, status: "unverified", reasonCode: "canonical_evidence_missing" })), evidenceDigest: null, resultDigest: null,
    }
    const targetResults = targetIds.map(() => ({ taskGraphVerificationReport: report, rawOutput: "private evidence payload" }))
    const fake = fixture({ targetCount: 8, snapshot: waitSnapshot(targetIds, verification), targetStatuses: Array(8).fill("failed"), targetResults })
    const first = outputOf((await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now }))[0]!.content)
    expect(first.tasks).toHaveLength(8)
    expect(first.tasks.every(task => (task.verificationReport as { criteria: unknown[] } | undefined)?.criteria.length === 8)).toBe(true)
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(16 * 1024)
    expect(JSON.stringify(first)).not.toContain("private evidence payload")
    const replayed = outputOf((await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now }))[0]!.content)
    expect(replayed).toEqual(first)
    expect(JSON.stringify(replayed)).not.toContain("private evidence payload")
    expect(fake.state.updates).toBe(1)
  })

  it("keeps timeout and failed child status explicit in the outcome", async () => {
    const fake = fixture({ waitStatus: "timed_out", targetStatus: "failed" })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections[0]?.content).toMatchObject({ output: { status: "timed_out", tasks: [{ status: "failed", failureReason: "provider failed" }] } })
    expect(JSON.stringify(projections)).not.toContain("hide-me")
  })

  it("bounds a large child result in the durable projection", async () => {
    const fake = fixture({ large: true })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections[0]?.content).toMatchObject({ output: { tasks: [{ result: { truncated: true } }] } })
  })

  it("keeps an eight-child projection within the UTF-8 replay limit", async () => {
    const targetIds = Array.from({ length: 8 }, (_, index) => `child-${index + 1}`)
    const fake = fixture({ large: true, targetCount: 8 })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    const output = outputOf(projections[0]!.content)
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(16 * 1024)
    expect(output).toMatchObject({ waitId: "wait-1", status: "ready", targetTaskIds: targetIds, matchedTaskIds: targetIds })
    expect(output.tasks).toHaveLength(8)
    expect(output.tasks.map(task => [task.taskId, task.status])).toEqual(targetIds.map(taskId => [taskId, "completed"]))
  })

  it("summarizes malformed child results without throwing", async () => {
    const fake = fixture({ malformed: true })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections).toHaveLength(1)
    const output = outputOf(projections[0]!.content)
    expect(Buffer.byteLength(JSON.stringify(output), "utf8")).toBeLessThanOrEqual(8192)
    expect(output).toMatchObject({ tasks: [{ taskId: "child-1", status: "completed", result: { truncated: true } }] })
  })

  it("rebuilds a legacy persisted outcome as a canonical projection without writing a second receipt", async () => {
    const fake = fixture({ consumed: true })
    const projections = await consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })
    expect(projections).toHaveLength(1)
    expect(projections[0]?.content).toMatchObject({ toolCallId: "wait:wait-1", toolName: "agent.wait", output: { waitId: "wait-1", status: "ready" } })
    expect(fake.state.updates).toBe(0)
  })

  it.each([{ corruptConsumed: true }, { missingConsumedOutcome: true }])("fails closed when a consumed wait has no valid persisted outcome", async input => {
    const fake = fixture({ consumed: true, ...input })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).rejects.toThrow("wait_consume_outcome_invalid")
    expect(fake.state.updates).toBe(0)
    expect(fake.state.consumedAt).toBe(now)
  })

  it("rejects a consumed archive whose matched tasks conflict with the durable wait row", async () => {
    const fake = fixture({ consumed: true, mode: "any", targetCount: 2, matchedTaskIds: ["child-1"], archivedMatchedTaskIds: ["child-2"] })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).rejects.toThrow("wait_consume_outcome_invalid")
  })

  it("rejects a consumed ready-all archive with only a subset of targets matched", async () => {
    const fake = fixture({ consumed: true, mode: "all", targetCount: 2, matchedTaskIds: ["child-1"] })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).rejects.toThrow("wait_consume_outcome_invalid")
  })

  it("fails closed for a fresh ready-all wait with incomplete canonical matches", async () => {
    const fake = fixture({ mode: "all", targetCount: 2, matchedTaskIds: ["child-1"] })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).rejects.toThrow("wait_consume_outcome_invalid")
    expect(fake.state.updates).toBe(0)
  })

  it.each([
    { archivedMatchedTaskIds: ["child-1", "child-1"] },
    { archivedMatchedTaskIds: ["foreign-task"] },
  ])("rejects a consumed archive with duplicated or foreign matched ids", async ({ archivedMatchedTaskIds }) => {
    const fake = fixture({ consumed: true, targetCount: 2, matchedTaskIds: ["child-1"], archivedMatchedTaskIds })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).rejects.toThrow("wait_consume_outcome_invalid")
  })

  it("fails closed for stale ownership and foreign lineage", async () => {
    const stale = { ...turn, leaseOwnerId: "other-worker" }
    const fake = fixture()
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn: stale, now })).rejects.toThrow("wait_consume_turn_fenced")
    const foreign = fixture({ foreign: true })
    await expect(consumeDurableWaitOutcomes({ client: foreign.client as never, lease, turn, now })).resolves.toEqual([])
    expect(foreign.state.updates).toBe(0)
  })

  it("leaves consumedAt unchanged when the receipt write fails", async () => {
    const fake = fixture({ failUpdate: true })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).rejects.toThrow("update failed")
    expect(fake.state.consumedAt).toBeNull()
    expect(fake.state.updates).toBe(0)
  })

  it.each(["aborted", "archived"])("does not consume a %s session outcome", async sessionStatus => {
    const fake = fixture({ sessionStatus })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).resolves.toEqual([])
    expect(fake.state.updates).toBe(0)
    expect(fake.state.consumedAt).toBeNull()
    expect(fake.calls.some(sql => sql.includes('UPDATE "agent_wait_conditions"'))).toBe(false)
  })

  it.each(["running", "paused", "waiting_for_user"])("keeps %s session outcome consumption compatible", async sessionStatus => {
    const fake = fixture({ sessionStatus })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).resolves.toHaveLength(1)
    expect(fake.state.updates).toBe(1)
  })

  it.each(["user", "system"])("keeps ordinary %s session outcome consumption compatible", async sessionSource => {
    const fake = fixture({ sessionSource })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).resolves.toHaveLength(1)
    expect(fake.state.updates).toBe(1)
  })

  it("does not consume when the session closes at the conditional outcome write", async () => {
    const fake = fixture({ closeBeforeUpdate: true })
    await expect(consumeDurableWaitOutcomes({ client: fake.client as never, lease, turn, now })).resolves.toEqual([])
    expect(fake.state.updates).toBe(0)
    expect(fake.state.consumedAt).toBeNull()
  })
})
