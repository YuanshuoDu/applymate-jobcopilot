import { NextRequest } from "next/server"

import { hashContent } from "@jobcopilot/shared"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"

interface RouteContext {
  params: Promise<{ id: string; artifactId: string; version: string }>
}

const MAX_DRAFT_LENGTH = 20_000
const MAX_REFS = 32
const MAX_SOURCE_EVIDENCE_ITEMS = 8
const MAX_SOURCE_EVIDENCE_ITEM_CHARS = 600
const MAX_SOURCE_EVIDENCE_TOTAL_CHARS = 3_000

type WorkerJobRecord = {
  readonly id: string; readonly company: string; readonly role: string; readonly location: string | null
  readonly status: string; readonly score: number | null; readonly url: string | null; readonly source: string | null
  readonly salary: string | null; readonly description: string | null; readonly keywords: string | null
}
type WorkerPersonaFact = { readonly id: string; readonly key: string; readonly value: string; readonly sourceRef: string | null; readonly confidence: number }
type SourceEvidenceItem = { readonly kind: "job" | "resume" | "persona"; readonly label: string; readonly text: string }
type SelectedSourceSnapshot = { readonly digest: string; readonly byRef: ReadonlyMap<string, SourceEvidenceItem> }

function selectedJobSourceDigest(job: WorkerJobRecord, resume: { readonly id: string; readonly content: unknown }, facts: readonly WorkerPersonaFact[]): string {
  const materials = [
    { sourceRef: `job:${job.id}`, content: job },
    { sourceRef: `resume:${resume.id}`, content: resume.content },
    ...facts.map(fact => ({
      sourceRef: `persona:${fact.id}`,
      content: { id: fact.id, key: fact.key, value: fact.value, confidence: Number(fact.confidence), sourceRef: fact.sourceRef },
    })),
  ]
  const sources = materials.map(item => ({ sourceRef: item.sourceRef, contentHash: hashContent(item.content) }))
    .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef))
  if (new Set(sources.map(source => source.sourceRef)).size !== sources.length) throw new Error("selected_job_source_refs_invalid")
  return hashContent({ jobId: job.id, sources })
}

