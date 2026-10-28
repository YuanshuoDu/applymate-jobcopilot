import { Buffer } from "node:buffer"
import {
  ANSWER_EVIDENCE_MAX_SOURCES, ANSWER_EVIDENCE_MAX_TOTAL_EXCERPT_CHARACTERS, ANSWER_EVIDENCE_SCHEMA_VERSION,
  parseAnswerEvidence, type AnswerEvidence, type AnswerEvidenceKind, type AnswerEvidenceSource,
} from "@jobcopilot/agent-protocol"
import type { HarnessModelRequest } from "@jobcopilot/agent-model"
import type { ContextSeedBlock, StepContextSnapshot } from "../context/step-context-builder.js"
import { snapshotEvidence } from "../verifier.js"
import {
  captureEvidenceArray, captureEvidenceJson, captureEvidenceRecord, captureEvidenceRequestPairs,
  captureFinalAnswerEvidenceScope, evidenceDigest, evidenceReferenceKey, evidenceScopeDigest,
  modelRequestMatchesEvidenceScope, sameFinalAnswerEvidenceScope, stableAnswerEvidenceJson,
  type FinalAnswerEvidenceScope,
} from "./final-answer-evidence-json.js"
import { isSafeAnswerEvidenceDisplayText, projectFinalAnswerEvidenceSources, type ProjectedAnswerEvidence } from "./final-answer-evidence-projection.js"
const READ_TOOLS = new Set(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"])
const MAX_JSON_BYTES = 8 * 1024
const MAX_RECEIPT_BYTES = 6 * 1024
const RECEIPT_VERSION = 1 as const
const MODEL_KEY = /^E-[a-f0-9]{64}$/
const DIGEST = /^sha256:[a-f0-9]{64}$/
const RECEIPT_MAPS = new WeakSet<object>()

export type FinalAnswerEvidenceReceiptBinding = Readonly<{
  key: string; observationId: string; toolCallId: string; toolName: string; sourceRef: string; inputDigest: string; resultDigest: string
}>
export type FinalAnswerEvidenceReceipt = Readonly<{
  schemaVersion: 1; scope: FinalAnswerEvidenceScope; bindings: readonly FinalAnswerEvidenceReceiptBinding[]
}>
export type FinalAnswerEvidenceBinding = FinalAnswerEvidenceReceiptBinding & Readonly<Pick<AnswerEvidenceSource, "kind" | "label" | "excerpt">>
export type FinalAnswerEvidenceBindingMap = Readonly<{
  bindings: readonly FinalAnswerEvidenceBinding[]; sourceReceipt: FinalAnswerEvidenceReceipt; promptInstruction: string
}>
type Observation = Readonly<{ observationId: string; toolCallId: string; toolName: string; input: unknown; output: unknown }>
type Inventory = { observations: Observation[]; observationIds: string[]; callIds: string[] }

/** Maps only exact tool pairs from the model request built against this same-step snapshot. */
export function buildFinalAnswerEvidenceBindingMap(request: HarnessModelRequest, snapshot: StepContextSnapshot,
  expectedScope: FinalAnswerEvidenceScope): FinalAnswerEvidenceBindingMap | null {
  try {
    const scope = captureFinalAnswerEvidenceScope(expectedScope)
    if (!scope || !modelRequestMatchesEvidenceScope(request.metadata, scope)) return null
    const pairs = captureEvidenceRequestPairs(request.messages), inventory = snapshotObservations(snapshot)
    if (!pairs || !inventory) return null
    const callCounts = counts(inventory.callIds), observationCounts = counts(inventory.observationIds)
    const candidates: FinalAnswerEvidenceBinding[] = []
    for (const observation of inventory.observations) {
      if (callCounts.get(observation.toolCallId) !== 1 || observationCounts.get(observation.observationId) !== 1) continue
      const pair = pairs.get(observation.toolCallId)
      if (!pair || pair.uses.length !== 1 || pair.results.length !== 1) continue
      const [use] = pair.uses, [result] = pair.results
      if (use.name !== observation.toolName || result.isError === true || !jsonWithinBound(use.input) || !jsonWithinBound(observation.output)
        || stableAnswerEvidenceJson(use.input) !== stableAnswerEvidenceJson(observation.input)) continue
      const resultJson = stableAnswerEvidenceJson(observation.output)
      if (result.content !== resultJson || Buffer.byteLength(result.content, "utf8") > MAX_JSON_BYTES) continue
      const inputDigest = evidenceDigest(stableAnswerEvidenceJson(use.input)), resultDigest = evidenceDigest(result.content)
      const projected = projectFinalAnswerEvidenceSources(observation.toolName, observation.output, [observation.observationId, observation.toolCallId])
      if (!eligibleReadOutput(snapshot, observation, projected)) continue
      for (const source of projected) candidates.push(binding(scope, observation, source, inputDigest, resultDigest))
    }
    return bindingMap(candidates, scope)
  } catch { return null }
}

/** Restores only a candidate's explicit persisted receipt; a snapshot alone never creates model keys. */
export function restoreFinalAnswerEvidenceBindingMap(snapshot: StepContextSnapshot, value: unknown,
  expectedScope: FinalAnswerEvidenceScope): FinalAnswerEvidenceBindingMap | null {
  const receipt = parseReceipt(value)
  if (!receipt) return null
  try {
    const scope = captureFinalAnswerEvidenceScope(expectedScope)
    if (!scope || !sameFinalAnswerEvidenceScope(receipt.scope, scope)) return null
    const scopeDigest = evidenceScopeDigest(scope)
    const inventory = snapshotObservations(snapshot)
    if (!inventory) return null
    const byId = new Map<string, Observation[]>()
    for (const observation of inventory.observations) add(byId, observation.observationId, observation)
    const bindings: FinalAnswerEvidenceBinding[] = []
    for (const item of receipt.bindings) {
      const matches = byId.get(item.observationId) ?? []
      if (matches.length !== 1 || counts(inventory.callIds).get(item.toolCallId) !== 1) return null
      const observation = matches[0]!
      if (observation.toolCallId !== item.toolCallId || observation.toolName !== item.toolName
        || evidenceDigest(stableAnswerEvidenceJson(observation.input)) !== item.inputDigest
        || evidenceDigest(stableAnswerEvidenceJson(observation.output)) !== item.resultDigest) return null
      const projected = projectFinalAnswerEvidenceSources(observation.toolName, observation.output, [observation.observationId, observation.toolCallId])
      const source = projected.find(candidate => candidate.sourceRef === item.sourceRef)
      if (!source || !eligibleReadOutput(snapshot, observation, [source])) return null
      const expected = receiptBinding(scopeDigest, observation, item.sourceRef, item.inputDigest, item.resultDigest)
      if (expected.key !== item.key) return null
      bindings.push({ ...item, kind: source.kind, label: source.label, excerpt: source.excerpt })
    }
    return bindingMap(bindings, scope)
  } catch { return null }
}

/** Rewrites only explicitly bound markers; unknown or malformed markers are removed. */
export function resolveFinalAnswerEvidenceMarkers(text: string, map: FinalAnswerEvidenceBindingMap | null | undefined): {
  text: string; answerEvidence?: AnswerEvidence
} {
  const available = validatedBindings(map), selected = new Map<string, FinalAnswerEvidenceBinding>()
  let output = text.replace(/\[\[source:([^\]]*)(?:\]\]?|$)/g, (_marker, key: string) => {
    if (!MODEL_KEY.test(key) || !available.has(key)) return ""
    const binding = available.get(key)!
    if (!selected.has(key) && selected.size < ANSWER_EVIDENCE_MAX_SOURCES) selected.set(key, binding)
    const index = [...selected.keys()].indexOf(key) + 1
    return index ? `[[source:S${index}]]` : ""
  })
  const sources: AnswerEvidenceSource[] = []
  for (const binding of selected.values()) sources.push({ key: `S${sources.length + 1}`, kind: binding.kind, label: binding.label, excerpt: binding.excerpt })
  const answerEvidence = sources.length ? parseAnswerEvidence({ schemaVersion: ANSWER_EVIDENCE_SCHEMA_VERSION, sources }) : null
  if (sources.length && !answerEvidence) output = output.replace(/\[\[source:S[1-8]\]\]/g, "")
  return { text: output, ...(answerEvidence ? { answerEvidence } : {}) }
}

