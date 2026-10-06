import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { Pool as PgPool, type PoolClient } from "pg"
import {
  canonicalNativeVerificationJson, digestNativeVerificationValue, parseNativeVerificationControl,
} from "./native-verification-contract.js"
import { parseNativeVerificationPacket } from "./native-verification-packet.js"
import { attachNativeVerificationReport } from "./native-verification-report.js"
import { readNativeVerificationTerminalProofWithClient } from "./native-verification-pg-readback.js"
import { ensureNativeVerificationControl } from "./native-verification-pg-request.js"
import { buildNativeChildPacketContent, type NativeVerificationPacketContent } from "./native-verification-pg-evidence.js"
import { loadNativeVerificationOwnedState, nativeVerificationBindingDigest, nativeVerificationTarget } from "./native-verification-pg-bindings.js"
import { nativeVerificationHistory } from "./native-verification-pg-readback.js"
import { createPgNativeVerificationPort } from "./pg-native-verification-port.js"
import { transaction } from "./pg-store-persistence.js"
import { TASK_GRAPH_NATIVE_METADATA_VERSION } from "./task-graph-native-state.js"
import { TASK_GRAPH_SNAPSHOT_VERSION, parseTaskGraphSnapshot, taskGraphItemId } from "./task-graph-snapshot.js"
import { loadTaskGraph } from "./task-graph-pg-state.js"
import type { TaskGraphExecutionScope } from "./task-graph-command-port.js"
import type { PgSubagentPool } from "./types.js"

const DATABASE_NAME = "applymate_agent_brain_ci"
function disposableUrl(): string | null {
  const required = process.env.AGENT_RUNTIME_PG_TEST_REQUIRED === "true"
  const value = process.env.AGENT_RUNTIME_PG_TEST_URL
  if (process.env.CI !== "true" && !required) return null
  if (!value || process.env.AGENT_RUNTIME_PG_TEST_DISPOSABLE !== "true") {
    if (required) throw new Error("Native verification PostgreSQL acceptance needs the dedicated disposable CI URL")
    return null
  }
  const url = new URL(value)
  if (url.protocol !== "postgresql:" || url.hostname !== "127.0.0.1" || url.port !== "5432"
    || url.username !== "postgres" || url.password !== "postgres" || url.pathname !== `/${DATABASE_NAME}`
    || url.search || url.hash) throw new Error("Native verification PostgreSQL acceptance requires the dedicated disposable CI URL")
  return value
}

const databaseUrl = disposableUrl(), describePg = databaseUrl ? describe : describe.skip
const suffix = randomUUID(), ids = {
  user: `native-verify-user-${suffix}`, session: `native-verify-session-${suffix}`, turn: `native-verify-turn-${suffix}`,
  root: `native-verify-root-${suffix}`, rootStep: `native-verify-root-step-${suffix}`, child: `native-verify-child-${suffix}`,
  childStep: `native-verify-child-step-${suffix}`, toolCallItem: `native-verify-tool-call-${suffix}`,
  toolItem: `native-verify-tool-item-${suffix}`, duplicateToolItem: `native-verify-duplicate-tool-item-${suffix}`,
  turnOwner: `native-verify-turn-owner-${suffix}`, taskOwner: `native-verify-task-owner-${suffix}`,
}
const goal = "Find and verify the persisted source facts"
const criteria = ["Cite the owned tool result"]
const childResult = { answer: "The source records fact 42" }
const toolOutput = { facts: ["Fact 42 is present in the owned result"] }
const metadata = {
  schemaVersion: TASK_GRAPH_NATIVE_METADATA_VERSION, operationKind: "spawn", operationId: "native-op-576",
  requestFingerprint: "a".repeat(64), callerTaskId: ids.root, role: "analyst", taskType: "research",
  contextDigest: "b".repeat(64), contextBytes: 0,
}
const snapshot = parseTaskGraphSnapshot({
  schemaVersion: TASK_GRAPH_SNAPSHOT_VERSION,
  nodes: [{ key: "native-child", templateId: "native", goal, successCriteria: criteria, dependsOn: [], depth: 1,
    taskId: ids.child, verificationDisposition: "legacy_unverified", nativeDelegation: metadata }],
})
const scope: TaskGraphExecutionScope = {
  userId: ids.user, sessionId: ids.session, turnId: ids.turn, rootTaskId: ids.root, parentTaskId: ids.root,
  stepId: ids.rootStep, turnLeaseOwner: ids.turnOwner, turnLeaseVersion: 1,
  parentLeaseOwner: ids.taskOwner, parentAttemptCount: 1,
}
const candidateText = "Verified answer.\n"
let pool: PgPool | undefined

