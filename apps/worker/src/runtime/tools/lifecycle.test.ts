import { createHash } from "node:crypto"
import { schemaVersion, ToolCallItemSchema, ToolResultItemSchema, validate } from "@jobcopilot/agent-protocol"
import { canonicalJson } from "@jobcopilot/shared"
import { Type } from "@sinclair/typebox"
import { describe, expect, it, vi } from "vitest"

import type { ExecutionOwner } from "../execution-owner.js"
import { InMemoryToolLifecycleSink, ToolLifecycle, type LifecycleCall } from "./lifecycle.js"
import { createToolResultReferenceRepository } from "./tool-result-reference-repo.js"
import { redactJobReadOutput } from "./job-read-output-redaction.js"
import { InMemoryToolResultReferenceStore, prepareLifecycleValue } from "./redaction.js"
import { createToolResultsReadTool } from "./tool-results-read-tool.js"
import { ToolRegistry } from "./registry.js"
import { ToolRouter } from "./router.js"
import type { RuntimeToolDefinition, ToolExecutionContext } from "./types.js"
import type { ToolResultChunk, ToolResultReferenceRepository } from "./tool-result-reference-types.js"

const call: LifecycleCall = { id: "call-1", toolName: "jobs.search", toolVersion: "1", sessionId: "session-1", turnId: "turn-1", stepId: "step-1" }
const ordinaryCall: LifecycleCall = { ...call, toolName: "notes.read" }
const planCall: LifecycleCall = { ...call, toolName: "agent.plan" }
const numericUuidV4 = "00000000-0000-4000-8000-000000000000"
const numericUuidV1 = "00000000-0000-1000-8000-000000000000"
const phoneLikeId = "+353 87 123 4567"
const prefixedFixtureId = `p3-discovery-failure-job-${numericUuidV4}`
const cuidJobId = "c123456789012345678901234"
const planReceipt = {
  status: "accepted",
  revision: 1,
  nodes: [
    { key: "source / résumé:💼", taskId: "subagent-12345678-1234-4abc-8def-123456789012", status: "queued" },
    { key: "dependent-b", taskId: "subagent-87654321-4321-4abc-8def-210987654321", status: "waiting" },
  ],
  readyTaskIds: ["subagent-12345678-1234-4abc-8def-123456789012"],
} as const
const spawnTurnId = "c123456789012345678901234"
const spawnRootTaskId = `root-${spawnTurnId}`
const spawnTaskId = "subagent-0e34de21-c5e7-4db7-8e75-904732813337"
const spawnCall: LifecycleCall = {
  ...call, id: "call-spawn", toolName: "agent.spawn", turnId: spawnTurnId,
  taskId: spawnRootTaskId, rootTaskId: spawnRootTaskId,
}
const spawnReceipt = {
  taskId: spawnTaskId, rootTaskId: spawnRootTaskId, parentTaskId: spawnRootTaskId,
  path: `/${spawnRootTaskId}/${spawnTaskId}`, depth: 1, status: "queued", replay: false,
} as const
const durableWaitReceipt = {
  waitId: "wait-12345678-1234-4234-9234-123456789012",
  status: "ready",
  taskIds: [spawnTaskId],
  deadlineAt: "2026-09-29T12:00:00.000Z",
  matchedTaskIds: [spawnTaskId],
  tasks: [{
    taskId: spawnTaskId,
    status: "completed",
    role: "scout",
    result: {
      summary: "Contact candidate@example.com at 202-555-0199",
      privateData: { content: "private resume notes" },
      taskId: spawnTaskId,
    },
    failureReason: null,
  }],
  aggregate: { jobIds: [spawnTaskId] },
}
const owner: ExecutionOwner = {
  kind: "turn", taskId: "root-1", lease: {
    turnId: "turn-1", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 1,
    leaseStartedAt: new Date("2026-08-31T11:59:00.000Z"), leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
  },
}
const verifiedReadRef = "tool-result-00000000-0000-4000-8000-000000000000"

