import {
  ContextSnapshotError,
  type ContextSnapshotTokenAccounting,
  type ContextSnapshotTokenProfile,
  type ContextSnapshotTokenUsage,
} from "./context-snapshot-types.js"

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ContextSnapshotError("token_invalid", `${field} must be non-empty`)
  return value
}

function tokenCount(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new ContextSnapshotError("token_invalid", `${field} must be a non-negative safe integer`)
  return value
}

function cost(value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new ContextSnapshotError("token_invalid", "estimatedCostUsd must be a non-negative finite number")
  return roundCost(value)
}

function roundCost(value: number): number {
  return Number(value.toFixed(8))
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function addCount(left: number, right: number, field: string): number {
  const result = left + right
  if (!Number.isSafeInteger(result)) throw new ContextSnapshotError("token_invalid", `${field} exceeds the safe integer range`)
  return result
}

type MutableProfile = {
  readonly profileKey: string
  readonly provider: string
  readonly model: string
  readonly profileId?: string
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
}

function profileKey(sample: ContextSnapshotTokenUsage): string {
  return sample.profileId ?? `${sample.provider}:${sample.model}`
}

export function aggregateTokenAccounting(samples: readonly ContextSnapshotTokenUsage[]): ContextSnapshotTokenAccounting {
  const profiles = new Map<string, MutableProfile>()
  let totalInputTokens = 0
  let totalOutputTokens = 0
  let totalCostUsd = 0

  for (const sample of samples) {
    const provider = nonEmpty(sample.provider, "provider")
    const model = nonEmpty(sample.model, "model")
    if (sample.profileId !== undefined) nonEmpty(sample.profileId, "profileId")
    const inputTokens = tokenCount(sample.inputTokens, "inputTokens")
    const outputTokens = tokenCount(sample.outputTokens, "outputTokens")
    const estimatedCostUsd = cost(sample.estimatedCostUsd)
    const key = profileKey({ ...sample, provider, model })
    const current = profiles.get(key)
    if (current && (current.provider !== provider || current.model !== model || current.profileId !== sample.profileId)) {
      throw new ContextSnapshotError("token_invalid", `Profile ${key} has conflicting provider/model metadata`)
    }
    const aggregate = current ?? {
      profileKey: key,
      provider,
      model,
      ...(sample.profileId === undefined ? {} : { profileId: sample.profileId }),
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
    }
    aggregate.inputTokens = addCount(aggregate.inputTokens, inputTokens, "inputTokens")
    aggregate.outputTokens = addCount(aggregate.outputTokens, outputTokens, "outputTokens")
    aggregate.estimatedCostUsd = roundCost(aggregate.estimatedCostUsd + estimatedCostUsd)
    profiles.set(key, aggregate)
    totalInputTokens = addCount(totalInputTokens, inputTokens, "totalInputTokens")
    totalOutputTokens = addCount(totalOutputTokens, outputTokens, "totalOutputTokens")
    totalCostUsd = roundCost(totalCostUsd + estimatedCostUsd)
  }

  const orderedProfiles: ContextSnapshotTokenProfile[] = [...profiles.values()]
    .sort((left, right) => compareText(left.profileKey, right.profileKey))
    .map((profile) => ({ ...profile }))
  return { profiles: orderedProfiles, totalInputTokens, totalOutputTokens, totalCostUsd }
}
