import {
  getValidator,
  type ValidationIssue,
  type ModelMessage,
} from "@jobcopilot/agent-protocol"
import { MODEL_SCHEMA_VERSION } from "../contracts.js"

export const NextStepSchema = {
  $id: "agent.model.next-step",
  oneOf: [
    {
      type: "object",
      properties: {
        schemaVersion: { const: MODEL_SCHEMA_VERSION },
        kind: { const: "call_tool" },
        callId: { type: "string", minLength: 1, maxLength: 256 },
        tool: { type: "string", minLength: 1, maxLength: 256 },
        arguments: { type: "object" },
        rationaleSummary: { type: "string", minLength: 1 },
      },
      required: ["schemaVersion", "kind", "callId", "tool", "arguments", "rationaleSummary"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: MODEL_SCHEMA_VERSION },
        kind: { const: "spawn_subagent" },
        contract: { type: "object" },
      },
      required: ["schemaVersion", "kind", "contract"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: MODEL_SCHEMA_VERSION },
        kind: { const: "send_message" },
        targetTaskId: { type: "string", minLength: 1, maxLength: 256 },
        message: { type: "object" },
      },
      required: ["schemaVersion", "kind", "targetTaskId", "message"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: MODEL_SCHEMA_VERSION },
        kind: { const: "wait" },
        taskIds: { type: "array", minItems: 1, items: { type: "string", minLength: 1, maxLength: 256 } },
        timeoutMs: { type: "integer", minimum: 1 },
      },
      required: ["schemaVersion", "kind", "taskIds", "timeoutMs"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: MODEL_SCHEMA_VERSION },
        kind: { const: "ask_user" },
        question: { type: "object" },
      },
      required: ["schemaVersion", "kind", "question"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: MODEL_SCHEMA_VERSION },
        kind: { const: "request_approval" },
        request: { type: "object" },
      },
      required: ["schemaVersion", "kind", "request"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: MODEL_SCHEMA_VERSION },
        kind: { const: "compact_context" },
        reason: { type: "string", minLength: 1 },
      },
      required: ["schemaVersion", "kind", "reason"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        schemaVersion: { const: MODEL_SCHEMA_VERSION },
        kind: { const: "finish" },
        response: { type: "object" },
      },
      required: ["schemaVersion", "kind", "response"],
      additionalProperties: false,
    },
  ],
} as const

const validateEnvelope = getValidator(NextStepSchema as unknown as Parameters<typeof getValidator>[0])

export const MAX_REPAIR_ATTEMPTS = 1

export type NextStep =
  | {
      schemaVersion: typeof MODEL_SCHEMA_VERSION
      kind: "call_tool"
      callId: string
      tool: string
      arguments: Record<string, unknown>
      rationaleSummary: string
    }
  | { schemaVersion: typeof MODEL_SCHEMA_VERSION; kind: "spawn_subagent"; contract: Record<string, unknown> }
  | { schemaVersion: typeof MODEL_SCHEMA_VERSION; kind: "send_message"; targetTaskId: string; message: Record<string, unknown> }
  | { schemaVersion: typeof MODEL_SCHEMA_VERSION; kind: "wait"; taskIds: string[]; timeoutMs: number }
  | { schemaVersion: typeof MODEL_SCHEMA_VERSION; kind: "ask_user"; question: Record<string, unknown> }
  | { schemaVersion: typeof MODEL_SCHEMA_VERSION; kind: "request_approval"; request: Record<string, unknown> }
  | { schemaVersion: typeof MODEL_SCHEMA_VERSION; kind: "compact_context"; reason: string }
  | { schemaVersion: typeof MODEL_SCHEMA_VERSION; kind: "finish"; response: Record<string, unknown> }

export type ToolArgumentsValidator = (call: Extract<NextStep, { kind: "call_tool" }>) => boolean | string | void

