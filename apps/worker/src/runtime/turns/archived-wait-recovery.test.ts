import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { canonicalJson } from "@jobcopilot/shared"

import type { AgentTreeManager } from "../subagents/manager.js"
import { durableLifecycleSink } from "./canonical-runtime-tool-recovery.js"
import { recoverCanonicalArchivedWaitControl } from "../canonical-turn-durable-wait-control.js"
import { createCanonicalPolicy } from "../policy/canonical-policy.js"
import { executionOwnerFence, type ExecutionOwner } from "../execution-owner.js"
import { createCoordinationTools } from "../tools/coordination-tools.js"
import type { CoordinationStore, CoordinationTaskView, DurableWaitControl, DurableWaitControlInvocation, DurableWaitControlReader, DurableWaitInvocation, DurableWaitStepAdmission } from "../tools/coordination-types.js"
import { projectDurableWaitOutcome } from "../subagents/durable-wait-dependency-revalidation.js"
import { InMemoryToolLifecycleSink, ToolLifecycle, type ToolLifecycleSink } from "../tools/lifecycle.js"
import { ToolRegistry } from "../tools/registry.js"
import { ToolRouter } from "../tools/router.js"
import {
  prepareToolResultJson,
  type CanonicalToolSourceName,
  type ToolResultReferenceRecord,
  type ToolResultReferenceRepository,
} from "../tools/tool-result-reference-types.js"
import type { HarnessModelRequest, ModelAdapter, ModelCapabilityProfile, ModelStreamEvent } from "@jobcopilot/agent-model"
import { createToolRouterExecutor } from "./turn-engine-helpers.js"
import { restoreToolCallState } from "./persisted-tool-call-state.js"
import { TurnEngine } from "./turn-engine.js"
import { toRepositoryJson, type TurnEngineEvent, type TurnEngineItem, type TurnEngineStore, type TurnEngineOptions } from "./turn-engine-types.js"
import type { RecoveredArchivedWaitControl } from "./turn-execution-wait.js"
import type { StepContext, StepContextSnapshot } from "../context/step-context-builder.js"

const rootId = "subagent-00000000-0000-4000-8000-000000000001"
const taskIds = Array.from({ length: 7 }, (_, index) => `subagent-00000000-0000-4000-8000-${String(index + 2).padStart(12, "0")}`)
const waitId = "wait-00000000-0000-4000-8000-000000000099"
const referenceId = "tool-result-00000000-0000-4000-8000-000000000088"
const owner: ExecutionOwner = {
  kind: "turn", taskId: rootId,
  lease: {
    turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
    leaseStartedAt: new Date("2026-10-10T10:00:00.000Z"), leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  },
}

function task(id: string, index: number, largeResult = true): CoordinationTaskView {
  const completed = index < 6
  return {
    id, userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: rootId,
    parentTaskId: rootId, path: `root/${index + 1}`, depth: 1, role: "auditor", taskType: "research",
    status: completed ? "completed" : "running", goal: `Inspect bounded fixture ${index + 1}`,
    context: null,
    result: completed ? { note: `fixture-${index + 1}:${largeResult ? "x".repeat(1_800) : "short"}` } : null,
    failureReason: null, attemptCount: 1, maxAttempts: 1, leaseOwner: null, leaseExpiresAt: null,
    interruptRequestedAt: null,
  }
}

function coordinationStore(rows: readonly CoordinationTaskView[]): CoordinationStore {
  const byId = new Map(rows.map(row => [row.id, row]))
  return {
    getTask: async input => byId.get(input.taskId) ?? null,
    listTasks: async () => [...rows],
    sendMessage: async () => { throw new Error("unused") },
    getSpawnReplay: async () => null,
    recordSpawn: async () => false,
    appendActivity: async () => undefined,
  }
}

function toolResultRepository() {
  const records: ToolResultReferenceRecord[] = []
  const puts = vi.fn(async (_owner: ExecutionOwner, input: { stepId: string; toolCallId: string; value: unknown }) => {
    const prepared = prepareToolResultJson(input.value, "agent.wait" as CanonicalToolSourceName)
    const record: ToolResultReferenceRecord = {
      id: referenceId, userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: input.stepId,
      taskId: rootId, toolCallId: input.toolCallId, sanitizedJson: prepared.value, sha256: prepared.sha256,
      byteCount: prepared.bytes, createdAt: new Date("2026-10-10T10:00:00.000Z"), updatedAt: new Date("2026-10-10T10:00:00.000Z"),
    }
    records.push(record)
    return record
  })
  const read = vi.fn(async () => null)
  const repository: ToolResultReferenceRepository = { put: puts, read }
  return { repository, records, read }
}

