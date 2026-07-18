import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ modelChat: vi.fn(), discoverJobs: vi.fn() }))

vi.mock('@/lib/model-router', () => ({
  modelChat: mocks.modelChat,
  stripFences: (value: string) => value.replace(/```json|```/g, ''),
}))

vi.mock('@/lib/agent/discover', () => ({ discoverJobs: mocks.discoverJobs }))

import { createChatPlan, requestedMinMatchScore, requestsFullWorkflow, runChatWorker, scoutResultMatchesRequest, synthesizeChatResult } from './chat-orchestrator'

const context = {
  userId: 'user_1',
  message: '请搜索 Berlin 的 Backend Engineer 职位',
  config: { targetRoles: ['Software Engineer'], targetLocations: ['Dublin'] },
  jobs: [{ id: 'job_1', company: 'N26', role: 'Backend Engineer', score: 88, status: 'saved', url: 'https://example.com/job' }],
  model: { provider: 'openai' as const, model: 'test' },
}

describe('chat orchestrator', () => {
  it('accepts a single specialist selected by the main agent', async () => {
    mocks.modelChat.mockResolvedValueOnce({ text: '{"role":"scout","goal":"Search Berlin backend jobs","targetRoles":["Backend Engineer"],"targetLocations":["Berlin"]}' })

    await expect(createChatPlan(context)).resolves.toEqual({
      role: 'scout',
      goal: 'Search only for Backend Engineer. Exclude unrelated roles.',
      targetRoles: ['Backend Engineer'],
      targetLocations: ['Berlin'],
    })
  })

  it('runs live discovery only through the scout worker', async () => {
    mocks.discoverJobs.mockResolvedValueOnce([
      { company: 'N26', title: 'Backend Engineer', location: 'Berlin', url: 'https://example.com/new', description: '', salary: null, logo: null, source: 'ats' },
    ])

    const result = await runChatWorker(context, {
      role: 'scout', goal: 'Search Berlin backend jobs', targetRoles: ['Backend Engineer'], targetLocations: ['Berlin'],
    })

    expect(mocks.discoverJobs).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'user_1', targetRoles: ['Backend Engineer'], targetLocations: ['Berlin'], maxResults: 6,
    }))
    expect(result.result.jobs).toEqual([expect.objectContaining({ company: 'N26', role: 'Backend Engineer' })])
  })

  it('corrects an incompatible scout target and detects mismatched results', async () => {
    mocks.modelChat.mockResolvedValueOnce({ text: '{"role":"scout","goal":"Search jobs","targetRoles":["Software Engineer"],"targetLocations":["Dublin"]}' })
    const uiPlan = await createChatPlan({ ...context, message: '搜索一下都柏林的UI UX 岗位' })

    expect(uiPlan.targetRoles).toEqual(['UI UX'])
    expect(uiPlan.targetLocations).toEqual(['Dublin'])
    expect(scoutResultMatchesRequest('搜索一下都柏林的UI UX 岗位', {
      role: 'scout', summary: 'Found jobs.', result: { jobs: [{ role: 'Software Engineer' }] }, confidence: 0.8,
    })).toBe(false)
  })

  it('replaces a previous agent location with the one in the current request', async () => {
    mocks.modelChat.mockResolvedValueOnce({ text: '{"role":"scout","goal":"Search jobs","targetRoles":["UI"],"targetLocations":["Dublin"]}' })

    await expect(createChatPlan({ ...context, message: '搜索 UI London 岗位' })).resolves.toEqual(expect.objectContaining({
      targetLocations: ['London'],
    }))
  })

  it('never exposes model thinking in the final response', async () => {
    mocks.modelChat.mockResolvedValueOnce({ text: '<think>private reasoning' })

    await expect(synthesizeChatResult(context, {
      role: 'auditor', goal: 'Summarize status', targetRoles: [], targetLocations: [],
    }, {
      role: 'auditor', summary: 'No completed tasks.', result: { jobs: [] }, confidence: 0.8,
    })).resolves.toBe('No completed tasks.')
  })

  it('routes an apply request to the end-to-end workflow, not a single specialist', () => {
    expect(requestsFullWorkflow('开始完整的从搜索到申请工作流')).toBe(true)
    expect(requestsFullWorkflow('帮我申请符合我简历匹配度高于65%的职位')).toBe(true)
    expect(requestsFullWorkflow('帮我优化简历')).toBe(false)
  })

  it('reads an explicit match threshold from an application request', () => {
    expect(requestedMinMatchScore('帮我申请符合我简历匹配度高于65%的职位')).toBe(65)
    expect(requestedMinMatchScore('请申请 match score >= 80% 的岗位')).toBe(80)
    expect(requestedMinMatchScore('帮我申请合适职位')).toBeNull()
  })
})
