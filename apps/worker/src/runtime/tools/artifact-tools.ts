import { Type, type Static } from "@sinclair/typebox"
import type { Pool } from "pg"
import { hashArtifactContent } from "../subagents/artifact-adapters.js"
import type { AgentArtifactReviewRow, AgentArtifactTaskFence, AgentArtifactVersionRow } from "../../db/agent-artifact-repo.js"
import type { RuntimeToolDefinition, ToolExecutionContext } from "./types.js"
import { PgArtifactToolStore } from "./artifact-store-pg.js"

const Id = Type.String({ minLength: 1, maxLength: 256 })
const Digest = Type.String({ pattern: "^sha256:[a-f0-9]{64}$" })
const ArtifactRefSchema = Type.Object({ artifactId: Id, version: Type.Integer({ minimum: 1 }), contentHash: Digest, sourceDigest: Digest }, { additionalProperties: false })
const Evidence = Type.Object({ artifactHash: Digest, path: Type.String({ minLength: 1, maxLength: 256 }), summary: Type.String({ minLength: 1, maxLength: 512 }) }, { additionalProperties: false })
const Finding = Type.Object({ id: Id, code: Id, severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]), message: Type.String({ minLength: 1, maxLength: 1000 }), artifactHash: Digest, evidence: Type.Array(Evidence, { minItems: 1, maxItems: 16 }) }, { additionalProperties: false })
const Findings = Type.Array(Finding, { maxItems: 64 })
const MAX_DRAFT_CONTENT_LENGTH = 20_000
const DraftContent = Type.String({ minLength: 1, maxLength: MAX_DRAFT_CONTENT_LENGTH, pattern: "\\S" })
const DraftInput = Type.Object({ baseArtifactId: Id, baseHash: Digest, content: DraftContent, constraints: Type.Unknown(), expectedPreviousHash: Type.Optional(Type.Union([Digest, Type.Null()])) }, { additionalProperties: false })
const VersionReadInput = Type.Object({ artifactRef: ArtifactRefSchema }, { additionalProperties: false })
const ReviewInput = Type.Object({ artifactRef: ArtifactRefSchema, decision: Type.Union([Type.Literal("passed"), Type.Literal("needs_revision"), Type.Literal("rejected")]), findings: Findings }, { additionalProperties: false })

export type ArtifactToolDraftInput = Static<typeof DraftInput>
export type ArtifactToolReviewInput = Static<typeof ReviewInput>
export type ArtifactVersionRef = Static<typeof ArtifactRefSchema>
export type ArtifactFindingInput = Static<typeof Finding>
export type ArtifactSourceMaterial = { readonly sourceRef: string; readonly content: unknown }
export type SelectedJobPreparation = { readonly jobId: string; readonly sourceDigest: string; readonly evidenceRefs: readonly string[] }
export type ArtifactToolExecutionContext = ToolExecutionContext & { readonly selectedJobPreparation?: SelectedJobPreparation; readonly taskId?: string; readonly toolCallId?: string; readonly taskFence?: AgentArtifactTaskFence }
export type ArtifactToolScope = SelectedJobPreparation & { readonly userId: string; readonly sessionId: string; readonly taskId: string; readonly toolCallId: string; readonly taskFence: AgentArtifactTaskFence }
export type ArtifactBaseInput = { readonly id: string; readonly type: "resume" | "cover_letter"; readonly jobId: string; readonly content: unknown; readonly constraintHash?: string; readonly userId: string }
export type ArtifactToolRecord = { readonly id: string; readonly type: "resume" | "cover_letter" | "application"; readonly lifecycle: "base" | "draft"; readonly version: number; readonly hash: string; readonly baseArtifactId: string; readonly baseHash: string; readonly constraintHash: string; readonly provenanceRefs: readonly string[]; readonly content: unknown; readonly ownerUserId?: string; readonly jobId?: string }

