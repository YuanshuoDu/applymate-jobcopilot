export interface LegacyQuestionBridgeQuestion {
  id: string
  userId: string
  runId: string
  stage: string
  question: string
  options: unknown
}

export interface LegacyQuestionBridgeSession {
  id: string
  userId: string
}

export interface LegacyQuestionBridgeTurn {
  id: string
  sessionId: string
  userId: string
  status: string
}

export interface LegacyQuestionBridgeItem {
  id: string
  sessionId: string
  turnId: string
  type: string
  status: string
  content: unknown
}

export interface LegacyQuestionBridgeInput {
  question: LegacyQuestionBridgeQuestion
  userId: string
  session: LegacyQuestionBridgeSession | null
  activeTurns: readonly LegacyQuestionBridgeTurn[]
  item: LegacyQuestionBridgeItem | null
  provenance: unknown
}

export type LegacyQuestionBridgeDecision =
  | { disposition: "bridged"; questionId: string; sessionId: string; turnId: string; itemId: string }
  | { disposition: "bridge_pending"; reason: "session_missing" | "active_turn_missing" | "active_turn_ambiguous" | "canonical_item_missing" | "provenance_missing" }
  | { disposition: "legacy_only"; reason: "foreign_ownership" | "session_mismatch" | "turn_mismatch" | "canonical_item_mismatch" | "provenance_mismatch" }

type JsonRecord = Record<string, unknown>
const ACTIVE_TURN_STATUSES = new Set(["queued", "in_progress", "waiting_for_dependency", "waiting_for_approval", "waiting_for_user"])

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`
  if (value !== null && typeof value === "object") {
    const row = value as JsonRecord
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${stableJson(row[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

function sameJson(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right)
}

function hasQuestionProvenance(provenance: unknown, questionId: string): "missing" | "mismatch" | "match" {
  if (provenance === null || provenance === undefined) return "missing"
  const row = record(provenance)
  if (!("sourceEvent" in row) && !("sourcePayload" in row)) return "missing"
  if (row.sourceEvent === "orchestrator_question" && (row.sourcePayload === undefined || row.sourcePayload === null)) return "missing"
  const sourcePayload = record(row.sourcePayload)
  if (row.sourceEvent === "orchestrator_question" && sourcePayload.id === questionId) return "match"
  return "mismatch"
}

export function classifyLegacyQuestionBridge(input: LegacyQuestionBridgeInput): LegacyQuestionBridgeDecision {
  const { question, session } = input
  if (!session) return { disposition: "bridge_pending", reason: "session_missing" }
  if (question.userId !== input.userId || session.userId !== input.userId) {
    return { disposition: "legacy_only", reason: "foreign_ownership" }
  }
  if (question.runId !== session.id) return { disposition: "legacy_only", reason: "session_mismatch" }
  if (input.activeTurns.length === 0) return { disposition: "bridge_pending", reason: "active_turn_missing" }
  if (input.activeTurns.length > 1) return { disposition: "bridge_pending", reason: "active_turn_ambiguous" }

  const turn = input.activeTurns[0]
  if (turn.sessionId !== session.id || turn.userId !== input.userId || !ACTIVE_TURN_STATUSES.has(turn.status)) {
    return { disposition: "legacy_only", reason: "turn_mismatch" }
  }
  if (!input.item) return { disposition: "bridge_pending", reason: "canonical_item_missing" }

  const content = record(input.item.content)
  const itemMatches = input.item.sessionId === session.id && input.item.turnId === turn.id &&
    input.item.type === "question" && input.item.status === "started" &&
    content.questionId === question.id && content.stage === question.stage &&
    content.question === question.question && sameJson(content.options, question.options)
  if (!itemMatches) return { disposition: "legacy_only", reason: "canonical_item_mismatch" }

  const provenance = hasQuestionProvenance(input.provenance, question.id)
  if (provenance === "missing") return { disposition: "bridge_pending", reason: "provenance_missing" }
  if (provenance === "mismatch") return { disposition: "legacy_only", reason: "provenance_mismatch" }
  return { disposition: "bridged", questionId: question.id, sessionId: session.id, turnId: turn.id, itemId: input.item.id }
}
