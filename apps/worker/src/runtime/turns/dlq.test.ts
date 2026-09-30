import { describe, expect, it, vi } from "vitest"

import { COGNITIVE_AGENDA_RESUME_FENCE_INVALID, classifyTurnFailure, recordTurnDlq } from "./dlq.js"
import { TurnLeaseError } from "./lease.js"

function fakePool() {
  const calls: Array<[string, unknown[]?]> = []
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => { calls.push([sql, params]); return { rows: [], rowCount: 1 } }),
    release: vi.fn(),
  }
  return { pool: { connect: vi.fn().mockResolvedValue(client) }, calls }
}

describe("Turn DLQ classification", () => {
  it("retries ordinary failures until the fifth consecutive attempt", () => {
    expect(classifyTurnFailure(new Error("provider timeout"), 0)).toEqual({ disposition: "retry", reasonCode: "execution_failed" })
    expect(classifyTurnFailure(new Error("provider timeout"), 4)).toEqual({ disposition: "dead_letter", reasonCode: "max_retries_exhausted" })
  })

  it("treats lease loss as recoverable and duplicate claims as a skip", () => {
    expect(classifyTurnFailure(new TurnLeaseError("lease_lost", "lost"), 4)).toEqual({ disposition: "retry", reasonCode: "lease_lost" })
    expect(classifyTurnFailure(new TurnLeaseError("lease_not_available", "duplicate"), 4)).toEqual({ disposition: "skip", reasonCode: "lease_not_available" })
  })

  it("keeps resume fence drift identifiable while retrying, then terminalizes at the existing limit", () => {
    const error = new Error(COGNITIVE_AGENDA_RESUME_FENCE_INVALID)
    expect(classifyTurnFailure(error, 0)).toEqual({ disposition: "retry", reasonCode: COGNITIVE_AGENDA_RESUME_FENCE_INVALID })
    expect(classifyTurnFailure(error, 4)).toEqual({ disposition: "dead_letter", reasonCode: "max_retries_exhausted" })
  })

  it("writes a typed, redacted outbox event for malformed payloads", async () => {
    const fake = fakePool()
    await recordTurnDlq(fake.pool, { turnId: "turn_1", sessionId: "session_1", secret: "must-not-persist" }, 1, "schema_invalid_payload", new Error("bad payload"))
    const insert = fake.calls.find(([sql]) => sql.includes('INSERT INTO "agent_outbox"'))
    expect(insert?.[1]).toContain("agent.turn.dlq")
    expect(JSON.stringify(insert?.[1])).not.toContain("must-not-persist")
    expect(JSON.stringify(insert?.[1])).toContain("schema_invalid_payload")
  })

  it("preserves the stable fence error code in the existing DLQ envelope", async () => {
    const fake = fakePool()
    await recordTurnDlq(fake.pool, { turnId: "turn_1", sessionId: "session_1" }, 4, "max_retries_exhausted", new Error(COGNITIVE_AGENDA_RESUME_FENCE_INVALID))
    expect(JSON.stringify(fake.calls)).toContain(COGNITIVE_AGENDA_RESUME_FENCE_INVALID)
  })
})
