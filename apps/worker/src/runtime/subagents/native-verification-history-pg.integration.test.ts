import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"
import type { InputContentPart } from "@jobcopilot/agent-protocol/input"
import {
  canonicalNativeVerificationJson, digestNativeVerificationValue, parseNativeVerificationControl,
  NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
} from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import { attachNativeVerificationReport } from "./native-verification-report.js"
import { ensureNativeVerificationControl } from "./native-verification-pg-request.js"
import { hydrateNativeVerificationHistoricalAdvisories } from "./native-verification-historical-advisory.js"
import { transaction } from "./pg-store-persistence.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import type { NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import type { PgSubagentPool } from "./types.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Historical native advisory acceptance needs the dedicated disposable CI URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Historical native advisory acceptance requires the dedicated disposable CI URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID()
const ids = {
  user: `native-history-user-${suffix}`, session: `native-history-session-${suffix}`,
  foreignSession: `native-history-foreign-session-${suffix}`,
  turn: (name: string) => `native-history-turn-${name}-${suffix}`,
  root: (name: string) => `native-history-root-${name}-${suffix}`,
  step: (name: string) => `native-history-step-${name}-${suffix}`,
}
const goal = "Prepare a factual answer"
const criteria = ["Cite all source facts", "Avoid unverified claims"]
const privateCandidate = (name: string) => `Private candidate sentinel ${name}`
const privateEvidence = (name: string) => `Private evidence sentinel ${name}`
let pool: PgPool | undefined

type TurnFixture = Readonly<{ name: string; sessionId: string; turnId: string; rootTaskId: string; stepId: string; createdAt: Date; scope: TaskGraphExecutionScope }>
type TurnSpec = Readonly<{ name: string; sessionId?: string; createdAt: Date; goal?: string; criteria?: readonly string[] }>

function commandTurnInput(turnGoal: string): Readonly<{ goal: string; content: InputContentPart[]; clientMessageId: string }> {
  return { goal: turnGoal, content: [{ type: "text", text: turnGoal }], clientMessageId: randomUUID() }
}

async function createTurn(spec: TurnSpec): Promise<TurnFixture> {
  const sessionId = spec.sessionId ?? ids.session
  const turnId = ids.turn(spec.name), rootTaskId = ids.root(spec.name), stepId = ids.step(spec.name)
  const turnOwner = `native-history-turn-owner-${spec.name}-${suffix}`, taskOwner = `native-history-task-owner-${spec.name}-${suffix}`
  const turnGoal = spec.goal ?? goal, turnCriteria = spec.criteria ?? criteria
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "createdAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, $6, CURRENT_TIMESTAMP)`,
  [turnId, sessionId, ids.user, JSON.stringify(commandTurnInput(turnGoal)), turnOwner, spec.createdAt])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', $4,
      '[]'::jsonb, $5::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
      1, 2, $6, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
  [rootTaskId, sessionId, turnId, turnGoal, JSON.stringify(turnCriteria), taskOwner])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [rootTaskId])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [rootTaskId, turnId])
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [stepId, sessionId, turnId, rootTaskId])
  return {
    name: spec.name, sessionId, turnId, rootTaskId, stepId, createdAt: spec.createdAt,
    scope: { userId: ids.user, sessionId, turnId, rootTaskId, parentTaskId: rootTaskId,
      stepId, turnLeaseOwner: turnOwner, turnLeaseVersion: 1, parentLeaseOwner: taskOwner, parentAttemptCount: 1 },
  }
}

