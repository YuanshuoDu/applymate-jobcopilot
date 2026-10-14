import { describe, expect, it } from "vitest"
import { redactSensitiveValue } from "@jobcopilot/shared"

import { redactJobReadOutput } from "./job-read-output-redaction.js"

const JOB_CUID = "c123456789012345678901234"
const NUMERIC_UUID_V4 = "00000000-0000-4000-8000-000000000000"
const PHONE_LIKE = "+353 87 123 4567"
const PREFIXED_FIXTURE_ID = "p3-discovery-failure-job-" + NUMERIC_UUID_V4

function discoverOutput() {
  return {
    jobs: [{
      id: JOB_CUID, title: "Engineer", company: "Example", location: "Dublin", url: "https://jobs.example/1",
      description: PHONE_LIKE, fullDescription: "Role details", salary: null, logo: null, source: "greenhouse",
      evidenceRefs: [NUMERIC_UUID_V4],
    }],
    evidence: [{
      evidenceId: NUMERIC_UUID_V4, jobId: JOB_CUID, kind: "source", source: "greenhouse",
      url: "https://jobs.example/1", summary: "Call " + PHONE_LIKE,
    }],
    nextCursor: null,
    usage: {
      ledgerKey: "ledger-1", toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-1",
      sessionId: "session-1", turnId: "turn-1", stepId: "step-1", requests: 1,
      jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0, aiCalls: 0, providers: ["greenhouse"],
      estimatedCostUsd: 0, durationMs: 10,
    },
  }
}

