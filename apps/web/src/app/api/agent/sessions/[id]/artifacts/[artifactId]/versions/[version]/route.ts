import { NextRequest } from "next/server"

import { hashContent } from "@jobcopilot/shared"
import { db } from "@/lib/db"
import { err, isErrorResponse, ok, requireAuth } from "@/lib/api-helpers"
import {
  boundedRefs, isContactKey, projectSourceEvidence, resumeEvidenceText, safeEvidencePreview,
  MAX_SOURCE_EVIDENCE_ITEM_CHARS, type SelectedSourceSnapshot, type SourceEvidenceItem,
} from "./artifact-version-evidence"

interface RouteContext {
  params: Promise<{ id: string; artifactId: string; version: string }>
}

const MAX_DRAFT_LENGTH = 20_000

type WorkerJobRecord = {
  readonly id: string; readonly company: string; readonly role: string; readonly location: string | null
  readonly status: string; readonly score: number | null; readonly url: string | null; readonly source: string | null
  readonly salary: string | null; readonly description: string | null; readonly keywords: string | null
}
type WorkerResumeRecord = {
  readonly id: string; readonly name: string; readonly kind: string; readonly origin: string; readonly isDefault: boolean
  readonly content: unknown; readonly createdAt: Date | string; readonly updatedAt: Date | string
}
type WorkerPersonaFact = {
  readonly id: string; readonly key: string; readonly category: string; readonly value: string; readonly source: string
  readonly sourceRef: string | null; readonly confidence: number; readonly allowedUses: readonly string[]
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function selectedJobSourceDigest(job: WorkerJobRecord, resume: WorkerResumeRecord, facts: readonly WorkerPersonaFact[]): string {
  const materials = [
    { sourceRef: `job:${job.id}`, content: job },
    { sourceRef: `resume:${resume.id}`, content: {
      id: resume.id, name: resume.name, kind: resume.kind, origin: resume.origin, isDefault: resume.isDefault,
      content: resume.content, createdAt: iso(resume.createdAt), updatedAt: iso(resume.updatedAt),
    } },
    ...facts.map((fact, index) => ({
      sourceRef: `persona:${fact.id}`,
      content: {
        id: fact.id, key: fact.key, category: fact.category, value: fact.value, source: fact.source,
        sourceRef: fact.sourceRef, confidence: Number(fact.confidence), allowedUses: [...fact.allowedUses], rank: index + 1,
      },
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
        orderBy: [{ isDefault: "desc" }, { updatedAt: "desc" }, { id: "desc" }],
        select: { id: true, name: true, kind: true, origin: true, isDefault: true, content: true, createdAt: true, updatedAt: true },
      }),
      db.personaFact.findMany({
        where: {
          userId,
          status: "confirmed",
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          allowedUses: { has: "cover_letter" },
        },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
        take: 50,
        select: { id: true, key: true, category: true, value: true, source: true, sourceRef: true, confidence: true, allowedUses: true },
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
    return { digest: selectedJobSourceDigest(job, {
      id: resume.id, name: resume.name, kind: resume.kind, origin: resume.origin, isDefault: resume.isDefault,
      content: resume.content, createdAt: resume.createdAt, updatedAt: resume.updatedAt,
    }, facts), byRef }
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

  const [head, review, currentSources] = await Promise.all([
    db.agentArtifact.findFirst({
      where: {
        id: artifact.artifactId,
        userId: auth.userId,
        jobId: job.id,
        lifecycle: "draft",
        artifactType: "cover_letter",
      },
      select: { version: true, hash: true },
    }),
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
  const isCurrentVersion = head?.version === artifact.version && head.hash === artifact.contentHash
  const staleReview = !isCurrentVersion || currentSources === null || currentSources.digest !== artifact.sourceDigest

  const response = ok({
    job: { company: boundedJobText(job.company), role: boundedJobText(job.role) },
    isCurrentVersion,
    artifact: {
      artifactId: artifact.artifactId,
      version: artifact.version,
      contentHash: artifact.contentHash,
      sourceDigest: artifact.sourceDigest,
      content: { text: artifact.content },
      provenanceRefs: boundedRefs(artifact.provenanceRefs),
      evidenceRefs: boundedRefs(artifact.evidenceRefs),
    },
    sourceEvidence: projectSourceEvidence(artifact, currentSources, isCurrentVersion),
    review: review ? projectReview(review, staleReview) : null,
  })
  response.headers.set("Cache-Control", "private, no-store, max-age=0")
  return response
}

function boundedJobText(value: string | null): string {
  return value && value.length <= 160 && value.trim() === value ? value : "Saved job"
}

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
