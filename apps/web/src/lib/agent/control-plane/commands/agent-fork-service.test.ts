import { describe, expect, it, vi } from "vitest"
import type { PrismaClient } from "@prisma/client"

import { AgentForkService } from "./agent-fork-service"
import { agentForkTurnSelect } from "../store/turn-select"

describe("AgentForkService Turn projection", () => {
  it("loads only the historical Turn fields copied into a fork", async () => {
    const completedAt = new Date("2026-10-01T00:00:00.000Z")
    const source = {
      id: "source-session", userId: "owner", goal: "Goal", source: "user", memorySummary: null,
      turns: [{ id: "turn-1", source: "user", status: "completed", input: { goal: "Goal" }, finalResponse: "Done",
        error: null, modelProfileSnapshot: {}, inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0,
        durationMs: 10, startedAt: completedAt, completedAt, createdAt: completedAt }],
      items: [], events: [], contextSnapshots: [],
    }
    const findFirst = vi.fn(async (args: { where: { id: string } }) => args.where.id === source.id ? source : null)
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: source.id }]),
      agentSession: { findFirst, create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      agentEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})) },
      agentTurn: { createMany: vi.fn(async () => ({ count: 1 })) },
      agentItem: { createMany: vi.fn(async () => ({ count: 0 })) },
    }
    const db = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient

    const result = await new AgentForkService(db).fork({
      sessionId: source.id, userId: source.userId, clientMessageId: "fork-request", source: "user", lastTurnId: "turn-1",
    })

    expect(result.disposition).toBe("forked")
    const sourceRead = findFirst.mock.calls[1]?.[0] as unknown as { select: { turns: { select: unknown } } }
    expect(sourceRead.select.turns.select).toEqual(agentForkTurnSelect)
    expect(Object.keys(agentForkTurnSelect)).not.toContain("nativeSemanticProgressMode")
  })

  it("excludes private memory events and root-task-history observations while keeping visible history", async () => {
    const at = new Date("2026-10-01T00:00:00.000Z")
    const source = {
      id: "source-session", userId: "owner", goal: "Goal", source: "user", memorySummary: null,
      turns: [{ id: "turn-1", source: "user", status: "completed", input: { goal: "Goal" }, finalResponse: "Done",
        error: null, modelProfileSnapshot: {}, inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0,
        durationMs: 10, startedAt: at, completedAt: at, createdAt: at }],
      items: [{ id: "visible-item", turnId: "turn-1", type: "user_message", status: "completed", phase: "input", revision: 1,
        content: { parts: [{ type: "text", text: "Visible user history" }] }, startedAt: at, completedAt: at, createdAt: at }],
      events: [
        { id: "snapshot-event", sessionId: "source-session", turnId: "turn-1", itemId: null, taskId: "root-1", sequence: BigInt(1),
          type: "agent.plan.discovery_persona_snapshot", actor: "worker", correlationId: "turn-1", causationId: null,
          idempotencyKey: "discovery-persona-snapshot:source-session:v1",
          payload: { projection: { facts: [{ factId: "fact-1", value: "PRIVATE_DISCOVERY_FACT_VALUE" }] } } },
        { id: "overflow-event", sessionId: "source-session", turnId: "turn-1", itemId: null, taskId: "root-1", sequence: BigInt(2),
          type: "agent.plan.discovery_persona_overflow", actor: "worker", correlationId: "turn-1", causationId: null,
          idempotencyKey: "discovery-persona-overflow:source-session:turn-1:v1",
          payload: { observedFactCount: 33, rawValue: "PRIVATE_OVERFLOW_VALUE" } },
        { id: "history-authorization-event", sessionId: "source-session", turnId: "turn-1", itemId: null, taskId: "root-1", sequence: BigInt(3),
          type: "agent.plan.root_task_history_session_authorization", actor: "worker", correlationId: "turn-1", causationId: null,
          idempotencyKey: "root-task-history-authorization:source-session:v1",
          payload: { consentVersion: 12, enabled: true, snapshotKey: "PRIVATE_HISTORY_AUTHORIZATION_KEY" } },
        { id: "history-snapshot-event", sessionId: "source-session", turnId: "turn-1", itemId: null, taskId: "root-1", sequence: BigInt(4),
          type: "agent.plan.root_task_history_memory_snapshot", actor: "worker", correlationId: "turn-1", causationId: null,
          idempotencyKey: "root-task-history-snapshot:source-session:v1",
          payload: { id: "root-task-history", value: "PRIVATE_ROOT_TASK_HISTORY_EVENT" } },
        { id: "visible-event", sessionId: "source-session", turnId: "turn-1", itemId: "visible-item", taskId: null, sequence: BigInt(5),
          type: "item.completed", actor: "worker", correlationId: "turn-1", causationId: null,
          idempotencyKey: "visible-item:completed", payload: { status: "completed" } },
      ],
      contextSnapshots: [{
        id: "history-context-snapshot", throughSequence: BigInt(5), schemaVersion: "agent-harness.context.v1",
        content: { context: { toolObservations: [
          { id: "root-task-history", content: { kind: "root_task_history", value: "PRIVATE_ROOT_TASK_HISTORY_SNAPSHOT" } },
          { id: "same-session-observation", content: { value: "Visible same-session observation" } },
        ] } },
        summary: "Visible fork summary", inputTokens: 4, outputTokens: 2, estimatedCostUsd: 0, tokenAccounting: {},
      }],
    }
    const findFirst = vi.fn(async (args: { where: { id: string } }) => args.where.id === source.id ? source : null)
    const copiedEvents = vi.fn(async (_input: { data: Array<{ type: string; payload: unknown }> }) => ({ count: 1 }))
    const copiedItems = vi.fn(async (_input: { data: Array<{ content: unknown }> }) => ({ count: 1 }))
    const copiedSnapshot = vi.fn(async (_input: { data: { content: unknown } }) => ({}))
    const tx = {
      $queryRaw: vi.fn(async () => [{ id: source.id }]),
      agentSession: { findFirst, create: vi.fn(async () => ({})), update: vi.fn(async () => ({})) },
      agentEvent: { findFirst: vi.fn(async () => null), create: vi.fn(async () => ({})), createMany: copiedEvents },
      agentContextSnapshot: { create: copiedSnapshot },
      agentTurn: { createMany: vi.fn(async () => ({ count: 1 })) },
      agentItem: { createMany: copiedItems },
    }
    const db = { $transaction: vi.fn(async (work: (value: typeof tx) => Promise<unknown>) => work(tx)) } as unknown as PrismaClient

    const result = await new AgentForkService(db).fork({
      sessionId: source.id, userId: source.userId, clientMessageId: "privacy-fork", source: "user", lastTurnId: "turn-1",
    })

    expect(result.disposition).toBe("forked")
    const copied = copiedEvents.mock.calls[0]?.[0] as unknown as { data: Array<{ type: string; payload: unknown }> }
    expect(copied.data.map(event => event.type)).toEqual(["item.completed"])
    const visible = copiedItems.mock.calls[0]?.[0] as unknown as { data: Array<{ content: unknown }> }
    expect(JSON.stringify(visible.data)).toContain("Visible user history")
    const serialized = JSON.stringify({ copied: copied.data.map(({ type, payload }) => ({ type, payload })), visible: visible.data })
    expect(serialized).not.toContain("PRIVATE_DISCOVERY_FACT_VALUE")
    expect(serialized).not.toContain("PRIVATE_OVERFLOW_VALUE")
    expect(serialized).not.toContain("PRIVATE_HISTORY_AUTHORIZATION_KEY")
    expect(serialized).not.toContain("PRIVATE_ROOT_TASK_HISTORY_EVENT")
    expect(serialized).not.toContain("agent.plan.root_task_history_session_authorization")
    expect(serialized).not.toContain("agent.plan.root_task_history_memory_snapshot")

    expect(copiedSnapshot).toHaveBeenCalledOnce()
    const snapshotContent = copiedSnapshot.mock.calls[0]?.[0].data.content
    const snapshotText = JSON.stringify(snapshotContent)
    expect(snapshotText).not.toContain("root-task-history")
    expect(snapshotText).not.toContain("PRIVATE_ROOT_TASK_HISTORY_SNAPSHOT")
    expect(snapshotText).toContain("Visible same-session observation")
  })
})
