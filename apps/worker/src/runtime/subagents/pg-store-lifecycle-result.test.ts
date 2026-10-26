import { describe, expect, it } from "vitest"
import type { StoredTaskGraphNode } from "./task-graph-snapshot.js"
import {
  plainObject,
  stripNonterminalDiscoveryRecovery,
  stripTaskGraphMetadata,
  taskGraphVerificationResult,
  unverifiedFailureReport,
} from "./pg-store-lifecycle-result.js"

describe("TaskGraph lifecycle result transformations", () => {
  it("parses only plain object result envelopes", () => {
    expect(plainObject('{"answer":42}')).toEqual({ answer: 42 })
    expect(plainObject("not json")).toBeNull()
    expect(plainObject([1, 2])).toBeNull()
    expect(plainObject(new Date(0))).toBeNull()
  })

  it("removes discovery recovery only for a retry or non-failure status", () => {
    const value = { answer: 42, discoveryRecovery: { attempt: 1 } }
    expect(stripNonterminalDiscoveryRecovery(value, "completed", false)).toEqual({ answer: 42 })
    expect(stripNonterminalDiscoveryRecovery(value, "failed", true)).toEqual({ answer: 42 })
    expect(stripNonterminalDiscoveryRecovery(value, "failed", false)).toBe(value)
  })

  it("strips reserved TaskGraph metadata recursively and breaks cycles", () => {
    const cycle: Record<string, unknown> = { answer: 1, taskGraphVerificationReport: { secret: true } }
    cycle.self = cycle
    expect(stripTaskGraphMetadata(cycle)).toEqual({ answer: 1, self: null })
    expect(stripTaskGraphMetadata({ nested: [{ taskGraphRepairReceipt: {}, keep: "yes" }] }))
      .toEqual({ nested: [{ keep: "yes" }] })
  })

  it("builds the server-owned verification envelope after stripping caller metadata", () => {
    const report = { status: "unverified", reasonCode: "result_invalid" }
    expect(taskGraphVerificationResult({
      answer: 42,
      structuredResult: { callerValue: true },
      taskGraphVerificationReport: { callerValue: true },
      nested: { verificationReport: { callerValue: true } },
    }, report, undefined, null)).toEqual({
      answer: 42,
      nested: {},
      taskGraphVerificationReport: report,
    })
    expect(taskGraphVerificationResult("plain result", report, { bound: true }, null)).toEqual({
      workerResult: "plain result",
      structuredResult: { bound: true },
      taskGraphVerificationReport: report,
    })
  })

  it("creates unverified reports from the node's typed verification criteria", () => {
    const typed = {
      verificationDisposition: "typed",
      verification: { criteria: [{ id: "candidate-count" }, { id: "evidence-count" }] },
    } as unknown as StoredTaskGraphNode
    const untyped = { verificationDisposition: "legacy" } as unknown as StoredTaskGraphNode

    expect(unverifiedFailureReport(typed)).toMatchObject({
      status: "unverified", reasonCode: "result_invalid",
      criteria: [
        { criterionId: "candidate-count", status: "unverified", reasonCode: "result_invalid" },
        { criterionId: "evidence-count", status: "unverified", reasonCode: "result_invalid" },
      ],
      evidenceDigest: null, resultDigest: null,
    })
    expect(unverifiedFailureReport(untyped)).toMatchObject({ status: "unverified", reasonCode: "contract_invalid", criteria: [] })
  })
})
