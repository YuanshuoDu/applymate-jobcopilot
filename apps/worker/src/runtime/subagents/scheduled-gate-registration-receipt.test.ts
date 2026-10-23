import { describe, expect, it, vi } from "vitest"
import {
  buildScheduledGateRegistrationReceipt,
  parseScheduledGateRegistrationReceipt,
  readScheduledGateRegistrationReceipt,
  scheduledGateRegistrationReceiptKey,
  SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT,
  SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA,
} from "./scheduled-gate-registration-receipt.js"

const owner = Object.freeze({ userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1",
  rootAttemptCount: 1, executionId: "execution-1", executionAttemptCount: 2 })
const receipt = Object.freeze({ schemaVersion: SCHEDULED_GATE_REGISTRATION_RECEIPT_SCHEMA, owner,
  continuationKey: `scheduled-taskgraph:sha256:${"a".repeat(64)}`, snapshotDigest: `sha256:${"b".repeat(64)}`,
  evidenceDigest: "c".repeat(64), checkpointDigest: "d".repeat(64), analyzeGraphRevision: 7,
  prepareScheduleRevision: 8, prepareWaitId: "wait-prepare-1", gateTaskId: "gate-task-1", gateAppendRevision: 11 })

function db(row: Record<string, unknown> | undefined) {
  const query = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 }))
  return { query, client: { query } as never }
}
function eventRow(value: unknown = receipt, overrides: Record<string, unknown> = {}) {
  return { itemId: null, taskId: null, actor: "system", idempotencyKey: scheduledGateRegistrationReceiptKey(receipt.continuationKey, receipt.gateTaskId),
    payload: value, hasOutbox: false, ...overrides }
}

describe("scheduled Gate registration receipt", () => {
  it("builds and parses only the bounded immutable lineage with the original Prepare wait", () => {
    expect(buildScheduledGateRegistrationReceipt(receipt)).toEqual(receipt)
    expect(parseScheduledGateRegistrationReceipt({ ...receipt, claimToken: "never-persist-this" })).toBeNull()
    expect(parseScheduledGateRegistrationReceipt({ ...receipt, owner: { ...owner, turnLeaseOwnerId: "transient" } })).toBeNull()
    expect(parseScheduledGateRegistrationReceipt({ ...receipt, prepareScheduleRevision: 9 })).toBeNull()
    expect(parseScheduledGateRegistrationReceipt({ ...receipt, gateAppendRevision: 8 })).toBeNull()
    expect(parseScheduledGateRegistrationReceipt({ ...receipt, prepareWaitId: "" })).toBeNull()
  })

  it("uses a stable idempotency key without exposing raw continuation data", () => {
    const first = scheduledGateRegistrationReceiptKey(receipt.continuationKey, receipt.gateTaskId)
    expect(first).toMatch(/^scheduled-gate-binding:[a-f0-9]{64}$/)
    expect(first).toBe(scheduledGateRegistrationReceiptKey(receipt.continuationKey, receipt.gateTaskId))
    expect(first).not.toContain(receipt.continuationKey)
  })

  it("reads only the unique private itemless system receipt for the exact owner and Gate", async () => {
    const valid = db(eventRow())
    await expect(readScheduledGateRegistrationReceipt(valid.client, { userId: owner.userId, sessionId: owner.sessionId,
      turnId: owner.turnId, owner, gateTaskId: receipt.gateTaskId })).resolves.toEqual(receipt)
    expect(valid.query.mock.calls[0]?.[0]).toContain('event."type" = $3')
    expect(valid.query.mock.calls[0]?.[1]?.[2]).toBe(SCHEDULED_GATE_REGISTRATION_RECEIPT_EVENT)

    for (const row of [
      eventRow(receipt, { itemId: "item-1" }), eventRow(receipt, { taskId: "task-1" }),
      eventRow(receipt, { actor: "orchestrator" }), eventRow(receipt, { hasOutbox: true }),
      eventRow(receipt, { idempotencyKey: "wrong-key" }), eventRow({ ...receipt, gateTaskId: "other-gate" }),
    ]) {
      await expect(readScheduledGateRegistrationReceipt(db(row).client, { userId: owner.userId, sessionId: owner.sessionId,
        turnId: owner.turnId, owner, gateTaskId: receipt.gateTaskId })).resolves.toBeNull()
    }
    await expect(readScheduledGateRegistrationReceipt(db(undefined).client, { userId: owner.userId, sessionId: owner.sessionId,
      turnId: owner.turnId, owner, gateTaskId: receipt.gateTaskId })).resolves.toBeNull()
  })

  it("rejects ambiguous receipts and owner/task mismatches", async () => {
    const duplicateQuery = vi.fn(async (_sql: string, _params?: readonly unknown[]) => ({ rows: [eventRow(), eventRow()], rowCount: 2 }))
    await expect(readScheduledGateRegistrationReceipt({ query: duplicateQuery } as never, { userId: owner.userId,
      sessionId: owner.sessionId, turnId: owner.turnId, owner, gateTaskId: receipt.gateTaskId })).resolves.toBeNull()
    const foreignOwner = { ...owner, rootTaskId: "other-root" }
    await expect(readScheduledGateRegistrationReceipt(db(eventRow()).client, { userId: owner.userId, sessionId: owner.sessionId,
      turnId: owner.turnId, owner: foreignOwner, gateTaskId: receipt.gateTaskId })).resolves.toBeNull()
  })
})
