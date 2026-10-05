import { createHash } from "node:crypto"

import type { ContextSeedBlock, StepContextSnapshot } from "./step-context-builder.js"
import { canonicalJson as compactionCanonicalJson } from "./context-compaction-canonical.js"
import { canonicalJson as snapshotCanonicalJson } from "./context-snapshot-json.js"
import { ContextSnapshotError, type ContextSnapshotCompaction, type ContextSnapshotContent } from "./context-snapshot-types.js"

const MAX_MODEL_MEMORY_CHARACTERS = 16_000

type RecordValue = Record<string, unknown>

function record(value: unknown, field: string): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContextSnapshotError("store_conflict", `${field} must be an object`)
  return value as RecordValue
}

function exactKeys(value: RecordValue, allowed: readonly string[], field: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ContextSnapshotError("store_conflict", `${field} has an unsupported field`)
}

function text(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim().length === 0)) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return value
}

function rows(value: unknown, field: string): RecordValue[] {
  if (!Array.isArray(value)) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  return value.map((item, index) => record(item, `${field}[${index}]`))
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  const values = value.map((item, index) => text(item, `${field}[${index}]`))
  for (let index = 1; index < values.length; index += 1) {
    if (values[index - 1].localeCompare(values[index]) >= 0) throw new ContextSnapshotError("store_conflict", `${field} is not sorted uniquely`)
  }
  return values
}

function orderedRows(value: unknown, field: string, keyField: string): RecordValue[] {
  const values = rows(value, field)
  let previous = ""
  for (const [index, item] of values.entries()) {
    const key = text(item[keyField], `${field}[${index}].${keyField}`)
    if (index > 0 && previous.localeCompare(key) >= 0) throw new ContextSnapshotError("store_conflict", `${field} is not sorted uniquely`)
    previous = key
  }
  return values
}

function uniqueIds(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new ContextSnapshotError("store_conflict", `Invalid ${field}`)
  const ids = value.map((item, index) => text(item, `${field}[${index}]`))
  if (new Set(ids).size !== ids.length) throw new ContextSnapshotError("store_conflict", `${field} contains duplicates`)
  return ids
}

function validateCompactionState(extension: ContextSnapshotCompaction, ownerId: string, sessionId: string, throughSequence: string): void {
  const state = record(extension.state, "compaction.state")
  exactKeys(state, ["ownerId", "sessionId", "throughSequence", "goal", "userConstraints", "approvals", "answers", "artifacts", "openTasks", "doNotRepeat", "facts"], "compaction.state")
  if (text(state.ownerId, "compaction.state.ownerId") !== ownerId || text(state.sessionId, "compaction.state.sessionId") !== sessionId) {
    throw new ContextSnapshotError("store_conflict", "Compaction state owner or session does not match its snapshot")
  }
  if (state.throughSequence !== throughSequence) throw new ContextSnapshotError("store_conflict", "Compaction state cursor does not match its snapshot")
  text(state.goal, "compaction.state.goal")
  strings(state.userConstraints, "compaction.state.userConstraints")
  strings(state.doNotRepeat, "compaction.state.doNotRepeat")
  for (const [index, item] of orderedRows(state.approvals, "compaction.state.approvals", "id").entries()) {
    exactKeys(item, ["id", "status", "scopeHash", "answersHash"], `compaction.state.approvals[${index}]`)
    text(item.id, `compaction.state.approvals[${index}].id`)
    text(item.status, `compaction.state.approvals[${index}].status`)
    for (const field of ["scopeHash", "answersHash"]) if (item[field] !== undefined) text(item[field], `compaction.state.approvals[${index}].${field}`)
  }
  for (const [index, item] of orderedRows(state.answers, "compaction.state.answers", "id").entries()) {
    exactKeys(item, ["id", "question", "answer", "answerHash"], `compaction.state.answers[${index}]`)
    text(item.id, `compaction.state.answers[${index}].id`)
    text(item.question, `compaction.state.answers[${index}].question`)
    text(item.answer, `compaction.state.answers[${index}].answer`, true)
    if (item.answerHash !== undefined) text(item.answerHash, `compaction.state.answers[${index}].answerHash`)
  }
  for (const [index, item] of orderedRows(state.artifacts, "compaction.state.artifacts", "id").entries()) {
    exactKeys(item, ["id", "type", "hash"], `compaction.state.artifacts[${index}]`)
    text(item.id, `compaction.state.artifacts[${index}].id`)
    text(item.type, `compaction.state.artifacts[${index}].type`)
    text(item.hash, `compaction.state.artifacts[${index}].hash`)
  }
  for (const [index, item] of orderedRows(state.openTasks, "compaction.state.openTasks", "taskId").entries()) {
    exactKeys(item, ["taskId", "status", "blocker"], `compaction.state.openTasks[${index}]`)
    text(item.taskId, `compaction.state.openTasks[${index}].taskId`)
    text(item.status, `compaction.state.openTasks[${index}].status`)
    if (item.blocker !== null) text(item.blocker, `compaction.state.openTasks[${index}].blocker`)
  }
  for (const [index, item] of orderedRows(state.facts, "compaction.state.facts", "factId").entries()) {
    exactKeys(item, ["factId", "key", "source"], `compaction.state.facts[${index}]`)
    text(item.factId, `compaction.state.facts[${index}].factId`)
    text(item.key, `compaction.state.facts[${index}].key`)
    text(item.source, `compaction.state.facts[${index}].source`)
  }
}

