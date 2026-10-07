export type FeedbackDisposition = 'passed' | 'failed' | 'uncertain'
export type FeedbackReason = 'meets_criterion' | 'does_not_meet_criterion' | 'evidence_missing' | 'evidence_conflict' | 'ambiguous' | 'unsupported_claim'
export type FeedbackCheck = Readonly<{ disposition: FeedbackDisposition; reason: FeedbackReason }>
export type FeedbackGroup = Readonly<{ checks: readonly FeedbackCheck[] }>
export type FeedbackView =
  | Readonly<{ state: 'none' }>
  | Readonly<{ state: 'unavailable' }>
  | Readonly<{ state: 'available'; groups: readonly FeedbackGroup[] }>

const FEEDBACK_KEY = 'nativeVerificationFeedback'
const PRIVATE_REPORT_KEY = 'nativeVerificationReport'
const FEEDBACK_FIELDS = ['criteria', 'disposition'] as const
const CRITERION_FIELDS = ['criterionId', 'disposition', 'evidenceReferenceIds', 'reasonCode'] as const
const DISPOSITIONS: readonly FeedbackDisposition[] = ['passed', 'failed', 'uncertain']
const REASONS: readonly FeedbackReason[] = ['meets_criterion', 'does_not_meet_criterion', 'evidence_missing', 'evidence_conflict', 'ambiguous', 'unsupported_claim']
const WAIT_STATUSES = ['waiting', 'ready', 'timed_out', 'interrupted', 'closed'] as const
const SUBAGENT_RESULT_FIELDS = ['finalItemId', 'finalText', FEEDBACK_KEY, 'status', 'stepCount', 'structuredResult', 'toolCallCount'] as const
const SUBAGENT_RESULT_SCHEMA = 'agent-harness.v2.subagent.result'
const ROLE_FIELDS = { scout: ['schemaVersion', 'role', 'status', 'candidates', 'evidence', 'summary'], analyst: ['schemaVersion', 'role', 'status', 'findings', 'evidence', 'summary'], writer: ['schemaVersion', 'role', 'status', 'artifactRef'], reviewer: ['schemaVersion', 'role', 'status', 'artifactRef', 'reviewStatus', 'reviewHash'] } as const
const EVIDENCE_FIELDS = ['id', 'kind', 'ref', 'source'] as const, CANDIDATE_FIELDS = ['jobId', 'source', 'url', 'evidenceIds'] as const, FINDING_FIELDS = ['jobId', 'score', 'evidenceIds'] as const, ARTIFACT_FIELDS = ['artifactId', 'version', 'contentHash', 'sourceDigest'] as const
const EVIDENCE_KINDS = new Set<unknown>(['job', 'persona', 'resume', 'source']), REVIEW_STATUSES = ['passed', 'needs_revision', 'rejected', 'stale'] as const
// Bound total role-array traversal regardless of the input path.
const ROLE_RESULT_ARRAY_ENTRY_LIMIT = 4_096
const SHA256 = /^sha256:[a-f0-9]{64}$/
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
type Slot = { readonly found: false } | { readonly found: true; readonly value: unknown }
type RoleResultArrayBudget = { remaining: number }

