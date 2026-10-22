import { describe, expect, it } from "vitest"

import { adaptLegacyRoleResult } from "./legacy-adapter.js"
import { ROLE_RESULT_SCHEMA, roleResultOutputSchema, structuredRoleOutputGuidance, validateRoleResult, RoleResultValidationError } from "./role-results.js"

const evidence = [{ id: "ev-job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" }]

function validScoutResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "scout" as const,
    status: "completed" as const,
    candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://example.test/job-1", evidenceIds: ["ev-job-1"] }],
    evidence,
    summary: "one candidate",
  }
}

function validAnalystResult() {
  return {
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "analyst" as const,
    status: "partial" as const,
    findings: [{ jobId: "job-1", score: 8.5, evidenceIds: ["ev-job-1"] }],
    evidence,
    summary: "one finding",
  }
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value }
  delete copy[key]
  return copy
}

function expectInvalidShape(value: unknown): void {
  let caught: unknown
  try { validateRoleResult(value) } catch (error: unknown) { caught = error }
  expect(caught).toBeInstanceOf(RoleResultValidationError)
  expect(caught).toMatchObject({ code: "invalid_shape" })
}

describe("structured Scout and Analyst results", () => {
  it("accepts real ids and linked job evidence", () => {
    expect(validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "job-1", source: "greenhouse", url: "https://example.test/job-1", evidenceIds: ["ev-job-1"] }], evidence, summary: "one candidate" }, "scout").role).toBe("scout")
    expect(validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "partial", findings: [{ jobId: "job-1", score: 8.5, evidenceIds: ["ev-job-1"] }], evidence, summary: "one finding" }, "analyst").status).toBe("partial")
  })

  it("rejects missing ids, dangling evidence, and non-job evidence", () => {
    expect(() => validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed", candidates: [{ jobId: "", source: "greenhouse", url: null, evidenceIds: ["ev-job-1"] }], evidence, summary: "bad" })).toThrow(RoleResultValidationError)
    expect(() => validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 4, evidenceIds: ["missing"] }], evidence, summary: "bad" })).toThrow(/unknown evidence/)
    expect(() => validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 4, evidenceIds: ["ev-persona"] }], evidence: [{ id: "ev-persona", kind: "persona", ref: "fact-1", source: "persona" }], summary: "bad" })).toThrow(/job evidence/)
  })

  it("rejects scores outside the contract", () => {
    expect(() => validateRoleResult({ schemaVersion: "agent-harness.v2.subagent.result", role: "analyst", status: "completed", findings: [{ jobId: "job-1", score: 11, evidenceIds: ["ev-job-1"] }], evidence, summary: "bad" })).toThrow(/score from 0 to 10/)
  })

  it.each([
    { name: "Scout top level", value: { ...validScoutResult(), extra: "unexpected" } },
    { name: "Analyst top level", value: { ...validAnalystResult(), extra: "unexpected" } },
    { name: "evidence", value: { ...validScoutResult(), evidence: [{ ...evidence[0], extra: "unexpected" }] } },
    { name: "candidate", value: { ...validScoutResult(), candidates: [{ ...validScoutResult().candidates[0], extra: "unexpected" }] } },
    { name: "finding", value: { ...validAnalystResult(), findings: [{ ...validAnalystResult().findings[0], extra: "unexpected" }] } },
  ])("rejects extra keys in $name", ({ value }) => {
    expectInvalidShape(value)
  })

  it.each([
    { name: "Scout summary", value: withoutKey(validScoutResult(), "summary") },
    { name: "Analyst findings", value: withoutKey(validAnalystResult(), "findings") },
    { name: "evidence source", value: { ...validScoutResult(), evidence: [withoutKey(evidence[0]!, "source")] } },
    { name: "candidate source", value: { ...validScoutResult(), candidates: [withoutKey(validScoutResult().candidates[0]!, "source")] } },
    { name: "finding evidenceIds", value: { ...validAnalystResult(), findings: [withoutKey(validAnalystResult().findings[0]!, "evidenceIds")] } },
  ])("rejects missing keys in $name", ({ value }) => {
    expectInvalidShape(value)
  })

  it.each([
    { name: "top-level nested userId", value: { ...validScoutResult(), metadata: { userId: "forged-user" } } },
    { name: "evidence nested sessionId", value: { ...validScoutResult(), evidence: [{ ...evidence[0], metadata: { sessionId: "forged-session" } }] } },
    { name: "candidate nested turnId", value: { ...validScoutResult(), candidates: [{ ...validScoutResult().candidates[0], metadata: { turnId: "forged-turn" } }] } },
    { name: "finding nested taskId", value: { ...validAnalystResult(), findings: [{ ...validAnalystResult().findings[0], metadata: { taskId: "forged-task" } }] } },
    { name: "array nested permissions", value: { ...validScoutResult(), metadata: [[{ permissions: ["admin"] }]] } },
    { name: "array nested allowedCapabilities", value: { ...validAnalystResult(), metadata: [{ policy: { allowedCapabilities: ["write"] } }] } },
  ])("rejects $name", ({ value }) => {
    expectInvalidShape(value)
  })

  it.each([
    {
      name: "a cyclic object",
      value: (() => {
        const cycle: Record<string, unknown> = {}
        cycle.self = cycle
        return { ...validScoutResult(), metadata: cycle }
      })(),
    },
    { name: "a non-plain object", value: { ...validScoutResult(), metadata: new Date("2026-01-01T00:00:00.000Z") } },
    { name: "NaN", value: { ...validAnalystResult(), findings: [{ ...validAnalystResult().findings[0], score: Number.NaN }] } },
    { name: "Infinity", value: { ...validAnalystResult(), findings: [{ ...validAnalystResult().findings[0], score: Number.POSITIVE_INFINITY }] } },
  ])("rejects $name in the result JSON", ({ value }) => {
    expectInvalidShape(value)
  })

  it("accepts nested business arrays, all evidence kinds, and legacy adapter output", () => {
    const allEvidence = [
      { id: "ev-job-1", kind: "job" as const, ref: "job-1", source: "greenhouse" },
      { id: "ev-persona-1", kind: "persona" as const, ref: "persona:target", source: "persona" },
      { id: "ev-resume-1", kind: "resume" as const, ref: "resume:base", source: "resume" },
      { id: "ev-source-1", kind: "source" as const, ref: "source:search", source: "lever" },
    ]
    const scout = { ...validScoutResult(), evidence: allEvidence, candidates: [{ ...validScoutResult().candidates[0], evidenceIds: allEvidence.map(item => item.id) }] }
    const analyst = { ...validAnalystResult(), evidence: allEvidence, findings: [{ ...validAnalystResult().findings[0], evidenceIds: allEvidence.map(item => item.id) }] }
    expect(validateRoleResult(scout, "scout").evidence).toHaveLength(4)
    expect(validateRoleResult(analyst, "analyst").evidence).toHaveLength(4)
    expect(validateRoleResult(adaptLegacyRoleResult("scout", { jobs: [{ id: "job-1", source: "lever", url: "https://example.test/job-1" }] }), "scout").role).toBe("scout")
    expect(validateRoleResult(adaptLegacyRoleResult("analyst", { analyses: [{ jobId: "job-1", score: 7 }] }), "analyst").role).toBe("analyst")
  })
})

