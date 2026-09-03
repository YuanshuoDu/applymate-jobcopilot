import { schemaVersion, validate } from '@jobcopilot/agent-protocol'

import { executeCompare, executeEnrich, executeScore, executeSearch, type DiscoveryToolDependencies } from './discovery-tool-executors'
import { assertTenantScope, createToolUsage, isDiscoveryToolVisible, type DiscoveryToolContext, type DiscoveryToolRole, type ToolUsageState } from './discovery-tool-support'
import { JobsCompareInputSchema, JobsCompareOutputSchema, JobsEnrichInputSchema, JobsEnrichOutputSchema, JobsScoreInputSchema, JobsScoreOutputSchema, JobsSearchInputSchema, JobsSearchOutputSchema, type JobsCompareInput, type JobsCompareOutput, type JobsEnrichInput, type JobsEnrichOutput, type JobsScoreInput, type JobsScoreOutput, type JobsSearchInput, type JobsSearchOutput, type JsonSchema } from './discovery-tool-types'

export type { DiscoveryToolContext, DiscoveryToolRole, DiscoveryToolScope, ScorePipelineContext, ToolUsageWriter } from './discovery-tool-support'
export type { DiscoveryToolDependencies } from './discovery-tool-executors'
export * from './discovery-tool-types'
export { isDiscoveryToolVisible, TOOL_ROLE_VISIBILITY } from './discovery-tool-support'

export interface AgentDiscoveryTool<TInput = unknown, TOutput = unknown> {
  readonly schemaVersion: typeof schemaVersion
  readonly name: string
  readonly version: '1'
  readonly description: string
  readonly capabilities: readonly ('read' | 'write')[]
  readonly inputSchema: JsonSchema
  readonly outputSchema: JsonSchema
  readonly risk: 'read' | 'draft_write'
  readonly domain: 'jobs'
  readonly idempotency: 'read_only' | 'idempotent'
  readonly timeoutMs: number
  readonly requiredCapabilities: readonly string[]
  readonly visibleTo: readonly DiscoveryToolRole[]
  execute(context: DiscoveryToolContext, input: TInput): Promise<TOutput>
}

function initialUsage(): ToolUsageState {
  return { requests: 0, jobsProcessed: 0, jobsSucceeded: 0, jobsFailed: 0, aiCalls: 0, providers: new Set(), estimatedCostUsd: 0 }
}

function definition<TInput, TOutput>(name: string, description: string, inputSchema: JsonSchema, outputSchema: JsonSchema, visibleTo: readonly DiscoveryToolRole[], execute: (input: TInput, context: DiscoveryToolContext, deps: DiscoveryToolDependencies, usage: ToolUsageState) => Promise<Omit<TOutput, 'usage'>>, deps: DiscoveryToolDependencies, risk: 'read' | 'draft_write' = 'read'): AgentDiscoveryTool<TInput, TOutput> {
  return {
    schemaVersion, name, version: '1', description, capabilities: risk === 'read' ? ['read'] : ['read', 'write'], inputSchema, outputSchema, risk, domain: 'jobs', idempotency: risk === 'read' ? 'read_only' : 'idempotent', timeoutMs: 120_000, requiredCapabilities: ['read'], visibleTo,
    async execute(context, input) {
      assertTenantScope(context.scope)
      if (!isDiscoveryToolVisible(name, context.scope.role)) throw new Error(`tool_visibility_denied:${name}:${context.scope.role}`)
      if (!validate(inputSchema as never, input)) throw new Error(`schema_error:${name}:input`)
      const startedAt = Date.now()
      const usage = initialUsage()
      try {
        const output = await execute(input, context, deps, usage)
        const completedUsage = createToolUsage(context.scope, name, startedAt, { ...usage, providers: [...usage.providers].sort() })
        const completeOutput = { ...output, usage: completedUsage } as TOutput
        if (!validate(outputSchema as never, completeOutput)) throw new Error(`schema_error:${name}:output`)
        await Promise.resolve(context.recordUsage?.(completedUsage)).catch(() => undefined)
        return completeOutput
      } catch (error) {
        const failedUsage = createToolUsage(context.scope, name, startedAt, { ...usage, jobsFailed: Math.max(usage.jobsFailed, usage.jobsProcessed - usage.jobsSucceeded), providers: [...usage.providers].sort() })
        await Promise.resolve(context.recordUsage?.(failedUsage)).catch(() => undefined)
        throw error
      }
    },
  }
}

export function createDiscoveryAnalysisTools(deps: DiscoveryToolDependencies = {}): AgentDiscoveryTool[] {
  return [
    definition<JobsSearchInput, JobsSearchOutput>('jobs.search', 'Search tenant-scoped normalized jobs through the existing discovery providers.', JobsSearchInputSchema, JobsSearchOutputSchema, ['orchestrator', 'scout', 'analyst', 'reviewer', 'auditor'], executeSearch, deps),
    definition<JobsEnrichInput, JobsEnrichOutput>('jobs.enrich', 'Enrich tenant-scoped jobs with the existing ATS, JSON-LD, and CSS cascade.', JobsEnrichInputSchema, JobsEnrichOutputSchema, ['orchestrator', 'scout', 'analyst'], executeEnrich, deps),
    definition<JobsScoreInput, JobsScoreOutput>('jobs.score', 'Score tenant-scoped jobs against the candidate resume as a draft analysis.', JobsScoreInputSchema, JobsScoreOutputSchema, ['orchestrator', 'analyst'], executeScore, deps, 'draft_write'),
    definition<JobsCompareInput, JobsCompareOutput>('jobs.compare', 'Compare tenant-scoped jobs using deterministic role, source, salary, score, and description features.', JobsCompareInputSchema, JobsCompareOutputSchema, ['orchestrator', 'analyst', 'reviewer', 'auditor'], executeCompare, deps),
  ]
}

export const DISCOVERY_ANALYSIS_TOOLS = createDiscoveryAnalysisTools()

export function visibleDiscoveryAnalysisTools(role: DiscoveryToolRole, deps: DiscoveryToolDependencies = {}): AgentDiscoveryTool[] {
  return createDiscoveryAnalysisTools(deps).filter(tool => tool.visibleTo.includes(role))
}
