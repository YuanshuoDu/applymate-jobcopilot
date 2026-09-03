import type { TenantScope } from "@jobcopilot/agent-protocol"

import { canonicalJson } from "./context-snapshot-canonical.js"
import { aggregateTokenAccounting } from "./context-snapshot-token-accounting.js"
import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  ContextSnapshotError,
  type ContextSnapshotArtifact,
  type ContextSnapshotCompletedWork,
  type ContextSnapshotContent,
  type ContextSnapshotContextSeeds,
  type ContextSnapshotDecisionInput,
  type ContextSnapshotFailedAttempt,
  type ContextSnapshotFact,
  type ContextSnapshotOpenWork,
  type ContextSnapshotReference,
  type ContextSnapshotSourceData,
  type ContextSnapshotTokenAccounting,
  type VerifiedContextReference,
  type VerifiedContextReferencePort,
} from "./context-snapshot-types.js"
import { validateSnapshotContent } from "./context-snapshot-validation.js"

export type CollectedContextSnapshot = {
  readonly content: ContextSnapshotContent
  readonly tokenAccounting: ContextSnapshotTokenAccounting
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextSnapshotError("invalid_input", `${field} must be non-empty`)
  return value
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function sequence(value: bigint | number | string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined
  let result: bigint
  try { result = typeof value === "bigint" ? value : BigInt(value) } catch { throw new ContextSnapshotError("invalid_input", `${field} must be an integer`) }
  if (result < 0n) throw new ContextSnapshotError("invalid_input", `${field} must not be negative`)
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new ContextSnapshotError("invalid_input", `${field} must be a safe integer`)
  return result.toString()
}

function textList(values: readonly string[], field: string): string[] {
  const normalized = values.map((value, index) => nonEmpty(value, `${field}[${index}]`))
  return [...new Set(normalized)].sort(compareText)
}

function rejectDuplicateIds(values: readonly { readonly id: string }[], field: string): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    const id = nonEmpty(value.id, `${field}[${index}].id`)
    if (seen.has(id)) throw new ContextSnapshotError("invalid_input", `${field} contains duplicate id ${id}`)
    seen.add(id)
  }
}

function rejectDuplicateKeys<T>(values: readonly T[], key: (value: T) => string, field: string): void {
  const seen = new Set<string>()
  for (const [index, value] of values.entries()) {
    const current = nonEmpty(key(value), `${field}[${index}]`)
    if (seen.has(current)) throw new ContextSnapshotError("invalid_input", `${field} contains duplicate id ${current}`)
    seen.add(current)
  }
}

function ordered<T extends { readonly id?: string; readonly taskId?: string; readonly sequence?: bigint | number | string }>(values: readonly T[], field: string): T[] {
  return values.map((value, index) => {
    const key = value.id ?? value.taskId
    if (!key) throw new ContextSnapshotError("invalid_input", `${field}[${index}] needs an id or taskId`)
    const normalizedSequence = sequence(value.sequence, `${field}[${index}].sequence`)
    return { ...value, ...(normalizedSequence === undefined ? {} : { sequence: normalizedSequence }) }
  }).sort((left, right) => {
    const leftSequence = left.sequence === undefined ? "0" : String(left.sequence)
    const rightSequence = right.sequence === undefined ? "0" : String(right.sequence)
    const sequenceResult = BigInt(leftSequence) < BigInt(rightSequence) ? -1 : BigInt(leftSequence) > BigInt(rightSequence) ? 1 : 0
    if (sequenceResult !== 0) return sequenceResult
    const idResult = compareText(left.id ?? left.taskId ?? "", right.id ?? right.taskId ?? "")
    return idResult !== 0 ? idResult : compareText(canonicalJson(left), canonicalJson(right))
  })
}

function seed<T extends { readonly id: string }>(value: T, field: string): T {
  return { ...value, id: nonEmpty(value.id, `${field}.id`) }
}

