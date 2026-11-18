import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA, readMaterialDriftRecoveryIntent, scheduledAutomationSnapshotDigest,
  scheduledPrepareGateVerifierStage, validateMaterialDriftRecoveryTurn, verifyMaterialDriftRecoveryLineage, type MaterialDriftRecoveryIntent,
} from "./canonical-turn-scheduled-pipeline-context.js"
import type { ScheduledPipelineGraphNode } from "./scheduled-pipeline-graph-shape.js"
import type pg from "pg"

const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["engineer"], targetLocations: ["Dublin"],
  minScore: 70, dailyCap: 8, requireApproval: true, autoApply: false }
const owner = { userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", rootAttemptCount: 2,
  turnLeaseOwnerId: "turn-lease", turnLeaseVersion: 4, executionId: "execution-1", executionAttemptCount: 7 }
const gate = { taskId: "old-gate", leaseOwnerId: "gate-lease", attemptCount: 3 }
const marker = { schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1",
  reason: "scheduled_prepare_material_source_changed", owner, gate, analyzeFingerprintDigest: `sha256:${"a".repeat(64)}`,
  prepareProofDigest: `sha256:${"b".repeat(64)}`, artifactDigest: `sha256:${"c".repeat(64)}`,
  currentMaterialDigest: `sha256:${"d".repeat(64)}`, proofDigest: `sha256:${"e".repeat(64)}` }
const intent: MaterialDriftRecoveryIntent = {
  schemaVersion: MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA, turnId: "new-turn", userId: "user-1", sessionId: "session-1", automationId: "automation-1",
  previousTurnId: owner.turnId, previousExecutionId: owner.executionId, previousRecoveryTurnId: null,
  previousGateTaskId: gate.taskId, previousGateAttemptCount: gate.attemptCount,
  previousRootTaskId: owner.rootTaskId, previousRootAttemptCount: owner.rootAttemptCount, previousTurnLeaseVersion: owner.turnLeaseVersion,
  previousExecutionAttemptCount: owner.executionAttemptCount, reservedExecutionAttemptCount: owner.executionAttemptCount + 1,
  currentSnapshotDigest: scheduledAutomationSnapshotDigest(snapshot)!, sourceMarker: marker,
}
function turn(overrides: Record<string, unknown> = {}) {
  return { id: "new-turn", userId: "user-1", sessionId: "session-1", source: "automation", executionMode: "canonical_task_graph",
    status: "in_progress", createdAt: new Date("2026-01-02T00:00:00Z"), input: { goal: "Run automation", automationRunMode: "manual",
      scheduledAutomationSnapshot: snapshot, materialDriftRecovery: intent }, ...overrides }
}
function recoveryChainFixture(count: number) {
  const turns = new Map<string, Record<string, unknown>>([[
    "old-turn", { id: "old-turn", userId: "user-1", sessionId: "session-1", source: "automation", executionMode: "canonical_task_graph",
      status: "interrupted", rootTaskId: "old-root", leaseVersion: 4, createdAt: new Date("2026-01-01T00:00:00Z"),
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot } },
  ]])
  let currentIntent: MaterialDriftRecoveryIntent = intent
  for (let position = 1; position <= count; position++) {
    currentIntent = { ...intent, turnId: `recovery-${position}`,
      previousRecoveryTurnId: position === 1 ? null : `recovery-${position - 1}`,
      reservedExecutionAttemptCount: owner.executionAttemptCount + position }
    turns.set(currentIntent.turnId, { id: currentIntent.turnId, userId: "user-1", sessionId: "session-1", source: "automation",
      executionMode: "canonical_task_graph", status: position === count ? "in_progress" : "interrupted",
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, position)),
      input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshot, materialDriftRecovery: currentIntent } })
  }
  const current = turns.get(currentIntent.turnId)!
  const predecessorId = currentIntent.previousRecoveryTurnId ?? "old-turn"
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes('FROM "agent_automations"')) return { rows: [{ id: "automation-1", userId: "user-1", sessionId: "session-1" }] }
    if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: "execution-1", userId: "user-1", sessionId: "session-1",
      attemptCount: currentIntent.reservedExecutionAttemptCount }] }
    if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [values?.[0] === "old-root"
      ? { id: "old-root", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", parentTaskId: null,
        depth: 0, role: "orchestrator", taskType: "root", status: "interrupted", attemptCount: 2 }
      : { id: "old-gate", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", parentTaskId: "old-root",
        depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "failed", attemptCount: 3 }] }
    if (sql.includes('ORDER BY "createdAt" DESC')) return { rows: [{ id: predecessorId }] }
    if (sql.includes('FROM "agent_turns" AS turn')) {
      const row = typeof values?.[0] === "string" ? turns.get(values[0]) : undefined
      return { rows: row ? [row] : [] }
    }
    return { rows: [] }
  })
  return { current, currentIntent, client: { query } as unknown as Pick<pg.PoolClient, "query"> }
}
function graph(scoutCount: number, stage: "analyze" | "prepare" | "gate" | "audit"): ScheduledPipelineGraphNode[] {
  const scouts = Array.from({ length: scoutCount }, (_, index) => ({ key: `scout-${index}`, templateId: "scout", depth: 1, dependsOn: [] }))
  const nodes = [...scouts, { key: "analyst", templateId: "analyst", depth: 2, dependsOn: scouts.map(node => node.key) }]
  if (stage !== "analyze") nodes.push({ key: "prepare", templateId: "prepare", depth: 3, dependsOn: ["analyst"] })
  if (stage === "gate" || stage === "audit") nodes.push({ key: "gate", templateId: "gate", depth: 4, dependsOn: ["prepare"] })
  if (stage === "audit") nodes.push({ key: "scheduled_audit", templateId: "scheduled_audit", depth: 5, dependsOn: ["gate"] })
  return nodes
}

