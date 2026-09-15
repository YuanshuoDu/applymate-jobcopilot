import { Buffer } from "node:buffer"

import { validateRoleResult, type RoleEvidence, type StructuredRoleResult } from "./role-results.js"
import type { ContextSeedBlock } from "../context/step-context-builder.js"

const MAX_EVIDENCE_BYTES = 8 * 1024
const MAX_EVIDENCE_ENTRIES = 50
const MAX_EVIDENCE_FIELD_LENGTH = 256
const MAX_RESTORED_OBSERVATIONS = 256
const RESTORED_TOOL_KEYS = ["toolCallId", "toolName", "input", "status", "output", "errorCode"] as const
const RESTORED_READ_TOOLS = new Set(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base", "application.get_state", "tool_results.read"])
type ObservedEvidenceKind = "job" | "persona" | "resume"

export type ObservedEvidenceIndex = {
  readonly entries: Map<string, RoleEvidence>
  readonly conflicts: Set<string>
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  try {
    const prototype = Object.getPrototypeOf(value)
    return (prototype === Object.prototype || prototype === null) && Object.getOwnPropertySymbols(value).length === 0
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

function boundedText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_EVIDENCE_FIELD_LENGTH ? value : undefined
}

function evidenceKey(kind: string, ref: string): string { return `${kind}\u0000${ref}` }

export function createObservedEvidenceIndex(): ObservedEvidenceIndex { return { entries: new Map(), conflicts: new Set() } }

function plainJson(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false
  if (!Array.isArray(value)) {
    try {
      const prototype = Object.getPrototypeOf(value)
      if (prototype !== Object.prototype && prototype !== null) return false
    } catch { return false }
  }
  seen.add(value)
  try { return (Array.isArray(value) ? value : Object.values(value)).every(child => plainJson(child, seen, depth + 1)) } finally { seen.delete(value) }
}

function restoredObservation(value: ContextSeedBlock): { readonly toolName: string; readonly output: unknown; readonly failed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.id !== "string" || value.id.trim() !== value.id || value.id.length === 0 || value.id.length > MAX_EVIDENCE_FIELD_LENGTH) throw new Error("child_resume_evidence_invalid")
  const content = plainRecord(value.content)
  if (!content || Object.keys(content).length !== RESTORED_TOOL_KEYS.length || Object.keys(content).some(key => !(RESTORED_TOOL_KEYS as readonly string[]).includes(key))) throw new Error("child_resume_evidence_invalid")
  if (typeof content.toolCallId !== "string" || content.toolCallId.trim() !== content.toolCallId || content.toolCallId.length === 0 || content.toolCallId.length > MAX_EVIDENCE_FIELD_LENGTH
    || typeof content.toolName !== "string" || content.toolName.trim() !== content.toolName || content.toolName.length === 0 || content.toolName.length > MAX_EVIDENCE_FIELD_LENGTH
    || !RESTORED_READ_TOOLS.has(content.toolName) || !plainJson(content.input) || !plainJson(content.output)
    || (content.status !== "completed" && content.status !== "failed") || (content.status === "completed" ? content.errorCode !== null : typeof content.errorCode !== "string" || content.errorCode.trim().length === 0)) throw new Error("child_resume_evidence_invalid")
  const encoded = JSON.stringify(content)
  if (encoded === undefined || Buffer.byteLength(encoded, "utf8") > MAX_EVIDENCE_BYTES) throw new Error("child_resume_evidence_limit")
  return { toolName: content.toolName, output: content.output, failed: content.status === "failed" }
}

/** Rehydrates only server-shaped read results from a durable child attempt. */
export function hydrateObservedEvidence(index: ObservedEvidenceIndex, observations: readonly ContextSeedBlock[]): void {
  if (!Array.isArray(observations) || observations.length > MAX_RESTORED_OBSERVATIONS || index.conflicts.size > 0) throw new Error("child_resume_evidence_invalid")
  for (const observation of observations) {
    const restored = restoredObservation(observation)
    if (restored.failed) continue
    const conflictCount = index.conflicts.size
    recordReadToolOutput(index, restored.toolName, restored.output)
    if (index.conflicts.size !== conflictCount || index.conflicts.size > 0) throw new Error("child_resume_evidence_conflict")
  }
}

function addObservedEvidence(index: ObservedEvidenceIndex, kind: ObservedEvidenceKind, ref: string, source: string): void {
  const key = evidenceKey(kind, ref)
  if (index.conflicts.has(key)) return
  const existing = index.entries.get(key)
  if (existing) {
    if (existing.source !== source) { index.entries.delete(key); index.conflicts.add(key) }
    return
  }
  if (index.entries.size >= MAX_EVIDENCE_ENTRIES) return
  const entry: RoleEvidence = { id: `read:${kind}:${ref}`, kind, ref, source }
  const serialized = JSON.stringify([...index.entries.values(), entry])
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_EVIDENCE_BYTES) return
  index.entries.set(key, entry)
}

