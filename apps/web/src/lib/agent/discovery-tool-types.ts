/** JSON-Schema contracts kept dependency-free for the Web package. */
export type JsonSchema = Record<string, unknown>

const id = { type: 'string', minLength: 1, maxLength: 256 }
const cursor = { type: 'string', minLength: 1, maxLength: 512 }
const usageSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: { ledgerKey: id, toolName: id, toolVersion: id, toolCallId: id, sessionId: id, turnId: id, stepId: id, requests: { type: 'integer', minimum: 0 }, jobsProcessed: { type: 'integer', minimum: 0 }, jobsSucceeded: { type: 'integer', minimum: 0 }, jobsFailed: { type: 'integer', minimum: 0 }, aiCalls: { type: 'integer', minimum: 0 }, providers: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 80 } }, estimatedCostUsd: { type: 'number', minimum: 0 }, durationMs: { type: 'integer', minimum: 0 } },
  required: ['ledgerKey', 'toolName', 'toolVersion', 'toolCallId', 'sessionId', 'turnId', 'stepId', 'requests', 'jobsProcessed', 'jobsSucceeded', 'jobsFailed', 'aiCalls', 'providers', 'estimatedCostUsd', 'durationMs'],
}
const evidenceSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: { evidenceId: id, jobId: id, kind: { enum: ['source', 'enrichment', 'analysis', 'comparison'] }, source: { type: 'string', minLength: 1, maxLength: 80 }, url: { type: 'string', minLength: 1, maxLength: 4_096 }, summary: { type: 'string', minLength: 1, maxLength: 1_000 } },
  required: ['evidenceId', 'jobId', 'kind', 'source', 'url', 'summary'],
}

export const JobsSearchInputSchema: JsonSchema = {
  $id: 'agent.jobs.search.input', type: 'object', additionalProperties: false,
  properties: { targetRoles: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } }, targetLocations: { type: 'array', maxItems: 8, items: { type: 'string', minLength: 1, maxLength: 160 } }, source: { type: 'string', minLength: 1, maxLength: 80 }, pageSize: { type: 'integer', minimum: 1, maximum: 50 }, cursor },
  required: ['targetRoles', 'targetLocations'],
}
const normalizedJobSchema: JsonSchema = {
  type: 'object', additionalProperties: false,
  properties: { id, title: { type: 'string', minLength: 1, maxLength: 500 }, company: { type: 'string', minLength: 1, maxLength: 500 }, location: { type: 'string', maxLength: 500 }, url: { type: 'string', minLength: 1, maxLength: 4_096 }, description: { type: 'string', maxLength: 100_000 }, fullDescription: { type: 'string', maxLength: 100_000 }, salary: { type: ['string', 'null'], maxLength: 500 }, logo: { type: ['string', 'null'], maxLength: 4_096 }, source: { type: 'string', minLength: 1, maxLength: 80 }, evidenceRefs: { type: 'array', minItems: 1, maxItems: 8, items: id } },
  required: ['id', 'title', 'company', 'location', 'url', 'description', 'fullDescription', 'salary', 'logo', 'source', 'evidenceRefs'],
}
export const JobsSearchOutputSchema: JsonSchema = { $id: 'agent.jobs.search.output', type: 'object', additionalProperties: false, properties: { jobs: { type: 'array', maxItems: 50, items: normalizedJobSchema }, evidence: { type: 'array', maxItems: 400, items: evidenceSchema }, nextCursor: { type: ['string', 'null'] }, usage: usageSchema }, required: ['jobs', 'evidence', 'nextCursor', 'usage'] }

