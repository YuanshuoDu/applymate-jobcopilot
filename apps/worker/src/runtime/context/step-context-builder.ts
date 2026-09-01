import type { InputContentPart, TenantScope } from "@jobcopilot/agent-protocol"
import type pg from "pg"

import { InputClaimStoreError, type InputClaimStore, type InputClaimTransaction, type StepCheckpoint, type StoredAgentInput, type TurnExecutionFence } from "./input-claim-store.js"

export type JsonValue = null | boolean | number | string | JsonValue[] | { readonly [key: string]: JsonValue }
export type ContextTrust = "system" | "user_confirmed" | "internal_record" | "external_untrusted"
export type ContextLayer = "system" | "profile" | "goal" | "steer_history" | "business" | "tool_observation" | "pending_input"
export type ContextRole = "instruction" | "data"

export type ContextSeedBlock = { readonly id: string; readonly content: unknown }
export type ContextHistoryEntry = { readonly id: string; readonly content: unknown }
export type BusinessReferenceKind = "job" | "jd" | "dom" | "email" | "artifact" | "attachment"
export type BusinessReferenceResource = "job" | "gmail_message" | "resume" | "resume_version" | "persona_fact" | "persona_evidence_chunk"
export type BusinessReference = {
  readonly id: string
  readonly kind: BusinessReferenceKind
  readonly ownerId: string
  readonly label?: string
  readonly hash?: string
  readonly summary?: string
  readonly resource?: BusinessReferenceResource
}

export type StepContextSnapshot = {
  readonly system: readonly ContextSeedBlock[]
  readonly profile: readonly ContextSeedBlock[]
  readonly goal?: ContextSeedBlock
  readonly steerHistory: readonly ContextHistoryEntry[]
  readonly businessRefs: readonly BusinessReference[]
  readonly toolObservations: readonly ContextSeedBlock[]
}

export type ContextBlock = {
  readonly id: string
  readonly layer: ContextLayer
  readonly role: ContextRole
  readonly trust: ContextTrust
  readonly source: string
  readonly content: JsonValue
}

export type StepContext = {
  readonly schemaVersion: "agent-harness.v2"
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly inputThroughSequence: bigint
  readonly consumedInputIds: readonly string[]
  readonly blocks: readonly ContextBlock[]
  readonly canonicalJson: string
}

export interface ContextOwnerFence {
  assertReferenceOwned(reference: BusinessReference, scope: TenantScope): Promise<void>
  assertAttachmentOwned(reference: Extract<InputContentPart, { type: "attachment_ref" }>, scope: TenantScope): Promise<{ attachmentId: string; filename?: string; mediaType?: string }>
}

export class ContextOwnershipError extends Error {
  constructor(readonly code: "reference_owner_mismatch" | "reference_owner_unknown" | "attachment_owner_unknown", message: string) {
    super(message)
    this.name = "ContextOwnershipError"
  }
}

const defaultOwnerFence: ContextOwnerFence = {
  async assertReferenceOwned(reference, scope) {
    if (reference.ownerId !== scope.userId) throw new ContextOwnershipError("reference_owner_mismatch", `Reference ${reference.id} is outside the tenant scope`)
    throw new ContextOwnershipError("reference_owner_unknown", `Reference ${reference.id} requires a server-side owner resolver`)
  },
  async assertAttachmentOwned(reference) {
    throw new ContextOwnershipError("attachment_owner_unknown", `Attachment ${reference.attachmentId} has no owner resolver`)
  },
}

const referenceTables: Record<BusinessReferenceResource, { table: string; ownerColumn: string }> = { job: { table: '"Job"', ownerColumn: '"userId"' }, gmail_message: { table: '"gmail_messages"', ownerColumn: '"user_id"' }, resume: { table: '"Resume"', ownerColumn: '"userId"' }, resume_version: { table: '"ResumeVersion"', ownerColumn: '"userId"' }, persona_fact: { table: '"persona_facts"', ownerColumn: '"userId"' }, persona_evidence_chunk: { table: '"persona_evidence_chunks"', ownerColumn: '"userId"' } }

