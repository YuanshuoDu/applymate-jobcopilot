import { describe, expect, it, vi } from "vitest"

import { createPlanRevisionRecoveryDispatcher, PlanRevisionRecoveryError, parsePlanRevisionEvent, parsePlanRevisionReceipt, planRevisionObservation, recoverPlanRevision } from "./plan-revision-receipt.js"
import { fingerprintPlanProposal } from "./plan-fingerprint.js"

const proposal = { schemaVersion: "agent-harness.plan.v1" as const, basedOnGoalRevision: 1, basedOnPlanRevision: null, nodes: [], completionCriteria: [], briefRationale: "bounded" }
const accepted = { status: "accepted", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null, proposal, intents: [] }
const acceptedWithHash = { ...accepted, proposalHash: fingerprintPlanProposal(proposal) }

describe("plan revision receipt", () => {
  it("parses accepted output with a server supplied call id", () => {
    const receipt = parsePlanRevisionReceipt(accepted, "call-1")
    expect(receipt).toEqual({ planCallId: "call-1", goalRevision: 1, planRevision: 1, basedOnPlanRevision: null })
  })

  it("parses and preserves a validated proposal hash while accepting legacy output without one", () => {
    expect(parsePlanRevisionReceipt(acceptedWithHash, "call-hash")).toMatchObject({ proposalHash: acceptedWithHash.proposalHash })
    expect(parsePlanRevisionReceipt(accepted, "call-hash", { requireProposalHash: true })).toBeNull()
    expect(parsePlanRevisionReceipt({ ...acceptedWithHash, proposalHash: `sha256:${"a".repeat(64)}` }, "call-hash")).toBeNull()
  })

  it("rejects malformed, non-finite, unknown, and broken CAS metadata", () => {
    expect(parsePlanRevisionReceipt({ ...accepted, planRevision: 2 }, "call-1")).toBeNull()
    expect(parsePlanRevisionReceipt({ ...accepted, extra: "identity" }, "call-1")).toBeNull()
    expect(parsePlanRevisionReceipt({ ...accepted, goalRevision: Number.NaN }, "call-1")).toBeNull()
    expect(parsePlanRevisionEvent({ planCallId: "call-1", goalRevision: 1, planRevision: 2, basedOnPlanRevision: null })).toBeNull()
  })

  it("parses event metadata and emits a compact observation", () => {
    const receipt = parsePlanRevisionEvent({ planCallId: "call-2", goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: acceptedWithHash.proposalHash })!
    expect(planRevisionObservation(receipt)).toEqual({ id: "plan-revision:call-2", content: { kind: "plan_revision", ...receipt } })
  })

  it("dispatches only server-owned recovery metadata to registered handlers", () => {
    const handler = vi.fn()
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    dispatcher.register(handler)
    dispatcher.recover({ goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: acceptedWithHash.proposalHash })
    expect(handler).toHaveBeenCalledWith({ goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1, proposalHash: acceptedWithHash.proposalHash })
    expect(handler.mock.calls[0]?.[0]).not.toHaveProperty("planCallId")
  })

  it("accepts only a contiguous recovery cursor and maps handler failures to invalid_output", () => {
    const first = { goalRevision: 1, planRevision: 1, basedOnPlanRevision: null }
    const second = { goalRevision: 1, planRevision: 2, basedOnPlanRevision: 1 }
    expect(recoverPlanRevision(null, first)).toBe(1)
    expect(recoverPlanRevision(1, second)).toBe(2)
    expect(recoverPlanRevision(1, first)).toBe(1)
    expect(() => recoverPlanRevision(null, second)).toThrow(PlanRevisionRecoveryError)
    expect(() => recoverPlanRevision(1, { ...second, planRevision: 3, basedOnPlanRevision: 2 })).toThrow(PlanRevisionRecoveryError)
    expect(() => recoverPlanRevision(2, { ...first, proposalHash: acceptedWithHash.proposalHash })).toThrow(PlanRevisionRecoveryError)

    const dispatcher = createPlanRevisionRecoveryDispatcher()
    dispatcher.register(() => { throw new Error("recovery failed") })
    expect(() => dispatcher.recover(first)).toThrowError(expect.objectContaining({ code: "invalid_output" }))
  })

  it("does not commit an earlier recovery transition when a later handler fails", () => {
    let state = 0
    const dispatcher = createPlanRevisionRecoveryDispatcher()
    dispatcher.register(() => ({ commit: () => { state = 1 }, rollback: () => { state = 0 } }))
    dispatcher.register(() => { throw new Error("second recovery handler failed") })
    expect(() => dispatcher.recover({ goalRevision: 1, planRevision: 1, basedOnPlanRevision: null })).toThrowError(expect.objectContaining({ code: "invalid_output" }))
    expect(state).toBe(0)
  })
})
