import { Type } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"
import type { HarnessModelRequest, ModelAdapter } from "@jobcopilot/agent-model"
import { describe, expect, it, vi } from "vitest"

import { createOptionalProductionChildExecutor, childExecutionEnabled } from "./production-child-runtime.js"
import type { SubagentLease } from "./types.js"
import type { TreeBudgetReservationStore } from "./tree-budget-types.js"
import type { TurnEngineStore } from "../turns/turn-engine-types.js"
import type { PublicToolDefinition } from "../tools/types.js"
import { InMemoryArtifactToolStore } from "../tools/artifact-tools.js"
import { hashArtifactContent } from "./artifact-adapters.js"
import { ROLE_RESULT_SCHEMA } from "./role-results.js"
import { loadSelectedJobArtifactContext } from "./selected-job-artifact-context.js"
import { materializeTaskGraphDependencyContext } from "./task-graph-dependency-context.js"
import type { GraphIdentityScope } from "./task-graph-pg-state.js"

const artifactStoreMock = vi.hoisted(() => ({ current: null as unknown }))
const selectedJobSourceCanary = "APPLYMATE_TRANSIENT_SELECTED_JOB_CANARY"
vi.mock("../tools/artifact-tools.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../tools/artifact-tools.js")>()
  return {
    ...actual,
    createArtifactToolStore: () => artifactStoreMock.current as import("../tools/artifact-tools.js").ArtifactToolStore,
  }
})

const profile = {
  provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
  continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: false,
  supportsReasoningSummary: false, supportsResponseContinuation: false, supportsProviderConversation: false,
  supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: 128, costClass: "low" as const,
}

function lease(): SubagentLease {
  return {
    id: "child-runtime-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-runtime-1", depth: 1,
    role: "analyst", taskType: "research", status: "running", goal: "Read jobs", constraints: [], successCriteria: [],
    allowedActions: ["jobs.search"], context: {}, expectedOutputSchema: {}, modelProfileSnapshot: { provider: "fixture", model: "fixture-model" },
    result: null, failureReason: null, attemptCount: 1, maxAttempts: 3, leaseOwner: "worker-1",
    leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"), interruptRequestedAt: null, budgetSnapshot: { subagentPolicy: { maxAttempts: 3 } }, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
  }
}

function store(): TurnEngineStore {
  return {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }),
    updateStep: async () => undefined,
    createItem: async ({ itemId }) => ({ id: itemId, revision: 0 }),
    updateItem: async ({ itemId, expectedRevision }) => ({ id: itemId, revision: expectedRevision + 1 }),
    appendEvent: async ({ id }) => ({ id }),
    recordFinalResponse: async () => undefined,
  }
}

function recordingStore() {
  const writes: Array<{ readonly method: string; readonly value: unknown }> = []
  const engineStore: TurnEngineStore = {
    startStep: async ({ stepId, ordinal }) => ({ id: stepId, ordinal }),
    updateStep: async () => undefined,
    createItem: async ({ itemId, content }) => { writes.push({ method: "createItem", value: content }); return { id: itemId, revision: 0 } },
    updateItem: async ({ itemId, expectedRevision, content }) => { writes.push({ method: "updateItem", value: content }); return { id: itemId, revision: expectedRevision + 1 } },
    appendEvent: async ({ payload }) => { writes.push({ method: "appendEvent", value: payload }); return { id: `event:${writes.length}` } },
    recordFinalResponse: async () => undefined,
  }
  return { engineStore, writes }
}