export function createPgContextOwnerFence(pool: Pick<pg.Pool, "connect">): ContextOwnerFence {
  async function owned(id: string, userId: string, resource: BusinessReferenceResource): Promise<void> {
    const client = await pool.connect()
    try {
      const table = referenceTables[resource]
      const result = await client.query(`SELECT "id" FROM ${table.table} WHERE "id" = $1 AND ${table.ownerColumn} = $2`, [id, userId])
      if (!result.rows[0]) throw new ContextOwnershipError("reference_owner_mismatch", `Reference ${id} is outside the tenant scope`)
    } finally { client.release() }
  }
  return {
    assertReferenceOwned: async (reference, scope) => {
      const resource = reference.resource ?? (reference.kind === "job" || reference.kind === "jd" ? "job" : reference.kind === "email" ? "gmail_message" : undefined)
      if (!resource) throw new ContextOwnershipError("reference_owner_unknown", `Reference ${reference.id} has no verifiable resource type`)
      await owned(reference.id, scope.userId, resource)
    },
    assertAttachmentOwned: async (reference, scope) => {
      const client = await pool.connect()
      try {
        const result = await client.query<{ id: string; name: string }>('SELECT "id", "name" FROM "Resume" WHERE "id" = $1 AND "userId" = $2', [reference.attachmentId, scope.userId])
        const row = result.rows[0]
        if (!row) throw new ContextOwnershipError("reference_owner_mismatch", `Attachment ${reference.attachmentId} is outside the tenant scope`)
        return { attachmentId: row.id, filename: row.name }
      } finally { client.release() }
    },
  }
}

const layerOrder: readonly ContextLayer[] = ["system", "profile", "goal", "steer_history", "business", "tool_observation", "pending_input"]

function id(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new TypeError(`${field} must be non-empty`)
  return value
}

function json(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Context content must contain finite numbers")
    return value
  }
  if (Array.isArray(value)) return value.map(json)
  if (typeof value === "object") {
    const result: { [key: string]: JsonValue } = {}
    for (const key of Object.keys(value).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) result[key] = json(child)
    }
    return result
  }
  throw new TypeError("Context content must be JSON serializable")
}

function stableJson(value: unknown): string {
  return JSON.stringify(json(value))
}

function block(layer: ContextLayer, role: ContextRole, trust: ContextTrust, source: string, blockId: string, content: unknown): ContextBlock {
  return { id: id(blockId, "block id"), layer, role, trust, source, content: json(content) }
}

function referenceContent(reference: BusinessReference): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = { referenceId: reference.id, kind: reference.kind }
  if (reference.label !== undefined) result.label = reference.label
  if (reference.hash !== undefined) result.hash = reference.hash
  // Job/artifact summaries remain data; raw JD, DOM and email content never does.
  if (reference.summary !== undefined && !["jd", "dom", "email"].includes(reference.kind)) result.summary = reference.summary
  return result
}

function referenceTrust(kind: BusinessReferenceKind): ContextTrust {
  return ["jd", "dom", "email"].includes(kind) ? "external_untrusted" : "internal_record"
}

function pendingBlocks(input: StoredAgentInput, ownerFence: ContextOwnerFence, scope: TenantScope): Promise<ContextBlock[]> {
  return Promise.all(input.content.map(async (part, partIndex) => {
    if (part.type === "attachment_ref") {
      const attachment = await ownerFence.assertAttachmentOwned(part, scope)
      if (attachment.attachmentId !== part.attachmentId) throw new ContextOwnershipError("reference_owner_mismatch", `Attachment resolver returned a different id`)
      return block("pending_input", "data", "external_untrusted", "user_input", `${input.id}:part:${partIndex}`, {
        inputId: input.id, partIndex, attachmentId: attachment.attachmentId, ...(attachment.mediaType ? { mediaType: attachment.mediaType } : {}), ...(attachment.filename ? { filename: attachment.filename } : {}),
      })
    }
    return block("pending_input", "data", "external_untrusted", "user_input", `${input.id}:part:${partIndex}`, { inputId: input.id, partIndex, text: part.text })
  }))
}

function checkpointWithInputs(checkpoint: StepCheckpoint, inputs: readonly StoredAgentInput[]): StepCheckpoint {
  const ids = [...checkpoint.consumedInputIds]
  const known = new Set(ids)
  let through = checkpoint.inputThroughSequence
  for (const input of [...inputs].sort((left, right) => left.acceptedSequence < right.acceptedSequence ? -1 : left.acceptedSequence > right.acceptedSequence ? 1 : left.id.localeCompare(right.id))) {
    if (!known.has(input.id)) { ids.push(input.id); known.add(input.id) }
    if (input.acceptedSequence > through) through = input.acceptedSequence
  }
  return { inputThroughSequence: through, consumedInputIds: ids }
}

