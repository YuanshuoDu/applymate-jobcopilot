import { Type, type Static } from '@sinclair/typebox'
import type { Pool } from 'pg'
import { hashArtifactContent } from '../subagents/artifact-adapters.js'
import type { RuntimeToolDefinition, ToolExecutionContext } from './types.js'
import { PgArtifactToolStore } from './artifact-store-pg.js'

const Id = Type.String({ minLength: 1, maxLength: 256 })
const Evidence = Type.Array(Type.Object({ sourceRef: Id, content: Type.String({ minLength: 1, maxLength: 8_000 }) }, { additionalProperties: false }), { minItems: 1, maxItems: 32 })
const DraftInput = Type.Object({ artifactId: Type.Optional(Id), baseArtifactId: Id, baseHash: Id, content: Type.Unknown(), constraints: Type.Unknown(), evidence: Evidence, expectedPreviousHash: Type.Optional(Type.Union([Id, Type.Null()])) }, { additionalProperties: false })
const ReadInput = Type.Object({ artifactId: Id }, { additionalProperties: false })
const ReviewInput = Type.Object({ artifactId: Id, expectedArtifactHash: Id, constraintHash: Id, decision: Type.Union([Type.Literal('passed'), Type.Literal('needs_revision'), Type.Literal('rejected')]), evidence: Evidence }, { additionalProperties: false })

export type ArtifactToolDraftInput = Static<typeof DraftInput>
export type ArtifactToolReviewInput = Static<typeof ReviewInput>
export type ArtifactBaseInput = {
  readonly id: string
  readonly type: ArtifactToolRecord['type']
  readonly jobId: string
  readonly content: unknown
  readonly constraintHash?: string
  readonly userId: string
}
export type ArtifactToolRecord = {
  readonly id: string
  readonly type: 'resume' | 'cover_letter' | 'application'
  readonly lifecycle: 'base' | 'draft'
  readonly version: number
  readonly hash: string
  readonly baseArtifactId: string
  readonly baseHash: string
  readonly constraintHash: string
  readonly provenanceRefs: readonly string[]
  readonly content: unknown
  readonly ownerUserId?: string
  readonly jobId?: string
}

export interface ArtifactToolStore {
  read(userId: string, artifactId: string): Promise<ArtifactToolRecord | null>
  writeDraft(userId: string, input: ArtifactToolDraftInput & { type: ArtifactToolRecord['type'] }): Promise<ArtifactToolRecord>
  registerBase(input: ArtifactBaseInput): ArtifactToolRecord | Promise<ArtifactToolRecord>
  listForUser(userId: string, jobId: string): Promise<ArtifactToolRecord[]>
}

export type ArtifactItem = {
  readonly type: 'artifact'
  readonly artifactId: string
  readonly artifactType: ArtifactToolRecord['type']
  readonly lifecycle: ArtifactToolRecord['lifecycle']
  readonly version: number
  readonly hash: string
  readonly baseHash: string
  readonly constraintHash: string
  readonly provenanceRefs: readonly string[]
  readonly reviewHash?: string
}

export class ArtifactToolError extends Error {
  constructor(readonly code: 'not_found' | 'stale_hash' | 'invalid_provenance' | 'precondition_failed', message: string) {
    super(message)
    this.name = 'ArtifactToolError'
  }
}

function textValues(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(textValues)
  if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(textValues)
  return []
}

