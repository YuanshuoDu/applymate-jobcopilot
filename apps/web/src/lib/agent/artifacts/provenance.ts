import { hashArtifactContent } from './hash'
import type { ArtifactProvenance } from './types'

export type EvidenceInput = {
  readonly sourceType: 'resume' | 'persona_fact' | 'persona_evidence'
  readonly sourceRef: string
  readonly content: string
}

export class ProvenanceError extends Error {
  readonly code: 'missing_evidence' | 'unsupported_claim' | 'invalid_provenance'

  constructor(code: ProvenanceError['code'], message: string) {
    super(message)
    this.name = 'ProvenanceError'
    this.code = code
  }
}

export function buildArtifactProvenance(evidence: readonly EvidenceInput[]): ArtifactProvenance[] {
  const seen = new Set<string>()
  return evidence.filter(item => {
    if (!item.sourceRef.trim() || !item.content.trim()) return false
    const key = `${item.sourceType}:${item.sourceRef}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).map(item => ({ sourceType: item.sourceType, sourceRef: item.sourceRef, evidenceHash: hashArtifactContent(item.content) }))
}

export function assertValidProvenance(provenance: readonly ArtifactProvenance[]): void {
  if (provenance.length === 0) throw new ProvenanceError('missing_evidence', 'A draft requires confirmed Persona or base-resume evidence.')
  if (provenance.some(item => !item.sourceRef.trim() || !/^sha256:[a-f0-9]{64}$/.test(item.evidenceHash))) {
    throw new ProvenanceError('invalid_provenance', 'Every provenance reference must have a source reference and evidence hash.')
  }
}

function textLeaves(value: unknown, path = '$'): Array<{ path: string; text: string }> {
  if (typeof value === 'string') return value.trim() ? [{ path, text: value }] : []
  if (Array.isArray(value)) return value.flatMap((item, index) => textLeaves(item, `${path}[${index}]`))
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => textLeaves(child, `${path}.${key}`))
}

function normalized(value: string): string {
  return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}%+.#-]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

function hardClaims(text: string): string[] {
  const claims: string[] = []
  for (const match of text.matchAll(/\b(?:at|for|from|worked at|worked for|joined|graduated from|certified by)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/g)) {
    if (match[1]) claims.push(match[1])
  }
  for (const match of text.matchAll(/\b\d+(?:[.,]\d+)?\s*(?:%|percent|years?|months?|k|m)?\b/gi)) claims.push(match[0])
  for (const match of text.matchAll(/\b(?:19|20)\d{2}\b/g)) claims.push(match[0])
  return claims.map(normalized).filter(Boolean)
}

/**
 * Checks only high-signal biographical claims. Normal wording changes remain
 * valid, while employers, dates and metrics must occur in real evidence.
 */
export function assertSupportedClaims(input: {
  readonly content: unknown
  readonly evidence: readonly EvidenceInput[]
  readonly allowedContext?: readonly string[]
}): ArtifactProvenance[] {
  const provenance = buildArtifactProvenance(input.evidence)
  assertValidProvenance(provenance)
  const evidenceText = normalized(input.evidence.map(item => item.content).join(' '))
  const allowedText = normalized((input.allowedContext ?? []).join(' '))
  const unsupported = new Set(hardClaims(textLeaves(input.content).map(item => item.text).join(' ')).filter(claim => !evidenceText.includes(claim) && !allowedText.includes(claim)))
  if (unsupported.size > 0) {
    throw new ProvenanceError('unsupported_claim', `Unsupported claims cannot pass provenance preflight: ${[...unsupported].join(', ')}`)
  }
  return provenance
}
