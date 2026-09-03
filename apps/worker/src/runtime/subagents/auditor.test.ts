import type { AgentEventRecord } from "@jobcopilot/agent-protocol"
import { describe, expect, it, vi } from "vitest"

import { RedactedAuditorReader, createAuditorTaskSpec, runAuditor, type AuditorEvidenceQuery } from "./auditor.js"

const query: AuditorEvidenceQuery = { scope: { userId: "user-a" }, sessionId: "session-a", turnId: "turn-a" }
const event: AgentEventRecord = {
  id: "event-a", sessionId: "session-a", turnId: "turn-a", itemId: null, taskId: "task-a", sequence: BigInt(4),
  type: "item.completed", actor: "tool", correlationId: "call-a", causationId: null, idempotencyKey: null,
  payload: { email: "candidate@example.com", password: "secret-value", result: "safe status" }, createdAt: "2026-09-03T00:00:00.000Z",
}

describe("Auditor evidence contract", () => {
  it("reads only source evidence and returns redacted events and artifacts", async () => {
    const source = {
      readEvents: vi.fn(async (input: AuditorEvidenceQuery) => { expect(input.scope.userId).toBe("user-a"); return [event] }),
      readArtifacts: vi.fn(async () => [{ id: "artifact-a", kind: "review", hash: "hash-a", data: { email: "candidate@example.com", finding: "pass" } }]),
    }
    const result = await runAuditor({ reader: new RedactedAuditorReader(source), query })
    expect(result).toMatchObject({ status: "completed", result: { role: "auditor", mode: "read_only_evidence", redacted: true } })
    expect(JSON.stringify(result)).not.toContain("candidate@example.com")
    expect(JSON.stringify(result)).not.toContain("secret-value")
    expect(source.readEvents).toHaveBeenCalledWith(query)
  })

  it("makes the read-only task contract explicit", () => {
    const spec = createAuditorTaskSpec({ userId: "user-a", sessionId: "session-a", taskType: "audit", goal: "verify evidence" })
    expect(spec).toMatchObject({ role: "auditor", allowedActions: ["read_events", "read_artifacts", "produce_evidence_summary"], toolPolicySnapshot: { externalWrites: false } })
  })
})
