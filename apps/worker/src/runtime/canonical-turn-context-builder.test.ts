import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import type { TenantScope } from "@jobcopilot/agent-protocol"
import type { ModelAdapter } from "@jobcopilot/agent-model"
import type { InputClaimStore, InputClaimTransaction } from "./context/input-claim-store.js"
import { StepContextBuilder, type ContextOwnerFence, type StepContextRequest } from "./context/step-context-builder.js"
import type { StoredAgentInput } from "./context/input-claim-store.js"
import { buildModelRequest } from "./turns/turn-engine-messages.js"
import { buildCognitiveActionAgenda } from "./turns/cognitive-action-agenda.js"
import { progressCheckpointFromStepContext } from "./progress.js"
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA, type TaskGraphCurrentState } from "./subagents/task-graph-command-port.js"
import { projectSelectedJobMemory, type SelectedJobMemoryNode } from "./context/selected-job-memory.js"
import type { ValidatedSelectedJobHistoryOutcome } from "./context/selected-job-history.js"
import type { ValidatedRootTaskHistoryOutcome } from "./context/root-task-history.js"
import { createCanonicalTurnContextBuilder } from "./canonical-turn-context-builder.js"
import type { DirectSelectedJobHistoryReader, SelectedJobHistoryReader } from "./canonical-turn-selected-job-history.js"
import type { DirectRootTaskHistoryReader } from "./canonical-turn-root-task-history.js"
import type { TurnLease } from "./turns/lease.js"

const scope: TenantScope = { userId: "user-a" }
const now = new Date("2026-10-07T12:00:00.000Z")

function transaction(calls: unknown[]): InputClaimTransaction {
  return {
    getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
    claimInputs: async () => ({ inputs: [], newlyClaimedInputIds: [] }),
    loadUnresolvedSteeringInputs: async input => { calls.push(input); return [] },
    persistCheckpoint: async () => undefined,
  }
}

function store(calls: unknown[]): InputClaimStore {
  return { scope, withTransaction: work => work(transaction(calls)) }
}

const lease: TurnLease = {
  userId: "user-a", sessionId: "session-a", turnId: "turn-a", ownerId: "worker-a", leaseVersion: 3,
  leaseStartedAt: now, leaseExpiresAt: new Date(now.getTime() + 60_000),
}