async function verifiedReadOutput(toolCallId: string) {
  const rawValue = {
    jobs: [{ id: numericUuidV4, description: "Contact candidate@example.com at 202-555-0199" }],
    page: 1,
    hasMore: false,
  }
  const sanitizedJson = redactJobReadOutput("jobs.search", rawValue)
  const encoded = canonicalJson(sanitizedJson)
  const stored = {
    id: verifiedReadRef,
    userId: "user-1",
    sessionId: "session-1",
    turnId: "turn-1",
    stepId: "source-step",
    taskId: "root-1",
    toolCallId: "source-call",
    sanitizedJson,
    sha256: createHash("sha256").update(encoded, "utf8").digest("hex"),
    byteCount: Buffer.byteLength(encoded, "utf8"),
    createdAt: new Date("2026-09-08T03:00:00.000Z"),
    updatedAt: new Date("2026-09-08T03:00:00.000Z"),
  }
  const client = {
    async query<T = unknown>(query: string) {
      const rows = query.includes('FROM "sub_agent_tasks" root')
        ? [{ id: "root-1" }]
        : query.includes("SELECT ref.*")
          ? [stored]
          : query.includes('FROM "agent_items" AS item')
            ? [{ toolName: "jobs.search" }]
            : []
      return { rows: rows as T[], rowCount: rows.length }
    },
    release: () => undefined,
  }
  const repository = createToolResultReferenceRepository({ connect: async () => client } as never)
  const tool = createToolResultsReadTool(repository, () => owner)
  const context: ToolExecutionContext = {
    scope: { userId: "user-1" },
    sessionId: "session-1",
    turnId: "turn-1",
    stepId: "read-step",
    taskId: "root-1",
    toolCallId,
    signal: new AbortController().signal,
    capabilities: ["read"],
    reportProgress: async () => undefined,
  }
  return tool.execute(context, { referenceId: verifiedReadRef })
}

function durableLifecyclePool(sourceCallId: string) {
  let stored: Record<string, unknown> | undefined
  const client = {
    async query<T = unknown>(query: string, values: readonly unknown[] = []) {
      let rows: unknown[] = []
      if (query.includes('FROM "agent_sessions"')) rows = [{ id: "session-1" }]
      else if (query.includes('FROM "agent_steps"')) rows = [{ id: values[0] }]
      else if (query.includes('FROM "sub_agent_tasks" root')) rows = [{ id: "root-1" }]
      else if (query.includes('FROM "agent_items" AS item')) {
        if (values[4] === sourceCallId) rows = [{ toolName: "jobs.search" }]
      } else if (query.includes('INSERT INTO "agent_tool_result_references"')) {
        stored = {
          id: values[0], userId: values[1], sessionId: values[2], turnId: values[3], stepId: values[4],
          taskId: values[5], toolCallId: values[6], sanitizedJson: JSON.parse(String(values[7])),
          sha256: values[8], byteCount: values[9], createdAt: values[10], updatedAt: values[10],
        }
      } else if (query.includes('WHERE "stepId" = $1')) {
        if (stored && stored.stepId === values[0] && stored.toolCallId === values[1]) rows = [stored]
      } else if (query.includes("SELECT ref.*")) {
        if (stored && stored.id === values[0] && stored.userId === values[1] && stored.sessionId === values[2]) rows = [stored]
      }
      return { rows: rows as T[], rowCount: rows.length }
    },
    release: () => undefined,
  }
  return { connect: async () => client }
}