export interface ArtifactToolStore {
  read(userId: string, artifactId: string): Promise<ArtifactToolRecord | null>
  readVersion(scope: Pick<ArtifactToolScope, "userId" | "sessionId" | "jobId">, ref: ArtifactVersionRef): Promise<AgentArtifactVersionRow | null>
  writeDraft(scope: ArtifactToolScope, input: ArtifactToolDraftInput & { readonly requestHash: string }): Promise<AgentArtifactVersionRow>
  saveReview(input: Omit<AgentArtifactReviewRow, "id" | "artifactVersionId" | "createdAt"> & { readonly taskFence: AgentArtifactTaskFence }): Promise<AgentArtifactReviewRow>
  findReview(scope: Pick<ArtifactToolScope, "userId" | "sessionId" | "jobId">, ref: ArtifactVersionRef): Promise<AgentArtifactReviewRow | null>
  registerBase(input: ArtifactBaseInput): ArtifactToolRecord | Promise<ArtifactToolRecord>
  listForUser(userId: string, jobId: string): Promise<ArtifactToolRecord[]>
}

export class ArtifactToolError extends Error {
  constructor(readonly code: "not_found" | "stale_hash" | "invalid_provenance" | "precondition_failed" | "receipt_conflict" | "stale_source" | "task_fence_denied", message: string) {
    super(message); this.name = "ArtifactToolError"
  }
}

export function computeArtifactSourceDigest(jobId: string, materials: readonly ArtifactSourceMaterial[]): string {
  if (!jobId.trim() || materials.length === 0 || materials.some(item => !item.sourceRef.trim())) throw new ArtifactToolError("invalid_provenance", "Selected job sources are required.")
  const sources = materials.map(item => ({ sourceRef: item.sourceRef, contentHash: hashArtifactContent(item.content) })).sort((a, b) => a.sourceRef.localeCompare(b.sourceRef))
  if (new Set(sources.map(item => item.sourceRef)).size !== sources.length) throw new ArtifactToolError("invalid_provenance", "Selected job source references must be unique.")
  return hashArtifactContent({ jobId, sources })
}

export function createSelectedJobPreparation(jobId: string, materials: readonly ArtifactSourceMaterial[]): SelectedJobPreparation {
  return { jobId, sourceDigest: computeArtifactSourceDigest(jobId, materials), evidenceRefs: [...new Set(materials.map(item => item.sourceRef))].sort() }
}

function scopeOf(context: ArtifactToolExecutionContext): ArtifactToolScope {
  const selected = context.selectedJobPreparation
  const taskFence = context.taskFence
  const { userId } = context.scope
  if (!selected || !userId?.trim() || !context.sessionId?.trim() || !context.taskId?.trim() || !context.toolCallId?.trim()
    || !context.turnId?.trim() || !context.rootTaskId?.trim() || !taskFence
    || taskFence.taskId !== context.taskId || taskFence.userId !== userId || taskFence.sessionId !== context.sessionId
    || taskFence.turnId !== context.turnId || taskFence.rootTaskId !== context.rootTaskId
    || !taskFence.leaseOwner.trim() || !Number.isSafeInteger(taskFence.attemptCount) || taskFence.attemptCount < 1
    || !selected.jobId.trim() || !/^sha256:[a-f0-9]{64}$/.test(selected.sourceDigest) || selected.evidenceRefs.length === 0) {
    throw new ArtifactToolError("precondition_failed", "Server-selected job and task receipt scope are required.")
  }
  return { userId, sessionId: context.sessionId, taskId: context.taskId, toolCallId: context.toolCallId, taskFence, ...selected }
}

function assertDraftContent(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_DRAFT_CONTENT_LENGTH) {
    throw new ArtifactToolError("precondition_failed", "Draft content must be a non-empty string of at most 20,000 characters.")
  }
}

function versionRef(row: AgentArtifactVersionRow): ArtifactVersionRef {
  return { artifactId: row.artifactId, version: row.version, contentHash: row.contentHash, sourceDigest: row.sourceDigest }
}

