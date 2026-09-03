import {
  CompactionError,
  type CompactionCollection,
  type CompactionFact,
  type CompactionInputItem,
  type CompactionOpenTask,
  type CompactionSource,
  type CompactionState,
  type CompactionApproval,
  type CompactionAnswer,
  type CompactionArtifact,
} from "./context-compaction-types.js"
import { canonicalJson, sha256Hex } from "./context-compaction-canonical.js"

const DEFAULT_NARRATIVE_INPUT_CHARACTERS = 24_000

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CompactionError("invalid_source", `${field} must be an object`)
  return value as Record<string, unknown>
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new CompactionError("invalid_source", `${field} must be non-empty`)
  return value
}

function strings(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new CompactionError("invalid_source", `${field} must be an array`)
  const result = value.map((entry, index) => text(entry, `${field}[${index}]`))
  if (new Set(result).size !== result.length) throw new CompactionError("invalid_source", `${field} contains duplicate values`)
  return result.sort((left, right) => left.localeCompare(right))
}

function optionalText(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : text(value, field)
}

function sortedById<T extends { readonly id: string }>(values: readonly T[], field: string): T[] {
  const ids = values.map((value) => value.id)
  if (new Set(ids).size !== ids.length) throw new CompactionError("invalid_source", `${field} contains duplicate ids`)
  return [...values].sort((left, right) => left.id.localeCompare(right.id))
}

function approvals(value: unknown): CompactionApproval[] {
  if (!Array.isArray(value)) throw new CompactionError("invalid_source", "approvals must be an array")
  return sortedById(value.map((entry, index) => {
    const item = record(entry, `approvals[${index}]`)
    return {
      id: text(item.id, `approvals[${index}].id`),
      status: text(item.status, `approvals[${index}].status`),
      ...(optionalText(item.scopeHash, `approvals[${index}].scopeHash`) ? { scopeHash: item.scopeHash as string } : {}),
      ...(optionalText(item.answersHash, `approvals[${index}].answersHash`) ? { answersHash: item.answersHash as string } : {}),
    }
  }), "approvals")
}

function answers(value: unknown): CompactionAnswer[] {
  if (!Array.isArray(value)) throw new CompactionError("invalid_source", "answers must be an array")
  return sortedById(value.map((entry, index) => {
    const item = record(entry, `answers[${index}]`)
    return {
      id: text(item.id, `answers[${index}].id`),
      question: text(item.question, `answers[${index}].question`),
      answer: text(item.answer, `answers[${index}].answer`),
      ...(optionalText(item.answerHash, `answers[${index}].answerHash`) ? { answerHash: item.answerHash as string } : {}),
    }
  }), "answers")
}

function artifacts(value: unknown): CompactionArtifact[] {
  if (!Array.isArray(value)) throw new CompactionError("invalid_source", "artifacts must be an array")
  return sortedById(value.map((entry, index) => {
    const item = record(entry, `artifacts[${index}]`)
    return { id: text(item.id, `artifacts[${index}].id`), type: text(item.type, `artifacts[${index}].type`), hash: text(item.hash, `artifacts[${index}].hash`) }
  }), "artifacts")
}

function openTasks(value: unknown): CompactionOpenTask[] {
  if (!Array.isArray(value)) throw new CompactionError("invalid_source", "openTasks must be an array")
  return sortedById(value.map((entry, index) => {
    const item = record(entry, `openTasks[${index}]`)
    const taskId = text(item.taskId, `openTasks[${index}].taskId`)
    return { id: taskId, taskId, status: text(item.status, `openTasks[${index}].status`), blocker: item.blocker === null ? null : text(item.blocker, `openTasks[${index}].blocker`) }
  }), "openTasks").map(({ id: _id, ...task }) => task)
}

