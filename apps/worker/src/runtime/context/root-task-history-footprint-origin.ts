import { OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT, TurnIntentSchema, validate } from "@jobcopilot/agent-protocol"

type Row = Record<string, unknown>

const FOOTPRINT_ORIGIN = JSON.stringify([
  "user", OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind, OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version,
])

function object(value: unknown): Row | undefined {
  let parsed = value
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed) as unknown } catch { return undefined }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  try {
    const prototype = Object.getPrototypeOf(parsed)
    return prototype === Object.prototype || prototype === null ? parsed as Row : undefined
  } catch { return undefined }
}

function exactObjectiveIntent(value: unknown): boolean {
  return validate(TurnIntentSchema, value)
    && !!value && typeof value === "object"
    && "kind" in value && value.kind === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.kind
    && "version" in value && value.version === OBJECTIVE_TASK_GRAPH_EXECUTION_INTENT.version
}

/** Separately fences footprint reads to server-owned, user-started objective v1 Turns. */
export function rootTaskHistoryFootprintOrigin(source: unknown, turnInput: unknown): string | undefined {
  if (source !== "user") return undefined
  const envelope = object(turnInput)
  if (!envelope) return undefined
  const nestedExists = Object.hasOwn(envelope, "input"), nested = nestedExists ? object(envelope.input) : undefined
  if (nestedExists && !nested) return undefined
  const copies = [envelope, ...(nested ? [nested] : [])].filter(value => Object.hasOwn(value, "intent"))
  if (!copies.length || !copies.every(value => exactObjectiveIntent(value.intent))) return undefined
  return FOOTPRINT_ORIGIN
}

export function isRootTaskHistoryFootprintOrigin(value: unknown): value is string {
  return value === FOOTPRINT_ORIGIN
}
