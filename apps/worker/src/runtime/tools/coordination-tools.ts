import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import {
  executeCloseSubagent,
  executeInterruptSubagent,
  executeListSubagents,
  executeSendMessage,
  executeSpawn,
  executeWaitSubagents,
  type CoordinationExecutorOptions,
} from "./coordination-executors.js"
import type { RuntimeToolDefinition } from "./types.js"

const IdSchema = Type.String({ minLength: 1, maxLength: 256 })
const KeySchema = Type.String({ minLength: 1, maxLength: 256 })
const TextSchema = Type.String({ minLength: 1, maxLength: 4_000 })
const StringListSchema = Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 32 })
const StatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("retrying"), Type.Literal("waiting"),
  Type.Literal("waiting_for_user"), Type.Literal("completed"), Type.Literal("failed"),
  Type.Literal("interrupted"), Type.Literal("cancelled"), Type.Literal("closed"),
])

export const SpawnSubagentInputSchema = Type.Object({
  idempotencyKey: KeySchema,
  role: Type.String({ minLength: 1, maxLength: 64 }),
  taskType: Type.String({ minLength: 1, maxLength: 128 }),
  goal: TextSchema,
  constraints: Type.Optional(StringListSchema),
  successCriteria: Type.Optional(StringListSchema),
  allowedActions: Type.Optional(StringListSchema),
  context: Type.Optional(Type.Unknown()),
  expectedOutputSchema: Type.Optional(Type.Unknown()),
  parentTaskId: Type.Optional(IdSchema),
}, { additionalProperties: false })
export type SpawnSubagentInput = Static<typeof SpawnSubagentInputSchema>

export const SendMessageInputSchema = Type.Object({
  idempotencyKey: KeySchema,
  taskId: IdSchema,
  kind: Type.String({ minLength: 1, maxLength: 64 }),
  payload: Type.Unknown(),
}, { additionalProperties: false })
export type SendMessageInput = Static<typeof SendMessageInputSchema>

export const WaitSubagentsInputSchema = Type.Object({
  idempotencyKey: KeySchema,
  taskIds: Type.Array(IdSchema, { minItems: 1, maxItems: 50 }),
  mode: Type.Union([Type.Literal("any"), Type.Literal("all")]),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 30_000 }),
}, { additionalProperties: false })
export type WaitSubagentsInput = Static<typeof WaitSubagentsInputSchema>

export const ListSubagentsInputSchema = Type.Object({
  includeTerminal: Type.Optional(Type.Boolean()),
}, { additionalProperties: false })
export type ListSubagentsInput = Static<typeof ListSubagentsInputSchema>

export const InterruptSubagentInputSchema = Type.Object({
  taskId: IdSchema,
  reason: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false })
export type InterruptSubagentInput = Static<typeof InterruptSubagentInputSchema>

export const CloseSubagentInputSchema = Type.Object({ taskId: IdSchema }, { additionalProperties: false })
export type CloseSubagentInput = Static<typeof CloseSubagentInputSchema>

const SpawnOutputSchema = Type.Object({
  taskId: IdSchema, rootTaskId: IdSchema, parentTaskId: Type.Union([IdSchema, Type.Null()]),
  path: Type.String({ minLength: 1, maxLength: 2_048 }), depth: Type.Integer({ minimum: 0 }),
  status: StatusSchema, replay: Type.Boolean(),
}, { additionalProperties: false })
const SendOutputSchema = Type.Object({ taskId: IdSchema, messageId: IdSchema, status: Type.Union([Type.Literal("queued"), Type.Literal("duplicate")]) }, { additionalProperties: false })
const WaitOutputSchema = Type.Object({
  waitId: IdSchema, status: Type.Union([Type.Literal("waiting"), Type.Literal("ready"), Type.Literal("timed_out"), Type.Literal("interrupted"), Type.Literal("closed")]),
  taskIds: Type.Array(IdSchema), deadlineAt: Type.String(), matchedTaskIds: Type.Array(IdSchema),
}, { additionalProperties: false })
const TaskOutputSchema = Type.Object({
  taskId: IdSchema, rootTaskId: IdSchema, parentTaskId: Type.Union([IdSchema, Type.Null()]),
  path: Type.String({ minLength: 1, maxLength: 2_048 }), depth: Type.Integer({ minimum: 0 }),
  role: Type.String(), taskType: Type.String(), status: StatusSchema,
  attemptCount: Type.Integer({ minimum: 0 }), maxAttempts: Type.Integer({ minimum: 1 }),
  leaseExpiresAt: Type.Union([Type.String(), Type.Null()]), interruptRequestedAt: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false })
