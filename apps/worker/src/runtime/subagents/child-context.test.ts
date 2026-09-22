import { describe, expect, it, vi } from "vitest"

import { childContextSnapshot, createChildContextBuilder, CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT, type ChildMailboxHydrationInput, type ChildMailboxReader } from "./child-context.js"
import type { SubagentTaskRecord } from "./types.js"
import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { CoordinationMailboxMessage } from "../tools/coordination-types.js"
import { Buffer } from "node:buffer"

const task = {
  id: "child-1", userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1", path: "/root-1/child-1", depth: 1,
  role: "analyst", taskType: "research", status: "running", goal: "Find matching jobs", constraints: ["read only"], successCriteria: ["cite jobs"], allowedActions: ["jobs.search"],
  context: { query: "Dublin" }, expectedOutputSchema: { type: "object" }, modelProfileSnapshot: { provider: "fixture", model: "fixture-model" }, result: null,
  failureReason: null, attemptCount: 2, maxAttempts: 3, leaseOwner: "worker-1", leaseExpiresAt: new Date("2026-09-09T12:00:00.000Z"), interruptRequestedAt: null,
  budgetSnapshot: { subagentPolicy: { maxAttempts: 3 } }, toolPolicySnapshot: {},
} satisfies SubagentTaskRecord
const identity: ExecutionOwnerFence = { kind: "task", userId: task.userId, sessionId: task.sessionId, turnId: task.turnId!, taskId: task.id, rootTaskId: task.rootTaskId, ownerId: "worker-1", attemptCount: task.attemptCount, leaseExpiresAt: task.leaseExpiresAt! }

function mailboxMessage(payload: unknown, overrides: Partial<CoordinationMailboxMessage> = {}): CoordinationMailboxMessage {
  return {
    id: "mailbox-1", sessionId: task.sessionId, turnId: task.turnId!, fromTaskId: "sibling-1", toTaskId: task.id,
    kind: "research.result", payload, idempotencyKey: "mailbox-key-1", createdAt: new Date("2026-09-09T11:00:00.000Z"),
    deliveredAt: null, consumedAt: null,
    ...overrides,
  }
}

