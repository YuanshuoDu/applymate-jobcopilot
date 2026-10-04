import { describe, expect, it } from "vitest"

import {
  evaluateTaskGraphVerification,
  TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
  TASK_GRAPH_VERIFICATION_SCHEMA_VERSION,
  validateTaskGraphVerificationContract,
  type TaskGraphVerificationContract,
  type TaskGraphVerificationEvidenceProjection,
} from "./task-graph-verification.js"

function contract(role: "scout" | "analyst", criteria: unknown[] = [{ id: "minimum-results", check: { kind: role === "scout" ? "candidate_count_gte" : "finding_count_gte", minimum: 1 } }]) {
  return { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role, criteria }
}

function validatedContract(role: "scout" | "analyst", criteria: unknown[]): TaskGraphVerificationContract {
  const result = validateTaskGraphVerificationContract(contract(role, criteria), role)
  if (!result.ok) throw new Error("test_contract_invalid")
  return result.contract
}

describe("TaskGraph typed verification contract", () => {
  it.each([
    ["scout", "scout", { kind: "candidate_count_gte", minimum: 2 }],
    ["analyst", "analyst", { kind: "finding_count_gte", minimum: 1 }],
  ] as const)("accepts bounded predicates for the registered %s template", (templateId, role, check) => {
    expect(validateTaskGraphVerificationContract(contract(role, [{ id: "result-count", check }]), templateId))
      .toMatchObject({ ok: true, contract: { schemaVersion: TASK_GRAPH_VERIFICATION_SCHEMA_VERSION, role, criteria: [{ id: "result-count", check }] } })
  })

  it("allows only role-appropriate checks and rejects a role/template mismatch", () => {
    expect(validateTaskGraphVerificationContract(contract("scout", [{ id: "score", check: { kind: "reported_score_gte", minimumScore: 7, minimumFindings: 1, aggregation: "any" } }]), "scout"))
      .toMatchObject({ ok: false, error: { code: "unknown_check" } })
    expect(validateTaskGraphVerificationContract(contract("analyst"), "scout"))
      .toMatchObject({ ok: false, error: { code: "role_mismatch", path: "verification.role" } })
    expect(validateTaskGraphVerificationContract(contract("scout"), "writer"))
      .toMatchObject({ ok: false, error: { code: "unsupported_template" } })
  })

  it("requires unique stable criterion IDs and rejects unknown or malformed contract fields", () => {
    expect(validateTaskGraphVerificationContract(contract("scout", [
      { id: "same", check: { kind: "candidate_count_gte", minimum: 1 } },
      { id: "same", check: { kind: "evidence_count_gte", minimum: 1 } },
    ]), "scout")).toMatchObject({ ok: false, error: { code: "duplicate_id", path: "verification.criteria[1].id" } })
    expect(validateTaskGraphVerificationContract(contract("scout", [{ id: "not stable", check: { kind: "candidate_count_gte", minimum: 1 } }]), "scout"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphVerificationContract({ ...contract("scout"), extra: true }, "scout"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    expect(validateTaskGraphVerificationContract(contract("scout", []), "scout"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
  })

  it("bounds counts and requires per-item evidence checks to be non-vacuous", () => {
    for (const check of [
      { kind: "candidate_count_gte", minimum: 0 },
      { kind: "candidate_count_gte", minimum: 51 },
      { kind: "all_candidates_have_evidence", minimumItems: 0 },
      { kind: "all_candidates_have_evidence", minimumItems: 51 },
      { kind: "evidence_count_gte", minimum: 0 },
    ]) {
      expect(validateTaskGraphVerificationContract(contract("scout", [{ id: "bounded", check }]), "scout"))
        .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    }
  })

  it("labels score checks as reported-score predicates and bounds threshold and nonempty finding scope", () => {
    const valid = { kind: "reported_score_gte", minimumScore: 7.5, minimumFindings: 1, aggregation: "any" }
    expect(validateTaskGraphVerificationContract(contract("analyst", [{ id: "reported-score", check: valid }]), "analyst"))
      .toMatchObject({ ok: true, contract: { criteria: [{ check: valid }] } })
    for (const check of [
      { ...valid, minimumScore: 10.1 },
      { ...valid, minimumScore: Number.NaN },
      { ...valid, minimumFindings: 0 },
      { ...valid, aggregation: "latest" },
    ]) {
      expect(validateTaskGraphVerificationContract(contract("analyst", [{ id: "reported-score", check }]), "analyst"))
        .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    }
  })

  it("rejects sparse criteria arrays rather than skipping missing entries", () => {
    const sparse = new Array(1)
    expect(validateTaskGraphVerificationContract(contract("scout", sparse), "scout"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    const hostile = new Proxy([], { ownKeys: () => { throw new Error("untrusted proxy") } })
    expect(validateTaskGraphVerificationContract(contract("scout", hostile), "scout"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
    const accessor = Object.defineProperty({}, "kind", { get: () => { throw new Error("untrusted getter") } })
    expect(validateTaskGraphVerificationContract(contract("scout", [{ id: "hostile", check: accessor }]), "scout"))
      .toMatchObject({ ok: false, error: { code: "invalid_shape" } })
  })
})

function canonicalEvidence(kind: "job" | "persona" | "resume", ref: string): string {
  return `read:${kind}:${ref}`
}

function scoutProjection(): TaskGraphVerificationEvidenceProjection {
  const jobOne = canonicalEvidence("job", "job-1")
  const jobTwo = canonicalEvidence("job", "job-2")
  const fact = canonicalEvidence("persona", "fact-1")
  return {
    schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    role: "scout",
    candidates: [
      { jobId: "job-1", evidenceIds: [jobOne] },
      { jobId: "job-2", evidenceIds: [jobTwo, fact] },
    ],
    evidenceIds: [jobOne, jobTwo, fact],
  }
}

function analystProjection(): TaskGraphVerificationEvidenceProjection {
  const jobOne = canonicalEvidence("job", "job-1")
  const jobTwo = canonicalEvidence("job", "job-2")
  const fact = canonicalEvidence("persona", "fact-1")
  return {
    schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
    role: "analyst",
    findings: [
      { jobId: "job-1", score: 8.25, evidenceIds: [jobOne, fact] },
      { jobId: "job-2", score: 4, evidenceIds: [jobTwo] },
    ],
    evidenceIds: [jobOne, jobTwo, fact],
  }
}

describe("TaskGraph durable evidence verification", () => {
  it("evaluates Scout counts only after candidate evidence IDs bind to canonical persisted evidence", () => {
    const scout = scoutProjection()
    const typed = validatedContract("scout", [
      { id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 2 } },
      { id: "evidence-count", check: { kind: "evidence_count_gte", minimum: 3 } },
      { id: "candidate-evidence", check: { kind: "all_candidates_have_evidence", minimumItems: 2 } },
    ])

    expect(evaluateTaskGraphVerification(typed, scout)).toEqual({
      status: "passed", reasonCode: "criteria_met",
      criteria: [
        { criterionId: "candidate-count", status: "passed", reasonCode: "criteria_met" },
        { criterionId: "evidence-count", status: "passed", reasonCode: "criteria_met" },
        { criterionId: "candidate-evidence", status: "passed", reasonCode: "criteria_met" },
      ],
    })
  })

  it("checks only Analyst-reported scores and keeps any/all aggregation explicit", () => {
    const analyst = analystProjection()
    const anyContract = validatedContract("analyst", [
      { id: "reported-score", check: { kind: "reported_score_gte", minimumScore: 8, minimumFindings: 2, aggregation: "any" } },
    ])
    expect(evaluateTaskGraphVerification(anyContract, analyst)).toMatchObject({ status: "passed", reasonCode: "criteria_met" })

    const allContract = validatedContract("analyst", [
      { id: "reported-score", check: { kind: "reported_score_gte", minimumScore: 8, minimumFindings: 2, aggregation: "all" } },
    ])
    expect(evaluateTaskGraphVerification(allContract, analyst)).toEqual({
      status: "failed", reasonCode: "reported_score_below_minimum",
      criteria: [{ criterionId: "reported-score", status: "failed", reasonCode: "reported_score_below_minimum" }],
    })
  })

  it("fails vacuous result arrays against positive minima", () => {
    const job = canonicalEvidence("job", "job-1")
    const empty: TaskGraphVerificationEvidenceProjection = {
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      role: "scout", candidates: [], evidenceIds: [job],
    }
    const typed = validatedContract("scout", [{ id: "minimum-candidates", check: { kind: "candidate_count_gte", minimum: 1 } }])
    expect(evaluateTaskGraphVerification(typed, empty)).toEqual({
      status: "failed", reasonCode: "criterion_not_met",
      criteria: [{ criterionId: "minimum-candidates", status: "failed", reasonCode: "criterion_not_met" }],
    })
  })

  it("returns unverified when canonical observations are missing or a claim is not rebound to its job", () => {
    const job = canonicalEvidence("job", "job-1")
    const typed = validatedContract("scout", [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }])
    const noEvidence: TaskGraphVerificationEvidenceProjection = {
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      role: "scout", candidates: [{ jobId: "job-1", evidenceIds: [job] }], evidenceIds: [],
    }
    expect(evaluateTaskGraphVerification(typed, noEvidence)).toMatchObject({ status: "unverified", reasonCode: "canonical_evidence_missing" })

    const wrongJob: TaskGraphVerificationEvidenceProjection = {
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      role: "scout", candidates: [{ jobId: "job-2", evidenceIds: [job] }], evidenceIds: [job],
    }
    const result = evaluateTaskGraphVerification(typed, wrongJob)
    expect(result).toMatchObject({ status: "unverified", reasonCode: "result_evidence_unbound" })
    expect(JSON.stringify(result)).not.toContain("job-2")
  })

  it("rejects non-canonical IDs, duplicate evidence, and duplicate result items with stable reasons", () => {
    const typed = validatedContract("scout", [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }])
    const job = canonicalEvidence("job", "job-1")
    const modelId: TaskGraphVerificationEvidenceProjection = {
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      role: "scout", candidates: [{ jobId: "job-1", evidenceIds: ["model-supplied-evidence"] }], evidenceIds: [job],
    }
    expect(evaluateTaskGraphVerification(typed, modelId)).toMatchObject({ status: "unverified", reasonCode: "result_evidence_unbound" })

    const duplicatedEvidence: TaskGraphVerificationEvidenceProjection = {
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      role: "scout", candidates: [{ jobId: "job-1", evidenceIds: [job] }], evidenceIds: [job, job],
    }
    expect(evaluateTaskGraphVerification(typed, duplicatedEvidence)).toMatchObject({ status: "unverified", reasonCode: "canonical_evidence_ambiguous" })

    const duplicateCandidate: TaskGraphVerificationEvidenceProjection = {
      schemaVersion: TASK_GRAPH_VERIFICATION_EVIDENCE_SCHEMA_VERSION,
      role: "scout", candidates: [{ jobId: "job-1", evidenceIds: [job] }, { jobId: "job-1", evidenceIds: [job] }], evidenceIds: [job],
    }
    expect(evaluateTaskGraphVerification(typed, duplicateCandidate)).toMatchObject({ status: "unverified", reasonCode: "result_ambiguous" })
  })

  it("does not accept the raw structured role result as an evidence projection", () => {
    const job = canonicalEvidence("job", "job-1")
    const rawResult = {
      schemaVersion: "agent-harness.v2.subagent.result", role: "scout", status: "completed",
      candidates: [{ jobId: "job-1", source: "model", url: null, evidenceIds: [job] }],
      evidence: [{ id: job, kind: "job", ref: "job-1", source: "persisted-read" }], summary: "untrusted summary",
    }
    const typed = validatedContract("scout", [{ id: "candidate-count", check: { kind: "candidate_count_gte", minimum: 1 } }])
    expect(evaluateTaskGraphVerification(typed, rawResult as never)).toMatchObject({ status: "unverified", reasonCode: "projection_invalid" })
  })
})