function bindingMap(input: readonly FinalAnswerEvidenceBinding[], scope: FinalAnswerEvidenceScope): FinalAnswerEvidenceBindingMap | null {
  const sorted = [...input].sort((a, b) => compare(a.toolCallId, b.toolCallId) || compare(a.sourceRef, b.sourceRef) || compare(a.observationId, b.observationId))
  const bindings: FinalAnswerEvidenceBinding[] = [], keys = new Set<string>(), identities = new Set<string>()
  const keyCounts = counts(input.map(item => item.key)), duplicateKeys = new Set<string>()
  for (const [key, count] of keyCounts) if (count > 1) duplicateKeys.add(key)
  let excerptChars = 0
  for (const item of sorted) {
    const identity = `${item.observationId}\0${item.toolCallId}\0${item.sourceRef}`
    if (duplicateKeys.has(item.key) || keys.has(item.key) || identities.has(identity)
      || excerptChars + charCount(item.excerpt) > ANSWER_EVIDENCE_MAX_TOTAL_EXCERPT_CHARACTERS) continue
    const next = [...bindings, item], receipt = makeReceipt(next, scope)
    if (next.length > ANSWER_EVIDENCE_MAX_SOURCES || !receipt || bytes(receipt) > MAX_RECEIPT_BYTES) continue
    bindings.push(Object.freeze({ ...item })); keys.add(item.key); identities.add(identity); excerptChars += charCount(item.excerpt)
  }
  const sourceReceipt = makeReceipt(bindings, scope)
  if (!bindings.length || !sourceReceipt || bytes(sourceReceipt) > MAX_RECEIPT_BYTES) return null
  const promptMap = bindings.map(item => `${item.key} -> tool=${item.toolName} record=${item.sourceRef}`).join("\n")
  const output: FinalAnswerEvidenceBindingMap = Object.freeze({ bindings: Object.freeze(bindings), sourceReceipt,
    promptInstruction: `For claims based on the visible read-tool results, place [[source:<key>]] beside the associated claim. These are model-selected source attributions, not independent verification. Use only these exact key-to-record bindings; do not invent keys:\n${promptMap}` })
  RECEIPT_MAPS.add(output)
  return output
}

