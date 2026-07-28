import { createHash } from 'crypto'
import { db } from '@/lib/db'
import { embedPersonaText, PERSONA_EMBEDDING_MODEL, vectorLiteral } from '@/lib/persona-embeddings'
import type { PersonaAllowedUse } from '@/lib/persona-facts'
import type { ResumeContent } from '@/lib/types'

type Candidate = { sourceType: string; sourceRef: string; factId?: string; content: string; allowedUses: string[] }
export type PersonaEvidence = { content: string; sourceType: string; sourceRef: string; score: number }

const ALL_USES = ['form_fill', 'tailor', 'cover_letter']

function digest(value: string) { return createHash('sha256').update(value).digest('hex') }

function resumeCandidates(id: string, content: ResumeContent): Candidate[] {
  const base = `resume:${id}`
  return [
    ...(content.summary?.trim() ? [{ sourceType: 'resume', sourceRef: `${base}:summary`, content: content.summary, allowedUses: ALL_USES }] : []),
    ...content.experience.flatMap((item, index) => item.bullets.map((bullet, bulletIndex) => ({ sourceType: 'resume', sourceRef: `${base}:experience:${index}:${bulletIndex}`, content: `${item.role} at ${item.company}: ${bullet}`, allowedUses: ALL_USES }))),
    ...(content.projects ?? []).flatMap((item, index) => item.bullets.map((bullet, bulletIndex) => ({ sourceType: 'resume', sourceRef: `${base}:project:${index}:${bulletIndex}`, content: `${item.name}: ${bullet}`, allowedUses: ALL_USES }))),
  ].filter(candidate => Boolean(candidate.content.trim()))
}

export async function syncPersonaEvidence(userId: string) {
  const [resumes, facts] = await Promise.all([
    db.resume.findMany({ where: { userId, kind: 'base' }, select: { id: true, content: true } }),
    db.personaFact.findMany({ where: { userId, status: 'confirmed', revokedAt: null }, select: { id: true, key: true, value: true, allowedUses: true } }),
  ])
  const candidates = [
    ...resumes.flatMap(resume => resumeCandidates(resume.id, resume.content as unknown as ResumeContent)),
    ...facts.map(fact => ({ sourceType: 'persona_fact', sourceRef: `fact:${fact.id}`, factId: fact.id, content: `${fact.key}: ${fact.value}`, allowedUses: fact.allowedUses })),
  ]
  const existing = await db.personaEvidenceChunk.findMany({ where: { userId }, select: { id: true, sourceRef: true, contentHash: true } })
  const existingKeys = new Set(existing.map(chunk => `${chunk.sourceRef}:${chunk.contentHash}`))
  const fresh = candidates.filter(candidate => !existingKeys.has(`${candidate.sourceRef}:${digest(candidate.content)}`))
  if (fresh.length) await db.personaEvidenceChunk.createMany({ data: fresh.map(candidate => ({
    userId, factId: candidate.factId, sourceType: candidate.sourceType, sourceRef: candidate.sourceRef,
    content: candidate.content, contentHash: digest(candidate.content), allowedUses: candidate.allowedUses,
  })) })

  const pending = await db.personaEvidenceChunk.findMany({ where: { userId, status: 'confirmed', embeddedAt: null }, select: { id: true, content: true } })
  let embedded = 0
  for (const chunk of pending) {
    const embedding = await embedPersonaText(chunk.content)
    if (!embedding) break
    await db.$executeRaw`UPDATE "persona_evidence_chunks" SET "embedding" = ${vectorLiteral(embedding)}::vector, "embedding_model" = ${PERSONA_EMBEDDING_MODEL}, "embedded_at" = NOW() WHERE "id" = ${chunk.id}`
    embedded++
  }
  return { candidates: candidates.length, indexed: fresh.length, embedded, semanticEnabled: Boolean(process.env.OPENAI_API_KEY?.trim()) }
}

export async function retrievePersonaEvidence(userId: string, use: PersonaAllowedUse, query: string, limit = 5): Promise<PersonaEvidence[]> {
  const embedding = await embedPersonaText(query)
  if (!embedding) return lexicalEvidence(userId, use, query, limit)
  const rows = await db.$queryRaw<Array<{ content: string; sourceType: string; sourceRef: string; score: number }>>`
    SELECT "content", "source_type" AS "sourceType", "source_ref" AS "sourceRef", (1 - ("embedding" <=> ${vectorLiteral(embedding)}::vector))::float8 AS "score"
    FROM "persona_evidence_chunks"
    WHERE "userId" = ${userId} AND "status" = 'confirmed' AND ${use} = ANY("allowedUses") AND "embedding" IS NOT NULL
    ORDER BY "embedding" <=> ${vectorLiteral(embedding)}::vector LIMIT ${limit}`
  return rows
}

async function lexicalEvidence(userId: string, use: PersonaAllowedUse, query: string, limit: number): Promise<PersonaEvidence[]> {
  const tokens = new Set(query.toLowerCase().match(/[a-z0-9+#.]{3,}/g) ?? [])
  const chunks = await db.personaEvidenceChunk.findMany({ where: { userId, status: 'confirmed', allowedUses: { has: use } }, take: 80, orderBy: { updatedAt: 'desc' } })
  return chunks.map(chunk => ({ ...chunk, score: [...tokens].filter(token => chunk.content.toLowerCase().includes(token)).length }))
    .filter(chunk => chunk.score > 0).sort((a, b) => b.score - a.score).slice(0, limit)
}

export async function personaEvidenceContext(userId: string, use: PersonaAllowedUse, query: string) {
  const evidence = await retrievePersonaEvidence(userId, use, query)
  return evidence.length ? `APPROVED RELEVANT EVIDENCE:\n${evidence.map(item => `- ${item.content}`).join('\n')}` : ''
}
