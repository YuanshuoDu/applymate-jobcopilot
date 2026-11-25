import { describe, expect, it } from "vitest"
import {
  buildObjectiveReviewedFillHandoffOutboxData,
  objectiveApplicationApprovedIntentId,
  objectiveReviewedFillHandoffIdempotencyKey,
  OBJECTIVE_REVIEWED_FILL_HANDOFF_SCHEMA,
  OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC,
  OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA,
  parseObjectiveApplicationApprovedIntent,
  parseObjectiveReviewedFillHandoffOutboxRow,
  parseObjectiveReviewedFillSource,
} from "./agent-objective-reviewed-fill.js"

const setId = `objective-review-${"a".repeat(40)}`
const approvalId = `objective-review:${setId}:3`
const approvedIntent = {
  schemaVersion: "objective-application-review-approved-intent.v1",
  userId: "user_1", sessionId: "session_1", reviewTurnId: "review_turn_1", applicationTaskId: "application_1",
  jobId: "job_1", approvalId, setId, slotOrdinal: 3, sourceTurnId: "source_turn_1", materialProofHash: "b".repeat(64),
}
const handoffIdentity = {
  userId: "user_1", sessionId: "session_1", applicationTaskId: "application_1", approvalId, predecessorTurnId: "review_turn_1",
}

describe("Objective reviewed fill shared contract", () => {
  it("parses the exact private approved intent and deterministic event identity", () => {
    expect(parseObjectiveApplicationApprovedIntent(approvedIntent)).toEqual(approvedIntent)
    expect(objectiveApplicationApprovedIntentId(setId, 3)).toBe(`objective-application-approved:${setId}:3`)
    const malformed = [
      { ...approvedIntent, extra: true },
      { ...approvedIntent, schemaVersion: "objective-application-review-approved-intent.v2" },
      { ...approvedIntent, reviewTurnId: approvedIntent.sourceTurnId },
      { ...approvedIntent, slotOrdinal: 2 },
      { ...approvedIntent, approvalId: "review_application:legacy" },
      { ...approvedIntent, materialProofHash: "not-a-hash" },
      Object.assign(Object.create({ foreign: true }), approvedIntent),
      Object.defineProperty({ ...approvedIntent }, "jobId", { get: () => "job_1", enumerable: true }),
    ]
    for (const value of malformed) expect(parseObjectiveApplicationApprovedIntent(value)).toBeNull()
  })

  it("accepts only the exact Objective selector under its own private field", () => {
    const source = { schemaVersion: OBJECTIVE_REVIEWED_FILL_SOURCE_SCHEMA, approvalId,
      reviewTurnId: "review_turn_1", materialProofHash: "c".repeat(64) }
    expect(parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: source })).toEqual(source)
    expect(parseObjectiveReviewedFillSource({})).toBeNull()
    expect(parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: {
      ...source, schemaVersion: "agent-harness.v2.selected-job-reviewed-fill-source.v1",
    } })).toBeNull()
    expect(parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: { ...source, extra: true } })).toBeNull()
    expect(parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: { ...source, approvalId: "approval_1" } })).toBeNull()
    expect(parseObjectiveReviewedFillSource({ reviewedApplicationMaterialSource: { ...source, materialProofHash: "x" } })).toBeNull()
    expect(parseObjectiveReviewedFillSource(Object.defineProperty({}, "reviewedApplicationMaterialSource", {
      get: () => source, enumerable: true,
    }))).toBeNull()
    expect(parseObjectiveReviewedFillSource(Object.assign(Object.create({ reviewedApplicationMaterialSource: source }), {}))).toBeNull()
  })

  it("builds a distinct Objective topic, schema, and idempotency key", () => {
    const data = buildObjectiveReviewedFillHandoffOutboxData(handoffIdentity)
    expect(data).toEqual({
      topic: OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC,
      aggregateId: handoffIdentity.sessionId,
      idempotencyKey: `agent-objective-reviewed-fill:${approvalId}`,
      payload: { schemaVersion: OBJECTIVE_REVIEWED_FILL_HANDOFF_SCHEMA, ...handoffIdentity },
    })
    expect(objectiveReviewedFillHandoffIdempotencyKey(approvalId)).toBe(`agent-objective-reviewed-fill:${approvalId}`)
    expect(objectiveReviewedFillHandoffIdempotencyKey("approval_1")).toBeNull()
    expect(buildObjectiveReviewedFillHandoffOutboxData({ ...handoffIdentity, approvalId: "approval_1" })).toBeNull()
    const overriddenSchema = { ...handoffIdentity, schemaVersion: "agent-harness.v2.reviewed-fill-handoff.v1" }
    expect(buildObjectiveReviewedFillHandoffOutboxData(overriddenSchema)).toBeNull()
    const accessor = Object.defineProperty({ ...handoffIdentity }, "userId", { get: () => "user_1", enumerable: true })
    expect(buildObjectiveReviewedFillHandoffOutboxData(accessor)).toBeNull()
  })

  it("rebinds an outbox row to its Objective approval and rejects legacy or expanded rows", () => {
    const data = buildObjectiveReviewedFillHandoffOutboxData(handoffIdentity)!
    const row = { id: "outbox_1", ...data }
    expect(parseObjectiveReviewedFillHandoffOutboxRow(row)).toEqual(row)
    const malformed = [
      { ...row, topic: "agent.reviewed-fill.dispatch" },
      { ...row, aggregateId: "session_foreign" },
      { ...row, idempotencyKey: `agent-reviewed-fill:${approvalId}` },
      { ...row, payload: { ...data.payload, schemaVersion: "agent-harness.v2.reviewed-fill-handoff.v1" } },
      { ...row, privateExtra: true },
      Object.defineProperty({ ...row }, "topic", { get: () => OBJECTIVE_REVIEWED_FILL_HANDOFF_TOPIC, enumerable: true }),
    ]
    for (const value of malformed) expect(parseObjectiveReviewedFillHandoffOutboxRow(value)).toBeNull()
  })
})
