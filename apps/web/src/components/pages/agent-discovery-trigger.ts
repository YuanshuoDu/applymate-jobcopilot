export type AgentDiscoveryStartResult =
  | { mode: "unavailable"; reason: "feature_disabled" | "not_entitled" }
  | { mode: "task_graph"; sessionId: string; turnId: string; disposition: string }

type TriggerOptions = {
  clientMessageId: string
  onTaskGraphStarted: (result: Extract<AgentDiscoveryStartResult, { mode: "task_graph" }>) => void
  fetcher?: typeof fetch
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function dispatchAgentDiscoveryStart({
  clientMessageId,
  onTaskGraphStarted,
  fetcher = fetch,
}: TriggerOptions): Promise<AgentDiscoveryStartResult> {
  const response = await fetcher("/api/agent/discovery/start", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": clientMessageId },
    body: JSON.stringify({ clientMessageId }),
  })
  const body: unknown = await response.json().catch(() => undefined)
  if (!response.ok) {
    if (response.status === 403 && isUnavailable(body)) return body
    throw new Error(`Could not start Agent discovery (status ${response.status})`)
  }
  if (!isRecord(body)) throw new Error("Invalid Agent discovery response")
  if (isUnavailable(body)) return body
  if (body.mode === "task_graph" && typeof body.sessionId === "string" && typeof body.turnId === "string" && typeof body.disposition === "string") {
    const result = { mode: "task_graph", sessionId: body.sessionId, turnId: body.turnId, disposition: body.disposition } as const
    onTaskGraphStarted(result)
    return result
  }
  throw new Error("Invalid Agent discovery response")
}

function isUnavailable(value: unknown): value is Extract<AgentDiscoveryStartResult, { mode: "unavailable" }> {
  if (!isRecord(value) || value.mode !== "unavailable") return false
  return value.reason === "feature_disabled" || value.reason === "not_entitled"
}
