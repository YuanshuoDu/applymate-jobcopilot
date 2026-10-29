import { afterEach, describe, expect, it, vi } from "vitest"

import {
  classifyPublicItemType,
  openPublicTimelineCursor,
  preservePublicToolCallId,
  projectPublicEventEnvelope,
  publicAgentEventId,
  publicIdempotencyKey,
  publicToolCallId,
  publicToolItemId,
  readPublicItemTypes,
  sealPublicTimelineCursor,
} from "./public-tool-identity"
import type { PrismaClient } from "@prisma/client"

afterEach(() => vi.unstubAllEnvs())

describe("public tool identity projection", () => {
  it("classifies only known ordinary item types as safe to preserve", () => {
    for (const type of [
      "agent_message", "user_message", "plan", "reasoning_summary", "subagent_activity",
      "approval_request", "approval_response", "question", "artifact", "context_compaction", "error", "task_graph",
    ]) expect(classifyPublicItemType(type)).toBeNull()
    expect(classifyPublicItemType("tool_call")).toBe("tool_call")
    expect(classifyPublicItemType("tool_result")).toBe("tool_result")
    expect(classifyPublicItemType(undefined)).toBe("unknown")
    expect(classifyPublicItemType("future_private_item")).toBe("unknown")
  })

  it("derives stable, distinct, session-scoped aliases from a keyed secret", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret-a")
    const providerId = "+353 87 123 4567"
    const callAlias = publicToolCallId("session-a", "turn-a", providerId)
    const itemAlias = publicToolItemId("session-a", "turn-a", "item:" + providerId)
    const eventAlias = publicAgentEventId("session-a", "event:" + providerId)
    const idempotencyAlias = publicIdempotencyKey("session-a", "started:" + providerId)

    expect(callAlias).toMatch(/^tc_[a-f0-9]{64}$/)
    expect(publicToolCallId("session-a", "turn-a", providerId)).toBe(callAlias)
    expect(publicToolCallId("session-a", "turn-a", "+353 87 123 4568")).not.toBe(callAlias)
    expect(publicToolCallId("session-b", "turn-a", providerId)).not.toBe(callAlias)
    expect(publicToolCallId("session-a", "turn-b", providerId)).not.toBe(callAlias)
    expect(publicToolItemId("session-a", "turn-a", "item:" + providerId)).toBe(itemAlias)
    expect(publicAgentEventId("session-a", "event:" + providerId)).toBe(eventAlias)
    expect(publicIdempotencyKey("session-a", "started:" + providerId)).toBe(idempotencyAlias)
    expect(new Set([callAlias, itemAlias, eventAlias, idempotencyAlias]).size).toBe(4)
    expect(JSON.stringify([callAlias, itemAlias, eventAlias, idempotencyAlias])).not.toContain(providerId)
    expect(publicIdempotencyKey("session-a", null)).toBeNull()

    vi.stubEnv("AUTH_SECRET", "test-secret-b")
    expect(publicToolCallId("session-a", "turn-a", providerId)).not.toBe(callAlias)
  })

  it("keeps event and causation aliases aligned and maps tool item and call fields consistently", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret")
    const providerId = "candidate@example.test"
    const rawItemId = "turn:turn-a:item:tool-call:" + providerId + ":attempt-1"
    const rawEventId = "turn:turn-a:event:item-started:" + rawItemId
    const projected = projectPublicEventEnvelope({
      id: "turn:turn-a:event:tool-started:" + providerId,
      sessionId: "session-a",
      turnId: "turn-a",
      itemId: rawItemId,
      type: "tool_call.started",
      correlationId: providerId,
      causationId: rawEventId,
      idempotencyKey: "tool-started:" + providerId,
      payload: { toolCallId: providerId, itemId: rawItemId, toolName: "agent.ask_user" },
    }, "tool_call")

    expect(projected.id).toBe(publicAgentEventId("session-a", "turn:turn-a:event:tool-started:" + providerId))
    expect(projected.causationId).toBe(publicAgentEventId("session-a", rawEventId))
    expect(projected.itemId).toBe(publicToolItemId("session-a", "turn-a", rawItemId))
    expect(projected.correlationId).toBe(publicToolCallId("session-a", "turn-a", providerId))
    expect(projected.idempotencyKey).not.toContain(providerId)
    expect(projected.payload).toEqual({
      toolCallId: publicToolCallId("session-a", "turn-a", providerId),
      itemId: publicToolItemId("session-a", "turn-a", rawItemId),
      toolName: "agent.ask_user",
    })
    expect(JSON.stringify(projected)).not.toContain(providerId)
  })

  it("aliases a validated nested tool item identity in transient snapshots", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret")
    const providerId = "opaque-provider-call-1"
    const rawItemId = "turn:turn-a:item:tool-call:" + providerId
    const projected = projectPublicEventEnvelope({
      id: "delta-1", sessionId: "session-a", turnId: "turn-a", itemId: rawItemId,
      type: "item.snapshot", correlationId: "turn-a", causationId: null, idempotencyKey: null,
      payload: { item: {
        schemaVersion: "agent-harness.v2", id: rawItemId, sessionId: "session-a", turnId: "turn-a",
        type: "tool_call", status: "started", revision: 1, content: { toolCallId: providerId },
      } },
    }, "tool_call")
    expect(projected.payload).toMatchObject({ item: {
      id: publicToolItemId("session-a", "turn-a", rawItemId),
      content: { toolCallId: publicToolCallId("session-a", "turn-a", providerId) },
    } })
    expect(JSON.stringify(projected)).not.toContain(providerId)
  })

  it("redacts an invalid nested tool snapshot instead of leaking its item ID", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret")
    const providerId = "private-call-id"
    const rawItemId = "turn:turn-a:item:tool-call:" + providerId
    const projected = projectPublicEventEnvelope({
      id: "delta-2", sessionId: "session-a", turnId: "turn-a", itemId: rawItemId,
      type: "item.snapshot", correlationId: rawItemId, causationId: null, idempotencyKey: null,
      payload: { item: {
        schemaVersion: "agent-harness.v2", id: rawItemId, sessionId: "foreign-session", turnId: "turn-a",
        type: "tool_call", status: "started", revision: 1, content: { toolCallId: providerId },
      } },
    }, "tool_call")
    expect(projected.payload).toEqual({ item: "[REDACTED]" })
    expect(JSON.stringify(projected)).not.toContain(providerId)
  })

  it("restores only the projected call alias after generic content redaction", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret")
    const providerId = "candidate@example.test"
    const rawItemId = "turn:turn-a:item:tool-call:" + providerId
    const projected = projectPublicEventEnvelope({
      id: "delta-3", sessionId: "session-a", turnId: "turn-a", itemId: rawItemId,
      type: "item.snapshot", correlationId: rawItemId, causationId: null, idempotencyKey: null,
      payload: { item: {
        schemaVersion: "agent-harness.v2", id: rawItemId, sessionId: "session-a", turnId: "turn-a",
        type: "tool_call", status: "started", revision: 1, content: { toolCallId: providerId, input: { secret: "private" } },
      } },
    }, "tool_call")
    const projectedPayload = projected.payload as { item: { id: string; type: string; content: unknown } }
    const redactedPayload = { item: { ...projectedPayload.item, content: "[REDACTED]" } }
    const restored = preservePublicToolCallId(redactedPayload, projectedPayload, "tool_call")
    expect(restored).toEqual({ item: {
      ...projectedPayload.item, content: { toolCallId: publicToolCallId("session-a", "turn-a", providerId) },
    } })
    expect(JSON.stringify(restored)).not.toContain(providerId)
    expect(JSON.stringify(restored)).not.toContain("private")
    expect(preservePublicToolCallId({ content: "[REDACTED]" }, { content: { toolCallId: providerId } }, "tool_call"))
      .toEqual({ content: "[REDACTED]" })
  })

  it("fails closed when an item identity cannot be classified", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret")
    const rawItemId = "turn:turn-a:item:tool-call:private-call-id"
    const projected = projectPublicEventEnvelope({
      id: "event-unknown", sessionId: "session-a", turnId: "turn-a", itemId: rawItemId,
      type: "item.failed", correlationId: rawItemId, causationId: "cause-private-call-id",
      idempotencyKey: "failed:private-call-id", payload: { errorCode: "failed", toolCallId: "private-call-id" },
    }, "unknown")
    expect(projected.itemId).toBeNull()
    expect(projected.correlationId).not.toContain("private-call-id")
    expect(projected.payload).toBeNull()
    expect(JSON.stringify(projected)).not.toContain("private-call-id")
  })

  it("leaves non-tool item identity and unrelated correlation intact", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret")
    const event = {
      id: "event-1", sessionId: "session-a", turnId: "turn-a", itemId: "final-item",
      type: "item.started", correlationId: "step-1", causationId: null, idempotencyKey: null,
      payload: { itemId: "final-item", type: "agent_message" },
    }
    const projected = projectPublicEventEnvelope(event)
    expect(projected.itemId).toBe("final-item")
    expect(projected.correlationId).toBe("step-1")
    expect(projected.payload).toEqual(event.payload)
    expect(projected.id).toBe(publicAgentEventId("session-a", "event-1"))
  })

  it("seals timeline cursors with session-bound authenticated encryption", () => {
    vi.stubEnv("AUTH_SECRET", "test-secret")
    const rawId = "+353 87 123 4567"
    const cursor = Buffer.from(JSON.stringify({
      collection: "timeline", sessionId: "session-a", createdAt: "2026-10-29T00:00:00.000Z", id: "item:" + rawId,
    }), "utf8").toString("base64url")
    const sealed = sealPublicTimelineCursor("session-a", cursor)
    expect(sealed.startsWith("ptc1.")).toBe(true)
    expect(sealed).not.toContain(cursor)
    expect(sealed).not.toContain(rawId)
    expect(openPublicTimelineCursor("session-a", sealed)).toBe(cursor)
    expect(sealPublicTimelineCursor("session-a", cursor)).not.toBe(sealed)
    expect(openPublicTimelineCursor("session-b", sealed)).toBeNull()

    const last = sealed.at(-1)
    const tampered = sealed.slice(0, -1) + (last === "A" ? "B" : "A")
    expect(openPublicTimelineCursor("session-a", tampered)).toBeNull()
    expect(openPublicTimelineCursor("session-a", "not-a-sealed-legacy-cursor")).toBe("not-a-sealed-legacy-cursor")

    vi.stubEnv("AUTH_SECRET", "rotated-secret")
    expect(openPublicTimelineCursor("session-a", sealed)).toBeNull()
  })

  it("reads only bounded item type rows and distinguishes lookup failure from missing rows", async () => {
    const findMany = vi.fn().mockResolvedValue([{ id: "item-1", type: "tool_call" }])
    const db = { agentItem: { findMany } } as unknown as Pick<PrismaClient, "agentItem">
    await expect(readPublicItemTypes(db, "session-a", ["item-1", "item-1"])).resolves.toEqual(new Map([ ["item-1", "tool_call"] ]))
    expect(findMany).toHaveBeenCalledWith({
      where: { sessionId: "session-a", id: { in: ["item-1"] } }, select: { id: true, type: true },
    })
    await expect(readPublicItemTypes(db, "session-a", Array.from({ length: 101 }, (_, index) => "item-" + index))).resolves.toEqual(new Map())
    expect(findMany).toHaveBeenCalledOnce()
    const missingDb = { agentItem: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as Pick<PrismaClient, "agentItem">
    await expect(readPublicItemTypes(missingDb, "session-a", ["missing-item"])).resolves.toEqual(new Map())

    const failingDb = { agentItem: { findMany: vi.fn().mockRejectedValue(new Error("database unavailable")) } } as unknown as Pick<PrismaClient, "agentItem">
    await expect(readPublicItemTypes(failingDb, "session-a", ["item-1"])).resolves.toBeNull()
  })
})