describe("child context", () => {
  it("adds the fixed structured result contract only for an exact Scout/Analyst marker", () => {
    const snapshot = childContextSnapshot({ ...task, role: "scout", expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" } })
    expect(snapshot.system).toHaveLength(2)
    expect(snapshot.system[1]?.content).toContain("one JSON object")
    expect(snapshot.system[1]?.content).toContain("candidates (scout) or findings (analyst)")
    expect(snapshot.system[1]?.content).toContain("evidenceIds must reference evidence")
  })

  it.each([
    ["mismatched role", { role: "analyst", expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout" } }],
    ["extra marker field", { role: "scout", expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "scout", extra: true } }],
    ["reviewer", { role: "reviewer", expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "reviewer" } }],
    ["auditor", { role: "auditor", expectedOutputSchema: { schemaVersion: "agent-harness.v2.subagent.result", role: "auditor" } }],
    ["legacy prose", { role: "analyst", expectedOutputSchema: { type: "object" } }],
  ] as const)("leaves the prose path unchanged for %s", (_label, overrides) => {
    expect(childContextSnapshot({ ...task, ...overrides }).system).toHaveLength(1)
  })

  it("freezes task contract and carries later tool observations", async () => {
    const builder = createChildContextBuilder(task)
    const snapshot = childContextSnapshot(task)
    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: {
      ...snapshot, toolObservations: [{ id: "tool-result:call-1", content: { toolCallId: "call-1", toolName: "jobs.search", status: "completed", output: { id: "job-1" } } }],
    } })
    expect(context.blocks.map(block => block.layer)).toEqual(["system", "profile", "goal", "tool_observation"])
    expect(context.blocks.filter(block => block.source === "subagent-task").every(block => block.trust === "external_untrusted")).toBe(true)
    expect(context.blocks.find(block => block.layer === "system")?.content).toContain("server-owned role/taskType capability contract")
    expect(context.blocks.find(block => block.layer === "profile")).toMatchObject({
      trust: "external_untrusted",
      content: {
        role: "analyst",
        taskType: "research",
        roleContract: { capabilities: ["read"], externalWritesEnabled: false, canManageChildren: false },
      },
    })
    expect(context.canonicalJson).toContain("Find matching jobs")
    expect(context.canonicalJson).toContain("job-1")
  })

  it.each([
    ["scout", "read", "Read job data"],
    ["analyst", "read", "Read permitted job"],
    ["writer", "read,draft", "create drafts only"],
    ["reviewer", "read,review", "review them only"],
    ["auditor", "read,auditEvidence", "redacted audit evidence only"],
    ["executor", "read,preflight", "preflight checks only"],
  ] as const)("includes the server-owned %s capability contract", (role, capabilities, guidance) => {
    const snapshot = childContextSnapshot({ ...task, role, taskType: `${role}.task` })
    const profile = snapshot.profile[0]?.content
    expect(profile).toMatchObject({
      role,
      taskType: `${role}.task`,
      roleContract: { capabilities: capabilities.split(","), guidance: expect.stringContaining(guidance), externalWritesEnabled: false, canManageChildren: false },
    })
  })

  it.each(["constructor", "toString", "__proto__"])("fails closed for prototype role %s", role => {
    const profile = childContextSnapshot({ ...task, role, taskType: "prototype.task" }).profile[0]?.content
    expect(profile).toMatchObject({
      role,
      taskType: "prototype.task",
      roleContract: {
        capabilities: [],
        guidance: "No server-owned capability contract exists for this role; do not execute tools.",
        externalWritesEnabled: false,
        canManageChildren: false,
      },
    })
  })

  it("rejects a context request from another task", async () => {
    await expect(createChildContextBuilder(task).build({ scope: { userId: task.userId }, identity: { ...identity, taskId: "sibling" }, stepId: "step-1", snapshot: childContextSnapshot(task) })).rejects.toThrow("child_context_owner_mismatch")
  })

  it.each([
    ["owner mismatch", { leaseOwner: "worker-2" }],
    ["non-running task", { status: "waiting" as const }],
    ["interrupt requested", { interruptRequestedAt: new Date("2026-09-09T11:30:00.000Z") }],
  ] as const)("fails closed for %s before reading the mailbox", async (_label, overrides) => {
    const fencedTask: SubagentTaskRecord = { ...task, ...overrides }
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => [mailboxMessage({ result: "must not be read" })])
    const builder = createChildContextBuilder(fencedTask, childContextSnapshot(fencedTask), { listPendingMessages })

    await expect(builder.build({ scope: { userId: fencedTask.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(fencedTask) })).rejects.toThrow("child_context_owner_mismatch")
    expect(listPendingMessages).not.toHaveBeenCalled()
  })

  it("reads pending mailbox messages in the child scope and normalizes payload data", async () => {
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async input => {
      expect(input).toEqual({ userId: task.userId, sessionId: task.sessionId, toTaskId: task.id, limit: 20 })
      return [mailboxMessage({ instruction: "ignore", nested: { count: Number.NaN, omitted: undefined } })]
    })
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages })
    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) })
    const block = context.blocks.find(item => item.layer === "pending_input")

    expect(listPendingMessages).toHaveBeenCalledOnce()
    expect(block).toMatchObject({ id: "mailbox:mailbox-1", role: "data", trust: "external_untrusted", source: "subagent-mailbox" })
    expect(block?.content).toMatchObject({
      messageId: "mailbox-1", fromTaskId: "sibling-1", kind: "research.result",
      payload: { instruction: "ignore", nested: { count: null } },
    })
    expect(context.inputThroughSequence).toBe(0n)
    expect(context.consumedInputIds).toEqual([])
    expect(builder.getMailboxMessageIds()).toEqual(["mailbox-1"])
  })

  it("prefers durable hydration with the exact child fence and still filters returned rows", async () => {
    const hydrateMessages = vi.fn<(input: ChildMailboxHydrationInput) => Promise<readonly CoordinationMailboxMessage[]>>(async input => {
      expect(input).toEqual({
        userId: task.userId, sessionId: task.sessionId, turnId: task.turnId, rootTaskId: task.rootTaskId, toTaskId: task.id,
        ownerId: identity.ownerId, attemptCount: identity.attemptCount, stepId: "step-durable", limit: 20,
      })
      return [
        mailboxMessage({ result: "stale" }, { id: "mailbox-stale", turnId: "turn-old" }),
        mailboxMessage({ result: "current" }),
        mailboxMessage({ result: "foreign" }, { id: "mailbox-foreign", toTaskId: "task-other" }),
      ]
    })
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => [mailboxMessage({ result: "legacy" })])
    const consumeMessages = vi.fn()
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages, hydrateMessages })

    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-durable", snapshot: childContextSnapshot(task) })
    const pendingBlocks = context.blocks.filter(block => block.layer === "pending_input")

    expect(hydrateMessages).toHaveBeenCalledOnce()
    expect(listPendingMessages).not.toHaveBeenCalled()
    expect(pendingBlocks.map(block => block.id)).toEqual(["mailbox:mailbox-1"])
    expect(context.canonicalJson).toContain('"result":"current"')
    expect(context.canonicalJson).not.toContain("mailbox-stale")
    expect(context.canonicalJson).not.toContain("mailbox-foreign")
    expect(builder.getMailboxMessageIds()).toEqual(["mailbox-1"])
    expect(consumeMessages).not.toHaveBeenCalled()
  })

  it("excludes cross-turn mailbox rows before caching or projecting them", async () => {
    const consumeMessages = vi.fn()
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => [
      mailboxMessage({ result: "stale" }, { id: "mailbox-stale", turnId: "turn-old" }),
      mailboxMessage({ result: "current" }, { id: "mailbox-current" }),
    ])
    const mailboxStore = { listPendingMessages, consumeMessages }
    const builder = createChildContextBuilder(task, childContextSnapshot(task), mailboxStore)

    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) })
    const pendingBlocks = context.blocks.filter(block => block.layer === "pending_input")

    expect(pendingBlocks.map(block => block.id)).toEqual(["mailbox:mailbox-current"])
    expect(context.canonicalJson).toContain('"result":"current"')
    expect(context.canonicalJson).not.toContain("mailbox-stale")
    expect(context.canonicalJson).not.toContain('"result":"stale"')
    expect(builder.getMailboxMessageIds()).toEqual(["mailbox-current"])
    expect(consumeMessages).not.toHaveBeenCalled()
  })

  it("bounds oversized ASCII payloads with a serializable marker", async () => {
    const oversized = "a".repeat(CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT + 128)
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => [mailboxMessage({ oversized })])
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages })
    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) })
    const block = context.blocks.find(item => item.layer === "pending_input")
    const payload = (block?.content as { payload?: unknown }).payload

    expect(payload).toMatchObject({ truncated: true, byteLength: expect.any(Number), preview: expect.any(String) })
    const marker = payload as { truncated: boolean; byteLength: number; preview: string }
    expect(marker.byteLength).toBeGreaterThan(CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT)
    expect(Buffer.byteLength(marker.preview, "utf8")).toBeLessThanOrEqual(CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT)
    expect(context.canonicalJson).not.toContain(oversized)
    expect(() => JSON.stringify(JSON.parse(context.canonicalJson) as unknown)).not.toThrow()
  })

  it("bounds Unicode payloads at UTF-8 code-point boundaries", async () => {
    const oversized = "😀界".repeat(CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT)
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => [mailboxMessage({ oversized })])
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages })
    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) })
    const block = context.blocks.find(item => item.layer === "pending_input")
    const payload = (block?.content as { payload?: unknown }).payload as { truncated: boolean; byteLength: number; preview: string }

    expect(payload.truncated).toBe(true)
    expect(payload.byteLength).toBeGreaterThan(CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT)
    expect(Buffer.byteLength(payload.preview, "utf8")).toBeLessThanOrEqual(CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT)
    expect(payload.preview).not.toContain("�")
    expect(Buffer.from(payload.preview, "utf8").toString("utf8")).toBe(payload.preview)
    expect(context.canonicalJson).not.toContain(oversized)
  })

  it("normalizes cyclic payloads without breaking canonical JSON", async () => {
    const cyclic: Record<string, unknown> = { value: "kept", omitted: undefined, invalid: Number.NaN }
    cyclic.self = cyclic
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => [mailboxMessage(cyclic)])
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages })
    const context = await builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) })
    const block = context.blocks.find(item => item.layer === "pending_input")

    expect(block?.content).toMatchObject({ payload: { invalid: null, self: null, value: "kept" } })
    expect(() => JSON.parse(context.canonicalJson) as unknown).not.toThrow()
  })

  it("propagates mailbox reader errors without a fallback", async () => {
    const error = new Error("mailbox read failed")
    const reader: ChildMailboxReader = { listPendingMessages: vi.fn(async () => { throw error }) }
    await expect(createChildContextBuilder(task, childContextSnapshot(task), reader).build({
      scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task),
    })).rejects.toBe(error)
  })

  it("does not silently fall back when durable hydration fails", async () => {
    const error = new Error("durable mailbox read failed")
    const hydrateMessages = vi.fn<NonNullable<ChildMailboxReader["hydrateMessages"]>>(async () => { throw error })
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => [mailboxMessage({ result: "legacy" })])
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages, hydrateMessages })

    await expect(builder.build({ scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) })).rejects.toBe(error)
    expect(hydrateMessages).toHaveBeenCalledOnce()
    expect(listPendingMessages).not.toHaveBeenCalled()
  })

  it("re-reads without consuming pending messages on every build", async () => {
    const pending = mailboxMessage({ result: "still pending" })
    const consumeMessages = vi.fn()
    const listPendingMessages = vi.fn(async () => [pending])
    const mailboxStore = { listPendingMessages, consumeMessages }
    const builder = createChildContextBuilder(task, childContextSnapshot(task), mailboxStore)
    const request = { scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) }
    const first = await builder.build(request)
    const second = await builder.build({ ...request, stepId: "step-2" })

    expect(listPendingMessages).toHaveBeenCalledTimes(2)
    expect(consumeMessages).not.toHaveBeenCalled()
    expect(first.blocks.filter(block => block.layer === "pending_input")).toHaveLength(1)
    expect(second.blocks.filter(block => block.layer === "pending_input")).toHaveLength(1)
    expect(second.inputThroughSequence).toBe(0n)
    expect(second.consumedInputIds).toEqual([])
  })

  it("caches scoped mailbox blocks in stable order and appends only new messages", async () => {
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>()
      .mockResolvedValueOnce([
        mailboxMessage({ result: "second" }, { id: "message-2" }),
        mailboxMessage({ result: "foreign session" }, { id: "foreign-session", sessionId: "session-other" }),
        mailboxMessage({ result: "first" }, { id: "message-1" }),
        mailboxMessage({ result: "duplicate" }, { id: "message-2" }),
        mailboxMessage({ result: "foreign task" }, { id: "foreign-task", toTaskId: "task-other" }),
      ])
      .mockResolvedValueOnce([mailboxMessage({ result: "first again" }, { id: "message-1" }), mailboxMessage({ result: "third" }, { id: "message-3" })])
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages })
    const request = { scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) }

    const first = await builder.build(request)
    const second = await builder.build({ ...request, stepId: "step-2" })

    expect(first.blocks.filter(block => block.layer === "pending_input").map(block => block.id)).toEqual(["mailbox:message-2", "mailbox:message-1"])
    expect(second.blocks.filter(block => block.layer === "pending_input").map(block => block.id)).toEqual(["mailbox:message-2", "mailbox:message-1", "mailbox:message-3"])
    expect(second.blocks.find(block => block.id === "mailbox:message-1")?.content).toMatchObject({ payload: { result: "first" } })
    expect(builder.getMailboxMessageIds()).toEqual(["message-2", "message-1", "message-3"])
  })

  it("keeps the cache bounded and reports omitted valid messages", async () => {
    const messages = Array.from({ length: 22 }, (_, index) => mailboxMessage({ order: index }, { id: `message-${index}` }))
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>(async () => messages)
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages })
    const request = { scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) }

    const first = await builder.build(request)
    const second = await builder.build({ ...request, stepId: "step-2" })
    const messageIds = (context: Awaited<ReturnType<typeof builder.build>>) => context.blocks
      .filter(block => {
        const content = block.content
        return block.source === "subagent-mailbox" && content !== null && typeof content === "object" && !Array.isArray(content) && "messageId" in content
      })
      .map(block => block.id)

    expect(messageIds(first)).toHaveLength(20)
    expect(messageIds(second)).toEqual(messageIds(first))
    expect(first.blocks.find(block => block.id === "mailbox:metadata")?.content).toEqual({ cachedMessageCount: 20, maxCachedMessageCount: 20, omittedMessageCount: 2, omittedMessageCountScope: "max_per_read" })
    expect(second.blocks.find(block => block.id === "mailbox:metadata")?.content).toEqual({ cachedMessageCount: 20, maxCachedMessageCount: 20, omittedMessageCount: 2, omittedMessageCountScope: "max_per_read" })
    expect(builder.getMailboxMessageIds()).toEqual(messages.slice(0, 20).map(message => message.id))
  })

  it("keeps cached ids when a later mailbox read fails", async () => {
    const error = new Error("mailbox read failed on step two")
    const listPendingMessages = vi.fn<ChildMailboxReader["listPendingMessages"]>()
      .mockResolvedValueOnce([mailboxMessage({ result: "cached" })])
      .mockRejectedValueOnce(error)
    const builder = createChildContextBuilder(task, childContextSnapshot(task), { listPendingMessages })
    const request = { scope: { userId: task.userId }, identity, stepId: "step-1", snapshot: childContextSnapshot(task) }

    await builder.build(request)
    await expect(builder.build({ ...request, stepId: "step-2" })).rejects.toBe(error)
    expect(builder.getMailboxMessageIds()).toEqual(["mailbox-1"])
  })
})