export function recordReadToolOutput(index: ObservedEvidenceIndex, toolName: string, output: unknown): void {
  try {
    const value = plainRecord(output)
    if (!value) return
    if (toolName === "jobs.search") {
      if (!Array.isArray(value.jobs)) return
      for (const item of value.jobs) {
        const job = plainRecord(item)
        const ref = boundedText(job?.id)
        if (ref) addObservedEvidence(index, "job", ref, boundedText(job?.source) ?? "jobs.read")
      }
      return
    }
    if (toolName === "jobs.get") {
      const job = plainRecord(value.job)
      const ref = boundedText(job?.id)
      if (ref) addObservedEvidence(index, "job", ref, boundedText(job?.source) ?? "jobs.read")
      return
    }
    if (toolName === "persona.retrieve") {
      if (!Array.isArray(value.facts)) return
      for (const item of value.facts) {
        const fact = plainRecord(item)
        const ref = boundedText(fact?.id)
        if (ref) addObservedEvidence(index, "persona", ref, boundedText(fact?.source) ?? "persona.retrieve")
      }
      return
    }
    if (toolName === "resume.get_base") {
      const resume = plainRecord(value.resume)
      const ref = boundedText(resume?.id)
      if (ref) addObservedEvidence(index, "resume", ref, "resume.get_base")
    }
  } catch {
    return
  }
}

function normalizeStructuredResult(value: StructuredRoleResult, index: ObservedEvidenceIndex): StructuredRoleResult | undefined {
  const canonicalByModelId = new Map<string, string>()
  const seenCanonical = new Set<string>()
  const evidence: RoleEvidence[] = []
  for (const item of value.evidence) {
    const key = evidenceKey(item.kind, item.ref)
    const observed = index.entries.get(key)
    if (!observed || index.conflicts.has(key) || seenCanonical.has(observed.id)) return undefined
    seenCanonical.add(observed.id)
    canonicalByModelId.set(item.id, observed.id)
    evidence.push(observed)
  }
  const rewriteEvidenceIds = (ids: readonly string[]): string[] | undefined => {
    const rewritten = ids.map(id => canonicalByModelId.get(id))
    return rewritten.every((id): id is string => typeof id === "string") ? rewritten : undefined
  }
  if (value.role === "scout") {
    const candidates = []
    for (const candidate of value.candidates) {
      const evidenceIds = rewriteEvidenceIds(candidate.evidenceIds)
      if (!evidenceIds) return undefined
      candidates.push({ ...candidate, evidenceIds })
    }
    return { ...value, candidates, evidence }
  }
  const findings = []
  for (const finding of value.findings) {
    const evidenceIds = rewriteEvidenceIds(finding.evidenceIds)
    if (!evidenceIds) return undefined
    findings.push({ ...finding, evidenceIds })
  }
  return { ...value, findings, evidence }
}

export function parseAndBindStructuredResult(value: string, role: "scout" | "analyst", index: ObservedEvidenceIndex): StructuredRoleResult | undefined {
  if (Buffer.byteLength(value, "utf8") > MAX_EVIDENCE_BYTES) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(value) as unknown
  } catch {
    return undefined
  }
  try {
    const validated = validateRoleResult(parsed, role)
    const normalized = normalizeStructuredResult(validated, index)
    if (!normalized) return undefined
    const rebound = validateRoleResult(normalized, role)
    const serialized = JSON.stringify(rebound)
    return serialized !== undefined && Buffer.byteLength(serialized, "utf8") <= MAX_EVIDENCE_BYTES ? rebound : undefined
  } catch {
    return undefined
  }
}
