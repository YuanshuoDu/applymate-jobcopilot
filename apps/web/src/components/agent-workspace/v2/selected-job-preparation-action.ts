export interface SelectedJobPreparationRequest {
  readonly sessionId: string
  readonly jobId: string
  readonly clientMessageId: string
}

export interface SelectedJobPreparationResponse {
  readonly inputId: string
  readonly turnId: string
  readonly disposition: "started" | "duplicate"
  readonly sequence: string
}

let sequence = 0

export function createSelectedJobPreparationMessageId(): string {
  sequence += 1
  const id = typeof globalThis.crypto?.randomUUID === "function"
    ? globalThis.crypto.randomUUID()
    : `fallback-${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `selected-job-preparation-${id}-${sequence}`
}

/** Sends the selected ID in the typed command envelope, never in model-authored text. */
export async function postSelectedJobPreparation(
  request: SelectedJobPreparationRequest,
  fetcher: typeof fetch = fetch,
): Promise<SelectedJobPreparationResponse> {
  const response = await fetcher(`/api/agent/sessions/${encodeURIComponent(request.sessionId)}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": request.clientMessageId },
    body: JSON.stringify({
      clientMessageId: request.clientMessageId,
      delivery: "follow_up",
      selectedJobPreparation: { jobId: request.jobId },
      content: [{ type: "text", text: "Prepare a cover letter draft for the selected job." }],
    }),
  })
  const body = await response.json().catch(() => null) as unknown
  if (!response.ok) throw new SelectedJobPreparationError(response.status)
  return parseResponse(body)
}

export class SelectedJobPreparationError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Selected-job preparation request failed with status ${status}`)
    this.name = "SelectedJobPreparationError"
    this.status = status
  }
}

function parseResponse(value: unknown): SelectedJobPreparationResponse {
  if (!isRecord(value) || typeof value.inputId !== "string" || typeof value.turnId !== "string"
    || typeof value.sequence !== "string" || (value.disposition !== "started" && value.disposition !== "duplicate")) {
    throw new Error("Selected-job preparation returned an invalid response")
  }
  return { inputId: value.inputId, turnId: value.turnId, sequence: value.sequence, disposition: value.disposition }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