function largeWaitRuntime(options: { readonly largeResults?: boolean; readonly sink?: ToolLifecycleSink } = {}) {
  const largeResults = options.largeResults ?? true
  const children = taskIds.map((id, index) => task(id, index, largeResults))
  const root: CoordinationTaskView = {
    ...task(rootId, 0), id: rootId, rootTaskId: rootId, parentTaskId: null, path: "root", depth: 0, status: "running",
  }
  const store = coordinationStore([root, ...children])
  const wait = vi.fn(async (input: DurableWaitInvocation) => ({
    waitId, status: "waiting" as const, deadlineAt: "2026-10-10T10:01:00.000Z", matchedTaskIds: [] as string[], input,
  }))
  const sink = options.sink ?? new InMemoryToolLifecycleSink()
  const archive = toolResultRepository()
  const lifecycle = new ToolLifecycle({ sink, durableResults: archive.repository, resolveOwner: () => owner })
  const definitions = createCoordinationTools({ manager: {} as AgentTreeManager, store, wait: { wait } })
  const registry = new ToolRegistry(definitions)
  const router = new ToolRouter(registry, lifecycle, createCanonicalPolicy({}, true, false))
  const input = { idempotencyKey: "archive-wait-1", taskIds, mode: "all" as const, timeoutMs: 30_000 }
  return { store, wait, sink, archive, definitions, registry, router, input }
}

async function routeLargeWait() {
  const runtime = largeWaitRuntime()
  const result = await runtime.router.execute({
    scope: { userId: "user-1" }, sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
    taskId: rootId, rootTaskId: rootId, actorRole: "orchestrator", capabilities: ["coordination", "canManageChildren"],
    signal: new AbortController().signal,
  }, { id: "wait-call-1", toolName: "agent.wait", toolVersion: "1", input: runtime.input })
  return { ...runtime, result }
}

const profile: ModelCapabilityProfile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true, continuationCursor: false,
  supportsParallelTools: false, supportsStreamingToolArgs: true, supportsReasoningSummary: true, supportsResponseContinuation: false,
  supportsProviderConversation: false, supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low",
}

type PersistedStep = {
  id: string; taskId: string; ordinal: number; status: string; finishReason: string | null; errorCode: string | null
  inputTokens: number; outputTokens: number; estimatedCostUsd: number
}
type PersistedItem = TurnEngineItem & {
  type: string; status: string; stepId: string | null; taskId: string; content: unknown
}
type PersistedEvent = TurnEngineEvent & {
  userId: string; sessionId: string; turnId: string; taskId: string; idempotencyKey: string; actor: string; sequence: string
}
type PersistedState = { steps: PersistedStep[]; items: PersistedItem[]; events: PersistedEvent[] }

type CrashCut = "before-wait-step-update" | "before-step-completion"
function turnStore(seed?: PersistedState, crashCut?: CrashCut, startStepStatus: "running" | "streaming" = "running") {
  const state: PersistedState = seed ?? { steps: [], items: [], events: [] }
  let beforeWaitClose: PersistedState | undefined
  const startedStepIds: string[] = []
  const updatedSteps: Array<{ stepId: string; status: string; inputTokens: number; outputTokens: number; estimatedCostUsd: number }> = []
  const eventIds = new Map<string, string>()
  let nextSequence = state.events.reduce((maximum, event) => Math.max(maximum, Number(event.sequence) || 0), 0)
  for (const event of state.events) eventIds.set(event.idempotencyKey, event.id)
  const store: TurnEngineStore = {
    startStep: async input => {
      startedStepIds.push(input.stepId)
      state.steps.push({ id: input.stepId, taskId: input.owner.taskId, ordinal: input.ordinal, status: startStepStatus, finishReason: null, errorCode: null, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 })
      return { id: input.stepId, ordinal: input.ordinal }
    },
    updateStep: async input => {
      const row = state.steps.find(step => step.id === input.stepId)
      if (!row) throw new Error("fixture_step_missing")
      if (crashCut === "before-wait-step-update" && input.status === "waiting_for_tool" && !beforeWaitClose) beforeWaitClose = structuredClone(state)
      Object.assign(row, { status: input.status, finishReason: input.finishReason, errorCode: input.errorCode, inputTokens: input.inputTokens, outputTokens: input.outputTokens, estimatedCostUsd: input.estimatedCostUsd })
      updatedSteps.push({ stepId: input.stepId, status: input.status, inputTokens: input.inputTokens, outputTokens: input.outputTokens, estimatedCostUsd: input.estimatedCostUsd })
    },
    createItem: async input => {
      state.items.push({ id: input.itemId, revision: 0, type: input.type, status: input.status, stepId: input.stepId, taskId: input.owner.taskId, content: input.content })
      return { id: input.itemId, revision: 0 }
    },
    updateItem: async input => {
      const item = state.items.find(candidate => candidate.id === input.itemId)
      if (!item || item.revision !== input.expectedRevision) throw new Error("fixture_item_revision_conflict")
      Object.assign(item, { status: input.status, content: input.content, revision: item.revision + 1 })
      return { id: item.id, revision: item.revision }
    },
    appendEvent: async input => {
      const previous = eventIds.get(input.idempotencyKey)
      if (previous) return { id: previous }
      if (crashCut === "before-step-completion" && input.type === "step.completed" && !beforeWaitClose) beforeWaitClose = structuredClone(state)
      eventIds.set(input.idempotencyKey, input.id)
      state.events.push({ id: input.id, type: input.type, itemId: input.itemId, correlationId: input.correlationId, causationId: input.causationId, payload: input.payload,
        userId: input.owner.userId, sessionId: input.owner.sessionId, turnId: input.owner.turnId, taskId: input.owner.taskId,
        idempotencyKey: input.idempotencyKey, actor: "orchestrator", sequence: String(++nextSequence) })
      return { id: input.id }
    },
    recordFinalResponse: async input => input.terminal ? {
      status: "completed", finalItemId: input.terminal.finalItemId,
      events: [{ id: "fixture-turn-completed", type: "turn.completed", itemId: input.terminal.finalItemId,
        correlationId: input.terminal.stepId, causationId: null, payload: { turnId: input.owner.turnId, taskId: input.owner.taskId, finalItemId: input.terminal.finalItemId, usage: input.terminal.usage } }],
    } : undefined,
  }
  return { state, store, startedStepIds, updatedSteps, get beforeWaitClose() { return beforeWaitClose } }
}