export interface NextStepRepairRequest {
  input: string
  issues: readonly NextStepIssue[]
  attempt: 1
  messages: readonly ModelMessage[]
}

export type NextStepRepair = (request: NextStepRepairRequest) => unknown | Promise<unknown>

export interface NextStepIssue {
  path: string
  keyword: string
  message: string
}

export interface NextStepValidationOptions {
  seenCallIds?: ReadonlySet<string>
  validateToolArguments?: ToolArgumentsValidator
}

export interface NextStepParseOptions extends NextStepValidationOptions {
  repair?: NextStepRepair
  messages?: readonly ModelMessage[]
}

export interface NextStepParseResult {
  step: NextStep
  repairAttempts: number
}

export class NextStepValidationError extends Error {
  readonly issues: readonly NextStepIssue[]
  readonly repairAttempts: number

  constructor(issues: readonly NextStepIssue[], repairAttempts: number) {
    super("Model output did not produce a valid NextStep")
    this.name = "NextStepValidationError"
    this.issues = issues
    this.repairAttempts = repairAttempts
  }
}

export function validateNextStep(value: unknown, options: NextStepValidationOptions = {}): NextStepIssue[] {
  if (!validateEnvelope(value)) return ajvIssues(validateEnvelope.errors)
  const step = value as NextStep
  if (step.kind !== "call_tool") return []
  const issues: NextStepIssue[] = []
  if (options.seenCallIds?.has(step.callId)) {
    issues.push({ path: "/callId", keyword: "unique", message: "callId has already been observed in this turn" })
  }
  if (options.validateToolArguments) {
    try {
      const validation = options.validateToolArguments(step)
      if (validation === false) issues.push({ path: "/arguments", keyword: "toolArguments", message: "tool arguments failed validation" })
      if (typeof validation === "string") issues.push({ path: "/arguments", keyword: "toolArguments", message: validation })
    } catch (error) {
      issues.push({ path: "/arguments", keyword: "toolArguments", message: error instanceof Error ? error.message : "tool arguments failed validation" })
    }
  }
  return issues
}

export async function parseNextStep(
  input: string | unknown,
  options: NextStepParseOptions = {},
): Promise<NextStepParseResult> {
  const originalText = typeof input === "string" ? input : JSON.stringify(input) ?? String(input)
  let parsed = parseAndValidate(input, options)
  let candidate = parsed.candidate
  let issues = parsed.issues
  if (issues.length === 0) return { step: candidate as NextStep, repairAttempts: 0 }
  if (!options.repair) throw new NextStepValidationError(issues, 0)

  let repaired: unknown
  try {
    repaired = await options.repair({
      input: originalText,
      issues,
      attempt: 1,
      messages: options.messages ?? [],
    })
  } catch (error) {
    throw new NextStepValidationError([
      ...issues,
      { path: "", keyword: "repair", message: error instanceof Error ? error.message : "NextStep repair failed" },
    ], MAX_REPAIR_ATTEMPTS)
  }
  parsed = parseAndValidate(repaired, options)
  candidate = parsed.candidate
  issues = parsed.issues
  if (issues.length > 0) throw new NextStepValidationError(issues, MAX_REPAIR_ATTEMPTS)
  return { step: candidate as NextStep, repairAttempts: MAX_REPAIR_ATTEMPTS }
}

function parseAndValidate(input: string | unknown, options: NextStepValidationOptions): { candidate: unknown; issues: NextStepIssue[] } {
  let candidate: unknown = input
  if (typeof input === "string") {
    try {
      candidate = JSON.parse(input) as unknown
    } catch {
      return { candidate: undefined, issues: [{ path: "", keyword: "json", message: "model output is not valid JSON" }] }
    }
  }
  return { candidate, issues: validateNextStep(candidate, options) }
}

function ajvIssues(errors: typeof validateEnvelope.errors): NextStepIssue[] {
  return (errors ?? []).map((error: ValidationIssue) => ({
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? "schema validation failed",
  }))
}
