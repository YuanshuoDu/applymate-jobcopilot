export const SCHEDULED_PIPELINE_CANDIDATE_SCHEMA = 'agent-harness.v2.scheduled-pipeline-candidate.v3' as const
export const LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA = 'agent-harness.v2.scheduled-pipeline-candidate.v2' as const
export const SCHEDULED_PIPELINE_SOURCE_RECEIPT_SCHEMA_VERSION = 1 as const
export const SCHEDULED_PIPELINE_SOURCE_RECEIPT_MAX_BINDINGS = 8
export const SCHEDULED_PIPELINE_SOURCE_RECEIPT_MAX_BYTES = 6 * 1024

const LEGACY_CANDIDATE_KEYS = 'candidateText,finalStepId,finalStepOrdinal,finishReason,rootAttemptCount,rootTaskId,schemaVersion,sessionId,stepAttempt,turnId,usage'
const RECEIPT_CANDIDATE_KEYS = 'candidateText,finalStepId,finalStepOrdinal,finishReason,rootAttemptCount,rootTaskId,schemaVersion,sessionId,sourceReceipt,stepAttempt,turnId,usage'
const READ_SOURCE_TOOLS = new Set(['jobs.search', 'jobs.get', 'persona.retrieve', 'resume.get_base'])

export type ScheduledPipelineSourceReceipt = Readonly<{
  schemaVersion: typeof SCHEDULED_PIPELINE_SOURCE_RECEIPT_SCHEMA_VERSION
  scope: Readonly<{ userId: string; sessionId: string; turnId: string; taskId: string; stepId: string }>
  bindings: readonly Readonly<{
    key: string
    observationId: string
    toolCallId: string
    toolName: string
    sourceRef: string
    inputDigest: string
    resultDigest: string
  }>[]
}>
export type ScheduledPipelineCandidateUsage = Readonly<{
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
}>
export type ScheduledPipelineCandidatePayload = Readonly<{
  schemaVersion: typeof SCHEDULED_PIPELINE_CANDIDATE_SCHEMA | typeof LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA
  sessionId: string
  turnId: string
  rootTaskId: string
  rootAttemptCount: number
  finalStepId: string
  finalStepOrdinal: number
  stepAttempt: 1
  candidateText: string
  finishReason: string
  usage: ScheduledPipelineCandidateUsage | null
  sourceReceipt: ScheduledPipelineSourceReceipt | null
}>

/** Validates and copies the bounded source receipt; no input object or nested object is retained. */
export function parseScheduledPipelineSourceReceipt(value: unknown): ScheduledPipelineSourceReceipt | null {
  return parseSourceReceipt(value, false)?.receipt ?? null
}

type SourceReceiptParse = { receipt: ScheduledPipelineSourceReceipt | null }