describe("job read output redaction", () => {
  it("preserves CUID and UUIDv4 IDs only at jobs.search paths", () => {
    const safe = redactJobReadOutput("jobs.search", {
      jobs: [
        {
          id: JOB_CUID,
          description: "Contact us at " + PHONE_LIKE,
          privateValue: "candidate work authorization details",
          metadata: { id: NUMERIC_UUID_V4 },
        },
        { id: NUMERIC_UUID_V4, description: "Backend Engineer" },
      ],
      page: 1,
      hasMore: false,
      id: NUMERIC_UUID_V4,
    })

    expect(safe).toEqual({
      jobs: [
        {
          id: JOB_CUID,
          description: "Contact us at [REDACTED_PHONE]",
          privateValue: "[REDACTED]",
          metadata: { id: "[REDACTED_PHONE]" },
        },
        { id: NUMERIC_UUID_V4, description: "Backend Engineer" },
      ],
      page: 1,
      hasMore: false,
      id: "[REDACTED_PHONE]",
    })
  })

  it("preserves numeric UUIDv4 at jobs.get while redacting the same value at other paths", () => {
    expect(redactSensitiveValue(NUMERIC_UUID_V4)).toBe("[REDACTED_PHONE]")

    const safe = redactJobReadOutput("jobs.get", {
      job: {
        id: NUMERIC_UUID_V4,
        description: "Email recruiter@example.com for details",
        privateValue: "candidate notes",
        metadata: { id: NUMERIC_UUID_V4 },
      },
      nested: { id: NUMERIC_UUID_V4 },
      id: PHONE_LIKE,
    })

    expect(safe).toEqual({
      job: {
        id: NUMERIC_UUID_V4,
        description: "Email [REDACTED_EMAIL] for details",
        privateValue: "[REDACTED]",
        metadata: { id: "[REDACTED_PHONE]" },
      },
      nested: { id: "[REDACTED_PHONE]" },
      id: "[REDACTED_PHONE]",
    })
  })

  it("preserves canonical jobs.discover IDs only at job and evidence reference paths", () => {
    const safe = redactJobReadOutput("jobs.discover", discoverOutput())

    expect(safe).toEqual({
      jobs: [{
        id: JOB_CUID, title: "Engineer", company: "Example", location: "Dublin", url: "https://jobs.example/1",
        description: "[REDACTED_PHONE]", fullDescription: "Role details", salary: null, logo: null,
        source: "greenhouse", evidenceRefs: ["[REDACTED_PHONE]"],
      }],
      evidence: [{
        evidenceId: "[REDACTED_PHONE]", jobId: JOB_CUID, kind: "source", source: "greenhouse",
        url: "https://jobs.example/1", summary: "Call [REDACTED_PHONE]",
      }],
      nextCursor: null,
      usage: {
        ledgerKey: "ledger-1", toolName: "jobs.discover", toolVersion: "1", toolCallId: "call-1",
        sessionId: "session-1", turnId: "turn-1", stepId: "step-1", requests: 1,
        jobsProcessed: 1, jobsSucceeded: 1, jobsFailed: 0, aiCalls: 0, providers: ["greenhouse"],
        estimatedCostUsd: 0, durationMs: 10,
      },
    })
  })

  it("allows the optional providerFailures usage field", () => {
    const output = discoverOutput()
    Object.assign(output.usage, { providerFailures: 1 })
    expect(redactJobReadOutput("jobs.discover", output)).not.toBe("[REDACTED]")
  })

  it("fails closed for unknown or missing discover object fields", () => {
    const extraTopLevel = discoverOutput()
    Object.assign(extraTopLevel, { unexpected: "private" })
    expect(redactJobReadOutput("jobs.discover", extraTopLevel)).toBe("[REDACTED]")

    const extraJobField = discoverOutput()
    Object.assign(extraJobField.jobs[0]!, { unexpected: "private" })
    expect(redactJobReadOutput("jobs.discover", extraJobField)).toBe("[REDACTED]")

    const missingJobField = discoverOutput()
    Reflect.deleteProperty(missingJobField.jobs[0], "fullDescription")
    expect(redactJobReadOutput("jobs.discover", missingJobField)).toBe("[REDACTED]")

    const extraUsageField = discoverOutput()
    Object.assign(extraUsageField.usage, { unexpected: "private" })
    expect(redactJobReadOutput("jobs.discover", extraUsageField)).toBe("[REDACTED]")
  })

  it("fails closed when discover values exceed the declared shape bounds", () => {
    const tooManyJobs = discoverOutput()
    tooManyJobs.jobs.push(...Array.from({ length: 50 }, () => tooManyJobs.jobs[0]!))
    expect(redactJobReadOutput("jobs.discover", tooManyJobs)).toBe("[REDACTED]")

    const tooLongText = discoverOutput()
    tooLongText.jobs[0]!.title = "x".repeat(501)
    expect(redactJobReadOutput("jobs.discover", tooLongText)).toBe("[REDACTED]")

    const badUsage = discoverOutput()
    badUsage.usage.jobsFailed = -1
    expect(redactJobReadOutput("jobs.discover", badUsage)).toBe("[REDACTED]")
  })

  it("fails closed for malformed discovery evidence or job references", () => {
    const unboundEvidence = discoverOutput()
    unboundEvidence.evidence[0]!.jobId = NUMERIC_UUID_V4
    expect(redactJobReadOutput("jobs.discover", unboundEvidence)).toBe("[REDACTED]")

    const evidenceMissing = discoverOutput()
    evidenceMissing.evidence = []
    expect(redactJobReadOutput("jobs.discover", evidenceMissing)).toBe("[REDACTED]")

    const evidenceRefMismatch = discoverOutput()
    evidenceRefMismatch.jobs[0]!.evidenceRefs = ["unrelated-evidence"]
    expect(redactJobReadOutput("jobs.discover", evidenceRefMismatch)).toBe("[REDACTED]")

    const duplicateJobs = discoverOutput()
    duplicateJobs.jobs.push({ ...duplicateJobs.jobs[0]! })
    expect(redactJobReadOutput("jobs.discover", duplicateJobs)).toBe("[REDACTED]")
  })

  it("allows a missing job result without creating an ID exception", () => {
    expect(redactJobReadOutput("jobs.get", { job: null })).toEqual({ job: null })
  })

  it("fails closed for phone-like, prefixed fixture, and noncanonical IDs", () => {
    expect(redactJobReadOutput("jobs.search", {
      jobs: [{ id: PHONE_LIKE }],
      page: 1,
      hasMore: false,
    })).toBe("[REDACTED]")

    expect(redactJobReadOutput("jobs.get", {
      job: { id: PREFIXED_FIXTURE_ID },
    })).toBe("[REDACTED]")

    expect(redactJobReadOutput("jobs.get", {
      job: { id: "job-1" },
    })).toBe("[REDACTED]")
  })

  it("fails closed when the tool name or exact identifier path is unknown", () => {
    expect(redactJobReadOutput("jobs.lookup", { job: { id: JOB_CUID } })).toBe("[REDACTED]")
    expect(redactJobReadOutput("jobs.search", { results: [{ id: JOB_CUID }] })).toBe("[REDACTED]")
    expect(redactJobReadOutput("jobs.search", {
      jobs: [{ nested: { id: JOB_CUID } }],
      page: 1,
      hasMore: false,
    })).toBe("[REDACTED]")
  })
})
