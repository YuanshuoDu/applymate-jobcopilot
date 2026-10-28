import { redactSensitiveText } from "@jobcopilot/shared"
import type { AnswerEvidenceKind } from "@jobcopilot/agent-protocol"
import { captureEvidenceArray, captureEvidenceJson, captureEvidenceRecord } from "./final-answer-evidence-json.js"
const PRIVATE_TEXT = /(?:https?:\/\/|ftp:\/\/|\bwww\.|\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b|(?:^|[^\w-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?=$|[^\w-])|\bsha256:[a-f0-9]{64}\b|\b(?:source[_ -]?digest|tool[_ -]?call[_ -]?id|call[_ -]?id)\b|\b\d{7,}\b)/i
const CUID = /(?:^|[^a-z0-9])c[a-z0-9]{24}(?:$|[^a-z0-9])/i
const OPAQUE_TOKEN = /(?:^|[^a-z0-9])[a-z0-9]{20,}(?:$|[^a-z0-9])/i
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i
const ADDRESS = /\b\d{1,6}\s+(?:[a-z0-9.'-]+\s+){0,4}(?:street|st|road|rd|avenue|ave|lane|ln|drive|dr|court|ct|crescent|close|boulevard|blvd)\b/i
const SAFE_FIELD = /^[\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}\s&,'’()+/#.-]{0,199}$/u
const CONTACT_WORDS = new Set(["contact", "name", "first", "last", "given", "surname", "email", "phone", "mobile", "telephone", "address", "birth", "gender", "identity"])
const PERSONA_LABELS: Readonly<Record<string, string>> = Object.freeze({
  target_role: "Target role", target_roles: "Target roles", preferred_role: "Preferred role",
  preferred_roles: "Preferred roles", target_location: "Target location", target_locations: "Target locations",
  preferred_location: "Preferred location", preferred_locations: "Preferred locations",
  skills: "Candidate skills", languages: "Candidate languages",
})

export type ProjectedAnswerEvidence = Readonly<{
  sourceRef: string; sourceId: string; kind: AnswerEvidenceKind; label: string; excerpt: string
}>
/** Rechecks already projected display text before a caller accepts a binding map. */
export function isSafeAnswerEvidenceDisplayText(value: unknown, max: number, protectedIds: readonly string[]): value is string {
  return typeof value === "string" && safeDisplay(value, max, protectedIds) === value
}

/** Projects only explicitly approved display fields; unknown source shapes produce no excerpts. */
export function projectFinalAnswerEvidenceSources(toolName: string, output: unknown, protectedIds: readonly string[] = []): ProjectedAnswerEvidence[] {
  const captured = captureEvidenceJson(output)
  const root = object(captured)
  if (!root) return []
  const ids = [...protectedIds, ...collectIds(captured)]
  const outputSources: ProjectedAnswerEvidence[] = []
  if (toolName === "jobs.search" && exactKeys(root, ["jobs", "page", "hasMore"])) {
    const jobs = captureEvidenceArray(root.jobs, 50)
    if (!jobs || !Number.isSafeInteger(root.page) || typeof root.hasMore !== "boolean") return []
    const seen = new Set<string>()
    for (let index = 0; index < jobs.length; index += 1) {
      const job = object(jobs[index])
      if (!job || !validJob(job) || seen.has(job.id as string)) return []
      seen.add(job.id as string)
      const source = jobSource(job, `jobs/${index}`, ids)
      if (source) outputSources.push(source)
    }
  } else if (toolName === "jobs.get" && exactKeys(root, ["job"])) {
    if (root.job !== null) {
      const job = object(root.job)
      if (!job || !validJob(job)) return []
      const source = jobSource(job, "job", ids)
      if (source) outputSources.push(source)
    }
  } else if (toolName === "persona.retrieve" && exactKeys(root, ["facts"])) {
    const facts = captureEvidenceArray(root.facts, 50)
    if (!facts) return []
    const seen = new Set<string>()
    for (let index = 0; index < facts.length; index += 1) {
      const fact = object(facts[index])
      if (!fact || !validPersonaFact(fact) || seen.has(fact.id as string)) return []
      seen.add(fact.id as string)
      if (isContactFact(fact)) continue
      const label = PERSONA_LABELS[fact.key as string]
      const value = label && safeField(fact.value, 200, ids)
      if (label && value) {
        const source = makeSource(`facts/${index}`, fact.id as string, "persona", label, `${label}: ${value}`, ids)
        if (source) outputSources.push(source)
      }
    }
  } else if (toolName === "resume.get_base" && exactKeys(root, ["resume"])) {
    if (root.resume !== null) {
      const resume = object(root.resume)
      if (!resume || !validResume(resume)) return []
      const excerpt = resumeExcerpt(resume.content, ids)
      if (excerpt) {
        const source = makeSource("resume", resume.id as string, "resume", "Base resume", excerpt, ids)
        if (source) outputSources.push(source)
      }
    }
  }
  return outputSources
}

function jobSource(job: Record<string, unknown>, sourceRef: string, ids: readonly string[]): ProjectedAnswerEvidence | null {
  const role = safeField(job.role, 120, ids), company = safeField(job.company, 120, ids)
  if (!role || !company) return null
  const location = typeof job.location === "string" ? safeField(job.location, 100, ids) : null
  const excerpt = [`Role: ${role}`, `Company: ${company}`, ...(location ? [`Location: ${location}`] : [])].join(" · ")
  return makeSource(sourceRef, job.id as string, "job", "Job listing", excerpt, ids)
}

function resumeExcerpt(value: unknown, ids: readonly string[]): string | null {
  const content = object(value)
  if (!content) return null
  const parts: string[] = []
  if (Object.hasOwn(content, "skills")) {
    const skills = captureEvidenceArray(content.skills, 50)
    if (!skills) return null
    const selected = skills.slice(0, 8).flatMap(skill => { const safe = safeField(skill, 80, ids); return safe ? [safe] : [] })
    if (selected.length) parts.push(`Skills: ${selected.join(", ")}`)
  }
  if (Object.hasOwn(content, "experience")) {
    const experience = captureEvidenceArray(content.experience, 50)
    if (!experience) return null
    const rows: string[] = []
    for (const raw of experience.slice(0, 3)) {
      const row = object(raw)
      if (!row) continue
      const role = Object.hasOwn(row, "role") ? safeField(row.role, 100, ids) : null
      const company = Object.hasOwn(row, "company") ? safeField(row.company, 100, ids) : null
      if (role || company) rows.push([role, company].filter((part): part is string => Boolean(part)).join(" at "))
    }
    if (rows.length) parts.push(`Experience: ${rows.join("; ")}`)
  }
  return parts.length ? parts.join(" · ") : null
}

function makeSource(sourceRef: string, sourceId: string, kind: AnswerEvidenceKind, label: string, excerpt: string, ids: readonly string[]): ProjectedAnswerEvidence | null {
  const safeLabel = safeDisplay(label, 120, ids), safeExcerpt = safeDisplay(excerpt, 600, ids)
  return safeLabel && safeExcerpt ? { sourceRef, sourceId, kind, label: safeLabel, excerpt: safeExcerpt } : null
}

function safeField(value: unknown, max: number, ids: readonly string[]): string | null {
  if (typeof value !== "string" || /[\u0000-\u001f\u007f]/.test(value)) return null
  const normalized = value.trim().replace(/\s+/g, " ")
  if (!normalized || normalized.length > max || !SAFE_FIELD.test(normalized)) return null
  return safeDisplay(normalized, max, ids)
}

function safeDisplay(value: string, max: number, ids: readonly string[]): string | null {
  if (!value || value.length > max || redactSensitiveText(value) !== value || PRIVATE_TEXT.test(value)
    || CUID.test(value) || OPAQUE_TOKEN.test(value) || UUID.test(value) || ADDRESS.test(value) || containsKnownId(value, ids)) return null
  return value
}

function containsKnownId(value: string, ids: readonly string[]): boolean {
  const lower = value.toLowerCase()
  return ids.some(id => id && (id.length > 2 ? lower.includes(id.toLowerCase()) : new RegExp(`(?:^|[^a-z0-9])${escapeRegex(id)}(?:$|[^a-z0-9])`, "i").test(value)))
}

function collectIds(value: unknown): string[] {
  const found = new Set<string>()
  const visit = (item: unknown): void => {
    if (Array.isArray(item)) { for (const child of item) visit(child); return }
    const record = object(item)
    if (!record) return
    for (const [key, child] of Object.entries(record)) {
      if (typeof child === "string" && /^(?:id|.*(?:Id|ID|_id|_ID|Ref|_ref))$/.test(key)) found.add(child)
      else visit(child)
    }
  }
  visit(value)
  return [...found]
}

function validJob(row: Record<string, unknown>): boolean {
  return exactKeys(row, ["id", "company", "role", "location", "status", "score", "url", "source", "salary", "description", "keywords"])
    && nonempty(row.id, 256) && typeof row.company === "string" && typeof row.role === "string"
    && nullableString(row.location) && typeof row.status === "string" && (row.score === null || typeof row.score === "number" && Number.isFinite(row.score))
    && nullableString(row.url) && nullableString(row.source) && nullableString(row.salary) && nullableString(row.description) && nullableString(row.keywords)
}
function validPersonaFact(row: Record<string, unknown>): boolean {
  return exactKeys(row, ["id", "key", "category", "value", "source", "sourceRef", "confidence", "allowedUses"])
    && nonempty(row.id, 256) && nonempty(row.key, 128) && typeof row.category === "string" && typeof row.value === "string"
    && typeof row.source === "string" && nullableString(row.sourceRef) && typeof row.confidence === "number" && Number.isFinite(row.confidence)
    && Array.isArray(row.allowedUses) && row.allowedUses.length <= 30 && row.allowedUses.every(item => typeof item === "string")
}
function validResume(row: Record<string, unknown>): boolean {
  return exactKeys(row, ["id", "name", "kind", "origin", "isDefault", "content", "createdAt", "updatedAt"])
    && nonempty(row.id, 256) && typeof row.name === "string" && row.kind === "base" && typeof row.origin === "string"
    && typeof row.isDefault === "boolean" && !!object(row.content) && typeof row.createdAt === "string" && typeof row.updatedAt === "string"
}
function isContactFact(fact: Record<string, unknown>): boolean {
  for (const value of [fact.key, fact.category]) {
    if (typeof value !== "string") continue
    const words = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    if (words.some(word => CONTACT_WORDS.has(word))) return true
  }
  return false
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value)
  return keys.length === expected.length && keys.every(key => typeof key === "string" && expected.includes(key))
}
function nullableString(value: unknown): boolean { return value === null || typeof value === "string" }
function nonempty(value: unknown, max: number): value is string { return typeof value === "string" && value.length > 0 && value.length <= max }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") }