function waitModel(requests: HarnessModelRequest[], input: unknown): ModelAdapter {
  return {
    id: "fixture-model", profile,
    async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
      requests.push(request)
      yield { type: "tool_call_completed", callId: "wait-call-1", name: "agent.wait", arguments: input }
      yield { type: "usage", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 }
      yield { type: "completed", finishReason: "tool_calls" }
    },
  }
}

function continuationModel(requests: HarnessModelRequest[]): ModelAdapter {
  return {
    id: "fixture-model", profile,
    async *stream(request: HarnessModelRequest): AsyncGenerator<ModelStreamEvent> {
      requests.push(request)
      yield { type: "text_delta", text: "The delegated task outcomes are ready for review." }
      yield { type: "usage", inputTokens: 8, outputTokens: 7, estimatedCostUsd: 0.002 }
      yield { type: "completed", finishReason: "stop" }
    },
  }
}

function snapshot(
  toolObservations: StepContextSnapshot["toolObservations"] = [],
  steerHistory: StepContextSnapshot["steerHistory"] = [],
): StepContextSnapshot {
  return { system: [], profile: [], steerHistory, businessRefs: [], toolObservations }
}

function contextBuilder(): TurnEngineOptions["contextBuilder"] {
  return { build: async ({ sessionId, turnId, stepId, snapshot }): Promise<StepContext> => ({
    schemaVersion: "agent-harness.v2", sessionId, turnId, stepId, inputThroughSequence: 0n, consumedInputIds: [],
    blocks: [
      ...snapshot.steerHistory.map(entry => ({ id: `history:${entry.id}`, layer: "steer_history" as const, role: "data" as const,
        trust: "external_untrusted" as const, source: "steer_history", content: toRepositoryJson(entry.content) })),
      ...snapshot.toolObservations.map(item => ({ id: item.id, layer: "tool_observation" as const, role: "data" as const,
        trust: "external_untrusted" as const, source: "tool_or_subagent", content: toRepositoryJson(item.content) })),
    ],
    canonicalJson: JSON.stringify({ steerHistory: snapshot.steerHistory, toolObservations: snapshot.toolObservations }),
  }) }
}

function interruptedWaitProjection(ids: readonly string[] = taskIds) {
  const output = {
    waitId, status: "interrupted", targetTaskIds: [...ids], matchedTaskIds: [],
    tasks: ids.map((taskId, index) => ({ taskId, status: index < ids.length - 1 ? "completed" : "running",
      role: "auditor", result: index < ids.length - 1 ? { truncated: true } : null, failureReason: null })),
  }
  return projectDurableWaitOutcome(waitId, { value: toRepositoryJson(output), taskIds: ids, mode: "all" })
}

function controlReader(status: DurableWaitControl["status"], inspect?: () => unknown): {
  reader: DurableWaitControlReader; calls: DurableWaitControlInvocation[]; admissions: DurableWaitStepAdmission[]; observations: unknown[]
} {
  const calls: DurableWaitControlInvocation[] = []
  const admissions: DurableWaitStepAdmission[] = [], observations: unknown[] = []
  return { calls, admissions, observations, reader: { readByInvocation: async (input, admission) => {
    calls.push(input); admissions.push(admission); observations.push(inspect?.()); return { waitId, status }
  } } }
}