export function validateSnapshotCompaction(value: unknown, ownerId: string, sessionId: string, throughSequence: string): void {
  if (value === undefined) return
  const extension = record(value, "compaction") as unknown as ContextSnapshotCompaction
  exactKeys(extension as unknown as RecordValue, ["itemId", "digest", "state", "narrativeSummary", "tokenMeasurement", "sourceItemIds"], "compaction")
  const itemId = text(extension.itemId, "compaction.itemId")
  const digest = text(extension.digest, "compaction.digest")
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new ContextSnapshotError("store_conflict", "Compaction digest is invalid")
  const state = record(extension.state, "compaction.state")
  validateCompactionState(extension, ownerId, sessionId, throughSequence)
  text(extension.narrativeSummary, "compaction.narrativeSummary", true)
  const measurement = record(extension.tokenMeasurement, "compaction.tokenMeasurement")
  exactKeys(measurement, ["beforeInputTokens", "afterInputTokens", "reductionTokens", "reductionRatio"], "compaction.tokenMeasurement")
  for (const field of ["beforeInputTokens", "afterInputTokens", "reductionTokens"]) {
    const amount = measurement[field]
    if (typeof amount !== "number" || !Number.isSafeInteger(amount) || amount < 0) throw new ContextSnapshotError("store_conflict", `Invalid compaction.tokenMeasurement.${field}`)
  }
  if (typeof measurement.reductionRatio !== "number" || !Number.isFinite(measurement.reductionRatio) || measurement.reductionRatio < 0 || measurement.reductionRatio > 1) {
    throw new ContextSnapshotError("store_conflict", "Invalid compaction.tokenMeasurement.reductionRatio")
  }
  const checkedIds = uniqueIds(extension.sourceItemIds, "compaction.sourceItemIds")
  try { snapshotCanonicalJson(extension) }
  catch { throw new ContextSnapshotError("store_conflict", "Compaction state is not canonical JSON") }
  const expected = createHash("sha256").update(compactionCanonicalJson({
    state, summary: extension.narrativeSummary, measurement, sourceItemIds: checkedIds, itemId,
  }), "utf8").digest("hex")
  if (expected !== digest) throw new ContextSnapshotError("store_conflict", "Compaction working state digest mismatch")
}

function withinMemoryBound(value: unknown): boolean {
  let characters = 0
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (typeof current === "string") characters += current.length
    else if (Array.isArray(current)) {
      for (const child of current) pending.push(child)
    }
    else if (current && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        characters += key.length
        pending.push(child)
      }
    }
    if (characters > MAX_MODEL_MEMORY_CHARACTERS) return false
  }
  return snapshotCanonicalJson(value).length <= MAX_MODEL_MEMORY_CHARACTERS
}

function workingState(content: ContextSnapshotContent): ContextSeedBlock | undefined {
  const compacted = content.compaction
  const state = compacted?.state
  const hasLegacyData = content.userConstraints.length + content.confirmedDecisions.length + content.completedWork.length
    + content.openWork.length + content.pendingApprovals.length + content.artifacts.length + content.facts.length + content.failedAttempts.length > 0
  if (!compacted && !hasLegacyData) return undefined
  const value = {
    kind: "durable_context_snapshot",
    status: "available",
    authority: "informational_only",
    provenance: {
      ownerId: content.ownerId, sessionId: content.sessionId, throughSequence: content.throughSequence,
      ...(compacted ? { compactionItemId: compacted.itemId, digest: compacted.digest } : {}),
    },
    // Compaction owns the latest values for these fields; legacy top-level copies may be stale.
    goal: state?.goal ?? content.goal,
    userConstraints: state?.userConstraints ?? content.userConstraints,
    answers: state?.answers ?? [],
    openWork: state?.openTasks ?? content.openWork,
    legacySnapshotFields: {
      freshness: compacted ? "may_be_stale_after_compaction" : "snapshot_scoped",
      confirmedDecisions: content.confirmedDecisions,
      completedWork: content.completedWork,
      failedAttempts: content.failedAttempts,
    },
    approvalState: {
      source: state ? "compaction_state" : "legacy_snapshot",
      entries: state?.approvals ?? content.pendingApprovals,
      freshness: state ? "compaction_state" : "snapshot_scoped",
      grantsActionAuthority: false,
    },
    artifacts: state?.artifacts ?? content.artifacts,
    doNotRepeat: state?.doNotRepeat ?? [],
    facts: state?.facts ?? content.facts,
    factValuesIncluded: false,
    evidenceBodiesIncluded: false,
  }
  if (withinMemoryBound(value)) return { id: `snapshot-working-state:${content.sessionId}:${content.throughSequence}`, content: value }
  return {
    id: `snapshot-working-state:${content.sessionId}:${content.throughSequence}`,
    content: {
      kind: "durable_context_snapshot", status: "unavailable", reason: "projection_limit_exceeded", authority: "informational_only",
      provenance: { ownerId: content.ownerId, sessionId: content.sessionId, throughSequence: content.throughSequence,
        ...(compacted ? { compactionItemId: compacted.itemId, digest: compacted.digest } : {}) },
    },
  }
}

export function stepContextSnapshotFromContent(content: ContextSnapshotContent): StepContextSnapshot {
  const memory = workingState(content)
  return {
    system: content.context.system,
    profile: content.context.profile,
    goal: content.context.goal ?? { id: "snapshot-goal", content: content.goal },
    steerHistory: content.context.steerHistory,
    businessRefs: content.references.map(({ source: _source, verified: _verified, ...reference }) => reference),
    toolObservations: [...content.context.toolObservations, ...(memory ? [memory] : [])],
  }
}
