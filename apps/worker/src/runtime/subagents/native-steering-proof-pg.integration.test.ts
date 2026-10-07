import { randomUUID } from "node:crypto"
import { Pool, type PoolClient } from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, canonicalNativeVerificationJson,
  parseNativeVerificationControl,
} from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import { attachNativeVerificationReport } from "./native-verification-report.js"
import { readNativeVerificationTerminalProofWithClient } from "./native-verification-pg-readback.js"
import type { NativeVerificationRootGoalWitness } from "./native-verification-port.js"
import { createPgNativeVerificationPort } from "./pg-native-verification-port.js"
import { isNativeSteeringEvidence, NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
  NATIVE_VERIFICATION_USER_STEERING_STAGE } from "./native-verification-steering-contract.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, taskGraphItemId } from "./task-graph-snapshot.js"
import type { TaskGraphExecutionScope, TaskGraphReadScope } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"

const EXPECTED_URL = "postgresql://postgres:postgres@127.0.0.1:5432/applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Native steering proof requires the dedicated disposable CI URL")
    return null
  }
  const url = new URL(value)
  if (value !== EXPECTED_URL || url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1"
    || url.port !== "5432" || url.username !== "postgres" || url.password !== "postgres"
    || url.pathname !== "/applymate_agent_brain_ci" || url.search || url.hash) {
    throw new Error("Native steering proof requires the dedicated disposable CI URL")
  }
  return value
}

const databaseUrl = disposableUrl()
const describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID()
const ids = {
  user: `native-steering-user-${suffix}`, session: `native-steering-session-${suffix}`,
  turn: `native-steering-turn-${suffix}`, root: `native-steering-root-${suffix}`,
  firstStep: `native-steering-first-step-${suffix}`, secondStep: `native-steering-second-step-${suffix}`,
  thirdStep: `native-steering-third-step-${suffix}`, firstInput: `native-steering-first-input-${suffix}`,
  rootInput: `native-steering-root-input-${suffix}`,
  secondInput: `native-steering-second-input-${suffix}`, futureInput: `native-steering-future-input-${suffix}`,
  cancelledInput: `native-steering-cancelled-input-${suffix}`,
  rootClientMessage: `native-steering-root-client-${suffix}`,
  turnOwner: `native-steering-turn-owner-${suffix}`, taskOwner: `native-steering-task-owner-${suffix}`,
}
const goal = "Assess the candidate against the saved requirements."
const criteria = ["Respect complete user steering as an untrusted constraint under the unchanged goal."]
const candidateText = "The candidate meets the saved requirement and keeps the requested work arrangement in scope."
const firstSteering = "Prefer remote-friendly roles; keep the existing location constraint."
const secondSteering = "Also preserve the user's requested working hours."
let pool: Pool | undefined

const readScope: TaskGraphReadScope = {
  userId: ids.user, sessionId: ids.session, turnId: ids.turn, rootTaskId: ids.root, parentTaskId: ids.root,
  turnLeaseOwner: ids.turnOwner, turnLeaseVersion: 1, parentLeaseOwner: ids.taskOwner, parentAttemptCount: 1,
}
function executionScope(stepId: string): TaskGraphExecutionScope { return { ...readScope, stepId } }

