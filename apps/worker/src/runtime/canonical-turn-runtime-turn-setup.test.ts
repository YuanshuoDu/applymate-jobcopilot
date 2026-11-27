import { describe, expect, it, vi } from "vitest"

const setupMocks = vi.hoisted(() => ({
  prepareBatch: vi.fn(), failBatch: vi.fn(), graph: vi.fn(), registerPlanning: vi.fn(), ensure: vi.fn(),
}))
vi.mock("./canonical-selected-job-batch-setup.js", () => ({
  canonicalSelectedJobBatchRuntimeAvailable: () => true,
  prepareCanonicalSelectedJobBatchForTurn: setupMocks.prepareBatch,
  failCanonicalSelectedJobBatchUnavailable: setupMocks.failBatch,
}))
vi.mock("./subagents/task-graph-templates.js", async importOriginal => {
  const actual = await importOriginal<typeof import("./subagents/task-graph-templates.js")>()
  return { ...actual, taskGraphRuntimeForTurn: setupMocks.graph }
})
vi.mock("./canonical-turn-coordination.js", () => ({ createCanonicalTurnCoordination: () => ({ nativeOptions: { enabled: false }, bindRoot: vi.fn() }) }))
vi.mock("./policy/canonical-policy.js", () => ({ createCanonicalPolicy: () => ({}) }))
vi.mock("./context/root-task-objective.js", () => ({ resolveRootTaskVerificationRequirements: () => ({ status: "none" }) }))
vi.mock("./canonical-turn-config.js", () => ({ capabilities: () => [] }))
vi.mock("./subagents/durable-wait-store.js", () => ({ createPgDurableWaitPort: () => ({}) }))
vi.mock("./tools/coordination-executor-support.js", () => ({ toolSafeDurableWaitPort: (value: unknown) => value }))
vi.mock("./mailbox/store.js", () => ({ PgCoordinationStore: class {} }))
vi.mock("./turns/canonical-runtime-tool-recovery.js", () => ({
  assertCanonicalCoordinationSurface: vi.fn(), assertCanonicalQuestionSurface: vi.fn(), isNativeQuestionWaitEnabled: () => false,
}))
vi.mock("./tools/planning-executors.js", () => ({ registerTaskGraphPlanningTool: setupMocks.registerPlanning }))

import type { TurnEngineStore } from "./turns/turn-engine-types.js"
import { addScheduledPrepareActions, prepareCanonicalTurnSetup, taskGraphDenialCheckpointReader, taskGraphTemplateRoleView, turnStoreForInteractiveDiscovery } from "./canonical-turn-runtime-turn-setup.js"
import { TASK_GRAPH_TEMPLATES } from "./subagents/task-graph-templates.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT_SCHEMA, type TaskGraphDenialCheckpoint } from "./turns/task-graph-terminal-assessment.js"
import { TASK_GRAPH_DENIAL_CHECKPOINT } from "./turns/turn-execution-types.js"
import type { TurnEngineQueryClient } from "./turns/turn-engine-owner-sql.js"
import type { AgentTreeManager } from "./subagents/manager.js"
import type { TaskGraphCommandPort } from "./subagents/task-graph-command-port.js"
import { registerTaskGraphSupersededScoutRetirementTool } from "./tools/task-graph-retire-superseded-scout.js"

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
  })

  it("registers the exact Scout retirement action only for Objective TaskGraph with the optional port", () => {
    const names: string[] = []
    const registry = { register: (definition: { name: string }) => names.push(definition.name) }
    const options = {
      commandPort: { requestSupersededScoutRetirement: vi.fn() } as unknown as TaskGraphCommandPort,
      manager: { signalTaskSubtree: vi.fn() } as unknown as AgentTreeManager,
      turnLeaseOwner: "turn-owner", turnLeaseVersion: 2, parentLeaseOwner: "root-owner", parentAttemptCount: () => 1,
    }

    expect(registerTaskGraphSupersededScoutRetirementTool(registry, false, options)).toBe(false)
    expect(registerTaskGraphSupersededScoutRetirementTool(registry, true,
      { ...options, commandPort: {} as TaskGraphCommandPort })).toBe(false)
    expect(registerTaskGraphSupersededScoutRetirementTool(registry, true, options)).toBe(true)
    expect(names).toEqual(["agent.retire_superseded_scout"])
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

const batchIntent = { kind: "selected_job_batch_preparation", version: 1 } as const
const batchReady = {
  status: "ready" as const, binding: {} as never, slots: [{ slotId: "slot-1", jobId: "job-1" }, { slotId: "slot-2", jobId: "job-2" }],
  templates: { cover_letter_writer_slot_1: { role: "writer", allowedActions: ["artifact.version.read", "cover_letter.draft"] },
    cover_letter_reviewer_slot_1: { role: "reviewer", allowedActions: ["artifact.version.read", "artifact.review"] } } as never,
}

function setupState(intent: unknown = batchIntent) {
  return { scope: { userId: owner.userId }, source: "user", intent, goal: "Prepare reviewed materials", turnInput: { intent },
    modelProfileSnapshot: {}, toolPolicySnapshot: {}, budgetSnapshot: {}, snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] } } as never
}

