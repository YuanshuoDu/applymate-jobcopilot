import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import {
  NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA_V2,
  NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX,
  canonicalNativeVerificationJson, digestNativeVerificationValue,
  type NativeVerificationControl, type NativeVerificationPacket,
} from "./native-verification-contract.js"
import {
  NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA, NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE,
  NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST,
} from "./native-verification-original-input-source.js"
import { createNativeVerificationContext } from "./native-verification-packet.js"
import { attachNativeVerificationReport } from "./native-verification-report.js"
import { nativeVerificationControlContentMatches } from "./native-verification-pg-request.js"
import { readNativeVerificationControlProofs } from "./native-verification-pg-readback.js"

const owner = { userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1" }
const scope: TaskGraphReadScope = { ...owner, turnLeaseOwner: "turn-lease", turnLeaseVersion: 1,
  parentLeaseOwner: "parent-lease", parentAttemptCount: 1 }
const result = { fact: "persisted" }
const resultText = canonicalNativeVerificationJson(result)
const criteria = [{ criterionId: "criterion-1", requirement: "Use the persisted result" }]
const target = { kind: "child" as const, nodeId: "node-1", nativeOperationId: "native-op-1", fingerprint: "a".repeat(64),
  taskId: "child-1", attempt: 1, resultDigest: digestNativeVerificationValue(result) }
const packetTarget = { kind: "child" as const, taskId: target.taskId, attempt: 1, resultDigest: target.resultDigest,
  referenceId: "target:1", resultText }
const packet: NativeVerificationPacket = {
  schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA, controlOperationId: "operation-1", controlTaskId: "control-1",
  goal: "Independently inspect the result", criteria, target: packetTarget,
  evidence: [{ referenceId: "tool:1", kind: "tool_result", summary: "{\"fact\":\"persisted\"}" }],
}
const control: NativeVerificationControl = {
  schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: packet.controlOperationId,
  controlTaskId: packet.controlTaskId, owner, target,
  goalDigest: digestNativeVerificationValue(packet.goal), criteriaDigest: digestNativeVerificationValue(packet.criteria),
  evidencePacketDigest: digestNativeVerificationValue(packet),
}
const modelReport = {
  schemaVersion: "agent-harness.v2.native-verifier-model-report.v1" as const,
  criteria: [{ criterionId: "criterion-1", disposition: "passed" as const, reasonCode: "meets_criterion" as const,
    evidenceReferenceIds: [packet.target.referenceId, packet.evidence[0]!.referenceId] }],
}
const report = attachNativeVerificationReport(control, 1, modelReport)!
const row = (overrides: Record<string, unknown> = {}) => ({
  id: control.controlTaskId, userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId,
  rootTaskId: owner.rootTaskId, parentTaskId: owner.parentTaskId, role: "auditor", taskType: "native_verification",
  status: "completed", attemptCount: 1, failureReason: null, expectedOutputSchema: control,
  context: createNativeVerificationContext(packet), result: { nativeVerificationReport: report }, resultOversize: false, ...overrides,
})

describe("native verification durable report readback", () => {
  async function read(rows: readonly unknown[]) {
    const client = { query: vi.fn(async (..._args: unknown[]) => ({ rows })) } as unknown as Pick<pg.PoolClient, "query">
    return readNativeVerificationControlProofs(client, scope)
  }

  it("rederives a current report against the real marker, packet, task ID, owner and attempt", async () => {
    const proofs = await read([row()])
    expect(proofs).toHaveLength(1)
    expect(proofs[0]).toMatchObject({ report, reportDigest: digestNativeVerificationValue(report), disposition: "passed" })
    expect(proofs[0]?.task.taskId).toBe(control.controlTaskId)
    const reviewed = proofs[0]!.task.packet
    expect(nativeVerificationControlContentMatches(reviewed, { goal: reviewed.goal, criteria: reviewed.criteria,
      target: reviewed.target, evidence: reviewed.evidence })).toBe(true)
    const changedToolEvidence = reviewed.evidence.map(item => ({ ...item, summary: "{\"fact\":\"changed persisted tool output\"}" }))
    expect(nativeVerificationControlContentMatches(reviewed, { goal: reviewed.goal, criteria: reviewed.criteria,
      target: reviewed.target, evidence: changedToolEvidence })).toBe(false)
  })

  it("invalidates an accepted root report when the original task reference changes", async () => {
    const originalTaskText = "Find roles in Dublin and preserve the salary floor from my full request."
    const inputId = "original-input-1", clientMessageId = "original-message-1", consumerStepId = "original-consumer-step"
    const consumedAt = "2026-10-06T12:00:00.000Z"
    const originalReferenceFor = (text: string) => {
      const content = [{ type: "text" as const, text }]
      const identity = {
        owner: { userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId },
        input: { id: inputId, clientMessageId, acceptedSequence: "0", consumedByStepId: consumerStepId, consumedAt, content },
        consumingStep: { id: consumerStepId, ordinal: 0, attempt: 1, inputThroughSequence: "0", consumedInputIds: [inputId] },
      }
      return {
        referenceId: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_REFERENCE_PREFIX + digestNativeVerificationValue(identity),
        summary: canonicalNativeVerificationJson({ schemaVersion: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA,
          stage: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE, trust: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST, content }),
      }
    }
    const originalReference = originalReferenceFor(originalTaskText)
    const candidateText = "The response covers Dublin roles and the saved salary floor."
    const candidateDigest = digestNativeVerificationValue(candidateText)
    const rootPacket: NativeVerificationPacket = {
      schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA_V2, controlOperationId: control.controlOperationId,
      controlTaskId: control.controlTaskId, goal: "Assess the response against the saved requirements.",
      criteria: [{ criterionId: "criterion-1", requirement: "Preserve the user's original job constraints." }],
      target: { kind: "root_goal", candidateDigest, referenceId: "candidate:root", candidateText },
      evidence: [packet.evidence[0]!, { referenceId: originalReference.referenceId,
        kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND, summary: originalReference.summary }],
    }
    const rootControl: NativeVerificationControl = {
      ...control, target: { kind: "root_goal", candidateDigest, childBindingSetDigest: "c".repeat(64) },
      goalDigest: digestNativeVerificationValue(rootPacket.goal),
      criteriaDigest: digestNativeVerificationValue(rootPacket.criteria),
      evidencePacketDigest: digestNativeVerificationValue(rootPacket),
    }
    const rootReport = attachNativeVerificationReport(rootControl, 1, {
      schemaVersion: "agent-harness.v2.native-verifier-model-report.v1",
      criteria: [{ criterionId: "criterion-1", disposition: "passed", reasonCode: "meets_criterion",
        evidenceReferenceIds: [rootPacket.target.referenceId] }],
    })
    if (!rootReport) throw new Error("native_original_reference_report_invalid")
    const persistedRow = row({ expectedOutputSchema: rootControl, context: createNativeVerificationContext(rootPacket),
      result: { nativeVerificationReport: rootReport } })
    const acceptedProofs = await read([persistedRow])
    expect(acceptedProofs).toHaveLength(1)
    const acceptedProof = acceptedProofs[0]
    if (!acceptedProof) throw new Error("native_original_reference_proof_missing")
    expect(acceptedProof).toMatchObject({ report: rootReport, disposition: "passed" })
    const acceptedOriginalEvidence = acceptedProof.task.packet.evidence.filter(item => item.referenceId === originalReference.referenceId)
    expect(acceptedOriginalEvidence).toHaveLength(1)
    expect(acceptedOriginalEvidence[0]).toMatchObject({ kind: NATIVE_VERIFICATION_USER_SELF_ATTESTATION_KIND,
      referenceId: originalReference.referenceId, summary: originalReference.summary })

    const changedOriginalText = `${originalTaskText} Exclude contract roles.`
    const changedReference = originalReferenceFor(changedOriginalText)
    expect(changedReference.referenceId).not.toBe(originalReference.referenceId)
    const changedEvidence = acceptedProof.task.packet.evidence.map(item => item.referenceId === originalReference.referenceId
      ? { ...item, referenceId: changedReference.referenceId, summary: changedReference.summary }
      : item)
    const changedPacket: NativeVerificationPacket = { ...acceptedProof.task.packet, evidence: changedEvidence }
    const changedControl: NativeVerificationControl = { ...rootControl,
      evidencePacketDigest: digestNativeVerificationValue(changedPacket) }

    expect(digestNativeVerificationValue(changedPacket)).not.toBe(rootControl.evidencePacketDigest)
    expect(nativeVerificationControlContentMatches(acceptedProof.task.packet, {
      goal: changedPacket.goal, criteria: changedPacket.criteria, target: changedPacket.target, evidence: changedPacket.evidence,
    })).toBe(false)
    const staleProofs = await read([row({ expectedOutputSchema: changedControl,
      context: createNativeVerificationContext(changedPacket), result: { nativeVerificationReport: rootReport } })])
    expect(staleProofs).toHaveLength(1)
    expect(staleProofs[0]).toMatchObject({ report: null, reportDigest: null, disposition: "uncertain" })
  })

  it("does not accept report bytes from failed, stale-attempt, malformed or oversized completed control rows", async () => {
    const proofs = await read([
      row({ status: "failed" }),
      row({ id: control.controlTaskId, attemptCount: 2 }),
      row({ id: control.controlTaskId, result: { nativeVerificationReport: { ...report, controlAttempt: 2 } } }),
      row({ id: control.controlTaskId, result: null, resultOversize: true }),
    ])
    expect(proofs).toHaveLength(4)
    expect(proofs.map(proof => proof.disposition)).toEqual(["uncertain", "uncertain", "uncertain", "uncertain"])
    expect(proofs.every(proof => proof.report === null)).toBe(true)
  })
})
