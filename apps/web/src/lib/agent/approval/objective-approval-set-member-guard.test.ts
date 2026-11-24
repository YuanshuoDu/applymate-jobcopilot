import { describe, expect, it } from "vitest"

import { assertNotObjectiveApprovalSetMember } from "./objective-approval-set-member-guard"

const FAMILY = "objective-application-approval-set-member"

function caught(payload: unknown): unknown {
  try { assertNotObjectiveApprovalSetMember(payload); return undefined } catch (error: unknown) { return error }
}

describe("generic approval set member guard", () => {
  it.each([
    ["the supported member envelope", { schema: `${FAMILY}.v1`, setId: "set-1" }],
    ["an unsupported version", { schema: `${FAMILY}.v2`, setId: "set-1" }],
    ["a truncated version marker", { schema: `${FAMILY}.` }],
    ["a malformed family suffix", { schema: `${FAMILY}-v1` }],
  ])("rejects %s", (_label, payload) => {
    expect(caught(payload)).toMatchObject({ code: "approval_not_approved" })
  })

  it("preserves ordinary payloads and unrelated schemas", () => {
    expect(() => assertNotObjectiveApprovalSetMember({ jobId: "job-1" })).not.toThrow()
    expect(() => assertNotObjectiveApprovalSetMember({ schema: "ordinary-review.v1", setId: "set-1" })).not.toThrow()
    expect(() => assertNotObjectiveApprovalSetMember(null)).not.toThrow()
  })

  it("fails closed on an accessor marker without invoking it", () => {
    let invoked = false
    const payload = Object.defineProperty({}, "schema", {
      enumerable: true,
      get: () => { invoked = true; return `${FAMILY}.v1` },
    })
    expect(caught(payload)).toMatchObject({ code: "approval_not_approved" })
    expect(invoked).toBe(false)
  })
})