function artifactId(userId: string, jobId: string): string { return `cover-letter:${hashArtifactContent({ userId, jobId }).slice(7)}` }

function metadata(name: string, description: string, risk: "read" | "draft_write", idempotency: "read_only" | "requires_key"): Pick<RuntimeToolDefinition, "schemaVersion" | "name" | "version" | "description" | "capabilities" | "risk" | "domain" | "idempotency" | "timeoutMs" | "requiredCapabilities"> {
  return { schemaVersion: "agent-harness.v2", name, version: "1", description, capabilities: risk === "read" ? ["read"] : ["read", "write"], risk, domain: "resume", idempotency, timeoutMs: 30_000, requiredCapabilities: [] }
}

export function createArtifactTools(store: ArtifactToolStore): RuntimeToolDefinition[] {
  return [
    {
      ...metadata("cover_letter.draft", "Persist an immutable, provenance-bound cover-letter draft for the selected job", "draft_write", "requires_key"),
      inputSchema: DraftInput, outputSchema: Type.Object({ artifactRef: ArtifactRefSchema }, { additionalProperties: false }),
      execute: async (rawContext: ToolExecutionContext, value: unknown) => {
        const context = rawContext as ArtifactToolExecutionContext
        const scope = scopeOf(context)
        assertDraftContent(value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).content : undefined)
        const input = value as ArtifactToolDraftInput
        const base = await store.read(scope.userId, input.baseArtifactId)
        if (!base || base.jobId !== scope.jobId || base.type !== "cover_letter" || base.lifecycle !== "base" || base.hash !== input.baseHash) throw new ArtifactToolError("stale_hash", "Selected-job cover-letter base is stale or unavailable.")
        const requestHash = hashArtifactContent({ op: "cover_letter.draft", ...scope, input })
        const row = await store.writeDraft(scope, { ...input, requestHash })
        return { artifactRef: versionRef(row) }
      },
    },
    {
      ...metadata("artifact.version.read", "Read one exact immutable artifact version within the selected job scope", "read", "read_only"),
      inputSchema: VersionReadInput, outputSchema: Type.Object({ artifactRef: ArtifactRefSchema, content: Type.Unknown() }, { additionalProperties: false }),
      execute: async (rawContext: ToolExecutionContext, value: unknown) => {
        const scope = scopeOf(rawContext as ArtifactToolExecutionContext)
        const ref = (value as Static<typeof VersionReadInput>).artifactRef
        const row = await store.readVersion(scope, ref)
        if (!row || row.contentHash !== ref.contentHash || row.sourceDigest !== ref.sourceDigest) throw new ArtifactToolError("not_found", "Artifact version is not available in the selected scope.")
        return { artifactRef: versionRef(row), content: row.content }
      },
    },
    {
      ...metadata("artifact.review", "Persist an immutable review bound to one artifact and selected-source digest", "draft_write", "requires_key"),
      inputSchema: ReviewInput, outputSchema: Type.Object({ artifactRef: ArtifactRefSchema, status: Type.Union([Type.Literal("passed"), Type.Literal("needs_revision"), Type.Literal("rejected"), Type.Literal("stale")]), reviewHash: Digest }, { additionalProperties: false }),
      execute: async (rawContext: ToolExecutionContext, value: unknown) => {
        const scope = scopeOf(rawContext as ArtifactToolExecutionContext)
        const input = value as ArtifactToolReviewInput
        const version = await store.readVersion(scope, input.artifactRef)
        if (!version || version.contentHash !== input.artifactRef.contentHash || version.sourceDigest !== input.artifactRef.sourceDigest) throw new ArtifactToolError("stale_hash", "Reviewed artifact version is unavailable or stale.")
        const stale = scope.sourceDigest !== input.artifactRef.sourceDigest
        const status = stale ? "stale" : input.decision
        const findings = stale ? [] : input.findings
        if (!stale && findings.some(item => item.artifactHash !== version.contentHash || item.evidence.some(evidence => evidence.artifactHash !== version.contentHash))) throw new ArtifactToolError("stale_hash", "Review findings must cite the exact artifact content hash.")
        const evidenceRefs = stale ? [] : [...scope.evidenceRefs]
        const reviewHash = hashArtifactContent({ artifactRef: input.artifactRef, currentSourceDigest: scope.sourceDigest, status, findings, evidenceRefs })
        const requestHash = hashArtifactContent({ op: "artifact.review", ...scope, artifactRef: input.artifactRef, decision: input.decision, findings: input.findings })
        const row = await store.saveReview({ userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId, artifactId: version.artifactId, version: version.version, contentHash: version.contentHash, sourceDigest: version.sourceDigest, currentSourceDigest: scope.sourceDigest, status, findings, evidenceRefs, taskId: scope.taskId, toolCallId: scope.toolCallId, requestHash, reviewHash, taskFence: scope.taskFence })
        return { artifactRef: input.artifactRef, status: row.status, reviewHash: row.reviewHash }
      },
    },
  ]
}

