import { describe, expect, it } from "vitest"
import { parseMaterialDriftRecoveryIntent, validateActiveMaterialDriftRecoveryChain, validateMaterialDriftRecoveryChain,
  validateMaterialDriftSourceMarker, type RecoveryLineageTurn } from "./material-drift-recovery-lineage"
import { scheduledAutomationSnapshotDigest } from "./scheduled-taskgraph-pipeline-checkpoint"

const scope = { userId: "user_1", sessionId: "session_1", automationId: "automation_1" }
const sourceMarker = { schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1", reason: "scheduled_prepare_material_source_changed",
  owner: { userId: "user_1", sessionId: "session_1", turnId: "source_turn", rootTaskId: "root_1", rootAttemptCount: 2,
    turnLeaseOwnerId: "lease_old", turnLeaseVersion: 3, executionId: "execution_1", executionAttemptCount: 4 },
  gate: { taskId: "gate_1", leaseOwnerId: "gate_lease", attemptCount: 5 },
  analyzeFingerprintDigest: `sha256:${"a".repeat(64)}`, prepareProofDigest: `sha256:${"b".repeat(64)}`,
  artifactDigest: `sha256:${"c".repeat(64)}`, currentMaterialDigest: `sha256:${"d".repeat(64)}`, proofDigest: `sha256:${"e".repeat(64)}` }

function sourceTurn(createdAt = 1_000): RecoveryLineageTurn {
  return { id: "source_turn", userId: scope.userId, sessionId: scope.sessionId, status: "interrupted", source: "automation",
    executionMode: "canonical_task_graph", input: { automationRunMode: "scheduled" }, rootTaskId: "root_1", leaseVersion: 3,
    createdAt: new Date(createdAt) }
}

function recoveryTurn(input: { id: string; prior?: string | null; reserved: number; createdAt: number; status?: string; snapshot?: number }): RecoveryLineageTurn {
  const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["SWE"], targetLocations: ["Berlin"],
    minScore: input.snapshot ?? 85, dailyCap: 8, requireApproval: true, autoApply: false }
  const intent = { schemaVersion: "agent-harness.v2.material-drift-recovery.v2", turnId: input.id, ...scope,
    previousTurnId: "source_turn", previousExecutionId: "execution_1", previousGateTaskId: "gate_1", previousGateAttemptCount: 5,
    previousRootTaskId: "root_1", previousRootAttemptCount: 2, previousTurnLeaseVersion: 3, previousExecutionAttemptCount: 4,
    previousRecoveryTurnId: input.prior ?? null, reservedExecutionAttemptCount: input.reserved,
    currentSnapshotDigest: scheduledAutomationSnapshotDigest(snapshot), sourceMarker }
  return { id: input.id, userId: scope.userId, sessionId: scope.sessionId, status: input.status ?? "interrupted",
    source: "automation", executionMode: "canonical_task_graph", input: { automationRunMode: "manual", scheduledAutomationSnapshot: snapshot, materialDriftRecovery: intent },
    rootTaskId: `new_root_${input.id}`, leaseVersion: 1, createdAt: new Date(input.createdAt) }
}

function validThirdAttempt(): RecoveryLineageTurn[] {
  return [recoveryTurn({ id: "recovery_3", prior: "recovery_2", reserved: 7, createdAt: 4_000 }),
    recoveryTurn({ id: "recovery_2", prior: "recovery_1", reserved: 6, createdAt: 3_000, snapshot: 86 }),
    recoveryTurn({ id: "recovery_1", reserved: 5, createdAt: 2_000, snapshot: 87 }), sourceTurn()]
}