const ListOutputSchema = Type.Object({ tasks: Type.Array(TaskOutputSchema, { maxItems: 50 }) }, { additionalProperties: false })
const InterruptOutputSchema = Type.Object({
  taskId: IdSchema, rootTaskId: IdSchema, status: Type.Literal("interrupt_requested"),
  affectedCount: Type.Integer({ minimum: 0 }), reason: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false })
const CloseOutputSchema = Type.Object({
  taskId: IdSchema, status: StatusSchema, closed: Type.Boolean(),
}, { additionalProperties: false })

function metadata(name: string, description: string, risk: "read" | "internal_write", idempotency: "read_only" | "idempotent" | "requires_key"): Pick<RuntimeToolDefinition, "schemaVersion" | "name" | "version" | "description" | "capabilities" | "risk" | "domain" | "idempotency" | "timeoutMs" | "requiredCapabilities"> {
  return {
    schemaVersion, name, version: "1", description,
    capabilities: risk === "read" ? ["read", "coordination"] : ["coordination"],
    risk, domain: "coordination", idempotency, timeoutMs: 30_000, requiredCapabilities: ["canManageChildren"],
  }
}

export function createCoordinationTools(options: CoordinationExecutorOptions): RuntimeToolDefinition[] {
  return [
    {
      ...metadata("spawn_subagent", "Create one permission-scoped child task and durably enqueue it", "internal_write", "requires_key"),
      inputSchema: SpawnSubagentInputSchema, outputSchema: SpawnOutputSchema,
      execute: (context, input) => executeSpawn(context, input as SpawnSubagentInput, options),
    },
    {
      ...metadata("send_message", "Send one idempotent mailbox message to a visible subagent", "internal_write", "requires_key"),
      inputSchema: SendMessageInputSchema, outputSchema: SendOutputSchema,
      execute: (context, input) => executeSendMessage(context, input as SendMessageInput, options),
    },
    {
      ...metadata("wait_subagents", "Durably wait for visible subagent results through the AH2-025 adapter", "internal_write", "requires_key"),
      inputSchema: WaitSubagentsInputSchema, outputSchema: WaitOutputSchema,
      execute: (context, input) => executeWaitSubagents(context, input as WaitSubagentsInput, options),
    },
    {
      ...metadata("list_subagents", "List visible tasks in the current session and task tree", "read", "read_only"),
      inputSchema: ListSubagentsInputSchema, outputSchema: ListOutputSchema,
      execute: (context, input) => executeListSubagents(context, input as ListSubagentsInput, options),
    },
    {
      ...metadata("interrupt_subagent", "Request interruption of a visible task tree", "internal_write", "idempotent"),
      inputSchema: InterruptSubagentInputSchema, outputSchema: InterruptOutputSchema,
      execute: (context, input) => executeInterruptSubagent(context, input as InterruptSubagentInput, options),
    },
    {
      ...metadata("close_subagent", "Close a visible non-running task", "internal_write", "idempotent"),
      inputSchema: CloseSubagentInputSchema, outputSchema: CloseOutputSchema,
      execute: (context, input) => executeCloseSubagent(context, input as CloseSubagentInput, options),
    },
  ]
}