/** Deterministic test store mirrors database receipt and immutable-version behavior. */
export class InMemoryArtifactToolStore implements ArtifactToolStore {
  private readonly records = new Map<string, ArtifactToolRecord>()
  private readonly versions = new Map<string, AgentArtifactVersionRow>()
  private readonly draftReceipts = new Map<string, AgentArtifactVersionRow>()
  private readonly reviews = new Map<string, AgentArtifactReviewRow>()
  private readonly reviewReceipts = new Map<string, AgentArtifactReviewRow>()

  registerBase(input: ArtifactBaseInput): ArtifactToolRecord {
    if (this.records.has(input.id) || [...this.records.values()].some(row => row.ownerUserId === input.userId && row.jobId === input.jobId && row.type === input.type && row.lifecycle === "base")) throw new ArtifactToolError("stale_hash", "A base artifact cannot be overwritten.")
    const hash = hashArtifactContent(input.content)
    const row: ArtifactToolRecord = { id: input.id, type: input.type, lifecycle: "base", version: 1, hash, baseArtifactId: input.id, baseHash: hash, constraintHash: input.constraintHash ?? hash, provenanceRefs: [input.id], content: input.content, ownerUserId: input.userId, jobId: input.jobId }
    this.records.set(row.id, row)
    return row
  }

  async read(userId: string, id: string): Promise<ArtifactToolRecord | null> {
    const row = this.records.get(id)
    return row?.ownerUserId === userId ? row : null
  }

  async writeDraft(scope: ArtifactToolScope, input: ArtifactToolDraftInput & { requestHash: string }): Promise<AgentArtifactVersionRow> {
    const receiptKey = `${scope.taskId}\0${scope.toolCallId}`
    const replay = this.draftReceipts.get(receiptKey)
    if (replay) return this.assertReplay(replay, scope, input.requestHash)
    const base = await this.read(scope.userId, input.baseArtifactId)
    if (!base || base.lifecycle !== "base" || base.hash !== input.baseHash || base.jobId !== scope.jobId || base.type !== "cover_letter") throw new ArtifactToolError("stale_hash", "Draft base is stale or unavailable.")
    if (scope.evidenceRefs.length === 0) throw new ArtifactToolError("invalid_provenance", "Draft requires source evidence.")
    const id = artifactId(scope.userId, scope.jobId)
    const previous = this.records.get(id)
    if (previous?.lifecycle === "base") throw new ArtifactToolError("precondition_failed", "A base artifact cannot be replaced by a draft.")
    if (previous && input.expectedPreviousHash !== undefined && input.expectedPreviousHash !== previous.hash) throw new ArtifactToolError("precondition_failed", "Draft update has a stale previous hash.")
    const hash = hashArtifactContent(input.content)
    const version = (previous?.version ?? 0) + 1
    const row: AgentArtifactVersionRow = { id: `version:${id}:${version}`, artifactId: id, version, userId: scope.userId, sessionId: scope.sessionId, jobId: scope.jobId, artifactType: "cover_letter", content: input.content, contentHash: hash, sourceDigest: scope.sourceDigest, constraintHash: hashArtifactContent(input.constraints), provenanceRefs: [...scope.evidenceRefs], evidenceRefs: [...scope.evidenceRefs], baseId: base.id, baseHash: base.hash, previousHash: previous?.hash ?? null, taskId: scope.taskId, toolCallId: scope.toolCallId, requestHash: input.requestHash, createdAt: new Date() }
    this.versions.set(`${id}:${version}`, row); this.draftReceipts.set(receiptKey, row)
    this.records.set(id, { id, type: "cover_letter", lifecycle: "draft", version, hash, baseArtifactId: base.id, baseHash: base.hash, constraintHash: row.constraintHash, provenanceRefs: row.provenanceRefs, content: row.content, ownerUserId: scope.userId, jobId: scope.jobId })
    return row
  }

