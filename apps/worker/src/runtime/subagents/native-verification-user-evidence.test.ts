import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import {
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  canonicalNativeVerificationJson, type NativeVerificationEvidence,
} from "./native-verification-contract.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import { NATIVE_VERIFICATION_USER_STEERING_SCHEMA, NATIVE_VERIFICATION_USER_STEERING_STAGE } from "./native-verification-steering-contract.js"
import {
  NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA,
  NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE,
  NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST,
} from "./native-verification-original-input-source.js"

const mocks = vi.hoisted(() => ({
  appendQuestions: vi.fn(),
  readSources: vi.fn(),
}))
vi.mock("./native-verification-question-evidence.js", () => ({ appendNativeQuestionSelfAttestations: mocks.appendQuestions }))
vi.mock("./native-verification-steering-source.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-verification-steering-source.js")>(),
  readNativeVerificationUserReferenceSources: mocks.readSources,
}))

import { appendNativeUserSelfAttestations } from "./native-verification-user-evidence.js"

const scope: TaskGraphReadScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-owner", turnLeaseVersion: 4, parentLeaseOwner: "parent-owner", parentAttemptCount: 2,
}
const content: NativeVerificationPacketContent = {
  goal: "Answer the user's request.", criteria: [{ criterionId: "criterion-1", requirement: "Preserve the user's stated constraints." }],
  target: { kind: "root_goal", candidateDigest: "a".repeat(64), referenceId: "candidate-ref", candidateText: "A candidate." }, evidence: [],
}
const question: NativeVerificationEvidence = {
  referenceId: `user-self-attestation:${"b".repeat(64)}`, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  summary: canonicalNativeVerificationJson({ kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, stage: "user_input",
    question: "Which location?", options: [], answer: "Dublin" }),
}
const steering: NativeVerificationEvidence = {
  referenceId: `user-self-attestation:${"c".repeat(64)}`, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  summary: canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
    stage: NATIVE_VERIFICATION_USER_STEERING_STAGE, content: [{ type: "text", text: "Prefer Dublin." }] }),
}
const originalReference: NativeVerificationEvidence = {
  referenceId: `user-self-attestation:${"d".repeat(64)}`, kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  summary: canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA,
    stage: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE, trust: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST,
    content: [{ type: "text", text: "Permanent only; posted in the last 14 days." }] }),
}
const client = { query: vi.fn() } as unknown as Pick<pg.PoolClient, "query">

describe("native verification user evidence composition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.appendQuestions.mockResolvedValue({ ...content, evidence: [question] })
    mocks.readSources.mockResolvedValue({ originalTaskReference: [originalReference], originalTaskReferenceRequired: false,
      steering: [steering] })
  })

  it("appends Q/A, complete untrusted original task text, then exact-step steering", async () => {
    const selection = { kind: "exact" as const, stepId: "step-current" }
    const result = await appendNativeUserSelfAttestations(client, scope, content, selection)

    expect(mocks.appendQuestions).toHaveBeenCalledWith(client, scope, content)
    expect(mocks.readSources).toHaveBeenCalledWith(client, scope, selection)
    expect(mocks.appendQuestions.mock.invocationCallOrder[0]).toBeLessThan(mocks.readSources.mock.invocationCallOrder[0]!)
    expect(result?.evidence).toEqual([question, originalReference, steering])
    expect(result?.evidence[1]?.summary).toContain(NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST)
    expect(result?.evidence[1]?.summary).toContain("Permanent only; posted in the last 14 days.")
    expect(result?.criteria).toEqual(content.criteria)
  })

  it("preserves exact Q/A content bytes when there is no steering", async () => {
    const withQuestions = { ...content, evidence: [question] }
    mocks.appendQuestions.mockResolvedValue(withQuestions)
    mocks.readSources.mockResolvedValue({ originalTaskReference: [], originalTaskReferenceRequired: false, steering: [] })

    const result = await appendNativeUserSelfAttestations(client, scope, content, { kind: "latest" })

    expect(result).toBe(withQuestions)
    expect(canonicalNativeVerificationJson(result)).toBe(canonicalNativeVerificationJson(withQuestions))
    expect(mocks.readSources).toHaveBeenCalledWith(client, scope, { kind: "latest" })
  })

  it("keeps the same original and steering references across distinct candidate Step selections", async () => {
    const first = await appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })
    const later = await appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-2" })

    expect(first?.evidence.slice(1)).toEqual(later?.evidence.slice(1))
    expect(first?.evidence[1]?.summary).not.toContain("step-1")
    expect(first?.evidence[1]?.summary).not.toContain("step-2")
  })

  it("fails closed for unavailable required originals, malformed sources and duplicate references", async () => {
    mocks.readSources.mockResolvedValue(null)
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact" })).resolves.toBeNull()

    mocks.readSources.mockResolvedValue({ originalTaskReference: [], originalTaskReferenceRequired: true, steering: [] })
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()

    mocks.readSources.mockResolvedValue({ originalTaskReference: [], originalTaskReferenceRequired: false,
      steering: [{ ...steering, summary: "not a canonical steering summary" }] })
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()

    mocks.readSources.mockResolvedValue({ originalTaskReference: [{ ...originalReference,
      summary: originalReference.summary.replace(NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST, "verified") }],
    originalTaskReferenceRequired: false, steering: [] })
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()

    mocks.readSources.mockResolvedValue({ originalTaskReference: [{ ...originalReference, referenceId: question.referenceId }],
      originalTaskReferenceRequired: false, steering: [] })
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()

    mocks.readSources.mockResolvedValue({ originalTaskReference: [originalReference, originalReference],
      originalTaskReferenceRequired: false, steering: [] })
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()
  })

  it("enforces total evidence-count and canonical packet byte bounds", async () => {
    mocks.appendQuestions.mockResolvedValue({ ...content, evidence: Array.from({ length: 32 }, (_, index) => ({
      referenceId: `evidence-${index}`, kind: "tool_result", summary: "bounded",
    })) })
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()

    const nearLimit = { ...content, evidence: Array.from({ length: 31 }, (_, index) => ({
      referenceId: `evidence-${index}`, kind: "tool_result", summary: "x".repeat(8_000),
    })) }
    mocks.appendQuestions.mockResolvedValue(nearLimit)
    mocks.readSources.mockResolvedValue({ originalTaskReference: [], originalTaskReferenceRequired: false,
      steering: Array.from({ length: 1 }, (_, index) => ({
      ...steering, referenceId: `user-self-attestation:${String(index + 1).repeat(64)}`,
      summary: canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
        stage: NATIVE_VERIFICATION_USER_STEERING_STAGE, content: [{ type: "text", text: "y".repeat(14_000) }] }),
      })) })
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()
  })
})