async function seedStep(stepId: string, ordinal: number, through: number, consumedIds: readonly string[]): Promise<void> {
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds",
     "modelProfileSnapshot", "startedAt")
    VALUES ($1, $2, $3, $4, $5, 1, 'streaming', $6::bigint, $7::jsonb, '{}'::jsonb, CURRENT_TIMESTAMP)`,
  [stepId, ids.session, ids.turn, ids.root, ordinal, String(through), JSON.stringify(consumedIds)])
}

async function seedSteering(input: Readonly<{
  id: string; sequence: number; text: string; stepId: string | null; status?: string; cancelled?: boolean;
}>): Promise<void> {
  const consumed = input.stepId !== null
  await pool!.query(`INSERT INTO "agent_inputs"
    ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence",
     "consumedByStepId", "consumedAt", "cancelledAt")
    VALUES ($1, $2, $3, $4, $5, 'steer', $6, $7::jsonb, $8::bigint, $9, $10, $11)`,
  [input.id, ids.session, ids.turn, ids.user, `client-${input.id}`, input.status ?? (consumed ? "consumed" : "accepted"),
    JSON.stringify([{ type: "text", text: input.text }]), String(input.sequence), input.stepId,
    consumed ? new Date() : null, input.cancelled ? new Date() : null])
}

async function seed(): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`,
    [ids.user, `${ids.user}@example.invalid`])
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Native current steering fixture', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user])
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "revision", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, 1, CURRENT_TIMESTAMP)`,
  [ids.turn, ids.session, ids.user, JSON.stringify({ goal, content: [{ type: "text", text: goal }], clientMessageId: ids.rootClientMessage }), ids.turnOwner])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', $4,
      '[]'::jsonb, $5::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
      1, 2, $6, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`,
  [ids.root, ids.session, ids.turn, goal, JSON.stringify(criteria), ids.taskOwner])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP)`,
  [taskGraphItemId(ids.root), ids.session, ids.turn, ids.root,
    JSON.stringify({ schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION, nodes: [] })])
  await seedStep(ids.firstStep, 0, 2, [ids.rootInput, ids.firstInput])
  await pool!.query(`INSERT INTO "agent_inputs"
    ("id", "sessionId", "targetTurnId", "userId", "clientMessageId", "delivery", "status", "content", "acceptedSequence",
     "consumedByStepId", "consumedAt", "cancelledAt")
    VALUES ($1, $2, $3, $4, $5, 'follow_up', 'consumed', $6::jsonb, 1, $7, CURRENT_TIMESTAMP, NULL)`,
  [ids.rootInput, ids.session, ids.turn, ids.user, ids.rootClientMessage,
    JSON.stringify([{ type: "text", text: goal }]), ids.firstStep])
  await seedSteering({ id: ids.firstInput, sequence: 2, text: firstSteering, stepId: ids.firstStep })
  await seedSteering({ id: ids.futureInput, sequence: 99, text: "Future steering must not enter an earlier checkpoint.", stepId: null })
  await seedSteering({ id: ids.cancelledInput, sequence: 2, text: "Cancelled steering must not enter the proof.",
    stepId: null, status: "cancelled", cancelled: true })
}

async function packetFor(controlTaskId: string) {
  const stored = await pool!.query<{ context: unknown; expectedOutputSchema: unknown }>(
    `SELECT "context", "expectedOutputSchema" FROM "sub_agent_tasks" WHERE "id" = $1 AND "sessionId" = $2 AND "turnId" = $3`,
    [controlTaskId, ids.session, ids.turn])
  const marker = parseNativeVerificationControl(stored.rows[0]?.expectedOutputSchema)
  const packet = marker ? parseNativeVerificationPacket(stored.rows[0]?.context, marker) : null
  if (!marker || !packet) throw new Error("native_steering_fixture_control_invalid")
  return { marker, packet }
}

async function passControl(controlTaskId: string): Promise<void> {
  const { marker, packet } = await packetFor(controlTaskId)
  const steering = packet.evidence.find(isNativeSteeringEvidence)
  if (!steering) throw new Error("native_steering_fixture_evidence_missing")
  const modelReport = {
    schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
    criteria: packet.criteria.map(criterion => ({ criterionId: criterion.criterionId, disposition: "passed" as const,
      reasonCode: "meets_criterion" as const, evidenceReferenceIds: [steering.referenceId] })),
  }
  const report = attachNativeVerificationReport(marker, 1, modelReport)
  if (!report) throw new Error("native_steering_fixture_report_invalid")
  const result = await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "attemptCount" = 1,
      "result" = $2::jsonb, "failureReason" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
    WHERE "id" = $1 AND "status" = 'queued' AND "attemptCount" = 0 RETURNING "id"`,
  [controlTaskId, JSON.stringify({ nativeVerificationReport: report })])
  if (result.rowCount !== 1) throw new Error("native_steering_fixture_control_update_failed")
}

async function terminalAccepted(stepId: string, witness: NativeVerificationRootGoalWitness): Promise<boolean> {
  const client: PoolClient = await pool!.connect()
  let open = false
  try {
    await client.query("BEGIN"); open = true
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
    const accepted = await readNativeVerificationTerminalProofWithClient(client, { scope: readScope, candidateText, witness, stepId })
    await client.query("ROLLBACK"); open = false
    return accepted
  } finally {
    if (open) await client.query("ROLLBACK").catch(() => undefined)
    client.release()
  }
}