async function createControl(turn: TurnFixture, spec: TurnSpec & Readonly<{
  badReport?: boolean; persistedAttempt?: number; reportAttempt?: number; dispositions?: readonly ("failed" | "uncertain")[];
}>): Promise<void> {
  const packetGoal = spec.goal ?? goal, packetCriteria = spec.criteria ?? criteria
  const candidateText = privateCandidate(turn.name)
  const target = { kind: "root_goal" as const, candidateDigest: digestNativeVerificationValue(candidateText), childBindingSetDigest: "c".repeat(64) }
  const content: NativeVerificationPacketContent = {
    goal: packetGoal,
    criteria: packetCriteria.map((requirement, index) => ({ criterionId: `criterion-${index + 1}`, requirement })),
    target: { kind: "root_goal", candidateDigest: target.candidateDigest, referenceId: `candidate-${turn.name}`, candidateText },
    evidence: [{ referenceId: `evidence-${turn.name}`, kind: "tool_result", summary: privateEvidence(turn.name) }],
  }
  const ensured = await transaction(pool as unknown as PgSubagentPool, async client => {
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
    const parent = await client.query<{ budgetSnapshot: unknown }>(`SELECT "budgetSnapshot" FROM "sub_agent_tasks" WHERE "id" = $1`, [turn.rootTaskId])
    if (!parent.rows[0]) throw new Error("historical_fixture_parent_missing")
    const created = await ensureNativeVerificationControl(client, { scope: turn.scope, parent: parent.rows[0], target, content })
    if (!created) throw new Error("historical_fixture_control_not_created")
    return created
  })
  const packet = parseNativeVerificationPacket({ nativeVerificationPacket: ensured.packet }, ensured.control)
  const control = parseNativeVerificationControl(ensured.control)
  if (!packet || !control) throw new Error("historical_fixture_packet_invalid")
  const modelReport = {
    schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
    criteria: packet.criteria.map((criterion, index) => ({
      criterionId: criterion.criterionId,
      disposition: spec.dispositions?.[index] ?? "failed",
      reasonCode: index === 1 && spec.dispositions?.[index] === "uncertain" ? "ambiguous" as const : "does_not_meet_criterion" as const,
      evidenceReferenceIds: [packet.evidence[0]!.referenceId],
    })),
  }
  const report = attachNativeVerificationReport(control, spec.reportAttempt ?? 1, modelReport)
  if (!report) throw new Error("historical_fixture_report_invalid")
  const savedReport = spec.badReport ? { ...report, evidencePacketDigest: "0".repeat(64) } : report
  await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "attemptCount" = $2, "result" = $3::jsonb,
    "failureReason" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
  [ensured.taskId, spec.persistedAttempt ?? 1, JSON.stringify({ nativeVerificationReport: savedReport })])
}

