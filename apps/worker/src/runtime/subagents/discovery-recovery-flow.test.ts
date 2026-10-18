import type { ModelAdapter, ModelStreamEvent } from "@jobcopilot/agent-model"
import { describe, expect, it, vi } from "vitest"

import { PolicyEngine } from "../policy/engine.js"
import { createJobsDiscoverTool, type JobDiscoveryExecutionFence } from "../tools/job-discover-tool.js"
import type { JobDiscoveryClient, JobDiscoveryOutput, JobDiscoveryRequest } from "../tools/job-discovery-client.js"
import { createChildExecutor } from "./child-executor.js"
import { createChildDiscoveryObservers } from "./child-discovery-observers.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { TASK_GRAPH_TEMPLATES } from "./task-graph-templates.js"
import { TASK_GRAPH_VERIFICATION_SCHEMA_VERSION } from "../planning/task-graph-verification.js"
import { taskGraphState, TASK_GRAPH_SNAPSHOT_VERSION } from "./task-graph-snapshot.js"
import { taskGraphItemId, parseTaskGraphSnapshot } from "./task-graph-snapshot.js"
import type { GraphTaskRow, LoadedGraph } from "./task-graph-pg-state.js"
import { projectTaskGraphDiscoveryRecoveryPage } from "./task-graph-discovery-recovery-page.js"
import { projectTaskGraphResultPage } from "./task-graph-result-page.js"
import { DISCOVERY_RECOVERY_SCHEMA_VERSION } from "./task-graph-discovery-recovery-contract.js"
import { InMemoryToolLifecycleSink, ToolLifecycle, type DiscoveryAttemptLifecycleEvent } from "../tools/lifecycle.js"
import type { ToolResultReferenceRecord, ToolResultReferenceRepository } from "../tools/tool-result-reference-types.js"
import { ToolRegistry } from "../tools/registry.js"
import { ToolRouter } from "../tools/router.js"
import { createReadOnlyTools, type ReadToolDataSource } from "../tools/read-tools.js"
import type { RuntimeToolDefinition } from "../tools/types.js"
import type { SubagentLease } from "./types.js"
import type { TurnExecutionStore } from "../turns/turn-execution-types.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"

const recoveredJobId = "c123456789012345678901234"
const scoutTemplate = TASK_GRAPH_TEMPLATES.scout
const graphVerification = {
  schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  role: "scout" as const,
  criteria: [{ id: "candidate-count", check: { kind: "candidate_count_gte" as const, minimum: 1 } }],
}

function childLease(id = "scout-task-1"): SubagentLease {
  return {
    id, userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
    path: `/root-1/${id}`, depth: 1, role: "scout", taskType: "job_discovery", status: "running",
    goal: "Find matching jobs", constraints: [], successCriteria: ["Return relevant roles"],
    allowedActions: [...scoutTemplate.allowedActions], context: {},
    expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "scout" },
    modelProfileSnapshot: { provider: "fixture", model: "fixture" }, result: null, failureReason: null,
    attemptCount: 2, maxAttempts: 3, leaseOwner: "child-worker", leaseExpiresAt: new Date(Date.now() + 60_000),
    interruptRequestedAt: null, budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "child-worker",
    signal: new AbortController().signal,
  }
}

function ordinarySnapshot(taskId: string) {
  return parseTaskGraphSnapshot({
    schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
    nodes: [{
      key: "scout-a", templateId: "scout", goal: "Find matching jobs", successCriteria: ["Return relevant roles"],
      dependsOn: [], depth: 1, taskId, verificationDisposition: "typed", verification: graphVerification,
      registeredScoutEnvelope: {
        role: scoutTemplate.role, taskType: scoutTemplate.taskType,
        expectedOutputSchema: scoutTemplate.expectedOutputSchema, allowedActions: [...scoutTemplate.allowedActions],
      },
    }],
  })
}

function provenanceClient(task: SubagentLease) {
  const content = ordinarySnapshot(task.id)
  const query = vi.fn(async (sql: unknown) => ({ rows: typeof sql === "string" && sql.includes('FROM "agent_items"') ? [{
      turnStatus: "in_progress", revision: 4, content, role: "scout", taskType: "job_discovery", allowedActions: task.allowedActions,
      expectedOutputSchema: task.expectedOutputSchema, context: {},
    }] : [] }))
  const client = { query, release: vi.fn() }
  return { pool: { connect: vi.fn(async () => client) }, client, query }
}