function contextSeeds(source: ContextSnapshotSourceData): ContextSnapshotContextSeeds {
  const context = source.context ?? {}
  rejectDuplicateIds(context.system ?? [], "context.system")
  rejectDuplicateIds(context.profile ?? [], "context.profile")
  rejectDuplicateIds(context.steerHistory ?? [], "context.steerHistory")
  rejectDuplicateIds(context.toolObservations ?? [], "context.toolObservations")
  return {
    system: (context.system ?? []).map((value, index) => seed(value, `context.system[${index}]`)).sort((left, right) => compareText(left.id, right.id)),
    profile: (context.profile ?? []).map((value, index) => seed(value, `context.profile[${index}]`)).sort((left, right) => compareText(left.id, right.id)),
    ...(context.goal === undefined ? {} : { goal: seed(context.goal, "context.goal") }),
    steerHistory: (context.steerHistory ?? []).map((value, index) => seed(value, `context.steerHistory[${index}]`)).sort((left, right) => compareText(left.id, right.id)),
    toolObservations: (context.toolObservations ?? []).map((value, index) => seed(value, `context.toolObservations[${index}]`)).sort((left, right) => compareText(left.id, right.id)),
  }
}

function normalizeDecisions(values: readonly ContextSnapshotDecisionInput[]): ContextSnapshotDecisionInput[] {
  rejectDuplicateKeys(values, (value) => value.id, "confirmedDecisions")
  return ordered(values, "confirmedDecisions").map((value, index) => ({
    id: nonEmpty(value.id, `confirmedDecisions[${index}].id`),
    decision: nonEmpty(value.decision, `confirmedDecisions[${index}].decision`),
    evidenceEventIds: textList(value.evidenceEventIds, `confirmedDecisions[${index}].evidenceEventIds`),
    ...(value.sequence === undefined ? {} : { sequence: sequence(value.sequence, `confirmedDecisions[${index}].sequence`) }),
  }))
}

function normalizeCompleted(values: readonly ContextSnapshotCompletedWork[]): ContextSnapshotCompletedWork[] {
  rejectDuplicateKeys(values, (value) => value.taskId, "completedWork")
  return ordered(values, "completedWork").map((value, index) => ({
    taskId: nonEmpty(value.taskId, `completedWork[${index}].taskId`),
    resultRef: nonEmpty(value.resultRef, `completedWork[${index}].resultRef`),
    summary: nonEmpty(value.summary, `completedWork[${index}].summary`),
    ...(value.sequence === undefined ? {} : { sequence: sequence(value.sequence, `completedWork[${index}].sequence`) }),
  }))
}

function normalizeOpen(values: readonly ContextSnapshotOpenWork[]): ContextSnapshotOpenWork[] {
  rejectDuplicateKeys(values, (value) => value.taskId, "openWork")
  return ordered(values, "openWork").map((value, index) => ({
    taskId: nonEmpty(value.taskId, `openWork[${index}].taskId`),
    status: nonEmpty(value.status, `openWork[${index}].status`),
    blocker: value.blocker === null ? null : nonEmpty(value.blocker, `openWork[${index}].blocker`),
    ...(value.sequence === undefined ? {} : { sequence: sequence(value.sequence, `openWork[${index}].sequence`) }),
  }))
}

function normalizeFailed(values: readonly ContextSnapshotFailedAttempt[]): ContextSnapshotFailedAttempt[] {
  rejectDuplicateKeys(values, (value) => value.taskId, "failedAttempts")
  return ordered(values, "failedAttempts").map((value, index) => ({
    taskId: nonEmpty(value.taskId, `failedAttempts[${index}].taskId`),
    reason: nonEmpty(value.reason, `failedAttempts[${index}].reason`),
    doNotRepeat: textList(value.doNotRepeat, `failedAttempts[${index}].doNotRepeat`),
    ...(value.sequence === undefined ? {} : { sequence: sequence(value.sequence, `failedAttempts[${index}].sequence`) }),
  }))
}

function normalizeArtifacts(values: readonly ContextSnapshotArtifact[]): ContextSnapshotArtifact[] {
  const normalized = values.map((value, index) => ({ id: nonEmpty(value.id, `artifacts[${index}].id`), type: nonEmpty(value.type, `artifacts[${index}].type`), hash: nonEmpty(value.hash, `artifacts[${index}].hash`) }))
  rejectDuplicateIds(normalized, "artifacts")
  return normalized.sort((left, right) => compareText(left.id, right.id) || compareText(canonicalJson(left), canonicalJson(right)))
}

