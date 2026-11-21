import { describe, expect, it } from "vitest"

import {
  buildReviewedFillHandoffIntent,
  buildReviewedFillHandoffOutboxData,
  parseReviewedFillHandoffIntent,
  parseReviewedFillHandoffOutboxRow,
  REVIEWED_FILL_HANDOFF_SCHEMA,
  REVIEWED_FILL_HANDOFF_TOPIC,
  reviewedFillHandoffIdempotencyKey,
} from "./agent-reviewed-fill-handoff.js"

const identity = {
  userId: "user_1", sessionId: "session_1", applicationTaskId: "application_1",
  approvalId: "approval_1", predecessorTurnId: "turn_1",
}

describe("reviewed fill handoff contract", () => {
  it("builds the exact private intent and deterministic outbox identity", () => {
    const payload = buildReviewedFillHandoffIntent(identity)
    expect(payload).toEqual({ schemaVersion: REVIEWED_FILL_HANDOFF_SCHEMA, ...identity })
    expect(Object.keys(payload ?? {}).sort()).toEqual([
      "applicationTaskId", "approvalId", "predecessorTurnId", "schemaVersion", "sessionId", "userId",
    ])
    expect(reviewedFillHandoffIdempotencyKey(identity.approvalId)).toBe("agent-reviewed-fill:approval_1")
    expect(buildReviewedFillHandoffOutboxData(identity)).toEqual({
      topic: REVIEWED_FILL_HANDOFF_TOPIC, aggregateId: identity.sessionId,
      idempotencyKey: "agent-reviewed-fill:approval_1", payload,
    })
  })

  it("rejects incomplete, expanded, mistyped, and noncanonical intent shapes", () => {
    const payload = buildReviewedFillHandoffIntent(identity)!
    const { predecessorTurnId: _predecessorTurnId, ...missing } = payload
    const malformed = [
      missing,
      { ...payload, sourceTurnId: "untrusted" },
      { ...payload, schemaVersion: "agent-harness.v2.reviewed-fill-handoff.v2" },
      { ...payload, approvalId: " approval_1" },
      { ...payload, userId: 9 },
      Object.assign(Object.create({ inherited: "foreign" }), payload),
      Object.defineProperty({ ...payload }, "userId", { get: () => "user_1", enumerable: true }),
    ]
    for (const value of malformed) expect(parseReviewedFillHandoffIntent(value)).toBeNull()
    expect(reviewedFillHandoffIdempotencyKey(" ")).toBeNull()
    const longApproval = "a".repeat(256)
    expect(reviewedFillHandoffIdempotencyKey(longApproval)).toBeNull()
    expect(buildReviewedFillHandoffIntent({ ...identity, approvalId: longApproval })).toBeNull()
  })

  it("rebinds the selected outbox row to its payload Session and approval key", () => {
    const data = buildReviewedFillHandoffOutboxData(identity)!
    const row = { id: "outbox_1", ...data }
    expect(parseReviewedFillHandoffOutboxRow(row)).toEqual(row)
    const malformed = [
      { ...row, topic: "agent.turn.dispatch" },
      { ...row, aggregateId: "session_foreign" },
      { ...row, idempotencyKey: "agent-reviewed-fill:approval_other" },
      { ...row, payload: { ...data.payload, sessionId: "session_foreign" } },
      { ...row, privateExtra: true },
      { ...row, id: "" },
    ]
    for (const value of malformed) expect(parseReviewedFillHandoffOutboxRow(value)).toBeNull()
  })
})