function loopOptions(input: {
  readonly store: TurnEngineStore; readonly router: ToolRouter; readonly registry: ToolRegistry; readonly model: ModelAdapter
  readonly reader: DurableWaitControlReader; readonly snapshot?: StepContextSnapshot; readonly recoveredWaitControl?: RecoveredArchivedWaitControl
  readonly resume?: TurnEngineOptions["resume"]
}): TurnEngineOptions {
  if (owner.kind !== "turn") throw new Error("fixture_owner_not_turn")
  const capabilities = ["coordination", "canManageChildren"]
  return {
    lease: owner.lease, scope: { userId: "user-1" }, goal: "wait for delegated evidence", snapshot: input.snapshot ?? snapshot(),
    contextBuilder: contextBuilder(), store: input.store, model: input.model, tools: input.registry.list(capabilities),
    executeTool: createToolRouterExecutor(input.router), rootTaskId: rootId, taskId: rootId, actorRole: "orchestrator", capabilities,
    validateToolArguments: (name, args) => input.registry.validateArguments(name, args, "1"), idFactory: prefix => prefix,
    durableWaitControlReader: input.reader, recoveredWaitControl: input.recoveredWaitControl, resume: input.resume,
  }
}

function createWaitEngine(input: {
  readonly controlStatus: DurableWaitControl["status"]
  readonly seed?: PersistedState
  readonly crashCut?: CrashCut
  readonly startStepStatus?: "running" | "streaming"
  readonly largeResults?: boolean
  readonly snapshot?: StepContextSnapshot
  readonly recoveredWaitControl?: RecoveredArchivedWaitControl
  readonly resume?: TurnEngineOptions["resume"]
  readonly wait: boolean
}): {
  readonly engine: TurnEngine
  readonly persisted: ReturnType<typeof turnStore>
  readonly runtime: ReturnType<typeof largeWaitRuntime>
  readonly requests: HarnessModelRequest[]
  readonly readerCalls: DurableWaitControlInvocation[]
  readonly readerAdmissions: DurableWaitStepAdmission[]
  readonly readerObservations: unknown[]
} {
  const persisted = turnStore(input.seed, input.crashCut, input.startStepStatus)
  const identity = executionOwnerFence(owner)
  const runtime = largeWaitRuntime({ largeResults: input.largeResults, sink: durableLifecycleSink(persisted.store, identity) })
  const reads = controlReader(input.controlStatus, () => {
    const step = persisted.state.steps.at(-1)
    const toolResult = persisted.state.items.find(item => item.type === "tool_result")
    return { step: step ? { id: step.id, status: step.status } : null, toolResult: toolResult ? { id: toolResult.id, status: toolResult.status, content: toolResult.content } : null }
  })
  const requests: HarnessModelRequest[] = []
  const engine = new TurnEngine(loopOptions({
    store: persisted.store, router: runtime.router, registry: runtime.registry,
    model: input.wait ? waitModel(requests, runtime.input) : continuationModel(requests),
    reader: reads.reader, snapshot: input.snapshot ?? snapshot(), recoveredWaitControl: input.recoveredWaitControl, resume: input.resume,
  }))
  return { engine, persisted, runtime, requests, readerCalls: reads.calls, readerAdmissions: reads.admissions, readerObservations: reads.observations }
}

function resumedUsage(step: PersistedStep | undefined) {
  return {
    inputTokens: step?.inputTokens ?? 0, outputTokens: step?.outputTokens ?? 0,
    estimatedCostUsd: step?.estimatedCostUsd ?? 0,
  }
}

function resumedState(stepCount: number, toolCallCount: number, usage: ReturnType<typeof resumedUsage>): NonNullable<TurnEngineOptions["resume"]> {
  return { nextOrdinal: stepCount, stepCount, toolCallCount, inputThroughSequence: 0n, consumedInputIds: [], usage }
}