function ensureClaimTenant(inputs: readonly StoredAgentInput[], request: StepContextRequest): void {
  for (const input of inputs) {
    if (input.sessionId !== request.sessionId || input.targetTurnId !== request.turnId || input.userId !== request.scope.userId || input.delivery !== "steer") {
      throw new ContextOwnershipError("reference_owner_mismatch", `AgentInput ${input.id} is outside the tenant Turn`)
    }
  }
}

export type StepContextRequest = {
  readonly scope: TenantScope
  readonly sessionId: string
  readonly turnId: string
  readonly stepId: string
  readonly snapshot: StepContextSnapshot
  readonly rootInputId?: string
  readonly mode?: "new" | "retry" | "rebuild"
  readonly rebuild?: boolean
  readonly lease?: TurnExecutionFence
  readonly now?: Date
}

export class StepContextBuilder {
  constructor(
    private readonly store: InputClaimStore,
    private readonly ownerFence: ContextOwnerFence = defaultOwnerFence,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async build(request: StepContextRequest): Promise<StepContext> {
    id(request.sessionId, "sessionId"); id(request.turnId, "turnId"); id(request.stepId, "stepId")
    if (request.scope.userId !== this.store.scope.userId) throw new ContextOwnershipError("reference_owner_mismatch", "Builder scope does not match the claim store tenant")
    return this.store.withTransaction(async (transaction) => this.buildInTransaction(transaction, request))
  }

  private async buildInTransaction(transaction: InputClaimTransaction, request: StepContextRequest): Promise<StepContext> {
    const mode = request.mode ?? (request.rebuild ? "rebuild" : "new")
    const persisted = await transaction.getCheckpoint({ ...request, lease: request.lease })
    const claimed = await transaction.claimInputs({
      sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId, checkpoint: persisted,
      mode, lease: request.lease, now: request.now ?? this.clock(),
    })
    ensureClaimTenant(claimed.inputs, request)
    const sequences = new Map<bigint, string>()
    for (const input of claimed.inputs) {
      const previous = sequences.get(input.acceptedSequence)
      if (previous && previous !== input.id) throw new InputClaimStoreError("checkpoint_conflict", `Duplicate accepted sequence ${input.acceptedSequence}`)
      sequences.set(input.acceptedSequence, input.id)
    }
    for (const reference of [...request.snapshot.businessRefs].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))) {
      id(reference.id, "business reference id")
      if (reference.ownerId !== request.scope.userId) throw new ContextOwnershipError("reference_owner_mismatch", `Reference ${reference.id} is outside the tenant scope`)
      await this.ownerFence.assertReferenceOwned(reference, request.scope)
    }
    const nextCheckpoint = checkpointWithInputs(persisted, claimed.inputs)
    await transaction.persistCheckpoint({ ...request, checkpoint: nextCheckpoint, lease: request.lease })
    const blocks: ContextBlock[] = []
    for (const seed of request.snapshot.system) blocks.push(block("system", "instruction", "system", "harness", `system:${seed.id}`, seed.content))
    for (const seed of request.snapshot.profile) blocks.push(block("profile", "data", "internal_record", "profile", `profile:${seed.id}`, seed.content))
    if (request.snapshot.goal) blocks.push(block("goal", "data", "external_untrusted", "turn_goal", `goal:${request.snapshot.goal.id}`, request.snapshot.goal.content))
    for (const entry of request.snapshot.steerHistory) blocks.push(block("steer_history", "data", "external_untrusted", "steer_history", `history:${entry.id}`, entry.content))
    for (const reference of [...request.snapshot.businessRefs].sort((left, right) => left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id))) blocks.push(block("business", "data", referenceTrust(reference.kind), "business_reference", `business:${reference.kind}:${reference.id}`, referenceContent(reference)))
    for (const observation of request.snapshot.toolObservations) blocks.push(block("tool_observation", "data", "external_untrusted", "tool_or_subagent", `observation:${observation.id}`, observation.content))
    for (const input of claimed.inputs) if (input.id !== request.rootInputId) blocks.push(...await pendingBlocks(input, this.ownerFence, request.scope))
    const ordered = blocks.sort((left, right) => layerOrder.indexOf(left.layer) - layerOrder.indexOf(right.layer))
    const result = {
      schemaVersion: "agent-harness.v2" as const, sessionId: request.sessionId, turnId: request.turnId, stepId: request.stepId,
      inputThroughSequence: nextCheckpoint.inputThroughSequence, consumedInputIds: [...nextCheckpoint.consumedInputIds], blocks: ordered,
    }
    return { ...result, canonicalJson: stableJson({ ...result, inputThroughSequence: result.inputThroughSequence.toString() }) }
  }
}