  async readVersion(scope: Pick<ArtifactToolScope, "userId" | "sessionId" | "jobId">, ref: ArtifactVersionRef): Promise<AgentArtifactVersionRow | null> {
    const row = this.versions.get(`${ref.artifactId}:${ref.version}`)
    return row?.userId === scope.userId && row.sessionId === scope.sessionId && row.jobId === scope.jobId ? row : null
  }

  async saveReview(input: Omit<AgentArtifactReviewRow, "id" | "artifactVersionId" | "createdAt"> & { readonly taskFence: AgentArtifactTaskFence }): Promise<AgentArtifactReviewRow> {
    const key = `${input.taskId}\0${input.toolCallId}`
    const replay = this.reviewReceipts.get(key)
    if (replay) {
      if (replay.requestHash !== input.requestHash || replay.userId !== input.userId || replay.sessionId !== input.sessionId || replay.jobId !== input.jobId) throw new ArtifactToolError("receipt_conflict", "Task review receipt was replayed with different input.")
      return replay
    }
    const version = this.versions.get(`${input.artifactId}:${input.version}`)
    if (!version || version.userId !== input.userId || version.sessionId !== input.sessionId || version.jobId !== input.jobId || version.contentHash !== input.contentHash || version.sourceDigest !== input.sourceDigest) throw new ArtifactToolError("stale_hash", "Review does not match an immutable artifact version.")
    const { taskFence: _taskFence, ...persisted } = input
    const row: AgentArtifactReviewRow = { ...persisted, id: `review:${key}`, artifactVersionId: version.id, createdAt: new Date() }
    const reviewKey = `${input.userId}:${input.sessionId}:${input.jobId}:${input.artifactId}:${input.version}:${input.contentHash}:${input.sourceDigest}`
    this.reviews.set(reviewKey, row); this.reviewReceipts.set(key, row)
    return row
  }

  async findReview(scope: Pick<ArtifactToolScope, "userId" | "sessionId" | "jobId">, ref: ArtifactVersionRef): Promise<AgentArtifactReviewRow | null> {
    return this.reviews.get(`${scope.userId}:${scope.sessionId}:${scope.jobId}:${ref.artifactId}:${ref.version}:${ref.contentHash}:${ref.sourceDigest}`) ?? null
  }

  async listForUser(userId: string, jobId: string): Promise<ArtifactToolRecord[]> {
    return [...this.records.values()].filter(row => row.ownerUserId === userId && row.jobId === jobId)
  }

  private assertReplay(row: AgentArtifactVersionRow, scope: ArtifactToolScope, requestHash: string): AgentArtifactVersionRow {
    if (row.requestHash !== requestHash || row.userId !== scope.userId || row.sessionId !== scope.sessionId || row.jobId !== scope.jobId) throw new ArtifactToolError("receipt_conflict", "Task tool receipt was replayed with different input.")
    return row
  }
}

export function createArtifactToolStore(pool: Pool): ArtifactToolStore { return new PgArtifactToolStore(pool) }
