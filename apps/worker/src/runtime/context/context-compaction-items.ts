import { randomUUID } from "node:crypto"

import { redactSensitiveText } from "@jobcopilot/shared"

import { COMPACTION_ITEM_TYPE, type CompactionError, type CompactionInvariantReport, type CompactionItemRecord, type CompactionSource, type CompactionStatus, type CompactionTokenMeasurement, type CompactionTriggerReason } from "./context-compaction-types.js"

export type CompactionItemIdFactory = () => string

function preview(value: string): string {
  return redactSensitiveText(value.replace(/\s+/g, " ").trim()).slice(0, 280)
}

function base(input: { id: string; sessionId: string; turnId: string; throughSequence: bigint; source: CompactionSource; reason: CompactionTriggerReason; status: CompactionStatus; preservedFields: CompactionInvariantReport["preservedFields"] }): CompactionItemRecord {
  return {
    id: input.id, sessionId: input.sessionId, turnId: input.turnId, type: COMPACTION_ITEM_TYPE, status: input.status,
    body: `Context compaction ${input.status}`,
    data: { reason: input.reason, throughSequence: input.throughSequence.toString(), sourceItemCount: input.source.items.length, beforeInputTokens: 0, preservedFields: input.preservedFields },
  }
}

export function createCompactionStartedItem(input: { sessionId: string; turnId: string; throughSequence: bigint; source: CompactionSource; reason: CompactionTriggerReason; preservedFields?: CompactionInvariantReport["preservedFields"]; id?: string }, idFactory: CompactionItemIdFactory = randomUUID): CompactionItemRecord {
  const item = base({ ...input, id: input.id ?? idFactory(), status: "started", preservedFields: input.preservedFields ?? [] })
  return { ...item, body: "Context compaction started" }
}

export function completeCompactionItem(started: CompactionItemRecord, input: { summary: string; measurement: CompactionTokenMeasurement; report: CompactionInvariantReport }): CompactionItemRecord {
  return {
    ...started, status: "completed", body: `Context compaction completed: ${preview(input.summary)}`,
    data: { ...started.data, beforeInputTokens: input.measurement.beforeInputTokens, afterInputTokens: input.measurement.afterInputTokens, reductionTokens: input.measurement.reductionTokens, reductionRatio: input.measurement.reductionRatio, preservedFields: input.report.preservedFields, summaryPreview: preview(input.summary) },
  }
}

export function failCompactionItem(started: CompactionItemRecord, error: CompactionError): CompactionItemRecord {
  return { ...started, status: "failed", body: `Context compaction failed (${error.code}); previous snapshot retained`, data: { ...started.data, errorCode: error.code, previousSnapshotRetained: true } }
}