describe("material drift recovery lineage", () => {
  it("validates a third Turn back to the original scheduled source and preserves reserved generations", () => {
    const turns = validThirdAttempt()
    const result = validateMaterialDriftRecoveryChain(turns, scope)

    expect(result).toMatchObject({ sourceTurn: turns[3], initialIntent: { turnId: "recovery_1", reservedExecutionAttemptCount: 5 },
      latestIntent: { turnId: "recovery_3", reservedExecutionAttemptCount: 7 } })
  })

  it("allows each fresh recovery to bind a different current snapshot digest", () => {
    expect(validateMaterialDriftRecoveryChain(validThirdAttempt(), scope)).not.toBeNull()
  })

  it("validates an active current Turn only over its terminal predecessors", () => {
    const turns = validThirdAttempt(), active = { ...turns[0]!, status: "in_progress" }
    expect(validateActiveMaterialDriftRecoveryChain(active, turns.slice(1, 3), turns[3]!, scope))
      .toMatchObject({ sourceTurn: turns[3], initialIntent: { turnId: "recovery_1" }, latestIntent: { turnId: "recovery_3" } })
  })

  it("rejects ordinary manual Turns and active recovery markers that diverge from the verified predecessor", () => {
    const turns = validThirdAttempt(), current = turns[0]!, active = { ...current, status: "waiting_for_dependency" }
    expect(validateActiveMaterialDriftRecoveryChain({ ...active, input: { automationRunMode: "manual" } }, turns.slice(1, 3), turns[3]!, scope)).toBeNull()
    const input = active.input as { materialDriftRecovery: Record<string, unknown> }
    const forged = { ...active, input: { ...active.input as object, materialDriftRecovery: { ...input.materialDriftRecovery,
      sourceMarker: { ...input.materialDriftRecovery.sourceMarker as object, proofDigest: `sha256:${"f".repeat(64)}` } } } }
    expect(validateActiveMaterialDriftRecoveryChain(forged, turns.slice(1, 3), turns[3]!, scope)).toBeNull()
  })

  it("rejects an active recovery whose predecessor is not terminal", () => {
    const turns = validThirdAttempt(), active = { ...turns[0]!, status: "in_progress" }
    const nonterminal = { ...turns[1]!, status: "waiting_for_user" }
    expect(validateActiveMaterialDriftRecoveryChain(active, [nonterminal, turns[2]!], turns[3]!, scope)).toBeNull()
    expect(validateActiveMaterialDriftRecoveryChain({ ...active, status: "completed" }, turns.slice(1, 3), turns[3]!, scope)).toBeNull()
  })

  it("revalidates the immutable source marker against original rows and the latest reserved attempt", () => {
    const turns = validThirdAttempt()
    const chain = validateMaterialDriftRecoveryChain(turns, scope)
    expect(chain).not.toBeNull()
    const source = turns[3]
    const root = { id: "root_1", sessionId: scope.sessionId, turnId: source.id, rootTaskId: "root_1", parentTaskId: null,
      depth: 0, role: "orchestrator", taskType: "root", status: "failed", attemptCount: 2 }
    const gate = { id: "gate_1", sessionId: scope.sessionId, turnId: source.id, rootTaskId: "root_1", parentTaskId: "root_1",
      depth: 1, role: "prepare", taskType: "scheduled_taskgraph_gate", status: "failed", attemptCount: 5 }
    const execution = { id: "execution_1", userId: scope.userId, sessionId: scope.sessionId, attemptCount: 7 }

    expect(validateMaterialDriftSourceMarker({ sourceTurn: source, root, gate, execution, intent: chain!.latestIntent })).toBe(true)
    expect(validateMaterialDriftSourceMarker({ sourceTurn: source, root: { ...root, attemptCount: 3 }, gate, execution, intent: chain!.latestIntent })).toBe(false)
    expect(validateMaterialDriftSourceMarker({ sourceTurn: source, root, gate, execution: { ...execution, attemptCount: 6 }, intent: chain!.latestIntent })).toBe(false)
  })

  it.each([
    ["wrong predecessor", (turns: RecoveryLineageTurn[]) => ({ ...turns[0], input: { ...turns[0].input as object,
      materialDriftRecovery: { ...(turns[0].input as { materialDriftRecovery: object }).materialDriftRecovery, previousRecoveryTurnId: "foreign" } } })],
    ["reserved attempt gap", (turns: RecoveryLineageTurn[]) => ({ ...turns[1], input: { ...turns[1].input as object,
      materialDriftRecovery: { ...(turns[1].input as { materialDriftRecovery: object }).materialDriftRecovery, reservedExecutionAttemptCount: 8 } } })],
    ["changed source marker", (turns: RecoveryLineageTurn[]) => ({ ...turns[1], input: { ...turns[1].input as object,
      materialDriftRecovery: { ...(turns[1].input as { materialDriftRecovery: Record<string, unknown> }).materialDriftRecovery, sourceMarker: { reason: "forged" } } } })],
    ["wrong owner", (turns: RecoveryLineageTurn[]) => ({ ...turns[1], userId: "other_user" })],
    ["completed predecessor", (turns: RecoveryLineageTurn[]) => ({ ...turns[1], status: "completed" })],
    ["non-monotonic time", (turns: RecoveryLineageTurn[]) => ({ ...turns[1], createdAt: turns[0].createdAt })],
    ["cycle", (turns: RecoveryLineageTurn[]) => ({ ...turns[1], input: { ...turns[1].input as object,
      materialDriftRecovery: { ...(turns[1].input as { materialDriftRecovery: object }).materialDriftRecovery, previousRecoveryTurnId: "recovery_3" } } })],
  ] as const)("fails closed for %s", (_label, corrupt) => {
    const turns = validThirdAttempt()
    turns[1] = corrupt(turns)
    expect(validateMaterialDriftRecoveryChain(turns, scope)).toBeNull()
  })

  it("rejects a chain beyond the bounded predecessor depth", () => {
    const chain = Array.from({ length: 65 }, (_, index) => recoveryTurn({ id: `recovery_${65 - index}`,
      prior: index < 64 ? `recovery_${64 - index}` : null, reserved: 69 - index, createdAt: 70_000 - index * 1_000 }))
    const turns = [...chain, sourceTurn()]
    expect(validateMaterialDriftRecoveryChain(turns, scope)).toBeNull()
  })

  it("rejects malformed or mismatched current intents and source lineage", () => {
    const turn = recoveryTurn({ id: "recovery_1", reserved: 5, createdAt: 2_000 })
    const intent = (turn.input as { materialDriftRecovery: Record<string, unknown> }).materialDriftRecovery
    expect(parseMaterialDriftRecoveryIntent({ ...intent, unexpected: true }, turn, scope)).toBeNull()
    expect(parseMaterialDriftRecoveryIntent(intent, { ...turn, id: "copied_turn" }, scope)).toBeNull()
    expect(validateMaterialDriftRecoveryChain([turn, { ...sourceTurn(), status: "completed" }], scope)).toBeNull()
    expect(validateMaterialDriftRecoveryChain([turn, { ...sourceTurn(), rootTaskId: "foreign_root" }], scope)).toBeNull()
  })
})
