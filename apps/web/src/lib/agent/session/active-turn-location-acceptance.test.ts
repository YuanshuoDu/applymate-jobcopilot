import { describe, expect, it } from "vitest"
import {
  OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION,
  formatObjectiveLocationSteerMessage,
} from "@jobcopilot/agent-protocol"
import { parseActiveTurnLocationAcceptance, type ActiveTurnLocationScope } from "./active-turn-location-acceptance"

const scope: ActiveTurnLocationScope = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1" }
const inputId = "11111111-1111-4111-8111-111111111111"
const clientMessageId = "location-request-1"
const parts = [{ type: "text", text: formatObjectiveLocationSteerMessage(["dublin"]) }]

function acceptedFacts(patch: Record<string, unknown> = {}) {
  return {
    id: inputId, inputSessionId: scope.sessionId, inputTargetTurnId: scope.turnId, inputUserId: scope.userId,
    clientMessageId, delivery: "steer", status: "queued", inputContent: parts, acceptedSequence: BigInt(4),
    consumedByStepId: null, consumedAt: null, cancelledAt: null,
    acceptedEventId: "event-accepted-1", acceptedEventSessionId: scope.sessionId, acceptedEventTurnId: scope.turnId,
    acceptedEventSequence: BigInt(4), acceptedType: "input.accepted", acceptedActor: "user", acceptedEventTaskId: null,
    acceptedEventCorrelationId: scope.turnId, acceptedEventCausationId: null, acceptedItemId: "item-accepted-1",
    acceptedPayload: { clientMessageId, delivery: "steer", disposition: "steered", inputId, source: "user" },
    acceptedItemRowId: "item-accepted-1", acceptedItemSessionId: scope.sessionId, acceptedItemTurnId: scope.turnId,
    acceptedItemStepId: null, acceptedItemType: "user_message", acceptedItemTaskId: null, acceptedItemStatus: "completed",
    acceptedItemContent: { clientMessageId, disposition: "steered", parts, source: "user" },
    ...patch,
  }
}

function receipt(patch: Record<string, unknown> = {}) {
  return {
    id: "event-location-1", sessionId: scope.sessionId, turnId: scope.turnId, taskId: scope.rootTaskId,
    type: OBJECTIVE_LOCATION_STEER_ACCEPTED_EVENT_TYPE, actor: "user", correlationId: scope.turnId,
    causationId: "event-accepted-1", itemId: null, idempotencyKey: `agent-objective-locations:${clientMessageId}:4`, sequence: BigInt(6),
    payload: { schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION, acceptedInputSequence: 4, locations: ["dublin"] },
    ...patch,
  }
}

describe("active Turn location acceptance proof", () => {
  it("binds a canonical typed confirmation to its accepted user input and exact Turn Root", () => {
    expect(parseActiveTurnLocationAcceptance(receipt(), acceptedFacts(), scope)).toMatchObject({
      inputId, acceptedInputSequence: BigInt(4), receiptSequence: BigInt(6), locations: ["dublin"], consumed: false,
    })
  })

  it.each([
    ["ordinary prose", {}, { inputContent: [{ type: "text", text: "Please search near Dublin" }], acceptedItemContent: {
      clientMessageId, disposition: "steered", parts: [{ type: "text", text: "Please search near Dublin" }], source: "user",
    } }],
    ["foreign owner", {}, { inputUserId: "user-2" }],
    ["stale accepted-event causation", { causationId: "other-event" }, {}],
    ["noncanonical location spelling", { payload: { schemaVersion: OBJECTIVE_LOCATION_STEER_SCHEMA_VERSION, acceptedInputSequence: 4, locations: ["Dublin"] } }, {}],
    ["foreign Root", { taskId: "root-2" }, {}],
    ["wrong actor", { actor: "system" }, {}],
  ])("rejects %s as an adopted confirmation", (_name, eventPatch, factsPatch) => {
    expect(parseActiveTurnLocationAcceptance(receipt(eventPatch), acceptedFacts(factsPatch), scope)).toBeNull()
  })

  it("keeps accepted but unconsumed input pending and never treats it as applied", () => {
    expect(parseActiveTurnLocationAcceptance(receipt(), acceptedFacts({ status: "accepted" }), scope)?.consumed).toBe(false)
  })

  it("rejects a consumed input without its exact Root Step identity", () => {
    expect(parseActiveTurnLocationAcceptance(receipt(), acceptedFacts({
      status: "consumed", consumedByStepId: null, consumedAt: new Date(),
    }), scope)).toBeNull()
  })
})