describe("structured cover letter artifact results", () => {
  const artifactRef = { artifactId: "artifact-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }

  it("accepts only a persisted Writer artifact reference", () => {
    expect(validateRoleResult({ schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef }, "writer"))
      .toEqual({ schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef })
  })

  it("accepts a hash-bound Reviewer receipt without body or findings", () => {
    expect(validateRoleResult({ schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash: `sha256:${"c".repeat(64)}` }, "reviewer"))
      .toMatchObject({ role: "reviewer", artifactRef, reviewStatus: "passed" })
  })

  it.each([
    { name: "unbound artifact hash", value: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef: { ...artifactRef, contentHash: "arbitrary" } } },
    { name: "draft content", value: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef, content: "Dear Hiring Manager" } },
    { name: "tenant identity", value: { schemaVersion: ROLE_RESULT_SCHEMA, role: "writer", status: "completed", artifactRef, userId: "user-1" } },
    { name: "unbounded review findings", value: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "passed", reviewHash: `sha256:${"c".repeat(64)}`, findings: ["details"] } },
    { name: "unknown review status", value: { schemaVersion: ROLE_RESULT_SCHEMA, role: "reviewer", status: "completed", artifactRef, reviewStatus: "invented", reviewHash: `sha256:${"c".repeat(64)}` } },
  ])("rejects $name", ({ value }) => expectInvalidShape(value))
})

