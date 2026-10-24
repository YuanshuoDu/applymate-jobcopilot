import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MODEL_SCHEMA_VERSION,
  type HarnessModelRequest,
  type ModelAdapter,
  type ModelCapabilityProfile,
  type ModelResponse,
} from '@jobcopilot/agent-model'
import type { AiConfig, ChatMessage } from '@/lib/model-router'

const mocks = vi.hoisted(() => ({
  createAdapter: vi.fn(),
  complete: vi.fn(),
}))

vi.mock('@/lib/agent-model-compat', () => ({
  createWebModelAdapter: mocks.createAdapter,
}))

import { completeAnalyzeModelCall } from './analyze-model-call'
type AnalyzeModelCallInput = Parameters<typeof completeAnalyzeModelCall>[0]

const profile: ModelCapabilityProfile = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  nativeTools: false,
  structuredOutput: false,
  streaming: true,
  continuationCursor: false,
  supportsParallelTools: false,
  supportsStreamingToolArgs: false,
  supportsReasoningSummary: false,
  supportsResponseContinuation: false,
  supportsProviderConversation: false,
  supportsBackgroundResponse: false,
  maxContextTokens: null,
  maxOutputTokens: null,
  costClass: 'unknown',
}

const scoringConfig: AiConfig = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'test-provider-key',
  usageUserId: 'usage-user',
  usageFeatureKey: 'jobScoring',
  usageRuntime: 'web',
}

const messages: readonly ChatMessage[] = [
  { role: 'system', content: 'Score the candidate and return JSON.' },
  { role: 'user', content: 'Resume and job details go here.' },
]

const fence = new Date('2026-10-24T13:00:00.123Z')
const baseInput: AnalyzeModelCallInput = {
  scoringConfig,
  messages,
  userId: 'user_1',
  sessionId: 'session_1',
  turnId: 'turn_1',
  executionAttempt: { id: 'execution_1', attemptCount: 4 },
  jobId: 'job_1',
  analysisFenceAt: fence,
}

function requestAt(index = 0): HarnessModelRequest {
  return mocks.complete.mock.calls[index]?.[0] as HarnessModelRequest
}

describe('completeAnalyzeModelCall', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    mocks.complete.mockResolvedValue({
      schemaVersion: MODEL_SCHEMA_VERSION,
      provider: profile.provider,
      model: profile.model,
      finishReason: 'stop',
      text: 'completion text',
      toolCalls: [],
      usage: null,
      continuationCursor: null,
    } satisfies ModelResponse)
    mocks.createAdapter.mockReturnValue({
      id: 'web:openai:gpt-4o-mini',
      profile,
      stream: async function* () {},
      complete: mocks.complete,
    } satisfies ModelAdapter)
  })

  it('preserves the scoring config and builds the shared bounded text completion request', async () => {
    const signal = new AbortController().signal
    const result = await completeAnalyzeModelCall({ ...baseInput, signal })

    expect(result).toBe('completion text')
    expect(mocks.createAdapter).toHaveBeenCalledOnce()
    expect(mocks.createAdapter).toHaveBeenCalledWith(scoringConfig)
    expect(mocks.createAdapter.mock.calls[0]?.[0]).toBe(scoringConfig)
    expect(mocks.complete).toHaveBeenCalledOnce()
    expect(mocks.complete.mock.calls[0]?.[0]).toEqual({
      schemaVersion: MODEL_SCHEMA_VERSION,
      provider: profile.provider,
      model: profile.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: messages[0]?.content }] },
        { role: 'user', content: [{ type: 'text', text: messages[1]?.content }] },
      ],
      tools: [],
      capabilities: {
        nativeTools: false,
        structuredOutput: false,
        streaming: true,
        continuationCursor: false,
      },
      maxOutputTokens: 1600,
      signal,
      metadata: {
        sessionId: 'session_1',
        turnId: 'turn_1',
        stepId: 'turn_1:analyze:job_1',
        taskId: 'job_1',
        userId: 'user_1',
        featureId: 'jobScoring',
        traceId: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    })
  })

  it('derives deterministic request-scoped traces from job, execution attempt and fence identity', async () => {
    const inputs: AnalyzeModelCallInput[] = [
      baseInput,
      { ...baseInput },
      { ...baseInput, jobId: 'job_2' },
      { ...baseInput, executionAttempt: { id: 'execution_2', attemptCount: 4 } },
      { ...baseInput, executionAttempt: { id: 'execution_1', attemptCount: 5 } },
      { ...baseInput, analysisFenceAt: new Date('2026-10-24T13:00:00.124Z') },
    ]
    for (const input of inputs) await completeAnalyzeModelCall(input)

    const traceIds = inputs.map((_, index) => requestAt(index).metadata.traceId)
    const baseline = traceIds[0]
    expect(baseline).toMatch(/^[0-9a-f]{64}$/)
    expect(traceIds[1]).toBe(baseline)
    for (const changed of traceIds.slice(2)) expect(changed).not.toBe(baseline)
    expect(new Set(traceIds).size).toBe(inputs.length - 1)
  })

  it('uses deterministic metadata-only legacy IDs and an uncancelled signal when IDs are absent', async () => {
    const input: AnalyzeModelCallInput = {
      ...baseInput,
      sessionId: undefined,
      turnId: undefined,
      executionAttempt: undefined,
      signal: undefined,
    }

    await completeAnalyzeModelCall(input)
    const first = requestAt()
    await completeAnalyzeModelCall(input)
    const second = requestAt(1)
    const traceId = first.metadata.traceId
    expect(traceId).toMatch(/^[0-9a-f]{64}$/)

    expect(first.metadata).toEqual({
      sessionId: `legacy-analyze-session:${traceId}`,
      turnId: `legacy-analyze-turn:${traceId}`,
      stepId: `legacy-analyze-turn:${traceId}:analyze:job_1`,
      taskId: 'job_1',
      userId: 'user_1',
      featureId: 'jobScoring',
      traceId,
    })
    expect(second.metadata).toEqual(first.metadata)
    expect(first.signal.aborted).toBe(false)
    expect(second.signal.aborted).toBe(false)
  })

  it('does not fall back when the adapter has no completion method', async () => {
    mocks.createAdapter.mockReturnValueOnce({
      id: 'web:openai:gpt-4o-mini',
      profile,
      stream: async function* () {},
    } satisfies ModelAdapter)

    await expect(completeAnalyzeModelCall(baseInput))
      .rejects.toThrow('The web model adapter does not support completion.')
    expect(mocks.complete).not.toHaveBeenCalled()
  })

  it('propagates normalized provider failures for the caller failure path', async () => {
    const failure = new Error('Legacy model client failed')
    mocks.complete.mockRejectedValueOnce(failure)

    await expect(completeAnalyzeModelCall(baseInput)).rejects.toBe(failure)
    expect(mocks.complete).toHaveBeenCalledOnce()
  })

  it('rejects a completion without text instead of fabricating output', async () => {
    mocks.complete.mockResolvedValueOnce({
      schemaVersion: MODEL_SCHEMA_VERSION,
      provider: profile.provider,
      model: profile.model,
      finishReason: 'error',
      toolCalls: [],
      usage: null,
      continuationCursor: null,
    } satisfies ModelResponse)

    await expect(completeAnalyzeModelCall(baseInput))
      .rejects.toThrow('The web model adapter returned no text.')
  })
})
