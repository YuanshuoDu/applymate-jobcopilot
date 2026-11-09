const HOST = "boards.greenhouse.io:443"
const MODEL_FAILURE_CODES = new Set([
  "application_fill_fixture_model_validation_failed", "application_fill_tool_transcript_invalid", "application_fill_tool_use_id_invalid",
  "application_fill_plan_receipt_missing_ready_task", "application_fill_plan_receipt_invalid", "application_fill_wait_limit_exceeded",
  "application_fill_wait_output_missing", "application_fill_wait_output_invalid", "application_fill_wait_scope_or_status_invalid",
  "application_fill_wait_terminal_interrupted", "application_fill_wait_terminal_closed", "application_fill_child_terminal_status_invalid",
])
function modelValidationFailure(code) {
  const safeCode = MODEL_FAILURE_CODES.has(code) ? code : "application_fill_fixture_model_validation_failed"
  const error = new Error("ApplicationTask full-loop fixture model validation failed")
  Object.defineProperty(error, "code", { value: safeCode, enumerable: true })
  return error
}
function failModel(code) { throw modelValidationFailure(code) }
function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name}_required`)
  return value
}
function safeBlockedTarget(value) {
  if (typeof value !== "string" || !value) return "invalid_target"
  try {
    let target
    if (/^https?:\/\//i.test(value)) {
      target = new URL(value)
    } else if (/^[a-z][a-z\d+.-]*:\/\//i.test(value)) {
      return "invalid_target"
    } else if (value.startsWith("//")) {
      target = new URL("https:" + value)
    } else if (value.startsWith("/")) {
      return "fixture_local"
    } else {
      target = new URL("https://" + value)
    }
    const isApprovedHost = target.protocol === "https:"
      && target.hostname.toLowerCase() === "boards.greenhouse.io"
      && (!target.port || target.port === "443")
    return isApprovedHost ? HOST : "external_target"
  } catch {
    return "invalid_target"
  }
}
function modelProfile() {
  return { provider: "fixture", model: "fixture-model", nativeTools: true, structuredOutput: true, streaming: true,
    continuationCursor: false, supportsParallelTools: false, supportsStreamingToolArgs: true,
    supportsReasoningSummary: true, supportsResponseContinuation: false, supportsProviderConversation: false,
    supportsBackgroundResponse: false, maxContextTokens: null, maxOutputTokens: null, costClass: "low" }
}

function assertToolMessagePairs(request) {
  const callCounts = new Map()
  const resultCounts = new Map()
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (part?.type === "tool_use") {
      if (message.role !== "assistant" || typeof part.id !== "string" || !part.id.trim()
        || typeof part.name !== "string" || !part.name.trim()) failModel("application_fill_tool_transcript_invalid")
      callCounts.set(part.id, (callCounts.get(part.id) ?? 0) + 1)
    } else if (part?.type === "tool_result") {
      if (message.role !== "tool" || typeof part.toolUseId !== "string" || !part.toolUseId.trim()
        || typeof part.content !== "string") failModel("application_fill_tool_transcript_invalid")
      resultCounts.set(part.toolUseId, (resultCounts.get(part.toolUseId) ?? 0) + 1)
    }
  }
  for (const id of new Set([...callCounts.keys(), ...resultCounts.keys()])) {
    if (callCounts.get(id) !== 1 || resultCounts.get(id) !== 1) failModel("application_fill_tool_transcript_invalid")
  }
}
function toolUses(request, name) {
  const calls = []
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role !== "assistant" || part?.type !== "tool_use" || part.name !== name) continue
    if (typeof part.id !== "string" || !part.id.trim()) failModel("application_fill_tool_use_id_invalid")
    calls.push(part)
  }
  return calls
}
function correlatedToolOutput(request, call, missingCode, invalidCode) {
  const matchingCalls = []
  const matchingResults = []
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role === "assistant" && part?.type === "tool_use" && part.id === call.id) matchingCalls.push(part)
    if (message.role === "tool" && part?.type === "tool_result" && part.toolUseId === call.id) matchingResults.push(part)
  }
  if (matchingCalls.length !== 1 || matchingCalls[0]?.name !== call.name || matchingResults.length > 1) {
    failModel(invalidCode)
  }
  const result = matchingResults[0]
  if (!result) failModel(missingCode)
  if (result.isError === true || typeof result.content !== "string") failModel(invalidCode)
  try {
    const output = JSON.parse(result.content)
    if (!output || typeof output !== "object" || Array.isArray(output)) failModel(invalidCode)
    return output
  } catch {
    failModel(invalidCode)
  }
}
function taskIdFromPlan(request) {
  const planCalls = toolUses(request, "agent.plan")
  if (planCalls.length === 0) {
    if (toolUses(request, "agent.wait").length > 0) failModel("application_fill_plan_receipt_missing_ready_task")
    return null
  }
  if (planCalls.length !== 1) failModel("application_fill_plan_receipt_invalid")
  const result = correlatedToolOutput(request, planCalls[0],
    "application_fill_plan_receipt_missing_ready_task", "application_fill_plan_receipt_invalid")
  if (!Array.isArray(result.readyTaskIds) || result.readyTaskIds.length !== 1
    || typeof result.readyTaskIds[0] !== "string" || !result.readyTaskIds[0].trim()) {
    failModel("application_fill_plan_receipt_missing_ready_task")
  }
  return result.readyTaskIds[0]
}
const MAX_FILL_WAIT_CALLS = 4
const FILL_WAIT_TIMEOUT_MS = 30_000
const ACTIVE_FILL_TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting"])
const ACCEPTED_FILL_TASK_STATUSES = new Set(["waiting_for_user", "completed"])
const VALID_WAIT_STATUSES = new Set(["waiting", "ready", "timed_out", "interrupted", "closed"])
const VALID_RESUMED_WAIT_STATUSES = new Set(["ready", "timed_out", "interrupted"])

function isRecord(value) { return Boolean(value && typeof value === "object" && !Array.isArray(value)) }
function hasExactKeys(value, expected) { return isRecord(value) && Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key)) }
function hasOnlyKeys(value, required, optional = []) {
  if (!isRecord(value)) return false
  const allowed = new Set([...required, ...optional]), keys = Object.keys(value)
  return required.every(key => Object.hasOwn(value, key)) && keys.every(key => allowed.has(key))
}
function agentWaitHistory(request, targetTaskId) {
  const waitCalls = toolUses(request, "agent.wait")
  const history = []
  const liveReceiptIndexes = new Map()
  const resumedReceiptIndexes = []
  let requestedCount = 0
  for (const [callIndex, call] of waitCalls.entries()) {
    const output = correlatedToolOutput(request, call, "application_fill_wait_output_missing", "application_fill_wait_output_invalid")
    if (call.id.startsWith("wait:")) {
      const disposition = fillResumedWaitDisposition(call, output, targetTaskId)
      resumedReceiptIndexes.push({ waitId: output.waitId, callIndex })
      history.push({ callId: call.id, output, disposition, resumed: true })
      continue
    }
    requestedCount += 1
    if (requestedCount > MAX_FILL_WAIT_CALLS) failModel("application_fill_wait_limit_exceeded")
    const expectedCallId = `full-loop-wait-${requestedCount}`
    const input = call.input
    if (call.id !== expectedCallId || !hasExactKeys(input, ["idempotencyKey", "taskIds", "mode", "timeoutMs"])
      || input.idempotencyKey !== `application-task-full-loop:wait:${requestedCount}`
      || !Array.isArray(input.taskIds) || input.taskIds.length !== 1 || input.taskIds[0] !== targetTaskId
      || input.mode !== "all" || input.timeoutMs !== FILL_WAIT_TIMEOUT_MS) {
      failModel("application_fill_wait_output_invalid")
    }
    const disposition = fillWaitDisposition(output, targetTaskId)
    if (liveReceiptIndexes.has(output.waitId)) failModel("application_fill_wait_output_invalid")
    liveReceiptIndexes.set(output.waitId, callIndex)
    history.push({ callId: call.id, output, disposition, resumed: false })
  }
  for (const { waitId, callIndex } of resumedReceiptIndexes) {
    const liveCallIndex = liveReceiptIndexes.get(waitId)
    if (liveCallIndex === undefined || liveCallIndex >= callIndex) failModel("application_fill_wait_output_invalid")
  }
  return { history, requestedCount }
}
function fillWaitDisposition(output, targetTaskId) {
  const receiptKeys = ["waitId", "status", "taskIds", "deadlineAt", "matchedTaskIds", "tasks"]
  if (!hasExactKeys(output, receiptKeys)
    || !Array.isArray(output.taskIds) || output.taskIds.length !== 1 || output.taskIds[0] !== targetTaskId
    || typeof output.waitId !== "string" || !output.waitId.trim() || typeof output.deadlineAt !== "string" || !output.deadlineAt.trim()
    || !validMatchedTaskIds(output.matchedTaskIds, targetTaskId)
    || !VALID_WAIT_STATUSES.has(output.status)) failModel("application_fill_wait_scope_or_status_invalid")
  if (output.status === "interrupted") failModel("application_fill_wait_terminal_interrupted")
  if (output.status === "closed") failModel("application_fill_wait_terminal_closed")
  const status = fillWaitTaskStatus(output.tasks, targetTaskId, false)
  return fillTaskDisposition(output.status, output.matchedTaskIds, targetTaskId, status)
}
function fillResumedWaitDisposition(call, output, targetTaskId) {
  const input = call.input
  const receiptKeys = ["waitId", "status", "matchedTaskIds", "targetTaskIds", "tasks"]
  if (!hasExactKeys(input, ["taskIds", "mode"]) || !Array.isArray(input.taskIds)
    || input.taskIds.length !== 1 || input.taskIds[0] !== targetTaskId || input.mode !== "all"
    || !hasExactKeys(output, receiptKeys) || typeof output.waitId !== "string" || !output.waitId.trim()
    || call.id !== `wait:${output.waitId}` || !Array.isArray(output.targetTaskIds)
    || output.targetTaskIds.length !== 1 || output.targetTaskIds[0] !== targetTaskId
    || !validMatchedTaskIds(output.matchedTaskIds, targetTaskId)
    || !VALID_RESUMED_WAIT_STATUSES.has(output.status)) {
    failModel("application_fill_wait_scope_or_status_invalid")
  }
  if (output.status === "interrupted") failModel("application_fill_wait_terminal_interrupted")
  const status = fillWaitTaskStatus(output.tasks, targetTaskId, true)
  return fillTaskDisposition(output.status, output.matchedTaskIds, targetTaskId, status)
}
function validMatchedTaskIds(value, targetTaskId) { return Array.isArray(value) && value.length <= 1 && value.every(taskId => typeof taskId === "string") && new Set(value).size === value.length && value.every(taskId => taskId === targetTaskId) }
function fillWaitTaskStatus(tasks, targetTaskId, resumed) {
  if (!Array.isArray(tasks) || tasks.length !== 1) failModel("application_fill_wait_scope_or_status_invalid")
  const task = tasks[0]
  const baseKeys = ["taskId", "status", "role", "result", "failureReason"]
  const liveStateKeys = [...baseKeys, "attemptCount", "maxAttempts", "leaseExpiresAt", "interruptRequestedAt"]
  const consumedOptionalKeys = ["verificationReport", "repairReceipt"]
  const taskShapeValid = resumed
    ? hasOnlyKeys(task, baseKeys, consumedOptionalKeys)
    : hasExactKeys(task, baseKeys) || hasExactKeys(task, liveStateKeys)
  if (!taskShapeValid || task.taskId !== targetTaskId || typeof task.status !== "string"
    || (resumed ? task.role !== null && (typeof task.role !== "string" || !task.role.trim()) : typeof task.role !== "string" || !task.role.trim())
    || (task.failureReason !== null && typeof task.failureReason !== "string")
    || consumedOptionalKeys.some(key => Object.hasOwn(task, key) && !isRecord(task[key]))) failModel("application_fill_wait_scope_or_status_invalid")
  return task.status
}
function fillTaskDisposition(waitStatus, matchedTaskIds, targetTaskId, taskStatus) {
  if (waitStatus === "ready") {
    if (matchedTaskIds.length !== 1 || matchedTaskIds[0] !== targetTaskId) failModel("application_fill_wait_scope_or_status_invalid")
    if (ACCEPTED_FILL_TASK_STATUSES.has(taskStatus)) return "complete"
  } else if ((waitStatus === "waiting" || waitStatus === "timed_out") && matchedTaskIds.length === 0
    && (ACTIVE_FILL_TASK_STATUSES.has(taskStatus) || ACCEPTED_FILL_TASK_STATUSES.has(taskStatus))) return "pending"
  failModel("application_fill_child_terminal_status_invalid")
}

function fixtureModel() {
  return {
    adapter: {
      id: "application-task-full-loop-model", profile: modelProfile(),
      async *stream(request) {
        assertToolMessagePairs(request)
        const targetTaskId = taskIdFromPlan(request)
        if (!targetTaskId) {
          yield { type: "tool_call_completed", callId: "full-loop-plan", name: "agent.plan", arguments: {
            expectedRevision: 0,
            nodes: [{ key: "application-fill", templateId: "application_filler", goal: "Fill the selected application for review",
              successCriteria: ["Observe the required synthetic work authorization field"], dependsOn: [] }],
          } }
          yield { type: "completed", finishReason: "tool_calls" }
          return
        }

        const { history: waitHistory, requestedCount } = agentWaitHistory(request, targetTaskId)
        if (waitHistory.at(-1)?.disposition === "complete") {
          yield { type: "text_delta", text: "The synthetic application fill reached its durable review boundary." }
          yield { type: "completed", finishReason: "stop" }
          return
        }
        const nextWaitSequence = requestedCount + 1
        if (nextWaitSequence > MAX_FILL_WAIT_CALLS) failModel("application_fill_wait_limit_exceeded")
        yield { type: "tool_call_completed", callId: "full-loop-wait-" + nextWaitSequence, name: "agent.wait", arguments: {
          idempotencyKey: "application-task-full-loop:wait:" + nextWaitSequence,
          taskIds: [targetTaskId], mode: "all", timeoutMs: FILL_WAIT_TIMEOUT_MS,
        } }
        yield { type: "completed", finishReason: "tool_calls" }
      },
    },
    registry: {}, candidates: [],
  }
}
export { HOST, fixtureModel, required, safeBlockedTarget }
