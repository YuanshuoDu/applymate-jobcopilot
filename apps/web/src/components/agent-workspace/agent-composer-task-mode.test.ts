import { describe, expect, it, vi } from 'vitest'
import {
  addSelectedComposerFiles,
  canSubmitComposerTask,
  newClientMessageId,
  routeComposerSubmission,
  startComposerTask,
  submitComposerTask,
  type ComposerAttachmentDraft,
} from './agent-composer-task-mode'
import { resolveComposerTaskAvailability, type ComposerTaskAvailabilityInput } from './agent-composer-task-availability'
import { parseAgentSessionControlStatus } from './v2/AgentSessionPauseResumeControl'

const blank: ComposerTaskAvailabilityInput = {
  selectedSessionId: null, composerSessionId: null, hasActiveTurn: false, turnStateReadiness: 'ready', sessionStatus: null,
  isRestoring: false, waitingForAnswer: false, isBusy: false, hasLiveBlocks: false,
}

const acceptedOutcome = (result: { sessionId: string; objective: string; inputId: string; turnId: string; disposition: 'started' | 'duplicate'; sequence: string }) => ({
  kind: 'accepted' as const, attemptKey: 'attempt-1', accountScope: 'a'.repeat(64), result,
})

describe('Agent composer Task mode', () => {
  it('preserves attachment deduplication and start-lock rejection', () => {
    let stored: ComposerAttachmentDraft[] = []
    const setAttachedFiles = (updater: ComposerAttachmentDraft[] | ((current: ComposerAttachmentDraft[]) => ComposerAttachmentDraft[])) => {
      stored = typeof updater === 'function' ? updater(stored) : updater
    }
    const fileList = [{ name: 'resume.pdf', size: 12, lastModified: 1, type: 'application/pdf' }] as unknown as FileList
    const onAdded = vi.fn(), onStartBlocked = vi.fn()
    addSelectedComposerFiles({ files: fileList, sessionStartLocked: false, refuseSendDuringSessionSwitch: vi.fn(() => false), setAttachedFiles, onStartBlocked, onAdded })
    expect(stored).toEqual([{ id: 'resume.pdf-12-1', name: 'resume.pdf', size: 12, type: 'application/pdf' }])
    expect(onAdded).toHaveBeenCalledWith(1)
    addSelectedComposerFiles({ files: fileList, sessionStartLocked: false, refuseSendDuringSessionSwitch: vi.fn(() => false), setAttachedFiles, onStartBlocked, onAdded })
    expect(stored).toHaveLength(1)
    addSelectedComposerFiles({ files: fileList, sessionStartLocked: true, refuseSendDuringSessionSwitch: vi.fn(() => false), setAttachedFiles, onStartBlocked, onAdded })
    expect(onStartBlocked).toHaveBeenCalledOnce()
    expect(stored).toHaveLength(1)
  })

  it('preserves the existing client message id format', () => {
    expect(newClientMessageId()).toMatch(/^message-/)
  })

  it('targets a new Session only from a blank idle workspace', () => {
    expect(resolveComposerTaskAvailability(blank)).toEqual({ kind: 'available', target: { kind: 'new-session' } })
    expect(resolveComposerTaskAvailability({ ...blank, hasLiveBlocks: true })).toMatchObject({ kind: 'unavailable', reason: 'not-blank' })
    expect(resolveComposerTaskAvailability({ ...blank, composerSessionId: 'stale-session' })).toMatchObject({ kind: 'unavailable' })
  })

  it('reuses only a selected Session whose composer confirms it is idle', () => {
    const selected = { ...blank, selectedSessionId: 'session-idle', composerSessionId: 'session-idle', sessionStatus: parseAgentSessionControlStatus('running'), hasLiveBlocks: true }
    expect(resolveComposerTaskAvailability(selected)).toEqual({
      kind: 'available', target: { kind: 'selected-session', sessionId: 'session-idle' },
    })
    for (const status of ['paused', 'pausing', 'resuming'] as const) {
      expect(resolveComposerTaskAvailability({ ...selected, sessionStatus: status })).toMatchObject({ kind: 'unavailable', reason: 'session-not-idle' })
    }
    expect(resolveComposerTaskAvailability({ ...selected, sessionStatus: null })).toMatchObject({ kind: 'unavailable', reason: 'session-not-idle' })
    expect(resolveComposerTaskAvailability({ ...selected, sessionStatus: undefined })).toMatchObject({ kind: 'unavailable', reason: 'session-not-idle' })
    expect(resolveComposerTaskAvailability({ ...selected, composerSessionId: null })).toMatchObject({ kind: 'unavailable', reason: 'session-unavailable' })
    expect(resolveComposerTaskAvailability({ ...selected, composerSessionId: 'other-session' })).toMatchObject({ kind: 'unavailable', reason: 'session-unavailable' })
  })

  it.each([
    ['recovering', { isRestoring: true }],
    ['waiting for an answer', { waitingForAnswer: true }],
    ['busy', { isBusy: true }],
    ['active Turn', { hasActiveTurn: true }],
    ['unknown Session control state', { sessionStatus: null }],
  ])('fails closed while %s', (_label, changes) => {
    const selected = { ...blank, selectedSessionId: 'session-idle', composerSessionId: 'session-idle', ...changes }
    expect(resolveComposerTaskAvailability(selected)).toMatchObject({ kind: 'unavailable' })
  })

  it.each([
    ['loading', 'turn-state-loading'],
    ['error', 'turn-state-error'],
  ] as const)('blocks Task until selected Session Turn state is verified (%s)', (turnStateReadiness, reason) => {
    expect(resolveComposerTaskAvailability({
      ...blank,
      selectedSessionId: 'session-idle',
      composerSessionId: 'session-idle',
      sessionStatus: 'running',
      turnStateReadiness,
    })).toEqual({ kind: 'unavailable', reason })
  })

  it('blocks text-only Task start with attachments while preserving the shared draft', () => {
    const availability = resolveComposerTaskAvailability(blank)
    expect(canSubmitComposerTask({ mode: 'task', availability, hasText: true, hasAttachments: false, isBusy: false })).toBe(true)
    expect(canSubmitComposerTask({ mode: 'task', availability, hasText: true, hasAttachments: true, isBusy: false })).toBe(false)
    expect(canSubmitComposerTask({ mode: 'chat', availability, hasText: true, hasAttachments: true, isBusy: false })).toBe(false)
    expect(canSubmitComposerTask({ mode: 'task', availability, hasText: false, hasAttachments: false, isBusy: false })).toBe(false)
  })

  it('uses the objective-start coordinator for blank and selected Sessions without issuing chat messages', async () => {
    const result = { sessionId: 'session-new', objective: 'Find roles', inputId: 'input-1', turnId: 'turn-1', disposition: 'started' as const, sequence: '1' }
    const start = vi.fn(async () => result)
    await startComposerTask({ start }, 'Find roles', { kind: 'new-session' })
    await startComposerTask({ start }, 'Find roles', { kind: 'selected-session', sessionId: 'session-idle' })
    expect(start).toHaveBeenNthCalledWith(1, 'Find roles', '')
    expect(start).toHaveBeenNthCalledWith(2, 'Find roles', '', 'session-idle')
  })

  it('routes Task text only to the objective-start handler and leaves Chat routing unchanged', () => {
    const startTask = vi.fn(), sendChat = vi.fn()
    expect(routeComposerSubmission('task', '  Complete the audit  ', { startTask, sendChat })).toBe(true)
    expect(startTask).toHaveBeenCalledWith('Complete the audit')
    expect(sendChat).not.toHaveBeenCalled()
    expect(routeComposerSubmission('chat', 'Continue the conversation', { startTask, sendChat })).toBe(true)
    expect(sendChat).toHaveBeenCalledWith('Continue the conversation')
    expect(routeComposerSubmission('task', '   ', { startTask, sendChat })).toBe(false)
  })

  it('consumes an accepted blank-workspace task after recording its accepted status', async () => {
    const result = { sessionId: 'session-new', objective: 'Find roles', inputId: 'input-1', turnId: 'turn-1', disposition: 'started' as const, sequence: '1' }
    const outcome = acceptedOutcome(result)
    const startRecoverableTask = vi.fn(async () => outcome)
    const consumeAcceptedAttempt = vi.fn(async () => undefined)
    const setTaskStartBusy = vi.fn(), setStartBusy = vi.fn(), setAddMenuOpen = vi.fn()
    const waitForSessionSwitch = vi.fn(), setChatInput = vi.fn(), onSessionRecorded = vi.fn()
    await submitComposerTask({
      mode: 'task', availability: resolveComposerTaskAvailability(blank), objectiveDraft: 'Find roles',
      attachedFileCount: 0, isBusy: false, selectedSessionId: null, selectedSessionRef: { current: null },
      startRecoverableTask, consumeAcceptedAttempt, startLockRef: { current: false }, setTaskStartBusy, setStartBusy, setAddMenuOpen,
      waitForSessionSwitch, turnComposerRef: { current: null }, setChatInput, shouldFollowScrollRef: { current: false },
      onSessionRecorded, notifyInfo: vi.fn(), notifyError: vi.fn(), preserveDraft: vi.fn(),
    })
    expect(startRecoverableTask).toHaveBeenCalledWith('Find roles', { kind: 'new-session' })
    expect(waitForSessionSwitch).toHaveBeenCalledOnce()
    expect(setChatInput).toHaveBeenCalledWith('')
    expect(onSessionRecorded).toHaveBeenCalledWith('session-new', 'Find roles', 'Task · Accepted')
    expect(consumeAcceptedAttempt).toHaveBeenCalledWith(outcome)
    expect(setTaskStartBusy).toHaveBeenNthCalledWith(1, true)
    expect(setTaskStartBusy).toHaveBeenLastCalledWith(false)
  })

  it('keeps a selected Session task draft retryable after a start failure', async () => {
    const startRecoverableTask = vi.fn(async () => { throw new Error('Network outcome unknown') })
    const setChatInput = vi.fn(), notifyError = vi.fn(), onSessionRecorded = vi.fn()
    await submitComposerTask({
      mode: 'task', availability: resolveComposerTaskAvailability({ ...blank, selectedSessionId: 'session-idle', composerSessionId: 'session-idle', sessionStatus: 'running' }),
      objectiveDraft: 'Finish the application audit', attachedFileCount: 0, isBusy: false,
      selectedSessionId: 'session-idle', selectedSessionRef: { current: 'session-idle' }, startRecoverableTask, consumeAcceptedAttempt: vi.fn(async () => undefined),
      startLockRef: { current: false }, setTaskStartBusy: vi.fn(), setStartBusy: vi.fn(), setAddMenuOpen: vi.fn(),
      waitForSessionSwitch: vi.fn(), turnComposerRef: { current: null }, setChatInput, shouldFollowScrollRef: { current: false },
      onSessionRecorded, notifyInfo: vi.fn(), notifyError, preserveDraft: vi.fn(),
    })
    expect(setChatInput).toHaveBeenCalledWith(expect.any(Function))
    const restoreDraft = setChatInput.mock.calls[0]?.[0] as (current: string) => string
    expect(restoreDraft('')).toBe('Finish the application audit')
    expect(restoreDraft('Newer draft')).toBe('Newer draft')
    expect(notifyError).toHaveBeenCalledWith('Network outcome unknown')
    expect(onSessionRecorded).not.toHaveBeenCalled()
  })

  it('keeps a failed draft bound to its original Session if selection changes while pending', async () => {
    const selectedSessionRef = { current: 'session-a' }
    const startRecoverableTask = vi.fn(async () => { selectedSessionRef.current = 'session-b'; throw new Error('Network outcome unknown') })
    const preserveDraft = vi.fn(), setChatInput = vi.fn()
    await submitComposerTask({
      mode: 'task', availability: resolveComposerTaskAvailability({ ...blank, selectedSessionId: 'session-a', composerSessionId: 'session-a', sessionStatus: 'running' }),
      objectiveDraft: 'Keep this task on A', attachedFileCount: 0, isBusy: false, selectedSessionId: 'session-a',
      selectedSessionRef, startRecoverableTask, consumeAcceptedAttempt: vi.fn(async () => undefined), startLockRef: { current: false }, setTaskStartBusy: vi.fn(), setStartBusy: vi.fn(),
      setAddMenuOpen: vi.fn(), waitForSessionSwitch: vi.fn(), turnComposerRef: { current: { setChatInput: vi.fn() } },
      setChatInput, shouldFollowScrollRef: { current: false }, onSessionRecorded: vi.fn(), notifyInfo: vi.fn(),
      notifyError: vi.fn(), preserveDraft,
    })
    expect(preserveDraft).toHaveBeenCalledWith('session-a', 'Keep this task on A')
    expect(setChatInput).not.toHaveBeenCalled()
  })

  it('routes changed drafts to the durable attempt gate without sending Chat', async () => {
    const calls: Array<{ objective: string; sessionId: string }> = []
    const startRecoverableTask = vi.fn(async (objective: string, target: { kind: string; sessionId?: string }) => {
      calls.push({ objective, sessionId: target.sessionId ?? target.kind })
      return { kind: 'recovery' as const, attemptKey: 'attempt-a', state: { kind: 'unknown' as const } }
    })
    const submit = (sessionId: string, objectiveDraft: string) => submitComposerTask({
      mode: 'task',
      availability: resolveComposerTaskAvailability({ ...blank, selectedSessionId: sessionId, composerSessionId: sessionId, sessionStatus: 'running' }),
      objectiveDraft, attachedFileCount: 0, isBusy: false, selectedSessionId: sessionId,
      selectedSessionRef: { current: sessionId }, startRecoverableTask, consumeAcceptedAttempt: vi.fn(async () => undefined), startLockRef: { current: false },
      setTaskStartBusy: vi.fn(), setStartBusy: vi.fn(), setAddMenuOpen: vi.fn(), waitForSessionSwitch: vi.fn(),
      turnComposerRef: { current: null }, setChatInput: vi.fn(), shouldFollowScrollRef: { current: false },
      onSessionRecorded: vi.fn(), notifyInfo: vi.fn(), notifyError: vi.fn(), preserveDraft: vi.fn(),
    })

    await submit('session-a', 'Objective A')
    await submit('session-a', 'Changed Objective A')
    expect(calls).toEqual([
      { objective: 'Objective A', sessionId: 'session-a' },
      { objective: 'Changed Objective A', sessionId: 'session-a' },
    ])
  })

  it('keeps the new selection when the selected Session changes during an accepted start', async () => {
    vi.stubGlobal('window', { dispatchEvent: vi.fn() })
    const result = { sessionId: 'session-a', objective: 'Finish the audit', inputId: 'input-1', turnId: 'turn-1', disposition: 'started' as const, sequence: '1' }
    const selectedSessionRef = { current: 'session-a' }
    const startRecoverableTask = vi.fn(async () => { selectedSessionRef.current = 'session-b'; return acceptedOutcome(result) })
    const setChatInput = vi.fn(), notifyInfo = vi.fn(), onSessionRecorded = vi.fn()
    try {
      await submitComposerTask({
        mode: 'task', availability: resolveComposerTaskAvailability({ ...blank, selectedSessionId: 'session-a', composerSessionId: 'session-a', sessionStatus: 'running' }),
        objectiveDraft: 'Finish the audit', attachedFileCount: 0, isBusy: false, selectedSessionId: 'session-a',
        selectedSessionRef, startRecoverableTask, consumeAcceptedAttempt: vi.fn(async () => undefined), startLockRef: { current: false }, setTaskStartBusy: vi.fn(),
        setStartBusy: vi.fn(), setAddMenuOpen: vi.fn(), waitForSessionSwitch: vi.fn(),
        turnComposerRef: { current: null }, setChatInput, shouldFollowScrollRef: { current: false },
        onSessionRecorded, notifyInfo, notifyError: vi.fn(), preserveDraft: vi.fn(),
      })
      expect(startRecoverableTask).toHaveBeenCalledOnce()
      expect(setChatInput).not.toHaveBeenCalled()
      expect(onSessionRecorded).not.toHaveBeenCalled()
      expect(notifyInfo).toHaveBeenCalledWith('Task start accepted', expect.any(String))
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