function selectedJobPool() {
  const job = {
    id: "job-1", company: "Example GmbH", role: "Engineer", location: "Berlin", status: "open", score: 8,
    url: "https://jobs.example/1", source: "greenhouse", salary: "EUR 80k", description: `${selectedJobSourceCanary} job description`, keywords: "TypeScript",
    createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
  }
  const resume = {
    id: "resume-1", name: "Base", kind: "base", origin: "manual", isDefault: true,
    content: { text: `${selectedJobSourceCanary} resume evidence` }, createdAt: new Date("2026-01-01T00:00:00Z"), updatedAt: new Date("2026-01-02T00:00:00Z"),
  }
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('FROM "Job"')) return { rows: [job] }
    if (sql.includes('FROM "Resume"')) return { rows: [resume] }
    if (sql.includes("FROM persona_facts")) return { rows: [{
      id: "fact-1", key: "language", category: "language", value: `${selectedJobSourceCanary} persona evidence`, source: "resume", sourceRef: "resume:language",
      confidence: 0.98, allowedUses: ["cover_letter"],
    }] }
    throw new Error(`unexpected production child query: ${sql}`)
  })
  return { query } as never
}

function jobTask(role: "writer" | "reviewer", context: unknown = { selectedJobPreparation: { jobId: "job-1" } }): SubagentLease {
  return {
    ...lease(), role, taskType: role === "writer" ? "cover_letter_draft" : "cover_letter_review",
    goal: role === "writer" ? "Draft a cover letter" : "Review the cover letter",
    allowedActions: role === "writer"
      ? ["cover_letter.draft"]
      : ["artifact.version.read", "artifact.review"],
    context, expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role },
    toolPolicySnapshot: {},
  }
}

function advertisedTools(request: HarnessModelRequest): readonly Record<string, unknown>[] {
  return request.tools.flatMap(tool => tool && typeof tool === "object" && !Array.isArray(tool)
    ? [tool as Record<string, unknown>]
    : [])
}

function budget(): TreeBudgetReservationStore {
  return {
    reserve: async input => ({ id: `reservation:${input.stepId}`, ...input, units: 1, status: "reserved", createdAt: new Date(), updatedAt: new Date(), settledAt: null }),
    settle: async input => ({ ...input, units: 1, createdAt: new Date(), updatedAt: new Date(), settledAt: new Date() }),
  }
}

function publicTool(name: string): PublicToolDefinition {
  return {
    schemaVersion, name, version: "1", description: name, capabilities: ["read"], inputSchema: Type.Object({}, { additionalProperties: false }),
    outputSchema: Type.Object({}, { additionalProperties: true }), risk: "read", domain: "jobs", idempotency: "read_only", timeoutMs: 1_000, requiredCapabilities: [],
  }
}

function validateFixtureToolArguments(name: string, input: unknown, version?: string): true | string {
  const emptyObject = input !== null && typeof input === "object" && !Array.isArray(input) && Object.keys(input).length === 0
  return name === "jobs.search" && (version === undefined || version === "1") && emptyObject
    ? true
    : "Tool arguments failed fixture schema validation"
}

function selectedJobExecutor(input: {
  readonly artifactStore: InMemoryArtifactToolStore
  readonly persistence: ReturnType<typeof recordingStore>
  readonly model: ModelAdapter
}) {
  artifactStoreMock.current = input.artifactStore
  const executor = createOptionalProductionChildExecutor({
    enabled: true, pool: selectedJobPool(), turnStore: input.persistence.engineStore, treeBudget: budget(),
    authorizeUsage: async () => ({ settle: async () => undefined }), modelRuntimeFactory: () => input.model,
  })
  if (!executor) throw new Error("production selected-job child executor was not created")
  return executor
}

function completedResult(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("completed child result was not an object")
  return value as Record<string, unknown>
}

function emittedTool(request: HarnessModelRequest, name: string): boolean {
  return advertisedTools(request).some(tool => tool.name === name)
}

function assertNoExternalTools(request: HarnessModelRequest): void {
  const tools = advertisedTools(request)
  expect(tools.map(tool => tool.name)).not.toContain("application.submit")
  expect(tools.map(tool => tool.name)).not.toContain("gmail.send")
  expect(tools.every(tool => tool.risk !== "external_write" && !(Array.isArray(tool.capabilities) && tool.capabilities.includes("external_write")))).toBe(true)
}

