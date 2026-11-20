import { describe, expect, it, vi } from "vitest"

import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import { addScheduledPrepareActions, prepareCanonicalTurnSetup, taskGraphDenialCheckpointReader, taskGraphTemplateRoleView, turnStoreForInteractiveDiscovery } from "./canonical-turn-runtime-turn-setup.js"
import { TASK_GRAPH_TEMPLATES } from "./subagents/task-graph-templates.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, type TaskGraphDenialCheckpoint } from "./turns/task-graph-terminal-assessment.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT } from "./turns/turn-execution-types.js"
import type { TurnEngineQueryClient } from "./turns/turn-engine-owner-sql.js"
import { MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA, readMaterialDriftRecoveryIntent, scheduledAutomationSnapshotDigest } from "./subagents/canonical-turn-scheduled-pipeline-context.js"
import { classifyTurnFailure } from "./turns/dlq.js"

const owner = {
  kind: "turn" as const, userId: "user-1", sessionId: "session-1", turnId: "turn-1", taskId: "root-1", rootTaskId: "root-1",
  ownerId: "worker-1", leaseVersion: 2, leaseExpiresAt: new Date("2026-10-01T00:01:00.000Z"),
}

describe("canonical interactive discovery store composition", () => {
  it("routes atomic no-progress input unchanged to the owner-fenced base store", async () => {
    const recordFinalResponse = vi.fn(async (_input: Parameters<TurnEngineStore["recordFinalResponse"]>[0]) => ({ status: "input_changed" as const }))
    const base = { recordFinalResponse } as unknown as TurnEngineStore
    const composed = turnStoreForInteractiveDiscovery(base, true, () => undefined)
    const input: Parameters<TurnEngineStore["recordFinalResponse"]>[0] = {
      owner, response: "{}", now: new Date(), noProgress: {
        stepId: "step-1", finalItemId: "final-1", finalContent: { text: "repeated denial" }, stepCount: 2,
        toolCallCount: 0, usage: { inputTokens: 4, outputTokens: 3, estimatedCostUsd: 0 },
        inputThroughSequence: 0n, consumedInputIds: [], reasonCode: "repeated_signature",
        signature: "task_graph_terminal_denial", stateFingerprint: "task_graph_terminal_denial",
      },
    }

    await expect(composed.recordFinalResponse(input)).resolves.toEqual({ status: "input_changed" })
    expect(recordFinalResponse).toHaveBeenCalledOnce()
    expect(recordFinalResponse.mock.calls[0]?.[0]).toBe(input)
  })

  it("keeps shortlist validation on ordinary interactive terminal responses", async () => {
    const recordFinalResponse = vi.fn(async (_input: Parameters<TurnEngineStore["recordFinalResponse"]>[0]) => undefined)
    const composed = turnStoreForInteractiveDiscovery({ recordFinalResponse } as unknown as TurnEngineStore, true, () => undefined)

    await expect(composed.recordFinalResponse({
      owner, response: "{}", now: new Date(), terminal: {
        stepId: "step-1", finalItemId: "final-1", finalContent: { text: "candidate" }, stepCount: 1,
        toolCallCount: 0, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
      }, noProgress: {
        stepId: "step-1", finalItemId: "final-1", finalContent: { text: "candidate" }, stepCount: 1,
        toolCallCount: 0, usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
        inputThroughSequence: 0n, consumedInputIds: [], reasonCode: "repeated_signature",
        signature: "task_graph_terminal_denial", stateFingerprint: "task_graph_terminal_denial",
      },
    })).rejects.toThrow("interactive_discovery_shortlist_missing")
    expect(recordFinalResponse).not.toHaveBeenCalled()
  })

  it("keeps scheduled Prepare actions available to the root task", () => {
    const initial = [TASK_GRAPH_TEMPLATES.prepare.allowedActions[0]!, "jobs.search"]
    const expected = [...initial, ...TASK_GRAPH_TEMPLATES.prepare.allowedActions.filter(action => !initial.includes(action))]
    expect(addScheduledPrepareActions([...initial], { source: "automation", automationRunMode: "scheduled" }, true)).toEqual(expected)
    expect(addScheduledPrepareActions(["jobs.search"], { source: "automation", automationRunMode: "scheduled" }, false)).toEqual(["jobs.search"])
    expect(addScheduledPrepareActions(["jobs.search"], { source: "automation", automationRunMode: "manual" }, true, true)).toEqual([
      "jobs.search", ...TASK_GRAPH_TEMPLATES.prepare.allowedActions,
    ])
    expect(addScheduledPrepareActions(["jobs.search"], { source: "automation", automationRunMode: "manual" }, true)).toEqual(["jobs.search"])
  })

  it("forwards the atomic transaction client into the TaskGraph checkpoint read", async () => {
    const checkpoint: TaskGraphDenialCheckpoint = { schemaVersion: TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, taskId: "root-1",
      graphRevision: 3, verificationDigest: "a".repeat(64) }
    const client = {} as TurnEngineQueryClient
    const decision = { ok: false as const, blocker: "task_graph_verification_unverified", feedback: "verification needed" }
    Object.defineProperty(decision, TASK_GRAPH_DENIAL_CHECKPOINT, { value: checkpoint })
    const checkCompletion = vi.fn(async (input: { readonly client?: unknown }) => {
      expect(input.client).toBe(client)
      return decision
    })
    const readCheckpoint = taskGraphDenialCheckpointReader({ enabled: true, rootTasks: { checkCompletion } as never,
      lease: {} as never, rootTaskId: "root-1", now: () => new Date() })
    if (!readCheckpoint) throw new Error("Expected a TaskGraph checkpoint reader")

    await expect(readCheckpoint(client)).resolves.toEqual(checkpoint)
    expect(checkCompletion).toHaveBeenCalledOnce()
    expect(checkCompletion.mock.calls[0]?.[0].client).toBe(client)
  })
})

