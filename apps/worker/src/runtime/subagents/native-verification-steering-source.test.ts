import type pg from "pg"
import { describe, expect, it, vi } from "vitest"
import { canonicalNativeVerificationJson } from "./native-verification-contract.js"
import { NATIVE_VERIFICATION_USER_STEERING_SCHEMA, NATIVE_VERIFICATION_USER_STEERING_STAGE,
  isNativeSteeringEvidence } from "./native-verification-steering-contract.js"
import { readNativeVerificationSteeringSource, type NativeSteeringCheckpointSelection } from "./native-verification-steering-source.js"
import type { TaskGraphReadScope } from "./task-graph-command-port.js"

type Row = Record<string, unknown>
type Client = Pick<pg.PoolClient, "query">
const scope: TaskGraphReadScope = {
  userId: "user-1", sessionId: "session-1", turnId: "turn-1", rootTaskId: "root-1", parentTaskId: "root-1",
  turnLeaseOwner: "turn-worker", turnLeaseVersion: 4, parentLeaseOwner: "root-worker", parentAttemptCount: 1,
}
const at = new Date("2026-10-07T10:00:00.000Z")

function ownerRow(patch: Row = {}): Row {
  return { turnId: scope.turnId, leaseOwnerId: scope.turnLeaseOwner, leaseVersion: scope.turnLeaseVersion,
    turnLeaseLive: true, rootTaskId: scope.rootTaskId, taskRootTaskId: scope.rootTaskId, parentTaskId: null,
    rootStatus: "running", leaseOwner: scope.parentLeaseOwner, attemptCount: scope.parentAttemptCount,
    interruptRequestedAt: null, rootLeaseLive: true, ...patch }
}
function stepRow(patch: Row = {}): Row {
  return { id: "step-current", taskId: scope.rootTaskId, ordinal: 2, attempt: 1, status: "streaming",
    inputThroughSequence: "9", consumedInputIds: [], ...patch }
}
function inputRow(patch: Row = {}): Row {
  return { id: "input-1", userId: scope.userId, sessionId: scope.sessionId, targetTurnId: scope.turnId,
    delivery: "steer", status: "consumed", content: [{ type: "text", text: "Use Dublin 🌍" }], acceptedSequence: "8",
    consumedByStepId: "step-origin", consumedAt: at, cancelledAt: null, ...patch }
}
function originalInputRow(patch: Row = {}): Row {
  return { id: "root-input", userId: scope.userId, sessionId: scope.sessionId, targetTurnId: scope.turnId,
    clientMessageId: "root-message", delivery: "follow_up", status: "consumed",
    content: [{ type: "text", text: "Find jobs" }], acceptedSequence: "1", consumedByStepId: "step-origin",
    consumedAt: at, cancelledAt: null, ...patch }
}

function sourceStep(patch: Row = {}): Row {
  return { id: "step-origin", taskId: scope.rootTaskId, ordinal: 1, attempt: 1, status: "completed",
    inputThroughSequence: "8", consumedInputIds: ["root-input", "input-1"], ...patch }
}

function fixture(options: {
  owner?: Row; rootInputMessageId?: unknown; rootTurnInput?: Row; rootInputs?: Row[]; exactStep?: Row | null; latestSteps?: Row[]; sources?: Row[]; sourceSteps?: Row[]
  superseded?: boolean
} = {}) {
  const calls: { sql: string; values: unknown[] }[] = []
  const clientMessageId = options.rootInputMessageId === undefined ? (options.rootTurnInput?.clientMessageId ?? "root-message") : options.rootInputMessageId
  const turnInput = options.rootTurnInput ?? { goal: "Find jobs", content: [{ type: "text", text: "Find jobs" }], clientMessageId }
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values })
    if (sql.includes('FROM "agent_turns" AS turn')) return { rows: [ownerRow(options.owner)], rowCount: 1 }
    if (sql.includes('SELECT "input" FROM "agent_turns"')) return { rows: [{ input: turnInput }], rowCount: 1 }
    if (sql.includes('FROM "agent_inputs"') && sql.includes('"clientMessageId" = $4')) {
      const rows = options.rootInputs ?? [originalInputRow({ clientMessageId })]
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_inputs"') && sql.includes('"delivery" = \'steer\'')) {
      const rows = (options.sources ?? [inputRow()]).filter(row => row.id !== values[4])
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "agent_steps" AS step')) {
      const rows = options.superseded ? [] : [options.exactStep ?? stepRow()]
      const matching = rows.filter(row => Number(row.attempt) === Number(values[4]))
      return { rows: matching, rowCount: matching.length }
    }
    if (sql.includes('FROM "agent_steps"') && sql.includes('ANY($4::text[])')) {
      return { rows: options.sourceSteps ?? [sourceStep()], rowCount: (options.sourceSteps ?? [sourceStep()]).length }
    }
    if (sql.includes('FROM "agent_steps"') && sql.includes('ORDER BY "ordinal" DESC')) {
      const rows = (options.latestSteps ?? [stepRow()]).filter(row => Number(row.attempt) === Number(values[3]))
      return { rows, rowCount: rows.length }
    }
    throw new Error(`unexpected query ${sql.slice(0, 80)}`)
  })
  return { client: { query } as unknown as Client, calls }
}

