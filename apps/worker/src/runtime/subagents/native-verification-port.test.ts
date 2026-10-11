import { describe, expect, it } from "vitest"
import type {
  NativeVerificationEnsureResult,
  NativeVerificationFeedback,
  NativeVerificationPort,
  NativeVerificationRecoverableGoal,
} from "./native-verification-port.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"

describe("NativeVerificationPort contract", () => {
  it("keeps control identities and criterion feedback bounded and safe", async () => {
    const feedback: NativeVerificationFeedback = {
      controlTaskId: "control-1",
      targetTaskId: "target-1",
      disposition: "uncertain",
      criteria: [{ criterionId: "criterion-1", disposition: "uncertain", reasonCode: "ambiguous", evidenceReferenceIds: ["target:target-1"] }],
    }
    const result: NativeVerificationEnsureResult = {
      status: "pending", controlTaskIds: ["control-1"], pendingControlTaskIds: ["control-1"], pendingTaskIds: ["control-1"], feedback: [feedback],
    }
    const recovered: NativeVerificationRecoverableGoal = {
      controlTaskId: "control-1", candidateText: "Candidate answer", status: "passed", feedback: null,
      witness: {
        controlTaskId: "control-1", controlOperationId: "operation-1", currentControlAttempt: 1,
        candidateDigest: "a".repeat(64), childBindingSetDigest: "b".repeat(64), goalDigest: "c".repeat(64),
        criteriaDigest: "d".repeat(64), evidencePacketDigest: "e".repeat(64), reportDigest: "f".repeat(64),
      },
    }
    const scope = {} as TaskGraphExecutionScope
    const readScope = {} as TaskGraphReadScope
    const port: NativeVerificationPort = {
      async ensureChildren(received) { expect(received).toBe(scope); return result },
      async ensureRootGoal(input) { expect(input.scope).toBe(scope); return result },
      async readRecoverableGoal(received) { expect(received).toBe(readScope); return recovered },
    }

    expect(await port.ensureChildren(scope)).toEqual(result)
    expect(await port.ensureRootGoal({ scope, candidateText: recovered.candidateText })).toEqual(result)
    expect(await port.readRecoverableGoal(readScope)).toEqual(recovered)
  })
})
