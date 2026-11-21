import { describe, expect, it, vi } from "vitest"
import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, type TenantScope } from "@jobcopilot/agent-protocol"
import { redactSensitiveText } from "@jobcopilot/shared"
import type { InputClaimQueryClient } from "./input-claim-store.js"
import { readRetrySourceSteeringObservation } from "./retry-source-steering.js"

type Row = Record<string, unknown>
const scope: TenantScope = { userId: "user-a" }
const receipt = { schemaVersion: "agent-harness.v2.retry-lineage.v1", predecessorTurnId: "turn-prior", acceptedInputId: "input-current", acceptedSequence: "8" }
const content = [{ type: "text", text: "Find Dublin engineering roles" }]
function objective(extra: Row = {}): Row {
  return { goal: "Find Dublin engineering roles", content, clientMessageId: "client-id", intent: OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, ...extra }
}
function input(turnId: string, id: string, sequence: string, delivery: string, parts: unknown, status = "accepted"): Row {
  return { id, sessionId: "session-a", targetTurnId: turnId, userId: scope.userId, clientMessageId: `client-${id}`,
    delivery, status, content: parts, acceptedSequence: sequence, consumedByStepId: null, consumedAt: null,
    cancelledAt: null, createdAt: new Date("2026-10-01T00:00:00Z") }
}
function event(stored: Row, disposition: string): Row {
  const id = String(stored.id), turnId = String(stored.targetTurnId), sequence = stored.acceptedSequence
  const itemId = `item-${id}`, clientMessageId = String(stored.clientMessageId), delivery = String(stored.delivery)
  return { acceptedEventId: `event-${id}`, acceptedEventSessionId: "session-a", acceptedEventTurnId: turnId,
    acceptedEventItemId: itemId, acceptedTaskId: null, acceptedEventSequence: sequence, acceptedType: "input.accepted",
    acceptedActor: "user", acceptedCorrelationId: turnId, acceptedEventCausationId: null,
    acceptedEventIdempotencyKey: `input.accepted:${id}`, acceptedPayload: {
      inputId: id, clientMessageId: redactSensitiveText(clientMessageId), delivery, disposition, source: "user",
    }, acceptedEventCreatedAt: stored.createdAt,
    acceptedItemId: itemId, acceptedItemSessionId: "session-a", acceptedItemTurnId: turnId, acceptedItemStepId: null,
    acceptedItemTaskId: null, acceptedItemType: "user_message", acceptedItemStatus: "completed",
    acceptedItemContent: { clientMessageId, disposition, parts: stored.content, source: "user" },
    acceptedItemCreatedAt: stored.createdAt, acceptedItemUpdatedAt: stored.createdAt }
}
function database(options: { currentInput?: Row; currentSource?: string; currentMode?: string; currentRootId?: string;
  predecessorInput?: Row; predecessorStatus?: string; predecessorSource?: string; predecessorMode?: string;
  predecessorTurnId?: string; predecessorRootStatus?: string } = {}) {
  const current = objective({ retryLineage: receipt }), previous = objective()
  const currentInput = options.currentInput ?? input("turn-current", "input-current", "8", "follow_up", content)
  const priorSteer = input("turn-prior", "input-prior-steer", "6", "steer", [{ type: "text", text: "Prefer Dublin; exclude contract roles." }])
  const priorOpening = input("turn-prior", "input-prior-open", "2", "follow_up", content)
  const predecessorInput = options.predecessorInput ?? previous
  const currentRow = { input: current, rootTaskId: options.currentRootId ?? "root-current",
    source: options.currentSource ?? "user", executionMode: options.currentMode ?? "canonical_task_graph" }
  const priorRow = { input: predecessorInput, source: options.predecessorSource ?? "user",
    executionMode: options.predecessorMode ?? "canonical_task_graph",
    status: options.predecessorStatus ?? "failed", rootStatus: options.predecessorRootStatus ?? "failed" }
  const calls: string[] = []
  const client = { query: vi.fn(async (sql: unknown, values: readonly unknown[] = []) => {
    const text = String(sql); calls.push(text)
    if (text.includes('FROM "agent_turns" AS turn')) return { rows: [values[0] === "turn-current" ? currentRow :
      options.predecessorTurnId === "foreign" ? undefined : priorRow].filter(Boolean) }
    if (text.includes('FROM "agent_inputs"')) {
      const rows = values[1] === "turn-current" ? [currentInput] : [priorOpening, priorSteer]
      return { rows }
    }
    if (text.includes('FROM "agent_events"')) {
      const rows = values[1] === "turn-current" ? [event(currentInput, "started")] : [event(priorOpening, "started"), event(priorSteer, "steered")]
      return { rows }
    }
    throw new Error(`Unexpected query ${text}`)
  }) }
  return { client: client as unknown as InputClaimQueryClient, calls, currentInput }
}
const request = { sessionId: "session-a", turnId: "turn-current", rootTaskId: "root-current", turnInput: objective({ retryLineage: receipt }) }

describe("retry source steering observation", () => {
  it("does not query ordinary Turns without a valid private receipt hint", async () => {
    const fake = database()
    await expect(readRetrySourceSteeringObservation(fake.client, scope, { ...request, turnInput: objective() })).resolves.toBeUndefined()
    expect(fake.calls).toEqual([])
  })

  it("projects only validated predecessor user steer as bounded historical advisory context", async () => {
    const fake = database()
    const result = await readRetrySourceSteeringObservation(fake.client, scope, request)
    expect(result).toMatchObject({ id: "retry-source-steering", content: {
      kind: "retry_source_steering", advisoryOnly: true, informationalOnly: true, notCurrentEvidence: true,
      messages: ["Prefer Dublin; exclude contract roles."],
    } })
    expect(JSON.stringify(result)).not.toContain("turn-prior")
    expect(JSON.stringify(result)).not.toContain("input-prior")
  })

  it("retains evidence after the current opening follow-up is consumed", async () => {
    const consumed = input("turn-current", "input-current", "8", "follow_up", content, "consumed")
    consumed.consumedByStepId = "step-current"; consumed.consumedAt = new Date("2026-10-01T00:01:00Z")
    const fake = database({ currentInput: consumed })
    await expect(readRetrySourceSteeringObservation(fake.client, scope, request)).resolves.toMatchObject({ id: "retry-source-steering" })
  })

  it.each([
    ["foreign current Root", { currentRootId: "root-other" }],
    ["non-user current Turn", { currentSource: "system" }],
    ["noncanonical current Turn", { currentMode: "legacy_pipeline_adapter" }],
    ["foreign predecessor", { predecessorTurnId: "foreign" }],
    ["non-user predecessor", { predecessorSource: "system" }],
    ["noncanonical predecessor", { predecessorMode: "legacy_pipeline_adapter" }],
    ["non-retryable predecessor", { predecessorStatus: "in_progress" }],
    ["active predecessor Root", { predecessorRootStatus: "running" }],
    ["changed predecessor objective", { predecessorInput: objective({ goal: "Different goal" }) }],
    ["wrong follow-up sequence", { currentInput: input("turn-current", "input-current", "9", "follow_up", content) }],
    ["wrong follow-up content", { currentInput: input("turn-current", "input-current", "8", "follow_up", [{ type: "text", text: "other" }]) }],
    ["cancelled follow-up", { currentInput: { ...input("turn-current", "input-current", "8", "follow_up", content, "cancelled"), cancelledAt: new Date() } }],
  ])("omits advice for %s", async (_label, options) => {
    const fake = database(options)
    await expect(readRetrySourceSteeringObservation(fake.client, scope, request)).resolves.toBeUndefined()
  })
})
