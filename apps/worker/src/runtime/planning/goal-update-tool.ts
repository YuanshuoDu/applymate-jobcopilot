import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import { ToolExecutionError, type RuntimeToolDefinition } from "../tools/types.js"
import { isPlainJsonObject, MAX_GOAL_REVISIONS, normalizeGoalContract, type GoalContract } from "./goal-plan-contract.js"

const Text = Type.String({ minLength: 1, maxLength: 4_000 })
const List = Type.Array(Type.String({ minLength: 1, maxLength: 1_000 }), { maxItems: 32 })
const ChangesSchema = Type.Object({
  objective: Type.Optional(Text), constraints: Type.Optional(List), successCriteria: Type.Optional(List),
  knownFacts: Type.Optional(List), unresolvedQuestions: Type.Optional(List), approvalBoundaries: Type.Optional(List),
}, { additionalProperties: false, minProperties: 1 })
const GoalUpdateInputSchema = Type.Object({ changes: ChangesSchema }, { additionalProperties: false })
const GoalUpdateOutputSchema = Type.Object({
  status: Type.Literal("accepted"), goalRevision: Type.Integer({ minimum: 2 }), basedOnGoalRevision: Type.Integer({ minimum: 1 }), goalContract: Type.Unknown(),
}, { additionalProperties: false })

export type GoalUpdateInput = Static<typeof GoalUpdateInputSchema>
export type GoalUpdateToolOptions = { readonly goal: GoalContract }
type ChangeKey = keyof GoalUpdateInput["changes"]
const CHANGE_KEYS: readonly ChangeKey[] = ["objective", "constraints", "successCriteria", "knownFacts", "unresolvedQuestions", "approvalBoundaries"]

function boundedIssues(error: unknown): readonly { path: string; code: string; message: string }[] {
  const issues = error && typeof error === "object" && "issues" in error && Array.isArray(error.issues) ? error.issues : []
  return issues.slice(0, 16).flatMap(issue => {
    if (!issue || typeof issue !== "object") return []
    const row = issue as Record<string, unknown>
    return typeof row.path === "string" && typeof row.code === "string" && typeof row.message === "string"
      ? [{ path: row.path.slice(0, 256), code: row.code.slice(0, 64), message: row.message.slice(0, 256) }] : []
  })
}

export function createGoalUpdateTool(options: GoalUpdateToolOptions): RuntimeToolDefinition<GoalUpdateInput, { readonly status: "accepted"; readonly goalRevision: number; readonly basedOnGoalRevision: number; readonly goalContract: GoalContract }> {
  let current = normalizeGoalContract(options.goal)
  if (current.budgetRef !== "runtime:turn") throw new TypeError("Goal update budget reference is server-owned")
  if (current.revision > MAX_GOAL_REVISIONS) throw new TypeError("Goal update revision is above the server limit")
  return {
    schemaVersion, name: "agent.goal.update", version: "1", description: "Update the server-owned semantic goal contract",
    capabilities: ["coordination"], inputSchema: GoalUpdateInputSchema, outputSchema: GoalUpdateOutputSchema,
    risk: "internal_write", domain: "coordination", idempotency: "idempotent", timeoutMs: 10_000, requiredCapabilities: ["canPlan"],
    execute: async (_context, input) => {
      try {
        if (!isPlainJsonObject(input) || !Object.prototype.hasOwnProperty.call(input, "changes") || Object.keys(input).some(key => key !== "changes") || !isPlainJsonObject(input.changes)) throw new Error("invalid_goal_update")
        const changes = input.changes
        const keys = Object.keys(changes)
        if (keys.length === 0 || keys.some(key => !(CHANGE_KEYS as readonly string[]).includes(key))) throw new Error("invalid_goal_update")
        const merged: Record<string, unknown> = { ...current, revision: current.revision + 1, budgetRef: "runtime:turn" }
        if (current.revision >= MAX_GOAL_REVISIONS) throw new ToolExecutionError("goal_revision_limit", "Goal revision limit reached", { maxGoalRevisions: MAX_GOAL_REVISIONS })
        for (const key of CHANGE_KEYS) if (Object.prototype.hasOwnProperty.call(changes, key)) merged[key] = changes[key]
        const next = normalizeGoalContract(merged)
        if (next.revision !== current.revision + 1 || next.budgetRef !== "runtime:turn") throw new Error("invalid_goal_update")
        const basedOnGoalRevision = current.revision
        current = next
        return { status: "accepted" as const, goalRevision: next.revision, basedOnGoalRevision, goalContract: next }
      } catch (error: unknown) {
        if (error instanceof ToolExecutionError) throw error
        throw new ToolExecutionError("goal_update_invalid", "Goal update was rejected", { issues: boundedIssues(error) })
      }
    },
  }
}