function makeReceipt(bindings: readonly FinalAnswerEvidenceReceiptBinding[], scope: FinalAnswerEvidenceScope): FinalAnswerEvidenceReceipt | null {
  const copy = bindings.map(({ key, observationId, toolCallId, toolName, sourceRef, inputDigest, resultDigest }) =>
    Object.freeze({ key, observationId, toolCallId, toolName, sourceRef, inputDigest, resultDigest }))
  const receipt = Object.freeze({ schemaVersion: RECEIPT_VERSION, scope, bindings: Object.freeze(copy) })
  return bytes(receipt) <= MAX_RECEIPT_BYTES ? receipt : null
}

function validatedBindings(map: FinalAnswerEvidenceBindingMap | null | undefined): Map<string, FinalAnswerEvidenceBinding> {
  if (!map || !RECEIPT_MAPS.has(map as object)) return new Map()
  const receipt = parseReceipt(map.sourceReceipt)
  if (!receipt || receipt.bindings.length !== map.bindings.length) return new Map()
  const allowed = new Map(receipt.bindings.map(item => [item.key, item] as const)), result = new Map<string, FinalAnswerEvidenceBinding>()
  for (const item of map.bindings) {
    const stored = allowed.get(item.key)
    if (!stored || !sameReceiptBinding(item, stored)
      || !isSafeAnswerEvidenceDisplayText(item.label, 120, [item.observationId, item.toolCallId])
      || !isSafeAnswerEvidenceDisplayText(item.excerpt, 600, [item.observationId, item.toolCallId])) return new Map()
    result.set(item.key, item)
  }
  return result.size === receipt.bindings.length ? result : new Map()
}

function snapshotObservations(snapshot: StepContextSnapshot): Inventory | null {
  const blocks = captureEvidenceArray(snapshot.toolObservations, 2_048)
  if (!blocks) return null
  const inventory: Inventory = { observations: [], observationIds: [], callIds: [] }
  for (const raw of blocks) {
    const block = captureEvidenceRecord(raw, ["id", "content"]), content = block && captureEvidenceRecord(block.content)
    if (!block || !stringId(block.id)) return null
    inventory.observationIds.push(block.id)
    if (!content) continue
    if (typeof content.toolCallId === "string") {
      if (!stringId(content.toolCallId)) return null
      inventory.callIds.push(content.toolCallId)
    }
    if (typeof block.id !== "string" || typeof content.toolCallId !== "string" || typeof content.toolName !== "string"
      || !READ_TOOLS.has(content.toolName) || !exactKeys(content, ["toolCallId", "toolName", "input", "status", "output", "errorCode"])
      || content.status !== "completed" || content.errorCode !== null) continue
    const input = captureEvidenceJson(content.input), output = captureEvidenceJson(content.output)
    if (!input || !output) continue
    inventory.observations.push({ observationId: block.id, toolCallId: content.toolCallId, toolName: content.toolName, input, output })
  }
  return inventory
}

function eligibleReadOutput(snapshot: StepContextSnapshot, observation: Observation, sources: readonly ProjectedAnswerEvidence[]): boolean {
  if (!sources.length) return false
  const block: ContextSeedBlock = { id: observation.observationId, content: { toolCallId: observation.toolCallId, toolName: observation.toolName,
    input: observation.input, status: "completed", output: observation.output, errorCode: null } }
  const evidence = snapshotEvidence({ ...snapshot, businessRefs: [], toolObservations: [block] })
  return sources.every(source => evidence.some(item => item.id === `read:${source.kind}:${source.sourceId}`))
}

