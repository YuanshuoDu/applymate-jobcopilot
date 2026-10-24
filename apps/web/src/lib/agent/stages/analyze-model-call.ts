import { createHash } from 'node:crypto'
import {
  MODEL_SCHEMA_VERSION,
  type HarnessModelRequest,
  type ModelCapabilities,
  type ModelMessage,
} from '@jobcopilot/agent-model'
import { createWebModelAdapter } from '@/lib/agent-model-compat'
import type { AiConfig, ChatMessage } from '@/lib/model-router'

type AnalyzeModelCallInput = {
  scoringConfig: AiConfig
  messages: readonly ChatMessage[]
  userId: string
  sessionId?: string
  turnId?: string
  executionAttempt?: { id: string; attemptCount: number }
  jobId: string
  analysisFenceAt: Date
  signal?: AbortSignal
}

function requestTraceId(input: AnalyzeModelCallInput): string {
  const material = JSON.stringify({
    userId: input.userId,
    executionId: input.executionAttempt?.id ?? null,
    executionAttemptCount: input.executionAttempt?.attemptCount ?? null,
    jobId: input.jobId,
    analysisFenceAt: input.analysisFenceAt.toISOString(),
  }) ?? ''
  return createHash('sha256').update(material).digest('hex')
}

function toModelMessages(messages: readonly ChatMessage[]): ModelMessage[] {
  return messages.map(({ role, content }) => ({
    role,
    content: [{ type: 'text', text: content }],
  }))
}

export async function completeAnalyzeModelCall(input: AnalyzeModelCallInput): Promise<string> {
  const adapter = createWebModelAdapter(input.scoringConfig)
  if (!adapter.complete) throw new Error('The web model adapter does not support completion.')

  const traceId = requestTraceId(input)
  const sessionId = input.sessionId ?? `legacy-analyze-session:${traceId}`
  const turnId = input.turnId ?? `legacy-analyze-turn:${traceId}`
  const capabilities: ModelCapabilities = {
    nativeTools: adapter.profile.nativeTools,
    structuredOutput: adapter.profile.structuredOutput,
    streaming: adapter.profile.streaming,
    continuationCursor: adapter.profile.continuationCursor,
  }
  const request: HarnessModelRequest = {
    schemaVersion: MODEL_SCHEMA_VERSION,
    provider: adapter.profile.provider,
    model: adapter.profile.model,
    messages: toModelMessages(input.messages),
    tools: [],
    capabilities,
    maxOutputTokens: 1600,
    signal: input.signal ?? new AbortController().signal,
    metadata: {
      sessionId,
      turnId,
      stepId: `${turnId}:analyze:${input.jobId}`,
      taskId: input.jobId,
      userId: input.userId,
      ...(input.scoringConfig.usageFeatureKey !== undefined
        ? { featureId: input.scoringConfig.usageFeatureKey }
        : {}),
      traceId,
    },
  }
  const response = await adapter.complete(request)
  if (typeof response.text !== 'string') throw new Error('The web model adapter returned no text.')
  return response.text
}