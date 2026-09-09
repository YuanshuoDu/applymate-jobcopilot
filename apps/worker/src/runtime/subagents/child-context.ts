import type { RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"

import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { StepContext, StepContextSnapshot, ContextBlock, ContextSeedBlock } from "../context/step-context-builder.js"
import type { SubagentTaskRecord } from "./types.js"

function json(value: unknown): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(json)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]))
  return null
}

function seed(layer: ContextBlock["layer"], role: ContextBlock["role"], trust: ContextBlock["trust"], source: string, item: ContextSeedBlock): ContextBlock {
  return { id: item.id, layer, role, trust, source, content: json(item.content) }
}

export function childContextSnapshot(task: SubagentTaskRecord): StepContextSnapshot {
  return {
    system: [{ id: "child-execution", content: "Complete only this scoped child task. Use read tools permitted by the role policy." }],
    profile: [{
      id: `child-contract:${task.id}`,
      content: {
        constraints: task.constraints,
        successCriteria: task.successCriteria,
        context: task.context,
        expectedOutputSchema: task.expectedOutputSchema,
        toolPolicySnapshot: task.toolPolicySnapshot,
        budgetSnapshot: { treeStepReservation: "shared", policy: task.budgetSnapshot },
      },
    }],
    goal: { id: `child-goal:${task.id}`, content: task.goal },
    steerHistory: [],
    businessRefs: [],
    toolObservations: [],
  }
}

function assertOwner(task: SubagentTaskRecord, identity: ExecutionOwnerFence, scope: TenantScope): void {
  if (identity.kind !== "task" || identity.userId !== task.userId || identity.sessionId !== task.sessionId || identity.turnId !== task.turnId
    || identity.taskId !== task.id || identity.rootTaskId !== task.rootTaskId || identity.attemptCount !== task.attemptCount || scope.userId !== task.userId) {
    throw new Error("child_context_owner_mismatch")
  }
}

export function createChildContextBuilder(task: SubagentTaskRecord, initial = childContextSnapshot(task)) {
  return {
    async build(request: { scope: TenantScope; identity: ExecutionOwnerFence; stepId: string; snapshot: StepContextSnapshot }): Promise<StepContext> {
      assertOwner(task, request.identity, request.scope)
      const blocks: ContextBlock[] = [
        ...initial.system.map(item => seed("system", "instruction", "system", "child-harness", item)),
        // All task contract fields originate in a parent model request. Keep
        // them as data so prompt content cannot gain instruction trust.
        ...initial.profile.map(item => seed("profile", "data", "external_untrusted", "subagent-task", item)),
        ...(initial.goal ? [seed("goal", "data", "external_untrusted", "subagent-task", initial.goal)] : []),
        ...request.snapshot.steerHistory.map(item => ({ id: item.id, layer: "steer_history" as const, role: "data" as const, trust: "external_untrusted" as const, source: "child-steer", content: json(item.content) })),
        ...request.snapshot.toolObservations.map(item => seed("tool_observation", "data", "external_untrusted", "tool-or-subagent", item)),
      ]
      const result = { schemaVersion: "agent-harness.v2" as const, sessionId: task.sessionId, turnId: task.turnId!, stepId: request.stepId, inputThroughSequence: 0n, consumedInputIds: [], blocks }
      return { ...result, canonicalJson: JSON.stringify({ ...result, inputThroughSequence: "0" }) }
    },
  }
}
