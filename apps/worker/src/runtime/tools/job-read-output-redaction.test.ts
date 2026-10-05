import { describe, expect, it } from "vitest"
import { redactSensitiveValue } from "@jobcopilot/shared"

import { redactJobReadOutput } from "./job-read-output-redaction.js"

const JOB_CUID = "c123456789012345678901234"
const NUMERIC_UUID_V4 = "00000000-0000-4000-8000-000000000000"
const PHONE_LIKE = "+353 87 123 4567"
const PREFIXED_FIXTURE_ID = "p3-discovery-failure-job-" + NUMERIC_UUID_V4

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