describe("archived durable wait recovery integration", () => {
  it("runs the registered wait through ToolRouter and archives only the sanitized oversized output", async () => {
    const routed = await routeLargeWait()
    expect(routed.wait).toHaveBeenCalledOnce()
    expect(routed.wait.mock.calls[0]?.[0]).toMatchObject({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1",
      taskId: rootId, rootTaskId: rootId, targetTaskIds: taskIds, mode: "all", timeoutMs: 30_000,
    })
    expect(routed.result).toMatchObject({ id: "wait-call-1", toolName: "agent.wait", status: "completed" })
    const reference = routed.result.output
    expect(reference).toEqual({
      $ref: referenceId,
      sizeBytes: routed.archive.records[0]?.byteCount,
      sha256: routed.archive.records[0]?.sha256,
    })
    expect(Object.keys(reference as object).sort()).toEqual(["$ref", "sha256", "sizeBytes"])
    expect(routed.archive.records[0]?.byteCount).toBeGreaterThan(8 * 1024)
    expect(routed.archive.records[0]?.sanitizedJson).toMatchObject({ waitId, taskIds, status: "waiting" })
    if (!(routed.sink instanceof InMemoryToolLifecycleSink)) throw new Error("fixture_lifecycle_events_missing")
    expect(routed.sink.events.at(-1)?.item).toMatchObject({ type: "tool_result", output: reference })
    expect(routed.sink.events.at(-1)?.payload.output).toEqual(reference)
    expect(routed.archive.records[0]?.sanitizedJson).not.toHaveProperty("privateControl")
    expect(routed.archive.records[0]?.sha256).toBe(createHash("sha256").update(canonicalJson(routed.archive.records[0]!.sanitizedJson), "utf8").digest("hex"))
    expect(routed.archive.read).not.toHaveBeenCalled()
  })

  it("keeps inline wait outputs on the existing path without a durable-control lookup", async () => {
    const inline = createWaitEngine({ controlStatus: "waiting", largeResults: false, wait: true })
    const inlineResult = await inline.engine.run()
    expect(inlineResult).toMatchObject({ status: "waiting_for_dependency", waitId, stepCount: 1, toolCallCount: 1 })
    expect(inline.readerCalls).toEqual([])
    expect(inline.runtime.archive.records).toEqual([])
    expect(inline.runtime.wait).toHaveBeenCalledOnce()
    expect(inline.persisted.state.items.find(item => item.type === "tool_result")?.content).toMatchObject({
      output: { waitId, status: "waiting", taskIds },
    })
  })

  it("admits an oversized wait from the current streaming Step only after its result is persisted", async () => {
    const fresh = createWaitEngine({ controlStatus: "waiting", startStepStatus: "streaming", wait: true })
    await expect(fresh.engine.run()).resolves.toMatchObject({ status: "waiting_for_dependency", waitId, stepCount: 1, toolCallCount: 1 })
    expect(fresh.readerAdmissions).toEqual(["fresh_streaming_root"])
    expect(fresh.readerCalls[0]).toMatchObject({ userId: "user-1", sessionId: "session-1", turnId: "turn-1",
      stepId: fresh.persisted.state.steps[0]?.id, taskId: rootId, rootTaskId: rootId, ownerId: "worker-1", leaseVersion: 1,
      targetTaskIds: taskIds, mode: "all", timeoutMs: 30_000, idempotencyKey: "archive-wait-1" })
    expect(Object.keys(fresh.readerCalls[0] ?? {}).sort()).toEqual([
      "idempotencyKey", "leaseVersion", "mode", "now", "ownerId", "rootTaskId", "sessionId", "stepId", "targetTaskIds", "taskId", "timeoutMs", "turnId", "userId",
    ])
    expect(fresh.readerObservations).toMatchObject([{
      step: { id: fresh.persisted.state.steps[0]?.id, status: "streaming" },
      toolResult: { status: "completed", content: { toolCallId: "wait-call-1",
        output: { $ref: referenceId, sizeBytes: fresh.runtime.archive.records[0]?.byteCount, sha256: fresh.runtime.archive.records[0]?.sha256 } } },
    }])
    expect(fresh.runtime.archive.records[0]?.byteCount).toBeGreaterThan(8 * 1024)
    expect(fresh.runtime.archive.read).not.toHaveBeenCalled()
    expect(fresh.persisted.state.steps).toMatchObject([{ status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 }])
  })

  it.each([
    ["waiting", "before-step-completion", "waiting_for_tool"],
    ["ready", "before-wait-step-update", "running"],
    ["timed_out", "before-step-completion", "waiting_for_tool"],
  ] as const)("re-hands off archived wait control (%s) from the exact persisted Step without another model call", async (status, crashCut, expectedStepStatus) => {
    const first = createWaitEngine({ controlStatus: "waiting", crashCut, wait: true })
    await expect(first.engine.run()).resolves.toMatchObject({ status: "waiting_for_dependency", waitId, stepCount: 1, toolCallCount: 1 })
    expect(first.requests).toHaveLength(1)
    expect(first.readerCalls).toHaveLength(1)
    expect(first.readerAdmissions).toEqual(["fresh_streaming_root"])
    expect(first.persisted.state.steps).toMatchObject([{ status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 }])
    expect(first.runtime.archive.records[0]?.byteCount).toBeGreaterThan(8 * 1024)
    expect(first.runtime.archive.read).not.toHaveBeenCalled()

    const cut = first.persisted.beforeWaitClose
    expect(cut).toBeDefined()
    expect(cut?.steps).toMatchObject([expectedStepStatus === "running"
      ? { status: "running", inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 }
      : { status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 }])
    expect(cut?.events).toContainEqual(expect.objectContaining({ type: "model.usage", actor: "orchestrator", correlationId: cut?.steps[0]?.id,
      itemId: null, taskId: rootId, idempotencyKey: `turn:${owner.lease.turnId}:event:model-usage:${cut?.steps[0]?.id}`,
      payload: expect.objectContaining({ taskId: rootId, usage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 } }) }))
    expect(cut?.events.filter(event => event.type.startsWith("model.")).map(event => event.type)).toEqual(["model.started", "model.completed", "model.usage"])
    expect(cut?.events.some(event => event.type === "step.completed")).toBe(false)
    const resultItem = cut?.items.find(item => item.type === "tool_result")
    expect(resultItem?.content).toMatchObject({ toolCallId: "wait-call-1", output: {
      $ref: referenceId, sizeBytes: first.runtime.archive.records[0]?.byteCount, sha256: first.runtime.archive.records[0]?.sha256,
    } })
    const restoredTools = restoreToolCallState(cut?.items ?? [], cut?.events ?? [])
    expect(restoredTools.observations).toMatchObject([{ id: "tool-result:wait-call-1", content: { toolCallId: "wait-call-1", toolName: "agent.wait", output: { $ref: referenceId } } }])
    expect(cut?.events.filter(event => event.type === "tool_call.completed" && event.correlationId === "wait-call-1").map(event => event.idempotencyKey)).toEqual([
      expect.stringMatching(/^turn:subagent-.*:tool-lifecycle:wait-call-1:completed:/),
      "turn:turn-1:event:tool-finished:wait-call-1",
    ])

    const reads = controlReader(status)
    const recovered = await recoverCanonicalArchivedWaitControl({
      identity: executionOwnerFence(owner), steps: cut?.steps ?? [], items: cut?.items ?? [], events: cut?.events ?? [],
      observations: restoredTools.observations, snapshot: snapshot(restoredTools.observations), reader: reads.reader,
      now: new Date("2026-10-10T10:00:30.000Z"),
    })
    expect(recovered).toMatchObject({ waitId, status, stepId: cut?.steps[0]?.id, stepStatus: expectedStepStatus, inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003, toolCallCount: 1, stepCompletionRecorded: false })
    expect(reads.calls).toHaveLength(1)
    expect(reads.admissions).toEqual(["restored_inflight_root"])
    expect(reads.calls[0]).toMatchObject({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: cut?.steps[0]?.id,
      taskId: rootId, rootTaskId: rootId, ownerId: "worker-1", leaseVersion: 1, targetTaskIds: taskIds, mode: "all", timeoutMs: 30_000, idempotencyKey: "archive-wait-1" })

    const restarted = createWaitEngine({
      controlStatus: status, seed: structuredClone(cut!), snapshot: snapshot(restoredTools.observations), recoveredWaitControl: recovered,
      resume: resumedState(1, 1, resumedUsage(cut?.steps[0])), wait: true,
    })
    await expect(restarted.engine.run()).resolves.toMatchObject({ status: "waiting_for_dependency", waitId, stepCount: 1, toolCallCount: 1 })
    expect(restarted.requests).toHaveLength(0)
    expect(restarted.persisted.startedStepIds).toEqual([])
    expect(restarted.readerCalls).toEqual([])
    expect(restarted.persisted.updatedSteps).toEqual(expectedStepStatus === "running"
      ? [{ stepId: cut?.steps[0]?.id, status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 }]
      : [])
    expect(restarted.persisted.state.steps).toHaveLength(1)
    expect(restarted.persisted.state.steps[0]).toMatchObject({ id: cut?.steps[0]?.id, status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 })
    expect(restarted.persisted.state.items.filter(item => item.type === "tool_call")).toHaveLength(1)
    expect(restarted.persisted.state.items.filter(item => item.type === "tool_result")).toHaveLength(1)
    expect(restarted.persisted.state.events.filter(event => event.type === "model.usage" && event.correlationId === cut?.steps[0]?.id)).toHaveLength(1)
    expect(resumedUsage(restarted.persisted.state.steps[0])).toEqual({ inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 })
    expect(restarted.persisted.state.events.filter(event => event.type === "step.completed" && event.correlationId === cut?.steps[0]?.id)).toHaveLength(1)
    expect(restarted.runtime.archive.read).not.toHaveBeenCalled()
  })

  it("continues only when the canonical durable wait-result projection is restored", async () => {
    const first = createWaitEngine({ controlStatus: "waiting", wait: true })
    await expect(first.engine.run()).resolves.toMatchObject({ status: "waiting_for_dependency", waitId })
    const persisted = first.persisted.state
    const restoredTools = restoreToolCallState(persisted.items, persisted.events)
    const result = {
      waitId, status: "ready", targetTaskIds: taskIds, matchedTaskIds: taskIds,
      tasks: taskIds.map(taskId => ({ taskId, status: "completed" })),
    }
    const otherWaitId = "wait-00000000-0000-4000-8000-000000000098"
    const otherResult = { ...result, waitId: otherWaitId }
    const unrelated = projectDurableWaitOutcome(otherWaitId, { value: toRepositoryJson(otherResult), taskIds, mode: "all" })
    const unrelatedSnapshot = snapshot([...restoredTools.observations, unrelated])
    const unrelatedReads = controlReader("ready")
    const unrelatedRecovery = await recoverCanonicalArchivedWaitControl({
      identity: executionOwnerFence(owner), steps: persisted.steps, items: persisted.items, events: persisted.events,
      observations: unrelatedSnapshot.toolObservations, snapshot: unrelatedSnapshot, reader: unrelatedReads.reader,
      now: new Date("2026-10-10T10:01:00.000Z"),
    })
    expect(unrelatedRecovery).toMatchObject({ waitId, status: "ready" })
    expect(unrelatedReads.calls).toHaveLength(1)
    expect(unrelatedReads.admissions).toEqual(["restored_inflight_root"])

    const projected = projectDurableWaitOutcome(waitId, { value: toRepositoryJson(result), taskIds, mode: "all" })
    expect(projected.content).toMatchObject({ status: "completed", input: { taskIds, mode: "all" } })
    if (!projected.content || typeof projected.content !== "object" || Array.isArray(projected.content)) throw new Error("fixture_projection_invalid")
    const observation = projected
    expect(projected.content.input).toEqual({ taskIds, mode: "all" })
    expect(Object.keys(projected.content.input as object).sort()).toEqual(["mode", "taskIds"])
    const loadedSnapshot = snapshot([...restoredTools.observations, observation])
    const reads = controlReader("ready")
    await expect(recoverCanonicalArchivedWaitControl({
      identity: executionOwnerFence(owner), steps: persisted.steps, items: persisted.items, events: persisted.events,
      observations: loadedSnapshot.toolObservations, snapshot: loadedSnapshot, reader: reads.reader,
      now: new Date("2026-10-10T10:01:00.000Z"),
    })).resolves.toBeUndefined()
    expect(reads.calls).toHaveLength(1)
    expect(reads.admissions).toEqual(["restored_inflight_root"])
    expect(reads.calls[0]).toMatchObject({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: persisted.steps[0]?.id,
      taskId: rootId, rootTaskId: rootId, ownerId: "worker-1", leaseVersion: 1, targetTaskIds: taskIds, mode: "all", timeoutMs: 30_000, idempotencyKey: "archive-wait-1" })

    const continued = createWaitEngine({
      controlStatus: "ready", seed: structuredClone(persisted), snapshot: loadedSnapshot,
      resume: resumedState(1, 1, resumedUsage(persisted.steps[0])), wait: false,
    })
    const resultAfterReady = await continued.engine.run()
    expect(resultAfterReady.status).toBe("completed")
    expect(continued.requests).toHaveLength(1)
    expect(JSON.stringify(continued.requests[0]?.messages)).toContain(`wait:${waitId}`)
    const requestMessages = JSON.stringify(continued.requests[0]?.messages)
    expect(requestMessages).toContain('\\"status\\":\\"ready\\"')
    expect(requestMessages).toContain(`\\"$ref\\":\\"${referenceId}\\"`)
    expect(JSON.stringify(continued.requests[0]?.messages)).not.toContain("fixture-1:")
    expect(continued.persisted.startedStepIds).toHaveLength(1)
    expect(continued.runtime.archive.read).not.toHaveBeenCalled()
  })

  it("continues after an interrupted wait only with the exact consumer projection and accepted steer", async () => {
    const first = createWaitEngine({ controlStatus: "waiting", wait: true })
    await expect(first.engine.run()).resolves.toMatchObject({ status: "waiting_for_dependency", waitId })
    const persisted = first.persisted.state
    expect(persisted.steps).toMatchObject([{ status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 }])
    expect(persisted.events.filter(event => event.type === "step.completed")).toMatchObject([
      { correlationId: persisted.steps[0]?.id, payload: { status: "waiting_for_dependency", toolCallCount: 1 } },
    ])
    const restoredTools = restoreToolCallState(persisted.items, persisted.events)
    const projected = interruptedWaitProjection()
    expect(projected.id).toBe(`wait-result:${waitId}`)
    if (!projected.content || typeof projected.content !== "object" || Array.isArray(projected.content)) throw new Error("fixture_projection_invalid")
    expect(projected.content).toMatchObject({ toolCallId: `wait:${waitId}`, toolName: "agent.wait", input: { taskIds, mode: "all" }, status: "completed", errorCode: null,
      output: { waitId, status: "interrupted", targetTaskIds: taskIds, matchedTaskIds: [] } })
    const projectedOutput = projected.content.output
    if (!projectedOutput || typeof projectedOutput !== "object" || Array.isArray(projectedOutput)) throw new Error("fixture_outcome_invalid")
    const projectedTasks = projectedOutput.tasks
    if (!Array.isArray(projectedTasks)) throw new Error("fixture_tasks_invalid")
    expect(projectedTasks).toHaveLength(taskIds.length)
    expect(projectedTasks[0]).toMatchObject({ taskId: taskIds[0], role: "auditor", status: "completed" })
    const steerText = "Stop waiting for the remaining child; summarize the completed results and say what is still pending."
    const acceptedSteer = { id: "input-accepted-steer-1", content: steerText }
    const loadedSnapshot = snapshot([...restoredTools.observations, projected], [acceptedSteer])
    const reads = controlReader("interrupted")
    await expect(recoverCanonicalArchivedWaitControl({
      identity: executionOwnerFence(owner), steps: persisted.steps, items: persisted.items, events: persisted.events,
      observations: loadedSnapshot.toolObservations, snapshot: loadedSnapshot, reader: reads.reader,
      now: new Date("2026-10-10T10:00:30.000Z"),
    })).resolves.toBeUndefined()
    expect(reads.calls).toHaveLength(1)
    expect(reads.admissions).toEqual(["restored_inflight_root"])
    expect(reads.calls[0]).toMatchObject({ stepId: persisted.steps[0]?.id, taskId: rootId, rootTaskId: rootId,
      targetTaskIds: taskIds, mode: "all", idempotencyKey: "archive-wait-1" })

    const continued = createWaitEngine({
      controlStatus: "interrupted", seed: structuredClone(persisted), snapshot: loadedSnapshot,
      resume: resumedState(1, 1, resumedUsage(persisted.steps[0])), wait: false,
    })
    await expect(continued.engine.run()).resolves.toMatchObject({ status: "completed", stepCount: 2, toolCallCount: 1 })
    expect(continued.requests).toHaveLength(1)
    const messages = continued.requests[0]?.messages ?? []
    const requestText = JSON.stringify(messages)
    expect(requestText).toContain(steerText)
    expect(requestText).toContain(`wait:${waitId}`)
    expect(requestText).toContain('\\"status\\":\\"interrupted\\"')
    expect(requestText).toContain(`\\"$ref\\":\\"${referenceId}\\"`)
    expect(requestText).not.toContain("fixture-1:")
    expect(messages.some(message => message.role === "user" && JSON.stringify(message.content).includes(steerText))).toBe(true)
    expect(messages.filter(message => message.role === "system").map(message => JSON.stringify(message.content)).join("\n")).not.toContain(steerText)
    expect(continued.runtime.wait).not.toHaveBeenCalled()
    expect(continued.runtime.archive.read).not.toHaveBeenCalled()
    expect(first.runtime.archive.read).not.toHaveBeenCalled()
    expect(continued.persisted.startedStepIds).toEqual([continued.persisted.state.steps[1]?.id])
    expect(continued.persisted.state.steps.map(step => step.id)).toEqual([persisted.steps[0]?.id, continued.persisted.state.steps[1]?.id])
    expect(continued.persisted.state.items.filter(item => item.type === "tool_call")).toHaveLength(1)
    expect(continued.persisted.state.items.filter(item => item.type === "tool_result")).toHaveLength(1)
    const usageEvents = continued.persisted.state.events.filter(event => event.type === "model.usage")
    expect(usageEvents).toHaveLength(2)
    expect(usageEvents.filter(event => event.correlationId === persisted.steps[0]?.id)).toHaveLength(1)
    expect(usageEvents.find(event => event.correlationId === persisted.steps[0]?.id)?.payload).toMatchObject({
      usage: { inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 },
    })
    expect(continued.persisted.state.events.filter(event => event.type === "step.completed" && event.correlationId === persisted.steps[0]?.id)).toHaveLength(1)
    expect(persisted.steps[0]).toMatchObject({ status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 })
  })

  it.each(["missing", "same-wait wrong target set"] as const)(
    "fails closed before continuation when interrupted wait projection is %s", async projectionCase => {
      const first = createWaitEngine({ controlStatus: "waiting", wait: true })
      await expect(first.engine.run()).resolves.toMatchObject({ status: "waiting_for_dependency", waitId })
      const persisted = first.persisted.state
      const restoredTools = restoreToolCallState(persisted.items, persisted.events)
      const wrongProjection = projectionCase === "missing" ? [] : [interruptedWaitProjection(taskIds.slice(1))]
      const steer = { id: "input-accepted-steer-1", content: "Continue after the interruption." }
      const loadedSnapshot = snapshot([...restoredTools.observations, ...wrongProjection], [steer])
      const reads = controlReader("interrupted")
      let continuation: ReturnType<typeof createWaitEngine> | undefined
      await expect(async () => {
        const recovered = await recoverCanonicalArchivedWaitControl({
          identity: executionOwnerFence(owner), steps: persisted.steps, items: persisted.items, events: persisted.events,
          observations: loadedSnapshot.toolObservations, snapshot: loadedSnapshot, reader: reads.reader,
          now: new Date("2026-10-10T10:00:30.000Z"),
        })
        continuation = createWaitEngine({ controlStatus: "interrupted", seed: structuredClone(persisted), snapshot: loadedSnapshot,
          recoveredWaitControl: recovered, resume: resumedState(1, 1, resumedUsage(persisted.steps[0])), wait: false })
        return continuation.engine.run()
      }).rejects.toMatchObject({ code: "persistence_conflict" })
      expect(reads.calls).toHaveLength(1)
      expect(reads.admissions).toEqual(["restored_inflight_root"])
      expect(continuation).toBeUndefined()
      expect(first.requests).toHaveLength(1)
      expect(first.persisted.startedStepIds).toEqual([first.persisted.state.steps[0]?.id])
      expect(first.persisted.state.steps).toHaveLength(1)
      expect(first.persisted.state.steps[0]).toMatchObject({ status: "waiting_for_tool", inputTokens: 17, outputTokens: 5, estimatedCostUsd: 0.003 })
      expect(first.runtime.wait).toHaveBeenCalledOnce()
      expect(first.runtime.archive.records[0]?.byteCount).toBeGreaterThan(8 * 1024)
      expect(first.runtime.archive.read).not.toHaveBeenCalled()
    },
  )
})
