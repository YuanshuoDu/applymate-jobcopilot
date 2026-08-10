import { db } from '@/lib/db'

export type AiUsageStatus = 'success' | 'error'

export async function recordAiUsage(input: {
  userId?: string
  featureKey?: string
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  estimatedCostUsd?: number
  latencyMs: number
  status: AiUsageStatus
  errorCode?: string
}): Promise<void> {
  if (typeof db.aiUsageEvent?.create !== 'function') return
  await db.aiUsageEvent.create({ data: {
    userId: input.userId,
    featureKey: input.featureKey ?? 'unclassified',
    provider: input.provider,
    model: input.model,
    inputTokens: Math.max(0, Math.trunc(input.inputTokens ?? 0)),
    outputTokens: Math.max(0, Math.trunc(input.outputTokens ?? 0)),
    estimatedCostUsd: Math.max(0, input.estimatedCostUsd ?? 0),
    latencyMs: Math.max(0, Math.trunc(input.latencyMs)),
    status: input.status,
    errorCode: input.errorCode?.slice(0, 120),
  } }).catch(() => undefined)
}