function setupInput(state = setupState(), batchGate?: () => unknown) {
  const tools = ["agent.plan", "agent.ask_user", "agent.wait", "agent.list", "agent.reconcile", "jobs.search", "artifact.create", "agent.spawn"]
    .map(name => ({ name }))
  const root = { id: "root-1", attemptCount: 1 }
  setupMocks.ensure.mockResolvedValue(root)
  setupMocks.registerPlanning.mockClear()
  const rootTasks = { ensure: setupMocks.ensure, checkCompletion: vi.fn() }
  return {
    pool: {} as never, lease: owner as never, signal: new AbortController().signal, now: () => new Date(),
    options: {
      stateLoader: vi.fn(async () => state), productionFlags: { taskGraphPlanningEnabled: true } as never,
      taskGraphCommandPort: {} as never, toolRuntimeFactory: () => ({
        registry: { list: () => tools, resolve: () => ({ idempotency: "pure" }), validateArguments: () => true }, router: {},
      } as never),
    } as never,
    manager: {} as never, rootTasks: rootTasks as never, executionProjection: {} as never, sessionProjection: {} as never,
    coordinationEnabled: true, childExecutionEnabled: true, consumeWaitOutcomes: true,
    ...(batchGate ? { batchCompletionGate: batchGate as never } : {}),
  }
}

describe("canonical batch production setup", () => {
  it("uses only verified slot templates, planner constraints, and the restricted Root surface", async () => {
    setupMocks.prepareBatch.mockResolvedValue(batchReady)
    setupMocks.graph.mockRejectedValue(new Error("batch must not use generic TaskGraph setup"))
    const setup = await prepareCanonicalTurnSetup(setupInput(undefined, () => undefined) as never)

    expect("earlyResult" in setup).toBe(false)
    if ("earlyResult" in setup) return
    expect(setup.selectedJobBatch).toBe(batchReady)
    expect(setup.selectedJobMode).toBe(false)
    expect(setup.taskGraphTemplateRoles).toEqual({ cover_letter_writer_slot_1: "writer", cover_letter_reviewer_slot_1: "reviewer" })
    expect(setupMocks.graph).not.toHaveBeenCalled()
    expect(setupMocks.registerPlanning).toHaveBeenCalledWith(expect.anything(), true, expect.objectContaining({
      templates: batchReady.templates, selectedJobBatchSlots: batchReady.slots,
    }))
    const toolNames = setup.rootTools.map(tool => (tool as { name: string }).name)
    expect(toolNames).toEqual(["agent.plan", "agent.ask_user", "agent.wait", "agent.list", "agent.reconcile"])
    expect(setupMocks.ensure.mock.calls[0]?.[0].allowedActions).toEqual([...toolNames, "artifact.version.read", "cover_letter.draft", "artifact.review"])
  })

  it("does not fall through to generic setup when verified batch proof is unavailable", async () => {
    setupMocks.prepareBatch.mockResolvedValue({ status: "unavailable" })
    setupMocks.failBatch.mockResolvedValue({ status: "failed", summary: "selected_job_batch_unavailable" })
    setupMocks.graph.mockClear()
    const result = await prepareCanonicalTurnSetup(setupInput() as never)

    expect(result).toEqual({ earlyResult: { status: "failed", summary: "selected_job_batch_unavailable" } })
    expect(setupMocks.failBatch).toHaveBeenCalledOnce()
    expect(setupMocks.graph).not.toHaveBeenCalled()
  })

  it("does not fall through when the trusted batch terminal factory is absent", async () => {
    setupMocks.prepareBatch.mockImplementation(async ({ completionGate }) => completionGate ? batchReady : { status: "unavailable" })
    setupMocks.failBatch.mockResolvedValue({ status: "failed", summary: "selected_job_batch_unavailable" })
    setupMocks.graph.mockClear()
    const result = await prepareCanonicalTurnSetup(setupInput() as never)

    expect(result).toEqual({ earlyResult: { status: "failed", summary: "selected_job_batch_unavailable" } })
    expect(setupMocks.prepareBatch.mock.calls.at(-1)?.[0].completionGate).toBeUndefined()
    expect(setupMocks.graph).not.toHaveBeenCalled()
  })

  it("keeps ordinary selected-job setup separate from the batch mode", async () => {
    setupMocks.prepareBatch.mockResolvedValue({ status: "not_batch" })
    setupMocks.graph.mockResolvedValue({ enabled: true, selectedJobMode: true, selectedJobPreparation: { jobId: "job-1" }, scheduledDraftMode: false,
      templates: { writer: { role: "writer" }, reviewer: { role: "reviewer" } } })
    const setup = await prepareCanonicalTurnSetup(setupInput(setupState({ kind: "selected_job_preparation", version: 1 })) as never)

    expect("earlyResult" in setup).toBe(false)
    if ("earlyResult" in setup) return
    expect(setup.selectedJobMode).toBe(true)
    expect(setup.selectedJobBatch).toBeUndefined()
    expect(setupMocks.graph).toHaveBeenCalledOnce()
    expect(setupMocks.registerPlanning.mock.calls.at(-1)?.[2]).not.toHaveProperty("selectedJobBatchSlots")
  })
})
