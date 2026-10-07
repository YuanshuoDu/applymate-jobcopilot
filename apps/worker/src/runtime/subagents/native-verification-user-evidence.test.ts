import { beforeEach, describe, expect, it, vi } from "vitest"
import type pg from "pg"
import {
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
  canonicalNativeVerificationJson, type NativeVerificationEvidence,
} from "./native-verification-contract.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import { NATIVE_VERIFICATION_USER_STEERING_SCHEMA, NATIVE_VERIFICATION_USER_STEERING_STAGE } from "./native-verification-steering-contract.js"

const mocks = vi.hoisted(() => ({
  appendQuestions: vi.fn(),
  readSteering: vi.fn(),
}))
vi.mock("./native-verification-question-evidence.js", () => ({ appendNativeQuestionSelfAttestations: mocks.appendQuestions }))
vi.mock("./native-verification-steering-source.js", async importOriginal => ({
  ...await importOriginal<typeof import("./native-verification-steering-source.js")>(),
  readNativeVerificationSteeringSource: mocks.readSteering,
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
const client = { query: vi.fn() } as unknown as Pick<pg.PoolClient, "query">

describe("native verification user evidence composition", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.appendQuestions.mockResolvedValue({ ...content, evidence: [question] })
    mocks.readSteering.mockResolvedValue([steering])
  })

  it("appends Q/A before exact-step steering and preserves only the private evidence shape", async () => {
    const selection = { kind: "exact" as const, stepId: "step-current" }
    const result = await appendNativeUserSelfAttestations(client, scope, content, selection)

    expect(mocks.appendQuestions).toHaveBeenCalledWith(client, scope, content)
    expect(mocks.readSteering).toHaveBeenCalledWith(client, scope, selection)
    expect(mocks.appendQuestions.mock.invocationCallOrder[0]).toBeLessThan(mocks.readSteering.mock.invocationCallOrder[0]!)
    expect(result?.evidence).toEqual([question, steering])
    expect(result?.evidence[1]?.summary).toContain(NATIVE_VERIFICATION_USER_STEERING_SCHEMA)
  })

  it("preserves exact Q/A content bytes when there is no steering", async () => {
    const withQuestions = { ...content, evidence: [question] }
    mocks.appendQuestions.mockResolvedValue(withQuestions)
    mocks.readSteering.mockResolvedValue([])

    const result = await appendNativeUserSelfAttestations(client, scope, content, { kind: "latest" })

    expect(result).toBe(withQuestions)
    expect(canonicalNativeVerificationJson(result)).toBe(canonicalNativeVerificationJson(withQuestions))
    expect(mocks.readSteering).toHaveBeenCalledWith(client, scope, { kind: "latest" })
  })

  it("keeps the same private steering identity across distinct candidate Step selections", async () => {
    const first = await appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })
    const later = await appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-2" })

    expect(first?.evidence.at(-1)).toEqual(later?.evidence.at(-1))
    expect(first?.evidence.at(-1)?.summary).not.toContain("step-1")
    expect(first?.evidence.at(-1)?.summary).not.toContain("step-2")
  })

  it("fails closed for unbound or malformed steering and duplicate private references", async () => {
    mocks.readSteering.mockResolvedValue(null)
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact" })).resolves.toBeNull()

    mocks.readSteering.mockResolvedValue([{ ...steering, summary: "not a canonical steering summary" }])
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()

    mocks.readSteering.mockResolvedValue([{ ...steering, referenceId: question.referenceId }])
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()

    mocks.readSteering.mockResolvedValue([steering, steering])
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
    mocks.readSteering.mockResolvedValue(Array.from({ length: 1 }, (_, index) => ({
      ...steering, referenceId: `user-self-attestation:${String(index + 1).repeat(64)}`,
      summary: canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
        stage: NATIVE_VERIFICATION_USER_STEERING_STAGE, content: [{ type: "text", text: "y".repeat(14_000) }] }),
    })))
    await expect(appendNativeUserSelfAttestations(client, scope, content, { kind: "exact", stepId: "step-1" })).resolves.toBeNull()
  })
})