function parseSourceReceipt(value: unknown, allowLegacyUnscoped: boolean): SourceReceiptParse | null {
  try {
    const root = decodeRecord(value)
    const plain = snapshotPlainRecord(root)
    const hasScope = Boolean(plain && Object.hasOwn(plain, 'scope'))
    const row = snapshotRecord(root, hasScope ? ['bindings', 'schemaVersion', 'scope'] : ['bindings', 'schemaVersion'])
    const scope = hasScope && row ? parseReceiptScope(row.scope) : null
    const rawBindings = row?.schemaVersion === SCHEDULED_PIPELINE_SOURCE_RECEIPT_SCHEMA_VERSION
      ? snapshotDenseArray(row.bindings, SCHEDULED_PIPELINE_SOURCE_RECEIPT_MAX_BINDINGS) : null
    if (!row || !rawBindings || hasScope && !scope || !hasScope && !allowLegacyUnscoped) return null

    const bindings: Array<ScheduledPipelineSourceReceipt['bindings'][number]> = []
    const keys = new Set<string>(), identities = new Set<string>(), calls = new Map<string, string>()
    for (const rawBinding of rawBindings) {
      const binding = snapshotRecord(rawBinding,
        ['inputDigest', 'key', 'observationId', 'resultDigest', 'sourceRef', 'toolCallId', 'toolName'])
      if (!binding || !validReceiptKey(binding.key) || !validIdentifier(binding.observationId, 256)
        || !validIdentifier(binding.toolCallId, 256) || typeof binding.toolName !== 'string' || !READ_SOURCE_TOOLS.has(binding.toolName)
        || !validSourceRef(binding.sourceRef) || !validDigest(binding.inputDigest) || !validDigest(binding.resultDigest)) return null

      const identity = JSON.stringify([binding.observationId, binding.toolCallId, binding.toolName, binding.sourceRef])
      const callIdentity = JSON.stringify([binding.observationId, binding.toolName, binding.inputDigest, binding.resultDigest])
      if (keys.has(binding.key) || identities.has(identity)
        || calls.has(binding.toolCallId) && calls.get(binding.toolCallId) !== callIdentity) return null
      keys.add(binding.key)
      identities.add(identity)
      calls.set(binding.toolCallId, callIdentity)
      bindings.push({ key: binding.key, observationId: binding.observationId, toolCallId: binding.toolCallId,
        toolName: binding.toolName, sourceRef: binding.sourceRef, inputDigest: binding.inputDigest, resultDigest: binding.resultDigest })
    }

    if (!scope) {
      const legacySerialized = JSON.stringify({ schemaVersion: SCHEDULED_PIPELINE_SOURCE_RECEIPT_SCHEMA_VERSION, bindings })
      if (!RuntimeTextEncoder || new RuntimeTextEncoder().encode(legacySerialized).byteLength > SCHEDULED_PIPELINE_SOURCE_RECEIPT_MAX_BYTES) return null
      return { receipt: null }
    }

    const receipt: ScheduledPipelineSourceReceipt = { schemaVersion: SCHEDULED_PIPELINE_SOURCE_RECEIPT_SCHEMA_VERSION, scope, bindings }
    const serialized = JSON.stringify(receipt)
    if (!RuntimeTextEncoder || new RuntimeTextEncoder().encode(serialized).byteLength > SCHEDULED_PIPELINE_SOURCE_RECEIPT_MAX_BYTES) return null
    return { receipt }
  } catch {
    return null
  }
}

/** Accepts strict v2 receipts and v3 candidate payloads while returning only normalized data. */
export function parseScheduledPipelineCandidatePayload(value: unknown): ScheduledPipelineCandidatePayload | null {
  try {
    const root = snapshotPlainRecord(decodeRecord(value))
    if (!root || (root.schemaVersion !== SCHEDULED_PIPELINE_CANDIDATE_SCHEMA
      && root.schemaVersion !== LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA)) return null
    const keys = root.schemaVersion === LEGACY_SCHEDULED_PIPELINE_CANDIDATE_SCHEMA
      ? Object.keys(root).sort().join(',') === LEGACY_CANDIDATE_KEYS
      : Object.keys(root).sort().join(',') === LEGACY_CANDIDATE_KEYS || Object.keys(root).sort().join(',') === RECEIPT_CANDIDATE_KEYS
    if (!keys) return null
    const row = root
    if (!nonempty(row.sessionId) || !nonempty(row.turnId) || !nonempty(row.rootTaskId) || !positive(row.rootAttemptCount)
      || !nonempty(row.finalStepId) || row.stepAttempt !== 1 || !Number.isSafeInteger(row.finalStepOrdinal)
      || Number(row.finalStepOrdinal) < 0 || !nonempty(row.candidateText) || !validFinishReason(row.finishReason)) return null

    const usage = row.usage === null ? null : parseUsage(row.usage)
    if (row.usage !== null && !usage) return null
    let sourceReceipt: ScheduledPipelineSourceReceipt | null = null
    if (row.schemaVersion === SCHEDULED_PIPELINE_CANDIDATE_SCHEMA && Object.hasOwn(row, 'sourceReceipt') && row.sourceReceipt !== null) {
      const parsedReceipt = parseSourceReceipt(row.sourceReceipt, true)
      if (!parsedReceipt) return null
      sourceReceipt = parsedReceipt.receipt
      if (sourceReceipt && (sourceReceipt.scope.sessionId !== row.sessionId || sourceReceipt.scope.turnId !== row.turnId
        || sourceReceipt.scope.taskId !== row.rootTaskId || sourceReceipt.scope.stepId !== row.finalStepId)) return null
    }

    return { schemaVersion: row.schemaVersion as ScheduledPipelineCandidatePayload['schemaVersion'],
      sessionId: row.sessionId, turnId: row.turnId, rootTaskId: row.rootTaskId, rootAttemptCount: Number(row.rootAttemptCount),
      finalStepId: row.finalStepId, finalStepOrdinal: Number(row.finalStepOrdinal), stepAttempt: 1,
      candidateText: row.candidateText, finishReason: row.finishReason, usage, sourceReceipt }
  } catch {
    return null
  }
}

