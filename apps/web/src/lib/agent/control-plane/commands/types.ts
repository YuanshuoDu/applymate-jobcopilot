import type { InputContentPart, TurnSource } from "@jobcopilot/agent-protocol"

export const COMMAND_DISPOSITIONS = [
  "started",
  "steered",
  "queued_follow_up",
  "duplicate",
] as const

export type CommandDisposition = (typeof COMMAND_DISPOSITIONS)[number]
export type InterruptDisposition = "interrupted" | "duplicate"

export interface CommandIdentity {
  sessionId: string
  userId: string
  clientMessageId: string
  source: TurnSource
}

/** Server-validated scope for the one-job preparation entry point. */
export interface SelectedJobPreparationScope {
  jobId: string
}

export const OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION = "agent-harness.v2.objective-requirements.v1" as const

export type ObjectiveVerificationRequirementKind = "candidate_count_gte" | "finding_count_gte"

export type ObjectiveVerificationRequirements = Readonly<{
  schemaVersion: typeof OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION
  requirements: readonly Readonly<{
    id: string
    check: Readonly<{ kind: ObjectiveVerificationRequirementKind; minimum: number }>
  }>[]
}>

const OBJECTIVE_REQUIREMENT_ID = /^[a-z][a-z0-9._-]{0,63}$/

function exactDataRecord(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null
  try {
    if (Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const ownKeys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    if ((prototype !== Object.prototype && prototype !== null) || ownKeys.length !== keys.length ||
        ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))) return null
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const key of keys) {
      const descriptor = descriptors[key]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
      result[key] = descriptor.value
    }
    return result
  } catch {
    return null
  }
}

function denseRequirements(value: unknown): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const ownKeys = Reflect.ownKeys(value)
    const descriptors = Object.getOwnPropertyDescriptors(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
    const length = lengthDescriptor && "value" in lengthDescriptor ? lengthDescriptor.value : null
    if (!Number.isSafeInteger(length) || Number(length) < 1 || Number(length) > 8 || ownKeys.length !== Number(length) + 1 ||
        ownKeys.some((key) => typeof key !== "string" ||
          (key !== "length" && (!/^\d+$/.test(key) || String(Number(key)) !== key || Number(key) >= Number(length))))) return null
    const rows: unknown[] = []
    for (let index = 0; index < Number(length); index += 1) {
      const descriptor = descriptors[String(index)]
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null
      rows.push(descriptor.value)
    }
    return rows
  } catch {
    return null
  }
}

/** Parses only the fixed user-intent subset; malformed values never escape this boundary. */
export function parseObjectiveVerificationRequirements(value: unknown): ObjectiveVerificationRequirements | null {
  const block = exactDataRecord(value, ["schemaVersion", "requirements"])
  if (!block || block.schemaVersion !== OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION) return null
  const rows = denseRequirements(block.requirements)
  if (!rows) return null
  const ids = new Set<string>()
  const requirements: ObjectiveVerificationRequirements["requirements"][number][] = []
  for (const row of rows) {
    const entry = exactDataRecord(row, ["id", "check"])
    if (!entry || typeof entry.id !== "string" || !OBJECTIVE_REQUIREMENT_ID.test(entry.id) || ids.has(entry.id)) return null
    const check = exactDataRecord(entry.check, ["kind", "minimum"])
    if (!check || (check.kind !== "candidate_count_gte" && check.kind !== "finding_count_gte") ||
        !Number.isSafeInteger(check.minimum) || Number(check.minimum) < 1 || Number(check.minimum) > 50) return null
    ids.add(entry.id)
    requirements.push({ id: entry.id, check: { kind: check.kind, minimum: Number(check.minimum) } })
  }
  return Object.freeze({
    schemaVersion: OBJECTIVE_VERIFICATION_REQUIREMENTS_SCHEMA_VERSION,
    requirements: Object.freeze(requirements.map((entry) => Object.freeze({
      ...entry,
      check: Object.freeze({ ...entry.check }),
    }))),
  })
}

export interface StartCommand extends CommandIdentity {
  content: InputContentPart[]
  intent?: ServerAgentTurnIntent
}

/** User-only fresh root whose immutable goal is separate from its reference content. */
export interface ObjectiveStartCommand extends CommandIdentity {
  objective: string
  content: InputContentPart[]
  verificationRequirements?: ObjectiveVerificationRequirements | null
}

/** Server-owned intent metadata persisted with the root Turn input envelope. */
export interface ServerAgentTurnIntent {
  kind: "interactive_discovery_shortlist"
  version: 1
}

export interface MessageCommand extends CommandIdentity {
  content: InputContentPart[]
  delivery: "steer" | "follow_up"
  expectedTurnId?: string | null
  expectedRevision?: number | null
  selectedJobPreparation?: SelectedJobPreparationScope
}

/** User-only action that atomically interrupts one objective and starts its successor. */
export interface ReplaceObjectiveCommand extends CommandIdentity {
  content: InputContentPart[]
  expectedTurnId: string
  expectedRevision: number
}

export interface SteerCommand extends CommandIdentity {
  content: InputContentPart[]
  expectedTurnId: string | null
  expectedRevision?: number | null
}

export interface InterruptCommand extends CommandIdentity {
  expectedTurnId: string | null
  expectedRevision?: number | null
}

export interface RetryCommand extends CommandIdentity {
  targetTurnId: string
  expectedRevision?: number | null
}

export interface ForkCommand extends CommandIdentity {
  lastTurnId: string
  editContent?: InputContentPart[]
}

export interface CommandResult {
  inputId: string
  turnId: string
  disposition: CommandDisposition
  originalDisposition?: Exclude<CommandDisposition, "duplicate">
  sequence: string
}

export interface ObjectiveStartResult {
  inputId: string
  turnId: string
  disposition: "started" | "duplicate"
  originalDisposition?: Exclude<CommandDisposition, "duplicate">
  sequence: string
}

export interface InterruptResult {
  inputId: string
  turnId: string
  disposition: InterruptDisposition
  originalDisposition?: "interrupted"
  sequence: string
}

export interface ForkResult {
  sessionId: string
  turnId: string
  lastTurnId: string
  disposition: "forked" | "duplicate"
}
