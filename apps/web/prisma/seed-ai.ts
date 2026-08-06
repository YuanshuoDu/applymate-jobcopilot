export interface AiSeedDatabase {
  aiProviderConfig: { upsert(args: { where: { key: string }; update: Record<string, unknown>; create: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }> }
  aiModelConfig: { upsert(args: { where: { providerId_model: { providerId: string; model: string } }; update: Record<string, unknown>; create: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }> }
  aiRouteConfig: { upsert(args: { where: { featureKey: string }; update: Record<string, unknown>; create: Record<string, unknown>; select: { id: true } }): Promise<{ id: string }> }
}

export const AI_PROVIDER_SEEDS = [
  { key: 'minimax', displayName: 'MiniMax', apiBase: 'https://api.minimax.io/v1', secretRef: 'MINIMAX_API_KEY', models: [{ model: 'MiniMax-M3', label: 'MiniMax M3', description: 'Platform default reasoning model', tier: 'standard', priceIn: 0.6, priceOut: 2.4, contextK: 512 }, { model: 'MiniMax-M2.7-highspeed', label: 'MiniMax M2.7 Highspeed', description: 'Lower-latency MiniMax model', tier: 'fast', priceIn: 0.6, priceOut: 2.4, contextK: 200 }] },
  { key: 'deepseek', displayName: 'DeepSeek', apiBase: 'https://api.deepseek.com/v1', secretRef: 'DEEPSEEK_API_KEY', models: [{ model: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', description: 'Fallback reasoning model', tier: 'standard', priceIn: 0.435, priceOut: 0.87, contextK: 1000 }, { model: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash', description: 'Low-latency fallback model', tier: 'fast', priceIn: 0.14, priceOut: 0.28, contextK: 1000 }] },
  { key: 'openai', displayName: 'OpenAI', apiBase: 'https://api.openai.com/v1', secretRef: 'OPENAI_API_KEY', models: [{ model: 'gpt-5.5', label: 'GPT-5.5', description: 'OpenAI flagship', tier: 'premium', priceIn: 5, priceOut: 30, contextK: 1000 }, { model: 'gpt-5.6-terra', label: 'GPT-5.6 Terra', description: 'Balanced OpenAI model', tier: 'premium', priceIn: 2.5, priceOut: 15, contextK: 1050 }] },
  { key: 'anthropic', displayName: 'Anthropic', apiBase: 'https://api.anthropic.com', secretRef: 'ANTHROPIC_API_KEY', models: [{ model: 'claude-sonnet-5', label: 'Claude Sonnet 5', description: 'Anthropic balanced model', tier: 'premium', priceIn: 3, priceOut: 15, contextK: 1000 }] },
] as const

const ROUTE_KEYS = ['scoring', 'parsing', 'suggest', 'coverLetter', 'agent', 'fieldSuggest', 'interviewPrep', 'formFill', 'formRevise', 'autoApply', 'jobScoring'] as const

export async function seedAiConfiguration(database: AiSeedDatabase): Promise<{ providerCount: number; modelCount: number; routeCount: number }> {
  const providerIds = new Map<string, string>()
  let modelCount = 0
  for (const provider of AI_PROVIDER_SEEDS) {
    const configured = Boolean(provider.secretRef && process.env[provider.secretRef])
    const row = await database.aiProviderConfig.upsert({ where: { key: provider.key }, update: { credentialConfigured: configured }, create: { key: provider.key, displayName: provider.displayName, apiBase: provider.apiBase, secretRef: provider.secretRef, credentialConfigured: configured, enabled: true }, select: { id: true } })
    providerIds.set(provider.key, row.id)
    for (const model of provider.models) { await database.aiModelConfig.upsert({ where: { providerId_model: { providerId: row.id, model: model.model } }, update: {}, create: { providerId: row.id, ...model, active: true }, select: { id: true } }); modelCount += 1 }
  }
  let routeCount = 0
  for (const featureKey of ROUTE_KEYS) { await database.aiRouteConfig.upsert({ where: { featureKey }, update: {}, create: { featureKey, defaultProvider: 'minimax', defaultModel: 'MiniMax-M3', fallbackProvider: 'deepseek', fallbackModel: 'deepseek-v4-pro', updatedById: 'seed' }, select: { id: true } }); routeCount += 1 }
  void providerIds
  return { providerCount: AI_PROVIDER_SEEDS.length, modelCount, routeCount }
}
