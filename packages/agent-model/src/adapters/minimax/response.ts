type RecordValue = Record<string, unknown>

interface ReasoningState {
  previousText: string
}

/** Convert MiniMax reasoning_details to the provider-neutral reasoning field. */
export function normalizeMiniMaxReasoningResponse(response: Response): Response {
  if (!response.body) return response
  const state: ReasoningState = { previousText: "" }
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let pending = ""
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true })
      emitCompleteLines(controller, encoder, state, pending, (remaining) => { pending = remaining })
    },
    flush(controller) {
      pending += decoder.decode()
      if (pending) controller.enqueue(encoder.encode(normalizeLine(pending, state)))
    },
  })
  return new Response(response.body.pipeThrough(transform), {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  })
}

function emitCompleteLines(
  controller: TransformStreamDefaultController<Uint8Array>,
  encoder: TextEncoder,
  state: ReasoningState,
  input: string,
  setRemaining: (remaining: string) => void,
): void {
  let remaining = input
  let newline = remaining.indexOf("\n")
  while (newline >= 0) {
    const line = remaining.slice(0, newline + 1)
    remaining = remaining.slice(newline + 1)
    controller.enqueue(encoder.encode(normalizeLine(line, state)))
    newline = remaining.indexOf("\n")
  }
  setRemaining(remaining)
}

function normalizeLine(line: string, state: ReasoningState): string {
  const match = /^(data:\s?)(.*?)(\r?\n)?$/.exec(line)
  if (!match || match[2].trim() === "[DONE]") return line
  let parsed: unknown
  try {
    parsed = JSON.parse(match[2].trim()) as unknown
  } catch {
    return line
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.choices)) return line
  const choices = parsed.choices.map((choice) => normalizeChoice(choice, state))
  return `${match[1]}${JSON.stringify({ ...parsed, choices })}${match[3] ?? ""}`
}

function normalizeChoice(value: unknown, state: ReasoningState): unknown {
  if (!isRecord(value) || !isRecord(value.delta) || !Object.hasOwn(value.delta, "reasoning_details")) return value
  const delta = value.delta
  const currentText = reasoningText(delta.reasoning_details)
  const reasoningDelta = currentText.startsWith(state.previousText)
    ? currentText.slice(state.previousText.length)
    : currentText
  state.previousText = currentText.startsWith(state.previousText)
    ? currentText
    : state.previousText + currentText
  const nextDelta: RecordValue = { ...delta }
  delete nextDelta.reasoning_details
  if (reasoningDelta) nextDelta.reasoning = reasoningDelta
  return { ...value, delta: nextDelta }
}

function reasoningText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.text !== "string") return []
    return [item.text]
  }).join("")
}

function isRecord(value: unknown): value is RecordValue {
  return Boolean(value && typeof value === "object" && !Array.isArray(value))
}
