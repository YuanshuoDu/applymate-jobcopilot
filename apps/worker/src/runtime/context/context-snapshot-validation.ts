import {
  CONTEXT_SNAPSHOT_SCHEMA_VERSION,
  ContextSnapshotError,
  type ContextSnapshotContent,
  type ContextSnapshotTokenAccounting,
  type ContextSnapshotTokenProfile,
} from "./context-snapshot-types.js"
import { canonicalJson } from "./context-snapshot-json.js"

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextSnapshotError("store_conflict", "Snapshot content must be an object")
  return value as Record<string, unknown>
}

function arrayField(value: Record<string, unknown>, field: string): unknown[] {
  if (!Array.isArray(value[field])) throw new ContextSnapshotError("store_conflict", `Snapshot content has invalid ${field}`)
  return value[field] as unknown[]
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextSnapshotError("store_conflict", `Snapshot content has invalid ${field}`)
  return value
}

function optionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") throw new ContextSnapshotError("store_conflict", `Snapshot content has invalid ${field}`)
}

function sequence(value: unknown, field: string): void {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new ContextSnapshotError("store_conflict", `Snapshot content has invalid ${field}`)
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function objectArray(value: Record<string, unknown>, field: string): Record<string, unknown>[] {
  return arrayField(value, field).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new ContextSnapshotError("store_conflict", `${field}[${index}] must be an object`)
    return item as Record<string, unknown>
  })
}

function sortedStrings(values: readonly unknown[], field: string): void {
  let previous: string | undefined
  for (const [index, value] of values.entries()) {
    const current = nonEmpty(value, `${field}[${index}]`)
    if (previous !== undefined && compareText(previous, current) >= 0) throw new ContextSnapshotError("store_conflict", `${field} is not sorted uniquely`)
    previous = current
  }
}

function validateContext(context: Record<string, unknown>): void {
  for (const field of ["system", "profile", "steerHistory", "toolObservations"]) {
    let previous: string | undefined
    for (const [index, item] of objectArray(context, field).entries()) {
      const id = nonEmpty(item.id, `${field}[${index}].id`)
      if (item.content === undefined) throw new ContextSnapshotError("store_conflict", `${field}[${index}] is missing content`)
      canonicalJson(item.content)
      if (previous !== undefined && compareText(previous, id) >= 0) throw new ContextSnapshotError("store_conflict", `${field} is not sorted uniquely`)
      previous = id
    }
  }
  if (context.goal !== undefined) {
    const goal = record(context.goal)
    nonEmpty(goal.id, "context.goal.id")
    if (goal.content === undefined) throw new ContextSnapshotError("store_conflict", "context.goal is missing content")
    canonicalJson(goal.content)
  }
}

function validateAccounting(value: unknown, field: string): ContextSnapshotTokenAccounting {
  const accounting = record(value)
  const profiles = objectArray(accounting, "profiles").map((profile, index) => {
    const result: ContextSnapshotTokenProfile = {
      profileKey: nonEmpty(profile.profileKey, `${field}.profiles[${index}].profileKey`),
      provider: nonEmpty(profile.provider, `${field}.profiles[${index}].provider`),
      model: nonEmpty(profile.model, `${field}.profiles[${index}].model`),
      ...(profile.profileId === undefined ? {} : { profileId: nonEmpty(profile.profileId, `${field}.profiles[${index}].profileId`) }),
      inputTokens: profile.inputTokens as number,
      outputTokens: profile.outputTokens as number,
      estimatedCostUsd: profile.estimatedCostUsd as number,
    }
    if (result.profileKey !== (result.profileId ?? `${result.provider}:${result.model}`)) throw new ContextSnapshotError("store_conflict", `${field}.profiles[${index}] has an invalid profile key`)
    if (!Number.isSafeInteger(result.inputTokens) || result.inputTokens < 0 || !Number.isSafeInteger(result.outputTokens) || result.outputTokens < 0) throw new ContextSnapshotError("store_conflict", `${field}.profiles[${index}] has invalid token counts`)
    if (!Number.isFinite(result.estimatedCostUsd) || result.estimatedCostUsd < 0) throw new ContextSnapshotError("store_conflict", `${field}.profiles[${index}] has invalid cost`)
    return result
  })
  let inputTokens = 0
  let outputTokens = 0
  let cost = 0
  let previous: string | undefined
  for (const profile of profiles) {
    if (previous !== undefined && compareText(previous, profile.profileKey) >= 0) throw new ContextSnapshotError("store_conflict", `${field}.profiles is not sorted uniquely`)
    previous = profile.profileKey
    inputTokens += profile.inputTokens
    outputTokens += profile.outputTokens
    cost = Number((cost + profile.estimatedCostUsd).toFixed(8))
  }
  const totalInputTokens = accounting.totalInputTokens
  const totalOutputTokens = accounting.totalOutputTokens
  const totalCostUsd = accounting.totalCostUsd
  if (typeof totalInputTokens !== "number" || typeof totalOutputTokens !== "number" || typeof totalCostUsd !== "number" || !Number.isSafeInteger(totalInputTokens) || totalInputTokens < 0 || !Number.isSafeInteger(totalOutputTokens) || totalOutputTokens < 0 || !Number.isFinite(totalCostUsd) || totalCostUsd < 0) throw new ContextSnapshotError("store_conflict", `${field} has invalid totals`)
  if (inputTokens !== totalInputTokens || outputTokens !== totalOutputTokens || cost !== Number(totalCostUsd.toFixed(8))) throw new ContextSnapshotError("store_conflict", `${field} totals do not match profiles`)
  return { profiles, totalInputTokens, totalOutputTokens, totalCostUsd: Number(totalCostUsd.toFixed(8)) }
}

