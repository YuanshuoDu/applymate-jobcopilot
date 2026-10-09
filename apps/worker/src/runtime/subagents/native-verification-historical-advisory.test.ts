import { Buffer } from "node:buffer"
import { describe, expect, it, vi } from "vitest"
import type pg from "pg"
import {
  NATIVE_VERIFICATION_CONTROL_SCHEMA, NATIVE_VERIFICATION_PACKET_SCHEMA,
  digestNativeVerificationValue, type NativeVerificationControl, type NativeVerificationPacket,
} from "./native-verification-contract.js"
import { attachNativeVerificationReport, parseNativeVerificationModelReport } from "./native-verification-report.js"
import { createNativeVerificationContext } from "./native-verification-packet.js"
import { hydrateNativeVerificationHistoricalAdvisories } from "./native-verification-historical-advisory.js"

const lease = { userId: "user-1", sessionId: "session-1", turnId: "current-turn" }
const createdAt = new Date("2026-10-06T10:00:00.000Z")
function proof(input: { turnId?: string; rootTaskId?: string; taskId?: string; goal?: string; criteria?: string[]; status?: string; failureReason?: string | null; disposition?: "failed" | "uncertain" | "passed"; failedCriterion?: number; reasonCode?: "does_not_meet_criterion" | "evidence_conflict" | "unsupported_claim" | "ambiguous" }) {
  const turnId = input.turnId ?? "prior-turn", rootTaskId = input.rootTaskId ?? `root-${turnId}`, taskId = input.taskId ?? `control-${turnId}`
  const goal = input.goal ?? "Find suitable roles", criteria = input.criteria ?? ["Use verified job facts", "Explain relevance"]
  const packet: NativeVerificationPacket = {
    schemaVersion: NATIVE_VERIFICATION_PACKET_SCHEMA, controlOperationId: `op-${turnId}`, controlTaskId: taskId, goal,
    criteria: criteria.map((requirement, index) => ({ criterionId: `criterion-${index + 1}`, requirement })),
    target: { kind: "root_goal", candidateDigest: digestNativeVerificationValue("private candidate"), referenceId: "private-candidate-ref", candidateText: "private candidate" },
    evidence: [{ referenceId: "private-evidence-ref", kind: "artifact", summary: "private packet summary" }],
  }
  const control: NativeVerificationControl = {
    schemaVersion: NATIVE_VERIFICATION_CONTROL_SCHEMA, controlOperationId: packet.controlOperationId, controlTaskId: taskId,
    owner: { userId: "user-1", sessionId: "session-1", turnId, rootTaskId, parentTaskId: rootTaskId },
    target: { kind: "root_goal", candidateDigest: packet.target.kind === "root_goal" ? packet.target.candidateDigest : "", childBindingSetDigest: "a".repeat(64) },
    goalDigest: digestNativeVerificationValue(goal), criteriaDigest: digestNativeVerificationValue(packet.criteria), evidencePacketDigest: digestNativeVerificationValue(packet),
  }
  const failedCriterion = input.failedCriterion ?? 0
  const verdicts = packet.criteria.map((item, index) => ({ criterionId: item.criterionId,
    disposition: index === failedCriterion ? input.disposition ?? "failed" : "passed",
    reasonCode: index === failedCriterion ? input.reasonCode ?? (input.disposition === "uncertain" ? "ambiguous" : input.disposition === "passed" ? "meets_criterion" : "does_not_meet_criterion") : "meets_criterion",
    evidenceReferenceIds: index === failedCriterion && input.disposition === "uncertain" ? [] : [index === failedCriterion ? "private-candidate-ref" : "private-evidence-ref"],
  }))
  const modelReport = parseNativeVerificationModelReport({ schemaVersion: "agent-harness.v2.native-verifier-model-report.v1", criteria: verdicts }, packet)!
  const report = attachNativeVerificationReport(control, 2, modelReport)!
  return {
    id: taskId, userId: "user-1", sessionId: "session-1", turnId, rootTaskId, parentTaskId: rootTaskId,
    role: "auditor", taskType: "native_verification", status: input.status ?? "completed", attemptCount: 2,
    failureReason: input.failureReason ?? null, expectedOutputSchema: control, context: createNativeVerificationContext(packet),
    result: { nativeVerificationReport: report }, createdAt: new Date("2026-10-06T09:00:00.000Z"),
  }
}

