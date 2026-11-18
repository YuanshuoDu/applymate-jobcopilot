import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolveScheduledTaskGraphRecoveryAdmission } from "./scheduled-taskgraph-recovery-admission"
import type { MaterialDriftRecoveryIntent, RecoveryLineageTurn } from "./material-drift-recovery-lineage"
import type { ScheduledAutomationSnapshot } from "./scheduled-automation-snapshot"
import { scheduledAutomationSnapshotDigest, type ScheduledTaskGraphPipelineOwner } from "./scheduled-taskgraph-pipeline-checkpoint"

const owner: ScheduledTaskGraphPipelineOwner = { userId: "user_1", sessionId: "session_1", turnId: "recovery_1", rootTaskId: "new_root",
  rootAttemptCount: 1, turnLeaseOwnerId: "current_lease", turnLeaseVersion: 1, executionId: "execution_1", executionAttemptCount: 5 }
const scope = { userId: owner.userId, sessionId: owner.sessionId, automationId: "automation_1" }
const snapshot: ScheduledAutomationSnapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1",
  targetRoles: ["SWE"], targetLocations: ["Berlin"], minScore: 85, dailyCap: 8, requireApproval: true, autoApply: false }
const sourceMarker = { schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1",
  reason: "scheduled_prepare_material_source_changed",
  owner: { userId: scope.userId, sessionId: scope.sessionId, turnId: "source_turn", rootTaskId: "old_root", rootAttemptCount: 2,
    turnLeaseOwnerId: "old_lease", turnLeaseVersion: 3, executionId: "execution_1", executionAttemptCount: 4 },
  gate: { taskId: "old_gate", leaseOwnerId: "old_gate_lease", attemptCount: 5 },
  analyzeFingerprintDigest: digest("a"), prepareProofDigest: digest("b"), artifactDigest: digest("c"),
  currentMaterialDigest: digest("d"), proofDigest: digest("e") }

type StoredTurn = RecoveryLineageTurn & { leaseOwnerId?: string | null }
type TaskRow = { id: string; userId: string; sessionId: string; turnId: string | null; rootTaskId: string | null;
  parentTaskId: string | null; depth: number; role: string; taskType: string; status: string; attemptCount: number;
  interruptRequestedAt: Date | null; closedAt: Date | null }
type FixtureRows = { session: { id: string; userId: string; source: string; status: string }; turns: StoredTurn[]; tasks: TaskRow[];
  automation: { id: string; userId: string; sessionId: string | null }; execution: { id: string; userId: string; sessionId: string; attemptCount: number } }
type AdmissionClient = Parameters<typeof resolveScheduledTaskGraphRecoveryAdmission>[0]["client"]

function digest(char: string): string { return `sha256:${char.repeat(64)}` }
function recoveryIntent(input: { turnId: string; reserved: number; prior: string | null; currentSnapshot?: unknown }): MaterialDriftRecoveryIntent {
  return { schemaVersion: "agent-harness.v2.material-drift-recovery.v2", turnId: input.turnId, ...scope,
    previousTurnId: "source_turn", previousExecutionId: "execution_1", previousGateTaskId: "old_gate", previousGateAttemptCount: 5,
    previousRootTaskId: "old_root", previousRootAttemptCount: 2, previousTurnLeaseVersion: 3, previousExecutionAttemptCount: 4,
    previousRecoveryTurnId: input.prior, reservedExecutionAttemptCount: input.reserved,
    currentSnapshotDigest: scheduledAutomationSnapshotDigest(input.currentSnapshot ?? snapshot), sourceMarker }
}
function sourceTurn(): RecoveryLineageTurn { return { id: "source_turn", userId: scope.userId, sessionId: scope.sessionId, status: "interrupted",
  source: "automation", executionMode: "canonical_task_graph", input: { automationRunMode: "scheduled" }, rootTaskId: "old_root",
  leaseVersion: 3, createdAt: new Date(1_000) } }
