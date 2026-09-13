import type { RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"

import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { StepContext, StepContextSnapshot, ContextBlock, ContextSeedBlock } from "../context/step-context-builder.js"
import type { CoordinationMailboxMessage } from "../tools/coordination-types.js"
import type { SubagentTaskRecord } from "./types.js"

const CHILD_MAILBOX_READ_LIMIT = 20

/** The child context only needs the server-owned pending-read capability. */
export type ChildMailboxReader = {
  readonly listPendingMessages: (input: {
    readonly userId: string
    readonly sessionId: string
    readonly toTaskId: string
    readonly limit: number
  }) => Promise<readonly CoordinationMailboxMessage[]>
}

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

function mailboxDate(value: Date | null): string | null {
  return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null
}

function mailboxBlock(message: CoordinationMailboxMessage): ContextBlock {
  return seed("pending_input", "data", "external_untrusted", "subagent-mailbox", {
    id: `mailbox:${message.id}`,
    content: {
      messageId: message.id,
      sessionId: message.sessionId,
      turnId: message.turnId,
      fromTaskId: message.fromTaskId,
      toTaskId: message.toTaskId,
      kind: message.kind,
      payload: json(message.payload),
      idempotencyKey: message.idempotencyKey,
      createdAt: mailboxDate(message.createdAt),
      deliveredAt: mailboxDate(message.deliveredAt),
      consumedAt: mailboxDate(message.consumedAt),
    },
  })
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

export function createChildContextBuilder(task: SubagentTaskRecord, initial = childContextSnapshot(task), mailboxReader?: ChildMailboxReader) {
  return {
    async build(request: { scope: TenantScope; identity: ExecutionOwnerFence; stepId: string; snapshot: StepContextSnapshot }): Promise<StepContext> {
      assertOwner(task, request.identity, request.scope)
      const pendingMessages = mailboxReader
        ? await mailboxReader.listPendingMessages({ userId: task.userId, sessionId: task.sessionId, toTaskId: task.id, limit: CHILD_MAILBOX_READ_LIMIT })
        : []
      const blocks: ContextBlock[] = [
        ...initial.system.map(item => seed("system", "instruction", "system", "child-harness", item)),
        // All task contract fields originate in a parent model request. Keep
        // them as data so prompt content cannot gain instruction trust.
        ...initial.profile.map(item => seed("profile", "data", "external_untrusted", "subagent-task", item)),
        ...(initial.goal ? [seed("goal", "data", "external_untrusted", "subagent-task", initial.goal)] : []),
        ...request.snapshot.steerHistory.map(item => ({ id: item.id, layer: "steer_history" as const, role: "data" as const, trust: "external_untrusted" as const, source: "child-steer", content: json(item.content) })),
        ...request.snapshot.toolObservations.map(item => seed("tool_observation", "data", "external_untrusted", "tool-or-subagent", item)),
        ...pendingMessages.map(mailboxBlock),
      ]
      const result = { schemaVersion: "agent-harness.v2" as const, sessionId: task.sessionId, turnId: task.turnId!, stepId: request.stepId, inputThroughSequence: 0n, consumedInputIds: [], blocks }
      return { ...result, canonicalJson: JSON.stringify({ ...result, inputThroughSequence: "0" }) }
    },
  }
}