function stringsDeep(value: unknown): string[] {
  if (typeof value === "string") return [value]
  if (Array.isArray(value)) return value.flatMap(stringsDeep)
  if (value && typeof value === "object") return Object.values(value).flatMap(stringsDeep)
  return []
}

function rowsForToolCall(value: unknown, callId: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(item => rowsForToolCall(item, callId))
  if (!value || typeof value !== "object") return []
  const row = value as Record<string, unknown>
  const matched = row.toolCallId === callId ? [row] : []
  return [...matched, ...Object.values(row).flatMap(child => rowsForToolCall(child, callId))]
}

function taskScope(): GraphIdentityScope {
  return { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
}

function selectedJobSourceDigest(): Promise<Awaited<ReturnType<typeof loadSelectedJobArtifactContext>>> {
  return loadSelectedJobArtifactContext(selectedJobPool(), "user-1", "job-1")
}

describe("production child runtime", () => {
  it("keeps child construction behind the explicit flag", () => {
    expect(childExecutionEnabled("0")).toBe(false)
    expect(childExecutionEnabled("1")).toBe(true)
    expect(createOptionalProductionChildExecutor({ enabled: false, pool: undefined as never })).toBeUndefined()
  })

  it("passes the actual child lease and owner fence through the production seam", async () => {
    const child = lease()
    const requests: HarnessModelRequest[] = []
    let modelCalls = 0
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        requests.push(request)
        modelCalls += 1
        if (modelCalls === 1) {
          yield { type: "tool_call_completed", callId: "jobs-call", name: "jobs.search", arguments: {} }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "Jobs read" }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const toolFactory = vi.fn(({ lease: actualLease, owner }) => {
      expect(actualLease).toBe(child)
      expect(owner).toMatchObject({ kind: "task", taskId: child.id, rootTaskId: child.rootTaskId, attemptCount: child.attemptCount })
      return {
        definitions: [publicTool("jobs.search")],
        router: { execute: async (_context: unknown, request: { id: string; toolName: string; toolVersion: string }) => ({ ...request, status: "completed" as const, errorCode: null }) },
        validateArguments: validateFixtureToolArguments,
      }
    })
    const executor = createOptionalProductionChildExecutor({
      enabled: true, pool: {} as never, turnStore: store(), treeBudget: budget(),
      authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model, toolRuntimeFactory: toolFactory,
    })

    if (!executor) throw new Error("child executor was not created")
    const result = await executor({ lease: child })
    expect(result).toMatchObject({ status: "completed" })
    expect(toolFactory).toHaveBeenCalledOnce()
    expect(requests[0]?.metadata).toMatchObject({ taskId: child.id, turnId: child.turnId })
    expect(requests[0]?.tools.map(tool => (tool as { name: string }).name)).toEqual(["jobs.search"])
  })

  it("uses the server-owned default resume loader for a recovered attempt", async () => {
    const child = { ...lease(), attemptCount: 2, leaseExpiresAt: new Date("2099-09-14T12:00:00.000Z") }
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 }
        if (sql.includes('SELECT task."id"')) return {
          rows: [{ id: child.id, userId: child.userId, sessionId: child.sessionId, turnId: child.turnId, rootTaskId: child.rootTaskId, status: "running", leaseOwner: child.ownerId, attemptCount: child.attemptCount, leaseExpiresAt: child.leaseExpiresAt, interruptRequestedAt: null, turnStatus: "in_progress", rootStatus: "running" }], rowCount: 1,
        }
        if (sql.includes('FROM "agent_steps"')) return { rows: [], rowCount: 0 }
        throw new Error(`unexpected resume query: ${sql}`)
      }),
      release: vi.fn(),
    }
    const poolWithConnect = { connect: vi.fn(async () => client), query: vi.fn() }
    const pool = poolWithConnect as unknown as never
    let modelCalls = 0
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream() {
        modelCalls += 1
        if (modelCalls === 1) {
          yield { type: "tool_call_completed", callId: "resume-call", name: "jobs.search", arguments: {} }
          yield { type: "completed", finishReason: "tool_calls" }
        } else {
          yield { type: "text_delta", text: "resumed" }
          yield { type: "completed", finishReason: "stop" }
        }
      },
    }
    const executor = createOptionalProductionChildExecutor({
      enabled: true, pool, turnStore: store(), treeBudget: budget(), authorizeUsage: async () => ({ settle: async () => undefined }),
      modelRuntimeFactory: () => model, toolRuntimeFactory: () => ({ definitions: [publicTool("jobs.search")], router: { execute: async (_context: unknown, request: { id: string; toolName: string; toolVersion: string }) => ({ ...request, status: "completed" as const, errorCode: null }) }, validateArguments: validateFixtureToolArguments }),
      mailboxReader: { listPendingMessages: async () => [] },
    })
    if (!executor) throw new Error("child executor was not created")
    await expect(executor({ lease: child })).resolves.toMatchObject({ status: "completed" })
    expect(poolWithConnect.connect).toHaveBeenCalledOnce()
    expect(client.query.mock.calls.map(([sql]) => sql)).toContain("SELECT set_config($1, $2, true)")
  })

  it("composes the selected-job Writer and Reviewer tools with a private exact-reference read receipt", async () => {
    const body = "Private cover letter body: production composition fixture."
    const preparation = (await selectedJobSourceDigest()).preparation
    const baseArtifactId = `cover-letter-base:${hashArtifactContent({ userId: "user-1", jobId: "job-1" }).slice(7)}`
    const baseHash = hashArtifactContent({ kind: "cover_letter_base", jobId: "job-1" })
    const artifactRef = {
      artifactId: `cover-letter:${hashArtifactContent({ userId: "user-1", jobId: "job-1" }).slice(7)}`,
      version: 1, contentHash: hashArtifactContent(body), sourceDigest: preparation.sourceDigest,
    }
    const writerRequests: HarnessModelRequest[] = []
    const writerModel: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        writerRequests.push(request)
        if (writerRequests.length === 1) {
          yield { type: "text_delta", text: selectedJobSourceCanary }
          yield { type: "tool_call_completed", callId: "draft-call", name: "cover_letter.draft", arguments: {
            baseArtifactId, baseHash, content: body, constraints: { maxWords: 160 },
          } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        yield { type: "text_delta", text: JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef }) }
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const artifacts = new InMemoryArtifactToolStore()
    const draftSpy = vi.spyOn(artifacts, "writeDraft")
    const writerPersistence = recordingStore()
    const writerExecutor = selectedJobExecutor({ artifactStore: artifacts, persistence: writerPersistence, model: writerModel })
    const writerLease = { ...jobTask("writer"), id: "writer-task" }
    const writer = await writerExecutor({ lease: writerLease })
    expect(writer, JSON.stringify({ writer, writes: writerPersistence.writes })).toMatchObject({ status: "completed" })
    expect(emittedTool(writerRequests[0]!, "cover_letter.draft")).toBe(true)
    assertNoExternalTools(writerRequests[0]!)
    expect(stringsDeep(writerRequests[0]).join("\n")).toContain(selectedJobSourceCanary)
    const writerResult = completedResult(writer.result)
    expect(writerResult.structuredResult).toMatchObject({ role: "writer", artifactRef })
    expect(draftSpy.mock.calls[0]?.[0]).toMatchObject({ taskFence: {
      taskId: "writer-task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
      parentTaskId: "root-1", leaseOwner: "worker-1", attemptCount: 1,
    } })
    expect(stringsDeep(writerPersistence.writes).join("\n")).not.toContain(body)
    expect(stringsDeep(writerPersistence.writes).join("\n")).not.toContain(selectedJobSourceCanary)
    const draftReceipts = writerPersistence.writes.flatMap(write => rowsForToolCall(write.value, "draft-call"))
      .filter(row => Object.prototype.hasOwnProperty.call(row, "output"))
    expect(draftReceipts.length).toBeGreaterThan(0)
    for (const receipt of draftReceipts) expect(receipt.output).toEqual({ artifactRef })

    const scope = taskScope()
    const reviewerContext = materializeTaskGraphDependencyContext(
      { selectedJobPreparation: { jobId: "job-1" } }, scope, ["writer"], [{
        ...scope, key: "writer", taskId: writerLease.id, status: "completed", role: "writer",
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" }, result: writer.result,
      }],
    )
    const reviewHash = hashArtifactContent({
      artifactRef, currentSourceDigest: preparation.sourceDigest, status: "passed", findings: [], evidenceRefs: preparation.evidenceRefs,
    })
    const reviewerRequests: HarnessModelRequest[] = []
    const reviewerModel: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        reviewerRequests.push(request)
        if (reviewerRequests.length === 1) {
          yield { type: "tool_call_completed", callId: "read-call", name: "artifact.version.read", arguments: { artifactRef } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        if (reviewerRequests.length === 2) {
          yield { type: "tool_call_completed", callId: "review-call", name: "artifact.review", arguments: { artifactRef, decision: "passed", findings: [] } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        yield { type: "text_delta", text: JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash }) }
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const reviewerPersistence = recordingStore()
    const reviewSpy = vi.spyOn(artifacts, "saveReview")
    const reviewerExecutor = selectedJobExecutor({ artifactStore: artifacts, persistence: reviewerPersistence, model: reviewerModel })
    const reviewerLease = { ...jobTask("reviewer", reviewerContext), id: "reviewer-task" }
    const reviewer = await reviewerExecutor({ lease: reviewerLease })
    expect(reviewer).toMatchObject({ status: "completed" })
    expect(emittedTool(reviewerRequests[0]!, "artifact.version.read")).toBe(true)
    expect(emittedTool(reviewerRequests[0]!, "artifact.review")).toBe(true)
    expect(emittedTool(reviewerRequests[0]!, "cover_letter.draft")).toBe(false)
    assertNoExternalTools(reviewerRequests[0]!)
    expect(stringsDeep(reviewerRequests[0]).join("\n")).toContain(selectedJobSourceCanary)
    expect(stringsDeep(reviewerRequests[1]).join("\n")).toContain(body)
    expect(completedResult(reviewer.result).structuredResult).toMatchObject({ role: "reviewer", artifactRef, reviewStatus: "passed", reviewHash })
    expect(reviewSpy.mock.calls[0]?.[0]).toMatchObject({ taskFence: {
      taskId: "reviewer-task", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
      parentTaskId: "root-1", leaseOwner: "worker-1", attemptCount: 1,
    } })

    const persisted = reviewerPersistence.writes
    expect(persisted.map(write => write.method)).toEqual(expect.arrayContaining(["createItem", "updateItem", "appendEvent"]))
    expect(stringsDeep(persisted).join("\n")).not.toContain(body)
    expect(stringsDeep(persisted).join("\n")).not.toContain(selectedJobSourceCanary)
    const readReceipts = persisted.flatMap(write => rowsForToolCall(write.value, "read-call"))
    expect(readReceipts.length).toBeGreaterThan(0)
    expect(readReceipts.some(row => JSON.stringify(row).includes(artifactRef.artifactId))).toBe(true)
    expect(JSON.stringify(readReceipts)).not.toContain(body)
    const reviewReceipts = persisted.flatMap(write => rowsForToolCall(write.value, "review-call"))
      .filter(row => Object.prototype.hasOwnProperty.call(row, "output"))
    expect(reviewReceipts.length).toBeGreaterThan(0)
    for (const receipt of reviewReceipts) expect(receipt.output).toEqual({ artifactRef })
    for (const write of persisted) {
      if (write.method === "createItem" || write.method === "updateItem" || write.method === "appendEvent") {
        expect(stringsDeep(write.value).join("\n")).not.toContain(body)
      }
    }
  })

  it("refuses a Reviewer read whose reference differs from the direct Writer dependency", async () => {
    const body = "Only the exact direct Writer reference is readable."
    const preparation = (await selectedJobSourceDigest()).preparation
    const baseArtifactId = `cover-letter-base:${hashArtifactContent({ userId: "user-1", jobId: "job-1" }).slice(7)}`
    const baseHash = hashArtifactContent({ kind: "cover_letter_base", jobId: "job-1" })
    const artifactRef = {
      artifactId: `cover-letter:${hashArtifactContent({ userId: "user-1", jobId: "job-1" }).slice(7)}`,
      version: 1, contentHash: hashArtifactContent(body), sourceDigest: preparation.sourceDigest,
    }
    const writerModel: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        if (request.metadata.stepId.endsWith("step:0:attempt:1")) {
          yield { type: "tool_call_completed", callId: "draft-call", name: "cover_letter.draft", arguments: {
            baseArtifactId, baseHash, content: body, constraints: {},
          } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        yield { type: "text_delta", text: JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef }) }
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const artifacts = new InMemoryArtifactToolStore()
    const writerExecutor = selectedJobExecutor({ artifactStore: artifacts, persistence: recordingStore(), model: writerModel })
    const writerLease = { ...jobTask("writer"), id: "writer-task" }
    const writer = await writerExecutor({ lease: writerLease })
    expect(writer, JSON.stringify(writer)).toMatchObject({ status: "completed" })

    const scope = taskScope()
    const context = materializeTaskGraphDependencyContext(
      { selectedJobPreparation: { jobId: "job-1" } }, scope, ["writer"], [{
        ...scope, key: "writer", taskId: writerLease.id, status: "completed", role: "writer",
        expectedOutputSchema: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer" }, result: writer.result,
      }],
    )
    const incorrectReference = { ...artifactRef, contentHash: `sha256:${"0".repeat(64)}` }
    const badReviewHash = hashArtifactContent({
      artifactRef: incorrectReference, currentSourceDigest: preparation.sourceDigest, status: "passed", findings: [], evidenceRefs: preparation.evidenceRefs,
    })
    const requests: HarnessModelRequest[] = []
    const model: ModelAdapter = {
      id: "fixture-model", profile,
      async *stream(request) {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: "tool_call_completed", callId: "bad-read-call", name: "artifact.version.read", arguments: { artifactRef: incorrectReference } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        if (requests.length === 2) {
          yield { type: "tool_call_completed", callId: "bad-review-call", name: "artifact.review", arguments: { artifactRef: incorrectReference, decision: "passed", findings: [] } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }
        yield { type: "text_delta", text: JSON.stringify({ schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef: incorrectReference, reviewStatus: "passed", reviewHash: badReviewHash }) }
        yield { type: "completed", finishReason: "stop" }
      },
    }
    const readSpy = vi.spyOn(artifacts, "readVersion")
    const reviewSpy = vi.spyOn(artifacts, "saveReview")
    const reviewerExecutor = selectedJobExecutor({ artifactStore: artifacts, persistence: recordingStore(), model })
    const result = await reviewerExecutor({ lease: { ...jobTask("reviewer", context), id: "reviewer-task" } })
    expect(result.status).toBe("failed")
    expect(result.failureReason).toBeDefined()
    expect(readSpy).not.toHaveBeenCalled()
    expect(reviewSpy).not.toHaveBeenCalled()
    expect(emittedTool(requests[0]!, "application.submit")).toBe(false)
    expect(emittedTool(requests[0]!, "gmail.send")).toBe(false)
  })
})
