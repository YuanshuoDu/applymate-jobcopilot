import { describe, expect, it } from "vitest"
import type pg from "pg"
import {
  NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA,
  NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE,
  NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST,
  isNativeOriginalTaskReferenceEvidence,
  nativeOriginalInputStepCoversCheckpoint,
  nativeOriginalTaskReferenceEvidence,
  nativeOriginalTaskReferenceProjection,
  readNativeOriginalInputBinding,
  type NativeOriginalConsumerStep,
  type NativeOriginalInputBinding,
} from "./native-verification-original-input-source.js"
import { canonicalNativeVerificationJson } from "./native-verification-contract.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
const scope: TaskGraphReadScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-worker", turnLeaseVersion: 4, parentLeaseOwner: "root-worker", parentAttemptCount: 1,
}
const at = new Date("2026-10-07T10:00:00.000Z")
const originalText = [
  { type: "text", text: "Find senior AI platform roles in Dublin." },
  { type: "text", text: "Permanent only; posted in the last 14 days; salary at least €90k." },
]

function original(patch: Partial<NativeOriginalInputBinding> = {}): NativeOriginalInputBinding {
  return { id: "root-input", clientMessageId: "root-message", consumedByStepId: "step-root", acceptedSequence: 1n,
    consumedAt: at, content: originalText, goal: "Find senior AI platform roles in Dublin.", ...patch }
}
function consumer(patch: Partial<NativeOriginalConsumerStep> = {}): NativeOriginalConsumerStep {
  return { id: "step-root", ordinal: 0, attempt: 1, inputThroughSequence: 1n,
    consumedInputIds: ["root-input"], ...patch }
}
function row(patch: Row = {}): Row {
  return { id: "root-input", sessionId: scope.sessionId, userId: scope.userId, targetTurnId: scope.turnId,
    clientMessageId: "root-message", delivery: "follow_up", status: "consumed", content: originalText,
    acceptedSequence: "1", consumedByStepId: "step-root", consumedAt: at, cancelledAt: null, ...patch }
}
function client(turnInput: unknown, inputs: readonly Row[] = [row()]): Client & { calls: { sql: string; values: unknown[] }[] } {
  const calls: { sql: string; values: unknown[] }[] = []
  return {
    calls,
    query: (async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values })
      if (sql.includes('SELECT "input" FROM "agent_turns"')) return { rows: [{ input: turnInput }], rowCount: 1 }
      if (sql.includes('FROM "agent_inputs"')) return { rows: [...inputs], rowCount: inputs.length }
      throw new Error(`unexpected query: ${sql}`)
    }) as unknown as Client["query"],
  }
}