describe("ToolLifecycle", () => {
  it("emits replayable started, progress, and result Items without raw sensitive data", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" })
    await lifecycle.started(call, { query: "Berlin", password: "secret" })
    await lifecycle.progress(call, { stage: "fetching", token: "private" })
    const output = await lifecycle.completed(call, {
      jobs: [{
        id: numericUuidV4,
        description: "Contact candidate@example.com at 202-555-0199",
        privateValue: "candidate work authorization details",
        notes: `Call ${phoneLikeId} to discuss`,
        metadata: { id: numericUuidV4 },
      }],
      page: 1,
      hasMore: false,
      id: numericUuidV4,
    })

    expect(output).toEqual({
      jobs: [{
        id: numericUuidV4,
        description: "Contact [REDACTED_EMAIL] at [REDACTED_PHONE]",
        privateValue: "[REDACTED]",
        notes: "Call [REDACTED_PHONE] to discuss",
        metadata: { id: "[REDACTED_PHONE]" },
      }],
      page: 1,
      hasMore: false,
      id: "[REDACTED_PHONE]",
    })
    expect(sink.events[2]?.item).toMatchObject({ type: "tool_result", output })
    expect(sink.events[2]?.payload.output).toEqual(output)
    expect(sink.replay().map((event) => event.phase)).toEqual(["started", "progress", "completed"])
    expect(validate(ToolCallItemSchema, sink.events[0].item)).toBe(true)
    expect(validate(ToolCallItemSchema, sink.events[1].item)).toBe(true)
    expect(validate(ToolResultItemSchema, sink.events[2].item)).toBe(true)
    expect(JSON.stringify(sink.events)).not.toContain("secret")
    expect(JSON.stringify(sink.events)).not.toContain("candidate work authorization details")
    expect(sink.events[1].item).toMatchObject({ type: "tool_call", input: { query: "Berlin", password: "[REDACTED]" } })
  })

  it("preserves only jobs.get job.id and redacts other matching ID fields", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    const output = await lifecycle.completed({ ...call, toolName: "jobs.get" }, {
      job: {
        id: cuidJobId,
        description: "Email recruiter@example.com for details",
        privateValue: "candidate work authorization details",
        metadata: { id: numericUuidV4 },
      },
      nested: { id: numericUuidV4 },
      id: phoneLikeId,
    })

    expect(output).toEqual({
      job: {
        id: cuidJobId,
        description: "Email [REDACTED_EMAIL] for details",
        privateValue: "[REDACTED]",
        metadata: { id: "[REDACTED_PHONE]" },
      },
      nested: { id: "[REDACTED_PHONE]" },
      id: "[REDACTED_PHONE]",
    })
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output })
    expect(sink.events[0]?.payload.output).toEqual(output)
  })

  it.each([
    { toolName: "jobs.search", output: { jobs: [{ id: phoneLikeId }], page: 1, hasMore: false } },
    { toolName: "jobs.get", output: { job: { id: numericUuidV1 } } },
    { toolName: "jobs.get", output: { job: { id: prefixedFixtureId } } },
  ] as const)("fails closed for invalid $toolName job IDs", async ({ toolName, output }) => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    const safeOutput = await lifecycle.completed({ ...call, id: `call-${toolName}-invalid`, toolName }, output)

    expect(safeOutput).toBe("[REDACTED]")
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output: safeOutput })
    expect(sink.events[0]?.payload.output).toEqual(safeOutput)
  })

  it("uses ordinary shared redaction for the same fields under an unrelated tool", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    const output = await lifecycle.completed(ordinaryCall, {
      jobs: [{
        id: numericUuidV4,
        description: "Contact candidate@example.com at 202-555-0199",
        privateValue: "candidate work authorization details",
        notes: `Call ${phoneLikeId} to discuss`,
        metadata: { id: numericUuidV4 },
      }],
      page: 1,
      hasMore: false,
      id: numericUuidV4,
    })

    expect(output).toEqual({
      jobs: [{
        id: "[REDACTED_PHONE]",
        description: "Contact [REDACTED_EMAIL] at [REDACTED_PHONE]",
        privateValue: "[REDACTED]",
        notes: "Call [REDACTED_PHONE] to discuss",
        metadata: { id: "[REDACTED_PHONE]" },
      }],
      page: 1,
      hasMore: false,
      id: "[REDACTED_PHONE]",
    })
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output })
    expect(sink.events[0]?.payload.output).toEqual(output)
  })

  it("preserves a repo-verified tool result ref and sanitized chunk through lifecycle completion", async () => {
    const toolCallId = "call-read-verified"
    const readOutput = await verifiedReadOutput(toolCallId)
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink, resolveOwner: () => owner })
    const output = await lifecycle.completed({ ...call, id: toolCallId, toolName: "tool_results.read" }, readOutput)

    expect(output).toEqual(readOutput)
    expect(readOutput.ref).toBe(verifiedReadRef)
    expect(readOutput.chunk).toContain(numericUuidV4)
    expect(readOutput.chunk).not.toContain("candidate@example.com")
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output: readOutput })
    expect(sink.events[0]?.payload.output).toEqual(readOutput)
  })

  it("round-trips an oversized result through paginated ToolRouter read outputs", async () => {
    const sourceCallId = "source-search-call"
    const repository = createToolResultReferenceRepository(durableLifecyclePool(sourceCallId) as never)
    const sourceOutput = {
      jobs: [{
        id: numericUuidV4,
        description: `Software Engineer ${"X".repeat(10_000)}`,
        privateValue: "candidate@example.com",
      }],
      page: 1,
      hasMore: false,
    }
    const searchTool: RuntimeToolDefinition = {
      schemaVersion,
      name: "jobs.search",
      version: "1",
      description: "Read fixture jobs",
      capabilities: ["read"],
      inputSchema: Type.Object({ query: Type.String() }, { additionalProperties: false }),
      outputSchema: Type.Object({
        jobs: Type.Array(Type.Object({ id: Type.String(), description: Type.String(), privateValue: Type.String() }, { additionalProperties: false })),
        page: Type.Integer(),
        hasMore: Type.Boolean(),
      }, { additionalProperties: false }),
      risk: "read",
      domain: "jobs",
      idempotency: "read_only",
      timeoutMs: 10_000,
      requiredCapabilities: [],
      execute: async () => sourceOutput,
    }
    const readTool = createToolResultsReadTool(repository, () => owner) as RuntimeToolDefinition
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink, durableResults: repository, resolveOwner: () => owner })
    const router = new ToolRouter(new ToolRegistry([searchTool, readTool]), lifecycle)
    const context = {
      scope: { userId: "user-1" },
      sessionId: "session-1",
      turnId: "turn-1",
      stepId: "source-step",
      taskId: "root-1",
      capabilities: ["read"],
      signal: new AbortController().signal,
    }
    const source = await router.execute(context, {
      id: sourceCallId,
      toolName: "jobs.search",
      toolVersion: "1",
      input: { query: "Berlin" },
    })
    expect(source.status).toBe("completed")
    const reference = source.output as { $ref: string; sizeBytes: number; sha256: string }
    expect(reference.$ref).toMatch(/^tool-result-[0-9a-f-]{36}$/)

    const expectedSafe = redactJobReadOutput("jobs.search", sourceOutput)
    const encoded = canonicalJson(expectedSafe)
    expect(reference.sizeBytes).toBeGreaterThan(8 * 1024)
    expect(reference.sizeBytes).toBe(Buffer.byteLength(encoded, "utf8"))
    expect(reference.sha256).toBe(createHash("sha256").update(encoded, "utf8").digest("hex"))

    const chunks: string[] = []
    let cursor: string | undefined
    let reachedEof = false
    for (let index = 0; index < 10; index += 1) {
      const requestId = `read-page-${index}`
      const read = await router.execute({ ...context, stepId: `read-step-${index}` }, {
        id: requestId,
        toolName: "tool_results.read",
        toolVersion: "1",
        input: { referenceId: reference.$ref, ...(cursor === undefined ? {} : { cursor }) },
      })
      expect(read.status).toBe("completed")
      const chunk = read.output as ToolResultChunk
      expect(chunk).toMatchObject({ ref: reference.$ref, sha256: reference.sha256, byteCount: reference.sizeBytes })
      chunks.push(chunk.chunk)
      const event = sink.events.find(candidate => candidate.phase === "completed"
        && candidate.item.type === "tool_result" && candidate.item.toolCallId === requestId)
      expect(event?.item).toMatchObject({ type: "tool_result", output: chunk })
      expect(event?.payload.output).toEqual(chunk)
      if (chunk.nextCursor === null) {
        reachedEof = true
        break
      }
      cursor = chunk.nextCursor
    }

    const rebuilt = chunks.join("")
    expect(reachedEof).toBe(true)
    expect(chunks.length).toBeGreaterThan(1)
    expect(rebuilt).toBe(encoded)
    expect(Buffer.byteLength(rebuilt, "utf8")).toBe(reference.sizeBytes)
    expect(createHash("sha256").update(rebuilt, "utf8").digest("hex")).toBe(reference.sha256)
    expect(JSON.parse(rebuilt)).toEqual(expectedSafe)
  })

  it("uses generic redaction when a tool result read lacks matching provenance", async () => {
    const readOutput = await verifiedReadOutput("call-read-verified")
    const genericOutput = prepareLifecycleValue(readOutput).safe
    const otherOwner: ExecutionOwner = { ...owner, taskId: "root-other" }
    const cases = [
      { callId: "call-read-verified", output: readOutput },
      { callId: "call-read-verified", output: readOutput, owner: otherOwner },
      { callId: "call-read-other", output: readOutput, owner },
      { callId: "call-read-verified", output: { ...readOutput }, owner },
    ]

    for (const testCase of cases) {
      const sink = new InMemoryToolLifecycleSink()
      const lifecycle = new ToolLifecycle({
        sink,
        ...(testCase.owner ? { resolveOwner: () => testCase.owner } : {}),
      })
      const output = await lifecycle.completed({ ...call, id: testCase.callId, toolName: "tool_results.read" }, testCase.output)

      expect(output).toEqual(genericOutput)
      expect(sink.events[0]?.payload.output).toEqual(output)
    }
  })

  it("records cancellation as an interrupted result Item", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink, references: new InMemoryToolResultReferenceStore(), now: () => "2026-08-31T12:00:00.000Z" })
    await lifecycle.started(call, {})
    await lifecycle.failed(call, "cancelled", "cancelled", { reason: "stop" })
    expect(sink.events.at(-1)).toMatchObject({ phase: "cancelled", item: { status: "interrupted", errorCode: "cancelled" } })
  })

  it("persists only oversized completed output with the actual call identity", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const put = vi.fn(async (_owner: ExecutionOwner, input: { stepId: string; toolCallId: string; value: unknown }) => ({
      id: "tool-result-durable", userId: "user-1", sessionId: "session-1", turnId: "turn-1", stepId: input.stepId,
      taskId: "root-1", toolCallId: input.toolCallId, sanitizedJson: input.value as never, sha256: "a".repeat(64),
      byteCount: 9_000, createdAt: new Date(), updatedAt: new Date(),
    }))
    const durableResults = { put, read: vi.fn() } as unknown as ToolResultReferenceRepository
    const lifecycle = new ToolLifecycle({
      sink, durableResults, resolveOwner: () => owner, maxEventBytes: 256,
      now: () => "2026-08-31T12:00:00.000Z",
    })

    await lifecycle.started(ordinaryCall, { query: "x".repeat(9_000) })
    await lifecycle.progress(ordinaryCall, { stage: "x".repeat(9_000) })
    const output = await lifecycle.completed(ordinaryCall, { result: "x".repeat(9_000), password: "secret" })

    expect(output).toEqual({ $ref: "tool-result-durable", sizeBytes: 9_000, sha256: "a".repeat(64) })
    expect(put).toHaveBeenCalledWith(owner, expect.objectContaining({ stepId: "step-1", toolCallId: "call-1" }))
    expect(sink.events[0]?.item).toMatchObject({ input: { $truncated: true } })
    expect(sink.events[1]?.payload).toMatchObject({ progress: { $truncated: true } })
    expect(JSON.stringify(sink.events)).not.toContain("secret")
  })

  it("fails closed when oversized output has no durable owner binding", async () => {
    const lifecycle = new ToolLifecycle({ sink: new InMemoryToolLifecycleSink(), maxEventBytes: 256 })
    await expect(lifecycle.completed(ordinaryCall, { result: "x".repeat(9_000) })).rejects.toMatchObject({
      code: "tool_result_storage_unavailable",
    })
  })

  it("preserves bounded TaskGraph IDs and valid punctuation/Unicode keys in the receipt and lifecycle event", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    expect(prepareLifecycleValue(planReceipt).safe).not.toEqual(planReceipt)

    const output = await lifecycle.completed(planCall, planReceipt)

    expect(output).toEqual(planReceipt)
    expect(sink.events).toHaveLength(1)
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output: planReceipt })
    expect(sink.events[0]?.payload.output).toEqual(planReceipt)
  })

  it("returns phone-like generated spawn IDs intact for the following agent.wait call", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    expect(prepareLifecycleValue(spawnReceipt).safe).not.toEqual(spawnReceipt)

    const output = await lifecycle.completed(spawnCall, spawnReceipt) as typeof spawnReceipt
    const followingWaitInput = { taskIds: [output.taskId] }

    expect(output).toEqual(spawnReceipt)
    expect(followingWaitInput).toEqual({ taskIds: [spawnTaskId] })
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output: spawnReceipt })
    expect(sink.events[0]?.payload.output).toEqual(spawnReceipt)
  })

  it("preserves the legacy spawn_subagent alias through lifecycle redaction", async () => {
    const lifecycle = new ToolLifecycle({ sink: new InMemoryToolLifecycleSink() })
    const output = await lifecycle.completed({ ...spawnCall, id: "call-spawn-alias", toolName: "spawn_subagent" }, spawnReceipt)
    expect(output).toEqual(spawnReceipt)
  })

  it.each(["agent.wait", "wait_subagents"])("preserves a generated wait ID and redacts other fields for %s", async toolName => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    const output = await lifecycle.completed({ ...call, id: `call-${toolName}`, toolName }, durableWaitReceipt)

    expect(output).toMatchObject({
      waitId: durableWaitReceipt.waitId,
      status: "ready",
      taskIds: [spawnTaskId],
      matchedTaskIds: [spawnTaskId],
      tasks: [{
        taskId: spawnTaskId,
        status: "completed",
        role: "scout",
        result: {
          summary: "Contact [REDACTED_EMAIL] at [REDACTED_PHONE]",
          privateData: { content: "[REDACTED]" },
        },
        failureReason: null,
      }],
    })
    const safeTasks = (output as { tasks: Array<{ result: { taskId: unknown } }> }).tasks
    expect(safeTasks[0]?.result.taskId).not.toBe(spawnTaskId)
    expect((output as { aggregate: { jobIds: unknown[] } }).aggregate.jobIds).not.toEqual([spawnTaskId])
    expect(sink.events[0]?.item).toMatchObject({ type: "tool_result", output })
    expect(sink.events[0]?.payload.output).toEqual(output)
  })

  it.each(["agent.wait", "wait_subagents"])("fails closed for malformed wait IDs on %s", async toolName => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })
    await expect(lifecycle.completed({ ...call, id: `call-${toolName}-malformed`, toolName }, {
      waitId: "wait-123",
      status: "ready",
      email: "candidate@example.com",
    })).rejects.toMatchObject({ code: "durable_wait_receipt_invalid" })

    expect(sink.events).toHaveLength(0)
  })

  it.each([
    { label: "malformed", output: { ...durableWaitReceipt, waitId: "wait-123", status: "waiting" } },
    { label: "missing", output: { status: "waiting", deadlineAt: "2026-09-29T12:00:00.000Z", matchedTaskIds: [] } },
  ])("rejects a $label wait ID before persisting a waiting receipt", async ({ output }) => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })

    await expect(lifecycle.completed({ ...call, toolName: "agent.wait" }, output)).rejects.toMatchObject({
      code: "durable_wait_receipt_invalid",
    })
    expect(sink.events).toHaveLength(0)
  })

  it("keeps generic redaction for canonical wait-shaped IDs on unrelated tools", async () => {
    const lifecycle = new ToolLifecycle({ sink: new InMemoryToolLifecycleSink() })
    const output = await lifecycle.completed(ordinaryCall, { waitId: durableWaitReceipt.waitId })
    expect(output).toEqual({ waitId: "wait-[REDACTED_PHONE]" })
  })

  it("fails closed for malformed or extra-field agent.spawn receipts", async () => {
    const sink = new InMemoryToolLifecycleSink()
    const lifecycle = new ToolLifecycle({ sink })

    await expect(lifecycle.completed(spawnCall, { ...spawnReceipt, email: "candidate@example.com" })).rejects.toMatchObject({
      code: "subagent_spawn_receipt_invalid",
    })
    expect(sink.events).toHaveLength(0)
  })

  it("keeps generic phone and email redaction and rejects malformed TaskGraph receipts", async () => {
    const ordinarySink = new InMemoryToolLifecycleSink()
    const ordinaryLifecycle = new ToolLifecycle({ sink: ordinarySink })
    const ordinary = await ordinaryLifecycle.completed(ordinaryCall, {
      message: "Email candidate@example.com or call 202-555-0199",
    })
    expect(ordinary).toEqual({ message: "Email [REDACTED_EMAIL] or call [REDACTED_PHONE]" })

    const malformedReceipts = [
      { ...planReceipt, extra: "candidate@example.com" },
      { ...planReceipt, nodes: [{ ...planReceipt.nodes[0], extra: "202-555-0199" }, planReceipt.nodes[1]] },
      { ...planReceipt, readyTaskIds: ["subagent-00000000-0000-4000-8000-000000000000"] },
      { ...planReceipt, nodes: [{ ...planReceipt.nodes[0], key: "candidate@example.com" }, planReceipt.nodes[1]] },
      { ...planReceipt, nodes: [{ ...planReceipt.nodes[0], key: "+1 (415) 555-0132" }, planReceipt.nodes[1]] },
      { ...planReceipt, nodes: [{ ...planReceipt.nodes[0], key: "password=private-token-value" }, planReceipt.nodes[1]] },
    ]
    for (const receipt of malformedReceipts) {
      const sink = new InMemoryToolLifecycleSink()
      const lifecycle = new ToolLifecycle({ sink })
      await expect(lifecycle.completed(planCall, receipt)).rejects.toMatchObject({ code: "task_graph_receipt_invalid" })
      expect(sink.events).toHaveLength(0)
    }
  })
})
