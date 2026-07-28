const MODEL = 'text-embedding-3-small'
const DIMENSIONS = 1536

export async function embedPersonaText(text: string): Promise<number[] | null> {
  const key = process.env.OPENAI_API_KEY?.trim()
  if (!key || !text.trim()) return null

  const response = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, input: text.slice(0, 8_000) }),
  })
  if (!response.ok) throw new Error(`Embedding provider returned ${response.status}`)
  const body = await response.json() as { data?: Array<{ embedding?: unknown }> }
  const embedding = body.data?.[0]?.embedding
  if (!Array.isArray(embedding) || embedding.length !== DIMENSIONS || embedding.some(value => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('Embedding provider returned an invalid vector')
  }
  return embedding
}

export function vectorLiteral(embedding: number[]) {
  return `[${embedding.join(',')}]`
}

export { MODEL as PERSONA_EMBEDDING_MODEL }