function fixture(): FixtureRows {
  const intent = recoveryIntent({ turnId: owner.turnId, reserved: 5, prior: null })
  const current: StoredTurn = { id: owner.turnId, userId: owner.userId, sessionId: owner.sessionId, status: "in_progress",
    source: "automation", executionMode: "canonical_task_graph", input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshot,
      materialDriftRecovery: intent }, rootTaskId: owner.rootTaskId, leaseVersion: owner.turnLeaseVersion,
    leaseOwnerId: owner.turnLeaseOwnerId, createdAt: new Date(2_000) }
  return { session: { id: owner.sessionId, userId: owner.userId, source: "automation", status: "running" },
    turns: [current, sourceTurn()],
    tasks: [
      { id: owner.rootTaskId, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
        parentTaskId: null, depth: 0, role: "orchestrator", taskType: "root", status: "waiting", attemptCount: 1,
        interruptRequestedAt: null, closedAt: null },
      { id: "old_root", userId: owner.userId, sessionId: owner.sessionId, turnId: "source_turn", rootTaskId: "old_root",
        parentTaskId: null, depth: 0, role: "orchestrator", taskType: "root", status: "failed", attemptCount: 2,
        interruptRequestedAt: null, closedAt: null },
      { id: "old_gate", userId: owner.userId, sessionId: owner.sessionId, turnId: "source_turn", rootTaskId: "old_root",
        parentTaskId: "old_root", depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "failed", attemptCount: 5,
        interruptRequestedAt: null, closedAt: null },
    ],
    automation: { id: scope.automationId, userId: owner.userId, sessionId: owner.sessionId },
    execution: { id: owner.executionId, userId: owner.userId, sessionId: owner.sessionId, attemptCount: 5 } }
}
function admissionClient(rows: FixtureRows): AdmissionClient {
  const query = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
    const sql = parts.join(" ")
    if (sql.includes('FROM "agent_sessions"')) return [rows.session.id === values[0] && rows.session.userId === values[1] ? rows.session : undefined].filter(Boolean)
    if (sql.includes('FROM "agent_automations"')) return [rows.automation.id === values[0] && rows.automation.userId === values[1]
      && rows.automation.sessionId === values[2] ? rows.automation : undefined].filter(Boolean)
    if (sql.includes('FROM "agent_turns"')) return rows.turns.filter(turn => turn.id === values[0] && turn.userId === values[1] && turn.sessionId === values[2])
    if (sql.includes('FROM "sub_agent_tasks"')) return rows.tasks.filter(task => task.id === values[0] && task.sessionId === values[1]
      && task.turnId === values[2] && task.userId === values.at(-1))
    if (sql.includes('FROM "agent_executions"')) return [rows.execution.id === values[0] && rows.execution.userId === values[1]
      && rows.execution.sessionId === values[2] ? rows.execution : undefined].filter(Boolean)
    return []
  })
  return { $queryRaw: query } as unknown as AdmissionClient
}
function privateRequest(secret = "worker-secret", body: unknown = {}): Request {
  return new Request("https://applymate.invalid/api/internal/agent-runtime/scheduled-pipeline", { method: "POST",
    headers: { "x-agent-worker-secret": secret, "content-type": "application/json" }, body: JSON.stringify(body) })
}

beforeEach(() => vi.stubEnv("AGENT_WORKER_SECRET", "worker-secret"))
afterEach(() => vi.unstubAllEnvs())

