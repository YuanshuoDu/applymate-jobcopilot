import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(), useApi: vi.fn(), refetch: vi.fn(),
}))
vi.mock('next-auth/react', () => ({ useSession: mocks.useSession }))
vi.mock('@/lib/hooks', () => ({ useApi: mocks.useApi }))
import { useApplicationTasks } from './useApplicationTasks'

const row = { id: 'task_1', jobId: 'job_1', userId: 'user_1', sessionId: 'session_1', status: 'waiting_for_user', checkpoint: 'form_answer_required', updatedAt: '2026-10-30T10:00:00Z', job: { company: 'Example', role: 'Engineer' } }

function read(enabled = true) {
  let result: ReturnType<typeof useApplicationTasks> | null = null
  function Probe() { result = useApplicationTasks({ enabled }); return null }
  renderToStaticMarkup(React.createElement(Probe))
  if (!result) throw new Error('Probe did not render')
  return result as ReturnType<typeof useApplicationTasks>
}

describe('shared application task reader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.useSession.mockReturnValue({ status: 'authenticated', data: { user: { id: 'user_1' } } })
    mocks.useApi.mockReturnValue({ data: { tasks: [row] }, loading: false, error: null, refetch: mocks.refetch })
  })

  it('reads one list and provides the same actual task to list and drawer consumers', () => {
    const result = read()
    expect(mocks.useApi).toHaveBeenCalledOnce()
    expect(mocks.useApi).toHaveBeenCalledWith('/api/agent/application-tasks', { cache: false, enabled: true })
    expect(result.byJobId.get('job_1')).toBe(result.tasks[0])
    expect(result.byJobId.get('job_other')).toBeUndefined()
  })

  it('synchronously hides the previous account records when the authenticated user changes', () => {
    expect(read().tasks).toHaveLength(1)
    mocks.useSession.mockReturnValue({ status: 'authenticated', data: { user: { id: 'user_2' } } })
    expect(read()).toMatchObject({ tasks: [], error: 'unavailable' })
  })

  it.each(['unauthenticated', 'loading'])('does not fetch or display cached private records while auth is %s', status => {
    mocks.useSession.mockReturnValue({ status, data: null })
    expect(read().tasks).toEqual([])
    expect(mocks.useApi).toHaveBeenCalledWith('/api/agent/application-tasks', { cache: false, enabled: false })
  })

  it('hides old rows and raw server errors after a failed refresh or authorization failure', () => {
    mocks.useApi.mockReturnValue({ data: { tasks: [row] }, loading: false, error: 'private server detail', refetch: mocks.refetch })
    expect(read()).toMatchObject({ tasks: [], error: 'unavailable' })
  })

  it('distinguishes a successful empty list from unavailable or malformed data', () => {
    mocks.useApi.mockReturnValue({ data: { tasks: [] }, loading: false, error: null, refetch: mocks.refetch })
    expect(read()).toMatchObject({ tasks: [], error: null })
    mocks.useApi.mockReturnValue({ data: {}, loading: false, error: null, refetch: mocks.refetch })
    expect(read()).toMatchObject({ tasks: [], error: 'unavailable' })
  })

  it('hides stale rows during refresh and when explicitly disabled', () => {
    mocks.useApi.mockReturnValue({ data: { tasks: [row] }, loading: true, error: null, refetch: mocks.refetch })
    expect(read()).toMatchObject({ tasks: [], loading: true, error: null })
    expect(read(false)).toMatchObject({ tasks: [], loading: false, error: null })
  })
})