async function seed(): Promise<void> {
  await pool!.query(`INSERT INTO "User" ("id", "email", "updatedAt") VALUES ($1, $2, CURRENT_TIMESTAMP)`, [ids.user, `${ids.user}@example.invalid`])
  await pool!.query(`INSERT INTO "agent_sessions" ("id", "userId", "goal", "status", "source", "updatedAt")
    VALUES ($1, $2, 'Native verifier disposable integration', 'running', 'test', CURRENT_TIMESTAMP)`, [ids.session, ids.user])
  await pool!.query(`INSERT INTO "agent_turns"
    ("id", "sessionId", "userId", "rootTaskId", "status", "source", "input", "modelProfileSnapshot", "toolPolicySnapshot", "budgetSnapshot",
     "leaseOwnerId", "leaseExpiresAt", "leaseStartedAt", "leaseVersion", "updatedAt")
    VALUES ($1, $2, $3, NULL, 'in_progress', 'user', $4::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      $5, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP, 1, CURRENT_TIMESTAMP)`,
  [ids.turn, ids.session, ids.user, JSON.stringify({ goal: "Original user objective", successCriteria: ["Satisfy original objective"] }), ids.turnOwner])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "leaseOwner", "leaseExpiresAt", "updatedAt")
    VALUES ($1, $2, $3, NULL, NULL, '/root', 0, 'orchestrator', 'root', 'running', 'Original user objective',
      '[]'::jsonb, '["Satisfy original objective"]'::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{"subagentPolicy":{"maxConcurrency":8,"maxDepth":8,"maxFanOut":8,"maxAttempts":2}}'::jsonb,
      1, 2, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes', CURRENT_TIMESTAMP)`, [ids.root, ids.session, ids.turn, ids.taskOwner])
  await pool!.query(`UPDATE "sub_agent_tasks" SET "rootTaskId" = $1 WHERE "id" = $1`, [ids.root])
  await pool!.query(`UPDATE "agent_turns" SET "rootTaskId" = $1 WHERE "id" = $2`, [ids.root, ids.turn])
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 1, 1, 'streaming', 0, '[]'::jsonb, '{}'::jsonb)`, [ids.rootStep, ids.session, ids.turn, ids.root])
  await pool!.query(`INSERT INTO "sub_agent_tasks"
    ("id", "sessionId", "turnId", "rootTaskId", "parentTaskId", "path", "depth", "role", "taskType", "status", "goal",
     "constraints", "successCriteria", "allowedActions", "context", "expectedOutputSchema", "result", "modelProfileSnapshot", "toolPolicySnapshot",
     "budgetSnapshot", "attemptCount", "maxAttempts", "updatedAt")
    VALUES ($1, $2, $3, $4, $4, '/root/native-child', 1, 'analyst', 'research', 'completed', $5,
      '[]'::jsonb, $6::jsonb, '[]'::jsonb, '{}'::jsonb, '{}'::jsonb, $7::jsonb, '{}'::jsonb, '{}'::jsonb,
      '{}'::jsonb, 1, 2, CURRENT_TIMESTAMP)`, [ids.child, ids.session, ids.turn, ids.root, goal, JSON.stringify(criteria), JSON.stringify(childResult)])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "taskId", "type", "status", "revision", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, 'task_graph', 'completed', 1, $5::jsonb, CURRENT_TIMESTAMP)`, [taskGraphItemId(ids.root), ids.session, ids.turn, ids.root, JSON.stringify(snapshot)])
  await pool!.query(`INSERT INTO "agent_steps"
    ("id", "sessionId", "turnId", "taskId", "ordinal", "attempt", "status", "inputThroughSequence", "consumedInputIds", "modelProfileSnapshot")
    VALUES ($1, $2, $3, $4, 2, 1, 'completed', 0, '[]'::jsonb, '{}'::jsonb)`, [ids.childStep, ids.session, ids.turn, ids.child])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_call', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP)`, [ids.toolCallItem, ids.session, ids.turn, ids.childStep, ids.child,
    JSON.stringify({ toolCallId: "lookup-576", toolName: "source.lookup", toolVersion: "1", status: "completed", input: { query: "fact 42" } })])
  await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "updatedAt")
    VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP)`, [ids.toolItem, ids.session, ids.turn, ids.childStep, ids.child,
    JSON.stringify({ toolCallId: "lookup-576", output: toolOutput, errorCode: null })])
}

async function completeControls(taskIds: readonly string[]): Promise<void> {
  for (const taskId of taskIds) {
    const stored = await pool!.query<{ id: string; expectedOutputSchema: unknown; context: unknown }>(`SELECT "id", "expectedOutputSchema", "context"
      FROM "sub_agent_tasks" WHERE "id" = $1`, [taskId])
    const row = stored.rows[0]
    const control = row && parseNativeVerificationControl(row.expectedOutputSchema)
    const packet = control ? parseNativeVerificationPacket(row!.context, control) : null
    if (!row || !control || !packet) throw new Error("native_verification_integration_control_unreadable")
    const modelReport = {
      schemaVersion: "agent-harness.v2.native-verifier-model-report.v1" as const,
      criteria: packet.criteria.map(item => ({ criterionId: item.criterionId, disposition: "passed" as const,
        reasonCode: "meets_criterion" as const, evidenceReferenceIds: [packet.target.referenceId] })),
    }
    const report = attachNativeVerificationReport(control, 1, modelReport)
    if (!report) throw new Error("native_verification_integration_report_invalid")
    await pool!.query(`UPDATE "sub_agent_tasks" SET "status" = 'completed', "attemptCount" = 1, "result" = $2::jsonb,
      "failureReason" = NULL, "completedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = $1`,
    [taskId, JSON.stringify({ nativeVerificationReport: report })])
  }
}

