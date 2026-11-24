import { hashContent } from "./canonical-json.js"

export type AgentSelectedJobQueryParameter = string | number | readonly string[] | null
export interface AgentSelectedJobMaterialQueryClient {
  query<Row>(sql: string, values: readonly AgentSelectedJobQueryParameter[]): Promise<{ rows: readonly Row[] }>
}

export type AgentSelectedJobJob = Readonly<{
  id: string; company: string; role: string; location: string | null; status: string; score: number | null
  url: string | null; source: string | null; salary: string | null; description: string | null; keywords: string | null
}>
export type AgentSelectedJobResume = Readonly<{
  id: string; name: string; kind: string; origin: string; isDefault: boolean; content: unknown; createdAt: string; updatedAt: string
}>
export type AgentSelectedJobPersonaFact = Readonly<{
  id: string; key: string; category: string; value: string; source: string; sourceRef: string | null; confidence: number; allowedUses: readonly string[]
}>
export type AgentSelectedJobSourceMaterial = Readonly<{ sourceRef: string; content: unknown }>
export type AgentSelectedJobMaterial = Readonly<{
  job: AgentSelectedJobJob; baseResume: AgentSelectedJobResume; personaFacts: readonly AgentSelectedJobPersonaFact[]
  preparation: Readonly<{ jobId: string; sourceDigest: string; evidenceRefs: readonly string[] }>
  transientSources: readonly AgentSelectedJobSourceMaterial[]
}>

interface JobRow extends AgentSelectedJobJob { createdAt: Date | string; updatedAt: Date | string }
interface ResumeRow extends Omit<AgentSelectedJobResume, "createdAt" | "updatedAt"> { createdAt: Date | string; updatedAt: Date | string }
interface PersonaRow extends Omit<AgentSelectedJobPersonaFact, "confidence" | "allowedUses"> { confidence: number | string; allowedUses: string[] }

const JOB_SQL = `SELECT "id", "company", "role", "location", "status", "score", "url", "source", "salary", "description", "keywords", "createdAt", "updatedAt"
  FROM "Job" WHERE "id" = $1 AND "userId" = $2`
const BASE_RESUME_SQL = `SELECT "id", "name", "kind", "origin", "isDefault", "content", "createdAt", "updatedAt"
  FROM "Resume" WHERE "userId" = $1 AND "kind" = 'base'
    AND ($2::text IS NULL OR "id" = $2)
    ORDER BY "isDefault" DESC, "updatedAt" DESC, "id" DESC LIMIT 1`
const PERSONA_SQL = `SELECT "id", "key", "category", "value", "source", "source_ref" AS "sourceRef", "confidence", "allowedUses"
  FROM persona_facts
  WHERE "userId" = $1 AND "status" = 'confirmed' AND ("expires_at" IS NULL OR "expires_at" > statement_timestamp())
    AND ($2::text[] IS NULL OR "key" = ANY($2::text[]))
    AND ($3::text IS NULL OR $3 = ANY("allowedUses"))
  ORDER BY "updated_at" DESC, "id" DESC LIMIT 50`

function iso(value: Date | string): string { return (value instanceof Date ? value : new Date(value)).toISOString() }

function normalizeJob(row: JobRow): AgentSelectedJobJob {
  return { id: row.id, company: row.company, role: row.role, location: row.location ?? null, status: row.status,
    score: row.score ?? null, url: row.url ?? null, source: row.source ?? null, salary: row.salary ?? null,
    description: row.description ?? null, keywords: row.keywords ?? null }
}

function normalizeResume(row: ResumeRow): AgentSelectedJobResume {
  return { ...row, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) }
}

function normalizePersonaFact(row: PersonaRow): AgentSelectedJobPersonaFact {
  return { ...row, confidence: Number(row.confidence), allowedUses: [...row.allowedUses] }
}

export async function readAgentSelectedJobJob(client: AgentSelectedJobMaterialQueryClient, userId: string, jobId: string): Promise<AgentSelectedJobJob | null> {
  const result = await client.query<JobRow>(JOB_SQL, [jobId, userId])
  return result.rows[0] ? normalizeJob(result.rows[0]) : null
}

export async function readAgentSelectedJobBaseResume(
  client: AgentSelectedJobMaterialQueryClient, userId: string, resumeId?: string,
): Promise<AgentSelectedJobResume | null> {
  const result = await client.query<ResumeRow>(BASE_RESUME_SQL, [userId, resumeId ?? null])
  return result.rows[0] ? normalizeResume(result.rows[0]) : null
}

export async function readAgentSelectedJobPersonaFacts(
  client: AgentSelectedJobMaterialQueryClient, userId: string, input: Readonly<{ keys?: readonly string[]; useCase?: string }> = {},
): Promise<readonly AgentSelectedJobPersonaFact[]> {
  const result = await client.query<PersonaRow>(PERSONA_SQL, [userId, input.keys?.length ? [...input.keys] : null, input.useCase ?? null])
  return result.rows.map(normalizePersonaFact)
}

export function buildAgentSelectedJobMaterial(input: Readonly<{
  job: AgentSelectedJobJob; baseResume: AgentSelectedJobResume; personaFacts: readonly AgentSelectedJobPersonaFact[]
}>): AgentSelectedJobMaterial {
  const { job, baseResume, personaFacts } = input
  const digestSources: AgentSelectedJobSourceMaterial[] = [
    { sourceRef: `job:${job.id}`, content: job },
    { sourceRef: `resume:${baseResume.id}`, content: baseResume },
    ...personaFacts.map((fact, index) => ({ sourceRef: `persona:${fact.id}`, content: { ...fact, rank: index + 1 } })),
  ]
  if (!job.id.trim() || !baseResume.id.trim() || digestSources.some(source => !source.sourceRef.trim())
    || new Set(digestSources.map(source => source.sourceRef)).size !== digestSources.length) throw new Error("selected_job_material_invalid")
  const sources = digestSources.map(source => ({ sourceRef: source.sourceRef, contentHash: hashContent(source.content) }))
    .sort((left, right) => left.sourceRef.localeCompare(right.sourceRef))
  const evidenceRefs = [...new Set(digestSources.map(source => source.sourceRef))].sort()
  return {
    job, baseResume, personaFacts,
    preparation: { jobId: job.id, sourceDigest: hashContent({ jobId: job.id, sources }), evidenceRefs },
    transientSources: [
      { sourceRef: `job:${job.id}`, content: job },
      { sourceRef: `resume:${baseResume.id}`, content: baseResume.content },
      ...personaFacts.map(fact => ({ sourceRef: `persona:${fact.id}`, content: {
        id: fact.id, key: fact.key, value: fact.value, confidence: fact.confidence, sourceRef: fact.sourceRef,
      } })),
    ],
  }
}

export async function readAgentSelectedJobMaterial(
  client: AgentSelectedJobMaterialQueryClient, input: Readonly<{ userId: string; jobId: string }>,
): Promise<AgentSelectedJobMaterial> {
  if (!input.userId.trim() || !input.jobId.trim()) throw new Error("selected_job_scope_invalid")
  const job = await readAgentSelectedJobJob(client, input.userId, input.jobId)
  if (!job) throw new Error("selected_job_not_found")
  const [baseResume, personaFacts] = await Promise.all([
    readAgentSelectedJobBaseResume(client, input.userId),
    readAgentSelectedJobPersonaFacts(client, input.userId, { useCase: "cover_letter" }),
  ])
  if (!baseResume) throw new Error("selected_job_base_resume_missing")
  return buildAgentSelectedJobMaterial({ job, baseResume, personaFacts })
}