async function currentSelectedJobSources(userId: string, job: WorkerJobRecord): Promise<SelectedSourceSnapshot | null> {
  try {
    const [resume, facts] = await Promise.all([
      db.resume.findFirst({
        where: { userId, kind: "base" },
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }],
        select: { id: true, content: true },
      }),
      db.personaFact.findMany({
        where: {
          userId,
          status: "confirmed",
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          allowedUses: { has: "cover_letter" },
        },
        orderBy: { updatedAt: "desc" },
        take: 50,
        select: { id: true, key: true, value: true, sourceRef: true, confidence: true },
      }),
    ])
    if (!resume) return null
    const jobText = safeEvidencePreview(job.description, MAX_SOURCE_EVIDENCE_ITEM_CHARS)
      || safeEvidencePreview(`${job.role} at ${job.company}${job.location ? ` · ${job.location}` : ""}`, MAX_SOURCE_EVIDENCE_ITEM_CHARS)
    const byRef = new Map<string, SourceEvidenceItem>([
      [`job:${job.id}`, { kind: "job", label: "Job description", text: jobText }],
      [`resume:${resume.id}`, { kind: "resume", label: "Base resume", text: resumeEvidenceText(resume.content) }],
      ...facts.map(fact => [`persona:${fact.id}`, {
        kind: "persona", label: `Profile fact · ${safeEvidencePreview(fact.key, 48) || "Profile"}`,
        text: isContactKey(fact.key) ? "Contact detail withheld" : safeEvidencePreview(fact.value, MAX_SOURCE_EVIDENCE_ITEM_CHARS),
      }] as const),
    ])
    return { digest: selectedJobSourceDigest(job, resume, facts), byRef }
  } catch {
    // A partial source snapshot must never keep an old review looking current.
    return null
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const auth = await requireAuth(request)
  if (isErrorResponse(auth)) return auth

  const { id: sessionId, artifactId, version: versionText } = await context.params
  const version = Number(versionText)
  if (!Number.isSafeInteger(version) || version < 1 || String(version) !== versionText) {
    return err("Invalid artifact version", 400)
  }
  const url = new URL(request.url)
  const contentHash = url.searchParams.get("contentHash")
  const sourceDigest = url.searchParams.get("sourceDigest")
  if (!isDigest(contentHash) || !isDigest(sourceDigest)) return err("Invalid artifact reference", 400)

  const session = await db.agentSession.findFirst({
    where: { id: sessionId, userId: auth.userId },
    select: { id: true },
  })
  if (!session) return err("Session not found", 404)

  const artifact = await db.agentArtifactVersion.findFirst({
    where: { artifactId, version, contentHash, sourceDigest, userId: auth.userId, sessionId, artifactType: "cover_letter" },
    select: {
      id: true, artifactId: true, version: true, userId: true, sessionId: true, jobId: true,
      artifactType: true, content: true, contentHash: true, sourceDigest: true,
      provenanceRefs: true, evidenceRefs: true,
    },
  })
  if (!artifact || artifact.userId !== auth.userId || artifact.sessionId !== sessionId
    || artifact.artifactId !== artifactId || artifact.version !== version || artifact.artifactType !== "cover_letter"
    || artifact.contentHash !== contentHash || artifact.sourceDigest !== sourceDigest) {
    return err("Artifact version not found", 404)
  }

  const job = await db.job.findFirst({
    where: { id: artifact.jobId, userId: auth.userId },
    select: {
      id: true, company: true, role: true, location: true, status: true, score: true,
      url: true, source: true, salary: true, description: true, keywords: true,
    },
  })
  if (!job) return err("Artifact version not found", 404)
  if (typeof artifact.content !== "string" || artifact.content.length > MAX_DRAFT_LENGTH) {
    return err("Artifact version is unavailable", 409)
  }

  const [review, currentSources] = await Promise.all([
    db.agentArtifactReview.findFirst({
      where: {
        artifactVersionId: artifact.id,
        userId: auth.userId,
        sessionId,
        jobId: job.id,
        artifactId,
        version,
        contentHash: artifact.contentHash,
        sourceDigest: artifact.sourceDigest,
      },
      orderBy: { createdAt: "desc" },
      select: { status: true, reviewHash: true, findings: true, evidenceRefs: true },
    }),
    currentSelectedJobSources(auth.userId, job),
  ])
  const staleReview = currentSources === null || currentSources.digest !== artifact.sourceDigest

  const response = ok({
    job: { company: boundedJobText(job.company), role: boundedJobText(job.role) },
    artifact: {
      artifactId: artifact.artifactId,
      version: artifact.version,
      contentHash: artifact.contentHash,
      sourceDigest: artifact.sourceDigest,
      content: { text: artifact.content },
      provenanceRefs: boundedRefs(artifact.provenanceRefs),
      evidenceRefs: boundedRefs(artifact.evidenceRefs),
    },
    sourceEvidence: projectSourceEvidence(artifact, currentSources),
    review: review ? projectReview(review, staleReview) : null,
  })
  response.headers.set("Cache-Control", "private, no-store, max-age=0")
  return response
}

function boundedJobText(value: string | null): string {
  return value && value.length <= 160 && value.trim() === value ? value : "Saved job"
}

function boundedRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.slice(0, MAX_REFS).filter((entry): entry is string => typeof entry === "string" && entry.length > 0 && entry.length <= 256 && entry.trim() === entry)
}