function packetContentForRollback(): NativeVerificationPacketContent {
  return {
    goal, criteria: [{ criterionId: "criterion-1", requirement: criteria[0]! }],
    target: { kind: "child", taskId: ids.child, attempt: 1, resultDigest: digestNativeVerificationValue(childResult),
      referenceId: "target:rollback", resultText: canonicalNativeVerificationJson(childResult) },
    evidence: [{ referenceId: "evidence:rollback", kind: "tool_result", summary: "bounded test-owned fact" }],
  }
}

describePg("native verification PostgreSQL producer and readback", () => {
  beforeAll(async () => {
    pool = new PgPool({ connectionString: databaseUrl!, max: 8 })
    await seed()
  })
  afterAll(async () => {
    if (!pool) return
    await pool.query(`DELETE FROM "agent_outbox" WHERE "aggregateId" = $1`, [ids.session])
    await pool.query(`DELETE FROM "User" WHERE "id" = $1`, [ids.user])
    await pool.end()
  })

  it("rolls back task, dispatch, event and receipt together when the caller transaction aborts", async () => {
    const parent = await pool!.query(`SELECT "budgetSnapshot" FROM "sub_agent_tasks" WHERE "id" = $1`, [ids.root])
    await expect(transaction(pool as unknown as PgSubagentPool, async client => {
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
      await ensureNativeVerificationControl(client, { scope, parent: parent.rows[0] as Record<string, unknown>,
        target: { kind: "child", nodeId: "rollback-node", nativeOperationId: "rollback-op", fingerprint: "c".repeat(64),
          taskId: ids.child, attempt: 1, resultDigest: digestNativeVerificationValue(childResult) }, content: packetContentForRollback() })
      throw new Error("exercise_atomic_rollback")
    })).rejects.toThrow("exercise_atomic_rollback")
    const rows = await pool!.query(`SELECT COUNT(*)::int AS "count" FROM "sub_agent_tasks"
      WHERE "sessionId" = $1 AND "role" = 'auditor' AND "taskType" = 'native_verification'`, [ids.session])
    expect(rows.rows[0]?.count).toBe(0)
    expect((await pool!.query(`SELECT "id" FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'native_verification.requested'`, [ids.session])).rows).toHaveLength(0)
    expect((await pool!.query(`SELECT "id" FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.session.event'`, [ids.session])).rows).toHaveLength(0)
  }, 30_000)

  it("concurrently replays one real child control, recovers exact candidate bytes, and rechecks current evidence on terminal proof", async () => {
    const port = createPgNativeVerificationPort(pool as unknown as PgSubagentPool)
    const [first, second] = await Promise.all([port.ensureChildren(scope), port.ensureChildren(scope)])
    expect(first.status).toBe("pending")
    expect(second.status).toBe("pending")
    expect(first.controlTaskIds).toEqual(second.controlTaskIds)
    expect(first.pendingTaskIds).toEqual(first.controlTaskIds)

    const counts = await pool!.query(`SELECT
      (SELECT COUNT(*)::int FROM "sub_agent_tasks" WHERE "sessionId" = $1 AND "role" = 'auditor' AND "taskType" = 'native_verification') AS "controls",
      (SELECT COUNT(*)::int FROM "agent_events" WHERE "sessionId" = $1 AND "type" = 'native_verification.requested') AS "receipts",
      (SELECT COUNT(*)::int FROM "agent_outbox" WHERE "aggregateId" = $1 AND "topic" = 'agent.session.event') AS "outbox"`, [ids.session])
    expect(counts.rows[0]).toEqual({ controls: 1, receipts: 1, outbox: 1 })

    await completeControls(first.controlTaskIds)
    const rootPending = await port.ensureRootGoal({ scope, candidateText })
    expect(rootPending.status).toBe("pending")
    const rootTaskIds = rootPending.controlTaskIds.filter(id => !first.controlTaskIds.includes(id))
    expect(rootTaskIds).toHaveLength(1)
    await completeControls(rootTaskIds)

    const recovered = await port.readRecoverableGoal(scope)
    expect(recovered).toMatchObject({ status: "passed", candidateText })
    if (!recovered || recovered.status !== "passed" || !recovered.witness) throw new Error("native_verification_candidate_not_recovered")
    const witness = recovered.witness
    const client: PoolClient = await pool!.connect()
    let proofTransactionOpen = false
    try {
      await client.query("BEGIN")
      proofTransactionOpen = true
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
      const accepted = await readNativeVerificationTerminalProofWithClient(client, {
        scope, candidateText, witness,
      })
      await client.query("ROLLBACK")
      proofTransactionOpen = false
      expect(accepted).toBe(true)
    } finally {
      if (proofTransactionOpen) await client.query("ROLLBACK").catch(() => undefined)
      client.release()
    }

    const expectStaleEvidenceRejected = async () => {
      const client: PoolClient = await pool!.connect()
      let transactionOpen = false
      try {
        await client.query("BEGIN")
        transactionOpen = true
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
        const accepted = await readNativeVerificationTerminalProofWithClient(client, { scope, candidateText, witness })
        await client.query("ROLLBACK")
        transactionOpen = false
        expect(accepted).toBe(false)
      } finally {
        if (transactionOpen) await client.query("ROLLBACK").catch(() => undefined)
        client.release()
      }
    }
    const originalCall = { toolCallId: "lookup-576", toolName: "source.lookup", toolVersion: "1", status: "completed", input: { query: "fact 42" } }
    const mutateCall = async (content: unknown) => pool!.query(`UPDATE "agent_items" SET "revision" = "revision" + 1, "content" = $2::jsonb WHERE "id" = $1`,
      [ids.toolCallItem, JSON.stringify(content)])
    const mutateResult = async (content: unknown) => pool!.query(`UPDATE "agent_items" SET "revision" = "revision" + 1, "content" = $2::jsonb WHERE "id" = $1`,
      [ids.toolItem, JSON.stringify(content)])

    await mutateCall({ ...originalCall, toolName: "source.other" })
    await expectStaleEvidenceRejected()
    await mutateCall(originalCall)
    await mutateCall({ ...originalCall, status: "failed" })
    await expectStaleEvidenceRejected()
    await mutateCall(originalCall)
    await mutateCall({ ...originalCall, input: { query: "changed after review" } })
    await expectStaleEvidenceRejected()
    await mutateCall(originalCall)
    await mutateResult({ toolCallId: "lookup-576", output: { facts: ["changed after review"] }, errorCode: null })
    await expectStaleEvidenceRejected()
    await mutateResult({ toolCallId: "lookup-576", output: toolOutput, errorCode: null })
    await mutateCall({ ...originalCall, toolCallId: "mismatched-call" })
    await expectStaleEvidenceRejected()
    await mutateCall(originalCall)
    await pool!.query(`INSERT INTO "agent_items" ("id", "sessionId", "turnId", "stepId", "taskId", "type", "status", "revision", "content", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, 'tool_result', 'completed', 1, $6::jsonb, CURRENT_TIMESTAMP)`,
    [ids.duplicateToolItem, ids.session, ids.turn, ids.childStep, ids.child, JSON.stringify({ toolCallId: "lookup-576", output: toolOutput, errorCode: null })])
    await expectStaleEvidenceRejected()

    const sourceClient = await pool!.connect()
    try {
      await sourceClient.query("BEGIN")
      await sourceClient.query(`SELECT set_config('app.user_id', $1, true)`, [ids.user])
      const graph = await loadTaskGraph(sourceClient, scope, false)
      const state = await loadNativeVerificationOwnedState(sourceClient, scope, graph.snapshot, false)
      const node = state.snapshot?.nodes.find(value => value.taskId === ids.child)
      const target = node ? nativeVerificationTarget(state, node) : null
      expect(target).not.toBeNull()
      await expect(target ? buildNativeChildPacketContent(sourceClient, state, target) : Promise.resolve(null)).resolves.toBeNull()
      await sourceClient.query("ROLLBACK")
    } catch (error) {
      await sourceClient.query("ROLLBACK").catch(() => undefined)
      throw error
    } finally { sourceClient.release() }
  }, 60_000)
})
