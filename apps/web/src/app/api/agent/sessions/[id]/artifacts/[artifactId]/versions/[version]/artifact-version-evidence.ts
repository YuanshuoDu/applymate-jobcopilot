export const MAX_SOURCE_EVIDENCE_ITEM_CHARS = 600

const MAX_REFS = 32
const MAX_SOURCE_EVIDENCE_ITEMS = 8
const MAX_SOURCE_EVIDENCE_TOTAL_CHARS = 3_000

type SourceKind = "job" | "resume" | "persona"

export type SourceEvidenceItem = {
  readonly kind: SourceKind
  readonly label: string
  readonly text: string
}

export type SelectedSourceSnapshot = {
  readonly digest: string
  readonly byRef: ReadonlyMap<string, SourceEvidenceItem>
}

export type ProjectedSourceEvidence = {
  readonly freshness: "current" | "stale" | "unavailable"
  readonly items: Array<{
    readonly reference: string
    readonly kind: SourceKind
    readonly label: string
    readonly text: string
  }>
}

export function boundedRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_REFS).filter((entry): entry is string =>
    typeof entry === "string" && entry.length > 0 && entry.length <= 256 && entry.trim() === entry,
  )
}

export function projectSourceEvidence(
  artifact: { readonly sourceDigest: string; readonly evidenceRefs: unknown; readonly provenanceRefs: unknown },
  snapshot: SelectedSourceSnapshot | null,
  isCurrentVersion: boolean,
): ProjectedSourceEvidence {
  if (!isCurrentVersion) return { freshness: "stale", items: [] }
  if (!snapshot) return { freshness: "unavailable", items: [] }
  if (snapshot.digest !== artifact.sourceDigest) return { freshness: "stale", items: [] }

  const refs = [...new Set([...boundedRefs(artifact.evidenceRefs), ...boundedRefs(artifact.provenanceRefs)])]
  if (refs.length === 0 || refs.some(reference => !snapshot.byRef.has(reference))) {
    return { freshness: "unavailable", items: [] }
  }

  const items: ProjectedSourceEvidence["items"] = []
  let totalChars = 0
  for (const reference of refs.slice(0, MAX_SOURCE_EVIDENCE_ITEMS)) {
    const source = snapshot.byRef.get(reference)
    if (!source) return { freshness: "unavailable", items: [] }
    const text = safeEvidencePreview(
      source.text,
      Math.min(MAX_SOURCE_EVIDENCE_ITEM_CHARS, MAX_SOURCE_EVIDENCE_TOTAL_CHARS - totalChars),
    )
    if (!text) continue
    items.push({ reference, kind: source.kind, label: safeEvidencePreview(source.label, 80), text })
    totalChars += text.length
    if (totalChars >= MAX_SOURCE_EVIDENCE_TOTAL_CHARS) break
  }
  return { freshness: "current", items }
}

export function resumeEvidenceText(value: unknown): string {
  const resume = record(value)
  const parts: string[] = []
  if (typeof resume.summary === "string") parts.push(resume.summary)
  if (Array.isArray(resume.skills)) {
    const skills = resume.skills.filter((skill): skill is string =>
      typeof skill === "string" && skill.trim().length > 0,
    ).slice(0, 4)
    if (skills.length) parts.push("Skills: " + skills.join(", "))
  }
  if (Array.isArray(resume.experience)) {
    for (const item of resume.experience.slice(0, 2)) {
      const row = record(item)
      const role = [row.role, row.company]
        .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
        .join(" at ")
      const bullets = Array.isArray(row.bullets)
        ? row.bullets.filter((bullet): bullet is string =>
          typeof bullet === "string" && bullet.trim().length > 0,
        ).slice(0, 2)
        : []
      if (role) parts.push(role + (bullets.length ? ": " + bullets.join("; ") : ""))
    }
  }
  return safeEvidencePreview(parts.join(" · "), MAX_SOURCE_EVIDENCE_ITEM_CHARS)
}

export function isContactKey(key: string): boolean {
  return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/)
    .some(word => ["contact", "name", "email", "phone", "mobile", "telephone", "address"].includes(word))
}

export function safeEvidencePreview(value: unknown, maxLength: number): string {
  return boundedPreview(redactContactDetails(normalizedText(value)), maxLength)
}

function redactContactDetails(value: string): string {
  const emailsRedacted = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
  return emailsRedacted.replace(/(^|[^A-Za-z0-9_])(\+?\d[\d\s().-]*\d)(?![A-Za-z0-9_])/g,
    (match, prefix: string, candidate: string) => (candidate.match(/\d/g)?.length ?? 0) >= 9
      ? prefix + "[redacted phone]"
      : match,
  )
}

function boundedPreview(value: string, maxLength: number): string {
  const text = value
  const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0
  if (limit === 0) return ""
  return text.length > limit ? text.slice(0, limit - 1).trimEnd() + "…" : text
}

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim()
    : ""
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
