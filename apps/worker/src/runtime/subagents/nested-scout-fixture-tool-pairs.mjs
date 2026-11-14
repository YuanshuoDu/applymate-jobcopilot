import { isDeepStrictEqual } from "node:util"

function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : null }

function matchingToolUses(request, name, inputMatches) {
  const messages = record(request)?.messages
  if (!Array.isArray(messages) || typeof name !== "string" || !name) {
    throw new Error("p1143_fixture_tool_pair_request_invalid")
  }
  const uses = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = record(messages[index])
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue
    for (const partValue of message.content) {
      const part = record(partValue)
      if (part?.type !== "tool_use" || part.name !== name || !inputMatches(part.input)) continue
      if (typeof part.id !== "string" || part.id.length === 0) throw new Error("p1143_fixture_tool_pair_call_invalid")
      uses.push({ id: part.id, input: part.input, messageIndex: index })
    }
  }
  return uses
}

export function findUniqueWaitInput(request, taskIds) {
  const expected = [...taskIds].sort((left, right) => left.localeCompare(right))
  const uses = matchingToolUses(request, "wait_subagents", () => true)
  if (uses.length > 1) throw new Error("p1143_fixture_tool_pair_call_ambiguous")
  if (uses.length === 0) return null
  const input = record(uses[0].input), keys = input ? Object.keys(input).sort().join(",") : ""
  if (keys !== "idempotencyKey,mode,taskIds,timeoutMs" || typeof input.idempotencyKey !== "string"
    || !/^final-dependency-wait:[a-f0-9]{64}$/.test(input.idempotencyKey) || input.mode !== "all"
    || input.timeoutMs !== 30_000 || !Array.isArray(input.taskIds) || !isDeepStrictEqual(input.taskIds, expected)) {
    throw new Error("p1143_fixture_wait_input_invalid")
  }
  return input
}

export function findExactToolResult(request, expected) {
  const value = record(expected), name = value?.name, input = value?.input
  const messages = record(request)?.messages
  if (!value || !Object.hasOwn(value, "input") || typeof name !== "string" || !name) {
    throw new Error("p1143_fixture_tool_pair_request_invalid")
  }
  const uses = matchingToolUses(request, name, candidate => isDeepStrictEqual(candidate, input))
  if (uses.length > 1) throw new Error("p1143_fixture_tool_pair_call_ambiguous")
  if (uses.length === 0) return null
  const use = uses[0]
  const results = []
  for (let index = use.messageIndex + 1; index < messages.length; index += 1) {
    const message = record(messages[index])
    if (message?.role !== "tool" || !Array.isArray(message.content)) continue
    for (const resultValue of message.content) {
      const result = record(resultValue)
      if (result?.type === "tool_result" && result.toolUseId === use.id) results.push(result)
    }
  }
  if (results.length > 1) throw new Error("p1143_fixture_tool_pair_result_ambiguous")
  if (results.length === 0) return null
  const result = results[0]
  if (typeof result.content !== "string" || Object.hasOwn(result, "isError") && typeof result.isError !== "boolean") {
    throw new Error("p1143_fixture_tool_pair_result_invalid")
  }
  let output
  try { output = JSON.parse(result.content) } catch { throw new Error("p1143_fixture_tool_pair_result_invalid") }
  return { callId: use.id, output, isError: result.isError === true }
}