function fakeClient(options: { roots?: Record<string, unknown>[]; turns?: Record<string, unknown>[]; controls?: Record<string, unknown>[]; hasSteer?: unknown; currentStartedSequence?: unknown } = {}) {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('SELECT EXISTS') && sql.includes('FROM "agent_inputs"')) return { rows: [{ hasSteer: Object.hasOwn(options, "hasSteer") ? options.hasSteer : false }], rowCount: 1 }
    if (sql.includes('FROM "sub_agent_tasks" AS root')) return { rows: options.roots ?? [], rowCount: options.roots?.length ?? 0 }
    if (sql.includes('WITH current_start AS')) {
      const currentStartedSequence = Object.hasOwn(options, "currentStartedSequence") ? options.currentStartedSequence : "100"
      const rows = (options.turns ?? []).map((turn, index) => ({
        ...turn, currentStartedSequence: Array.isArray(currentStartedSequence) ? currentStartedSequence[index] : currentStartedSequence,
      }))
      return { rows, rowCount: rows.length }
    }
    if (sql.includes('FROM "sub_agent_tasks" AS task')) return { rows: options.controls ?? [], rowCount: options.controls?.length ?? 0 }
    return { rows: [], rowCount: 0 }
  })
  return { query } as unknown as Pick<pg.PoolClient, "query"> & { query: typeof query }
}

function turnRow(task: ReturnType<typeof proof>, startedSequence: unknown = "10", rowCreatedAt = task.createdAt) {
  return { id: task.turnId, rootTaskId: task.rootTaskId, createdAt: rowCreatedAt, startedSequence }
}

function call(client: Pick<pg.PoolClient, "query">, patch: Record<string, unknown> = {}) {
  return hydrateNativeVerificationHistoricalAdvisories(client, {
    lease, currentTurnCreatedAt: createdAt, currentInput: { goal: "Find suitable roles", successCriteria: ["Use verified job facts", "Explain relevance"] },
    currentRootTaskId: null, ...patch,
  })
}