function discoveryOutput(request: JobDiscoveryRequest): JobDiscoveryOutput {
  const job = {
    id: recoveredJobId, title: "Software Engineer", company: "Example", location: "Dublin",
    url: `https://jobs.example/${recoveredJobId}`, description: "Role", fullDescription: "x".repeat(7 * 1024),
    salary: null, logo: null, source: "greenhouse", evidenceRefs: ["evidence-1"],
  }
  return {
    jobs: [job], evidence: [{
      evidenceId: "evidence-1", jobId: recoveredJobId, kind: "source", source: "greenhouse",
      url: job.url, summary: "Discovered from the Greenhouse source",
    }], nextCursor: null,
    usage: {
      ledgerKey: "ledger-1", toolName: "jobs.discover", toolVersion: "1", toolCallId: request.toolCallId,
      sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId, requests: 1,
      jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0, providerFailures: 0, aiCalls: 0,
      providers: ["greenhouse"], estimatedCostUsd: 0, durationMs: 1,
    },
  }
}

function typedScoutResult(jobId: string) {
  const evidenceId = `read:job:${jobId}`
  return JSON.stringify({
    schemaVersion: ROLE_RESULT_SCHEMA, role: "scout", status: "completed",
    candidates: [{ jobId, source: "greenhouse", url: `https://jobs.example/${jobId}`, evidenceIds: [evidenceId] }],
    evidence: [{ id: evidenceId, kind: "job", ref: jobId, source: "greenhouse" }], summary: "Found a matching role",
  })
}

function scriptedModel(toolNames: readonly string[], finalText: string): ModelAdapter {
  const profile = {
    provider: "fixture", model: "fixture", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" as const,
  }
  let calls = 0
  return {
    id: "fixture", profile,
    async *stream() {
      const toolName = toolNames[calls]
      calls += 1
      if (toolName) {
      yield { type: "tool_call_completed", callId: `tool-call-${calls}`, name: toolName,
        arguments: toolName === "jobs.get" ? { jobId: recoveredJobId }
          : { targetRoles: ["Software Engineer"], targetLocations: ["Dublin"] } } satisfies ModelStreamEvent
        yield { type: "completed", finishReason: "tool_calls" }
      } else {
        yield { type: "text_delta", text: finalText }
        yield { type: "completed", finishReason: "stop" }
      }
    },
  }
}

function workerStores(): { store: TurnExecutionStore; budget: TreeBudgetReservationStore } {
  return {
    store: {
      startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }), updateStep: async () => undefined,
      createItem: async ({ itemId }) => ({ id: itemId, revision: 0 }),
      updateItem: async ({ itemId, expectedRevision }) => ({ id: itemId, revision: expectedRevision + 1 }),
      appendEvent: async ({ id }) => ({ id }), recordFinalResponse: async () => undefined,
    },
    budget: {
      reserve: async input => ({ id: `reservation:${input.stepId}`, ...input, units: 1, status: "reserved", createdAt: new Date(), updatedAt: new Date(), settledAt: null }),
      settle: async input => ({ ...input, units: 1, createdAt: new Date(), updatedAt: new Date(), settledAt: new Date() }),
    },
  }
}

function discoveryPolicy(): PolicyEngine {
  return new PolicyEngine({ snapshot: { version: "policy.v1", rules: [{
    id: "flow-test-discovery", roles: ["subagent"], tools: ["jobs.discover"], toolVersions: ["1"],
    risks: ["internal_write"], domains: ["jobs"], requiredCapabilities: ["read"], outcome: "allow",
    reasonCode: "test_discovery_allowed", reason: "Flow fixture allows this scoped discovery call",
  }] } })
}

function readPolicy(): PolicyEngine {
  return new PolicyEngine({ snapshot: { version: "policy.v1", rules: [{
    id: "flow-test-job-read", roles: ["subagent"], tools: ["jobs.get"], toolVersions: ["1"],
    risks: ["read"], domains: ["jobs"], requiredCapabilities: ["read"], outcome: "allow",
    reasonCode: "test_job_read_allowed", reason: "Flow fixture allows this scoped fresh job read",
  }] } })
}

function readSource(getJob: ReadToolDataSource["getJob"]): ReadToolDataSource {
  return {
    searchJobs: async () => ({ jobs: [], page: 1, hasMore: false }), getJob,
    retrievePersona: async () => ({ facts: [] }), getBaseResume: async () => ({ resume: null }),
    getApplicationState: async () => ({ job: null, task: null, approvals: [] }),
  }
}

function failedGraph(task: SubagentLease, result: unknown): LoadedGraph {
  const snapshot = ordinarySnapshot(task.id)
  const persistedContext = task.context !== null && typeof task.context === "object" && !Array.isArray(task.context)
    ? task.context as Record<string, unknown> : undefined
  const taskRow: GraphTaskRow = {
    id: task.id, role: "scout", taskType: "job_discovery", status: "failed",
    expectedOutputSchema: task.expectedOutputSchema, allowedActions: task.allowedActions,
    contextIsObject: persistedContext !== undefined,
    hasPrivateSelectionContext: Boolean(persistedContext && ["selectedJobPreparation", "coverLetterBase", "writerReviewFeedback"]
      .some(key => Object.hasOwn(persistedContext, key))),
    attemptCount: task.attemptCount, result, failureReason: "invalid_structured_result",
  }
  return {
    rootTaskId: "root-1", snapshot,
    item: { id: taskGraphItemId("root-1"), revision: 4, content: snapshot, createdAt: new Date(0) },
    state: taskGraphState(snapshot, 4, new Map([[task.id, { status: "failed", failureReason: taskRow.failureReason }]]), []),
    tasks: new Map([[task.id, taskRow]]),
  }
}