function projectSourceEvidence(
  artifact: { sourceDigest: string; evidenceRefs: unknown; provenanceRefs: unknown }, snapshot: SelectedSourceSnapshot | null,
) {
  if (!snapshot) return { freshness: "unavailable" as const, items: [] }
  if (snapshot.digest !== artifact.sourceDigest) return { freshness: "stale" as const, items: [] }
  const refs = [...new Set([...boundedRefs(artifact.evidenceRefs), ...boundedRefs(artifact.provenanceRefs)])]
  if (refs.length === 0 || refs.some(reference => !snapshot.byRef.has(reference))) return { freshness: "unavailable" as const, items: [] }
  const items: Array<{ reference: string; kind: SourceEvidenceItem["kind"]; label: string; text: string }> = []
  let totalChars = 0
  for (const reference of refs.slice(0, MAX_SOURCE_EVIDENCE_ITEMS)) {
    const source = snapshot.byRef.get(reference)!
    const text = boundedPreview(source.text, Math.min(MAX_SOURCE_EVIDENCE_ITEM_CHARS, MAX_SOURCE_EVIDENCE_TOTAL_CHARS - totalChars))
    if (!text) continue
    items.push({ reference, kind: source.kind, label: boundedPreview(source.label, 80), text })
    totalChars += text.length
    if (totalChars >= MAX_SOURCE_EVIDENCE_TOTAL_CHARS) break
  }
  return { freshness: "current" as const, items }
}

function resumeEvidenceText(value: unknown): string {
  const resume = record(value)
  const parts: string[] = []
  if (typeof resume.summary === "string") parts.push(resume.summary)
  if (Array.isArray(resume.skills)) {
    const skills = resume.skills.filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0).slice(0, 4)
    if (skills.length) parts.push(`Skills: ${skills.join(", ")}`)
  }
  if (Array.isArray(resume.experience)) {
    for (const item of resume.experience.slice(0, 2)) {
      const row = record(item)
      const role = [row.role, row.company].filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" at ")
      const bullets = Array.isArray(row.bullets) ? row.bullets.filter((bullet): bullet is string => typeof bullet === "string" && bullet.trim().length > 0).slice(0, 2) : []
      if (role) parts.push(`${role}${bullets.length ? `: ${bullets.join("; ")}` : ""}`)
    }
  }
  return safeEvidencePreview(parts.join(" · "), MAX_SOURCE_EVIDENCE_ITEM_CHARS)
}

function isContactKey(key: string): boolean { return key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase().split(/[^a-z0-9]+/).some(word => ["contact", "name", "email", "phone", "mobile", "telephone", "address"].includes(word)) }
function safeEvidencePreview(value: unknown, maxLength: number): string { return boundedPreview(redactContactDetails(normalizedText(value)), maxLength) }
function redactContactDetails(value: string): string {
  const emailsRedacted = value.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
  return emailsRedacted.replace(/(^|[^A-Za-z0-9_])(\+?\d[\d\s().-]*\d)(?![A-Za-z0-9_])/g,
    (match, prefix: string, candidate: string) => (candidate.match(/\d/g)?.length ?? 0) >= 9 ? `${prefix}[redacted phone]` : match)
}

function boundedPreview(value: unknown, maxLength: number): string {
  const text = normalizedText(value)
  return text.length > maxLength ? `${text.slice(0, maxLength - 1).trimEnd()}…` : text
}
function normalizedText(value: unknown): string { return typeof value === "string" ? value.replace(/<[^>]*>/g, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim() : "" }

function projectReview(value: { status: string; reviewHash: string; findings: unknown; evidenceRefs: unknown }, staleSource: boolean) {
  const status = staleSource || !["passed", "needs_revision", "rejected", "stale"].includes(value.status) ? "stale" : value.status
  return {
    status,
    reviewHash: value.reviewHash,
    evidenceRefs: status === "stale" ? [] : boundedRefs(value.evidenceRefs),
    findings: status === "stale" ? [] : projectFindings(value.findings),
  }
}

function projectFindings(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.slice(0, 20).flatMap((entry) => {
    const row = record(entry)
    if (!boundedText(row.code, 80) || !boundedText(row.severity, 32) || !boundedText(row.message, 1_000)) return []
    return [{ code: row.code, severity: row.severity, message: row.message, evidenceRefs: boundedRefs(row.evidenceRefs) }]
  })
}

function boundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && value.trim() === value
}

function isDigest(value: unknown): value is string { return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value) }

function record(value: unknown): Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {} }