function facts(value: unknown): CompactionFact[] {
  if (!Array.isArray(value)) throw new CompactionError("invalid_source", "facts must be an array")
  return [...value.map((entry, index) => {
    const item = record(entry, `facts[${index}]`)
    return { factId: text(item.factId, `facts[${index}].factId`), key: text(item.key, `facts[${index}].key`), source: text(item.source, `facts[${index}].source`) }
  })].sort((left, right) => left.factId.localeCompare(right.factId))
}

function normalizeState(input: CompactionState): CompactionState {
  const value = record(input, "state")
  const throughSequence = value.throughSequence
  if (typeof throughSequence !== "bigint" || throughSequence < 0n) throw new CompactionError("invalid_source", "state.throughSequence must be non-negative bigint")
  const normalizedFacts = facts(value.facts)
  if (new Set(normalizedFacts.map((fact) => fact.factId)).size !== normalizedFacts.length) throw new CompactionError("invalid_source", "facts contains duplicate ids")
  return {
    ownerId: text(value.ownerId, "state.ownerId"),
    sessionId: text(value.sessionId, "state.sessionId"),
    throughSequence,
    goal: text(value.goal, "state.goal"),
    userConstraints: strings(value.userConstraints, "state.userConstraints"),
    approvals: approvals(value.approvals),
    answers: answers(value.answers),
    artifacts: artifacts(value.artifacts),
    openTasks: openTasks(value.openTasks),
    doNotRepeat: strings(value.doNotRepeat, "state.doNotRepeat"),
    facts: normalizedFacts,
  }
}

function sequence(value: unknown, field: string): bigint {
  if (typeof value !== "bigint" || value < 0n) throw new CompactionError("invalid_source", `${field} must be non-negative bigint`)
  return value
}

function itemText(item: CompactionInputItem): string {
  if (typeof item.content === "string") return item.content
  try { return canonicalJson(item.content) } catch { return "[item content omitted]" }
}

function normalizeItems(items: readonly CompactionInputItem[], sessionId: string): CompactionInputItem[] {
  const result = items.map((item, index) => {
    const value = record(item, `items[${index}]`)
    const normalized = { ...item, id: text(value.id, `items[${index}].id`), sessionId: text(value.sessionId, `items[${index}].sessionId`), turnId: text(value.turnId, `items[${index}].turnId`), type: text(value.type, `items[${index}].type`), status: text(value.status, `items[${index}].status`), sequence: sequence(value.sequence, `items[${index}].sequence`) }
    if (normalized.sessionId !== sessionId) throw new CompactionError("invalid_source", `items[${index}] belongs to another session`)
    return normalized
  })
  if (new Set(result.map((item) => item.id)).size !== result.length) throw new CompactionError("invalid_source", "items contains duplicate ids")
  return result.sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : left.id.localeCompare(right.id))
}

export function estimateCompactionTokens(value: string): number {
  return Math.ceil(Array.from(value).length / 4)
}

export function collectCompactionState(source: CompactionSource, maxNarrativeInputCharacters = DEFAULT_NARRATIVE_INPUT_CHARACTERS): CompactionCollection {
  if (!Number.isSafeInteger(maxNarrativeInputCharacters) || maxNarrativeInputCharacters < 1) throw new CompactionError("invalid_source", "maxNarrativeInputCharacters must be positive")
  const state = normalizeState(source.state)
  const items = normalizeItems(source.items, state.sessionId)
  const rendered = items.map((item) => ({ id: item.id, sequence: item.sequence, type: item.type, text: itemText(item) }))
  const fullText = rendered.map((item) => `[${item.sequence.toString()}] ${item.type} ${item.text}`).join("\n")
  return {
    state,
    narrativeItems: rendered,
    narrativeText: fullText.slice(0, maxNarrativeInputCharacters),
    sourceItemIds: items.map((item) => item.id),
    beforeInputTokens: estimateCompactionTokens(fullText),
    stateDigest: sha256Hex(state),
  }
}

export function compactionStateCanonicalJson(state: CompactionState): string {
  return canonicalJson(state)
}