describe("scheduled Prepare verifier routing", () => {
  it("routes only current Gate/Audit stages, not a four-node two-Scout Prepare graph", () => {
    expect(graph(2, "prepare")).toHaveLength(4)
    expect(scheduledPrepareGateVerifierStage(graph(2, "prepare"))).toBeNull()
    expect(scheduledPrepareGateVerifierStage(graph(1, "gate"))).toBe("gate")
    expect(scheduledPrepareGateVerifierStage(graph(2, "gate"))).toBe("gate")
    expect(scheduledPrepareGateVerifierStage(graph(4, "audit"))).toBe("audit")
  })
  it("fails closed for incomplete or malformed prefixes", () => {
    expect(scheduledPrepareGateVerifierStage(graph(2, "analyze"))).toBeNull()
    const malformed = graph(2, "gate")
    malformed[3] = { ...malformed[3]!, dependsOn: ["missing"] }
    expect(scheduledPrepareGateVerifierStage(malformed)).toBeNull()
  })
})

describe("manual material-drift recovery intent", () => {
  it("reads only an exact current-Turn binding with the matching current snapshot digest", () => {
    expect(readMaterialDriftRecoveryIntent(turn())).toMatchObject({ status: "valid", intent })
    const expected = `sha256:${createHash("sha256").update(JSON.stringify([snapshot.schemaVersion, snapshot.targetRoles, snapshot.targetLocations,
      snapshot.minScore, snapshot.dailyCap, snapshot.requireApproval, snapshot.autoApply]), "utf8").digest("hex")}`
    expect(scheduledAutomationSnapshotDigest(snapshot)).toBe(expected)
  })
  it("keeps ordinary manual and cron Turns absent, while rejecting copied or forged intents", () => {
    const ordinary = turn({ input: { goal: "Run normally", automationRunMode: "manual" } })
    const cron = turn({ input: { goal: "Cron", automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot } })
    expect(readMaterialDriftRecoveryIntent(ordinary)).toEqual({ status: "absent" })
    expect(readMaterialDriftRecoveryIntent(cron)).toEqual({ status: "absent" })
    expect(readMaterialDriftRecoveryIntent(turn({ id: "forked-turn" }))).toEqual({ status: "invalid" })
    expect(readMaterialDriftRecoveryIntent(turn({ source: "user" }))).toEqual({ status: "invalid" })
    expect(readMaterialDriftRecoveryIntent(turn({ executionMode: "legacy" }))).toEqual({ status: "invalid" })
    expect(readMaterialDriftRecoveryIntent(turn({ input: { ...turn().input, automationRunMode: "scheduled" } }))).toEqual({ status: "invalid" })
  })
  it("rejects unknown fields, stale snapshot digests, marker drift, and accessors without invoking them", () => {
    expect(readMaterialDriftRecoveryIntent(turn({ input: { ...turn().input,
      materialDriftRecovery: { ...intent, forged: true } } }))).toEqual({ status: "invalid" })
    expect(readMaterialDriftRecoveryIntent(turn({ input: { ...turn().input,
      scheduledAutomationSnapshot: { ...snapshot, targetLocations: ["Paris"] } } }))).toEqual({ status: "invalid" })
    expect(readMaterialDriftRecoveryIntent(turn({ input: { ...turn().input,
      materialDriftRecovery: { ...intent, sourceMarker: { ...marker, extra: true } } } }))).toEqual({ status: "invalid" })
    expect(readMaterialDriftRecoveryIntent(turn({ input: { ...turn().input,
      materialDriftRecovery: { ...intent, schemaVersion: "agent-harness.v2.material-drift-recovery.v1" } } }))).toEqual({ status: "invalid" })
    const getter = vi.fn(() => { throw new Error("untrusted getter executed") })
    const input = { goal: "x", automationRunMode: "manual", scheduledAutomationSnapshot: snapshot }
    Object.defineProperty(input, "materialDriftRecovery", { enumerable: true, get: getter })
    expect(readMaterialDriftRecoveryIntent(turn({ input }))).toEqual({ status: "invalid" })
    expect(getter).not.toHaveBeenCalled()
  })
})

