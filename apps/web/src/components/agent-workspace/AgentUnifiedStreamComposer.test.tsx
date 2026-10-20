import { readFileSync } from 'node:fs'
import {
  canStartOrdinaryChat,
  isObjectiveDraftPending,
  isOrdinaryComposerInputLocked,
  objectiveContextFormReducer,
  shouldReleaseInputAfterSessionSelection,
  type AgentObjectiveContextFormState,
} from './AgentObjectiveContextForm'
import { canShowObjectiveContextEntry } from './AgentUnifiedStreamComposer'

import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('./AgentUnifiedStreamComposer.tsx', import.meta.url), 'utf8')
const streamSource = readFileSync(new URL('./AgentUnifiedStream.tsx', import.meta.url), 'utf8')
const formSource = readFileSync(new URL('./AgentObjectiveContextForm.tsx', import.meta.url), 'utf8')

const emptyFormState: AgentObjectiveContextFormState = {
  objective: '', context: '', open: false, pending: false, accepted: false, error: null,
}

describe('Agent unified stream composer', () => {
  it('uses the active V2 turn composer and creates a session for a new draft', () => {
    expect(source).toContain('turnComposer.send(outgoing)')
    expect(source).toContain("fetch('/api/agent/sessions'")
    expect(source).toContain("sendAgentTurnMessage(recordedSessionId, outgoing, 'steer'")
    expect(source).not.toContain('streamAgentChat')
  })

  it('blocks ordinary chat admission until an objective draft is accepted or discarded', () => {
    const open = objectiveContextFormReducer(emptyFormState, { type: 'open' })
    const failed = objectiveContextFormReducer(open, {
      type: 'failed', error: { message: 'Request outcome unknown', conflict: false },
    })
    const accepted = objectiveContextFormReducer(open, { type: 'accepted' })
    const discarded = objectiveContextFormReducer(open, { type: 'discard' })

    expect(isObjectiveDraftPending(open)).toBe(true)
    expect(canStartOrdinaryChat(isObjectiveDraftPending(open))).toBe(false)
    expect(isObjectiveDraftPending(failed)).toBe(true)
    expect(canStartOrdinaryChat(isObjectiveDraftPending(failed))).toBe(false)
    expect(isObjectiveDraftPending(accepted)).toBe(false)
    expect(canStartOrdinaryChat(isObjectiveDraftPending(accepted))).toBe(true)
    expect(isObjectiveDraftPending(discarded)).toBe(false)
    expect(canStartOrdinaryChat(isObjectiveDraftPending(discarded))).toBe(true)
    expect(source).toContain("onDraftPendingChange={pending => { objectiveDraftPendingRef.current = pending }}")
    expect(formSource).toContain("onDraftPendingChange?.(isObjectiveDraftPending(nextState))")

    const sendStart = source.indexOf('async function sendChat')
    const guardAt = source.indexOf('if (objectiveContextEntryAvailable && !canStartOrdinaryChat(objectiveDraftPendingRef.current))', sendStart)
    const sessionCreationAt = source.indexOf("fetch('/api/agent/sessions'", sendStart)
    expect(sendStart).toBeGreaterThanOrEqual(0)
    expect(guardAt).toBeGreaterThan(sendStart)
    expect(sessionCreationAt).toBeGreaterThan(guardAt)
    expect(source).toContain("Your regular draft and attachments will stay here.")
  })

  it('keeps an objective draft parked across selected Sessions while active chat stays usable', () => {
    let open = objectiveContextFormReducer(emptyFormState, { type: 'open' })
    open = objectiveContextFormReducer(open, { type: 'edit-objective', value: 'Finish the application audit' })
    open = objectiveContextFormReducer(open, { type: 'edit-context', value: 'Keep this exact background.' })
    const failed = objectiveContextFormReducer(open, {
      type: 'failed', error: { message: 'Request outcome unknown', conflict: false },
    })
    expect(failed).toMatchObject({
      open: true,
      accepted: false,
      objective: 'Finish the application audit',
      context: 'Keep this exact background.',
    })
    expect(isObjectiveDraftPending(failed)).toBe(true)

    expect(source).toContain('const objectiveContextEntryAvailable = canShowObjectiveContextEntry(Boolean(resumeSessionId), timelineRestoring, Boolean(turnComposer), liveBlocks.length, waitingForAnswer)')
    expect(source).toContain('<AgentObjectiveContextForm')
    expect(source).toContain('available={objectiveContextEntryAvailable}')
    expect(formSource).toContain('if (!available) return null')
    expect(formSource.indexOf('useReducer(objectiveContextFormReducer')).toBeLessThan(formSource.indexOf('if (!available) return null'))
    expect(source).toContain('if (objectiveContextEntryAvailable && !canStartOrdinaryChat(objectiveDraftPendingRef.current))')

    const sendStart = source.indexOf('async function sendChat')
    const activeTurnSendAt = source.indexOf('turnComposer.send(outgoing)', sendStart)
    const pendingGuardAt = source.indexOf('if (objectiveContextEntryAvailable && !canStartOrdinaryChat', sendStart)
    expect(activeTurnSendAt).toBeGreaterThan(sendStart)
    expect(pendingGuardAt).toBeGreaterThan(activeTurnSendAt)
  })

  it('hides the objective entry for selected Sessions and while a Session is restoring', () => {
    expect(canShowObjectiveContextEntry(true, false, false, 0, false)).toBe(false)
    expect(canShowObjectiveContextEntry(false, true, false, 0, false)).toBe(false)
    expect(canShowObjectiveContextEntry(false, false, false, 0, false)).toBe(true)
    expect(source).toContain('canShowObjectiveContextEntry(Boolean(resumeSessionId), timelineRestoring, Boolean(turnComposer), liveBlocks.length, waitingForAnswer)')
    expect(streamSource).toContain('resumeSessionId={resumeSessionId}')
    expect(streamSource).toContain('timelineRestoring={timeline.restoring}')
  })

  it('rejects attachment changes while the accepted task switches Sessions', () => {
    expect(source).toContain('if (sessionStartLockRef.current || refuseSendDuringSessionSwitch()) {')
    expect(source).toContain('onRemoveAttachedFile={id => { if (!objectiveSessionSwitchPendingRef.current) setAttachedFiles(current => current.filter(file => file.id !== id)) }}')
    const lockSetAt = source.indexOf('objectiveSessionSwitchPendingRef.current = true')
    const fileGuardAt = source.indexOf('if (sessionStartLockRef.current || refuseSendDuringSessionSwitch())')
    const removeGuardAt = source.indexOf('onRemoveAttachedFile={id => { if (!objectiveSessionSwitchPendingRef.current)')
    expect(lockSetAt).toBeGreaterThanOrEqual(0)
    expect(fileGuardAt).toBeGreaterThan(lockSetAt)
    expect(removeGuardAt).toBeGreaterThan(fileGuardAt)
  })

  it('locks ordinary input while objective start is in flight and through the Session switch', () => {
    expect(isOrdinaryComposerInputLocked(false, false)).toBe(false)
    expect(isOrdinaryComposerInputLocked(true, false)).toBe(true)
    expect(isOrdinaryComposerInputLocked(false, true)).toBe(true)
    expect(isOrdinaryComposerInputLocked(true, true)).toBe(true)
    expect(source).toContain('inputRef.current.disabled = isOrdinaryComposerInputLocked(')
    expect(source).toContain('onBusyChange={setObjectiveStartBusy}')
    expect(source).toContain('waitForObjectiveSessionSwitch()')
    expect(source).toContain('objectiveSessionSwitchFallbackRef.current = setTimeout(releaseOrdinaryComposerInputLock, 5_000)')
    expect(source).toContain('window.requestAnimationFrame(releaseOrdinaryComposerInputLock)')
    expect(source).toContain('onChatInputChange={value => {')
    expect(source).toContain('if (isOrdinaryComposerInputLocked(objectiveStartInFlightRef.current, objectiveSessionSwitchPendingRef.current)) return')
    expect(source).toContain('if (isOrdinaryComposerInputLocked(objectiveStartInFlightRef.current, objectiveSessionSwitchPendingRef.current)) {')

    const sendStart = source.indexOf('async function sendChat')
    const switchGuardAt = source.indexOf('if (refuseSendDuringSessionSwitch()) return', sendStart)
    const activeTurnSendAt = source.indexOf('turnComposer.send(outgoing)', sendStart)
    const sessionCreationAt = source.indexOf("fetch('/api/agent/sessions'", sendStart)
    expect(switchGuardAt).toBeGreaterThan(sendStart)
    expect(switchGuardAt).toBeLessThan(activeTurnSendAt)
    expect(switchGuardAt).toBeLessThan(sessionCreationAt)
    expect(source).toContain("toast.info('Task is switching', 'Wait for the new task to finish opening before sending more context.')")

    const guardedControllerAt = source.indexOf('const turnComposerForAgentComposer = turnComposer ? {')
    const guardedControllerSendAt = source.indexOf('if (refuseSendDuringSessionSwitch()) return', guardedControllerAt)
    const guardedActiveTurnSendAt = source.indexOf('turnComposer.send(text)', guardedControllerAt)
    expect(guardedControllerAt).toBeGreaterThanOrEqual(0)
    expect(guardedControllerSendAt).toBeLessThan(guardedActiveTurnSendAt)
    expect(source).toContain('<AgentTurnComposerProvider value={turnComposerForAgentComposer}>')

    expect(shouldReleaseInputAfterSessionSelection(true, false, true)).toBe(true)
    expect(shouldReleaseInputAfterSessionSelection(true, true, true)).toBe(false)
    expect(shouldReleaseInputAfterSessionSelection(false, false, true)).toBe(false)
    expect(shouldReleaseInputAfterSessionSelection(true, false, false)).toBe(false)
    const commitGuardAt = source.indexOf('if (!shouldReleaseAfterCommit) return')
    const unlockFrameAt = source.indexOf('window.requestAnimationFrame(releaseOrdinaryComposerInputLock)')
    expect(commitGuardAt).toBeGreaterThanOrEqual(0)
    expect(unlockFrameAt).toBeGreaterThan(commitGuardAt)
    const waitAt = source.indexOf('waitForObjectiveSessionSwitch()', source.indexOf('onAccepted={(sessionId, objective)'))
    const recordAt = source.indexOf("onSessionRecorded(sessionId, objective, 'Task · Running')")
    expect(waitAt).toBeGreaterThanOrEqual(0)
    expect(recordAt).toBeGreaterThan(waitAt)
  })

  it('preserves job, resume, file, and quick-thinking composer context', () => {
    expect(source).toContain('jobComposerContext(job)')
    expect(source).toContain('resumeComposerContext(resume)')
    expect(source).toContain('attachmentComposerContext(attachedFiles)')
    expect(source).toContain("t('agent.quickThinkingPrompt')")
  })

  it('offers objective and background only for a fresh composer without touching ordinary context', () => {
    expect(source).toContain('canShowObjectiveContextEntry(Boolean(resumeSessionId), timelineRestoring, Boolean(turnComposer), liveBlocks.length, waitingForAnswer)')
    expect(source).toContain('<AgentObjectiveContextForm')
    expect(source).toContain('startLockRef={sessionStartLockRef}')
    expect(source).toContain('turnComposer.send(outgoing)')
    expect(source).toContain('attachmentComposerContext(attachedFiles)')
    const formStart = source.indexOf('<AgentObjectiveContextForm')
    const composerStart = source.indexOf('<AgentComposer', formStart)
    expect(source.slice(formStart, composerStart)).not.toContain('setAttachedFiles')
  })
})