describe("canonical Turn context builder", () => {
  it("injects only server-owned native-root scope into the same-client historical steering reader", async () => {
    const calls: unknown[] = []
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("context without attachments must not acquire another client") } } as unknown as Pick<pg.Pool, "connect">,
      store: store(calls), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2, rootInputId: "original-input-a",
      planningEnabled: true, selectedJobMode: false, rootTaskHistoryDirectReader: { load: async () => [] },
    })

    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-a",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
      mode: "rebuild", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })

    expect(calls).toEqual([{
      userId: "user-a", sessionId: "session-a", turnId: "turn-a", rootTaskId: "root-a", parentTaskId: "root-a",
      turnLeaseOwner: "worker-a", turnLeaseVersion: 3, parentLeaseOwner: "worker-a", parentAttemptCount: 2,
      rootInputId: "original-input-a", lease: { ownerId: "worker-a", leaseVersion: 3, now },
    }])
    expect(calls[0]).not.toHaveProperty("stepId")
    expect(context.consumedInputIds).toEqual([])
    expect(context.taskGraphRevision).toBeUndefined()
  })

  it("does not request native steering hydration when canonical root planning is disabled", async () => {
    const calls: unknown[] = []
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("unexpected connection") } } as unknown as Pick<pg.Pool, "connect">,
      store: store(calls), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2, planningEnabled: false, selectedJobMode: false,
    })

    await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-a",
      snapshot: { system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [] },
    })

    expect(calls).toEqual([])
  })

  it("adds bounded Root-task history as untrusted advisory context without changing current graph evidence", async () => {
    const outcomes: readonly ValidatedRootTaskHistoryOutcome[] = [{
      sourceTurnId: "private-earlier-turn", sourceRootTaskId: "private-earlier-root", terminalSequence: 12n,
      taskGraph: {
        revision: 7,
        nodes: [{ key: "private-node", templateId: "analyst", goal: "PRIVATE_OLD_GOAL", successCriteria: ["PRIVATE_CRITERION"],
          dependsOn: [], taskId: "private-child-task", status: "failed", readiness: "terminal", resultSummary: "PRIVATE_RESULT", failureReason: "PRIVATE_FAILURE" }],
      } satisfies TaskGraphCurrentState,
    }]
    const reader: DirectRootTaskHistoryReader = { load: vi.fn(async () => outcomes) }
    const currentGraph = { kind: "task_graph_current", revision: 23, nodes: [{ taskId: "current-task", status: "running" }] }
    const snapshot: StepContextRequest["snapshot"] = {
      system: [{ id: "system-current", content: "Current policy remains authoritative." }], profile: [],
      goal: { id: "goal-current", content: "CURRENT_GOAL_SENTINEL" },
      taskGraphRevision: 23,
      toolObservations: [
        { id: "task-graph-current", content: currentGraph },
        { id: "root-task-history", content: { kind: "spoofed_history", text: "CALLER_HISTORY_SENTINEL" } },
      ],
      steerHistory: [], businessRefs: [],
    }
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("the injected reader must avoid a database connection") } } as unknown as Pick<pg.Pool, "connect">,
      store: store([]), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled: true, selectedJobMode: false, rootTaskHistoryDirectReader: reader,
    })

    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-root-history", snapshot,
      now, mode: "new", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })
    const historyBlock = context.blocks.find(block => block.id === "observation:root-task-history")
    const graphBlock = context.blocks.find(block => block.id === "observation:task-graph-current")
    const serializedHistory = JSON.stringify(historyBlock?.content)
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({
      context, model, tools: [{ name: "agent.plan", version: "1" }], sessionId: lease.sessionId, turnId: lease.turnId,
      stepId: "step-root-history", userId: scope.userId, taskId: "root-a", signal: new AbortController().signal, freshSteering: true,
    })
    const requestText = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")

    expect(reader.load).toHaveBeenCalledWith({ lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-root-history", now })
    expect(context.taskGraphRevision).toBe(23)
    expect(graphBlock?.content).toEqual(currentGraph)
    expect(historyBlock).toMatchObject({ layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" })
    expect(historyBlock?.content).toMatchObject({ kind: "root_task_history", informationalOnly: true, advisoryOnly: true, notCurrentEvidence: true })
    expect(requestText).toContain("root_task_history")
    expect(requestText).toContain('"taskKind":"analyst"')
    expect(requestText).toContain('"status":"failed"')
    for (const privateValue of ["private-earlier-turn", "private-earlier-root", "private-node", "private-child-task", "PRIVATE_OLD_GOAL", "PRIVATE_CRITERION", "PRIVATE_RESULT", "PRIVATE_FAILURE", "CALLER_HISTORY_SENTINEL", "spoofed_history"]) {
      expect(serializedHistory).not.toContain(privateValue)
      expect(requestText).not.toContain(privateValue)
    }
    const withoutHistory = { ...context, blocks: context.blocks.filter(block => block.id !== historyBlock?.id) }
    expect(buildCognitiveActionAgenda(context)).toEqual(buildCognitiveActionAgenda(withoutHistory))
    expect(progressCheckpointFromStepContext(context)).toEqual(progressCheckpointFromStepContext(withoutHistory))
  })

  it("keeps Root-task history disabled for selected-job turns", async () => {
    const rootReader: DirectRootTaskHistoryReader = { load: vi.fn(async () => []) }
    const selectedJobReader: DirectSelectedJobHistoryReader = { load: vi.fn(async () => []) }
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("injected history readers avoid database connections") } } as unknown as Pick<pg.Pool, "connect">,
      store: store([]), scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled: true, selectedJobMode: true, selectedJobId: "job-a",
      rootTaskHistoryDirectReader: rootReader, selectedJobDirectHistoryReader: selectedJobReader,
    })

    await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-selected-job", snapshot: {
        system: [], profile: [], steerHistory: [], businessRefs: [], toolObservations: [],
      },
    })

    expect(rootReader.load).not.toHaveBeenCalled()
    expect(selectedJobReader.load).toHaveBeenCalledTimes(1)
  })

  it("adds validated same-job history to the actual request as untrusted data beside current Turn context", async () => {
    const jobId = "selected-job-a"
    const graphNode = {
      key: "current-analyst", templateId: "analyst", taskId: "current-task", goal: "CURRENT_GRAPH_SENTINEL",
      successCriteria: [], dependsOn: [], status: "completed", readiness: "terminal",
      resultProjection: {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
        role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
        findings: [{ jobId, score: 9, evidenceKinds: ["job"] }],
      },
    }
    const memory = (sourceTurnId: string, sourceRootTaskId: string, score: number) => {
      const value = projectSelectedJobMemory({ jobId, sourceTurnId, sourceRootTaskId, throughSequence: "17", graph: { revision: 4, nodes: [{
        ...graphNode, resultProjection: { ...graphNode.resultProjection, findings: [{ jobId, score, evidenceKinds: ["job"] }] },
      }] } })
      if (!value) throw new Error("selected-job memory fixture was invalid")
      return value
    }
    const currentMemory = memory(lease.turnId, "root-a", 9)
    const otherJobMemory = projectSelectedJobMemory({ jobId: "other-job", sourceTurnId: lease.turnId, sourceRootTaskId: "root-a", throughSequence: "17", graph: { revision: 4, nodes: [{
      ...graphNode, resultProjection: { ...graphNode.resultProjection, findings: [{ jobId: "other-job", score: 1, evidenceKinds: ["job"] }] },
    }] } })!
    const priorMemory = memory("private-prior-turn", "private-prior-root", 6.5)
    const historyReader: SelectedJobHistoryReader = {
      load: vi.fn(async () => [{ record: priorMemory, terminalSequence: 12n }]),
    }
    const steer: StoredAgentInput = {
      id: "steer-current", sessionId: lease.sessionId, targetTurnId: lease.turnId, userId: scope.userId,
      clientMessageId: "steer-current", delivery: "steer", status: "consumed",
      content: [{ type: "text", text: "CURRENT_STEERING_SENTINEL: include Berlin roles" }], acceptedSequence: 3n,
      consumedByStepId: "step-current", consumedAt: now, createdAt: now,
    }
    const claimStore: InputClaimStore = {
      scope,
      withTransaction: work => work({
        getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
        claimInputs: async () => ({ inputs: [steer], newlyClaimedInputIds: [steer.id] }),
        persistCheckpoint: async () => undefined,
      }),
    }
    const ownerFence: ContextOwnerFence = {
      assertReferenceOwned: async () => undefined,
      assertAttachmentOwned: async reference => ({ attachmentId: reference.attachmentId }),
    }
    const baseBuilder = new StepContextBuilder(claimStore, ownerFence)
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("the injected history reader avoids another database client") } } as unknown as Pick<pg.Pool, "connect">,
      store: claimStore, baseBuilder, scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled: false, selectedJobMode: true, selectedJobMemories: [otherJobMemory, currentMemory], selectedJobId: jobId,
      selectedJobHistoryReader: historyReader,
    })
    const snapshot: StepContextRequest["snapshot"] = {
      system: [{ id: "system-rule", content: "fixed system policy" }], profile: [],
      goal: { id: "goal-current", content: "CURRENT_GOAL_SENTINEL: find suitable roles" },
      steerHistory: [{ id: "qa-current", content: { question: "Preferred city?", answer: "Berlin" } }],
      businessRefs: [{ id: jobId, kind: "job", ownerId: scope.userId, label: "Selected role" }],
      toolObservations: [
        { id: "task-graph-current", content: { kind: "task_graph_current", revision: 4, nodes: [graphNode] } },
        { id: "unrelated", content: { text: "must be filtered" } },
      ],
    }
    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-current", snapshot,
      now, mode: "new", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({
      context, model, tools: [{ name: "agent.plan", version: "1" }], sessionId: lease.sessionId, turnId: lease.turnId,
      stepId: "step-current", userId: scope.userId, taskId: "root-a", signal: new AbortController().signal, freshSteering: true,
    })
    const text = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    const historyBlock = context.blocks.find(block => block.id === "observation:selected-job-history")
    const serializedHistory = JSON.stringify(historyBlock?.content)
    const systemText = request.messages.filter(message => message.role === "system").flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")

    expect(historyReader.load).toHaveBeenCalledWith({
      lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-current", jobId, records: [otherJobMemory, currentMemory], now,
    })
    expect(text).toContain("selected_job_history")
    expect(text).toContain('"score":6.5')
    expect(text).toContain("CURRENT_GOAL_SENTINEL")
    expect(text).toContain("CURRENT_STEERING_SENTINEL")
    expect(text).toContain("Preferred city?")
    expect(text).toContain("CURRENT_GRAPH_SENTINEL")
    expect(text).toContain("selected_job_memory")
    expect(text).not.toContain("other-job")
    expect(text).not.toContain("must be filtered")
    expect(historyBlock).toMatchObject({ layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" })
    for (const privateValue of ["private-prior-turn", "private-prior-root", jobId, "graphDigest", "terminalSequence", "verification", "criteria", "PASS"]) {
      expect(serializedHistory).not.toContain(privateValue)
    }
    expect(systemText).not.toContain("private-prior")
    expect(systemText).not.toContain(jobId)
    expect(request.tools).toEqual([{ name: "agent.plan", version: "1" }])
    const withoutHistory = { ...context, blocks: context.blocks.filter(block => block.id !== historyBlock?.id) }
    expect(buildCognitiveActionAgenda(context)).toEqual(buildCognitiveActionAgenda(withoutHistory))
    expect(progressCheckpointFromStepContext(context)).toEqual(progressCheckpointFromStepContext(withoutHistory))
  })

  it("recalls direct outcomes with compaction records absent and keeps fresh current context through token admission", async () => {
    const jobId = "selected-job-direct-a"
    const failedNode: SelectedJobMemoryNode = {
      role: "analyst", status: "failed", readiness: "terminal", repairState: "none",
      verification: { status: "failed", criteria: [
        { status: "failed", reasonCode: "reported_score_below_minimum" },
        { status: "failed", reasonCode: "criterion_not_met" },
        { status: "failed", reasonCode: "reported_score_below_minimum" },
      ] },
      result: { availability: "available", role: "analyst", status: "completed", score: 6.5, evidenceKinds: ["job"] },
    }
    const unverifiedNode: SelectedJobMemoryNode = {
      ...failedNode, verification: { status: "unverified", criteria: [
        { status: "unverified", reasonCode: "canonical_evidence_missing" },
        { status: "unverified", reasonCode: "canonical_evidence_missing" },
      ] },
    }
    const outcomes: readonly ValidatedSelectedJobHistoryOutcome[] = [
      { jobId, sourceTurnId: "private-source-turn", sourceRootTaskId: "private-source-root", terminalSequence: 12n, nodes: [failedNode] },
      { jobId, sourceTurnId: "private-unverified-turn", sourceRootTaskId: "private-unverified-root", terminalSequence: 11n, nodes: [unverifiedNode] },
    ]
    const directReader: DirectSelectedJobHistoryReader = { load: vi.fn(async () => outcomes) }
    const steer: StoredAgentInput = {
      id: "fresh-steer-direct", sessionId: lease.sessionId, targetTurnId: lease.turnId, userId: scope.userId,
      clientMessageId: "fresh-steer-direct", delivery: "steer", status: "consumed",
      content: [{ type: "text", text: "FRESH_STEERING_SENTINEL: prioritize Dublin" }], acceptedSequence: 3n,
      consumedByStepId: "step-direct", consumedAt: now, createdAt: now,
    }
    const claimStore: InputClaimStore = {
      scope,
      withTransaction: work => work({
        getCheckpoint: async () => ({ inputThroughSequence: 0n, consumedInputIds: [] }),
        claimInputs: async () => ({ inputs: [steer], newlyClaimedInputIds: [steer.id] }),
        persistCheckpoint: async () => undefined,
      }),
    }
    const ownerFence: ContextOwnerFence = {
      assertReferenceOwned: async () => undefined,
      assertAttachmentOwned: async reference => ({ attachmentId: reference.attachmentId }),
    }
    const baseBuilder = new StepContextBuilder(claimStore, ownerFence)
    const currentGraph = {
      key: "current-analyst", templateId: "analyst", taskId: "current-task", goal: "CURRENT_GRAPH_DIRECT_SENTINEL",
      successCriteria: [], dependsOn: [], status: "completed", readiness: "terminal",
      resultProjection: {
        schemaVersion: TASK_GRAPH_RESULT_PROJECTION_SCHEMA, trust: "untrusted", availability: "available",
        role: "analyst", status: "completed", findingCount: 1, evidenceCount: 1,
        findings: [{ jobId, score: 8, evidenceKinds: ["job"] }],
      },
    }
    const sameTurnMemory = projectSelectedJobMemory({
      jobId, sourceTurnId: lease.turnId, sourceRootTaskId: "root-a", throughSequence: "18", graph: { revision: 5, nodes: [currentGraph] },
    })
    if (!sameTurnMemory) throw new Error("current selected-job memory fixture was invalid")
    const builder = createCanonicalTurnContextBuilder({
      pool: { connect: async () => { throw new Error("the direct reader and injected builder avoid another client") } } as unknown as Pick<pg.Pool, "connect">,
      store: claimStore, baseBuilder, scope, lease, rootTaskId: "root-a", rootAttemptCount: 2,
      planningEnabled: false, selectedJobMode: true, selectedJobMemories: [sameTurnMemory], selectedJobId: jobId,
      selectedJobDirectHistoryReader: directReader,
    })
    const snapshot: StepContextRequest["snapshot"] = {
      system: [{ id: "fixed-system", content: "Keep current authorization checks." }], profile: [],
      goal: { id: "goal-current", content: "CURRENT_GOAL_DIRECT_SENTINEL: find Dublin roles" },
      steerHistory: [{ id: "qa-current", content: { question: "Preferred location?", answer: "Dublin" } }],
      taskGraphRevision: 5,
      businessRefs: [{ id: jobId, kind: "job", ownerId: scope.userId, label: "Current selected role" }],
      toolObservations: [{ id: "task-graph-current", content: { kind: "task_graph_current", revision: 5, nodes: [currentGraph] } }],
    }
    const context = await builder.build({
      scope, sessionId: lease.sessionId, turnId: lease.turnId, stepId: "step-direct", snapshot,
      now, mode: "new", lease: { ownerId: lease.ownerId, leaseVersion: lease.leaseVersion, now },
    })
    const model = { profile: { provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: false, streaming: true, continuationCursor: false } } as unknown as ModelAdapter
    const request = buildModelRequest({
      context, model, tools: [{ name: "agent.plan", version: "1" }], sessionId: lease.sessionId, turnId: lease.turnId,
      stepId: "step-direct", userId: scope.userId, taskId: "root-a", signal: new AbortController().signal, freshSteering: true,
    })
    const messageText = request.messages.flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")
    const historyBlocks = context.blocks.filter(block => block.id === "observation:selected-job-history")
    const history = JSON.stringify(historyBlocks[0]?.content)
    const systemText = request.messages.filter(message => message.role === "system").flatMap(message => message.content).flatMap(part => part.type === "text" ? [part.text] : []).join("\n")

    expect(directReader.load).toHaveBeenCalledWith({
      lease, rootTaskId: "root-a", rootAttemptCount: 2, stepId: "step-direct", jobId, now,
    })
    expect(historyBlocks).toHaveLength(1)
    expect(messageText).toContain("selected_job_history")
    expect(messageText).toContain('"score":6.5')
    expect(messageText).toContain('"reasonHints":["criterion_not_met","reported_score_below_minimum"]')
    expect(messageText).toContain('"reasonHints":["canonical_evidence_missing"]')
    expect(messageText).toContain("selected_job_memory")
    expect(messageText).toContain('"score":8')
    expect(messageText).toContain("CURRENT_GOAL_DIRECT_SENTINEL")
    expect(messageText).toContain("FRESH_STEERING_SENTINEL")
    expect(messageText).toContain("Preferred location?")
    expect(messageText).toContain("CURRENT_GRAPH_DIRECT_SENTINEL")
    expect(context.taskGraphRevision).toBe(5)
    expect(historyBlocks[0]).toMatchObject({ layer: "tool_observation", role: "data", trust: "external_untrusted", source: "tool_or_subagent" })
    for (const privateValue of ["private-source-turn", "private-source-root", "private-unverified-turn", "private-unverified-root", jobId,
      "terminalSequence", "verification", "criteria", "criteria_met", "criterionId", "evidenceDigest", "resultDigest", "PASS"]) {
      expect(history).not.toContain(privateValue)
    }
    for (const privateValue of ["private-source-turn", "private-source-root", "private-unverified-turn", "private-unverified-root", jobId]) {
      expect(systemText).not.toContain(privateValue)
    }
    expect(systemText).not.toContain("reported_score_below_minimum")
    expect(systemText).not.toContain("canonical_evidence_missing")
    const withoutHistory = { ...context, blocks: context.blocks.filter(block => block.id !== historyBlocks[0]?.id) }
    expect(buildCognitiveActionAgenda(context)).toEqual(buildCognitiveActionAgenda(withoutHistory))
    expect(progressCheckpointFromStepContext(context)).toEqual(progressCheckpointFromStepContext(withoutHistory))
  })
})
