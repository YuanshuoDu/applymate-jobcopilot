import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"
import {
  NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA,
  canonicalNativeVerificationJson, digestNativeVerificationValue,
  type NativeVerificationControl, type NativeVerificationPacket,
} from "./native-verification-contract.js"
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