function validateContent(content: Record<string, unknown>): void {
  nonEmpty(content.ownerId, "ownerId")
  nonEmpty(content.sessionId, "sessionId")
  sequence(content.throughSequence, "throughSequence")
  nonEmpty(content.goal, "goal")
  for (const field of ["userConstraints", "pendingApprovals", "consumedInputIds"]) sortedStrings(arrayField(content, field), field)
  const orderedEntities = (field: string, keyField: string): void => {
    let previousSequence = 0n
    let previousKey: string | undefined
    const seen = new Set<string>()
    for (const [index, item] of objectArray(content, field).entries()) {
      const key = nonEmpty(item[keyField], `${field}[${index}].${keyField}`)
      if (seen.has(key)) throw new ContextSnapshotError("store_conflict", `${field} contains duplicate id ${key}`)
      seen.add(key)
      if (item.sequence !== undefined) sequence(item.sequence, `${field}[${index}].sequence`)
      const currentSequence = item.sequence === undefined ? 0n : BigInt(item.sequence as string)
      if (previousKey !== undefined && (currentSequence < previousSequence || (currentSequence === previousSequence && compareText(previousKey, key) >= 0))) {
        throw new ContextSnapshotError("store_conflict", `${field} is not sorted uniquely`)
      }
      previousSequence = currentSequence
      previousKey = key
    }
  }
  orderedEntities("confirmedDecisions", "id")
  for (const [index, item] of objectArray(content, "confirmedDecisions").entries()) {
    nonEmpty(item.id, `confirmedDecisions[${index}].id`)
    nonEmpty(item.decision, `confirmedDecisions[${index}].decision`)
    sortedStrings(arrayField(item, "evidenceEventIds"), `confirmedDecisions[${index}].evidenceEventIds`)
    if (item.sequence !== undefined) sequence(item.sequence, `confirmedDecisions[${index}].sequence`)
  }
  orderedEntities("completedWork", "taskId")
  for (const [index, item] of objectArray(content, "completedWork").entries()) {
    nonEmpty(item.taskId, `completedWork[${index}].taskId`)
    nonEmpty(item.resultRef, `completedWork[${index}].resultRef`)
    nonEmpty(item.summary, `completedWork[${index}].summary`)
    if (item.sequence !== undefined) sequence(item.sequence, `completedWork[${index}].sequence`)
  }
  orderedEntities("openWork", "taskId")
  for (const [index, item] of objectArray(content, "openWork").entries()) {
    nonEmpty(item.taskId, `openWork[${index}].taskId`)
    nonEmpty(item.status, `openWork[${index}].status`)
    if (item.blocker !== null) nonEmpty(item.blocker, `openWork[${index}].blocker`)
    if (item.sequence !== undefined) sequence(item.sequence, `openWork[${index}].sequence`)
  }
  orderedEntities("failedAttempts", "taskId")
  for (const [index, item] of objectArray(content, "failedAttempts").entries()) {
    nonEmpty(item.taskId, `failedAttempts[${index}].taskId`)
    nonEmpty(item.reason, `failedAttempts[${index}].reason`)
    sortedStrings(arrayField(item, "doNotRepeat"), `failedAttempts[${index}].doNotRepeat`)
    if (item.sequence !== undefined) sequence(item.sequence, `failedAttempts[${index}].sequence`)
  }
  const artifacts = objectArray(content, "artifacts").map((item, index) => {
    const id = nonEmpty(item.id, `artifacts[${index}].id`)
    nonEmpty(item.type, `artifacts[${index}].type`)
    nonEmpty(item.hash, `artifacts[${index}].hash`)
    return id
  })
  sortedStrings(artifacts, "artifacts")
  const facts = objectArray(content, "facts").map((item, index) => {
    const id = nonEmpty(item.factId, `facts[${index}].factId`)
    nonEmpty(item.key, `facts[${index}].key`)
    nonEmpty(item.source, `facts[${index}].source`)
    return id
  })
  sortedStrings(facts, "facts")
  let previousReference: string | undefined
  const seenReferences = new Set<string>()
  for (const [index, item] of objectArray(content, "references").entries()) {
    const kind = nonEmpty(item.kind, `references[${index}].kind`)
    if (!["job", "jd", "dom", "email", "artifact", "attachment"].includes(kind)) throw new ContextSnapshotError("store_conflict", `references[${index}] has an invalid kind`)
    const id = nonEmpty(item.id, `references[${index}].id`)
    nonEmpty(item.ownerId, `references[${index}].ownerId`)
    const source = nonEmpty(item.source, `references[${index}].source`)
    if (item.verified !== true) throw new ContextSnapshotError("store_conflict", `references[${index}] is not verified`)
    for (const field of ["label", "hash", "summary", "resource"]) optionalString(item[field], `references[${index}].${field}`)
    const key = `${kind}:${id}`
    if (seenReferences.has(key)) throw new ContextSnapshotError("store_conflict", `references contains duplicate ${key}`)
    seenReferences.add(key)
    const orderKey = `${kind}\u0000${id}\u0000${source}`
    if (previousReference !== undefined && compareText(previousReference, orderKey) > 0) throw new ContextSnapshotError("store_conflict", "references are not sorted")
    previousReference = orderKey
  }
  validateContext(record(content.context))
  validateAccounting(content.tokenAccounting, "tokenAccounting")
}

export function validateSnapshotContent(value: unknown): ContextSnapshotContent {
  const content = record(value)
  if (content.schemaVersion !== CONTEXT_SNAPSHOT_SCHEMA_VERSION) throw new ContextSnapshotError("store_conflict", "Unsupported context snapshot schema version")
  validateContent(content)
  return content as ContextSnapshotContent
}
