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
  message: 'Please search Berlin of Backend Engineer Position',
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
    const uiPlan = await createChatPlan({ ...context, message: 'Search for DublinUI UX post' })

    expect(uiPlan.targetRoles).toEqual(['UI UX'])
    expect(uiPlan.targetLocations).toEqual(['Dublin'])
    expect(scoutResultMatchesRequest('Search for DublinUI UX post', {
      role: 'scout', summary: 'Found jobs.', result: { jobs: [{ role: 'Software Engineer' }] }, confidence: 0.8,
    })).toBe(false)
  })

  it('replaces a previous agent location with the one in the current request', async () => {
    mocks.modelChat.mockResolvedValueOnce({ text: '{"role":"scout","goal":"Search jobs","targetRoles":["UI"],"targetLocations":["Dublin"]}' })

    await expect(createChatPlan({ ...context, message: 'search UI London post' })).resolves.toEqual(expect.objectContaining({
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
    expect(requestsFullWorkflow('Start a complete search-to-apply workflow')).toBe(true)
    expect(requestsFullWorkflow('Help me apply for a resume that matches my profile better than65%position')).toBe(true)
    expect(requestsFullWorkflow('Help me optimize my resume')).toBe(false)
  })

  it('reads an explicit match threshold from an application request', () => {
    expect(requestedMinMatchScore('Help me apply for a resume that matches my profile better than65%position')).toBe(65)
    expect(requestedMinMatchScore('Please apply match score >= 80% position')).toBe(80)
    expect(requestedMinMatchScore('Help me apply for suitable positions')).toBeNull()
  })
})
