import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ useSession: vi.fn() }))
vi.mock('next-auth/react', () => ({ useSession: mocks.useSession }))
import { createApplicationTaskRequestGate, isCurrentApplicationTaskSnapshot, useApplicationTasks } from './useApplicationTasks'

function read(enabled = true) {
  let result: ReturnType<typeof useApplicationTasks> | null = null
  function Probe() { result = useApplicationTasks({ enabled }); return null }
  renderToStaticMarkup(React.createElement(Probe))
  if (!result) throw new Error('Probe did not render')
  return result as ReturnType<typeof useApplicationTasks>
}

describe('shared application task reader', () => {
  beforeEach(() => mocks.useSession.mockReturnValue({ status: 'authenticated', data: { user: { id: 'user_1' } } }))

  it('starts in loading state without exposing a previous account or guessing an error', () => {
    expect(read()).toMatchObject({ tasks: [], loading: true, error: null, limited: false })
  })

  it.each(['unauthenticated', 'loading'])('hides records while authentication is %s', status => {
    mocks.useSession.mockReturnValue({ status, data: null })
    expect(read()).toMatchObject({ tasks: [], error: null })
  })

  it('treats an authenticated session without a user id as unavailable', () => {
    mocks.useSession.mockReturnValue({ status: 'authenticated', data: { user: {} } })
    expect(read()).toMatchObject({ tasks: [], loading: false, error: 'unavailable' })
    expect(read(false)).toMatchObject({ tasks: [], loading: false, error: null })
  })

  it('does not report loading or records while disabled', () => {
    expect(read(false)).toMatchObject({ tasks: [], loading: false, error: null, limited: false })
  })

  it('rejects an older response even if it resolves after a newer request', async () => {
    const gate = createApplicationTaskRequestGate()
    let finishOld!: (value: string) => void
    const oldResult = new Promise<string>(resolve => { finishOld = resolve })
    const shown: string[] = []
    const old = gate.start()
    const publishOld = oldResult.then(value => { if (old.current()) shown.push(value) })
    const newer = gate.start()
    expect(old.signal.aborted).toBe(true)
    if (newer.current()) shown.push('new')
    finishOld('old')
    await publishOld
    expect(shown).toEqual(['new'])
  })

  it('does not reshow a loaded account snapshot after another scope commits or it is re-enabled', () => {
    const snapshot = { owner: 'user_1', epoch: 1 }
    expect(isCurrentApplicationTaskSnapshot({ owner: 'user_1', epoch: 1 }, snapshot, 'user_1')).toBe(true)
    expect(isCurrentApplicationTaskSnapshot({ owner: 'user_2', epoch: 2 }, snapshot, 'user_2')).toBe(false)
    // Before the returned account's next fetch runs, the committed epoch is newer.
    expect(isCurrentApplicationTaskSnapshot({ owner: 'user_1', epoch: 3 }, snapshot, 'user_1')).toBe(false)
    expect(isCurrentApplicationTaskSnapshot({ owner: null, epoch: 2 }, snapshot, null)).toBe(false)
    expect(isCurrentApplicationTaskSnapshot({ owner: 'user_1', epoch: 3 }, snapshot, 'user_1')).toBe(false)
  })

  it('invalidates a previous account even when the same account returns', () => {
    const gate = createApplicationTaskRequestGate()
    const beforeSwitch = gate.start()
    gate.cancel()
    gate.start()
    expect(beforeSwitch.current()).toBe(false)
    gate.cancel()
    expect(beforeSwitch.signal.aborted).toBe(true)
  })
})
