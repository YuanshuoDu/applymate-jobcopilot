import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { validateChildWaitSourceEvents } from "./child-resume-source-wait-event-validation.js"
import { prepareOwnerScopedWaitLifecycleOutput } from "../tools/lifecycle-receipt-output.js"
import { sanitizeLifecyclePreview } from "../tools/redaction.js"
import { projectWaitCallEventContent } from "../turns/turn-execution-wait-event-projection.js"

const lease = { id: "task-parent", userId: "user-a", sessionId: "session-a", turnId: "turn-a", attemptCount: 3 }
const stepId = "step-source", callId = "provider:call%_42", callItemId = `task:${lease.id}:item:tool-call:${callId}`
const resultId = `task:${lease.id}:item:tool-result:${callId}`
const waitId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
const childId = "subagent-00000000-0000-4000-8000-000000000001"
const output = {
  waitId, status: "ready" as const, taskIds: [childId], deadlineAt: "2026-11-10T10:00:00.000Z",
  matchedTaskIds: [childId], tasks: [{ taskId: childId, status: "completed", role: "scout", result: { jobs: 1 }, failureReason: null }],
}
const input = { idempotencyKey: "wait-key-1", taskIds: [childId], mode: "all", timeoutMs: 2_000 }
const resultContent = { toolCallId: callId, output, errorCode: null }

type EventRow = Record<string, unknown>
type Fixture = ReturnType<typeof fixture>