async function finishTurn(turn: TurnFixture): Promise<void> {
  await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "result" = '{}'::jsonb,
    "leaseOwner" = NULL, "leaseExpiresAt" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [turn.rootTaskId])
  await pool!.query(`UPDATE "agent_turns" SET "status" = 'completed', "leaseOwnerId" = NULL, "leaseExpiresAt" = NULL,
    "leaseStartedAt" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [turn.turnId])
}

describePg("historical native verification advisory PostgreSQL fixture", () => {
  const base = new Date(Date.now() - 60 * 60 * 1000)
  let current: TurnFixture
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 8 })
    await pool.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
    await pool.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
      VALUES ($1, $2, 'Historical advisory disposable fixture', 'running', 'test', CURRENT_TIMESTAMP),
             ($3, $2, 'Foreign historical advisory fixture', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user, ids.foreignSession])

    const seedTerminal = async (spec: TurnSpec & Parameters<typeof createControl>[1]) => {
      const turn = await createTurn(spec)
      await createControl(turn, spec)
      await finishTurn(turn)
      return turn
    }
    await seedTerminal({ name: "valid-old", createdAt: new Date(base.getTime() + 10_000), dispositions: ["failed", "uncertain"] })
    await seedTerminal({ name: "valid-new", createdAt: new Date(base.getTime() + 20_000), dispositions: ["failed", "uncertain"] })
    await seedTerminal({ name: "wrong-goal", createdAt: new Date(base.getTime() + 30_000), goal: "A different objective" })
    await seedTerminal({ name: "wrong-criteria", createdAt: new Date(base.getTime() + 40_000), criteria: [criteria[0]!, "A different criterion"] })
    await seedTerminal({ name: "bad-report", createdAt: new Date(base.getTime() + 50_000), badReport: true })
    await seedTerminal({ name: "wrong-attempt", createdAt: new Date(base.getTime() + 60_000), persistedAttempt: 2, reportAttempt: 1 })
    await seedTerminal({ name: "foreign", sessionId: ids.foreignSession, createdAt: new Date(base.getTime() + 70_000) })
    await seedTerminal({ name: "future", createdAt: new Date(base.getTime() + 120_000) })
    current = await createTurn({ name: "current", createdAt: new Date(base.getTime() + 90_000) })
    await createControl(current, { name: current.name, createdAt: current.createdAt, dispositions: ["failed", "uncertain"] })
    const persisted = await pool.query<{ id: string; input: unknown }>(`SELECT "id", "input" FROM "agent_turns" WHERE "id" = ANY($1::text[])`, [[ids.turn("valid-old"), current.turnId]])
    expect(persisted.rows).toHaveLength(2)
    for (const row of persisted.rows) expect(row.input).toMatchObject({
      goal, content: [{ type: "text", text: goal }], clientMessageId: expect.any(String),
    })
  })

  afterAll(async () => {
    if (!pool) return
    await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = ANY($1::text[])`, [[ids.session, ids.foreignSession]])
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    await pool.end()
  })

  it("projects only deduplicated matching prior terminal reports and excludes active, future, mismatched, and foreign Turns", async () => {
    const read = async () => {
      const client: PoolClient = await pool!.connect()
      let open = false
      try {
        await client.query("BEGIN")
        open = true
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        const row = await client.query<{ createdAt: Date; input: unknown }>(`SELECT "createdAt", "input" FROM "agent_turns" WHERE "id" = $1`, [current.turnId])
        if (!row.rows[0]) throw new Error("historical_fixture_current_turn_missing")
        return await hydrateNativeVerificationHistoricalAdvisories(client, {
          lease: { userId: ids.user, sessionId: ids.session, turnId: current.turnId },
          currentTurnCreatedAt: row.rows[0].createdAt, currentInput: row.rows[0].input, currentRootTaskId: current.rootTaskId,
        })
      } finally {
        if (open) await client.query("ROLLBACK").catch(() => undefined)
        client.release()
      }
    }
    const advisories = await read()
    expect(await read()).toEqual(advisories)
    expect(advisories).toHaveLength(2)
    expect(advisories.map(item => item.id)).toEqual(["native-verification-advisory:0", "native-verification-advisory:1"])
    expect(advisories.map(item => item.content)).toEqual([
      { type: "historical_native_verification_advisory", label: "Historical advisory only", goal,
        criterionId: "criterion-1", requirement: criteria[0], disposition: "failed", reasonCode: "does_not_meet_criterion", evidenceReferenceIds: ["prior-evidence-1"] },
      { type: "historical_native_verification_advisory", label: "Historical advisory only", goal,
        criterionId: "criterion-2", requirement: criteria[1], disposition: "uncertain", reasonCode: "ambiguous", evidenceReferenceIds: ["prior-evidence-1"] },
    ])
    const publicText = JSON.stringify(advisories)
    for (const name of ["valid-old", "valid-new", "wrong-goal", "wrong-criteria", "bad-report", "wrong-attempt", "foreign", "future", "current"]) {
      expect(publicText).not.toContain(name)
      expect(publicText).not.toContain(privateCandidate(name))
      expect(publicText).not.toContain(privateEvidence(name))
    }
    expect(publicText).not.toContain(ids.user)
    expect(publicText).not.toContain(ids.session)
    expect(publicText).not.toContain(ids.foreignSession)
    expect(publicText).not.toContain("native-verifier-report.v1")
    expect(publicText).not.toContain(NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA)
    expect(publicText).not.toContain("evidence-valid-new")
    expect(publicText).not.toContain("candidate-valid-new")
    expect(Buffer.byteLength(publicText, "utf8")).toBeLessThanOrEqual(24 * 1024)

    const steerId = `native-history-steer-${suffix}`
    await pool!.query(`INSERT INTO "agent_inputs"
      ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence")
      VALUES ($1, $2, $3, $4, $5, 'steer', 'accepted', $6::jsonb, 99)`,
    [steerId, ids.session, current.turnId, ids.user, `client-${steerId}`, JSON.stringify([{ type: "text", text: "Change the objective" }])])
    await expect(read()).resolves.toEqual([])
    await pool!.query(`UPDATE "agent_inputs" SET "status" = 'consumed', "consumedByStepId" = $2, "consumedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [steerId, current.stepId])
    await expect(read()).resolves.toEqual([])
    await pool!.query(`UPDATE "agent_inputs" SET "status" = 'cancelled', "cancelledAt" = CURRENT_TIMESTAMP WHERE "id" = $1`, [steerId])
    await expect(read()).resolves.toEqual(advisories)
  }, 60_000)
})
