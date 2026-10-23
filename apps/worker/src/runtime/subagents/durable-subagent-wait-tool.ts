import { schemaVersion } from "@jobcopilot/agent-protocol"
import { Type } from "@sinclair/typebox"
import type pg from "pg"

import type { RuntimeToolDefinition, ToolExecutionContext } from "../tools/types.js"
import { registerDurableSubagentWait, type DurableSubagentWaitResult } from "./durable-subagent-wait-store.js"
import type { SubagentLease } from "./types.js"

const IdSchema = Type.String({ minLength: 1, maxLength: 256 })
const MAX_WAIT_TARGETS = 8

export const DurableSubagentWaitInputSchema = Type.Object({
  idempotencyKey: IdSchema,
  taskIds: Type.Array(IdSchema, { minItems: 1, maxItems: MAX_WAIT_TARGETS }),
  mode: Type.Union([Type.Literal("any"), Type.Literal("all")]),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 30_000 }),
}, { additionalProperties: false })

const ChildStatusSchema = Type.Union([
  Type.Literal("queued"), Type.Literal("running"), Type.Literal("retrying"), Type.Literal("waiting"),
  Type.Literal("waiting_for_user"), Type.Literal("completed"), Type.Literal("passed"), Type.Literal("failed"), Type.Literal("interrupted"),
  Type.Literal("cancelled"), Type.Literal("closed"),
])

export const DurableSubagentWaitOutputSchema = Type.Object({
  waitId: IdSchema,
  status: Type.Union([Type.Literal("waiting"), Type.Literal("ready"), Type.Literal("timed_out")]),
  taskIds: Type.Array(IdSchema, { maxItems: MAX_WAIT_TARGETS }),
  deadlineAt: Type.String({ minLength: 1, maxLength: 64 }),
  matchedTaskIds: Type.Array(IdSchema, { maxItems: MAX_WAIT_TARGETS }),
  tasks: Type.Array(Type.Object({
    taskId: IdSchema,
    status: ChildStatusSchema,
    role: Type.String({ minLength: 1, maxLength: 256 }),
    result: Type.Unknown(),
    failureReason: Type.Union([Type.String({ maxLength: 500 }), Type.Null()]),
  }, { additionalProperties: false }), { maxItems: MAX_WAIT_TARGETS }),
}, { additionalProperties: false })

type WaitInput = {
  readonly idempotencyKey: string
  readonly taskIds: readonly string[]
  readonly mode: "any" | "all"
  readonly timeoutMs: number
}

function parseWaitInput(value: unknown): WaitInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("wait_invalid")
  const input = value as Record<string, unknown>
  const keys = Object.keys(input).sort().join(",")
  if (keys !== "idempotencyKey,mode,taskIds,timeoutMs"
    || typeof input.idempotencyKey !== "string" || input.idempotencyKey.length < 1 || input.idempotencyKey.length > 256
    || !Array.isArray(input.taskIds)
    || (input.mode !== "any" && input.mode !== "all")
    || !Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) < 1 || Number(input.timeoutMs) > 30_000) {
    throw new Error("wait_invalid")
  }
  const taskIds: string[] = []
  for (const id of input.taskIds as readonly unknown[]) {
    if (typeof id !== "string" || id.length < 1 || id.length > 256 || taskIds.length === MAX_WAIT_TARGETS) throw new Error("wait_invalid")
    taskIds.push(id)
  }
  if (taskIds.length === 0) throw new Error("wait_invalid")
  return { idempotencyKey: input.idempotencyKey, taskIds, mode: input.mode, timeoutMs: Number(input.timeoutMs) }
}

/** The only child coordination definition: its lease is closed over by the server. */
export function createDurableSubagentWaitTool(pool: Pick<pg.Pool, "connect">, lease: SubagentLease): RuntimeToolDefinition {
  return {
    schemaVersion,
    name: "wait_subagents",
    version: "1",
    description: "Durably wait for direct child task results and resume this child when the wait resolves.",
    capabilities: ["coordination"],
    inputSchema: DurableSubagentWaitInputSchema,
    outputSchema: DurableSubagentWaitOutputSchema,
    risk: "internal_write",
    domain: "coordination",
    idempotency: "requires_key",
    timeoutMs: 30_000,
    requiredCapabilities: [],
    execute: (context: ToolExecutionContext, input: unknown) => executeDurableSubagentWait(pool, lease, context, parseWaitInput(input)),
  }
}

async function executeDurableSubagentWait(
  pool: Pick<pg.Pool, "connect">,
  lease: SubagentLease,
  context: ToolExecutionContext,
  input: WaitInput,
): Promise<DurableSubagentWaitResult> {
  return registerDurableSubagentWait(pool, {
    lease,
    stepId: context.stepId,
    idempotencyKey: input.idempotencyKey,
    targetTaskIds: input.taskIds,
    mode: input.mode,
    timeoutMs: input.timeoutMs,
  })
}
