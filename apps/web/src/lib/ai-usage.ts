import { db } from '@/lib/db'
import { getEffectiveEntitlements } from './entitlements'

export type AiUsageStatus = 'success' | 'error'
export type AiUsageRuntime = 'web' | 'worker' | 'admin' | 'unknown'

const STABLE_ERROR_CODES = new Set([
  'configuration_error',
  'network_error',
  'provider_error',
  'timeout',
])

export function aiUsageErrorCode(error: unknown): string {
  const name = error instanceof Error ? error.name.toLowerCase() : ''
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  const normalized = message.toLowerCase()
  const status = message.match(/(?:api error|http(?: status)?|status)\s*[:=]?\s*([1-5]\d{2})/i)?.[1]
  if (status) return `http_${status}`
  if (name === 'aborterror' || /timeout|timed out|aborted/.test(normalized)) return 'timeout'
  if (/fetch failed|econnreset|econnrefused|enotfound|network/.test(normalized)) return 'network_error'
  if (/no api key|configuration|not an allowed|api base url/.test(normalized)) return 'configuration_error'
  return 'provider_error'
}

function stableErrorCode(value: string | undefined): string | undefined {
  if (!value) return undefined
  if (STABLE_ERROR_CODES.has(value) || /^http_[1-5]\d{2}$/.test(value)) return value
  return aiUsageErrorCode(value)
}

function currentMonth(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

async function recordAiBudgetCredit(userId: string, now = new Date()): Promise<void> {
  if (typeof db.aiBudget?.upsert !== 'function') return
  const limit = (await getEffectiveEntitlements(userId)).limits.ai_credits
  if (limit === null || limit === undefined) return

  const month = currentMonth(now)
  await db.aiBudget.upsert({
    where: { userId_month: { userId, month } },
    create: { userId, month, used: 1, limit },
    update: { used: { increment: 1 } },
  })
}

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
  credentialSource?: 'platform' | 'user'
  runtime?: AiUsageRuntime
  chargeBudget?: boolean
}): Promise<void> {
  if (typeof db.aiUsageEvent?.create === 'function') {
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
      errorCode: stableErrorCode(input.errorCode),
      credentialSource: input.credentialSource ?? 'platform',
      runtime: input.runtime ?? 'web',
    } }).catch(() => undefined)
  }

  // Provider tests have no usageUserId and remain telemetry-only. User-scoped
  // calls consume exactly one monthly credit, including failed upstream calls.
  if (input.userId && input.chargeBudget !== false) await recordAiBudgetCredit(input.userId).catch(() => undefined)
}
