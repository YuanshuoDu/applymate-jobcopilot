import type { RepositoryJsonValue, TenantScope } from "@jobcopilot/agent-protocol"
import { Buffer } from "node:buffer"

import type { ExecutionOwnerFence } from "../execution-owner.js"
import type { StepContext, StepContextSnapshot, ContextBlock, ContextSeedBlock } from "../context/step-context-builder.js"
import type { CoordinationMailboxMessage } from "../tools/coordination-types.js"
import { getSubagentRolePolicy } from "./role-policy.js"
import type { SubagentTaskRecord } from "./types.js"

const CHILD_MAILBOX_READ_LIMIT = 20
/** Maximum UTF-8 size of a normalized mailbox payload before it is summarized. */
export const CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT = 8 * 1024

/** The child context only needs the server-owned pending-read capability. */
export type ChildMailboxHydrationInput = {
  readonly userId: string
  readonly sessionId: string
  readonly turnId: string
  readonly rootTaskId: string
  readonly toTaskId: string
  readonly ownerId: string
  readonly attemptCount: number
  readonly stepId: string
  readonly limit: number
}

export type ChildMailboxReader = {
  readonly listPendingMessages: (input: {
    readonly userId: string
    readonly sessionId: string
    readonly toTaskId: string
    readonly limit: number
  }) => Promise<readonly CoordinationMailboxMessage[]>
  readonly hydrateMessages?: (input: ChildMailboxHydrationInput) => Promise<readonly CoordinationMailboxMessage[]>
}

export type ChildContextBuilder = {
  build(request: { scope: TenantScope; identity: ExecutionOwnerFence; stepId: string; snapshot: StepContextSnapshot }): Promise<StepContext>
  getMailboxMessageIds(): readonly string[]
}

function json(value: unknown): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (Array.isArray(value)) return value.map(json)
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined).map(([key, child]) => [key, json(child)]))
  return null
}

/**
 * Normalizes a mailbox payload before measuring it. Sorting keys makes the
 * encoded form stable, while the path set turns cyclic input into safe JSON.
 */
function mailboxJson(value: unknown, path = new Set<object>()): RepositoryJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") return Number.isFinite(value) ? value : null
  if (!value || typeof value !== "object") return null
  if (path.has(value)) return null
  path.add(value)
  try {
    if (Array.isArray(value)) return value.map(child => mailboxJson(child, path))
    const record = value as Record<string, unknown>
    return Object.fromEntries(Object.keys(record).sort().flatMap(key => {
      const child = record[key]
      return child === undefined ? [] : [[key, mailboxJson(child, path)]]
    }))
  } finally {
    path.delete(value)
  }
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return ""
  let bytes = 0
  let prefix = ""
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8")
    if (bytes + characterBytes > maxBytes) break
    prefix += character
    bytes += characterBytes
  }
  return prefix
}

function boundedMailboxPayload(value: unknown): RepositoryJsonValue {
  const normalized = mailboxJson(value)
  const encoded = JSON.stringify(normalized)
  const byteLength = Buffer.byteLength(encoded, "utf8")
  if (byteLength <= CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT) return normalized
  return {
    truncated: true,
    byteLength,
    preview: utf8Prefix(encoded, CHILD_MAILBOX_PAYLOAD_BYTE_LIMIT),
  }
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
      payload: boundedMailboxPayload(message.payload),
      idempotencyKey: message.idempotencyKey,
      createdAt: mailboxDate(message.createdAt),
      deliveredAt: mailboxDate(message.deliveredAt),
      consumedAt: mailboxDate(message.consumedAt),
    },
  })
}

function mailboxMetadataBlock(cachedMessageCount: number, omittedMessageCount: number): ContextBlock {
  return seed("pending_input", "data", "external_untrusted", "subagent-mailbox", {
    id: "mailbox:metadata",
    content: {
      cachedMessageCount,
      maxCachedMessageCount: CHILD_MAILBOX_READ_LIMIT,
      omittedMessageCount,
      omittedMessageCountScope: "max_per_read",
    },
  })
}

function copyBlock(block: ContextBlock): ContextBlock {
  return { ...block, content: json(block.content) }
}

const ROLE_GUIDANCE: ReadonlyMap<string, string> = new Map([
  ["scout", "Read job data and report evidence only; do not write, submit, send, or manage children."],
  ["analyst", "Read permitted job, persona, and resume data and analyze evidence only; do not write, submit, send, or manage children."],
  ["writer", "Read permitted resume data and create drafts only; do not perform external writes, submit, send, or manage children."],
  ["reviewer", "Read permitted artifacts and evidence and review them only; do not create drafts, submit, send, or manage children."],
  ["auditor", "Read permitted records and produce redacted audit evidence only; do not mutate, submit, send, or manage children."],
  ["executor", "Read permitted application state and run preflight checks only; do not execute external actions, submit, send, or manage children."],
])

function roleGuidance(role: string): string {
  return ROLE_GUIDANCE.get(role) ?? "No server-owned capability contract exists for this role; do not execute tools."
}

