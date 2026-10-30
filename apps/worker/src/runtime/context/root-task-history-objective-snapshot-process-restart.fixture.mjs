import { createHash } from "node:crypto"
import { Pool } from "pg"
import { AgentEventEnvelopeSchema, AgentInputSchema, AgentItemSchema, schemaVersion, validate } from "@jobcopilot/agent-protocol"
import { createCanonicalTurnRuntime } from "../canonical-turn-runtime.ts"
import { createPgTaskGraphCommandPort } from "../subagents/pg-task-graph-command-port.ts"
import { taskGraphRuntimeOptions } from "../subagents/task-graph-templates.ts"
import { createProductionChildExecutor } from "../subagents/production-child-runtime.ts"
import { NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA, parseNativeVerificationControl } from "../subagents/native-verification-contract.ts"
import { parseNativeVerificationPacket } from "../subagents/native-verification-packet.ts"
import { startProductionAgentRuntime as startProductionAgentRuntimeHelper } from "../../queue/production-bootstrap.ts"
import { startProductionWorkerRuntime } from "../../queue/production-worker-runtime.ts"
import { readRootTaskHistoryChronologyWitness } from "./root-task-history-chronology-witness.ts"
import { readRootTaskHistoryFence, rootTaskHistoryOrigin } from "./root-task-history-fence.ts"
import { createRootTaskHistoryObjectiveSnapshotIdentity } from "./root-task-history-objective-snapshot-codec.ts"
import { readRootTaskHistorySteerEvidence } from "./root-task-history-steer-evidence.ts"
import { matchesAgentOutboxIdentity } from "../outbox-identity.ts"
const [, , mode, rawInput] = process.argv
const input = JSON.parse(rawInput)
const pool = new Pool({ connectionString: process.env.AGENT_RUNTIME_PG_TEST_URL, max: 5 })
let bootstrap
let stdinBuffer = ""
let stopping = false
let modelStreamCalls = 0
let crossSessionSourceQueries = 0
let workerBReleasePending = true
const commandWaiters = new Map()
const queuedCommands = []
const noOpProjection = { start: async () => undefined, finish: async () => undefined }
function say(line) { process.stdout.write(`${line}\n`) }
function waitForCommand(command) {
  const queued = queuedCommands.indexOf(command)
  if (queued >= 0) { queuedCommands.splice(queued, 1); return Promise.resolve() }
  return new Promise(resolve => {
    const waiters = commandWaiters.get(command) ?? []
    waiters.push(resolve)
    commandWaiters.set(command, waiters)
  })
}
function onStdinData(chunk) {
  stdinBuffer += chunk
  const lines = stdinBuffer.split("\n")
  stdinBuffer = lines.pop() ?? ""
  for (const line of lines) {
    const command = line.trim()
    if (!command) continue
    const waiters = commandWaiters.get(command)
    const resolve = waiters?.shift()
    if (resolve) {
      if (!waiters.length) commandWaiters.delete(command)
      resolve()
    } else queuedCommands.push(command)
  }
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", onStdinData)
function instrumentCandidateWindowQueries() {
  const connect = pool.connect.bind(pool)
  const instrument = client => {
    const query = client.query.bind(client)
    client.query = (statement, ...args) => {
      const sql = typeof statement === "string" ? statement : statement?.text
      if (typeof sql === "string" && sql.includes("WITH terminal_window AS MATERIALIZED") && sql.includes("AS source_session")) crossSessionSourceQueries += 1
      return query(statement, ...args)
    }
    return client
  }
  pool.connect = (...args) => {
    const callback = args[0]
    if (typeof callback === "function") {
      return connect((error, client, release) => callback(error, client ? instrument(client) : client, release))
    }
    return connect().then(instrument)
  }
}
function modelProfile() {
  return {
    provider: "fixture", model: "objective-snapshot-fixture", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low",
  }
}
const nativeVerifierExecutor = createProductionChildExecutor({
  pool,
  authorizeUsage: async () => ({ settle: async () => undefined }),
  modelRuntimeFactory: async ({ task }) => {
    const control = parseNativeVerificationControl(task.expectedOutputSchema)
    const packet = control ? parseNativeVerificationPacket(task.context, control) : null
    if (task.role !== "auditor" || task.taskType !== "native_verification" || !control || !packet) {
      throw new Error("objective_snapshot_native_verifier_packet_invalid")
    }
    const report = {
      schemaVersion: NATIVE_VERIFICATION_MODEL_REPORT_SCHEMA,
      criteria: packet.criteria.map(item => ({
        criterionId: item.criterionId,
        disposition: "passed",
        reasonCode: "meets_criterion",
        evidenceReferenceIds: item.requirement.includes("self-attestation")
          ? packet.evidence.filter(evidence => evidence.kind === "user_self_attestation").map(evidence => evidence.referenceId)
          : [packet.target.referenceId, ...packet.evidence.filter(evidence => evidence.kind === "tool_result").map(evidence => evidence.referenceId)],
      })),
    }
    return {
      id: "objective-snapshot-fixture-native-verifier", profile: modelProfile(),
      async *stream() {
        yield { type: "text_delta", text: JSON.stringify(report) }
        yield { type: "completed", finishReason: "stop" }
      },
    }
  },
})
function historyProjection(request) {
  const matches = []
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.type !== "text" || typeof part.text !== "string") continue
      for (const line of part.text.split("\n")) {
        if (!line.startsWith("{")) continue
        try {
          const value = JSON.parse(line)
          if (value?.historical === true) matches.push(value)
        } catch { /* Other context blocks are not JSON projections. */ }
      }
    }
  }
  const snapshot = matches[0]
  const privateText = JSON.stringify(request.messages)
  const reason = matches.length !== 1 ? `historical_match_count_${matches.length}`
    : !Array.isArray(snapshot?.turns) ? "turns_missing"
      : snapshot.turns.length !== 1 ? `turn_count_${snapshot.turns.length}`
        : !snapshot.turns[0]?.nodes?.some(node => node.taskKind === "analyst" && node.status === "completed") ? "completed_analyst_missing"
          : ["PRIVATE_SOURCE_NODE_GOAL", "PRIVATE_SOURCE_CRITERION", "PRIVATE_SOURCE_RESULT"].some(value => privateText.includes(value))
            ? "private_source_sentinel_present" : null
  if (reason) throw new Error(`objective_snapshot_context_invalid:${reason}`)
}
function record(value) {
  if (typeof value === "string") { try { value = JSON.parse(value) } catch { return null } }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null
}
function timestamp(value) {
  const date = value instanceof Date ? new Date(value) : typeof value === "string" ? new Date(value) : null
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null
}
function evidenceSequence(value) {
  try {
    const parsed = typeof value === "bigint" ? value : typeof value === "string" && /^(0|[1-9]\d*)$/.test(value)
      ? BigInt(value) : typeof value === "number" && Number.isSafeInteger(value) ? BigInt(value) : null
    return parsed !== null && parsed >= 0n && parsed <= BigInt(Number.MAX_SAFE_INTEGER) ? parsed : null
  } catch { return null }
}
function exactKeys(value, keys) {
  return value && Object.keys(value).sort().join(",") === [...keys].sort().join(",")
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (Array.isArray(value)) return value.map(canonical)
  const object = record(value)
  if (!object || Object.getOwnPropertySymbols(value).length) throw new TypeError("invalid-json")
  return Object.fromEntries(Object.keys(object).sort().map(key => [key, canonical(object[key])]))
}
function sameJson(left, right) {
  try { return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right)) } catch { return false }
}
function inputUnsafeReason(row, scope, request) {
  if (row.sessionId !== request.sessionId || row.targetTurnId !== request.turnId || row.userId !== scope.userId) return "input_scope"
  const createdAt = timestamp(row.createdAt), consumedAt = row.consumedAt === null ? null : timestamp(row.consumedAt)
  const cancelledAt = row.cancelledAt === null ? null : timestamp(row.cancelledAt)
  const acceptedSequence = evidenceSequence(row.acceptedSequence)
  const status = row.status, consumedByStepId = row.consumedByStepId
  const hasConsumer = typeof consumedByStepId === "string" && consumedByStepId.length > 0
  const hasConsumedAt = consumedAt !== null
  if (acceptedSequence === null || createdAt === null || !(consumedByStepId === null || hasConsumer)
    || hasConsumer !== hasConsumedAt || status === "consumed" && (!hasConsumer || cancelledAt !== null)
    || status === "cancelled" && cancelledAt === null || status !== "cancelled" && cancelledAt !== null
    || status !== "consumed" && status !== "cancelled" && hasConsumer) return "input_lifecycle"
  const value = { schemaVersion, id: row.id, clientMessageId: row.clientMessageId, sessionId: row.sessionId,
    turnId: row.targetTurnId, delivery: row.delivery, state: status, content: row.content, createdAt, consumedAt }
  return validate(AgentInputSchema, value) && typeof row.id === "string" && typeof row.clientMessageId === "string"
    ? null : "input_schema"
}
function eventUnsafeReason(row, sessionId, turnId) {
  const payload = record(row.acceptedPayload), item = record(row.acceptedItemContent)
  if (row.acceptedEventSessionId !== sessionId || row.acceptedEventTurnId !== turnId || row.acceptedTaskId !== null
    || row.acceptedCorrelationId !== turnId || row.acceptedItemSessionId !== sessionId || row.acceptedItemTurnId !== turnId
    || row.acceptedItemTaskId !== null || row.acceptedEventItemId !== row.acceptedItemId
    || typeof row.acceptedItemId !== "string") return "event_scope"
  if (!payload || !item || !exactKeys(payload, ["clientMessageId", "delivery", "disposition", "inputId", "source"])
    || !exactKeys(item, ["clientMessageId", "disposition", "parts", "source"])
    || typeof payload.inputId !== "string" || typeof payload.clientMessageId !== "string"
    || (payload.delivery !== "steer" && payload.delivery !== "follow_up")
    || typeof payload.disposition !== "string" || !payload.disposition.trim()
    || (payload.source !== "user" && payload.source !== "automation" && payload.source !== "system")
    || row.acceptedType !== "input.accepted" || row.acceptedActor !== (payload.source === "user" ? "user" : "system")
    || row.acceptedItemType !== "user_message" || row.acceptedItemStatus !== "completed"
    || !Array.isArray(item.parts) || item.clientMessageId !== payload.clientMessageId
    || item.disposition !== payload.disposition || item.source !== payload.source) return "event_schema"
  const sequence = evidenceSequence(row.acceptedEventSequence), createdAt = timestamp(row.acceptedEventCreatedAt)
  if (sequence === null || createdAt === null) return "event_schema"
  const envelope = { schemaVersion, id: row.acceptedEventId, sessionId: row.acceptedEventSessionId,
    turnId: row.acceptedEventTurnId, itemId: row.acceptedEventItemId, taskId: row.acceptedTaskId,
    sequence: Number(sequence), type: row.acceptedType, actor: row.acceptedActor,
    correlationId: row.acceptedCorrelationId, causationId: row.acceptedEventCausationId,
    idempotencyKey: row.acceptedEventIdempotencyKey, payload: row.acceptedPayload, createdAt }
  const itemEnvelope = { schemaVersion, id: row.acceptedItemId, sessionId: row.acceptedItemSessionId,
    turnId: row.acceptedItemTurnId, stepId: row.acceptedItemStepId, status: row.acceptedItemStatus,
    createdAt: timestamp(row.acceptedItemCreatedAt), updatedAt: timestamp(row.acceptedItemUpdatedAt),
    type: row.acceptedItemType, data: row.acceptedItemContent }
  return validate(AgentEventEnvelopeSchema, envelope) && validate(AgentItemSchema, itemEnvelope)
    ? null : "event_schema"
}
function classifyUnsafeSteer(trace, scope, request) {
  if (!trace.rootValid) return "root_fence"
  if (trace.stepRows !== 1) return "step_fence"
  if (!Array.isArray(trace.inputs)) return "probe_unclassified"
  if (trace.inputs.length > 64) return "input_overflow"
  const byId = new Map(), sequences = new Set(), clientMessages = new Set()
  for (const row of trace.inputs) {
    const invalid = inputUnsafeReason(row, scope, request)
    if (invalid) return invalid
    const sequence = evidenceSequence(row.acceptedSequence)
    if (byId.has(row.id) || sequences.has(sequence) || clientMessages.has(row.clientMessageId)) return "input_duplicate_identity"
    byId.set(row.id, { row, sequence }); sequences.add(sequence); clientMessages.add(row.clientMessageId)
  }
  if (!Array.isArray(trace.events)) return "probe_unclassified"
  if (trace.events.length > 64) return "event_overflow"
  if (trace.inputs.length !== trace.events.length) return "input_event_count"
  const seenInputs = new Set(), eventIds = new Set(), eventSequences = new Set()
  for (const row of trace.events) {
    const invalid = eventUnsafeReason(row, request.sessionId, request.turnId)
    if (invalid) return invalid
    const payload = record(row.acceptedPayload), item = record(row.acceptedItemContent)
    const input = byId.get(payload.inputId)
    const eventSequence = evidenceSequence(row.acceptedEventSequence)
    if (seenInputs.has(payload.inputId) || eventIds.has(row.acceptedEventId) || eventSequences.has(eventSequence)) return "event_duplicate_identity"
    if (!input || row.acceptedItemId !== row.acceptedEventItemId
      || payload.clientMessageId !== input.row.clientMessageId || payload.delivery !== input.row.delivery
      || eventSequence !== input.sequence || !sameJson(input.row.content, item.parts)) return "event_input_binding"
    seenInputs.add(payload.inputId); eventIds.add(row.acceptedEventId); eventSequences.add(eventSequence)
  }
  return seenInputs.size !== byId.size ? "input_event_missing" : "unsafe_unclassified"
}
function instrumentSteerQueries(client) {
  const trace = { rootRows: null, rootValid: false, stepRows: null, inputs: null, events: null }
  return {
    trace,
    client: { query: async (statement, ...args) => {
      const result = await client.query(statement, ...args)
      const sql = typeof statement === "string" ? statement : statement?.text
      if (typeof sql === "string") {
        if (sql.includes('JOIN "sub_agent_tasks" AS root')) {
          trace.rootRows = result.rows.length
          trace.rootValid = result.rows.length === 1 && typeof result.rows[0]?.id === "string"
        }
        else if (sql.includes('FROM "agent_steps"') && sql.includes("FOR UPDATE")) trace.stepRows = result.rows.length
        else if (sql.includes('FROM "agent_inputs"')) trace.inputs = result.rows
        else if (sql.includes('FROM "agent_events" AS event') && sql.includes("input.accepted")) trace.events = result.rows
      }
      return result
    } },
  }
}
function flag(value) { return value === true ? "enabled" : value === false ? "disabled" : "unknown" }
function smallCount(value) { return value === 0 ? "0" : value === 1 ? "1" : "2+" }
function evidenceCount(rows) { return !Array.isArray(rows) ? "unknown" : rows.length > 64 ? "over64" : smallCount(rows.length) }
function historyDiagnosisLine(facts) {
  return Object.entries(facts).map(([key, value]) => `${key}=${value}`).join(" ")
}
function noteProbeFailure(facts, error) {
  const code = error && typeof error === "object" ? error.code : undefined
  const message = error && typeof error === "object" && typeof error.message === "string" ? error.message : ""
  if (["57014", "55P03", "ETIMEDOUT", "ESOCKETTIMEDOUT", "ETIME"].includes(code) || /timeout/i.test(message)) {
    facts.probe = "timeout_inconclusive"
  }
  else if (facts.probe === "complete") facts.probe = "incomplete"
}
async function runLockingProbe(client, name, facts, operation) {
  // Existing validators lock rows; rolling back this savepoint releases probe locks immediately.
  await client.query(`SAVEPOINT ${name}`)
  let value, ok = true
  try { value = await operation() } catch (error) { ok = false; noteProbeFailure(facts, error) }
  try {
    await client.query(`ROLLBACK TO SAVEPOINT ${name}`)
    await client.query(`RELEASE SAVEPOINT ${name}`)
  } catch (error) { ok = false; noteProbeFailure(facts, error) }
  return { ok, value }
}
async function diagnoseHistoryEligibility(runtimeGateEnabled) {
  const facts = {
    sample: "after_context", consistency: "read_committed", clock: "postgres_sample",
    liveOwner: "unknown", authRows: "unknown", authState: "unknown", authPayload: "unknown", consent: "unknown",
    capturedGate: "unknown", runtimeGate: flag(runtimeGateEnabled), observedReadGate: "unknown", observedSteer: "not_reached",
    observedSteerReason: "not_reached",
    observedTurnOrigin: "not_reached", observedRootFence: "not_reached", observedFenceOrigin: "not_reached",
    observedObjective: "not_reached", observedStartWitness: "not_reached", observedIdentity: "not_reached", probe: "complete",
  }
  let client
  let transactionStarted = false
  try {
    client = await pool.connect()
    await client.query("BEGIN ISOLATION LEVEL READ COMMITTED")
    transactionStarted = true
    await client.query("SET LOCAL lock_timeout='250ms'")
    await client.query("SET LOCAL statement_timeout='2000ms'")
    const clock = await client.query(`SELECT clock_timestamp() AS "sampledAt"`)
    const sampledAtValue = clock.rows[0]?.sampledAt
    const sampledAt = sampledAtValue instanceof Date ? sampledAtValue : new Date(sampledAtValue)
    if (clock.rows.length !== 1 || !Number.isFinite(sampledAt.getTime())) throw new Error("diagnostic_clock_unavailable")
    const current = await client.query(`SELECT turn."userId",turn."sessionId",turn."id" AS "turnId",
        turn."source" AS "turnSource",turn."input" AS "turnInput",turn."leaseOwnerId" AS "ownerId",
        turn."leaseVersion",turn."leaseStartedAt",turn."leaseExpiresAt",root."id" AS "rootTaskId",
        root."attemptCount" AS "rootAttemptCount",step."id" AS "stepId",
        step."inputThroughSequence"::text AS "inputThroughSequence"
      FROM "agent_turns" turn JOIN "sub_agent_tasks" root ON root."id"=turn."rootTaskId"
        AND root."sessionId"=turn."sessionId" AND root."turnId"=turn."id" AND root."rootTaskId"=root."id"
      JOIN "agent_steps" step ON step."sessionId"=turn."sessionId" AND step."turnId"=turn."id"
        AND step."taskId"=root."id" AND step."attempt"=root."attemptCount" AND step."status"='streaming'
      WHERE turn."id"=$1 AND turn."status"='in_progress' AND turn."leaseOwnerId" IS NOT NULL
        AND turn."leaseExpiresAt">$2 AND root."status"='running'
        AND root."leaseOwner"=turn."leaseOwnerId" AND root."leaseExpiresAt">$2
      ORDER BY step."ordinal" DESC LIMIT 2`, [input.turnId, sampledAt])
    facts.liveOwner = current.rows.length === 1 ? "present" : current.rows.length ? "ambiguous" : "missing"
    if (current.rows.length === 1) {
      const owner = current.rows[0]
      const origin = rootTaskHistoryOrigin(owner.turnSource, owner.turnInput)
      facts.observedTurnOrigin = origin ? "present" : "missing"
      await client.query("SELECT set_config($1,$2,true)", ["app.user_id", owner.userId])
      const key = `root-task-history-session-authorization:${owner.sessionId}:v1`
      const expectedId = `agent-root-task-history-${createHash("sha256").update(key).digest("hex")}`
      const authRows = await client.query(`SELECT "id","sessionId","turnId","taskId","sequence"::text AS "sequence",
          "itemId","type","actor","correlationId","causationId","idempotencyKey","payload"
        FROM "agent_events" WHERE "idempotencyKey"=$1 OR "id"=$2 ORDER BY "sequence" LIMIT 2`, [key, expectedId])
      facts.authRows = smallCount(authRows.rows.length)
      let authorization
      if (authRows.rows.length === 1) {
        const event = authRows.rows[0], payload = record(event.payload)
        const exactKeys = payload && Object.keys(payload).sort().join(",")
          === "consentEnabled,consentVersion,gateEnabledAtCapture,schemaVersion,sessionId,userId"
        const payloadValid = exactKeys && payload.schemaVersion === "agent-harness.v2.root-task-history-session-authorization.v1"
          && payload.sessionId === owner.sessionId && payload.userId === owner.userId
          && typeof payload.consentEnabled === "boolean" && typeof payload.gateEnabledAtCapture === "boolean"
          && Number.isSafeInteger(payload.consentVersion) && payload.consentVersion >= 0
        facts.consent = flag(payload?.consentEnabled)
        facts.capturedGate = flag(payload?.gateEnabledAtCapture)
        const eventIdentityValid = event.id === expectedId && event.idempotencyKey === key && event.sessionId === owner.sessionId
        const eventValid = eventIdentityValid && event.type === "agent.plan.root_task_history_session_authorization"
          && event.actor === "orchestrator" && event.itemId === null && event.causationId === null
          && typeof event.taskId === "string" && event.taskId.length > 0 && event.taskId.trim() === event.taskId && event.correlationId === event.taskId
          && /^(0|[1-9][0-9]*)$/.test(event.sequence) && event.sequence !== "0"
        let retainedOwnerValid = false, outboxValid = false
        if (payloadValid && eventValid) {
          const retained = await client.query(`SELECT turn."id" FROM "agent_turns" turn
            JOIN "sub_agent_tasks" task ON task."id"=$4 AND task."sessionId"=$2 AND task."turnId"=$1
              AND task."rootTaskId"=task."id" AND task."parentTaskId" IS NULL
              AND task."role"='orchestrator' AND task."taskType"='root'
            JOIN "agent_sessions" session ON session."id"=task."sessionId" AND session."userId"=$3
            WHERE turn."id"=$1 AND turn."sessionId"=$2 AND turn."userId"=$3 AND turn."rootTaskId"=$4 LIMIT 2`,
          [event.turnId, owner.sessionId, owner.userId, event.taskId])
          retainedOwnerValid = retained.rows.length === 1
          const outboxRows = await client.query(`SELECT "id","topic","aggregateId","idempotencyKey","payload"
            FROM "agent_outbox" WHERE "idempotencyKey"=$1 OR "id"=$2 LIMIT 2`,
          [`agent-event:${event.id}`, `agent-outbox-${event.id}`])
          const expectedOutbox = {
            id: `agent-outbox-${event.id}`, topic: "agent.events", aggregateId: owner.sessionId,
            idempotencyKey: `agent-event:${event.id}`,
            payload: { eventId: event.id, sessionId: event.sessionId, turnId: event.turnId, taskId: event.taskId,
              itemId: null, sequence: BigInt(event.sequence).toString(), type: event.type, actor: event.actor,
              correlationId: event.correlationId, causationId: null, idempotencyKey: key, payload: event.payload },
          }
          outboxValid = outboxRows.rows.length === 1 && matchesAgentOutboxIdentity(outboxRows.rows[0], expectedOutbox)
        }
        const authorizationValid = payloadValid && eventValid && retainedOwnerValid && outboxValid
        facts.authState = !eventIdentityValid ? "identity_conflict" : authorizationValid ? "valid" : "invalid"
        facts.authPayload = authorizationValid ? "valid" : "invalid"
        if (authorizationValid) authorization = {
          eventId: event.id, sessionId: payload.sessionId, userId: payload.userId,
          consentVersion: payload.consentVersion, consentEnabled: payload.consentEnabled,
          gateEnabledAtCapture: payload.gateEnabledAtCapture,
        }
        facts.observedReadGate = authorizationValid
          ? runtimeGateEnabled === true && authorization.consentEnabled ? "enabled" : "disabled"
          : "unknown"
      } else {
        if (authRows.rows.length) {
          facts.authState = "multiple_identity"
          facts.authPayload = "multiple"
        } else {
          const orphanOutbox = await client.query(`SELECT "id" FROM "agent_outbox"
            WHERE "idempotencyKey"=$1 OR "id"=$2 LIMIT 2`,
          [`agent-event:${expectedId}`, `agent-outbox-${expectedId}`])
          facts.authState = orphanOutbox.rows.length ? "orphan_outbox" : "missing"
          facts.authPayload = facts.authState
        }
      }

      const lease = {
        userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, ownerId: owner.ownerId,
        leaseVersion: Number(owner.leaseVersion), leaseStartedAt: owner.leaseStartedAt, leaseExpiresAt: owner.leaseExpiresAt,
      }
      const scope = { userId: owner.userId }
      const steerTrace = instrumentSteerQueries(client)
      const steerProbe = await runLockingProbe(client, "history_steer_probe", facts, () =>
        readRootTaskHistorySteerEvidence(steerTrace.client, scope, {
          sessionId: owner.sessionId, turnId: owner.turnId, stepId: owner.stepId,
          lease: { ownerId: owner.ownerId, leaseVersion: Number(owner.leaseVersion), now: sampledAt },
        }))
      const steerEvidence = steerProbe.ok ? steerProbe.value : undefined
      facts.observedSteer = steerProbe.ok ? steerEvidence.kind : "error"
      facts.observedSteerRootRows = steerTrace.trace.rootRows === null ? "unknown" : smallCount(steerTrace.trace.rootRows)
      facts.observedSteerStepRows = steerTrace.trace.stepRows === null ? "unknown" : smallCount(steerTrace.trace.stepRows)
      facts.observedSteerInputRows = evidenceCount(steerTrace.trace.inputs)
      facts.observedSteerEventRows = evidenceCount(steerTrace.trace.events)
      facts.observedSteerReason = !steerProbe.ok ? "probe_inconclusive"
        : steerEvidence.kind === "unsafe" ? classifyUnsafeSteer(steerTrace.trace, scope,
          { sessionId: owner.sessionId, turnId: owner.turnId })
          : steerEvidence.kind

      let fence
      if (facts.observedReadGate === "enabled" && steerEvidence?.kind === "no_accepted_steer") {
        const fenceProbe = await runLockingProbe(client, "history_fence_probe", facts, () =>
          readRootTaskHistoryFence(client, {
            lease, rootTaskId: owner.rootTaskId, rootAttemptCount: Number(owner.rootAttemptCount),
            stepId: owner.stepId, now: sampledAt, crossSessionRootTaskHistoryEnabled: true,
          }))
        fence = fenceProbe.ok ? fenceProbe.value : undefined
        facts.observedRootFence = fenceProbe.ok ? fence ? "present" : "missing" : "error"
        facts.observedFenceOrigin = fenceProbe.ok ? fence?.currentOrigin ? "present" : fence ? "missing" : "not_available" : "error"
        facts.observedObjective = fenceProbe.ok ? fence?.objectiveDigest ? "present" : fence ? "missing" : "not_available" : "error"
        facts.observedStartWitness = fenceProbe.ok ? fence?.currentStartWitness ? "present"
          : fence?.currentOrigin ? "missing" : "not_available" : "error"
      }

      if (facts.observedReadGate === "enabled" && steerEvidence?.kind === "no_accepted_steer"
        && facts.observedTurnOrigin === "present" && facts.observedStartWitness === "not_available") {
        const witnessProbe = await runLockingProbe(client, "history_witness_probe", facts, async () => {
          const starts = await client.query(`SELECT "id" FROM "agent_events"
            WHERE "sessionId"=$1 AND "turnId"=$2 AND "taskId"=$3 AND "type"='turn.started' LIMIT 2`,
          [owner.sessionId, owner.turnId, owner.rootTaskId])
          if (starts.rows.length !== 1) return starts.rows.length ? "ambiguous" : "missing"
          return (await readRootTaskHistoryChronologyWitness(client, {
            userId: owner.userId, sessionId: owner.sessionId, turnId: owner.turnId, rootTaskId: owner.rootTaskId,
            boundary: "turn_start", boundaryEventId: String(starts.rows[0].id),
          })) ? "present" : "missing"
        })
        facts.observedStartWitness = witnessProbe.ok ? witnessProbe.value : "error"
      }

      const revision = /^(0|[1-9][0-9]*)$/.test(owner.inputThroughSequence ?? "")
        ? BigInt(owner.inputThroughSequence) : undefined
      if (authorization && fence && steerEvidence) {
        facts.observedIdentity = createRootTaskHistoryObjectiveSnapshotIdentity({
          lease, authorization, fence, acceptedInputRevision: revision, steerEvidence,
        }) ? "eligible" : "ineligible"
      }
    }
  } catch (error) {
    noteProbeFailure(facts, error)
  } finally {
    if (transactionStarted) {
      try { await client.query("ROLLBACK") } catch (error) { noteProbeFailure(facts, error) }
    }
    client?.release()
  }
  return historyDiagnosisLine(facts)
}
function spawnedTaskId(request, callId) {
  for (const message of request.messages ?? []) {
    for (const part of message.content ?? []) {
      if (part.type !== "tool_result" || part.toolUseId !== callId || typeof part.content !== "string") continue
      const result = JSON.parse(part.content)
      if (typeof result.taskId === "string" && result.taskId.length) return result.taskId
    }
  }
  throw new Error("objective_snapshot_spawn_result_missing")
}
function waitForHistorySuspension(turnId) {
  return (async () => {
    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      const result = await pool.query(`SELECT turn."status", wait."status" AS "waitStatus", wait."suspendedAt"
        FROM "agent_turns" turn JOIN "agent_wait_conditions" wait ON wait."turnId"=turn."id"
        WHERE turn."id"=$1 AND wait."idempotencyKey"=$2`, [turnId, `objective-snapshot-wait:${turnId}`])
      if (result.rows[0]?.status === "waiting_for_dependency" && result.rows[0]?.waitStatus === "waiting"
        && result.rows[0]?.suspendedAt) return
      await new Promise(resolve => setTimeout(resolve, 20))
    }
    throw new Error("objective_snapshot_parent_did_not_suspend")
  })()
}
async function waitForRestartReady(turnId) {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline && !stopping) {
    const result = await pool.query(`SELECT turn."status", wait."status" AS "waitStatus", wait."consumedAt",
        dispatch."publishedAt", dispatch."attemptCount"
      FROM "agent_turns" turn JOIN "agent_wait_conditions" wait ON wait."turnId"=turn."id"
      JOIN "agent_outbox" dispatch ON dispatch."aggregateId"=turn."sessionId" AND dispatch."topic"='agent.turn.dispatch'
        AND dispatch."idempotencyKey"='turn-dispatch:'||turn."id"
      WHERE turn."id"=$1 AND wait."idempotencyKey"=$2`, [turnId, `objective-snapshot-wait:${turnId}`])
    const row = result.rows[0]
    if (row?.status === "queued" && row.waitStatus === "ready" && !row.consumedAt && row.publishedAt && Number(row.attemptCount) >= 2) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error("objective_snapshot_restart_boundary_missing")
}
async function startRuntime(firstWorker) {
  const workerId = `objective-snapshot-${firstWorker ? "worker-a" : "worker-b"}-${process.pid}`
  const childExecutor = async input => {
    const { lease } = input
    if (lease.role === "auditor" && lease.taskType === "native_verification") {
      say("FIXTURE_NATIVE_VERIFIER_STARTED")
      const outcome = await nativeVerifierExecutor(input)
      say("FIXTURE_NATIVE_VERIFIER_RETURNED")
      return outcome
    }
    say("FIXTURE_CHILD_EXECUTOR_STARTED")
    await waitForHistorySuspension(lease.turnId)
    say("FIXTURE_PARENT_SUSPENDED")
    await waitForCommand("complete-child")
    say("FIXTURE_CHILD_EXECUTOR_RETURNING_COMPLETED")
    return { status: "completed", result: { proof: "objective-snapshot-child-completed", taskId: lease.id } }
  }
  const runtimeOptions = {
    authorizeUsage: async () => ({ settle() {} }),
    modelRuntimeFactory() {
      let calls = 0
      return { adapter: { id: "objective-snapshot-fixture-model", profile: modelProfile(), async *stream(request) {
        modelStreamCalls += 1; if (firstWorker) {
          say("FIXTURE_MODEL_STREAM_ENTERED_A")
          const stats = await pool.query(`SELECT COUNT(event."id")::int AS "snapshotEvents",
            COALESCE(SUM(CASE WHEN jsonb_typeof(event."payload"->'outcomes')='array'
              THEN jsonb_array_length(event."payload"->'outcomes') ELSE 0 END),0)::int AS "snapshotOutcomes"
            FROM "agent_turns" turn LEFT JOIN "agent_events" event ON event."sessionId"=turn."sessionId"
              AND event."turnId"=turn."id" AND event."type"='agent.plan.root_task_history_memory_snapshot'
            WHERE turn."id"=$1`, [input.turnId])
          let contextFailure
          let contextProjectionValid = false
          try { historyProjection(request); contextProjectionValid = true } catch (error) { contextFailure = error }
          if (mode === "worker-a-diagnostic" && input.forceContextFailureForDiagnostic === true) {
            say(`FIXTURE_MODEL_CONTEXT_A_PROJECTION_${contextProjectionValid ? "VALID" : "INVALID"}`)
            contextFailure = new Error("objective_snapshot_context_invalid:fixture_forced")
          }
          let eligibility = ""
          if (contextFailure) {
            try { eligibility = await diagnoseHistoryEligibility(flags.crossSessionRootTaskHistoryEnabled) } catch { eligibility = "probe=incomplete" }
          }
          say(`FIXTURE_HISTORY_A snapshots=${stats.rows[0]?.snapshotEvents ?? 0} outcomes=${stats.rows[0]?.snapshotOutcomes ?? 0} sourceQueries=${crossSessionSourceQueries}${eligibility ? ` ${eligibility}` : ""}`)
          if (contextFailure) {
            const reason = contextFailure instanceof Error && contextFailure.message.startsWith("objective_snapshot_context_invalid:")
              ? contextFailure.message.slice("objective_snapshot_context_invalid:".length) : "unclassified"
            say(`FIXTURE_MODEL_CONTEXT_A_INVALID ${reason}`); throw new Error("objective_snapshot_context_invalid")
          }
          calls += 1
          if (calls === 1) {
            say("FIXTURE_MODEL_CONTEXT_A_OK"); await waitForCommand("continue-turn")
            yield { type: "tool_call_completed", callId: "objective-snapshot-spawn", name: "agent.spawn", arguments: {
              idempotencyKey: `objective-snapshot-spawn:${input.turnId}`, role: "analyst", taskType: "research",
              goal: "Return the deterministic restart result", successCriteria: ["Persist the restart result"],
              context: { fixture: "objective-snapshot-process-restart" },
            } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          if (calls === 2) {
            const taskId = spawnedTaskId(request, "objective-snapshot-spawn")
            yield { type: "tool_call_completed", callId: "objective-snapshot-wait", name: "agent.wait", arguments: {
              idempotencyKey: `objective-snapshot-wait:${input.turnId}`, taskIds: [taskId], mode: "all", timeoutMs: 30_000,
            } }
            yield { type: "completed", finishReason: "tool_calls" }
            return
          }
          throw new Error("objective_snapshot_worker_a_unexpected_stream")
        }
        if (mode === "worker-b-corrupt") { say("FIXTURE_MODEL_STREAM_ENTERED_B"); throw new Error("objective_snapshot_corrupt_snapshot_reached_stream") }
        say("FIXTURE_MODEL_STREAM_ENTERED_B")
        historyProjection(request)
        say("FIXTURE_MODEL_CONTEXT_B_OK")
        say(`FIXTURE_CROSS_SESSION_SOURCE_QUERY_COUNT_B ${crossSessionSourceQueries}`)
        if (workerBReleasePending) {
          await waitForCommand("release-model")
          workerBReleasePending = false
          say("FIXTURE_MODEL_RELEASE_RECEIVED_B")
        }
        yield { type: "text_delta", text: "objective-snapshot-worker-restart-fixture-complete" }
        say("FIXTURE_MODEL_FINAL_TEXT_EMITTED_B")
        say("FIXTURE_MODEL_COMPLETION_EVENT_B")
        yield { type: "completed", finishReason: "stop" }
      } }, registry: {}, candidates: [] }
    },
  }
  const flags = {
    taskGraphPlanningEnabled: true, childExecutionEnabled: true, coordinationEnabled: true, consumeWaitOutcomes: true,
    canonicalAutomationEnabled: false, turnBoundaryCompactionEnabled: false, crossSessionRootTaskHistoryEnabled: true,
    objectiveHistoryIndexEnabled: false,
  }
  await startProductionWorkerRuntime({ pool, workerId, productionFlags: flags, onBootstrapReady(value) { bootstrap = value },
    startAgentRunWorker() {} }, {
    createOptionalProductionChildExecutor({ enabled }) { return enabled ? childExecutor : undefined },
    createCanonicalTurnRuntime(runtimePool, productionOptions) {
      const commandPort = productionOptions.productionFlags?.taskGraphPlanningEnabled
        ? createPgTaskGraphCommandPort(runtimePool) : undefined
      return createCanonicalTurnRuntime(runtimePool, { ...runtimeOptions, ...productionOptions, ...taskGraphRuntimeOptions(commandPort) })
    },
    createWorkerUsageAuthorizer() { return async () => ({ settle() {} }) },
    createCanonicalExecutionProjection() { return noOpProjection }, createCanonicalSessionProjection() { return noOpProjection },
    startProductionAgentRuntime(startupOptions) {
      return startProductionAgentRuntimeHelper({ ...startupOptions, bootstrapOptions: runtime => {
        const base = typeof startupOptions.bootstrapOptions === "function" ? startupOptions.bootstrapOptions(runtime) : startupOptions.bootstrapOptions
        return { ...base, ownerId: workerId, turnRecoveryIntervalMs: 10,
          waitResolver: { ...base?.waitResolver, intervalMs: 10, ownerId: `objective-snapshot-wait-${process.pid}` },
          subagents: { ...base?.subagents, intervalMs: 10 } }
      } })
    },
  })
}
async function waitForStop() {
  await waitForCommand("shutdown"); stopping = true
  process.stdin.off("data", onStdinData); process.stdin.pause(); process.stdin.destroy()
}
async function run() {
  if (!process.env.AGENT_RUNTIME_PG_TEST_URL || !process.env.AGENT_TURN_REDIS_TEST_URL) throw new Error("fixture_services_missing")
  instrumentCandidateWindowQueries()
  if (mode === "worker-a" || mode === "worker-a-diagnostic") {
    if (mode === "worker-a-diagnostic" && input.forceContextFailureForDiagnostic !== true) {
      throw new Error("objective_snapshot_diagnostic_flag_required")
    }
    await startRuntime(true)
    say("FIXTURE_WORKER_READY_A")
    if (mode === "worker-a") {
      await waitForRestartReady(input.turnId)
      say(`FIXTURE_CROSS_SESSION_SOURCE_QUERY_COUNT_A ${crossSessionSourceQueries}`)
      say("FIXTURE_RESTART_BOUNDARY_READY")
    }
  } else {
    await startRuntime(false)
    say("FIXTURE_WORKER_READY_B")
    if (mode === "worker-b-corrupt") {
      const deadline = Date.now() + 30_000
      while (Date.now() < deadline) {
        const result = await pool.query(`SELECT "status" FROM "agent_turns" WHERE "id"=$1`, [input.turnId])
        if (result.rows[0]?.status === "failed") break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      if (modelStreamCalls !== 0) throw new Error("objective_snapshot_stream_was_entered")
      const failed = await pool.query(`SELECT event."payload" FROM "agent_events" event
        WHERE event."turnId"=$1 AND event."type"='turn.failed' ORDER BY event."sequence" DESC LIMIT 1`, [input.turnId])
      if (failed.rows[0]?.payload?.errorCode !== "persistence_conflict") throw new Error("objective_snapshot_conflict_not_terminalized")
      say(`FIXTURE_CROSS_SESSION_SOURCE_QUERY_COUNT_B ${crossSessionSourceQueries}`)
      say("FIXTURE_MODEL_STREAM_NOT_ENTERED_B")
      say("FIXTURE_CORRUPTION_FAILED_CLOSED")
    }
  }
  await waitForStop()
}

try {
  await run()
} catch (error) {
  process.stderr.write(`OBJECTIVE_SNAPSHOT_RESTART_FIXTURE_FAILED_${error instanceof Error && error.message === "objective_snapshot_restart_boundary_missing" ? "RESTART_BOUNDARY_MISSING" : "UNCLASSIFIED"}\n`)
  process.exitCode = 1
} finally {
  process.stdin.off("data", onStdinData)
  process.stdin.pause()
  if (bootstrap) await bootstrap.close().catch(() => undefined)
  await pool.end().catch(() => undefined)
  const { closeSharedRedisConnections } = await import("../../redis.ts")
  await closeSharedRedisConnections().catch(() => undefined)
}