function ownerEvent(inputRow: Omit<EventRow, "sessionId" | "turnId" | "taskId">): EventRow {
  return { sessionId: lease.sessionId, turnId: lease.turnId, taskId: lease.id, ...inputRow }
}
function lifecycle(phase: "started" | "completed", sequence: number, completedOutput: unknown = output): EventRow {
  const digest = "a1b2c3d4e5f60718293a4b5c"
  const payload = phase === "started"
    ? { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", status: phase, input: sanitizeLifecyclePreview(input) }
    : { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", status: phase,
      output: prepareOwnerScopedWaitLifecycleOutput(completedOutput, "wait_subagents", "task").safe, errorCode: null }
  return ownerEvent({ id: `tool-lifecycle:task:${lease.id}:${callId}:${phase}:${digest}`, itemId: null,
    type: `tool_call.${phase}`, actor: "subagent", correlationId: callId, causationId: null, sequence,
    idempotencyKey: `task:${lease.id}:tool-lifecycle:${callId}:${phase}:${digest}`, payload })
}
function policy(sequence: number, attempt = lease.attemptCount): EventRow {
  const digest = createHash("sha256").update(JSON.stringify([
    lease.userId, lease.sessionId, lease.turnId, "task", lease.id, attempt, stepId, callId,
  ])).digest("hex")
  return ownerEvent({ id: `agent-policy-${digest}`, itemId: null, type: "policy.decision", actor: "subagent",
    correlationId: callId, causationId: null, sequence, idempotencyKey: `policy-decision:${digest}`,
    payload: { schemaVersion: "agent-harness.v2", policyVersion: "policy.v1", hook: "before_tool_use", outcome: "allow",
      reasonCode: "wait_allowed", reason: "Durable child wait is allowed", scope: { userId: lease.userId,
        sessionId: lease.sessionId, turnId: lease.turnId, stepId, toolCallId: callId, toolName: "wait_subagents",
        toolVersion: "1", role: "subagent", domain: "coordination", risk: "internal_write" } } })
}
function fixture(options: { initial?: boolean; side?: readonly ("started" | "policy" | "completed")[]; sourceAttempt?: number;
  resultOutput?: "waiting" | "ready"; lifecycleOutput?: "waiting" | "ready"; historicalWaitingAllowed?: boolean } = {}) {
  const initial = options.initial ?? false, side = options.side ?? [], sourceAttempt = options.sourceAttempt ?? lease.attemptCount
  const waitingOutput = { ...output, status: "waiting", matchedTaskIds: [] }
  const persistedOutput = options.resultOutput === "waiting" ? waitingOutput : output
  const completedOutput = options.lifecycleOutput === "waiting" ? waitingOutput : output
  const callContent = initial
    ? { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input }
    : { toolCallId: callId, toolName: "wait_subagents", toolVersion: "1", input, status: "completed", errorCode: null }
  const call = { id: callItemId, content: callContent }
  const previous = ownerEvent({ id: "event-previous-step", itemId: null, type: "model.completed", actor: "subagent",
    correlationId: stepId, causationId: null, sequence: 1, idempotencyKey: "previous", payload: {} })
  const itemStart = ownerEvent({ id: "event-item-start", itemId: callItemId, type: "item.started", actor: "subagent",
    correlationId: stepId, causationId: previous.id, sequence: 2, idempotencyKey: `task:${lease.id}:event:item-started:${callItemId}`,
    payload: { itemId: callItemId, type: "tool_call", phase: null } })
  const callStart = ownerEvent({ id: "event-call-start", itemId: callItemId, type: "tool_call.started", actor: "subagent",
    correlationId: callId, causationId: itemStart.id, sequence: 3, idempotencyKey: `task:${lease.id}:event:tool-started:${callId}`,
    payload: { toolCallId: callId, toolName: "wait_subagents", taskId: lease.id } })
  const canonical: EventRow[] = [itemStart, callStart]
  const sideRows = side.map((kind, index) => kind === "policy" ? policy((index + 1) * 10, sourceAttempt)
    : lifecycle(kind, (index + 1) * 10, completedOutput))
  const rows = [...canonical, ...sideRows]
  let result: EventRow | undefined
  if (!initial) {
    const sideEnd = 30
    const callComplete = ownerEvent({ id: "event-call-complete", itemId: callItemId, type: "item.completed", actor: "subagent",
      correlationId: callItemId, causationId: callStart.id, sequence: sideEnd + 10,
      idempotencyKey: `task:${lease.id}:event:tool-call-completed:${callId}:${callItemId}:1`,
      payload: { itemId: callItemId, status: "completed", content: projectWaitCallEventContent(callContent) } })
    const toolComplete = ownerEvent({ id: "event-tool-complete", itemId: callItemId, type: "tool_call.completed", actor: "subagent",
      correlationId: callId, causationId: callComplete.id, sequence: sideEnd + 20,
      idempotencyKey: `task:${lease.id}:event:tool-finished:${callId}`,
      payload: { toolCallId: callId, toolName: "wait_subagents", status: "completed", errorCode: null, taskId: lease.id } })
    const resultStart = ownerEvent({ id: "event-result-start", itemId: resultId, type: "item.started", actor: "subagent",
      correlationId: stepId, causationId: toolComplete.id, sequence: sideEnd + 30,
      idempotencyKey: `task:${lease.id}:event:item-started:${resultId}`,
      payload: { itemId: resultId, type: "tool_result", phase: null } })
    const content = { ...resultContent, output: persistedOutput }
    result = { id: resultId, content }
    const resultComplete = ownerEvent({ id: "event-result-complete", itemId: resultId, type: "item.completed", actor: "subagent",
      correlationId: resultId, causationId: resultStart.id, sequence: sideEnd + 40,
      idempotencyKey: `task:${lease.id}:event:tool-result-completed:${callId}:${resultId}:1`,
      payload: { itemId: resultId, status: "completed", content } })
    rows.push(callComplete, toolComplete, resultStart, resultComplete)
    canonical.push(callComplete, toolComplete, resultStart, resultComplete)
  }
  const client = { query: async (sql: string, params: unknown[] = []) => {
    if (sql.includes('FROM "agent_events" AS event')) return { rows: [previous], rowCount: 1 }
    if (sql.includes('"causationId" = ANY')) {
      const causes = params[3] as unknown[]
      return { rows: rows.filter(row => causes.includes(row.causationId)), rowCount: rows.filter(row => causes.includes(row.causationId)).length }
    }
    const [sessionId, turnId, taskId, callItem, call, resultItem, keys, idPrefix, keyPrefix, policyId, policyKey] = params
    const selected = rows.filter(row => row.sessionId === sessionId && row.turnId === turnId && row.taskId === taskId
      && (row.itemId === callItem || row.correlationId === call || row.itemId === resultItem || row.correlationId === resultItem
        || (keys as string[]).includes(String(row.idempotencyKey)) || String(row.id).startsWith(String(idPrefix))
        || String(row.idempotencyKey).startsWith(String(keyPrefix)) || row.id === policyId || row.idempotencyKey === policyKey))
      .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    return { rows: selected, rowCount: selected.length }
  } }
  const wait = { id: waitId, targetTaskIds: [childId], deadlineAt: new Date(output.deadlineAt) }
  return { initial, side, rows, canonical, client, call, result, sourceAttempt, wait,
    historicalWaitingAllowed: options.historicalWaitingAllowed ?? initial }
}
function inspect(fake: Fixture) {
  return validateChildWaitSourceEvents({ client: fake.client as never, lease, wait: fake.wait, stepId, call: fake.call, result: fake.result,
    callId, callItemId, resultId, sourceAttempt: fake.sourceAttempt, output, initial: fake.initial,
    waiting: false, historicalWaitingAllowed: fake.historicalWaitingAllowed })
}

describe("child wait source side-event validation", () => {
  it("accepts canonical completion with legacy zero-side-event history", async () => {
    await expect(inspect(fixture())).resolves.toBe(true)
  })

  it("accepts complete scoped ToolLifecycle and policy telemetry beside all six canonical events", async () => {
    await expect(inspect(fixture({ side: ["started", "policy", "completed"] }))).resolves.toBe(true)
  })

  it("requires lifecycle completion telemetry to precede the canonical call-item completion", async () => {
    const fake = fixture({ side: ["started", "policy", "completed"] })
    const callItemCompletion = fake.canonical.find(row => String(row.idempotencyKey).includes("tool-call-completed:"))!
    callItemCompletion.sequence = 25
    await expect(inspect(fake)).resolves.toBe(false)
  })

  it("matches the completed lifecycle to the persisted waiting receipt after the current result becomes ready", async () => {
    await expect(inspect(fixture({ side: ["started", "policy", "completed"], resultOutput: "waiting", lifecycleOutput: "waiting" })))
      .resolves.toBe(true)
    const tampered = fixture({ side: ["started", "policy", "completed"], resultOutput: "waiting", lifecycleOutput: "waiting" })
    const completed = tampered.rows.find(row => row.type === "tool_call.completed")!
    const payload = completed.payload as Record<string, unknown>
    payload.output = { ...(payload.output as Record<string, unknown>), matchedTaskIds: ["foreign-target"] }
    await expect(inspect(tampered)).resolves.toBe(false)
  })

  it("accepts only a structurally bound historical waiting lifecycle output when the ready result replaced it", async () => {
    const recovered = fixture({ side: ["started", "policy", "completed"], lifecycleOutput: "waiting", historicalWaitingAllowed: true })
    await expect(inspect(recovered)).resolves.toBe(true)
    const tampered = fixture({ side: ["started", "policy", "completed"], lifecycleOutput: "waiting", historicalWaitingAllowed: true })
    const completed = tampered.rows.find(row => row.type === "tool_call.completed")!
    const payload = completed.payload as Record<string, unknown>
    payload.output = { ...(payload.output as Record<string, unknown>), waitId: "foreign-wait" }
    await expect(inspect(tampered)).resolves.toBe(false)
    await expect(inspect(fixture({ side: ["started", "policy", "completed"], lifecycleOutput: "waiting" }))).resolves.toBe(false)
  })

  it("binds policy identity to the source attempt and ignores JSONB object-key order", async () => {
    const fake = fixture({ sourceAttempt: lease.attemptCount - 1, side: ["started", "policy", "completed"] })
    for (const row of fake.rows.filter(row => row.type === "policy.decision" || String(row.id).startsWith("tool-lifecycle:"))) {
      row.payload = Object.fromEntries(Object.entries(row.payload as Record<string, unknown>).reverse())
    }
    await expect(inspect(fake)).resolves.toBe(true)
  })

  it.each([
    { side: [] }, { side: ["started"] }, { side: ["started", "policy"] },
    { side: ["started", "policy", "completed"] },
  ] as const)("accepts only a real initial crash-cut telemetry prefix: $side", async ({ side }) => {
    await expect(inspect(fixture({ initial: true, side }))).resolves.toBe(true)
  })

  it.each([
    ["policy without lifecycle start", ["policy"]],
    ["completion without policy", ["started", "completed"]],
    ["reordered policy", ["policy", "started"]],
    ["truncated terminal history", ["started", "policy"]],
    ["unknown progress phase", ["started", "policy", "progress"]],
  ] as const)("rejects invalid or incomplete terminal side-event set: %s", async (_label, side) => {
    await expect(inspect(fixture({ side: side as never }))).resolves.toBe(false)
  })

  it.each([
    ["policy event owner", (row: EventRow) => { row.taskId = "foreign-task" }],
    ["policy actor", (row: EventRow) => { row.actor = "tool" }],
    ["policy payload scope", (row: EventRow) => { (row.payload as Record<string, unknown>).scope = { ...(row.payload as Record<string, unknown>).scope as object, userId: "foreign-user" } }],
    ["policy outcome", (row: EventRow) => { (row.payload as Record<string, unknown>).outcome = "deny" }],
    ["policy identity key", (row: EventRow) => { row.idempotencyKey = "policy-decision:wrong" }],
    ["started lifecycle call identity", (row: EventRow) => { (row.payload as Record<string, unknown>).toolCallId = "another-call" }],
    ["started lifecycle ID digest", (row: EventRow) => { row.id = String(row.id).replace(/[0-9a-f]{24}$/, "b".repeat(24)) }],
    ["started lifecycle input", (row: EventRow) => { (row.payload as Record<string, unknown>).input = { ...input, timeoutMs: 1 } }],
    ["completed lifecycle key digest", (row: EventRow) => { row.idempotencyKey = String(row.idempotencyKey).replace(/[0-9a-f]{24}$/, "b".repeat(24)) }],
    ["completed lifecycle output", (row: EventRow) => { (row.payload as Record<string, unknown>).output = { status: "failed" } }],
  ] as const)("rejects tampered side event: %s", async (_label, corrupt) => {
    const fake = fixture({ side: ["started", "policy", "completed"] })
    const row = fake.rows[Number(_label.startsWith("policy") ? 3 : _label.startsWith("started") ? 2 : 4)]!
    corrupt(row)
    await expect(inspect(fake)).resolves.toBe(false)
  })

  it("rejects duplicate same-phase lifecycle records and any unrelated correlated event", async () => {
    const duplicate = fixture({ side: ["started", "policy", "completed"] })
    duplicate.rows.push({ ...duplicate.rows[2], id: "tool-lifecycle:task:task-parent:provider:call%_42:started:bbbbbbbbbbbbbbbbbbbbbbbb",
      idempotencyKey: "task:task-parent:tool-lifecycle:provider:call%_42:started:bbbbbbbbbbbbbbbbbbbbbbbb", sequence: 15 })
    await expect(inspect(duplicate)).resolves.toBe(false)
    const unknown = fixture({ side: ["started", "policy", "completed"] })
    unknown.rows.push({ ...unknown.rows[0], id: "untrusted-extra", type: "custom.event", itemId: null, actor: "subagent",
      correlationId: callId, causationId: null, idempotencyKey: "untrusted-extra", sequence: 25 })
    await expect(inspect(unknown)).resolves.toBe(false)
  })

  it("keeps the six canonical events mandatory and preserves the canonical cause fence", async () => {
    const missing = fixture({ side: ["started", "policy", "completed"] })
    missing.rows.splice(missing.rows.findIndex(row => row.id === "event-result-complete"), 1)
    await expect(inspect(missing)).resolves.toBe(false)
    const extraCause = fixture({ side: ["started", "policy", "completed"] })
    extraCause.rows.push({ ...extraCause.rows[0], id: "unexpected-causal", type: "custom.event", itemId: null,
      correlationId: "unrelated", causationId: "event-call-start", idempotencyKey: "unexpected-causal", sequence: 80 })
    await expect(inspect(extraCause)).resolves.toBe(false)
    const tampered = fixture({ side: ["started", "policy", "completed"] })
    const resultEvent = tampered.rows.find(row => row.id === "event-result-complete")!
    ;(resultEvent.payload as Record<string, unknown>).status = "failed"
    await expect(inspect(tampered)).resolves.toBe(false)
  })
})
