import { redactSensitiveText } from "@jobcopilot/shared"

import { collectCompactionState, estimateCompactionTokens } from "./context-compaction-collector.js"
import { canonicalJson } from "./context-compaction-canonical.js"
import { completeCompactionItem, createCompactionStartedItem, failCompactionItem, type CompactionItemIdFactory } from "./context-compaction-items.js"
import { assertCompactionInvariantsPreserved } from "./context-compaction-validator.js"
import { evaluateCompactionTrigger } from "./context-compaction-trigger.js"
import type { ContextSnapshotCompactionPort } from "./context-snapshot-compaction-seam.js"
import { CompactionError, type CompactionBounds, type CompactionRequest, type CompactionResult, type CompactionState, type CompactionTokenMeasurement, type NarrativeSummarizer } from "./context-compaction-types.js"

const DEFAULT_BOUNDS: CompactionBounds = { maxNarrativeInputCharacters: 24_000, maxSummaryCharacters: 2_000 }

function bounds(input: Partial<CompactionBounds> | undefined): CompactionBounds {
  const result = { ...DEFAULT_BOUNDS, ...input }
  for (const [key, value] of Object.entries(result)) if (!Number.isSafeInteger(value) || value < 1) throw new CompactionError("invalid_source", `${key} must be positive`)
  return result
}

function boundedSummary(value: unknown, maxCharacters: number): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CompactionError("summarizer_failed", "Narrative summarizer returned no summary")
  return redactSensitiveText(value.replace(/\s+/g, " ").trim()).slice(0, maxCharacters)
}

function tokenMeasurement(state: CompactionState, summary: string, beforeInputTokens: number): CompactionTokenMeasurement {
  const afterInputTokens = estimateCompactionTokens(canonicalJson({ summary, state }))
  if (afterInputTokens >= beforeInputTokens) throw new CompactionError("no_token_reduction", "Compaction did not reduce input tokens")
  const reductionTokens = beforeInputTokens - afterInputTokens
  return { beforeInputTokens, afterInputTokens, reductionTokens, reductionRatio: Number((reductionTokens / Math.max(1, beforeInputTokens)).toFixed(6)) }
}

function errorCode(error: unknown): string {
  return error instanceof CompactionError ? error.code : "unexpected_failure"
}

export class ContextCompactor {
  constructor(
    private readonly port: ContextSnapshotCompactionPort,
    private readonly summarizer: NarrativeSummarizer,
    private readonly idFactory?: CompactionItemIdFactory,
  ) {}

  async compact(request: CompactionRequest): Promise<CompactionResult> {
    const limits = bounds(request.bounds)
    const collection = collectCompactionState(request.source, limits.maxNarrativeInputCharacters)
    const trigger = evaluateCompactionTrigger({ inputTokens: collection.beforeInputTokens, itemCount: collection.sourceItemIds.length, atTurnBoundary: request.atTurnBoundary, requested: request.requested }, request.policy)
    if (!trigger.shouldCompact || !trigger.reason) return { status: "skipped", trigger, item: null }

    const started = createCompactionStartedItem({ sessionId: collection.state.sessionId, turnId: request.turnId, throughSequence: collection.state.throughSequence, source: request.source, reason: trigger.reason, id: request.itemId }, this.idFactory)
    let lifecycleStarted = false
    try {
      lifecycleStarted = true
      await this.port.recordStarted(started, request.scope)
      const narrativeSummary = boundedSummary(await this.summarizer({ sessionId: collection.state.sessionId, throughSequence: collection.state.throughSequence, narrativeText: collection.narrativeText, state: collection.state, itemCount: collection.sourceItemIds.length, maxOutputCharacters: limits.maxSummaryCharacters }), limits.maxSummaryCharacters)
      const report = assertCompactionInvariantsPreserved(collection.state, collection.state)
      const measurement = tokenMeasurement(collection.state, narrativeSummary, collection.beforeInputTokens)
      const draft = { scope: request.scope, turnId: request.turnId, state: collection.state, narrativeSummary, tokenMeasurement: measurement, sourceItemIds: collection.sourceItemIds, reason: trigger.reason }
      const startedSnapshot = await this.port.loadLatest({ scope: request.scope, sessionId: collection.state.sessionId })
      const completed = completeCompactionItem(started, { summary: narrativeSummary, measurement, report })
      const snapshot = await this.port.publishAtomically({ scope: request.scope, previousSnapshot: startedSnapshot, draft, startedItem: started, completedItem: completed })
      return { status: "compacted", trigger, item: completed, snapshot, invariantReport: report, tokenMeasurement: measurement, failureRecorded: false }
    } catch (error: unknown) {
      const failure = error instanceof CompactionError ? error : new CompactionError("publish_failed", "Compaction failed")
      const failed = failCompactionItem(started, failure)
      let failureRecorded = false
      if (lifecycleStarted) {
        try { await this.port.recordFailed(failed, request.scope); failureRecorded = true } catch { failureRecorded = false }
      }
      return { status: "failed", trigger, item: failed, errorCode: errorCode(error), failureRecorded }
    }
  }
}
