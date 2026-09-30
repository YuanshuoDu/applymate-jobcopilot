import { Buffer } from "node:buffer"

import type { StepContextSnapshot } from "./context/step-context-builder.js"

export type FinalCandidate = {
  readonly text: string
  readonly finishReason: string
  readonly evidenceRefs?: readonly string[]
}

export type FinalEvidence = {
  readonly id: string
  readonly status?: "verified" | "conflicting" | "missing"
}

export type BusinessCheck = {
  readonly name: string
  readonly ok: boolean
  readonly message?: string
}

export type FinalVerification =
  | { readonly ok: true; readonly evidenceRefs: readonly string[]; readonly businessChecks: readonly BusinessCheck[] }
  | { readonly ok: false; readonly code: "final_unverified" | "evidence_missing" | "evidence_conflict" | "business_precondition_failed"; readonly blocker: string; readonly feedback: string; readonly evidenceRefs: readonly string[]; readonly businessChecks: readonly BusinessCheck[] }

export type VerifyCandidateInput = {
  readonly goal: string
  readonly candidate: FinalCandidate
  readonly evidence?: readonly FinalEvidence[]
  readonly expectedEvidence?: readonly string[]
  readonly businessChecks?: readonly BusinessCheck[]
}

const MAX_READ_BYTES = 8 * 1024
const MAX_READ_ENTRIES = 50
const MAX_READ_TEXT = 256
const READ_TOOLS = new Set(["jobs.search", "jobs.get", "persona.retrieve", "resume.get_base"])
const FOREIGN_KEYS = new Set([
  "userId", "sessionId", "turnId", "stepId", "taskId", "parentTaskId", "rootTaskId", "ownerId",
  "lease", "leaseOwnerId", "leaseVersion", "idempotencyKey", "capabilities", "permissions", "allowedCapabilities",
  "budgetLimit", "maxBudget",
])
type ReadEvidenceKind = "job" | "persona" | "resume"

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

function plainJson(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true
  if (typeof value === "number") return Number.isFinite(value)
  if (typeof value !== "object" || depth > 32 || seen.has(value)) return false
  if (!Array.isArray(value) && !plainRecord(value)) return false
  seen.add(value)
  try { return (Array.isArray(value) ? value : Object.values(value)).every(item => plainJson(item, seen, depth + 1)) } finally { seen.delete(value) }
}

function foreignShape(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== "object") return false
  if (seen.has(value)) return true
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.some(item => foreignShape(item, seen))
    const record = plainRecord(value)
    return !record || Object.keys(record).some(key => FOREIGN_KEYS.has(key)) || Object.values(record).some(item => foreignShape(item, seen))
  } finally { seen.delete(value) }
}

function boundedJson(value: unknown): boolean {
  try {
    if (!plainJson(value) || foreignShape(value)) return false
    const encoded = JSON.stringify(value)
    return encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_READ_BYTES
  } catch {
    return false
  }
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_READ_TEXT
}

function projectReadOutput(toolName: string, output: unknown): FinalEvidence[] {
  if (!boundedJson(output)) return []
  const value = plainRecord(output)
  if (!value) return []
  const projected: Array<{ readonly kind: ReadEvidenceKind; readonly ref: string }> = []
  const add = (kind: ReadEvidenceKind, ref: unknown): boolean => {
    if (!boundedText(ref) || projected.length >= MAX_READ_ENTRIES) return false
    projected.push({ kind, ref })
    return true
  }
  if (toolName === "jobs.search") {
    if (!Array.isArray(value.jobs) || value.jobs.length > MAX_READ_ENTRIES) return []
    for (const item of value.jobs) { const job = plainRecord(item); if (!job || !add("job", job.id)) return [] }
  } else if (toolName === "jobs.get") {
    const job = value.job === null ? null : plainRecord(value.job)
    if (value.job !== null && (!job || !add("job", job.id))) return []
  } else if (toolName === "persona.retrieve") {
    if (!Array.isArray(value.facts) || value.facts.length > MAX_READ_ENTRIES) return []
    for (const item of value.facts) { const fact = plainRecord(item); if (!fact || !add("persona", fact.id)) return [] }
  } else if (toolName === "resume.get_base") {
    const resume = value.resume === null ? null : plainRecord(value.resume)
    if (value.resume !== null && (!resume || !add("resume", resume.id))) return []
  } else return []
  return projected.map(({ kind, ref }) => ({ id: `read:${kind}:${ref}`, status: "verified" as const }))
}

