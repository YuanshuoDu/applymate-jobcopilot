import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalJson, redactSensitiveValue } from "@jobcopilot/shared"

import type { SubagentLease } from "../subagents/types.js"
import type { TurnLease } from "../turns/lease.js"
import { MAX_TOOL_RESULT_BYTES } from "./tool-result-reference-types.js"
import { createToolResultReferenceRepository, isVerifiedToolResultChunk, ToolResultRepositoryError } from "./tool-result-reference-repo.js"

const now = new Date("2026-09-08T03:00:00.000Z")
const turn: TurnLease = {
  turnId: "turn-current", sessionId: "session-1", ownerId: "worker-1", userId: "user-1", leaseVersion: 7,
  leaseStartedAt: new Date("2026-09-08T02:59:00.000Z"), leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"),
}
const rootOwner = { kind: "turn" as const, taskId: "root-current", lease: turn }

type StoredRow = Record<string, unknown>

function row(id: string, taskId: string, value: unknown): StoredRow {
  const encoded = canonicalJson(value)
  return {
    id, userId: "user-1", sessionId: "session-1", turnId: "turn-current", stepId: "step-1", taskId,
    toolCallId: "call-1", sanitizedJson: value, sha256: createHash("sha256").update(encoded).digest("hex"), byteCount: Buffer.byteLength(encoded),
    createdAt: now, updatedAt: now,
  }
}

type TaskRow = { id: string; rootTaskId: string; turnId: string; sessionId: string; path: string }

function fakePool(options: {
  historical?: StoredRow
  tasks?: TaskRow[]
  childRootTurnStatus?: string
  stepTaskId?: string
  stepAttempt?: number
  sessionStatus?: string
  sessionUserId?: string
  sourceToolNames?: string[]
} = {}) {
  let stored: StoredRow | undefined = options.historical
  const queries: Array<{ text: string; values: readonly unknown[] }> = []
  const tasks = new Map((options.tasks ?? [{ id: "root-current", rootTaskId: "root-current", turnId: "turn-current", sessionId: "session-1", path: "/root-current" }]).map(task => [task.id, task]))
  const client = {
    async query<T = unknown>(text: string, values: readonly unknown[] = []) {
      queries.push({ text, values })
      if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK" || text.includes("set_config")) return { rows: [], rowCount: 0 } as { rows: T[]; rowCount: number }
      if (text.includes('FROM "agent_items" AS item')) {
        const scoped = values[0] === "session-1" && values[5] === "user-1"
        const rows = scoped ? (options.sourceToolNames ?? ["test.tool"]).slice(0, 2).map(toolName => ({ toolName })) : []
        return { rows, rowCount: rows.length } as { rows: T[]; rowCount: number }
      }
      if (text.includes('FROM "agent_sessions"')) {
        const allowed = values[0] === "session-1" && values[1] === (options.sessionUserId ?? "user-1")
          && !["aborted", "archived"].includes(options.sessionStatus ?? "running")
        return { rows: allowed ? [{ id: "session-1" }] : [], rowCount: allowed ? 1 : 0 } as { rows: T[]; rowCount: number }
      }
      if (text.includes('FROM "agent_steps"')) {
        const matches = values[1] === "session-1" && values[2] === "turn-current"
          && values[3] === (options.stepTaskId ?? "root-current") && values[4] === (options.stepAttempt ?? 1)
        return { rows: matches ? [{ id: "step-1" }] : [], rowCount: matches ? 1 : 0 } as { rows: T[]; rowCount: number }
      }
      if (text.includes('FROM "sub_agent_tasks" task')) {
        const allowed = options.childRootTurnStatus === undefined || ["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"].includes(options.childRootTurnStatus)
        return { rows: allowed ? [{ id: String(values[0]) }] : [], rowCount: allowed ? 1 : 0 } as { rows: T[]; rowCount: number }
      }
      if (text.includes('FROM "sub_agent_tasks" root')) return { rows: [{ id: "root-current" }], rowCount: 1 } as { rows: T[]; rowCount: number }
      if (text.includes("INSERT INTO \"agent_tool_result_references\"")) {
        if (!stored) {
          stored = row(String(values[0]), String(values[5]), JSON.parse(String(values[7])))
          stored.sha256 = String(values[8])
        }
        return { rows: [], rowCount: 1 } as { rows: T[]; rowCount: number }
      }
      if (text.includes('WHERE "stepId" = $1')) return { rows: stored ? [stored] : [], rowCount: stored ? 1 : 0 } as { rows: T[]; rowCount: number }
      if (text.includes('SELECT ref.*')) {
        if (!stored || stored.userId !== values[1] || stored.sessionId !== values[2]) return { rows: [], rowCount: 0 } as { rows: T[]; rowCount: number }
        if (!text.includes('JOIN "sub_agent_tasks"')) return { rows: [stored], rowCount: 1 } as { rows: T[]; rowCount: number }
        const target = tasks.get(String(stored.taskId))
        const current = tasks.get(String(values[3]))
        const allowed = target && current && stored.turnId === values[4] && target.turnId === values[4]
          && target.rootTaskId === values[5] && (target.id === current.id || target.path.startsWith(`${current.path}/`))
        return { rows: allowed ? [stored] : [], rowCount: allowed ? 1 : 0 } as { rows: T[]; rowCount: number }
      }
      return { rows: [], rowCount: 0 } as { rows: T[]; rowCount: number }
    },
    release: () => undefined,
  }
  return { pool: { connect: async () => client }, queries, get stored() { return stored } }
}

