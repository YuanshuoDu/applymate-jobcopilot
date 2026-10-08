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
import { TASK_GRAPH_RESULT_PROJECTION_SCHEMA } from "./subagents/task-graph-command-port.js"
import { projectSelectedJobMemory } from "./context/selected-job-memory.js"
import { createCanonicalTurnContextBuilder } from "./canonical-turn-context-builder.js"
import type { SelectedJobHistoryReader } from "./canonical-turn-selected-job-history.js"
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
      planningEnabled: true, selectedJobMode: false,
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
})