function readEvidence(content: unknown): FinalEvidence[] {
  try {
    const value = plainRecord(content)
    if (!value || typeof value.toolCallId !== "string" || !boundedText(value.toolCallId)
      || typeof value.toolName !== "string" || !READ_TOOLS.has(value.toolName)
      || value.status !== "completed" || value.errorCode !== null
      || !Object.prototype.hasOwnProperty.call(value, "input") || !Object.prototype.hasOwnProperty.call(value, "output")
      || !boundedJson(value.input) || !boundedJson(value.output)) return []
    return projectReadOutput(value.toolName, value.output)
  } catch {
    return []
  }
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))].sort()
}

export function snapshotEvidence(snapshot: StepContextSnapshot): FinalEvidence[] {
  const business = snapshot.businessRefs.map((reference) => ({ id: reference.id, status: "verified" as const }))
  const observations = snapshot.toolObservations.flatMap((observation) => {
    try {
      const content = plainRecord(observation.content)
      if (!content || typeof content.toolCallId !== "string") return []
      return [
        { id: content.toolCallId, status: content.status === "completed" ? "verified" as const : "conflicting" as const },
        ...readEvidence(content),
      ]
    } catch {
      return []
    }
  })
  return [...business, ...observations]
}

export function verifyCandidateFinal(input: VerifyCandidateInput): FinalVerification {
  const text = input.candidate.text.trim()
  const evidence = input.evidence ?? []
  const evidenceRefs = uniqueSorted(input.candidate.evidenceRefs ?? evidence.map((entry) => entry.id))
  const businessChecks = [...(input.businessChecks ?? [])].sort((left, right) => left.name.localeCompare(right.name))
  if (input.candidate.finishReason !== "stop" || text.length === 0) {
    return rejected("final_unverified", "The model did not provide a completed candidate response", "A final response requires a non-empty stop response", evidenceRefs, businessChecks)
  }
  const expected = uniqueSorted(input.expectedEvidence ?? [])
  const available = new Map(evidence.map((entry) => [entry.id, entry.status ?? "verified"]))
  const requiredRefs = uniqueSorted([...expected, ...evidenceRefs])
  const missing = requiredRefs.filter((id) => !available.has(id) || available.get(id) === "missing")
  if (missing.length > 0 || (expected.length === 0 && evidenceRefs.length === 0)) {
    const blocker = missing.length > 0 ? `Missing evidence: ${missing.join(", ")}` : "No verifiable evidence is attached to the candidate final"
    return rejected("evidence_missing", blocker, "Attach verified business or tool evidence before claiming completion", evidenceRefs, businessChecks)
  }
  const conflicting = requiredRefs.filter((id) => available.get(id) === "conflicting")
  if (conflicting.length > 0) return rejected("evidence_conflict", `Conflicting evidence: ${conflicting.join(", ")}`, "Resolve conflicting evidence before claiming completion", evidenceRefs, businessChecks)
  const failed = businessChecks.filter((check) => !check.ok)
  if (failed.length > 0) return rejected("business_precondition_failed", failed.map((check) => check.message ?? check.name).join("; "), "Complete the business prerequisites before claiming completion", evidenceRefs, businessChecks)
  return { ok: true, evidenceRefs, businessChecks }
}

function rejected(code: Extract<FinalVerification, { ok: false }>["code"], blocker: string, feedback: string, evidenceRefs: readonly string[], businessChecks: readonly BusinessCheck[]): Extract<FinalVerification, { ok: false }> {
  return { ok: false, code, blocker, feedback, evidenceRefs, businessChecks }
}