describe("failed Scout discovery recovery flow", () => {
  it("keeps a persisted partial discovery unverified and requires fresh jobs.get evidence", async () => {
    const failedLease = { ...childLease(), maxAttempts: 2 }
    const provenance = provenanceClient(failedLease)
    const observer = await createChildDiscoveryObservers(provenance.pool as never, failedLease, {
      taskId: failedLease.id, rootTaskId: failedLease.rootTaskId, sessionId: failedLease.sessionId,
      turnId: failedLease.turnId!, attemptCount: failedLease.attemptCount,
    })
    expect(provenance.pool.connect).toHaveBeenCalledOnce()
    expect(provenance.query.mock.calls.map(([sql]) => sql)).toEqual([
      "BEGIN", "SELECT set_config($1, $2, true)", expect.stringContaining('FROM "agent_items"'), "COMMIT",
    ])
    expect(provenance.query).toHaveBeenCalledWith("SELECT set_config($1, $2, true)", ["app.user_id", failedLease.userId])
    expect(provenance.client.release).toHaveBeenCalledOnce()

    const sink = new InMemoryToolLifecycleSink()
    const observedEvents: DiscoveryAttemptLifecycleEvent[] = []
    const durableReferenceId = "tool-result-00000000-0000-4000-8000-000000000009"
    const durableResults: ToolResultReferenceRepository = {
      put: vi.fn(async (_owner, input): Promise<ToolResultReferenceRecord> => ({
        id: durableReferenceId, userId: failedLease.userId, sessionId: failedLease.sessionId,
        turnId: failedLease.turnId!, stepId: input.stepId, taskId: failedLease.id, toolCallId: input.toolCallId,
        sanitizedJson: input.value as ToolResultReferenceRecord["sanitizedJson"], sha256: "a".repeat(64),
        byteCount: Buffer.byteLength(JSON.stringify(input.value), "utf8"), createdAt: new Date(), updatedAt: new Date(),
      })),
      read: vi.fn(async () => null),
    }
    const lifecycle = new ToolLifecycle({ sink, durableResults, resolveOwner: () => ({ kind: "task", lease: failedLease }), onDiscoveryAttemptLifecycleEvent: event => {
      observedEvents.push(event)
      observer.observeLifecycleEvent(event)
    } })
    const discoveryFence: JobDiscoveryExecutionFence = {
      userId: failedLease.userId, sessionId: failedLease.sessionId, turnId: failedLease.turnId!, taskId: failedLease.id,
      rootTaskId: failedLease.rootTaskId, role: "scout", leaseOwner: failedLease.ownerId, attemptCount: failedLease.attemptCount,
    }
    const discoveryClient: JobDiscoveryClient = { discover: async request => discoveryOutput(request) }
    const discovery = createJobsDiscoverTool({ client: discoveryClient, fence: discoveryFence }) as RuntimeToolDefinition
    const router = new ToolRouter(new ToolRegistry([discovery]), lifecycle, discoveryPolicy())
    const stores = workerStores()
    const executor = createChildExecutor({
      store: stores.store, treeBudget: stores.budget,
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => scriptedModel(["jobs.discover"], "not-json"),
      toolRuntimeFactory: () => ({
        definitions: [discovery], router,
        discoveryAttemptSidecar: observer.discoveryAttemptSidecar,
        discoveryRecoverySidecar: observer.discoveryRecoverySidecar,
        validateArguments: () => true,
      }),
    })

    const failed = await executor({ lease: failedLease })
    expect(sink.events.map(event => event.phase)).toEqual(["started", "completed"])
    expect(observedEvents.map(event => event.phase)).toEqual(["started", "completed"])
    expect(observedEvents[0]?.call).toMatchObject({ taskId: failedLease.id, rootTaskId: failedLease.rootTaskId,
      sessionId: failedLease.sessionId, turnId: failedLease.turnId, toolName: "jobs.discover", toolVersion: "1" })
    expect(durableResults.put).toHaveBeenCalledOnce()
    expect(durableResults.put).toHaveBeenCalledWith({ kind: "task", lease: failedLease }, expect.objectContaining({
      stepId: observedEvents[0]?.call.stepId, toolCallId: observedEvents[0]?.call.id,
      value: expect.objectContaining({ jobs: [expect.objectContaining({ id: recoveredJobId, fullDescription: "x".repeat(7 * 1024) })] }),
    }))
    expect(sink.events[1]?.item).toMatchObject({ output: {
      $ref: durableReferenceId, sizeBytes: expect.any(Number), sha256: "a".repeat(64),
    } })
    const persistedSize = (sink.events[1]?.item as { output?: { sizeBytes?: number } } | undefined)?.output?.sizeBytes
    expect(persistedSize).toBeGreaterThan(6 * 1024)
    expect(persistedSize).toBeLessThan(1024 * 1024)
    expect(observedEvents[1]).toMatchObject({ phase: "completed", output: {
      jobs: [expect.objectContaining({ id: recoveredJobId, fullDescription: "x".repeat(7 * 1024) })],
    } })
    expect(observer.discoveryRecoverySidecar()).toMatchObject({ attemptCount: failedLease.attemptCount, jobIds: [recoveredJobId] })
    expect(failed).toMatchObject({ status: "failed", failureReason: "invalid_structured_result",
      result: { status: "failed", discoveryRecovery: {
        schemaVersion: DISCOVERY_RECOVERY_SCHEMA_VERSION, attemptCount: failedLease.attemptCount,
        jobIds: [recoveredJobId], truncated: false,
      } } })
    expect(failed.result).not.toHaveProperty("structuredResult")

    // The graph fixture stands in for a final, non-retryable persisted failure; PgStore finalization is covered separately.
    expect(projectTaskGraphResultPage(failedGraph(failedLease, failed.result), {
      nodeKey: "scout-a", expectedRevision: 4, offset: 0,
    })).toMatchObject({ availability: "unavailable", reason: "result_unavailable" })
    const page = projectTaskGraphDiscoveryRecoveryPage(failedGraph(failedLease, failed.result), {
      mode: "discovery_recovery", nodeKey: "scout-a", expectedRevision: 4, offset: 0,
    })
    expect(page).toMatchObject({ availability: "available", observation: "partial_discovery", verificationStatus: "unverified",
      taskStatus: "failed", items: [{ jobId: recoveredJobId }] })
    expect(JSON.stringify(page)).not.toMatch(/greenhouse|provider|score|evidence|PRIVATE/)

    const readStores = workerStores()
    const getJob = vi.fn(async (_userId: string, jobId: string) => ({
      id: jobId, company: "Example", role: "Software Engineer", location: "Dublin", status: "saved", score: 8,
      url: `https://jobs.example/${jobId}`, source: "greenhouse", salary: null, description: "Role", keywords: null,
    }))
    const readDefinitions = createReadOnlyTools(readSource(getJob))
    const readSink = new InMemoryToolLifecycleSink()
    const readRouter = new ToolRouter(new ToolRegistry(readDefinitions), new ToolLifecycle({ sink: readSink }), readPolicy())
    const freshExecutor = createChildExecutor({
      store: readStores.store, treeBudget: readStores.budget,
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => scriptedModel(["jobs.get"], typedScoutResult(recoveredJobId)),
      toolRuntimeFactory: () => ({
        definitions: readDefinitions, router: readRouter,
        validateArguments: () => true,
      }),
    })
    const freshLease = { ...childLease("scout-retry-task"), attemptCount: 1, allowedActions: ["jobs.get"] }
    const current = await freshExecutor({ lease: freshLease })
    expect(getJob).toHaveBeenCalledWith(freshLease.userId, recoveredJobId)
    expect(readSink.events.map(event => event.phase)).toEqual(["started", "completed"])
    expect(current).toMatchObject({ status: "completed", result: { status: "completed", structuredResult: {
      candidates: [{ jobId: recoveredJobId, evidenceIds: [`read:job:${recoveredJobId}`] }],
      evidence: [{ id: `read:job:${recoveredJobId}`, kind: "job", ref: recoveredJobId, source: "greenhouse" }],
    } } })

    const forgedStores = workerStores()
    const forgedRead = vi.fn(async () => null)
    const forgedDefinitions = createReadOnlyTools(readSource(forgedRead))
    const forgedSink = new InMemoryToolLifecycleSink()
    const forgedRouter = new ToolRouter(new ToolRegistry(forgedDefinitions), new ToolLifecycle({ sink: forgedSink }), readPolicy())
    const forged = await createChildExecutor({
      store: forgedStores.store, treeBudget: forgedStores.budget,
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => scriptedModel([], typedScoutResult(recoveredJobId)),
      toolRuntimeFactory: () => ({ definitions: forgedDefinitions, router: forgedRouter, validateArguments: () => true }),
    })({ lease: freshLease })
    expect(forged).toMatchObject({ status: "failed", failureReason: "evidence_missing", result: { status: "failed" } })
    expect(forgedRead).not.toHaveBeenCalled()
    expect(forged.result).not.toHaveProperty("structuredResult")
  })
})
