import { pinnedFetch } from '@jobcopilot/shared'
import { aiUsageErrorCode, recordAiUsage } from '@/lib/ai-usage'

const MODEL = 'text-embedding-3-small'
const DIMENSIONS = 1536

export async function embedPersonaText(text: string, userId?: string): Promise<number[] | null> {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key || !text.trim()) return null

  const startedAt = Date.now()
  try {
    const response = await pinnedFetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, input: text.slice(0, 8_000) }),
    })
    if (!response.ok) throw new Error(`Embedding provider returned ${response.status}`)
    const body = await response.json() as { data?: Array<{ embedding?: unknown }>; usage?: { prompt_tokens?: number; total_tokens?: number } }
    const embedding = body.data?.[0]?.embedding
    if (!Array.isArray(embedding) || embedding.length !== DIMENSIONS || embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
      throw new Error('Embedding provider returned an invalid vector')
    }
    const inputTokens = body.usage?.prompt_tokens ?? body.usage?.total_tokens ?? 0
    await recordAiUsage({ userId, featureKey: 'personaEmbedding', provider: 'openai', model: MODEL, credentialSource: 'platform', inputTokens, estimatedCostUsd: Number((inputTokens * 0.02 / 1_000_000).toFixed(8)), latencyMs: Date.now() - startedAt, status: 'success' })
    return embedding
  } catch (error) {
    await recordAiUsage({ userId, featureKey: 'personaEmbedding', provider: 'openai', model: MODEL, credentialSource: 'platform', latencyMs: Date.now() - startedAt, status: 'error', errorCode: aiUsageErrorCode(error) })
    throw error
  }
}

export function vectorLiteral(embedding: number[]) {
  return `[${embedding.join(',')}]`
}

export { MODEL as PERSONA_EMBEDDING_MODEL }