describePg("native steering proof PostgreSQL identity and checkpoint", () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: databaseUrl!, max: 6 })
    await seed()
  })

  afterAll(async () => {
    if (!pool) return
    try { await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session]) }
    finally {
      try { await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user]) }
      finally { await pool.end() }
    }
  })

  it("reuses an unchanged owned steering proof and rejects it after a new consumed steer", async () => {
    const port = createPgNativeVerificationPort(pool as unknown as PgSubagentPool)
    const first = await port.ensureRootGoal({ scope: executionScope(ids.firstStep), candidateText })
    expect(first.status).toBe("pending")
    expect(first.controlTaskIds).toHaveLength(1)
    const firstControlId = first.controlTaskIds[0]!
    const firstPacket = await packetFor(firstControlId)
    expect(firstPacket.packet.schemaVersion).toBe("agent-harness.v2.native-verifier-packet.v2")
    const firstEvidence = firstPacket.packet.evidence.filter(isNativeSteeringEvidence)
    expect(firstEvidence).toHaveLength(1)
    expect(JSON.parse(firstEvidence[0]!.summary)).toEqual({ schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
      stage: NATIVE_VERIFICATION_USER_STEERING_STAGE, content: [{ type: "text", text: firstSteering }] })
    const firstReference = firstEvidence[0]!.referenceId
    const firstPacketJson = JSON.stringify(firstPacket.packet)
    expect(firstReference).toMatch(/^user-self-attestation:[a-f0-9]{64}$/)
    expect(firstPacketJson.includes("Future steering must not enter an earlier checkpoint.")).toBe(false)
    expect(firstPacketJson.includes("Cancelled steering must not enter the proof.")).toBe(false)

    await passControl(firstControlId)
    const firstPass = await port.ensureRootGoal({ scope: executionScope(ids.firstStep), candidateText })
    expect(firstPass.status).toBe("passed")
    expect(firstPass.controlTaskIds).toContain(firstControlId)
    const firstWitness = firstPass.rootGoalWitness
    if (!firstWitness) throw new Error("native_steering_fixture_witness_missing")
    await expect(terminalAccepted(ids.firstStep, firstWitness)).resolves.toBe(true)

    await pool!.query(`UPDATE "agent_steps" SET "status" = 'completed', "finishReason" = 'stop', "completedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'streaming'`, [ids.firstStep])
    await seedStep(ids.secondStep, 1, 2, [])
    const unchanged = await port.ensureRootGoal({ scope: executionScope(ids.secondStep), candidateText })
    expect(unchanged.status).toBe("passed")
    expect(unchanged.controlTaskIds).toContain(firstControlId)
    expect(unchanged.rootGoalWitness).toEqual(firstWitness)
    const unchangedPacket = await packetFor(firstControlId)
    expect(unchangedPacket.packet.evidence.filter(isNativeSteeringEvidence)).toEqual(firstEvidence)
    await expect(terminalAccepted(ids.secondStep, firstWitness)).resolves.toBe(true)
    const recoveredUnchanged = await port.readRecoverableGoal(readScope)
    expect(recoveredUnchanged).toMatchObject({ status: "passed", controlTaskId: firstControlId, candidateText })

    await pool!.query(`UPDATE "agent_steps" SET "status" = 'completed', "finishReason" = 'stop', "completedAt" = CURRENT_TIMESTAMP
      WHERE "id" = $1 AND "status" = 'streaming'`, [ids.secondStep])
    await seedStep(ids.thirdStep, 2, 2, [])
    await seedSteering({ id: ids.secondInput, sequence: 3, text: secondSteering, stepId: ids.thirdStep })
    await pool!.query(`UPDATE "agent_steps" SET "inputThroughSequence" = 3, "consumedInputIds" = $2::jsonb WHERE "id" = $1`,
      [ids.thirdStep, JSON.stringify([ids.secondInput])])

    const changed = await port.ensureRootGoal({ scope: executionScope(ids.thirdStep), candidateText })
    expect(changed.status).toBe("pending")
    expect(changed.controlTaskIds).toHaveLength(1)
    const secondControlId = changed.controlTaskIds[0]!
    expect(secondControlId).not.toBe(firstControlId)
    const changedPacket = await packetFor(secondControlId)
    const changedEvidence = changedPacket.packet.evidence.filter(isNativeSteeringEvidence)
    expect(changedEvidence).toHaveLength(2)
    expect(JSON.parse(changedEvidence[0]!.summary)).toEqual(JSON.parse(firstEvidence[0]!.summary))
    expect(JSON.parse(changedEvidence[1]!.summary)).toEqual({ schemaVersion: NATIVE_VERIFICATION_USER_STEERING_SCHEMA,
      stage: NATIVE_VERIFICATION_USER_STEERING_STAGE, content: [{ type: "text", text: secondSteering }] })
    expect(canonicalNativeVerificationJson(changedEvidence)).not.toBe(canonicalNativeVerificationJson(firstEvidence))

    const recoveredChanged = await port.readRecoverableGoal(readScope)
    expect(recoveredChanged).not.toMatchObject({ status: "passed", controlTaskId: firstControlId })
    await expect(terminalAccepted(ids.thirdStep, firstWitness)).resolves.toBe(false)
    await expect(terminalAccepted(ids.firstStep, firstWitness)).resolves.toBe(false)

    await passControl(secondControlId)
    const currentPass = await port.ensureRootGoal({ scope: executionScope(ids.thirdStep), candidateText })
    expect(currentPass.status).toBe("passed")
    expect(currentPass.controlTaskIds).toContain(secondControlId)
    const currentWitness = currentPass.rootGoalWitness
    if (!currentWitness) throw new Error("native_steering_fixture_current_witness_missing")
    await expect(port.readRecoverableGoal(readScope)).resolves.toMatchObject({ status: "passed", controlTaskId: secondControlId, candidateText })
    await expect(terminalAccepted(ids.thirdStep, currentWitness)).resolves.toBe(true)
    await expect(terminalAccepted(ids.firstStep, currentWitness)).resolves.toBe(false)
    await pool!.query(`UPDATE "agent_inputs" SET "clientMessageId" = $2 WHERE "id" = $1`, [ids.rootInput, `orphan-${suffix}`])
    await expect(port.ensureRootGoal({ scope: executionScope(ids.thirdStep), candidateText })).resolves.toMatchObject({ status: "unavailable" })
  }, 60_000)
})