describe("material-drift recovery source lineage", () => {
  it.each([{ count: 64, valid: true }, { count: 65, valid: false }])(
    "counts the current Turn toward the $count-recovery depth limit", async ({ count, valid }) => {
      const fixture = recoveryChainFixture(count)
      expect(await verifyMaterialDriftRecoveryLineage(fixture.client, fixture.current, fixture.currentIntent)).toBe(valid)
    },
  )
  it("requires exact lineage and rejects a newer non-automation Turn", async () => {
    const current = turn()
    const source = { id: "old-turn", userId: "user-1", sessionId: "session-1", source: "automation", executionMode: "canonical_task_graph",
      status: "interrupted", rootTaskId: "old-root", leaseVersion: 4, createdAt: new Date("2026-01-01T00:00:00Z"),
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot } }
    const rows = new Map<string, Record<string, unknown>>([
      ["agent_automations", { id: "automation-1", userId: "user-1", sessionId: "session-1" }],
      ["current", current], ["source", source], ["newest", { id: "old-turn" }],
      ["root", { id: "old-root", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root",
        parentTaskId: null, depth: 0, role: "orchestrator", taskType: "root", status: "interrupted", attemptCount: 2 }],
      ["gate", { id: "old-gate", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root",
        parentTaskId: "old-root", depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "failed", attemptCount: 3 }],
      ["agent_executions", { id: "execution-1", userId: "user-1", sessionId: "session-1", attemptCount: 8 }],
    ])
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const table = sql.includes('FROM "agent_automations"') ? "agent_automations"
        : sql.includes('FROM "agent_executions"') ? "agent_executions"
          : sql.includes('FROM "sub_agent_tasks"') ? values?.[0] === "old-root" ? "root" : "gate"
            : sql.includes('ORDER BY "createdAt" DESC') ? "newest"
              : sql.includes('FROM "agent_turns" AS turn') ? values?.[0] === "old-turn" ? "source" : "current" : "current"
      return { rows: rows.has(table) ? [rows.get(table)!] : [] }
    })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    expect(await verifyMaterialDriftRecoveryLineage(client, current, intent)).toBe(true)
    expect(query).toHaveBeenCalledTimes(7)
    const latestQuery = query.mock.calls.find(([sql]) => sql.includes('ORDER BY "createdAt" DESC'))?.[0]
    expect(latestQuery).not.toContain('"source"')
    expect(latestQuery).not.toContain('"executionMode"')
    rows.set("newest", { id: "newer-user-turn" })
    expect(await verifyMaterialDriftRecoveryLineage(client, current, intent)).toBe(false)
  })
  it("reports transient database failures as unavailable so the Turn can retry", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT turn.")) throw new Error("database offline")
      return { rows: [] }
    })
    const release = vi.fn()
    const result = await validateMaterialDriftRecoveryTurn({ connect: async () => ({ query, release }) } as unknown as pg.Pool,
      { turnId: intent.turnId, userId: intent.userId, sessionId: intent.sessionId }, intent)
    expect(result).toEqual({ status: "unavailable" })
    expect(query).toHaveBeenCalledWith("ROLLBACK")
    expect(release).toHaveBeenCalledOnce()
  })
  it("fails closed when a prior identity, status, or execution attempt no longer matches", async () => {
    const current = turn()
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('FROM "agent_turns" AS turn') ? [{ ...current, id: "wrong-turn" }] : [],
    }))
    expect(await verifyMaterialDriftRecoveryLineage({ query } as unknown as Pick<pg.PoolClient, "query">, current)).toBe(false)
  })
  it.each([7, 9])("rejects a recovery execution attempt count of %s instead of the exact reservation", async executionAttemptCount => {
    const current = turn(), source = { id: "old-turn", userId: "user-1", sessionId: "session-1", source: "automation",
      executionMode: "canonical_task_graph", status: "interrupted", rootTaskId: "old-root", leaseVersion: 4,
      createdAt: new Date("2026-01-01T00:00:00Z"), input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot } }
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM "agent_automations"')) return { rows: [{ id: "automation-1", userId: "user-1", sessionId: "session-1" }] }
      if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: "execution-1", userId: "user-1", sessionId: "session-1", attemptCount: executionAttemptCount }] }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [values?.[0] === "old-root"
        ? { id: "old-root", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", parentTaskId: null,
          depth: 0, role: "orchestrator", taskType: "root", status: "interrupted", attemptCount: 2 }
        : { id: "old-gate", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", parentTaskId: "old-root",
          depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "failed", attemptCount: 3 }] }
      if (sql.includes('ORDER BY "createdAt" DESC')) return { rows: [{ id: "old-turn" }] }
      if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [values?.[0] === "old-turn" ? source : current] }
      return { rows: [] }
    })
    expect(await verifyMaterialDriftRecoveryLineage({ query } as unknown as Pick<pg.PoolClient, "query">, current, intent)).toBe(false)
  })
  it("requires each stopped recovery Turn to chain to the original marker and exact reserved attempt", async () => {
    const predecessorIntent = { ...intent, turnId: "recovery-1", previousRecoveryTurnId: null, reservedExecutionAttemptCount: 8 }
    const predecessor = { id: "recovery-1", userId: "user-1", sessionId: "session-1", source: "automation",
      executionMode: "canonical_task_graph", status: "interrupted", createdAt: new Date("2026-01-02T00:00:00Z"),
      input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshot, materialDriftRecovery: predecessorIntent } }
    const currentIntent = { ...intent, turnId: "recovery-2", previousRecoveryTurnId: predecessor.id, reservedExecutionAttemptCount: 9 }
    const current = turn({ id: currentIntent.turnId, createdAt: new Date("2026-01-03T00:00:00Z"), input: {
      automationRunMode: "manual", scheduledAutomationSnapshot: snapshot, materialDriftRecovery: currentIntent } })
    const source = { id: "old-turn", userId: "user-1", sessionId: "session-1", source: "automation", executionMode: "canonical_task_graph",
      status: "interrupted", rootTaskId: "old-root", leaseVersion: 4, createdAt: new Date("2026-01-01T00:00:00Z"),
      input: { automationRunMode: "scheduled", scheduledAutomationSnapshot: snapshot } }
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM "agent_automations"')) return { rows: [{ id: "automation-1", userId: "user-1", sessionId: "session-1" }] }
      if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: "execution-1", userId: "user-1", sessionId: "session-1", attemptCount: 9 }] }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [values?.[0] === "old-root"
        ? { id: "old-root", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", parentTaskId: null,
          depth: 0, role: "orchestrator", taskType: "root", status: "interrupted", attemptCount: 2 }
        : { id: "old-gate", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", parentTaskId: "old-root",
          depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "failed", attemptCount: 3 }] }
      if (sql.includes('ORDER BY "createdAt" DESC')) return { rows: [{ id: predecessor.id }] }
      if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [values?.[0] === source.id ? source : values?.[0] === predecessor.id ? predecessor : current] }
      return { rows: [] }
    })
    const client = { query } as unknown as Pick<pg.PoolClient, "query">
    expect(await verifyMaterialDriftRecoveryLineage(client, current, currentIntent)).toBe(true)
    const forgedPredecessor = { ...predecessor, input: { ...predecessor.input,
      materialDriftRecovery: { ...predecessorIntent, sourceMarker: { ...marker, proofDigest: `sha256:${"f".repeat(64)}` } } } }
    query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes('FROM "agent_automations"')) return { rows: [{ id: "automation-1", userId: "user-1", sessionId: "session-1" }] }
      if (sql.includes('FROM "agent_executions"')) return { rows: [{ id: "execution-1", userId: "user-1", sessionId: "session-1", attemptCount: 9 }] }
      if (sql.includes('FROM "sub_agent_tasks"')) return { rows: [values?.[0] === "old-root"
        ? { id: "old-root", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", parentTaskId: null,
          depth: 0, role: "orchestrator", taskType: "root", status: "interrupted", attemptCount: 2 }
        : { id: "old-gate", userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", parentTaskId: "old-root",
          depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "failed", attemptCount: 3 }] }
      if (sql.includes('ORDER BY "createdAt" DESC')) return { rows: [{ id: predecessor.id }] }
      if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [values?.[0] === source.id ? source : values?.[0] === predecessor.id ? forgedPredecessor : current] }
      return { rows: [] }
    })
    expect(await verifyMaterialDriftRecoveryLineage(client, current, currentIntent)).toBe(false)
  })
})
