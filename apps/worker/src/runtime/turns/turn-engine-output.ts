import type { RepositoryJsonValue } from "@jobcopilot/agent-protocol"

export class TurnEngineError extends Error {
  constructor(
    readonly code: "final_unverified" | "step_limit" | "model_incomplete" | "persistence_conflict" | "invalid_output" | "budget_exhausted" | "no_progress" | "evidence_missing" | "evidence_conflict" | "business_precondition_failed" | "discovery_memory_overflow",
    message: string,
  ) {
    super(message)
    this.name = "TurnEngineError"
  }
}

export function toRepositoryJson(value: unknown): RepositoryJsonValue {
  if (value === null || value === undefined) return null
  if (typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TurnEngineError("invalid_output", "Engine output contains a non-finite number")
    return value
  }
  if (Array.isArray(value)) return value.map(toRepositoryJson)
  if (typeof value !== "object") throw new TurnEngineError("invalid_output", "Engine output is not JSON serializable")
  const result: { [key: string]: RepositoryJsonValue } = {}
  for (const key of Object.keys(value).sort()) {
    const child = (value as Record<string, unknown>)[key]
    if (child !== undefined) result[key] = toRepositoryJson(child)
  }
  return result
}