describe("scheduled TaskGraph recovery admission", () => {
  it("admits a current private manual recovery without changing mode or exposing historical marker data", async () => {
    const rows = fixture()
    const result = await resolveScheduledTaskGraphRecoveryAdmission({ client: admissionClient(rows), request: privateRequest(), owner })

    expect(result).toEqual({ snapshot, automationId: scope.automationId, owner })
    expect((rows.turns[0]!.input as { automationRunMode: string }).automationRunMode).toBe("manual")
    expect(Object.keys(result ?? {}).sort()).toEqual(["automationId", "owner", "snapshot"])
    expect(JSON.stringify(result)).not.toContain("sourceMarker")
  })

  it("requires the worker secret before reading persisted state", async () => {
    const client = admissionClient(fixture())
    expect(await resolveScheduledTaskGraphRecoveryAdmission({ client, request: privateRequest("wrong"), owner })).toBeNull()
    expect(vi.mocked(client.$queryRaw)).not.toHaveBeenCalled()
  })

  it("rejects ordinary manual Runs even when the client supplies a forged recovery body", async () => {
    const rows = fixture(), current = rows.turns[0]!
    rows.turns[0] = { ...current, input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshot } }
    const result = await resolveScheduledTaskGraphRecoveryAdmission({ client: admissionClient(rows), request: privateRequest("worker-secret",
      { automationRunMode: "scheduled", materialDriftRecovery: (current.input as { materialDriftRecovery: unknown }).materialDriftRecovery }), owner })
    expect(result).toBeNull()
  })

  it.each([
    ["current turn lease version", (rows: FixtureRows) => { rows.turns[0] = { ...rows.turns[0]!, leaseVersion: 2 } }],
    ["current turn lease owner", (rows: FixtureRows) => { rows.turns[0] = { ...rows.turns[0]!, leaseOwnerId: "replaced_lease" } }],
    ["missing current turn lease owner", (rows: FixtureRows) => { rows.turns[0] = { ...rows.turns[0]!, leaseOwnerId: null } }],
    ["queued current Turn", (rows: FixtureRows) => { rows.turns[0] = { ...rows.turns[0]!, status: "queued" } }],
    ["completed current Turn", (rows: FixtureRows) => { rows.turns[0] = { ...rows.turns[0]!, status: "completed" } }],
    ["current root attempt", (rows: FixtureRows) => { rows.tasks[0] = { ...rows.tasks[0]!, attemptCount: 2 } }],
    ["inactive current root", (rows: FixtureRows) => { rows.tasks[0] = { ...rows.tasks[0]!, status: "completed" } }],
    ["current execution attempt", (rows: FixtureRows) => { rows.execution = { ...rows.execution, attemptCount: 6 } }],
    ["source Gate attempt", (rows: FixtureRows) => { rows.tasks[2] = { ...rows.tasks[2]!, attemptCount: 6 } }],
    ["pinned snapshot digest", (rows: FixtureRows) => { const turn = rows.turns[0]!; rows.turns[0] = { ...turn,
      input: { ...(turn.input as object), scheduledAutomationSnapshot: { ...snapshot, minScore: 90 } } } }],
    ["automation ownership", (rows: FixtureRows) => { rows.automation = { ...rows.automation, userId: "other_user" } }],
    ["terminal stale Turn", (rows: FixtureRows) => { rows.turns[0] = { ...rows.turns[0]!, status: "failed" } }],
  ] as const)("fails closed on %s mismatch", async (_label, corrupt) => {
    const rows = fixture()
    corrupt(rows)
    expect(await resolveScheduledTaskGraphRecoveryAdmission({ client: admissionClient(rows), request: privateRequest(), owner })).toBeNull()
  })

  it("validates a fresh Turn against every persisted recovery predecessor", async () => {
    const rows = fixture(), priorSnapshot = { ...snapshot, minScore: 87 }
    const priorIntent = recoveryIntent({ turnId: "recovery_1", reserved: 5, prior: null, currentSnapshot: priorSnapshot })
    const prior = { ...rows.turns[0]!, id: "recovery_1", status: "interrupted", createdAt: new Date(3_000),
      input: { automationRunMode: "manual", scheduledAutomationSnapshot: priorSnapshot, materialDriftRecovery: priorIntent } }
    const nextOwner = { ...owner, turnId: "recovery_2", rootTaskId: "new_root_2", rootAttemptCount: 1, executionAttemptCount: 6 }
    const nextIntent = recoveryIntent({ turnId: nextOwner.turnId, reserved: 6, prior: prior.id })
    rows.turns[0] = { ...rows.turns[0]!, id: nextOwner.turnId, ...nextOwner, input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshot,
      materialDriftRecovery: nextIntent }, createdAt: new Date(4_000) }
    rows.turns.push(prior)
    rows.tasks[0] = { ...rows.tasks[0]!, id: nextOwner.rootTaskId, turnId: nextOwner.turnId, rootTaskId: nextOwner.rootTaskId,
      attemptCount: nextOwner.rootAttemptCount }
    rows.execution = { ...rows.execution, attemptCount: nextOwner.executionAttemptCount }

    expect(await resolveScheduledTaskGraphRecoveryAdmission({ client: admissionClient(rows), request: privateRequest(), owner: nextOwner }))
      .toEqual({ snapshot, automationId: scope.automationId, owner: nextOwner })
  })
})
