import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useApi } from '@/lib/hooks'
import { AgentTeamList } from './AgentTeamList'

vi.mock('@/lib/hooks', () => ({ useApi: vi.fn() }))
vi.mock('@/lib/i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }))

const mockUseApi = vi.mocked(useApi)

describe('AgentTeamList', () => {
  beforeEach(() => {
    mockUseApi.mockImplementation((url: string) => {
      if (url.includes('/tasks')) return { data: { tasks: [
        { id: 'child', parentTaskId: 'root', role: 'analyst', taskType: 'score', status: 'completed', goal: 'Score matches' },
        { id: 'root', role: 'scout', taskType: 'search', status: 'running', goal: 'Find roles' },
      ] }, loading: false, error: null, refetch: vi.fn() } as never
      if (url.includes('/custom')) return { data: [], loading: false, error: null, refetch: vi.fn() } as never
      return { data: [], loading: false, error: null, refetch: vi.fn() } as never
    })
  })

  it('renders built-in team status and a nested task tree from the session fixture', () => {
    const html = renderToStaticMarkup(<AgentTeamList sessionId="session-1" />)
    expect(html).toContain('agent.team')
    expect(html).toContain('Task tree')
    expect(html).toContain('Find roles')
    expect(html).toContain('Score matches')
    expect(html).toContain('Done')
  })
})
