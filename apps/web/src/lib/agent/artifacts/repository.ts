import { hashArtifactContent, hashArtifactConstraints } from './hash'
import { assertSupportedClaims, type EvidenceInput } from './provenance'
import { reviewIsCurrent } from './review'
import type { ArtifactConstraintSet, ArtifactKind, ArtifactReview, ArtifactSummary, VersionedArtifact } from './types'

export type DraftInput<T> = {
  readonly id: string
  readonly kind: ArtifactKind
  readonly baseArtifactId: string
  readonly baseHash: string
  readonly content: T
  readonly createdBy: string
  readonly constraints: ArtifactConstraintSet
  readonly evidence: readonly EvidenceInput[]
}

export type BaseInput<T> = {
  readonly id: string
  readonly kind: ArtifactKind
  readonly content: T
  readonly createdBy: string
}

export class ArtifactRepositoryError extends Error {
  readonly code: 'not_found' | 'invalid_transition' | 'stale_artifact' | 'provenance_failed'

  constructor(code: ArtifactRepositoryError['code'], message: string) {
    super(message)
    this.name = 'ArtifactRepositoryError'
    this.code = code
  }
}

function summary<T>(artifact: VersionedArtifact<T>): ArtifactSummary {
  const { content: _content, createdBy: _createdBy, parentArtifactId: _parent, staleReason: _stale, ...result } = artifact
  return result
}

export function createBaseArtifact<T>(input: {
  readonly id: string
  readonly kind: ArtifactKind
  readonly content: T
  readonly createdBy: string
}): VersionedArtifact<T> {
  const hash = hashArtifactContent(input.content)
  return {
    id: input.id, kind: input.kind, lifecycle: 'base', version: 1, hash,
    baseArtifactId: input.id, baseHash: hash, constraintHash: hashArtifactConstraints({ base: input.id }),
    provenance: [{ sourceType: 'resume', sourceRef: `resume:${input.id}`, evidenceHash: hash }],
    content: input.content, createdBy: input.createdBy, parentArtifactId: null, staleReason: null,
  }
}

export function buildDraftArtifactSummary(input: {
  readonly id: string
  readonly kind: ArtifactKind
  readonly content: unknown
  readonly baseArtifactId: string
  readonly baseHash: string
  readonly constraints: ArtifactConstraintSet
  readonly provenance: VersionedArtifact['provenance']
}): ArtifactSummary {
  return {
    id: input.id,
    kind: input.kind,
    lifecycle: 'draft',
    version: 1,
    hash: hashArtifactContent(input.content),
    baseArtifactId: input.baseArtifactId,
    baseHash: input.baseHash,
    constraintHash: hashArtifactConstraints(input.constraints),
    provenance: [...input.provenance],
  }
}

export class InMemoryArtifactRepository {
  private readonly current = new Map<string, VersionedArtifact>()
  private readonly history = new Map<string, VersionedArtifact[]>()

  createBase<T>(input: BaseInput<T>): VersionedArtifact<T> {
    if (this.current.has(input.id)) throw new ArtifactRepositoryError('invalid_transition', 'A base artifact cannot be overwritten.')
    const artifact = createBaseArtifact(input)
    this.store(artifact)
    return artifact
  }

  createDraft<T>(input: DraftInput<T>): VersionedArtifact<T> {
    const base = this.current.get(input.baseArtifactId)
    if (!base || base.lifecycle !== 'base') throw new ArtifactRepositoryError('not_found', 'The immutable base artifact was not found.')
    if (base.hash !== input.baseHash) throw new ArtifactRepositoryError('stale_artifact', 'Draft was based on a stale base artifact.')
    let provenance: ReturnType<typeof assertSupportedClaims>
    try {
      provenance = assertSupportedClaims({ content: input.content, evidence: input.evidence, allowedContext: [input.constraints.company, input.constraints.role] })
    } catch (error) {
      throw new ArtifactRepositoryError('provenance_failed', error instanceof Error ? error.message : 'Artifact provenance failed.')
    }
    const previous = this.current.get(input.id)
    if (previous && previous.lifecycle === 'approved') throw new ArtifactRepositoryError('invalid_transition', 'An approved artifact cannot be overwritten.')
    const version = (previous?.version ?? 0) + 1
    const artifact: VersionedArtifact<T> = {
      id: input.id, kind: input.kind, lifecycle: 'draft', version,
      hash: hashArtifactContent(input.content), baseArtifactId: input.baseArtifactId, baseHash: input.baseHash,
      constraintHash: hashArtifactConstraints(input.constraints), provenance, content: input.content,
      createdBy: input.createdBy, parentArtifactId: previous?.id ?? input.baseArtifactId, staleReason: null,
    }
    this.store(artifact)
    return artifact
  }

  approve<T>(artifactId: string, review: ArtifactReview, currentConstraints: ArtifactConstraintSet): VersionedArtifact<T> {
    const draft = this.current.get(artifactId)
    if (!draft) throw new ArtifactRepositoryError('not_found', 'Draft artifact was not found.')
    if (draft.lifecycle !== 'draft' || !reviewIsCurrent(review, summary(draft), hashArtifactConstraints(currentConstraints))) {
      throw new ArtifactRepositoryError('stale_artifact', 'Only the current reviewed draft can be approved.')
    }
    if (review.status !== 'passed') throw new ArtifactRepositoryError('invalid_transition', 'Only a passing review can create an approved artifact.')
    const approved = { ...draft, id: `${draft.id}:approved:${draft.version}`, lifecycle: 'approved' as const, parentArtifactId: draft.id } as unknown as VersionedArtifact<T>
    this.store(approved)
    return approved as unknown as VersionedArtifact<T>
  }

  invalidateStale(currentConstraints: ArtifactConstraintSet): ArtifactSummary[] {
    const constraintHash = hashArtifactConstraints(currentConstraints)
    const stale: ArtifactSummary[] = []
    for (const [id, artifact] of this.current) {
      if (artifact.lifecycle === 'draft' && artifact.constraintHash !== constraintHash) {
        const next = { ...artifact, lifecycle: 'stale' as const, staleReason: 'tailoring_constraints_changed' }
        this.current.set(id, next)
        this.history.get(id)?.push(next)
        stale.push(summary(next))
      }
    }
    return stale
  }

  get(id: string): VersionedArtifact | null { return this.current.get(id) ?? null }
  getHistory(id: string): readonly VersionedArtifact[] { return [...(this.history.get(id) ?? [])] }

  private store(artifact: VersionedArtifact): void {
    this.current.set(artifact.id, artifact)
    const versions = this.history.get(artifact.id) ?? []
    versions.push(artifact)
    this.history.set(artifact.id, versions)
  }
}

export function artifactSummary(artifact: VersionedArtifact): ArtifactSummary { return summary(artifact) }