describe("material drift recovery setup intent", () => {
  const turn = (source: string, input: unknown) => readMaterialDriftRecoveryIntent({
    id: "turn-1", userId: "user-1", sessionId: "session-1", source, executionMode: "canonical_task_graph", input,
  })

  it.each([
    ["missing manual mode", "automation", { materialDriftRecovery: {} }],
    ["wrong manual mode", "automation", { automationRunMode: "scheduled", materialDriftRecovery: {} }],
    ["non-automation source", "user", { automationRunMode: "manual", materialDriftRecovery: {} }],
  ])("fails closed for a present intent with %s", (_label, source, input) => {
    expect(turn(source, input)).toEqual({ status: "invalid" })
  })

  it("keeps absent input on the ordinary path", () => {
    expect(turn("user", undefined)).toEqual({ status: "absent" })
  })

  it.each([
    ["missing manual mode", "automation", { materialDriftRecovery: {} }],
    ["wrong manual mode", "automation", { automationRunMode: "scheduled", materialDriftRecovery: {} }],
    ["non-automation source", "user", { automationRunMode: "manual", materialDriftRecovery: {} }],
  ])("terminates setup for a present intent with %s", async (_label, source, turnInput) => {
    const ensure = vi.fn(async () => ({ id: "root-1" })), finish = vi.fn(async () => undefined)
    const executionFinish = vi.fn(async () => undefined), sessionFinish = vi.fn(async () => undefined)
    const connect = vi.fn(async () => { throw new Error("invalid intent must not query DB") })
    const state = { source, automationRunMode: (turnInput as Record<string, unknown>).automationRunMode, turnInput, goal: "Run automation",
      modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }
    const result = await prepareCanonicalTurnSetup({
      pool: { connect } as never, lease: { userId: "user-1", sessionId: "session-1", turnId: "turn-1" } as never,
      signal: new AbortController().signal, now: () => new Date(), options: { stateLoader: async () => state } as never,
      manager: {} as never, rootTasks: { ensure, finish } as never,
      executionProjection: { finish: executionFinish } as never, sessionProjection: { finish: sessionFinish } as never,
      coordinationEnabled: false, childExecutionEnabled: false, consumeWaitOutcomes: false,
    })
    expect(result).toMatchObject({ earlyResult: { status: "failed", summary: "material_drift_recovery_invalid" } })
    expect(connect).not.toHaveBeenCalled()
    expect(ensure).toHaveBeenCalledOnce(); expect(finish).toHaveBeenCalledOnce()
    expect(executionFinish).toHaveBeenCalledOnce(); expect(sessionFinish).toHaveBeenCalledOnce()
  })

  it("retries setup when valid recovery lineage cannot be read because the database is unavailable", async () => {
    const snapshot = { schemaVersion: "agent-harness.v2.scheduled-automation-snapshot.v1", targetRoles: ["engineer"],
      targetLocations: ["Dublin"], minScore: 70, dailyCap: 8, requireApproval: true, autoApply: false }
    const intent = { schemaVersion: MATERIAL_DRIFT_RECOVERY_INTENT_SCHEMA, turnId: "turn-1", userId: "user-1", sessionId: "session-1",
      automationId: "automation-1", previousRecoveryTurnId: null, previousTurnId: "old-turn", previousExecutionId: "execution-1",
      previousGateTaskId: "old-gate", previousGateAttemptCount: 1, previousRootTaskId: "old-root", previousRootAttemptCount: 1,
      previousTurnLeaseVersion: 1, previousExecutionAttemptCount: 3, reservedExecutionAttemptCount: 4,
      currentSnapshotDigest: scheduledAutomationSnapshotDigest(snapshot), sourceMarker: {
        schemaVersion: "agent-harness.v2.scheduled-prepare-material-drift-terminal.v1", reason: "scheduled_prepare_material_source_changed",
        owner: { userId: "user-1", sessionId: "session-1", turnId: "old-turn", rootTaskId: "old-root", rootAttemptCount: 1,
          turnLeaseOwnerId: "old-worker", turnLeaseVersion: 1, executionId: "execution-1", executionAttemptCount: 3 },
        gate: { taskId: "old-gate", leaseOwnerId: "gate-worker", attemptCount: 1 }, ...Object.fromEntries(
          ["a", "b", "c", "d", "e"].map((value, index) => [["analyzeFingerprintDigest", "prepareProofDigest", "artifactDigest", "currentMaterialDigest", "proofDigest"][index]!, `sha256:${value.repeat(64)}`]),
        ),
      },
    }
    const query = vi.fn(async (sql: string) => {
      if (sql.startsWith("SELECT turn.")) throw new Error("database offline")
      return { rows: [] }
    })
    const release = vi.fn(), ensure = vi.fn(), executionFinish = vi.fn(), sessionFinish = vi.fn()
    const state = { source: "automation", automationRunMode: "manual", turnInput: { automationRunMode: "manual",
      scheduledAutomationSnapshot: snapshot, materialDriftRecovery: intent }, goal: "Run automation",
      modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {} }
    const failure = new Error("material_drift_recovery_validation_unavailable")
    await expect(prepareCanonicalTurnSetup({
      pool: { connect: async () => ({ query, release }) } as never,
      lease: { userId: "user-1", sessionId: "session-1", turnId: "turn-1" } as never,
      signal: new AbortController().signal, now: () => new Date(), options: { stateLoader: async () => state } as never,
      manager: {} as never, rootTasks: { ensure, finish: vi.fn() } as never,
      executionProjection: { finish: executionFinish } as never, sessionProjection: { finish: sessionFinish } as never,
      coordinationEnabled: false, childExecutionEnabled: false, consumeWaitOutcomes: false,
    })).rejects.toThrow(failure.message)
    expect(classifyTurnFailure(failure, 0)).toMatchObject({ disposition: "retry", reasonCode: "execution_failed" })
    expect(release).toHaveBeenCalledOnce(); expect(ensure).not.toHaveBeenCalled()
    expect(executionFinish).not.toHaveBeenCalled(); expect(sessionFinish).not.toHaveBeenCalled()
  })
})

describe("active TaskGraph template role view", () => {
  it("freezes only valid role values from the active template map", () => {
    const roles = taskGraphTemplateRoleView({
      scout: { ...TASK_GRAPH_TEMPLATES.scout, role: "analyst", context: { privateRegistryContext: "PRIVATE_TEMPLATE_CONTEXT" } },
      analyst: TASK_GRAPH_TEMPLATES.analyst,
      invalidRole: { ...TASK_GRAPH_TEMPLATES.scout, role: "" },
    })

    expect(roles?.scout).toBe("analyst")
    expect(roles?.analyst).toBe("analyst")
    expect(roles).not.toHaveProperty("invalidRole")
    expect(Object.isFrozen(roles)).toBe(true)
    expect(Object.keys(roles ?? {})).toEqual(["scout", "analyst"])
    expect(JSON.stringify(roles)).not.toMatch(/privateRegistryContext|PRIVATE_TEMPLATE_CONTEXT|allowedActions/)
    expect(taskGraphTemplateRoleView(undefined)).toBeUndefined()
  })
})
