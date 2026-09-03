import {
  snapshotCanonicalJson,
  snapshotChecksum,
} from "./context-snapshot-canonical.js"
import { collectContextSnapshot } from "./context-snapshot-collector.js"
import { redactSensitiveText } from "@jobcopilot/shared"
import {
  ContextSnapshotError,
  type AgentContextSnapshot,
  type ContextSnapshotBuildRequest,
  type ContextSnapshotSourcePort,
  type ContextSnapshotStorePort,
  type VerifiedContextReferencePort,
} from "./context-snapshot-types.js"

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextSnapshotError("invalid_input", `${field} must be non-empty`)
  return value
}

function validateRequest(request: ContextSnapshotBuildRequest): void {
  nonEmpty(request.scope.userId, "scope.userId")
  nonEmpty(request.sessionId, "sessionId")
  if (request.throughSequence < 0n) throw new ContextSnapshotError("invalid_input", "throughSequence must not be negative")
  if (!Number.isSafeInteger(request.version) || request.version < 1) throw new ContextSnapshotError("invalid_input", "version must be a positive safe integer")
}

function memorySummary(snapshot: AgentContextSnapshot["content"]): string {
  const goal = redactSensitiveText(snapshot.goal.replace(/\s+/g, " ").trim()).slice(0, 240)
  const totalTokens = snapshot.tokenAccounting.totalInputTokens + snapshot.tokenAccounting.totalOutputTokens
  return [
    `Goal: ${goal}`,
    `Completed: ${snapshot.completedWork.length}`,
    `Open: ${snapshot.openWork.length}`,
    `Pending approvals: ${snapshot.pendingApprovals.length}`,
    `Tokens: ${totalTokens}`,
    `Estimated cost: $${snapshot.tokenAccounting.totalCostUsd.toFixed(8)}`,
  ].join(" · ")
}

export class AgentContextSnapshotBuilder {
  constructor(
    private readonly source: ContextSnapshotSourcePort,
    private readonly references: VerifiedContextReferencePort,
    private readonly store?: ContextSnapshotStorePort,
  ) {}

  async build(request: ContextSnapshotBuildRequest): Promise<AgentContextSnapshot> {
    validateRequest(request)
    const source = await this.source.load({ scope: request.scope, sessionId: request.sessionId, throughSequence: request.throughSequence })
    if (!source) throw new ContextSnapshotError("source_missing", `No context source was found for session ${request.sessionId}`)
    const collected = await collectContextSnapshot({
      scope: request.scope,
      sessionId: request.sessionId,
      throughSequence: request.throughSequence,
      source,
      references: this.references,
    })
    const summary = memorySummary(collected.content)
    const base = {
      sessionId: request.sessionId,
      throughSequence: request.throughSequence,
      version: request.version,
      content: collected.content,
    }
    return {
      ...base,
      schemaVersion: collected.content.schemaVersion,
      summary,
      memorySummary: summary,
      checksum: snapshotChecksum(base),
      inputTokens: collected.tokenAccounting.totalInputTokens,
      outputTokens: collected.tokenAccounting.totalOutputTokens,
      estimatedCostUsd: collected.tokenAccounting.totalCostUsd,
      tokenAccounting: collected.tokenAccounting,
      canonicalJson: snapshotCanonicalJson(base),
    }
  }

  async buildAndPersist(request: ContextSnapshotBuildRequest): Promise<AgentContextSnapshot> {
    if (!this.store) throw new ContextSnapshotError("invalid_input", "A snapshot store is required for persistence")
    return this.store.save(await this.build(request), request.scope)
  }
}