const exact = (stepId = "step-current"): NativeSteeringCheckpointSelection => ({ kind: "exact", stepId })

describe("native verification consumed steering source", () => {
  it("rederives complete chronological text and stable source references across later candidate Steps", async () => {
    const second = inputRow({ id: "input-2", acceptedSequence: "9", consumedByStepId: "step-current", content: [{ type: "text", text: "Preserve all context." }] })
    const later = stepRow({ id: "step-later", ordinal: 4, inputThroughSequence: "11", consumedInputIds: [] })
    const sourceSteps = [sourceStep(), stepRow({ id: "step-current", status: "completed", inputThroughSequence: "9", consumedInputIds: ["input-2"] })]
    const first = fixture({ exactStep: stepRow({ consumedInputIds: ["input-2"] }), sources: [inputRow(), second], sourceSteps })
    const laterFixture = fixture({ exactStep: later, sources: [inputRow(), second], sourceSteps })
    const before = await readNativeVerificationSteeringSource(first.client, scope, exact())
    const after = await readNativeVerificationSteeringSource(laterFixture.client, scope, exact("step-later"))

    expect(before).toEqual(after)
    expect(first.calls.find(call => call.sql.includes('FROM "agent_steps" AS step'))?.values[4]).toBe(scope.parentAttemptCount)
    expect(before?.map(item => isNativeSteeringEvidence(item) && JSON.parse(item.summary).content[0].text)).toEqual(["Use Dublin 🌍", "Preserve all context."])
    expect(before?.every(isNativeSteeringEvidence)).toBe(true)
    expect(first.calls.find(call => call.sql.includes('"delivery" = \'steer\''))?.sql).toContain('"acceptedSequence" <= $4::bigint')
  })

  it("uses only a latest root checkpoint for recovery and rejects an exact superseded candidate", async () => {
    const superseded = fixture({ superseded: true })
    await expect(readNativeVerificationSteeringSource(superseded.client, scope, exact())).resolves.toBeNull()
    expect(superseded.calls.some(call => call.sql.includes("NOT EXISTS") && call.sql.includes("newer."))).toBe(true)

    const latest = fixture({ latestSteps: [stepRow({ id: "step-new", ordinal: 8 }), stepRow({ id: "step-old", ordinal: 7 })] })
    const evidence = await readNativeVerificationSteeringSource(latest.client, scope, { kind: "latest" })
    expect(evidence).toHaveLength(1)
    expect(latest.calls.some(call => call.sql.includes('ORDER BY "ordinal" DESC, "attempt" DESC'))).toBe(true)
    expect(latest.calls.find(call => call.sql.includes('ORDER BY "ordinal" DESC'))?.values[3]).toBe(scope.parentAttemptCount)

    const waiting = fixture({ latestSteps: [stepRow({ id: "step-waiting", ordinal: 8, status: "waiting_for_tool" })] })
    const completed = fixture({ latestSteps: [stepRow({ id: "step-completed", ordinal: 8, status: "completed" })] })
    await expect(readNativeVerificationSteeringSource(waiting.client, scope, { kind: "latest" }))
      .resolves.toEqual(await readNativeVerificationSteeringSource(completed.client, scope, { kind: "latest" }))
    const exactWaiting = fixture({ exactStep: stepRow({ status: "waiting_for_tool" }) })
    await expect(readNativeVerificationSteeringSource(exactWaiting.client, scope, exact())).resolves.toBeNull()

    const retryScope = { ...scope, parentAttemptCount: 2 }
    const priorAttempt = fixture({ owner: ownerRow({ attemptCount: 2 }), latestSteps: [stepRow({ attempt: 1 })] })
    await expect(readNativeVerificationSteeringSource(priorAttempt.client, retryScope, { kind: "latest" })).resolves.toBeNull()
    expect(priorAttempt.calls.find(call => call.sql.includes('ORDER BY "ordinal" DESC'))?.values[3]).toBe(2)
    const exactPriorAttempt = fixture({ owner: ownerRow({ attemptCount: 2 }), exactStep: stepRow({ attempt: 1 }) })
    await expect(readNativeVerificationSteeringSource(exactPriorAttempt.client, retryScope, exact())).resolves.toBeNull()
    expect(exactPriorAttempt.calls.find(call => call.sql.includes('FROM "agent_steps" AS step'))?.values[4]).toBe(2)
    expect(exactPriorAttempt.calls.find(call => call.sql.includes('FROM "agent_steps" AS step'))?.sql).toContain('newer."attempt" = $5')
  })

  it("preserves no-step compatibility only when the consumed steering scan is empty", async () => {
    const empty = fixture({ sources: [] })
    await expect(readNativeVerificationSteeringSource(empty.client, scope, { kind: "exact" })).resolves.toEqual([])
    const consumed = fixture()
    await expect(readNativeVerificationSteeringSource(consumed.client, scope, { kind: "exact" })).resolves.toBeNull()
  })

  it("excludes the exact Turn input by clientMessageId and fails closed when that identity is missing", async () => {
    const steer = inputRow({ id: "first-real-steer", acceptedSequence: "2", consumedByStepId: "step-current" })
    const valid = fixture({ exactStep: stepRow({ ordinal: 0, consumedInputIds: ["root-input", "first-real-steer"] }),
      rootInputs: [originalInputRow({ consumedByStepId: "step-current" })], sources: [steer],
      sourceSteps: [stepRow({ ordinal: 0, inputThroughSequence: "2", consumedInputIds: ["root-input", "first-real-steer"] })] })
    await expect(readNativeVerificationSteeringSource(valid.client, scope, exact())).resolves.toHaveLength(1)
    expect(valid.calls.find(call => call.sql.includes('"clientMessageId" = $4'))?.values[3]).toBe("root-message")

    const missing = fixture({ rootInputMessageId: "missing-root-message", rootInputs: [], sources: [steer] })
    await expect(readNativeVerificationSteeringSource(missing.client, scope, exact())).resolves.toBeNull()
    const malformed = fixture({ rootInputMessageId: 7, sources: [steer] })
    await expect(readNativeVerificationSteeringSource(malformed.client, scope, exact())).resolves.toBeNull()
    expect(malformed.calls.some(call => call.sql.includes('SELECT "input" FROM "agent_turns"'))).toBe(true)
  })

  it("matches only steers claimed by the selected Step while keeping prior steering evidence", async () => {
    const current = inputRow({ id: "step-steer", consumedByStepId: "step-current" })
    const exactStep = stepRow({ consumedInputIds: ["step-steer"] })
    const sourceSteps = [sourceStep(), stepRow({ consumedInputIds: ["step-steer"] })]
    const valid = fixture({ exactStep, sources: [inputRow(), current], sourceSteps })
    await expect(readNativeVerificationSteeringSource(valid.client, scope, exact())).resolves.toHaveLength(2)
    const omitted = fixture({ exactStep: stepRow({ consumedInputIds: [] }), sources: [current], sourceSteps })
    await expect(readNativeVerificationSteeringSource(omitted.client, scope, exact())).resolves.toBeNull()
    const later = fixture({ exactStep: stepRow({ id: "step-later", ordinal: 4, consumedInputIds: [] }),
      sources: [inputRow(), current], sourceSteps })
    await expect(readNativeVerificationSteeringSource(later.client, scope, exact("step-later"))).resolves.toHaveLength(2)
  })

  it("fails closed when a selected Step claims steering beyond its input cursor", async () => {
    const late = inputRow({ id: "late-steer", acceptedSequence: "10", consumedByStepId: "step-current" })
    const value = fixture({ exactStep: stepRow({ inputThroughSequence: "9", consumedInputIds: ["late-steer"] }),
      sources: [late], sourceSteps: [stepRow({ inputThroughSequence: "10", consumedInputIds: ["late-steer"] })] })
    await expect(readNativeVerificationSteeringSource(value.client, scope, exact())).resolves.toBeNull()
    const query = value.calls.find(call => call.sql.includes("'steer'"))
    expect(query?.sql).toContain('"consumedByStepId" = $6')
    expect(query?.values[5]).toBe("step-current")
  })

  it("accepts a valid empty checkpoint when there is no original input or consumed steering", async () => {
    const noSteer = fixture({ rootInputMessageId: null, rootInputs: [], sources: [], exactStep: stepRow({ consumedInputIds: [] }) })
    await expect(readNativeVerificationSteeringSource(noSteer.client, scope, exact())).resolves.toEqual([])
    expect(noSteer.calls.some(call => call.sql.includes('FROM "agent_steps" AS step'))).toBe(true)
  })

  const checkpointReconciliationCases: [string, Parameters<typeof fixture>[0]][] = [
    ["unresolved original input referenced by checkpoint", {
      rootInputMessageId: "missing-root-message", rootInputs: [], sources: [],
      exactStep: stepRow({ consumedInputIds: ["root-input"] }),
    }],
    ["resolved original input missing from checkpoint", {
      rootInputs: [originalInputRow({ consumedByStepId: "step-current" })], exactStep: stepRow({ consumedInputIds: [] }), sources: [],
    }],
    ["returned steering source missing from checkpoint", {
      sources: [inputRow({ consumedByStepId: "step-current" })], exactStep: stepRow({ consumedInputIds: ["root-input"] }),
      sourceSteps: [stepRow({ consumedInputIds: ["input-1"] })],
    }],
    ["missing steering source row referenced by checkpoint", {
      sources: [], exactStep: stepRow({ consumedInputIds: ["root-input", "input-1"] }),
    }],
    ["extra unresolved checkpoint input", {
      exactStep: stepRow({ consumedInputIds: ["root-input", "input-1", "unresolved-input"] }),
    }],
  ]
  it.each(checkpointReconciliationCases)("rejects checkpoint input IDs that do not reconcile: %s", async (_label, options) => {
    const value = fixture(options)
    await expect(readNativeVerificationSteeringSource(value.client, scope, exact())).resolves.toBeNull()
  })

  it("applies checkpoint input reconciliation to the latest recovery Step", async () => {
    const latest = fixture({ sources: [], latestSteps: [stepRow({ consumedInputIds: ["unresolved-input"] })] })
    await expect(readNativeVerificationSteeringSource(latest.client, scope, { kind: "latest" })).resolves.toBeNull()
  })

  it("fails closed when the matching original input has malformed content or steer delivery", async () => {
    const steer = inputRow()
    const mismatched = fixture({ rootInputs: [originalInputRow({ content: [{ type: "text", text: "different ask" }] })], sources: [steer] })
    await expect(readNativeVerificationSteeringSource(mismatched.client, scope, exact())).resolves.toBeNull()

    const steerShaped = originalInputRow({ delivery: "steer" })
    const misclassified = fixture({ rootInputs: [steerShaped], sources: [steerShaped] })
    await expect(readNativeVerificationSteeringSource(misclassified.client, scope, exact())).resolves.toBeNull()
    expect(misclassified.calls.find(call => call.sql.includes("= 'steer'"))?.values[4]).toBeNull()

    const malformedTurn = fixture({ rootTurnInput: { goal: "Find jobs", content: "not an array", clientMessageId: "root-message" }, sources: [steer] })
    await expect(readNativeVerificationSteeringSource(malformedTurn.client, scope, exact())).resolves.toBeNull()
    const explicitGoal = fixture({ rootTurnInput: { goal: "explicit goal", content: [{ type: "text", text: "Find jobs" }], clientMessageId: "root-message" }, sources: [steer] })
    await expect(readNativeVerificationSteeringSource(explicitGoal.client, scope, exact())).resolves.toHaveLength(1)
  })

  it("uses exact BIGINT comparisons and permits multibyte IDs within the database character bound", async () => {
    const inputId = "输入".repeat(100), sourceStepId = "步骤".repeat(120)
    const current = stepRow({ consumedInputIds: [], inputThroughSequence: "9007199254740994" })
    const input = inputRow({ id: inputId, acceptedSequence: "9007199254740993", consumedByStepId: sourceStepId })
    const origin = sourceStep({ id: sourceStepId, inputThroughSequence: "9007199254740993", consumedInputIds: ["root-input", inputId] })
    const value = fixture({ exactStep: current, sources: [input], sourceSteps: [origin] })
    const evidence = await readNativeVerificationSteeringSource(value.client, scope, exact())
    expect(evidence).toHaveLength(1)
    expect(value.calls.find(call => call.sql.includes('"delivery" = \'steer\''))?.values[3]).toBe("9007199254740994")
    expect(isNativeSteeringEvidence(evidence?.[0])).toBe(true)
  })

  const invalidCases: [string, Parameters<typeof fixture>[0], boolean?][] = [
    ["foreign input owner", { sources: [inputRow({ userId: "other-user" })] }],
    ["child consuming Step", { sourceSteps: [sourceStep({ taskId: "child-1" })] }],
    ["source missing from its consuming Step checkpoint", { sourceSteps: [sourceStep({ consumedInputIds: ["root-input"] })] }],
    ["source checkpoint below accepted sequence", { sourceSteps: [sourceStep({ inputThroughSequence: "7" })] }],
    ["missing consuming Step", { sourceSteps: [] }],
    ["invalid consumed timestamp", { sources: [inputRow({ consumedAt: null })] }],
    ["attached input", { sources: [inputRow({ content: [{ type: "attachment_ref", attachmentId: "file-1", mediaType: "text/plain" }] })] }],
    ["expired root lease", { owner: ownerRow({ rootLeaseLive: false }) }],
    ["unknown latest Step status", { latestSteps: [stepRow({ status: "queued" })] }, true],
  ]
  it.each(invalidCases)("fails closed for %s", async (_name, options, useLatest = false) => {
    const value = fixture(options)
    await expect(readNativeVerificationSteeringSource(value.client, scope, useLatest ? { kind: "latest" } : exact())).resolves.toBeNull()
  })

  it("rejects malformed consumed markers and noncanonical BIGINT values", async () => {
    const malformed = fixture({ sources: [inputRow({ status: "accepted" })] })
    await expect(readNativeVerificationSteeringSource(malformed.client, scope, exact())).resolves.toBeNull()
    const invalidSequence = fixture({ sources: [inputRow({ acceptedSequence: "9223372036854775808" })] })
    await expect(readNativeVerificationSteeringSource(invalidSequence.client, scope, exact())).resolves.toBeNull()
    const badIds = fixture({ exactStep: stepRow({ consumedInputIds: ["root-input", "input-1", "input-1"] }) })
    await expect(readNativeVerificationSteeringSource(badIds.client, scope, exact())).resolves.toBeNull()
  })

  it("enforces whole-input, aggregate and count bounds without clipping", async () => {
    const many = Array.from({ length: 17 }, (_unused, index) => inputRow({ id: `input-${index}`, acceptedSequence: String(index + 1), consumedByStepId: `step-${index}` }))
    const tooMany = fixture({ exactStep: stepRow({ inputThroughSequence: "30", consumedInputIds: ["root-input", ...many.map(item => String(item.id))] }), sources: many })
    await expect(readNativeVerificationSteeringSource(tooMany.client, scope, exact())).resolves.toBeNull()

    const large = fixture({ sources: [inputRow({ content: [{ type: "text", text: "x".repeat(16 * 1024) }] })] })
    await expect(readNativeVerificationSteeringSource(large.client, scope, exact())).resolves.toBeNull()

    const inputs = Array.from({ length: 5 }, (_unused, index) => inputRow({ id: `input-${index}`, acceptedSequence: String(index + 1), consumedByStepId: `step-${index}`, content: [{ type: "text", text: "x".repeat(14 * 1024) }] }))
    const steps = inputs.map((item, index) => sourceStep({ id: `step-${index}`, ordinal: index, inputThroughSequence: String(index + 1), consumedInputIds: ["root-input", String(item.id)] }))
    const aggregate = fixture({ exactStep: stepRow({ ordinal: 8, inputThroughSequence: "9", consumedInputIds: ["root-input", ...inputs.map(item => String(item.id))] }), sources: inputs, sourceSteps: steps })
    await expect(readNativeVerificationSteeringSource(aggregate.client, scope, exact())).resolves.toBeNull()
  })

  it("keeps chronological source content in the declared private schema", async () => {
    const value = fixture({ sources: [inputRow({ content: [{ type: "text", text: "first" }, { type: "text", text: "second\nexactly" }] })] })
    const result = await readNativeVerificationSteeringSource(value.client, scope, exact())
    expect(result).toHaveLength(1)
    const evidence = result![0]
    expect(evidence.kind).toBe("user_self_attestation")
    expect(JSON.parse(evidence.summary)).toEqual({ schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
      stage: NATIVE_VERIFICATION_USER_STEERING_STAGE, content: [{ type: "text", text: "first" }, { type: "text", text: "second\nexactly" }] })
    expect(isNativeSteeringEvidence(evidence)).toBe(true)
    expect(value.calls.some(call => call.sql.includes('"consumedByStepId" IS NOT NULL') || call.sql.includes('"status" = \'consumed\''))).toBe(true)
  })
})