describe("structured scheduled Prepare results", () => {
  const artifactRef = { artifactId: "artifact-resume-1", version: 2, contentHash: `sha256:${"a".repeat(64)}`, sourceDigest: `sha256:${"b".repeat(64)}` }
  const validPrepareResult = () => ({
    schemaVersion: ROLE_RESULT_SCHEMA,
    role: "prepare",
    status: "completed",
    taskId: "prepare-task-1",
    attemptCount: 2,
    snapshotDigest: `sha256:${"c".repeat(64)}`,
    checkpointDigest: "d".repeat(64),
    jobs: [{ jobId: "job-1", status: "prepared" }, { jobId: "job-2", status: "skipped" }],
    materials: [{ jobId: "job-1", kind: "resume", artifactRef }],
  })

  it("accepts only status, binding digests, and immutable material references", () => {
    expect(validateRoleResult(validPrepareResult(), "prepare")).toEqual(validPrepareResult())
    expect(roleResultOutputSchema("prepare")).toMatchObject({
      properties: {
        role: { const: "prepare" }, taskId: { type: "string" }, attemptCount: { minimum: 1 }, jobs: { maxItems: 50 },
        materials: { maxItems: 100, items: { properties: { artifactRef: { properties: { artifactId: { maxLength: 128 } } } } } },
      },
      additionalProperties: false,
    })
    const guidance = structuredRoleOutputGuidance("prepare", { schemaVersion: ROLE_RESULT_SCHEMA, role: "prepare" })
    expect(guidance).toContain("scheduled.application.prepare")
    expect(guidance).toContain("server independently rebinds task, attempt, job IDs")
    expect(guidance).toContain("Never include scores")
  })

  it("accepts the completed zero-eligible-jobs result", () => {
    expect(validateRoleResult({
      ...validPrepareResult(), jobs: [], materials: [],
    }, "prepare")).toMatchObject({ role: "prepare", status: "completed", taskId: "prepare-task-1", attemptCount: 2, jobs: [], materials: [] })
  })

  it("rejects sparse job arrays and enumerable array extras", () => {
    const sparse = new Array<unknown>(2)
    sparse[1] = { jobId: "job-1", status: "prepared" }
    const withExtra: unknown[] = [{ jobId: "job-1", status: "prepared" }]
    Object.assign(withExtra, { status: "failed" })
    expectInvalidShape({ ...validPrepareResult(), jobs: sparse })
    expectInvalidShape({ ...validPrepareResult(), jobs: withExtra })
  })

  it.each([
    ["model score", { ...validPrepareResult(), jobs: [{ jobId: "job-1", status: "prepared", score: 95 }] }],
    ["missing task binding", (() => { const { taskId: _taskId, ...value } = validPrepareResult(); return value })()],
    ["missing attempt binding", (() => { const { attemptCount: _attemptCount, ...value } = validPrepareResult(); return value })()],
    ["invalid attempt binding", { ...validPrepareResult(), attemptCount: 0 }],
    ["user identity", { ...validPrepareResult(), userId: "user-1" }],
    ["schedule configuration", { ...validPrepareResult(), config: { minScore: 70 } }],
    ["resume body", { ...validPrepareResult(), materials: [{ jobId: "job-1", kind: "resume", artifactRef, content: "private resume" }] }],
    ["letter body", { ...validPrepareResult(), letter: "private letter" }],
    ["unknown job binding", { ...validPrepareResult(), materials: [{ jobId: "job-3", kind: "resume", artifactRef }] }],
    ["material for skipped job", { ...validPrepareResult(), materials: [{ jobId: "job-2", kind: "resume", artifactRef }] }],
    ["duplicate job", { ...validPrepareResult(), jobs: [{ jobId: "job-1", status: "prepared" }, { jobId: "job-1", status: "skipped" }] }],
    ["duplicate artifact kind", { ...validPrepareResult(), materials: [{ jobId: "job-1", kind: "resume", artifactRef }, { jobId: "job-1", kind: "resume", artifactRef }] }],
    ["invalid job status", { ...validPrepareResult(), jobs: [{ jobId: "job-1", status: "ready" }] }],
    ["failed result marked completed", { ...validPrepareResult(), jobs: [{ jobId: "job-1", status: "failed" }] }],
    ["partial result without failed job", { ...validPrepareResult(), status: "partial" }],
    ["malformed checkpoint digest", { ...validPrepareResult(), checkpointDigest: `sha256:${"d".repeat(64)}` }],
    ["malformed snapshot digest", { ...validPrepareResult(), snapshotDigest: "c".repeat(64) }],
    ["malformed material reference", { ...validPrepareResult(), materials: [{ jobId: "job-1", kind: "resume", artifactRef: { ...artifactRef, sourceDigest: "arbitrary" } }] }],
  ])("rejects %s", (_name, value) => expectInvalidShape(value))
})