function binding(scope: FinalAnswerEvidenceScope, observation: Observation, source: ProjectedAnswerEvidence,
  inputDigest: string, resultDigest: string): FinalAnswerEvidenceBinding {
  const scopeDigest = evidenceScopeDigest(scope)
  return { ...receiptBinding(scopeDigest, observation, source.sourceRef, inputDigest, resultDigest),
    kind: source.kind, label: source.label, excerpt: source.excerpt }
}
function receiptBinding(scopeDigest: string, observation: Observation, sourceRef: string, inputDigest: string,
  resultDigest: string): FinalAnswerEvidenceReceiptBinding {
  return { key: evidenceReferenceKey(scopeDigest, observation.observationId, observation.toolCallId, observation.toolName, sourceRef, inputDigest, resultDigest),
    observationId: observation.observationId, toolCallId: observation.toolCallId, toolName: observation.toolName, sourceRef, inputDigest, resultDigest }
}
function parseReceipt(value: unknown): FinalAnswerEvidenceReceipt | null {
  const row = captureEvidenceRecord(value, ["schemaVersion", "scope", "bindings"])
  const scope = row && captureFinalAnswerEvidenceScope(row.scope), raw = row && captureEvidenceArray(row.bindings, ANSWER_EVIDENCE_MAX_SOURCES)
  if (!row || row.schemaVersion !== RECEIPT_VERSION || !scope || !raw?.length) return null
  const scopeDigest = evidenceScopeDigest(scope)
  const bindings: FinalAnswerEvidenceReceiptBinding[] = [], keys = new Set<string>(), identities = new Set<string>()
  for (const value of raw) {
    const item = captureEvidenceRecord(value, ["key", "observationId", "toolCallId", "toolName", "sourceRef", "inputDigest", "resultDigest"])
    if (!item || typeof item.key !== "string" || !MODEL_KEY.test(item.key) || !stringId(item.observationId) || !stringId(item.toolCallId)
      || typeof item.toolName !== "string" || !READ_TOOLS.has(item.toolName) || !validSourceRef(item.toolName, item.sourceRef)
      || typeof item.inputDigest !== "string" || !DIGEST.test(item.inputDigest) || typeof item.resultDigest !== "string" || !DIGEST.test(item.resultDigest)) return null
    const identity = JSON.stringify([item.observationId, item.toolCallId, item.toolName, item.sourceRef])
    if (keys.has(item.key) || identities.has(identity)
      || item.key !== evidenceReferenceKey(scopeDigest, item.observationId, item.toolCallId, item.toolName, item.sourceRef, item.inputDigest, item.resultDigest)) return null
    keys.add(item.key); identities.add(identity)
    bindings.push({ key: item.key, observationId: item.observationId, toolCallId: item.toolCallId, toolName: item.toolName, sourceRef: item.sourceRef,
      inputDigest: item.inputDigest, resultDigest: item.resultDigest })
  }
  const receipt = makeReceipt(bindings, scope)
  return receipt && bytes(receipt) <= MAX_RECEIPT_BYTES ? receipt : null
}

function validSourceRef(tool: string, ref: unknown): ref is string {
  if (typeof ref !== "string") return false
  if (tool === "jobs.get") return ref === "job"
  if (tool === "resume.get_base") return ref === "resume"
  const prefix = tool === "jobs.search" ? "jobs" : "facts"
  return new RegExp(`^${prefix}/(?:0|[1-9]\\d{0,1})$`).test(ref)
}
function exactKeys(row: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(row).length === keys.length && keys.every(key => Object.hasOwn(row, key)) }
function sameReceiptBinding(a: FinalAnswerEvidenceReceiptBinding, b: FinalAnswerEvidenceReceiptBinding): boolean {
  return a.key === b.key && a.observationId === b.observationId && a.toolCallId === b.toolCallId && a.toolName === b.toolName
    && a.sourceRef === b.sourceRef && a.inputDigest === b.inputDigest && a.resultDigest === b.resultDigest
}
function stringId(value: unknown): value is string { return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 }
function counts(values: readonly string[]): Map<string, number> { const result = new Map<string, number>(); for (const value of values) result.set(value, (result.get(value) ?? 0) + 1); return result }
function add<K, V>(map: Map<K, V[]>, key: K, value: V): void { const values = map.get(key) ?? []; values.push(value); map.set(key, values) }
function bytes(value: unknown): number { return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8") }
function charCount(value: string): number { let count = 0; for (const _ of value) count++; return count }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0 }
function jsonWithinBound(value: unknown): boolean { return captureEvidenceJson(value, MAX_JSON_BYTES) !== null }
