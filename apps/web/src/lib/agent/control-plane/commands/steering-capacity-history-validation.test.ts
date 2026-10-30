import { describe, expect, it } from "vitest"
import { redactSensitiveText } from "@jobcopilot/shared"

import { acceptedSource, parseReceipt, sequence, stepFrom, type Row } from "./steering-capacity-history-validation"

const scope = { sessionId: "session_1", userId: "user_1", turnId: "turn_1" }
const inputId = "12345678-1234-4abc-8abc-123456789012"
const clientMessageId = "request-415-555-0100"

function acceptedRow(): Row {
  const parts = [{ type: "text", text: "private input" }]
  return {
    id: inputId, inputSessionId: scope.sessionId, inputTargetTurnId: scope.turnId, inputUserId: scope.userId,
    inputContent: parts, clientMessageId, delivery: "steer", status: "accepted", acceptedSequence: BigInt(7),
    acceptedEventId: "event_1", acceptedEventSessionId: scope.sessionId, acceptedEventTurnId: scope.turnId,
    acceptedType: "input.accepted", acceptedActor: "user", acceptedEventTaskId: null, acceptedEventCorrelationId: scope.turnId,
    acceptedEventCausationId: null, acceptedItemId: "item_1", acceptedEventSequence: BigInt(7),
    acceptedPayload: { inputId, clientMessageId: redactSensitiveText(clientMessageId), delivery: "steer", source: "user", disposition: "steered" },
    acceptedItemRowId: "item_1", acceptedItemSessionId: scope.sessionId, acceptedItemTurnId: scope.turnId,
    acceptedItemStepId: null, acceptedItemType: "user_message", acceptedItemTaskId: null, acceptedItemStatus: "completed",
    acceptedItemContent: { clientMessageId, disposition: "steered", parts, source: "user" },
  }
}

describe("steering history row validation", () => {
  it("binds accepted event identity to the raw input while comparing the redacted caller ID", () => {
    const row = acceptedRow()
    expect(acceptedSource(row, scope)).toBe("user")
    expect(acceptedSource({ ...row, acceptedPayload: { ...(row.acceptedPayload as object), inputId: redactSensitiveText(inputId) } }, scope)).toBe("user")
  })

  it("fails closed for scope, event, item, parts, and client projection mismatches", () => {
    const row = acceptedRow()
    const cases: Row[] = [
      { ...row, inputUserId: "other_user" },
      { ...row, acceptedEventSessionId: "other_session" },
      { ...row, acceptedEventTurnId: "other_turn" },
      { ...row, acceptedEventCausationId: "event_parent" },
      { ...row, acceptedEventSequence: BigInt(8) },
      { ...row, acceptedItemRowId: "other_item" },
      { ...row, acceptedItemStepId: "step_1" },
      { ...row, inputContent: [{ type: "text", text: "different" }] },
      { ...row, acceptedItemContent: { ...(row.acceptedItemContent as object), clientMessageId: "other_client" } },
      { ...row, acceptedPayload: { ...(row.acceptedPayload as object), clientMessageId } },
      { ...row, acceptedPayload: { ...(row.acceptedPayload as object), inputId: "other_input" } },
      { ...row, acceptedPayload: { ...(row.acceptedPayload as object), unexpected: true } },
    ]
    for (const candidate of cases) expect(acceptedSource(candidate, scope)).toBeNull()
  })

  it("keeps sequence, step, and receipt validators fail closed", () => {
    expect(sequence("9223372036854775807")).toBe(BigInt("9223372036854775807"))
    expect(sequence("9223372036854775808")).toBeNull()
    expect(stepFrom({ id: "step_1", taskId: null, ordinal: 0, attempt: 1, status: "completed", inputThroughSequence: 1, consumedInputIds: [] })).not.toBeNull()
    expect(stepFrom({ id: "step_1", taskId: null, ordinal: -1, attempt: 1, status: "completed", inputThroughSequence: 1, consumedInputIds: [] })).toBeNull()
    expect(parseReceipt({}, scope.sessionId, scope.turnId, "root_1")).toBeNull()
  })
})