interface TextEncoderLike { encode(input: string): Uint8Array }
const RuntimeTextEncoder = (globalThis as typeof globalThis & { TextEncoder?: new () => TextEncoderLike }).TextEncoder

function decodeRecord(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) as unknown } catch { return null }
}

function snapshotRecord(value: unknown, expected: readonly string[]): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length !== expected.length) return null
    const snapshot: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== 'string' || !expected.includes(key)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    return null
  }
}

function snapshotPlainRecord(value: unknown): Record<string, unknown> | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    const prototype = Object.getPrototypeOf(value)
    const keys = Reflect.ownKeys(value)
    if ((prototype !== Object.prototype && prototype !== null) || keys.length > RECEIPT_CANDIDATE_KEYS.split(',').length) return null
    const snapshot: Record<string, unknown> = {}
    for (const key of keys) {
      if (typeof key !== 'string') return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      snapshot[key] = descriptor.value
    }
    return snapshot
  } catch {
    return null
  }
}

function snapshotDenseArray(value: unknown, maxItems: number): unknown[] | null {
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return null
    const keys = Reflect.ownKeys(value)
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length')
    if (!lengthDescriptor || lengthDescriptor.enumerable || !Object.hasOwn(lengthDescriptor, 'value')
      || !Number.isSafeInteger(lengthDescriptor.value) || Number(lengthDescriptor.value) < 1
      || Number(lengthDescriptor.value) > maxItems || keys.length !== Number(lengthDescriptor.value) + 1) return null

    const length = Number(lengthDescriptor.value), snapshot: unknown[] = [], seen = new Set<number>()
    let sawLength = false
    for (const key of keys) {
      if (key === 'length') { sawLength = true; continue }
      if (typeof key !== 'string') return null
      const index = Number(key)
      if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key || seen.has(index)) return null
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null
      snapshot[index] = descriptor.value
      seen.add(index)
    }
    return sawLength && seen.size === length ? snapshot : null
  } catch {
    return null
  }
}

function parseUsage(value: unknown): ScheduledPipelineCandidateUsage | null {
  const row = snapshotRecord(value, ['estimatedCostUsd', 'inputTokens', 'outputTokens'])
  return row && nonnegativeInteger(row.inputTokens) && nonnegativeInteger(row.outputTokens)
    && typeof row.estimatedCostUsd === 'number' && Number.isFinite(row.estimatedCostUsd) && row.estimatedCostUsd >= 0
    ? { inputTokens: row.inputTokens, outputTokens: row.outputTokens, estimatedCostUsd: row.estimatedCostUsd } : null
}

function parseReceiptScope(value: unknown): ScheduledPipelineSourceReceipt['scope'] | null {
  const row = snapshotRecord(value, ['sessionId', 'stepId', 'taskId', 'turnId', 'userId'])
  return row && validIdentifier(row.userId, 256) && validIdentifier(row.sessionId, 256) && validIdentifier(row.turnId, 256)
    && validIdentifier(row.taskId, 256) && validIdentifier(row.stepId, 256)
    ? { userId: row.userId, sessionId: row.sessionId, turnId: row.turnId, taskId: row.taskId, stepId: row.stepId } : null
}

function positive(value: unknown): boolean { return Number.isSafeInteger(value) && Number(value) > 0 }
function nonnegativeInteger(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0 }
function validFinishReason(value: unknown): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 128 }
function validIdentifier(value: unknown, maxLength: number): value is string { return typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= maxLength }
function validReceiptKey(value: unknown): value is string { return typeof value === 'string' && /^E-[A-Za-z0-9_-]{1,126}$/.test(value) }
function validDigest(value: unknown): value is string { return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value) }
function validSourceRef(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 && value.split('/').length <= 8
    && value.split('/').every(segment => /^(?:[A-Za-z][A-Za-z0-9_-]{0,31}|(?:0|[1-9]\d{0,5}))$/.test(segment)
      && !['__proto__', 'prototype', 'constructor'].includes(segment))
}
