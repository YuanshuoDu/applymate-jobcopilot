const HOST = "boards.greenhouse.io:443"

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
        || typeof part.name !== "string" || !part.name.trim()) throw new Error("application_fill_tool_transcript_invalid")
      callCounts.set(part.id, (callCounts.get(part.id) ?? 0) + 1)
    } else if (part?.type === "tool_result") {
      if (message.role !== "tool" || typeof part.toolUseId !== "string" || !part.toolUseId.trim()
        || typeof part.content !== "string") throw new Error("application_fill_tool_transcript_invalid")
      resultCounts.set(part.toolUseId, (resultCounts.get(part.toolUseId) ?? 0) + 1)
    }
  }
  for (const id of new Set([...callCounts.keys(), ...resultCounts.keys()])) {
    if (callCounts.get(id) !== 1 || resultCounts.get(id) !== 1) throw new Error("application_fill_tool_transcript_invalid")
  }
}

function toolUses(request, name) {
  const calls = []
  for (const message of request.messages ?? []) for (const part of message.content ?? []) {
    if (message.role !== "assistant" || part?.type !== "tool_use" || part.name !== name) continue
    if (typeof part.id !== "string" || !part.id.trim()) throw new Error("application_fill_tool_use_id_invalid")
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
    throw new Error(invalidCode)
  }
  const result = matchingResults[0]
  if (!result) throw new Error(missingCode)
  if (result.isError === true || typeof result.content !== "string") throw new Error(invalidCode)
  try {
    const output = JSON.parse(result.content)
    if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error(invalidCode)
    return output
  } catch {
    throw new Error(invalidCode)
  }
}

function taskIdFromPlan(request) {
  const planCalls = toolUses(request, "agent.plan")
  if (planCalls.length === 0) {
    if (toolUses(request, "agent.wait").length > 0) throw new Error("application_fill_plan_receipt_missing_ready_task")
    return null
  }
  if (planCalls.length !== 1) throw new Error("application_fill_plan_receipt_invalid")
  const result = correlatedToolOutput(request, planCalls[0],
    "application_fill_plan_receipt_missing_ready_task", "application_fill_plan_receipt_invalid")
  if (!Array.isArray(result.readyTaskIds) || result.readyTaskIds.length !== 1
    || typeof result.readyTaskIds[0] !== "string" || !result.readyTaskIds[0].trim()) {
    throw new Error("application_fill_plan_receipt_missing_ready_task")
  }
  return result.readyTaskIds[0]
}
const MAX_FILL_WAIT_CALLS = 4
const FILL_WAIT_TIMEOUT_MS = 30_000
const ACTIVE_FILL_TASK_STATUSES = new Set(["queued", "running", "retrying", "waiting"])
const ACCEPTED_FILL_TASK_STATUSES = new Set(["waiting_for_user", "completed"])
const VALID_WAIT_STATUSES = new Set(["waiting", "ready", "timed_out", "interrupted", "closed"])

function agentWaitHistory(request, targetTaskId) {
  const waitCalls = toolUses(request, "agent.wait")
  if (waitCalls.length > MAX_FILL_WAIT_CALLS) throw new Error("application_fill_wait_limit_exceeded")
  return waitCalls.map(call => {
    const output = correlatedToolOutput(request, call, "application_fill_wait_output_missing", "application_fill_wait_output_invalid")
    const disposition = fillWaitDisposition(output, targetTaskId)
    return { callId: call.id, output, disposition }
  })
}

function fillWaitDisposition(output, targetTaskId) {
  if (!Array.isArray(output.taskIds) || output.taskIds.length !== 1 || output.taskIds[0] !== targetTaskId
    || !Array.isArray(output.tasks) || output.tasks.length !== 1 || output.tasks[0]?.taskId !== targetTaskId
    || typeof output.waitId !== "string" || !output.waitId.trim()
    || typeof output.deadlineAt !== "string" || !output.deadlineAt.trim()
    || !Array.isArray(output.matchedTaskIds) || !output.matchedTaskIds.every(taskId => typeof taskId === "string")
    || !VALID_WAIT_STATUSES.has(output.status)) throw new Error("application_fill_wait_scope_or_status_invalid")
  if (output.status === "interrupted" || output.status === "closed") {
    throw new Error("application_fill_wait_terminal_" + output.status)
  }
  const status = output.tasks[0].status
  if (ACCEPTED_FILL_TASK_STATUSES.has(status)) return "complete"
  if (ACTIVE_FILL_TASK_STATUSES.has(status)) return "pending"
  throw new Error("application_fill_child_terminal_" + String(status))
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

        const waitHistory = agentWaitHistory(request, targetTaskId)
        if (waitHistory.at(-1)?.disposition === "complete") {
          yield { type: "text_delta", text: "The synthetic application fill reached its durable review boundary." }
          yield { type: "completed", finishReason: "stop" }
          return
        }
        const nextWaitSequence = waitHistory.length + 1
        if (nextWaitSequence > MAX_FILL_WAIT_CALLS) throw new Error("application_fill_wait_limit_exceeded")
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
