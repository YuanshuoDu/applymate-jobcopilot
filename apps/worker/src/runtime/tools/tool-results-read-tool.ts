import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import type { ExecutionOwner } from "../execution-owner.js"
import { ToolExecutionError, type RuntimeToolDefinition, type ToolExecutionContext } from "./types.js"
import type { ToolResultChunk, ToolResultReferenceRepository } from "./tool-result-reference-types.js"

export const ToolResultsReadInputSchema = Type.Object({
  referenceId: Type.String({ minLength: 1, maxLength: 256 }),
  cursor: Type.Optional(Type.String({ maxLength: 32, pattern: "^(0|[1-9][0-9]*)$" })),
}, { additionalProperties: false })
export type ToolResultsReadInput = Static<typeof ToolResultsReadInputSchema>

const ToolResultsReadOutputSchema = Type.Object({
  ref: Type.String({ minLength: 1, maxLength: 256 }),
  sha256: Type.String({ pattern: "^[0-9a-f]{64}$" }),
  byteCount: Type.Integer({ minimum: 0, maximum: 1024 * 1024 }),
  chunk: Type.String(),
  nextCursor: Type.Union([Type.String({ pattern: "^(0|[1-9][0-9]*)$" }), Type.Null()]),
}, { additionalProperties: false })

export type ToolResultOwnerResolver = (context: ToolExecutionContext) => ExecutionOwner

export function createToolResultsReadTool(
  repository: ToolResultReferenceRepository,
  resolveOwner: ToolResultOwnerResolver,
): RuntimeToolDefinition<ToolResultsReadInput, ToolResultChunk> {
  return {
    schemaVersion,
    name: "tool_results.read",
    version: "1",
    description: "Read a bounded UTF-8 chunk from a private durable tool result",
    capabilities: ["read"],
    inputSchema: ToolResultsReadInputSchema,
    outputSchema: ToolResultsReadOutputSchema,
    risk: "read",
    domain: "coordination",
    idempotency: "read_only",
    timeoutMs: 10_000,
    requiredCapabilities: [],
    execute: async (context, input) => {
      try {
        const owner = resolveOwner(context)
        const result = await repository.read(owner, input)
        if (!result) throw new ToolExecutionError("tool_result_not_found", "Tool result is unavailable")
        return result
      } catch (error) {
        if (error instanceof ToolExecutionError) throw error
        const code = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "tool_result_unavailable"
        throw new ToolExecutionError(code, "Tool result is unavailable")
      }
    },
  }
}
