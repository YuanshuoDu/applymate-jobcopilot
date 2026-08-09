import type { Prisma } from '@prisma/client'
import { db } from '@/lib/db'
import { APPLYMATE_BACKING, FEATURE_LABELS, MODEL_CATALOGUE, resolveConfig, type Provider } from '@/lib/model-router'

const SECRET_REFS: Partial<Record<Provider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', deepseek: 'DEEPSEEK_API_KEY', minimax: 'MINIMAX_API_KEY',
  qwen: 'QWEN_API_KEY', zhipu: 'ZHIPU_API_KEY', kimi: 'KIMI_API_KEY',
}

function configured(secretRef: string | null, provider: string) {
  const ref = secretRef || SECRET_REFS[provider as Provider]
  return Boolean(ref && process.env[ref])
}

async function bootstrap() {
  const count = await db.aiProviderConfig.count()
  if (count > 0) return
  const grouped = new Map<string, typeof MODEL_CATALOGUE>()
  for (const model of MODEL_CATALOGUE) grouped.set(model.provider, [...(grouped.get(model.provider) ?? []), model])
  await Promise.all([...grouped.entries()].map(([provider, models]) => db.aiProviderConfig.create({ data: {
    key: provider,
    displayName: provider,
    apiBase: models[0]?.defaultBase ?? '',
    secretRef: SECRET_REFS[provider as Provider] ?? null,
    credentialConfigured: configured(null, provider),
    models: { create: models.map(model => ({ model: model.model, label: model.label, description: model.description, tier: model.tier, priceIn: model.priceIn, priceOut: model.priceOut, contextK: model.contextK })) },
  } })))
  const defaultModel = MODEL_CATALOGUE.find(model => model.provider === APPLYMATE_BACKING.provider && model.model === APPLYMATE_BACKING.model) ?? MODEL_CATALOGUE[0]
  await db.$transaction(Object.keys(FEATURE_LABELS).map(featureKey => db.aiRouteConfig.create({ data: { featureKey, defaultProvider: defaultModel.provider, defaultModel: defaultModel.model, updatedById: 'system' } })))
}

export async function getAiAdminConfig() {
  await bootstrap().catch(() => undefined)
  const [providers, routes] = await Promise.all([
    db.aiProviderConfig.findMany({ orderBy: { key: 'asc' }, include: { models: { orderBy: { model: 'asc' } } } }),
    db.aiRouteConfig.findMany({ orderBy: { featureKey: 'asc' } }),
  ])
  return {
    providers: providers.map(provider => ({ ...provider, secretRef: provider.secretRef, credentialConfigured: configured(provider.secretRef, provider.key) })),
    routes,
    features: FEATURE_LABELS,
  }
}

export async function resolvePlatformRoute(featureKey: string) {
  const route = await db.aiRouteConfig.findUnique({ where: { featureKey }, select: { defaultProvider: true, defaultModel: true, fallbackProvider: true, fallbackModel: true } }).catch(() => null)
  const candidates = route ? [route, { defaultProvider: APPLYMATE_BACKING.provider, defaultModel: APPLYMATE_BACKING.model, fallbackProvider: null, fallbackModel: null }] : [{ defaultProvider: APPLYMATE_BACKING.provider, defaultModel: APPLYMATE_BACKING.model, fallbackProvider: null, fallbackModel: null }]
  for (const candidate of candidates) {
    const primary = resolveConfig({ provider: candidate.defaultProvider as Provider, model: candidate.defaultModel })
    if (primary.resolvedKey) return primary
    if (candidate.fallbackProvider && candidate.fallbackModel) {
      const fallback = resolveConfig({ provider: candidate.fallbackProvider as Provider, model: candidate.fallbackModel })
      if (fallback.resolvedKey) return fallback
    }
  }
  return resolveConfig(APPLYMATE_BACKING)
}

export type AiConfigMutation =
  | { type: 'provider'; id?: string; key: string; displayName: string; apiBase: string; secretRef: string | null; enabled: boolean }
  | { type: 'model'; id?: string; providerId: string; model: string; label: string; description: string; tier: string; priceIn: number; priceOut: number; contextK: number; active: boolean }
  | { type: 'route'; featureKey: string; defaultProvider: string; defaultModel: string; fallbackProvider: string | null; fallbackModel: string | null }

export function aiMutationData(input: AiConfigMutation, actorUserId: string): Prisma.AiProviderConfigCreateInput | Prisma.AiProviderConfigUpdateInput | Prisma.AiModelConfigCreateInput | Prisma.AiModelConfigUpdateInput | Prisma.AiRouteConfigCreateInput | Prisma.AiRouteConfigUpdateInput {
  if (input.type === 'provider') return { key: input.key, displayName: input.displayName, apiBase: input.apiBase, secretRef: input.secretRef, credentialConfigured: configured(input.secretRef, input.key), enabled: input.enabled, version: { increment: 1 } }
  if (input.type === 'model') return { provider: { connect: { id: input.providerId } }, model: input.model, label: input.label, description: input.description, tier: input.tier, priceIn: input.priceIn, priceOut: input.priceOut, contextK: input.contextK, active: input.active }
  return { featureKey: input.featureKey, defaultProvider: input.defaultProvider, defaultModel: input.defaultModel, fallbackProvider: input.fallbackProvider, fallbackModel: input.fallbackModel, version: { increment: 1 }, updatedById: actorUserId }
}