/** Reads only the public feedback slot, never server verification receipts. */
export function extractNativeVerificationFeedback(value: unknown): FeedbackView {
  try { return extract(value) } catch { return { state: 'unavailable' } }
}
/** Removes only recognized feedback/proof fields before the generic JSON row renders. */
export function safeNativeFeedbackOutput(value: unknown): unknown {
  try {
    const root = record(value)
    if (!root) return value
    const copy = copyWithout(root, [FEEDBACK_KEY, PRIVATE_REPORT_KEY])
    const result = own(root, 'result')
    if (result.found) copy.result = stripDirectResult(result.value)
    const status = own(root, 'status')
    const tasks = own(root, 'tasks')
    if (!status.found || !isWaitStatus(status.value) || !tasks.found || !denseArray(tasks.value, 8, 0)) {
      return Object.keys(copy).length ? copy : undefined
    }
    const safeTasks = tasks.value.map(task => {
      const taskRecord = record(task)
      if (!taskRecord) return null
      const result = own(taskRecord, 'result')
      return result.found ? copyWith(taskRecord, 'result', stripDirectResult(result.value)) : copyWithout(taskRecord, [])
    })
    return { ...copy, tasks: safeTasks }
  } catch { return '[unavailable]' }
}
function extract(value: unknown): FeedbackView {
  const direct = extractDirectResult(value)
  if (direct.state !== 'none') return direct
  const root = record(value)
  if (!root) return { state: 'none' }
  const result = own(root, 'result')
  if (result.found) {
    const nested = extractNestedSubagentResult(result.value)
    if (nested.state !== 'none') return nested
  }
  const status = own(root, 'status')
  const tasks = own(root, 'tasks')
  if (!status.found || !isWaitStatus(status.value) || !tasks.found) return { state: 'none' }
  if (!denseArray(tasks.value, 8, 0)) return { state: 'unavailable' }
  const groups: FeedbackGroup[] = []
  for (const task of tasks.value) {
    const taskRecord = record(task)
    if (!taskRecord) return { state: 'unavailable' }
    const result = own(taskRecord, 'result')
    if (!result.found) return { state: 'unavailable' }
    const parsed = extractDirectResult(result.value)
    if (parsed.state === 'unavailable') return parsed
    if (parsed.state === 'available') groups.push(...parsed.groups)
  }
  return groups.length ? available(groups) : { state: 'none' }
}
function extractDirectResult(value: unknown): FeedbackView {
  const root = record(value)
  if (!root) return { state: 'none' }
  if (own(root, PRIVATE_REPORT_KEY).found) return { state: 'unavailable' }
  const direct = own(root, FEEDBACK_KEY)
  if (!direct.found) return { state: 'none' }
  const parsed = parseFeedback(direct.value)
  return parsed ? available([parsed]) : { state: 'unavailable' }
}
function extractNestedSubagentResult(value: unknown): FeedbackView {
  const root = record(value)
  if (!root) return { state: 'none' }
  const direct = own(root, FEEDBACK_KEY)
  const report = own(root, PRIVATE_REPORT_KEY)
  if (!direct.found && !report.found) return { state: 'none' }
  if (report.found || !isCanonicalCompletedSubagentResult(root)) return { state: 'unavailable' }
  return extractDirectResult(root)
}
function isCanonicalCompletedSubagentResult(value: Record<string, unknown>): boolean {
  const envelope = exactRecord(value, SUBAGENT_RESULT_FIELDS)
  if (!envelope || envelope.status !== 'completed'
    || !Number.isSafeInteger(envelope.stepCount) || Number(envelope.stepCount) < 0
    || !Number.isSafeInteger(envelope.toolCallCount) || Number(envelope.toolCallCount) < 0
    || (envelope.finalItemId !== null && typeof envelope.finalItemId !== 'string')
    || typeof envelope.finalText !== 'string') return false
  return isRoleResult(envelope.structuredResult)
}
function isRoleResult(value: unknown): boolean {
  const root = record(value); if (!root) return false
  const schema = own(root, 'schemaVersion'), role = own(root, 'role')
  if (!schema.found || schema.value !== SUBAGENT_RESULT_SCHEMA || !role.found) return false
  return role.value === 'scout' || role.value === 'analyst' ? isListRoleResult(root, role.value)
    : role.value === 'writer' || role.value === 'reviewer' ? isArtifactRoleResult(root, role.value) : false
}
function isListRoleResult(value: Record<string, unknown>, role: 'scout' | 'analyst'): boolean {
  const result = exactRecord(value, ROLE_FIELDS[role])
  if (!result || result.schemaVersion !== SUBAGENT_RESULT_SCHEMA || result.role !== role || (result.status !== 'completed' && result.status !== 'partial') || typeof result.summary !== 'string') return false
  const budget = { remaining: ROLE_RESULT_ARRAY_ENTRY_LIMIT }
  const evidence = parseRoleEvidence(result.evidence, budget)
  return Boolean(evidence && isRoleItemsValid(role, result[role === 'scout' ? 'candidates' : 'findings'], evidence, budget))
}
function parseRoleEvidence(value: unknown, budget: RoleResultArrayBudget): Map<string, Record<string, unknown>> | null {
  if (!roleResultArray(value, budget, 0)) return null
  const rows = new Map<string, Record<string, unknown>>()
  for (const raw of value) {
    const row = exactRecord(raw, EVIDENCE_FIELDS)
    if (!row || !nonEmpty(row.id) || !nonEmpty(row.ref) || !nonEmpty(row.source)
      || !EVIDENCE_KINDS.has(row.kind) || rows.has(row.id)) return null
    rows.set(row.id, row)
  }
  return rows
}
function isRoleItemsValid(role: 'scout' | 'analyst', value: unknown, evidence: ReadonlyMap<string, Record<string, unknown>>, budget: RoleResultArrayBudget): boolean {
  if (!roleResultArray(value, budget, 0)) return false
  for (const raw of value) {
    const item = exactRecord(raw, role === 'scout' ? CANDIDATE_FIELDS : FINDING_FIELDS)
    if (!item || !nonEmpty(item.jobId) || (role === 'scout'
      ? !nonEmpty(item.source) || (item.url !== null && !nonEmpty(item.url))
      : typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 10)) return false
    const ids = item.evidenceIds
    if (!roleResultArray(ids, budget)) return false
    let hasMatchingJobEvidence = false
    for (const id of ids) {
      if (!nonEmpty(id)) return false
      const row = evidence.get(id)
      if (!row) return false
      if (row.kind === 'job' && row.ref === item.jobId) hasMatchingJobEvidence = true
    }
    if (!hasMatchingJobEvidence) return false
  }
  return true
}
function roleResultArray(value: unknown, budget: RoleResultArrayBudget, minLength = 1): value is unknown[] {
  if (!denseArray(value, ROLE_RESULT_ARRAY_ENTRY_LIMIT, minLength) || value.length > budget.remaining) return false
  budget.remaining -= value.length
  return true
}
function isArtifactRoleResult(value: Record<string, unknown>, role: 'writer' | 'reviewer'): boolean {
  const result = exactRecord(value, ROLE_FIELDS[role])
  const artifact = result && exactRecord(result.artifactRef, ARTIFACT_FIELDS)
  if (!result || !artifact || result.schemaVersion !== SUBAGENT_RESULT_SCHEMA || result.role !== role || result.status !== 'completed'
    || typeof artifact.artifactId !== 'string' || !IDENTIFIER.test(artifact.artifactId)
    || !Number.isSafeInteger(artifact.version) || Number(artifact.version) < 1
    || typeof artifact.contentHash !== 'string' || !SHA256.test(artifact.contentHash)
    || typeof artifact.sourceDigest !== 'string' || !SHA256.test(artifact.sourceDigest)) return false
  return role === 'writer' || (REVIEW_STATUSES as readonly unknown[]).includes(result.reviewStatus)
    && typeof result.reviewHash === 'string' && SHA256.test(result.reviewHash)
}
function nonEmpty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }

function parseFeedback(value: unknown): FeedbackGroup | null {
  const feedback = exactRecord(value, FEEDBACK_FIELDS)
  if (!feedback || !isDisposition(feedback.disposition) || !denseArray(feedback.criteria, 32)) return null
  const checks: FeedbackCheck[] = []
  for (const [index, raw] of feedback.criteria.entries()) {
    const criterion = exactRecord(raw, CRITERION_FIELDS)
    if (!criterion || criterion.criterionId !== `criterion-${index + 1}` || !isDisposition(criterion.disposition)
      || !isReason(criterion.reasonCode) || !denseArray(criterion.evidenceReferenceIds, 8, 0)) return null
    const refs = criterion.evidenceReferenceIds
    if (refs.some((ref, refIndex) => !isIdentifier(ref) || refs.indexOf(ref) !== refIndex)) return null
    if (criterion.disposition === 'passed' && criterion.reasonCode !== 'meets_criterion') return null
    if (criterion.disposition === 'failed' && !['does_not_meet_criterion', 'evidence_conflict', 'unsupported_claim'].includes(criterion.reasonCode)) return null
    if (criterion.disposition === 'uncertain' && !['evidence_missing', 'evidence_conflict', 'ambiguous', 'unsupported_claim'].includes(criterion.reasonCode)) return null
    checks.push({ disposition: criterion.disposition, reason: criterion.reasonCode })
  }
  const aggregate = checks.some(check => check.disposition === 'failed') ? 'failed'
    : checks.some(check => check.disposition === 'uncertain') ? 'uncertain' : 'passed'
  return aggregate === feedback.disposition ? { checks } : null
}
function available(groups: readonly FeedbackGroup[]): FeedbackView { return { state: 'available', groups } }
function isDisposition(value: unknown): value is FeedbackDisposition { return typeof value === 'string' && DISPOSITIONS.includes(value as FeedbackDisposition) }
function isReason(value: unknown): value is FeedbackReason { return typeof value === 'string' && REASONS.includes(value as FeedbackReason) }
function isIdentifier(value: unknown): value is string { return typeof value === 'string' && IDENTIFIER.test(value) }
function isWaitStatus(value: unknown): boolean { return typeof value === 'string' && (WAIT_STATUSES as readonly string[]).includes(value) }

