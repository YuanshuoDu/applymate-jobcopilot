import { describe, expect, it, vi } from "vitest"

import {
  hasOrphanScheduledAuditRegistration,
  scheduledAuditDigest,
  stableScheduledAuditOwnerForScope,
} from "./pg-scheduled-task-graph-audit-registration.js"
import { SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT } from "./scheduled-audit-contract.js"

describe("scheduled Audit registration helpers", () => {
  it("binds a stable owner to the exact TaskGraph scope", () => {
    expect(stableScheduledAuditOwnerForScope({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
      parentAttemptCount: 4,
    }, { executionId: "execution-1", executionAttemptCount: 2 })).toEqual({
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
      rootAttemptCount: 4, executionId: "execution-1", executionAttemptCount: 2,
    })
  })

  it("uses a deterministic digest for private registration evidence", () => {
    const value = { gateTaskId: "gate-1", attemptCount: 2 }
    expect(scheduledAuditDigest(value)).toBe(scheduledAuditDigest({ ...value }))
    expect(scheduledAuditDigest(value)).not.toBe(scheduledAuditDigest({ ...value, attemptCount: 3 }))
  })

  it("checks orphan registration in the exact user, session, turn, and continuation scope", async () => {
    const query = vi.fn(async () => ({ rows: [{ id: "event-1" }], rowCount: 1 }))
    const client = { query } as never
    await expect(hasOrphanScheduledAuditRegistration(client, {
      userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
    } as never, "continuation-1")).resolves.toBe(true)
    expect(query).toHaveBeenCalledWith(expect.stringContaining(`event."type" = $3`),
      ["session-1", "turn-1", SCHEDULED_AUDIT_REGISTRATION_RECEIPT_EVENT, "continuation-1", "user-1"])
  })
})
