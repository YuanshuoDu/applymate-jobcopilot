import { describe, expect, it, vi } from "vitest"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { parseObjectiveStartBody } from "./objective-start-route-helpers"

const sessionId = "session_1"
const baseBody = {
  schemaVersion,
  clientMessageId: "start_1",
  objective: "  Find senior backend roles in Dublin  ",
  content: [{ type: "text", text: "\nReference context stays byte-for-byte.\n" }],
}
const validRequirements = {
  schemaVersion: "agent-harness.v2.objective-requirements.v1",
  requirements: [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 3 } }],
}

function request(key = "start_1") {
  return new Request("http://localhost/api/agent/sessions/session_1/start-objective", {
    method: "POST", headers: { "idempotency-key": key }, body: "{}",
  })
}

describe("parseObjectiveStartBody", () => {
  it("requires the matching idempotency header and preserves content text", () => {
    const parsed = parseObjectiveStartBody(baseBody, request(), sessionId)
    expect(parsed).toMatchObject({
      clientMessageId: "start_1",
      objective: "Find senior backend roles in Dublin",
      content: [{ type: "text", text: "\nReference context stays byte-for-byte.\n" }],
    })
    expect(parseObjectiveStartBody(baseBody, request("other"), sessionId)).toMatchObject({ status: 422 })
    expect(parseObjectiveStartBody(baseBody, new Request("http://localhost"), sessionId)).toMatchObject({ status: 422 })
  })

  it("enforces exact 2,000-byte objective boundary after outer trim", () => {
    expect(parseObjectiveStartBody({ ...baseBody, objective: `${"a".repeat(1_998)}é` }, request(), sessionId))
      .toMatchObject({ objective: `${"a".repeat(1_998)}é` })
    expect(parseObjectiveStartBody({ ...baseBody, objective: "界".repeat(667) }, request(), sessionId))
      .toMatchObject({ status: 422 })
    expect(parseObjectiveStartBody({ ...baseBody, objective: "  " }, request(), sessionId))
      .toMatchObject({ status: 422 })
  })

  it("accepts and preserves whitespace-only background text byte-for-byte", () => {
    const text = " \t\r\n "
    const parsed = parseObjectiveStartBody({ ...baseBody, content: [{ type: "text", text }] }, request(), sessionId)
    expect(parsed).toMatchObject({ content: [{ type: "text", text }] })
  })

  it("accepts and preserves the existing 20,000-character context limit", () => {
    const text = "reference ".repeat(2_000)
    const parsed = parseObjectiveStartBody({ ...baseBody, content: [{ type: "text", text }] }, request(), sessionId)
    expect(parsed).toMatchObject({ content: [{ type: "text", text }] })
  })

  it("keeps absent requirements omitted, parses valid values, and rejects malformed blocks", () => {
    const absent = parseObjectiveStartBody(baseBody, request(), sessionId)
    expect(Object.hasOwn(absent as object, "verificationRequirements")).toBe(false)

    const valid = parseObjectiveStartBody({ ...baseBody, verificationRequirements: validRequirements }, request(), sessionId)
    expect(valid).toMatchObject({ verificationRequirements: validRequirements })

    const malformed = { ...validRequirements, requirements: [{
      id: "candidate-count", check: { kind: "evidence_count_gte", minimum: 3 },
    }] }
    const invalid = parseObjectiveStartBody({ ...baseBody, verificationRequirements: malformed }, request(), sessionId)
    expect(invalid).toMatchObject({ status: 422 })
  })

  it("accepts and canonicalizes the versioned exact-location requirement only when enabled", () => {
    const locationRequirements = {
      schemaVersion: "agent-harness.v2.objective-requirements.v2",
      requirements: [{ id: "candidate-location", check: { kind: "candidate_location_in", locations: ["Dublin, Ireland", " Berlin ", "dublin"] } }],
    }
    const disabled = parseObjectiveStartBody({ ...baseBody, verificationRequirements: locationRequirements }, request(), sessionId)
    expect(disabled).toMatchObject({ status: 422 })
    vi.stubEnv("AGENT_OBJECTIVE_LOCATION_VERIFICATION_ENABLED", "1")
    try {
      const enabled = parseObjectiveStartBody({ ...baseBody, verificationRequirements: locationRequirements }, request(), sessionId)
      expect(enabled).toMatchObject({
        verificationRequirements: {
          schemaVersion: "agent-harness.v2.objective-requirements.v2",
          requirements: [{ id: "candidate-location", check: { kind: "candidate_location_in", locations: ["berlin", "dublin", "dublin, ireland"] } }],
        },
      })
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("rejects authority fields and malformed or over-bound context without trimming text", () => {
    for (const body of [
      { ...baseBody, source: "automation" },
      { ...baseBody, userId: "user_1" },
      { ...baseBody, criteria: ["must pass"] },
      { ...baseBody, schemaVersion: "unsupported" },
      { ...baseBody, content: [{ type: "text", text: "" }] },
      { ...baseBody, content: [{ type: "text", text: "x".repeat(20_001) }] },
      { ...baseBody, content: [{ type: "text", text: "ok", extra: true }] },
      { ...baseBody, content: [] },
      { ...baseBody, content: Array.from({ length: 33 }, () => ({ type: "text", text: "ok" })) },
      { ...baseBody, content: Array.from({ length: 9 }, (_, i) => ({ type: "attachment_ref", attachmentId: `resume_${i}`, mediaType: "application/pdf" })) },
    ]) {
      expect(parseObjectiveStartBody(body, request(), sessionId)).toMatchObject({ status: 422 })
    }
  })
})