function record(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
      ? value as Record<string, unknown> : null
  } catch { return null }
}
function exactRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
  const parsed = record(value)
  if (!parsed) return null
  try {
    const keys = Object.getOwnPropertyNames(parsed)
    if (keys.length !== fields.length || keys.some(key => !fields.includes(key))) return null
    return keys.every(key => { const descriptor = Object.getOwnPropertyDescriptor(parsed, key); return Boolean(descriptor?.enumerable && 'value' in descriptor) }) ? parsed : null
  } catch { return null }
}
function own(value: Record<string, unknown>, key: string): Slot {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  if (!descriptor) return { found: false }
  if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('feedback_slot_invalid')
  return { found: true, value: descriptor.value }
}
function denseArray(value: unknown, maxLength: number, minLength = 1): value is unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length < minLength || value.length > maxLength
    || Object.getOwnPropertySymbols(value).length) return false
  const names = Object.getOwnPropertyNames(value)
  if (names.length !== value.length + 1 || !names.includes('length')) return false
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (!descriptor?.enumerable || !('value' in descriptor)) return false
  }
  return true
}
function copyWithout(value: Record<string, unknown>, excluded: readonly string[]): Record<string, unknown> {
  const copy: Record<string, unknown> = {}
  for (const key of Object.getOwnPropertyNames(value)) {
    if (excluded.includes(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.enumerable && 'value' in descriptor) Object.defineProperty(copy, key, { value: descriptor.value, enumerable: true, configurable: true, writable: true })
  }
  return copy
}
function copyWith(value: Record<string, unknown>, key: string, replacement: unknown): Record<string, unknown> {
  const copy = copyWithout(value, [])
  copy[key] = replacement
  return copy
}
function stripDirectResult(value: unknown): unknown {
  const result = record(value)
  if (!result) return value
  const copy = copyWithout(result, [FEEDBACK_KEY, PRIVATE_REPORT_KEY])
  return Object.keys(copy).length ? copy : undefined
}
