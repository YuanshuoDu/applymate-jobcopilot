import { Type, type Static } from "@sinclair/typebox"
import { schemaVersion } from "@jobcopilot/agent-protocol"

import type { RuntimeToolDefinition, ToolExecutionContext } from "./types.js"

export const JobSearchInputSchema = Type.Object({
  target: Type.Optional(Type.String({ maxLength: 160 })),
  location: Type.Optional(Type.String({ maxLength: 160 })),
  source: Type.Optional(Type.String({ maxLength: 64 })),
  page: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
}, { additionalProperties: false })
export type JobSearchInput = Static<typeof JobSearchInputSchema>

export const JobIdInputSchema = Type.Object({ jobId: Type.String({ minLength: 1, maxLength: 256 }) }, { additionalProperties: false })
export type JobIdInput = Static<typeof JobIdInputSchema>

export const PersonaRetrieveInputSchema = Type.Object({
  keys: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 128 }), { maxItems: 30 })),
  useCase: Type.Optional(Type.Union([Type.Literal("form_fill"), Type.Literal("tailor"), Type.Literal("cover_letter")])),
  jobId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false })
export type PersonaRetrieveInput = Static<typeof PersonaRetrieveInputSchema>

export const BaseResumeInputSchema = Type.Object({
  resumeId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false })
export type BaseResumeInput = Static<typeof BaseResumeInputSchema>

export const ApplicationStateInputSchema = Type.Object({
  jobId: Type.String({ minLength: 1, maxLength: 256 }),
  taskId: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
}, { additionalProperties: false })
export type ApplicationStateInput = Static<typeof ApplicationStateInputSchema>

export interface JobRecord {
  id: string
  company: string
  role: string
  location: string | null
  status: string
  score: number | null
  url: string | null
  source: string | null
  salary: string | null
  description: string | null
  keywords: string | null
}

export interface JobSearchResult {
  jobs: JobRecord[]
  page: number
  hasMore: boolean
}

export interface PersonaFactRecord {
  id: string
  key: string
  category: string
  value: string
  source: string
  sourceRef: string | null
  confidence: number
  allowedUses: string[]
}

export interface ResumeRecord {
  id: string
  name: string
  kind: string
  origin: string
  isDefault: boolean
  content: unknown
  createdAt: string
  updatedAt: string
}

export interface ApplicationStateResult {
  job: Pick<JobRecord, "id" | "company" | "role" | "status"> & { workflowState: string } | null
  task: {
    id: string
    status: string
    checkpoint: string | null
    question: unknown
    sensitiveFlags: unknown
    resumeId: string | null
    coverLetterId: string | null
    startedAt: string | null
    completedAt: string | null
    createdAt: string
    updatedAt: string
  } | null
  approvals: Array<{ id: string; type: string; status: string; title: string; impact: unknown; decidedAt: string | null; createdAt: string }>
}

export interface ReadToolDataSource {
  searchJobs(userId: string, input: JobSearchInput): Promise<JobSearchResult>
  getJob(userId: string, jobId: string): Promise<JobRecord | null>
  retrievePersona(userId: string, input: PersonaRetrieveInput): Promise<{ facts: PersonaFactRecord[] }>
  getBaseResume(userId: string, input: BaseResumeInput): Promise<{ resume: ResumeRecord | null }>
  getApplicationState(userId: string, input: ApplicationStateInput): Promise<ApplicationStateResult>
}

const nullableText = Type.Union([Type.String(), Type.Null()])
const JobRecordSchema = Type.Object({
  id: Type.String(), company: Type.String(), role: Type.String(), location: nullableText,
  status: Type.String(), score: Type.Union([Type.Integer(), Type.Null()]), url: nullableText,
  source: nullableText, salary: nullableText, description: nullableText, keywords: nullableText,
}, { additionalProperties: false })
const JobSearchResultSchema = Type.Object({ jobs: Type.Array(JobRecordSchema, { maxItems: 50 }), page: Type.Integer(), hasMore: Type.Boolean() }, { additionalProperties: false })
const PersonaResultSchema = Type.Object({ facts: Type.Array(Type.Object({
  id: Type.String(), key: Type.String(), category: Type.String(), value: Type.String(), source: Type.String(), sourceRef: nullableText,
  confidence: Type.Number(), allowedUses: Type.Array(Type.String()),
}, { additionalProperties: false })) }, { additionalProperties: false })
const ResumeResultSchema = Type.Object({ resume: Type.Union([Type.Object({
  id: Type.String(), name: Type.String(), kind: Type.String(), origin: Type.String(), isDefault: Type.Boolean(), content: Type.Unknown(),
  createdAt: Type.String(), updatedAt: Type.String(),
}, { additionalProperties: false }), Type.Null()]) }, { additionalProperties: false })
const ApplicationResultSchema = Type.Object({
  job: Type.Union([Type.Object({ id: Type.String(), company: Type.String(), role: Type.String(), status: Type.String(), workflowState: Type.String() }, { additionalProperties: false }), Type.Null()]),
  task: Type.Union([Type.Object({
    id: Type.String(), status: Type.String(), checkpoint: nullableText, question: Type.Unknown(), sensitiveFlags: Type.Unknown(), resumeId: nullableText, coverLetterId: nullableText,
    startedAt: nullableText, completedAt: nullableText, createdAt: Type.String(), updatedAt: Type.String(),
  }, { additionalProperties: false }), Type.Null()]),
  approvals: Type.Array(Type.Object({ id: Type.String(), type: Type.String(), status: Type.String(), title: Type.String(), impact: Type.Unknown(), decidedAt: nullableText, createdAt: Type.String() }, { additionalProperties: false })),
}, { additionalProperties: false })

function readMetadata(name: string, description: string) {
  return { schemaVersion, name, version: "1", description, capabilities: ["read"] as const, risk: "read" as const, idempotency: "read_only" as const, timeoutMs: 10_000, requiredCapabilities: [] as const } as const
}

export function createReadOnlyTools(source: ReadToolDataSource): RuntimeToolDefinition[] {
  return [
    { ...readMetadata("jobs.search", "Search the current user's saved and discovered jobs"), inputSchema: JobSearchInputSchema, outputSchema: JobSearchResultSchema, execute: (context, input) => source.searchJobs(userId(context), input as JobSearchInput) },
    { ...readMetadata("jobs.get", "Read one job owned by the current user"), inputSchema: JobIdInputSchema, outputSchema: Type.Object({ job: Type.Union([JobRecordSchema, Type.Null()]) }, { additionalProperties: false }), execute: async (context, input) => ({ job: await source.getJob(userId(context), (input as JobIdInput).jobId) }) },
    { ...readMetadata("persona.retrieve", "Retrieve confirmed candidate facts with provenance"), inputSchema: PersonaRetrieveInputSchema, outputSchema: PersonaResultSchema, execute: (context, input) => source.retrievePersona(userId(context), input as PersonaRetrieveInput) },
    { ...readMetadata("resume.get_base", "Read an immutable base resume owned by the current user"), inputSchema: BaseResumeInputSchema, outputSchema: ResumeResultSchema, execute: (context, input) => source.getBaseResume(userId(context), input as BaseResumeInput) },
    { ...readMetadata("application.get_state", "Read application preparation state and pending approvals"), inputSchema: ApplicationStateInputSchema, outputSchema: ApplicationResultSchema, execute: (context, input) => source.getApplicationState(userId(context), input as ApplicationStateInput) },
  ]
}

function userId(context: ToolExecutionContext): string {
  return context.scope.userId
}