const jobInputSchema: JsonSchema = { type: 'object', additionalProperties: false, properties: { jobId: id, html: { type: 'string', maxLength: 500_000 } }, required: ['jobId'] }
export const JobsEnrichInputSchema: JsonSchema = { $id: 'agent.jobs.enrich.input', type: 'object', additionalProperties: false, properties: { jobs: { type: 'array', minItems: 1, maxItems: 50, items: jobInputSchema } }, required: ['jobs'] }
const failedResultSchema: JsonSchema = { type: 'object', additionalProperties: false, properties: { jobId: id, status: { const: 'failed' }, code: id, message: { type: 'string', minLength: 1, maxLength: 500 } }, required: ['jobId', 'status', 'code', 'message'] }
const enrichedResultSchema: JsonSchema = { type: 'object', additionalProperties: false, properties: { jobId: id, status: { const: 'enriched' }, fullDescription: { type: 'string', minLength: 1, maxLength: 100_000 }, applyUrl: { type: ['string', 'null'], minLength: 1, maxLength: 4_096 }, method: { type: 'string', minLength: 1, maxLength: 80 }, evidenceRefs: { type: 'array', minItems: 1, maxItems: 8, items: id } }, required: ['jobId', 'status', 'fullDescription', 'applyUrl', 'method', 'evidenceRefs'] }
export const JobsEnrichOutputSchema: JsonSchema = { $id: 'agent.jobs.enrich.output', type: 'object', additionalProperties: false, properties: { results: { type: 'array', maxItems: 50, items: { anyOf: [enrichedResultSchema, failedResultSchema] } }, evidence: { type: 'array', maxItems: 400, items: evidenceSchema }, usage: usageSchema }, required: ['results', 'evidence', 'usage'] }
export const JobsScoreInputSchema: JsonSchema = { $id: 'agent.jobs.score.input', type: 'object', additionalProperties: false, properties: { jobIds: { type: 'array', minItems: 1, maxItems: 50, uniqueItems: true, items: id } }, required: ['jobIds'] }
const scoredResultSchema: JsonSchema = { type: 'object', additionalProperties: false, properties: { jobId: id, status: { const: 'scored' }, score: { type: 'integer', minimum: 0, maximum: 100 }, matchedKeywords: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 160 } }, missingKeywords: { type: 'array', maxItems: 100, items: { type: 'string', minLength: 1, maxLength: 160 } }, recommendation: { type: 'string', maxLength: 2_000 }, evidenceRefs: { type: 'array', minItems: 1, maxItems: 8, items: id } }, required: ['jobId', 'status', 'score', 'matchedKeywords', 'missingKeywords', 'recommendation', 'evidenceRefs'] }
export const JobsScoreOutputSchema: JsonSchema = { $id: 'agent.jobs.score.output', type: 'object', additionalProperties: false, properties: { results: { type: 'array', maxItems: 50, items: { anyOf: [scoredResultSchema, failedResultSchema] } }, evidence: { type: 'array', maxItems: 400, items: evidenceSchema }, usage: usageSchema }, required: ['results', 'evidence', 'usage'] }
export const JobsCompareInputSchema: JsonSchema = { $id: 'agent.jobs.compare.input', type: 'object', additionalProperties: false, properties: { jobIds: { type: 'array', minItems: 1, maxItems: 20, uniqueItems: true, items: id } }, required: ['jobIds'] }
const comparisonFeaturesSchema: JsonSchema = { type: 'object', additionalProperties: false, properties: { title: { type: 'string', maxLength: 500 }, company: { type: 'string', maxLength: 500 }, location: { type: 'string', maxLength: 500 }, source: { type: 'string', maxLength: 80 }, url: { type: 'string', maxLength: 4_096 }, salary: { type: ['string', 'null'], maxLength: 500 }, score: { type: ['integer', 'null'], minimum: 0, maximum: 100 }, hasFullDescription: { type: 'boolean' }, descriptionLength: { type: 'integer', minimum: 0 } }, required: ['title', 'company', 'location', 'source', 'url', 'salary', 'score', 'hasFullDescription', 'descriptionLength'] }
const comparisonSchema: JsonSchema = { type: 'object', additionalProperties: false, properties: { jobId: id, features: comparisonFeaturesSchema, evidenceRefs: { type: 'array', minItems: 1, items: id } }, required: ['jobId', 'features', 'evidenceRefs'] }
export const JobsCompareOutputSchema: JsonSchema = { $id: 'agent.jobs.compare.output', type: 'object', additionalProperties: false, properties: { comparisons: { type: 'array', maxItems: 20, items: comparisonSchema }, failures: { type: 'array', maxItems: 20, items: failedResultSchema }, evidence: { type: 'array', maxItems: 160, items: evidenceSchema }, usage: usageSchema }, required: ['comparisons', 'failures', 'evidence', 'usage'] }

export interface JobsSearchInput { targetRoles: string[]; targetLocations: string[]; source?: string; pageSize?: number; cursor?: string }
export interface JobEvidence { evidenceId: string; jobId: string; kind: 'source' | 'enrichment' | 'analysis' | 'comparison'; source: string; url: string; summary: string }
export interface ToolUsage { ledgerKey: string; toolName: string; toolVersion: string; toolCallId: string; sessionId: string; turnId: string; stepId: string; requests: number; jobsProcessed: number; jobsSucceeded: number; jobsFailed: number; aiCalls: number; providers: string[]; estimatedCostUsd: number; durationMs: number }
export interface NormalizedJob { id: string; title: string; company: string; location: string; url: string; description: string; fullDescription: string; salary: string | null; logo: string | null; source: string; evidenceRefs: string[] }
export interface JobsSearchOutput { jobs: NormalizedJob[]; evidence: JobEvidence[]; nextCursor: string | null; usage: ToolUsage }
export interface JobsEnrichInput { jobs: Array<{ jobId: string; html?: string }> }
export type FailedJobResult = { jobId: string; status: 'failed'; code: string; message: string }
export type EnrichedJobResult = { jobId: string; status: 'enriched'; fullDescription: string; applyUrl: string | null; method: string; evidenceRefs: string[] }
export interface JobsEnrichOutput { results: Array<EnrichedJobResult | FailedJobResult>; evidence: JobEvidence[]; usage: ToolUsage }
export interface JobsScoreInput { jobIds: string[] }
export type ScoredJobResult = { jobId: string; status: 'scored'; score: number; matchedKeywords: string[]; missingKeywords: string[]; recommendation: string; evidenceRefs: string[] }
export interface JobsScoreOutput { results: Array<ScoredJobResult | FailedJobResult>; evidence: JobEvidence[]; usage: ToolUsage }
export interface JobsCompareInput { jobIds: string[] }
export interface JobsCompareOutput { comparisons: Array<{ jobId: string; features: { title: string; company: string; location: string; source: string; url: string; salary: string | null; score: number | null; hasFullDescription: boolean; descriptionLength: number }; evidenceRefs: string[] }>; failures: FailedJobResult[]; evidence: JobEvidence[]; usage: ToolUsage }