function normalizeFacts(values: readonly ContextSnapshotFact[]): ContextSnapshotFact[] {
  const normalized = values.map((value, index) => ({ factId: nonEmpty(value.factId, `facts[${index}].factId`), key: nonEmpty(value.key, `facts[${index}].key`), source: nonEmpty(value.source, `facts[${index}].source`) }))
  const ids = normalized.map((value) => ({ id: value.factId }))
  rejectDuplicateIds(ids, "facts")
  return normalized.sort((left, right) => compareText(left.factId, right.factId) || compareText(canonicalJson(left), canonicalJson(right)))
}

async function verifyReferences(values: readonly ContextSnapshotReference[], scope: TenantScope, port: VerifiedContextReferencePort): Promise<VerifiedContextReference[]> {
  const candidates = [...values].sort((left, right) => compareText(left.kind, right.kind) || compareText(left.id, right.id) || compareText(left.source, right.source) || compareText(left.ownerId, right.ownerId))
  const seen = new Set<string>()
  const verified: VerifiedContextReference[] = []
  for (const [index, reference] of candidates.entries()) {
    const id = nonEmpty(reference.id, `references[${index}].id`)
    const source = nonEmpty(reference.source, `references[${index}].source`)
    if (reference.ownerId !== scope.userId) throw new ContextSnapshotError("reference_cross_tenant", `Reference ${id} is outside the tenant scope`)
    const key = `${reference.kind}:${id}`
    if (seen.has(key)) throw new ContextSnapshotError("duplicate_reference", `Reference ${key} appears more than once`)
    seen.add(key)
    const candidate = { ...reference, id, source }
    const result = await port.verify(candidate, scope)
    if (!result) throw new ContextSnapshotError("reference_missing", `Reference ${id} was not found for this tenant`)
    if (result.verified !== true) throw new ContextSnapshotError("reference_unverified", `Reference ${id} was not verified`)
    if (result.id !== id || result.kind !== reference.kind || result.ownerId !== scope.userId || result.source.trim().length === 0) {
      throw new ContextSnapshotError("reference_cross_tenant", `Reference ${id} verification did not match the tenant scope`)
    }
    verified.push({ ...result, source: result.source, verified: true })
  }
  return verified.sort((left, right) => compareText(left.kind, right.kind) || compareText(left.id, right.id) || compareText(left.source, right.source))
}

export async function collectContextSnapshot(input: {
  readonly scope: TenantScope
  readonly sessionId: string
  readonly throughSequence: bigint
  readonly source: ContextSnapshotSourceData
  readonly references: VerifiedContextReferencePort
}): Promise<CollectedContextSnapshot> {
  const sessionId = nonEmpty(input.sessionId, "sessionId")
  const ownerId = nonEmpty(input.scope.userId, "scope.userId")
  if (input.throughSequence < 0n) throw new ContextSnapshotError("invalid_input", "throughSequence must not be negative")
  const goal = nonEmpty(input.source.goal, "goal")
  const tokenAccounting = aggregateTokenAccounting(input.source.tokenUsage)
  const content: ContextSnapshotContent = {
    schemaVersion: CONTEXT_SNAPSHOT_SCHEMA_VERSION,
    ownerId,
    sessionId,
    throughSequence: input.throughSequence.toString(),
    goal,
    userConstraints: textList(input.source.userConstraints, "userConstraints"),
    confirmedDecisions: normalizeDecisions(input.source.confirmedDecisions),
    completedWork: normalizeCompleted(input.source.completedWork),
    openWork: normalizeOpen(input.source.openWork),
    pendingApprovals: textList(input.source.pendingApprovals, "pendingApprovals"),
    artifacts: normalizeArtifacts(input.source.artifacts),
    facts: normalizeFacts(input.source.facts),
    failedAttempts: normalizeFailed(input.source.failedAttempts),
    references: await verifyReferences(input.source.references, input.scope, input.references),
    consumedInputIds: textList(input.source.consumedInputIds ?? [], "consumedInputIds"),
    context: contextSeeds(input.source),
    tokenAccounting,
  }
  return { content: validateSnapshotContent(content), tokenAccounting }
}
