import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TurnJobPayload, TurnLease } from "./lease.js"

const { claim, getClaim } = vi.hoisted(() => ({ claim: vi.fn(), getClaim: vi.fn() }))
vi.mock("./lease.js", async importOriginal => ({ ...(await importOriginal<typeof import("./lease.js")>()), claimTurnLease: claim }))
vi.mock("./approved-fill-terminal-claim.js", async importOriginal => ({
  ...(await importOriginal<typeof import("./approved-fill-terminal-claim.js")>()), getApprovedFillTerminalClaim: getClaim,
}))

import { TurnLeaseError } from "./lease.js"
import { claimTurnLeaseWithApprovedFillFallback, dispatchGenerationFromJobId } from "./turn-queue-admission.js"

const payload: TurnJobPayload = { turnId: "turn-1", sessionId: "session-1", ownerId: "owner-1" }
const lease: TurnLease = { ...payload, userId: "user-1", leaseVersion: 2, leaseStartedAt: new Date(0), leaseExpiresAt: new Date(60_000) }

describe("Turn queue admission", () => {
  beforeEach(() => { claim.mockReset(); getClaim.mockReset() })

  it("reads only a canonical generation for the exact Turn job ID", () => {
    const encoded = Buffer.from(payload.turnId, "utf8").toString("base64url")
    expect(dispatchGenerationFromJobId(`agent-turn-${encoded}-4`, payload.turnId)).toBe(4)
    for (const id of [undefined, 4, `agent-turn-${encoded}-04`, `agent-turn-${encoded}--1`, `agent-turn-${encoded}-9007199254740992`, "other-4"]) {
      expect(dispatchGenerationFromJobId(id, payload.turnId)).toBeUndefined()
    }
    expect(dispatchGenerationFromJobId(`agent-turn-${encoded}-1`, "different-turn")).toBeUndefined()
  })

  it("uses the approved Fill fallback only after lease_not_available and requires its marker", async () => {
    claim.mockRejectedValue(new TurnLeaseError("lease_not_available", "unavailable"))
    getClaim.mockReturnValue({ state: "form_filled" })
    const fallback = vi.fn(async () => lease)
    const result = await claimTurnLeaseWithApprovedFillFallback({ pool: {} as never, payload, now: new Date(0), leaseMs: 60_000,
      dispatchGeneration: 3, approvedFillFallback: fallback })
    expect(result).toBe(lease)
    expect(fallback).toHaveBeenCalledWith({ pool: {}, payload, now: expect.any(Date), leaseMs: 60_000, dispatchGeneration: 3 })

    getClaim.mockReturnValue(undefined)
    await expect(claimTurnLeaseWithApprovedFillFallback({ pool: {} as never, payload, now: new Date(0), leaseMs: 60_000,
      approvedFillFallback: fallback })).rejects.toThrow("approved_fill_terminal_claim_marker_missing")
  })

  it("preserves normal claims and does not invoke the fallback for other errors", async () => {
    claim.mockResolvedValue(lease)
    const fallback = vi.fn()
    await expect(claimTurnLeaseWithApprovedFillFallback({ pool: {} as never, payload, now: new Date(0), leaseMs: 60_000,
      approvedFillFallback: fallback })).resolves.toBe(lease)
    expect(fallback).not.toHaveBeenCalled()

    const failure = new Error("database unavailable")
    claim.mockRejectedValue(failure)
    await expect(claimTurnLeaseWithApprovedFillFallback({ pool: {} as never, payload, now: new Date(0), leaseMs: 60_000,
      approvedFillFallback: fallback })).rejects.toBe(failure)
    expect(fallback).not.toHaveBeenCalled()
  })
})