function roleContract(task: SubagentTaskRecord): Record<string, unknown> {
  // Guard before consulting the policy object: its legacy lookup must not
  // treat prototype names such as "constructor" as known roles.
  const policy = ROLE_GUIDANCE.has(task.role) ? getSubagentRolePolicy(task.role) : null
  return {
    role: task.role,
    taskType: task.taskType,
    capabilities: policy ? [...policy.capabilities] : [],
    guidance: roleGuidance(task.role),
    externalWritesEnabled: policy?.externalWritesEnabled ?? false,
    canManageChildren: policy?.canManageChildren ?? false,
  }
}

export function childContextSnapshot(task: SubagentTaskRecord): StepContextSnapshot {
  return {
    system: [{ id: "child-execution", content: "Complete only this scoped child task. Use the server-owned role/taskType capability contract in the profile to choose work; runtime-published tools and router policy are authoritative for access." }],
    profile: [{
      id: `child-contract:${task.id}`,
      content: {
        role: task.role,
        taskType: task.taskType,
        roleContract: roleContract(task),
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
    || identity.taskId !== task.id || identity.rootTaskId !== task.rootTaskId || identity.ownerId !== task.leaseOwner
    || identity.attemptCount !== task.attemptCount || task.status !== "running" || task.interruptRequestedAt !== null
    || scope.userId !== task.userId) {
    throw new Error("child_context_owner_mismatch")
  }
}

export function createChildContextBuilder(task: SubagentTaskRecord, initial = childContextSnapshot(task), mailboxReader?: ChildMailboxReader): ChildContextBuilder {
  // Keep the first normalized block for each id. A Map preserves first-read
  // order and prevents later reads from replacing an already visible payload.
  const mailboxBlocks = new Map<string, ContextBlock>()
  // This is the largest number of distinct valid rows omitted by one read.
  // It reports the bounded overflow without retaining an unbounded id set.
  let omittedMessageCount = 0
  return {
    async build(request: { scope: TenantScope; identity: ExecutionOwnerFence; stepId: string; snapshot: StepContextSnapshot }): Promise<StepContext> {
      assertOwner(task, request.identity, request.scope)
      if (request.identity.kind !== "task") throw new Error("child_context_owner_mismatch")
      const pendingMessages = mailboxReader?.hydrateMessages
        ? await mailboxReader.hydrateMessages({
          userId: task.userId, sessionId: task.sessionId, turnId: task.turnId!, rootTaskId: task.rootTaskId, toTaskId: task.id,
          ownerId: request.identity.ownerId, attemptCount: request.identity.attemptCount, stepId: request.stepId, limit: CHILD_MAILBOX_READ_LIMIT,
        })
        : mailboxReader
          ? await mailboxReader.listPendingMessages({ userId: task.userId, sessionId: task.sessionId, toTaskId: task.id, limit: CHILD_MAILBOX_READ_LIMIT })
          : []
      const scopedMessages = pendingMessages.filter(message => typeof message.id === "string" && message.id.length > 0
        && message.sessionId === task.sessionId && message.turnId === task.turnId && message.toTaskId === task.id)
      const seenThisBuild = new Set<string>()
      let omittedThisBuild = 0
      for (const message of scopedMessages) {
        if (seenThisBuild.has(message.id) || mailboxBlocks.has(message.id)) continue
        seenThisBuild.add(message.id)
        if (mailboxBlocks.size >= CHILD_MAILBOX_READ_LIMIT) {
          omittedThisBuild += 1
          continue
        }
        mailboxBlocks.set(message.id, mailboxBlock(message))
      }
      omittedMessageCount = Math.max(omittedMessageCount, omittedThisBuild)
      const cachedMailboxBlocks = [...mailboxBlocks.values()].map(copyBlock)
      if (omittedMessageCount > 0) cachedMailboxBlocks.push(mailboxMetadataBlock(mailboxBlocks.size, omittedMessageCount))
      const blocks: ContextBlock[] = [
        ...initial.system.map(item => seed("system", "instruction", "system", "child-harness", item)),
        // All task contract fields originate in a parent model request. Keep
        // them as data so prompt content cannot gain instruction trust.
        ...initial.profile.map(item => seed("profile", "data", "external_untrusted", "subagent-task", item)),
        ...(initial.goal ? [seed("goal", "data", "external_untrusted", "subagent-task", initial.goal)] : []),
        ...request.snapshot.steerHistory.map(item => ({ id: item.id, layer: "steer_history" as const, role: "data" as const, trust: "external_untrusted" as const, source: "child-steer", content: json(item.content) })),
        ...request.snapshot.toolObservations.map(item => seed("tool_observation", "data", "external_untrusted", "tool-or-subagent", item)),
        ...cachedMailboxBlocks,
      ]
      const result = { schemaVersion: "agent-harness.v2" as const, sessionId: task.sessionId, turnId: task.turnId!, stepId: request.stepId, inputThroughSequence: 0n, consumedInputIds: [], blocks }
      return { ...result, canonicalJson: JSON.stringify({ ...result, inputThroughSequence: "0" }) }
    },
    getMailboxMessageIds: () => [...mailboxBlocks.keys()],
  }
}
