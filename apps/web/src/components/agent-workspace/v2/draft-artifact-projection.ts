import type { SupervisorTaskSummary } from './task-tree-projection'
import type { TaskGraphIdentity } from './task-graph-plan-query'

export interface DraftArtifactRef {
  readonly artifactId: string
  readonly version: number
  readonly contentHash: string
  readonly sourceDigest: string
}

export interface DraftReview {
  readonly status: 'passed' | 'needs_revision' | 'rejected' | 'stale'
  readonly reviewHash: string
  readonly evidenceRefs: readonly string[]
  readonly findings: readonly { code: string; severity: string; message: string; evidenceRefs: readonly string[] }[]
}

export type DraftEvidenceFreshness = 'current' | 'stale' | 'unavailable'
export type DraftEvidenceKind = 'job' | 'resume' | 'persona'

export interface DraftSourceEvidenceItem {
  readonly reference: string
  readonly kind: DraftEvidenceKind
  readonly label: string
  readonly text: string
}

export interface DraftSourceEvidence {
  readonly freshness: DraftEvidenceFreshness
  readonly items: readonly DraftSourceEvidenceItem[]
}

export interface DraftArtifactPayload {
  readonly job: { readonly company: string; readonly role: string }
  readonly artifact: DraftArtifactRef & {
    readonly content: { readonly text: string }
    readonly provenanceRefs: readonly string[]
    readonly evidenceRefs: readonly string[]
  }
  readonly review: DraftReview | null
  readonly sourceEvidence: DraftSourceEvidence
}

const DIGEST = /^sha256:[a-f0-9]{64}$/
const REVIEW_STATUSES = new Set(['passed', 'needs_revision', 'rejected', 'stale'])
const EVIDENCE_KINDS = new Set<DraftEvidenceKind>(['job', 'resume', 'persona'])

export function latestWriterArtifact(
  sessionId: string,
  tasks: readonly SupervisorTaskSummary[],
  activeGraph: TaskGraphIdentity | null,
): DraftArtifactRef | null {
  if (!activeGraph || activeGraph.sessionId !== sessionId) return null
  const candidates = tasks.filter(task => task.sessionId === sessionId
    && task.turnId === activeGraph.turnId && task.rootTaskId === activeGraph.rootTaskId
    && task.role === 'writer'
    && task.taskType === 'cover_letter_draft' && validArtifactRef(task.artifactRef))
  const uniqueRefs = new Map<string, DraftArtifactRef>()
  for (const task of candidates) {
    const ref = task.artifactRef
    if (!validArtifactRef(ref)) continue
    uniqueRefs.set(JSON.stringify([ref.artifactId, ref.version, ref.contentHash, ref.sourceDigest]), ref)
  }
  const refs = [...uniqueRefs.values()]
  const highestVersion = Math.max(0, ...refs.map(candidate => candidate.version))
  const latest = refs.filter(candidate => candidate.version === highestVersion)
  return latest.length === 1 ? latest[0] : null
}

export function selectedDraftArtifactUrl(sessionId: string, ref: DraftArtifactRef): string {
  const query = new URLSearchParams({ contentHash: ref.contentHash, sourceDigest: ref.sourceDigest })
  return `/api/agent/sessions/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(ref.artifactId)}/versions/${ref.version}?${query}`
}

export function parseDraftArtifactPayload(value: unknown, expected: DraftArtifactRef): DraftArtifactPayload | null {
  const root = record(value)
  const job = record(root.job)
  const artifact = record(root.artifact)
  const ref = parseArtifactRef(artifact)
  const content = record(artifact.content)
  const sourceEvidence = parseSourceEvidence(root.sourceEvidence)
  if (!ref || !sameRef(ref, expected) || typeof content.text !== 'string' || content.text.length > 20_000
    || !boundedText(job.company, 160) || !boundedText(job.role, 160) || !sourceEvidence) return null
  const review = root.review === null ? null : parseReview(root.review)
  if (root.review !== null && !review) return null
  return {
    job: { company: job.company, role: job.role },
    artifact: {
      ...ref,
      content: { text: content.text },
      provenanceRefs: strings(artifact.provenanceRefs),
      evidenceRefs: strings(artifact.evidenceRefs),
    },
    review,
    sourceEvidence,
  }
}

function parseSourceEvidence(value: unknown): DraftSourceEvidence | null {
  const row = record(value)
  const freshness = row.freshness
  if (freshness === 'stale' || freshness === 'unavailable') return { freshness, items: [] }
  if (freshness !== 'current' || !Array.isArray(row.items) || row.items.length > 8) return null

  const items: DraftSourceEvidenceItem[] = []
  let totalTextLength = 0
  for (const entry of row.items) {
    const item = record(entry)
    if (Object.keys(item).sort().join(',') !== 'kind,label,reference,text'
      || !EVIDENCE_KINDS.has(item.kind as DraftEvidenceKind)
      || !boundedText(item.reference, 256) || !boundedText(item.label, 80)
      || !boundedText(item.text, 600)) return null
    totalTextLength += item.text.length
    if (totalTextLength > 3_000) return null
    items.push({
      reference: item.reference,
      kind: item.kind as DraftEvidenceKind,
      label: item.label,
      text: item.text,
    })
  }
  return { freshness, items }
}

export function validArtifactRef(value: unknown): value is DraftArtifactRef {
  const row = record(value)
  return Object.keys(row).sort().join(',') === 'artifactId,contentHash,sourceDigest,version'
    && boundedText(row.artifactId, 256) && Number.isSafeInteger(row.version) && Number(row.version) > 0
    && typeof row.contentHash === 'string' && DIGEST.test(row.contentHash)
    && typeof row.sourceDigest === 'string' && DIGEST.test(row.sourceDigest)
}

function parseArtifactRef(value: Record<string, unknown>): DraftArtifactRef | null {
  return validArtifactRef({ artifactId: value.artifactId, version: value.version, contentHash: value.contentHash, sourceDigest: value.sourceDigest })
    ? { artifactId: value.artifactId as string, version: Number(value.version), contentHash: value.contentHash as string, sourceDigest: value.sourceDigest as string }
    : null
}

function parseReview(value: unknown): DraftReview | null {
  const row = record(value)
  if (!REVIEW_STATUSES.has(String(row.status)) || !boundedText(row.reviewHash, 256)) return null
  const findings = Array.isArray(row.findings) ? row.findings.slice(0, 20).flatMap(entry => {
    const finding = record(entry)
    if (!boundedText(finding.code, 80) || !boundedText(finding.severity, 32) || !boundedText(finding.message, 1_000)) return []
    return [{ code: finding.code, severity: finding.severity, message: finding.message, evidenceRefs: strings(finding.evidenceRefs) }]
  }) : []
  return { status: row.status as DraftReview['status'], reviewHash: row.reviewHash, evidenceRefs: strings(row.evidenceRefs), findings }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.slice(0, 32).filter((entry): entry is string => boundedText(entry, 256)) : []
}

function sameRef(left: DraftArtifactRef, right: DraftArtifactRef): boolean {
  return left.artifactId === right.artifactId && left.version === right.version
    && left.contentHash === right.contentHash && left.sourceDigest === right.sourceDigest
}

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max && value.trim() === value
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}
