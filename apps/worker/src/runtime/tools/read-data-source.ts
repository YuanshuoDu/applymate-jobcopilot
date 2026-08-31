import type pg from "pg"

import type {
  ApplicationStateInput,
  ApplicationStateResult,
  BaseResumeInput,
  JobRecord,
  JobSearchInput,
  JobSearchResult,
  PersonaFactRecord,
  PersonaRetrieveInput,
  ReadToolDataSource,
  ResumeRecord,
} from "./read-tools.js"

interface JobRow extends JobRecord { createdAt: Date | string; updatedAt: Date | string }
interface PersonaRow extends Omit<PersonaFactRecord, "confidence"> { confidence: number | string; allowedUses: string[] }
interface ResumeRow extends Omit<ResumeRecord, "createdAt" | "updatedAt"> { createdAt: Date | string; updatedAt: Date | string }
interface TaskRow {
  id: string; sessionId: string | null; status: string; checkpoint: string | null; question: unknown; sensitiveFlags: unknown
  resumeId: string | null; coverLetterId: string | null; startedAt: Date | string | null; completedAt: Date | string | null; createdAt: Date | string; updatedAt: Date | string
}
interface ApprovalRow { id: string; type: string; status: string; title: string; impact: unknown; decidedAt: Date | string | null; createdAt: Date | string }

function iso(value: Date | string | null): string | null {
  if (value === null) return null
  return (value instanceof Date ? value : new Date(value)).toISOString()
}

function job(row: JobRow): JobRecord {
  return { id: row.id, company: row.company, role: row.role, location: row.location ?? null, status: row.status, score: row.score ?? null, url: row.url ?? null, source: row.source ?? null, salary: row.salary ?? null, description: row.description ?? null, keywords: row.keywords ?? null }
}

export function createPostgresReadToolDataSource(pool: pg.Pool): ReadToolDataSource {
  return {
    async searchJobs(userId: string, input: JobSearchInput): Promise<JobSearchResult> {
      const page = input.page ?? 1
      const limit = input.limit ?? 20
      const result = await pool.query<JobRow>(
        `SELECT "id", "company", "role", "location", "status", "score", "url", "source", "salary", "description", "keywords", "createdAt", "updatedAt"
         FROM "Job"
         WHERE "userId" = $1
           AND ($2::text IS NULL OR "role" ILIKE '%' || $2 || '%' OR "company" ILIKE '%' || $2 || '%' OR "description" ILIKE '%' || $2 || '%')
           AND ($3::text IS NULL OR "location" ILIKE '%' || $3 || '%')
           AND ($4::text IS NULL OR "source" = $4)
         ORDER BY "updatedAt" DESC, "id" DESC LIMIT $5 OFFSET $6`,
        [userId, input.target ?? null, input.location ?? null, input.source ?? null, limit + 1, (page - 1) * limit],
      )
      return { jobs: result.rows.slice(0, limit).map(job), page, hasMore: result.rows.length > limit }
    },

    async getJob(userId: string, jobId: string): Promise<JobRecord | null> {
      const result = await pool.query<JobRow>(
        `SELECT "id", "company", "role", "location", "status", "score", "url", "source", "salary", "description", "keywords", "createdAt", "updatedAt"
         FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [jobId, userId],
      )
      return result.rows[0] ? job(result.rows[0]) : null
    },

    async retrievePersona(userId: string, input: PersonaRetrieveInput): Promise<{ facts: PersonaFactRecord[] }> {
      const result = await pool.query<PersonaRow>(
        `SELECT "id", "key", "category", "value", "source", "source_ref" AS "sourceRef", "confidence", "allowed_uses" AS "allowedUses"
         FROM persona_facts
         WHERE "userId" = $1 AND "status" = 'confirmed' AND ("expires_at" IS NULL OR "expires_at" > NOW())
           AND ($2::text[] IS NULL OR "key" = ANY($2::text[]))
           AND ($3::text IS NULL OR $3 = ANY("allowed_uses"))
         ORDER BY "updated_at" DESC LIMIT 50`,
        [userId, input.keys?.length ? input.keys : null, input.useCase ?? null],
      )
      return { facts: result.rows.map((row) => ({ ...row, confidence: Number(row.confidence), allowedUses: [...row.allowedUses] })) }
    },

    async getBaseResume(userId: string, input: BaseResumeInput): Promise<{ resume: ResumeRecord | null }> {
      const result = await pool.query<ResumeRow>(
        `SELECT "id", "name", "kind", "origin", "isDefault", "content", "createdAt", "updatedAt"
         FROM "Resume" WHERE "userId" = $1 AND "kind" = 'base'
           AND ($2::text IS NULL OR "id" = $2)
         ORDER BY "isDefault" DESC, "updatedAt" DESC LIMIT 1`, [userId, input.resumeId ?? null],
      )
      const row = result.rows[0]
      return { resume: row ? { ...row, createdAt: iso(row.createdAt) as string, updatedAt: iso(row.updatedAt) as string } : null }
    },

    async getApplicationState(userId: string, input: ApplicationStateInput): Promise<ApplicationStateResult> {
      const jobResult = await pool.query<Pick<JobRecord, "id" | "company" | "role" | "status"> & { workflowState: string }>(
        `SELECT "id", "company", "role", "status", "workflowState" FROM "Job" WHERE "id" = $1 AND "userId" = $2`, [input.jobId, userId],
      )
      const taskResult = await pool.query<TaskRow>(
        `SELECT "id", "sessionId", "status", "checkpoint", "question", "sensitiveFlags", "resumeId", "coverLetterId", "startedAt", "completedAt", "createdAt", "updatedAt"
         FROM application_tasks WHERE "userId" = $1 AND "jobId" = $2 AND ($3::text IS NULL OR "id" = $3)
         ORDER BY "updatedAt" DESC LIMIT 1`, [userId, input.jobId, input.taskId ?? null],
      )
      const task = taskResult.rows[0]
      const approvals = task?.sessionId ? await pool.query<ApprovalRow>(
        `SELECT "id", "type", "status", "title", "impact", "decidedAt", "createdAt" FROM agent_approvals
         WHERE "sessionId" = $1 AND "userId" = $2 ORDER BY "createdAt" DESC LIMIT 20`, [task.sessionId, userId],
      ) : { rows: [] as ApprovalRow[] }
      return {
        job: jobResult.rows[0] ?? null,
        task: task ? { id: task.id, status: task.status, checkpoint: task.checkpoint, question: task.question, sensitiveFlags: task.sensitiveFlags, resumeId: task.resumeId, coverLetterId: task.coverLetterId, startedAt: iso(task.startedAt), completedAt: iso(task.completedAt), createdAt: iso(task.createdAt) as string, updatedAt: iso(task.updatedAt) as string } : null,
        approvals: approvals.rows.map((row) => ({ ...row, decidedAt: iso(row.decidedAt), createdAt: iso(row.createdAt) as string })),
      }
    },
  }
}