function normalized(value: string): string { return value.toLocaleLowerCase().replace(/[^\p{L}\p{N}%+.#-]+/gu, ' ').replace(/\s+/g, ' ').trim() }

function assertSupportedDraft(input: ArtifactToolDraftInput): void {
  const evidenceText = normalized(input.evidence.map(entry => entry.content).join(' '))
  const allowedText = normalized(JSON.stringify(input.constraints))
  const draftText = textValues(input.content).join(' ')
  const claims = [
    ...Array.from(draftText.matchAll(/\b(?:at|for|from|worked at|worked for|joined|graduated from|certified by)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,3})/g)).map(match => match[1] ?? ''),
    ...Array.from(draftText.matchAll(/\b\d+(?:[.,]\d+)?\s*(?:%|percent|years?|months?|k|m)?\b/gi)).map(match => match[0]),
    ...Array.from(draftText.matchAll(/\b(?:19|20)\d{2}\b/g)).map(match => match[0]),
  ].map(normalized).filter(Boolean)
  const unsupported = claims.filter(claim => !evidenceText.includes(claim) && !allowedText.includes(claim))
  if (unsupported.length) throw new ArtifactToolError('invalid_provenance', `Unsupported claims cannot pass provenance preflight: ${[...new Set(unsupported)].join(', ')}`)
}

function item(artifact: ArtifactToolRecord, reviewHash?: string): ArtifactItem {
  return { type: 'artifact', artifactId: artifact.id, artifactType: artifact.type, lifecycle: artifact.lifecycle, version: artifact.version, hash: artifact.hash, baseHash: artifact.baseHash, constraintHash: artifact.constraintHash, provenanceRefs: [...artifact.provenanceRefs], ...(reviewHash ? { reviewHash } : {}) }
}

function metadata(name: string, description: string, risk: 'read' | 'draft_write', idempotency: 'read_only' | 'idempotent' | 'requires_key'): Pick<RuntimeToolDefinition, 'schemaVersion' | 'name' | 'version' | 'description' | 'capabilities' | 'risk' | 'domain' | 'idempotency' | 'timeoutMs' | 'requiredCapabilities'> {
  return { schemaVersion: 'agent-harness.v2' as const, name, version: '1', description, capabilities: risk === 'read' ? ['read'] as const : ['read', 'write'] as const, risk, domain: 'resume' as const, idempotency, timeoutMs: 30_000, requiredCapabilities: [] as const }
}

export function createArtifactTools(store: ArtifactToolStore): RuntimeToolDefinition[] {
  return [
    ...(['resume', 'cover_letter'] as const).map(type => ({
      ...metadata(`${type === 'resume' ? 'resume' : 'cover_letter'}.draft`, `Create a provenance-checked ${type} draft without replacing a base or approved artifact`, 'draft_write', 'requires_key'),
      inputSchema: DraftInput, outputSchema: Type.Object({ artifact: Type.Unknown(), item: Type.Unknown() }, { additionalProperties: false }),
      execute: async (context: ToolExecutionContext, value: unknown) => {
        const input = value as ArtifactToolDraftInput
        assertSupportedDraft(input)
        const artifact = await store.writeDraft(context.scope.userId, { ...input, type })
        return { artifact: { ...artifact, content: undefined }, item: item(artifact) }
      },
    })),
    {
      ...metadata('artifact.get', 'Read a versioned Agent artifact by id', 'read', 'read_only'),
      inputSchema: ReadInput, outputSchema: Type.Object({ artifact: Type.Union([Type.Unknown(), Type.Null()]), item: Type.Union([Type.Unknown(), Type.Null()]) }, { additionalProperties: false }),
      execute: async (context: ToolExecutionContext, value: unknown) => {
        const artifact = await store.read(context.scope.userId, (value as Static<typeof ReadInput>).artifactId)
        return { artifact: artifact ? { ...artifact, content: undefined } : null, item: artifact ? item(artifact) : null }
      },
    },
    {
      ...metadata('artifact.preflight', 'Check artifact provenance, lifecycle, and constraint freshness without writing', 'read', 'read_only'),
      inputSchema: Type.Object({ artifactId: Id, expectedArtifactHash: Id, constraintHash: Id }, { additionalProperties: false }),
      outputSchema: Type.Object({ ok: Type.Boolean(), issues: Type.Array(Type.String()), item: Type.Union([Type.Unknown(), Type.Null()]) }, { additionalProperties: false }),
      execute: async (context: ToolExecutionContext, value: unknown) => {
        const input = value as { artifactId: string; expectedArtifactHash: string; constraintHash: string }
        const artifact = await store.read(context.scope.userId, input.artifactId)
        if (!artifact) throw new ArtifactToolError('not_found', 'Artifact was not found.')
        const issues = [
          ...(artifact.hash !== input.expectedArtifactHash ? ['stale_hash'] : []),
          ...(artifact.constraintHash !== input.constraintHash ? ['stale_constraints'] : []),
          ...(artifact.provenanceRefs.length === 0 ? ['missing_provenance'] : []),
          ...(artifact.lifecycle !== 'draft' ? ['artifact_not_draft'] : []),
        ]
        return { ok: issues.length === 0, issues, item: item(artifact) }
      },
    },
    {
      ...metadata('artifact.review', 'Produce a hash-bound, provenance-backed review result', 'read', 'read_only'),
      inputSchema: ReviewInput, outputSchema: Type.Object({ artifactId: Id, artifactHash: Id, decision: Type.String(), evidenceRefs: Type.Array(Type.String()), item: Type.Unknown() }, { additionalProperties: false }),
      execute: async (context: ToolExecutionContext, value: unknown) => {
        const input = value as ArtifactToolReviewInput
        const artifact = await store.read(context.scope.userId, input.artifactId)
        if (!artifact) throw new ArtifactToolError('not_found', 'Artifact was not found.')
        if (artifact.hash !== input.expectedArtifactHash || artifact.constraintHash !== input.constraintHash) throw new ArtifactToolError('stale_hash', 'Review is bound to a stale artifact hash or constraint set.')
        if (artifact.provenanceRefs.length === 0 || input.evidence.length === 0 || input.evidence.some(entry => !artifact.provenanceRefs.includes(entry.sourceRef))) throw new ArtifactToolError('invalid_provenance', 'Review requires evidence from the artifact provenance chain.')
        return { artifactId: artifact.id, artifactHash: artifact.hash, decision: input.decision, evidenceRefs: input.evidence.map(entry => entry.sourceRef), item: item(artifact, artifact.hash) }
      },
    },
  ]
}

/** Small deterministic store for tool contract tests and local harness wiring. */
export class InMemoryArtifactToolStore implements ArtifactToolStore {
  private readonly records = new Map<string, ArtifactToolRecord>()
  registerBase(input: Omit<ArtifactBaseInput, 'jobId' | 'userId'> & { jobId?: string; userId?: string }): ArtifactToolRecord {
    if (this.records.has(input.id)) throw new ArtifactToolError('stale_hash', 'A base artifact cannot be overwritten.')
    if (input.jobId && input.userId && [...this.records.values()].some(record => record.lifecycle === 'base' && record.jobId === input.jobId && record.ownerUserId === input.userId && record.type === input.type)) {
      throw new ArtifactToolError('stale_hash', 'A base artifact cannot be overwritten.')
    }
    const hash = hashArtifactContent(input.content)
    const record: ArtifactToolRecord = { id: input.id, type: input.type, lifecycle: 'base', version: 1, hash, baseArtifactId: input.id, baseHash: hash, constraintHash: input.constraintHash ?? hash, provenanceRefs: [`${input.type}:${input.id}`], content: input.content, ...(input.userId ? { ownerUserId: input.userId } : {}), ...(input.jobId ? { jobId: input.jobId } : {}) }
    this.records.set(input.id, record)
    return record
  }
  async read(userId: string, artifactId: string): Promise<ArtifactToolRecord | null> {
    if (!userId.trim()) return null
    const record = this.records.get(artifactId)
    return record && (!record.ownerUserId || record.ownerUserId === userId) ? record : null
  }
  async writeDraft(_userId: string, input: ArtifactToolDraftInput & { type: ArtifactToolRecord['type'] }): Promise<ArtifactToolRecord> {
    const base = this.records.get(input.baseArtifactId)
    if (base?.ownerUserId && base.ownerUserId !== _userId) throw new ArtifactToolError('not_found', 'Artifact is not available in the current tenant.')
    if (!base || base.hash !== input.baseHash) throw new ArtifactToolError('stale_hash', 'Draft base hash is stale or unavailable.')
    if (base.lifecycle !== 'base') throw new ArtifactToolError('stale_hash', 'Drafts must be based on an immutable base artifact.')
    if (input.evidence.length === 0) throw new ArtifactToolError('invalid_provenance', 'Draft requires evidence.')
    const id = input.artifactId ?? `${input.type}:${input.baseArtifactId}`
    const previous = this.records.get(id)
    if (previous?.lifecycle === 'draft' && input.expectedPreviousHash !== undefined && input.expectedPreviousHash !== previous.hash) throw new ArtifactToolError('precondition_failed', 'Draft update has a stale previous hash.')
    if (previous?.lifecycle === 'base') throw new ArtifactToolError('precondition_failed', 'A base artifact cannot be replaced by a draft.')
    if (previous?.lifecycle === 'draft' && ((previous.jobId && base.jobId && previous.jobId !== base.jobId) || previous.baseArtifactId !== base.id || previous.type !== input.type)) throw new ArtifactToolError('precondition_failed', 'Draft identity does not match its base artifact.')
    const record: ArtifactToolRecord = { id, type: input.type, lifecycle: 'draft', version: (previous?.version ?? 0) + 1, hash: hashArtifactContent(input.content), baseArtifactId: input.baseArtifactId, baseHash: input.baseHash, constraintHash: hashArtifactContent(input.constraints), provenanceRefs: input.evidence.map(entry => entry.sourceRef), content: input.content, ownerUserId: base.ownerUserId ?? _userId, ...(base.jobId ? { jobId: base.jobId } : {}) }
    this.records.set(id, record)
    return record
  }

  async listForUser(userId: string, jobId: string): Promise<ArtifactToolRecord[]> {
    return [...this.records.values()].filter(record => (!record.ownerUserId || record.ownerUserId === userId) && record.jobId === jobId)
  }
}

/** Build the durable Worker store; the caller owns pool lifecycle and injection. */
export function createArtifactToolStore(pool: Pool): ArtifactToolStore {
  return new PgArtifactToolStore(pool)
}