describe("historical native verification advisories", () => {
  it("hydrates only parser-validated failed criteria for an exact objective as bounded untrusted notes", async () => {
    const task = proof({ disposition: "uncertain" })
    const client = fakeClient({ turns: [turnRow(task)], controls: [task] })
    const notes = await call(client)
    expect(notes).toHaveLength(1)
    expect(notes[0]).toEqual({ id: "native-verification-advisory:0", content: {
      type: "historical_native_verification_advisory", label: "Historical advisory only", goal: "Find suitable roles",
      criterionId: "criterion-1", requirement: "Use verified job facts", disposition: "uncertain", reasonCode: "ambiguous",
      evidenceReferenceIds: [],
    } })
    expect(Buffer.byteLength(JSON.stringify(notes), "utf8")).toBeLessThanOrEqual(24 * 1024)
    expect(JSON.stringify(notes)).not.toMatch(/private candidate|private packet|private-evidence|control-prior|evidencePacketDigest|controlOperationId/)
    const queries = client.query.mock.calls.map(([sql]) => sql)
    expect(queries.every(sql => !sql.includes("FOR UPDATE") && !sql.startsWith("UPDATE") && !sql.startsWith("INSERT"))).toBe(true)
    expect(queries.some(sql => sql.includes('prior_start."sequence" < current_start."sequence"') && sql.includes("LIMIT 8"))).toBe(true)
    expect(queries.some(sql => sql.includes("LIMIT 64"))).toBe(true)
  })

  it("omits changed goal or any changed/invalid criterion list without truncation", async () => {
    const task = proof({})
    const client = fakeClient({ turns: [turnRow(task)], controls: [task] })
    expect(await call(client, { currentInput: { goal: "Changed goal", successCriteria: ["Use verified job facts", "Explain relevance"] } })).toEqual([])
    expect(await call(client, { currentInput: { goal: "Find suitable roles", successCriteria: ["Explain relevance", "Use verified job facts"] } })).toEqual([])
    expect(await call(client, { currentInput: { goal: "Find suitable roles", content: "Other goal", successCriteria: ["Use verified job facts", "Explain relevance"] } })).toEqual([])
  })

  it("omits history when accepted, queued, or consumed non-cancelled steer exists without reading its content", async () => {
    const task = proof({})
    const options = { turns: [turnRow(task)], controls: [task] }
    for (const hasSteer of [true, "false", null]) {
      const client = fakeClient({ ...options, hasSteer })
      expect(await call(client)).toEqual([])
      const query = client.query.mock.calls.find(([sql]) => sql.includes('SELECT EXISTS'))?.[0] ?? ""
      expect(query).toContain('"delivery" = \'steer\'')
      expect(query).toContain('"status" IN (\'accepted\', \'queued\', \'consumed\')')
      expect(query).toContain('"cancelledAt" IS NULL')
      expect(query).not.toContain('"content"')
      expect(client.query.mock.calls.some(([sql]) => sql.includes('FROM "agent_turns" AS turn'))).toBe(false)
    }
  })

  it("requires terminal same-owner root/parent/task lineage and a successful runtime attempt", async () => {
    const valid = proof({})
    const turns = [turnRow(valid)]
    for (const changed of [
      { ...valid, userId: "foreign-user" }, { ...valid, sessionId: "foreign-session" }, { ...valid, parentTaskId: "foreign-root" },
      { ...valid, rootTaskId: "foreign-root" }, { ...valid, status: "failed" }, { ...valid, failureReason: "worker crashed" },
      { ...valid, attemptCount: 0 }, { ...valid, result: { nativeVerificationReport: { schemaVersion: "forged" } } },
    ]) expect(await call(fakeClient({ turns, controls: [changed] }))).toEqual([])
    const equalPrior = proof({ turnId: "equal-prior" })
    const current = proof({ turnId: "current-turn" })
    const equalFuture = proof({ turnId: "equal-future" })
    const unsequenced = proof({ turnId: "unsequenced" })
    const chronology = await call(fakeClient({
      turns: [turnRow(equalPrior, "99", createdAt), turnRow(current, "100", createdAt),
        turnRow(equalFuture, "101", createdAt), turnRow(unsequenced, null, createdAt)],
      controls: [equalPrior, current, equalFuture, unsequenced],
    }))
    expect(chronology).toHaveLength(1)
    expect(chronology[0]?.content).toMatchObject({ criterionId: "criterion-1", disposition: "failed" })
    expect(await call(fakeClient({ currentStartedSequence: null, turns: [turnRow(equalPrior, "99", createdAt)], controls: [equalPrior] }))).toEqual([])
    expect(await call(fakeClient({ currentStartedSequence: "ambiguous", turns: [turnRow(equalPrior, "99", createdAt)], controls: [equalPrior] }))).toEqual([])
    expect(await call(fakeClient({ currentStartedSequence: ["100", "101"], turns: [turnRow(equalPrior, "99", createdAt), turnRow(equalFuture, "98", createdAt)], controls: [equalPrior, equalFuture] }))).toEqual([])
    const futureTask = proof({ turnId: "future", rootTaskId: "future-root", taskId: "future-control" })
    expect(await call(fakeClient({ turns: [turnRow(futureTask, "101", new Date(createdAt.getTime() + 1))], controls: [futureTask] }))).toEqual([])
  })

  it("uses the current owned root criteria and caps unique notes at three", async () => {
    const task = proof({ criteria: ["Use verified job facts", "Explain relevance", "Keep concise", "Avoid assumptions"], disposition: "failed" })
    const client = fakeClient({
      roots: [{ goal: "Find suitable roles", successCriteria: ["Use verified job facts", "Explain relevance"] }],
      turns: [turnRow(task)], controls: [task],
    })
    const notes = await call(client, { currentRootTaskId: "current-root" })
    expect(notes).toHaveLength(0)
    const currentCriteria = ["Use verified job facts", "Explain relevance", "Keep concise", "Avoid assumptions"]
    const same = fakeClient({
      roots: [{ goal: "Find suitable roles", successCriteria: currentCriteria }],
      turns: [task, proof({ turnId: "prior-2", criteria: currentCriteria }), proof({ turnId: "prior-3", criteria: currentCriteria })].map((item, index) => turnRow(item, String(10 + index))),
      controls: [task, proof({ turnId: "prior-2", criteria: currentCriteria, failedCriterion: 1 }), proof({ turnId: "prior-3", criteria: currentCriteria, failedCriterion: 2 })],
    })
    const bounded = await call(same, { currentRootTaskId: "current-root", currentInput: { goal: "Find suitable roles", successCriteria: currentCriteria } })
    expect(bounded).toHaveLength(3)
    expect(bounded.map(item => item.id)).toEqual(["native-verification-advisory:0", "native-verification-advisory:1", "native-verification-advisory:2"])
  })

  it("omits whole oversize notes and rejects a missing current root binding", async () => {
    const longGoal = '"'.repeat(4_000), requirement = '"'.repeat(2_000)
    const task = proof({ goal: longGoal, criteria: [requirement] })
    const client = fakeClient({ turns: [turnRow(task)], controls: [task] })
    expect(await call(client, { currentInput: { goal: longGoal, successCriteria: [requirement] } })).toEqual([])
    expect(await call(fakeClient({ roots: [], turns: [turnRow(task)], controls: [task] }), { currentRootTaskId: "missing-root" })).toEqual([])
  })
})