describe("native verifier original input source", () => {
  it("binds the complete nested Turn input to its exact owned consumed follow-up", async () => {
    const turnInput = { input: { goal: "Find senior AI platform roles in Dublin.", content: originalText, clientMessageId: "root-message" } }
    const db = client(turnInput)
    const result = await readNativeOriginalInputBinding(db, scope)

    expect(result).toMatchObject({ kind: "bound", input: {
      id: "root-input", clientMessageId: "root-message", consumedByStepId: "step-root",
      acceptedSequence: 1n, goal: "Find senior AI platform roles in Dublin.", content: originalText,
    } })
    expect(db.calls.find(call => call.sql.includes('"clientMessageId" = $4'))?.values)
      .toEqual([scope.sessionId, scope.userId, scope.turnId, "root-message"])
  })

  it("preserves legacy inputs with no explicit original content source", async () => {
    const db = client({ goal: "Legacy goal" }, [])
    await expect(readNativeOriginalInputBinding(db, scope)).resolves.toEqual({ kind: "legacy" })
    expect(db.calls).toHaveLength(1)
  })

  it.each([
    ["partial Turn envelope", { goal: "Goal", clientMessageId: "root-message" }, [row()]],
    ["missing owned row", { goal: "Goal", content: originalText, clientMessageId: "root-message" }, []],
    ["ambiguous rows", { goal: "Goal", content: originalText, clientMessageId: "root-message" }, [row(), row({ id: "duplicate" })]],
    ["foreign input owner", { goal: "Goal", content: originalText, clientMessageId: "root-message" }, [row({ userId: "other-user" })]],
    ["wrong Turn", { goal: "Goal", content: originalText, clientMessageId: "root-message" }, [row({ targetTurnId: "other-turn" })]],
    ["not original follow-up", { goal: "Goal", content: originalText, clientMessageId: "root-message" }, [row({ delivery: "steer" })]],
    ["unconsumed source", { goal: "Goal", content: originalText, clientMessageId: "root-message" }, [row({ status: "accepted" })]],
    ["canceled source", { goal: "Goal", content: originalText, clientMessageId: "root-message" }, [row({ cancelledAt: at })]],
    ["Turn/source content mismatch", { goal: "Goal", content: originalText, clientMessageId: "root-message" }, [row({ content: [{ type: "text", text: "different" }] })]],
  ])("fails closed for %s", async (_label, turnInput, inputs) => {
    await expect(readNativeOriginalInputBinding(client(turnInput, inputs), scope)).resolves.toBeNull()
  })

  it("projects the exact complete text under an explicitly untrusted reference label", () => {
    const projection = nativeOriginalTaskReferenceProjection(original())
    expect(projection).toEqual({ kind: "reference", content: originalText, summary: canonicalNativeVerificationJson({
      schemaVersion: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_SCHEMA,
      stage: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_STAGE,
      trust: NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST,
      content: originalText,
    }) })
  })

  it("omits only exact single-part goal equality and rejects unresolved or oversized content", () => {
    expect(nativeOriginalTaskReferenceProjection(original({ content: [{ type: "text", text: "Same goal" }], goal: "Same goal" })))
      .toEqual({ kind: "omitted" })
    expect(nativeOriginalTaskReferenceProjection(original({ content: [{ type: "text", text: "Same goal\n" }], goal: "Same goal" })).kind)
      .toBe("reference")
    expect(nativeOriginalTaskReferenceProjection(original({ content: [{ type: "attachment_ref", attachmentId: "file-1" }] })).kind)
      .toBe("unavailable")
    expect(nativeOriginalTaskReferenceProjection(original({ content: [{ type: "text", text: "x".repeat(300_000) }] })).kind)
      .toBe("unavailable")
  })

  it("keeps the original consumer on root ordinal zero and covers later checkpoint cursors", () => {
    const input = original()
    expect(nativeOriginalInputStepCoversCheckpoint(input, consumer(), consumer({ id: "step-later", ordinal: 4, inputThroughSequence: 9n })))
      .toBe(true)
    expect(nativeOriginalInputStepCoversCheckpoint(input, consumer({ ordinal: 1 }), consumer({ id: "step-later", ordinal: 4 })))
      .toBe(false)
    expect(nativeOriginalInputStepCoversCheckpoint(input, consumer({ attempt: 2 }), consumer({ id: "step-later", ordinal: 4 })))
      .toBe(false)
    expect(nativeOriginalInputStepCoversCheckpoint(input, consumer({ consumedInputIds: [] }), consumer({ id: "step-later", ordinal: 4 })))
      .toBe(false)
    expect(nativeOriginalInputStepCoversCheckpoint(input, consumer({ inputThroughSequence: 0n }), consumer({ id: "step-later", ordinal: 4 })))
      .toBe(false)
    expect(nativeOriginalInputStepCoversCheckpoint(input, consumer(), consumer({ ordinal: 0, id: "different-root-step" })))
      .toBe(false)
  })

  it("hash-binds owner, original source and consuming Step without putting private IDs in the summary", () => {
    const evidence = nativeOriginalTaskReferenceEvidence(scope, original(), consumer())
    expect(evidence).not.toBeNull()
    expect(evidence?.kind).toBe("user_self_attestation")
    expect(evidence?.summary).toContain(NATIVE_VERIFICATION_ORIGINAL_TASK_REFERENCE_TRUST)
    expect(evidence?.summary).toContain("Permanent only; posted in the last 14 days; salary at least €90k.")
    expect(evidence?.summary).not.toContain("root-input")
    expect(evidence?.summary).not.toContain("step-root")
    expect(isNativeOriginalTaskReferenceEvidence(evidence)).toBe(true)
    expect(isNativeOriginalTaskReferenceEvidence({ ...evidence!, summary: evidence!.summary.replace("untrusted_user_provided_reference", "verified") }))
      .toBe(false)
  })
})