const JOB_ID = "00000000-0000-4000-8000-000000000001"
const NESTED_ID = "00000000-0000-4000-8000-000000000002"

function largeSearchOutput() {
  return { jobs: [{ id: JOB_ID, title: "Engineer", description: `Contact private@example.com or +353 85 123 4567 ${"x".repeat(9_000)}`, metadata: { id: NESTED_ID } }], page: 1, hasMore: false }
}

function largeGetOutput() {
  return { job: { id: JOB_ID, title: "Engineer", contact: "private@example.com +353 85 123 4567", description: "x".repeat(9_000), company: { id: NESTED_ID } } }
}

function largeWaitOutput() {
  const taskId = "subagent-00000000-0000-4000-8000-000000000004"
  return {
    waitId: "wait-00000000-0000-4000-8000-000000000003", status: "ready", taskIds: [taskId], deadlineAt: "2099-01-01T00:00:00.000Z",
    matchedTaskIds: [taskId], tasks: [{ taskId, status: "completed", role: "analyst", result: { details: `private@example.com +353 85 123 4567 ${"x".repeat(9_000)}`, nested: { id: NESTED_ID } }, failureReason: null }],
  }
}

describe("tool result reference repository", () => {
  it("redacts and idempotently stores one fenced result per step and call", async () => {
    const fake = fakePool()
    const repository = createToolResultReferenceRepository(fake.pool as never)
    const first = await repository.put(rootOwner, { stepId: "step-1", toolCallId: "call-1", value: { answer: "safe", password: "secret" }, now })
    const second = await repository.put(rootOwner, { stepId: "step-1", toolCallId: "call-1", value: { answer: "safe", password: "different" }, now })

    expect(first.id).toBe(second.id)
    expect(first.sanitizedJson).toEqual({ answer: "[REDACTED]", password: "[REDACTED]" })
    expect(fake.queries.some(query => query.text.includes("set_config('app.user_id'"))).toBe(true)
    const sourceQuery = fake.queries.find(query => query.text.includes('FROM "agent_items" AS item'))
    expect(sourceQuery?.values).toEqual(["session-1", "turn-current", "root-current", "step-1", "call-1", "user-1"])
    expect(sourceQuery?.text).toContain('item."content"->>\'toolCallId\' = $5')
    await expect(repository.put(rootOwner, { stepId: "step-1", toolCallId: "call-1", value: "x".repeat(MAX_TOOL_RESULT_BYTES + 1), now }))
      .rejects.toMatchObject({ code: "tool_result_too_large" })
  })

  it("returns an exact generic-redacted legacy row for the same source call only", async () => {
    const input = { jobs: [{ id: JOB_ID, title: "Engineer", description: "Contact private@example.com", metadata: { id: NESTED_ID } }], page: 1, hasMore: false }
    const legacyJson = redactSensitiveValue(input)
    const historical: StoredRow = { ...row("tool-result-legacy", "root-current", legacyJson), toolCallId: "legacy-call" }
    const fake = fakePool({ historical, sourceToolNames: ["jobs.search"] })
    const repository = createToolResultReferenceRepository(fake.pool as never)

    const retried = await repository.put(rootOwner, { stepId: "step-1", toolCallId: "legacy-call", value: input, now })

    expect(retried.id).toBe(historical["id"])
    expect(retried.sanitizedJson).toEqual(legacyJson)
    expect(retried.sha256).toBe(historical["sha256"])
    expect(canonicalJson(legacyJson)).not.toContain(JOB_ID)
    await expect(repository.put(rootOwner, { stepId: "step-1", toolCallId: "legacy-call", value: { ...input, page: 2 }, now }))
      .rejects.toMatchObject({ code: "tool_result_conflict" })
  })

  it.each([{ sourceToolNames: [] as string[] }, { sourceToolNames: ["jobs.search", "jobs.get"] }])("requires one canonical tool_call source, got %j", async ({ sourceToolNames }) => {
    const fake = fakePool({ sourceToolNames })
    const repository = createToolResultReferenceRepository(fake.pool as never)
    await expect(repository.put(rootOwner, { stepId: "step-1", toolCallId: "unbound-call", value: { id: JOB_ID }, now }))
      .rejects.toMatchObject({ code: "tool_result_fence_rejected" })
    expect(fake.queries.some(query => query.text.includes('INSERT INTO "agent_tool_result_references"'))).toBe(false)
  })

  it.each([
    ["agent.wait", largeWaitOutput()],
    ["jobs.search", largeSearchOutput()],
    ["jobs.get", largeGetOutput()],
  ] as const)("source-sanitizes and reads every %s durable chunk to verified EOF", async (toolName, value) => {
    const fake = fakePool({ sourceToolNames: [toolName] })
    const repository = createToolResultReferenceRepository(fake.pool as never)
    const stored = await repository.put(rootOwner, { stepId: "step-1", toolCallId: `call-${toolName}`, value, now })
    const encoded = canonicalJson(stored.sanitizedJson)
    expect(stored.byteCount).toBeGreaterThan(8 * 1024)
    expect(stored.byteCount).toBe(Buffer.byteLength(encoded, "utf8"))
    expect(stored.sha256).toBe(createHash("sha256").update(encoded, "utf8").digest("hex"))

    const chunks: string[] = []
    let cursor: string | undefined
    let result: Awaited<ReturnType<typeof repository.read>> = null
    for (let index = 0; index < 10; index += 1) {
      result = await repository.read(rootOwner, { referenceId: stored.id, ...(cursor === undefined ? {} : { cursor }) }, `reader-${toolName}`)
      expect(result).not.toBeNull()
      expect(isVerifiedToolResultChunk(result, rootOwner, `reader-${toolName}`)).toBe(true)
      chunks.push(result!.chunk)
      if (result!.nextCursor === null) break
      cursor = result!.nextCursor
    }
    expect(result?.nextCursor).toBeNull()
    expect(chunks.join("")).toBe(encoded)
    expect(Buffer.byteLength(chunks.join(""), "utf8")).toBe(stored.byteCount)
    expect(createHash("sha256").update(chunks.join(""), "utf8").digest("hex")).toBe(stored.sha256)
    expect(isVerifiedToolResultChunk(result, { ...rootOwner, taskId: "other-root" }, `reader-${toolName}`)).toBe(false)

    const serialized = JSON.stringify(JSON.parse(chunks.join("")))
    expect(serialized).not.toContain("private@example.com")
    expect(serialized).not.toContain("+353 85 123 4567")
    expect(serialized).toContain("[REDACTED_PHONE]")
    if (toolName === "jobs.search" || toolName === "jobs.get") expect(serialized).toContain(JOB_ID)
    if (toolName === "agent.wait") expect(serialized).toContain("subagent-00000000-0000-4000-8000-000000000004")
    expect(serialized).not.toContain(NESTED_ID)
  })

  it.each(["aborted", "archived"])("rejects a %s session before any tool result write", async sessionStatus => {
    const fake = fakePool({ sessionStatus })
    const repository = createToolResultReferenceRepository(fake.pool as never)

    await expect(repository.put(rootOwner, { stepId: "step-1", toolCallId: "closed-call", value: { safe: true }, now }))
      .rejects.toMatchObject({ code: "tool_result_fence_rejected" })

    const sessionQuery = fake.queries.find(query => query.text.includes('FROM "agent_sessions"'))
    expect(sessionQuery?.text).toContain('"status" NOT IN (\'aborted\', \'archived\')')
    expect(sessionQuery?.text).toContain("FOR UPDATE")
    expect(sessionQuery?.values).toEqual(["session-1", "user-1"])
    expect(fake.queries.some(query => query.text.includes('FROM "sub_agent_tasks"'))).toBe(false)
    expect(fake.queries.some(query => query.text.includes('FROM "agent_steps"'))).toBe(false)
    expect(fake.queries.some(query => query.text.includes('INSERT INTO "agent_tool_result_references"'))).toBe(false)
    expect(fake.queries.some(query => query.text === "ROLLBACK")).toBe(true)
  })

  it("rejects a cross-user session before the write fence", async () => {
    const fake = fakePool({ sessionUserId: "user-2" })
    const repository = createToolResultReferenceRepository(fake.pool as never)

    await expect(repository.put(rootOwner, { stepId: "step-1", toolCallId: "foreign-session", value: { safe: true }, now }))
      .rejects.toMatchObject({ code: "tool_result_fence_rejected" })
    expect(fake.queries.some(query => query.text.includes('INSERT INTO "agent_tool_result_references"'))).toBe(false)
    expect(fake.queries.some(query => query.text.includes('FROM "sub_agent_tasks"'))).toBe(false)
  })

  it("rejects a changed payload for an already claimed identity", async () => {
    const fake = fakePool()
    const repository = createToolResultReferenceRepository(fake.pool as never)
    await repository.put(rootOwner, { stepId: "step-1", toolCallId: "call-1", value: { result: "first" }, now })
    fake.stored!.sha256 = "0".repeat(64)
    await expect(repository.put(rootOwner, { stepId: "step-1", toolCallId: "call-1", value: { result: "second" }, now }))
      .rejects.toBeInstanceOf(ToolResultRepositoryError)
  })

  it("allows a current root owner to read an earlier turn in the same session", async () => {
    const value = { z: 1, a: "previous" }
    const fake = fakePool({ historical: { ...row("ref-old", "root-old", value), turnId: "turn-old", stepId: "step-old", toolCallId: "call-old" } })
    const repository = createToolResultReferenceRepository(fake.pool as never)
    const result = await repository.read(rootOwner, { referenceId: "ref-old" })
    expect(result).toMatchObject({ ref: "ref-old", chunk: canonicalJson(value), nextCursor: null })
    expect(fake.queries.some(query => query.text.includes('ref."sessionId" = $3'))).toBe(true)
    const sourceQuery = fake.queries.find(query => query.text.includes('FROM "agent_items" AS item'))
    expect(sourceQuery?.values).toEqual(["session-1", "turn-old", "root-old", "step-old", "call-old", "user-1"])
  })

  it("keeps the root history read tenant-scoped and trusts the database lease clock", async () => {
    const staleOwner = { ...rootOwner, lease: { ...turn, leaseExpiresAt: new Date("2020-01-01T00:00:00.000Z") } }
    const fake = fakePool({ historical: { ...row("ref-user", "root-old", { safe: true }), userId: "user-2" } })
    const repository = createToolResultReferenceRepository(fake.pool as never)
    expect(await repository.read(staleOwner, { referenceId: "ref-user" })).toBeNull()
    const fenceQuery = fake.queries.find(query => query.text.includes('FROM "sub_agent_tasks" root'))
    expect(fenceQuery?.text).toContain('leaseExpiresAt" > CURRENT_TIMESTAMP')
    expect(fenceQuery?.text).not.toContain('leaseExpiresAt" > $7')
  })

  it("keeps read chunks UTF-8 safe and within the wrapper limit", async () => {
    const value = { summary: "😊".repeat(5000) }
    const fake = fakePool({ historical: { ...row("ref-large", "root-old", value), sha256: "" } })
    const encoded = canonicalJson(value)
    fake.stored!.sha256 = createHash("sha256").update(encoded).digest("hex")
    const repository = createToolResultReferenceRepository(fake.pool as never)
    const result = await repository.read(rootOwner, { referenceId: "ref-large" })
    expect(result).not.toBeNull()
    expect(Buffer.byteLength(JSON.stringify(result), "utf8")).toBeLessThanOrEqual(4096)
    expect(result!.chunk.endsWith("�")).toBe(false)
    expect(result!.nextCursor).not.toBeNull()
  })

  it("accepts a near-limit array of many keyed objects under the canonical bound", async () => {
    const value = { entries: Array.from({ length: 1_200 }, (_, index) => ({ [`key_${index}`]: "x".repeat(800) })) }
    const encoded = canonicalJson(value)
    expect(Buffer.byteLength(encoded, "utf8")).toBeGreaterThan(900_000)
    expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_BYTES)
    const fake = fakePool()
    const repository = createToolResultReferenceRepository(fake.pool as never)
    await expect(repository.put(rootOwner, { stepId: "step-1", toolCallId: "near-limit", value, now })).resolves.toMatchObject({ byteCount: Buffer.byteLength(encoded, "utf8") })
  })

  it("allows a child to read its own and descendant results while denying siblings, ancestors, and old turns", async () => {
    const child: SubagentLease = {
      id: "child-current", userId: "user-1", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current", parentTaskId: "root-current",
      path: "/root-current/child-current", depth: 1, role: "reader", taskType: "read", status: "running", goal: "read", constraints: [],
      successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 1,
      maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"), interruptRequestedAt: null,
      budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
    }
    const tasks = [
      { id: "root-current", rootTaskId: "root-current", turnId: "turn-current", sessionId: "session-1", path: "/root-current" },
      { id: "child-current", rootTaskId: "root-current", turnId: "turn-current", sessionId: "session-1", path: "/root-current/child-current" },
      { id: "descendant", rootTaskId: "root-current", turnId: "turn-current", sessionId: "session-1", path: "/root-current/child-current/descendant" },
      { id: "sibling", rootTaskId: "root-current", turnId: "turn-current", sessionId: "session-1", path: "/root-current/sibling" },
      { id: "old-descendant", rootTaskId: "root-current", turnId: "turn-old", sessionId: "session-1", path: "/root-current/child-current/old-descendant" },
    ]
    const owner = { kind: "task" as const, lease: child }
    for (const [referenceId, taskId, expected] of [["ref-own", "child-current", true], ["ref-descendant", "descendant", true], ["ref-sibling", "sibling", false], ["ref-ancestor", "root-current", false], ["ref-old", "old-descendant", false]] as const) {
      const fake = fakePool({ childRootTurnStatus: "waiting_for_dependency", historical: { ...row(referenceId, taskId, { summary: taskId }), turnId: taskId === "old-descendant" ? "turn-old" : "turn-current" }, tasks })
      const repository = createToolResultReferenceRepository(fake.pool as never)
      const result = await repository.read(owner, { referenceId })
      if (expected) expect(result).toMatchObject({ ref: referenceId })
      else expect(result).toBeNull()
    }
  })

  it("binds writes to the exact task step and attempt", async () => {
    const child: SubagentLease = {
      id: "child-current", userId: "user-1", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current", parentTaskId: "root-current",
      path: "/root-current/child-current", depth: 1, role: "reader", taskType: "read", status: "running", goal: "read", constraints: [],
      successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 2,
      maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"), interruptRequestedAt: null,
      budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
    }
    const fake = fakePool({ stepTaskId: "other-task", stepAttempt: 1 })
    const repository = createToolResultReferenceRepository(fake.pool as never)
    await expect(repository.put({ kind: "task", lease: child }, { stepId: "step-1", toolCallId: "call-1", value: { ok: true }, now }))
      .rejects.toMatchObject({ code: "tool_result_fence_rejected" })
    const stepQuery = fake.queries.find(query => query.text.includes('FROM "agent_steps"'))
    expect(stepQuery?.values).toEqual(["step-1", "session-1", "turn-current", "child-current", 2])
  })

  it("allows child read and write while the parent turn is queued for wakeup", async () => {
    const child: SubagentLease = {
      id: "child-current", userId: "user-1", sessionId: "session-1", turnId: "turn-current", rootTaskId: "root-current", parentTaskId: "root-current",
      path: "/root-current/child-current", depth: 1, role: "reader", taskType: "read", status: "running", goal: "read", constraints: [],
      successCriteria: [], allowedActions: [], context: {}, expectedOutputSchema: {}, result: null, failureReason: null, attemptCount: 1,
      maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date("2099-01-01T00:00:00.000Z"), interruptRequestedAt: null,
      budgetSnapshot: {}, toolPolicySnapshot: {}, ownerId: "worker-1", signal: new AbortController().signal,
    }
    const fake = fakePool({
      childRootTurnStatus: "queued", stepTaskId: "child-current",
      historical: row("ref-queued", "child-current", { queued: true }),
      tasks: [
        { id: "root-current", rootTaskId: "root-current", turnId: "turn-current", sessionId: "session-1", path: "/root-current" },
        { id: "child-current", rootTaskId: "root-current", turnId: "turn-current", sessionId: "session-1", path: "/root-current/child-current" },
      ],
    })
    const repository = createToolResultReferenceRepository(fake.pool as never)
    const owner = { kind: "task" as const, lease: child }
    await expect(repository.put(owner, { stepId: "step-1", toolCallId: "call-1", value: { queued: true }, now })).resolves.toMatchObject({ taskId: "child-current" })
    await expect(repository.read(owner, { referenceId: "ref-queued" })).resolves.toMatchObject({ ref: "ref-queued" })
    const childFenceQueries = fake.queries.filter(query => query.text.includes('FROM "sub_agent_tasks" task'))
    expect(childFenceQueries.every(query => query.text.includes("'queued'"))).toBe(true)
  })

  it("rejects a cursor inside a UTF-8 code point and returns an explicit EOF chunk", async () => {
    const value = { summary: "😊".repeat(2_000) }
    const fake = fakePool({ historical: { ...row("ref-utf8", "root-old", value), sha256: "" } })
    fake.stored!.sha256 = createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")
    const repository = createToolResultReferenceRepository(fake.pool as never)
    await expect(repository.read(rootOwner, { referenceId: "ref-utf8", cursor: "13" })).rejects.toMatchObject({ code: "tool_result_cursor_invalid" })
    const end = String(Buffer.byteLength(canonicalJson(value), "utf8"))
    await expect(repository.read(rootOwner, { referenceId: "ref-utf8", cursor: end })).resolves.toMatchObject({ chunk: "", nextCursor: null })
  })
})
