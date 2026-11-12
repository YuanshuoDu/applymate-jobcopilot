import type { ObjectiveStartResult } from './agent-objective-start-command'
import { useCallback, useEffect, useRef, type Dispatch, type MutableRefObject, type RefObject, type SetStateAction } from 'react'
import { isOrdinaryComposerInputLocked, shouldReleaseInputAfterSessionSelection } from './AgentObjectiveContextForm'
import { composerTaskUnavailableMessage, type ComposerTaskAvailability, type ComposerTaskTarget } from './agent-composer-task-availability'

export type AgentComposerMode = 'chat' | 'task'

export type ComposerAttachmentDraft = { id: string; name: string; size: number; type: string }

export function addSelectedComposerFiles(options: {
  readonly files: FileList | null
  readonly sessionStartLocked: boolean
  readonly refuseSendDuringSessionSwitch: () => boolean
  readonly setAttachedFiles: Dispatch<SetStateAction<ComposerAttachmentDraft[]>>
  readonly onStartBlocked: () => void
  readonly onAdded: (count: number) => void
}): void {
  if (options.sessionStartLocked || options.refuseSendDuringSessionSwitch()) {
    if (options.sessionStartLocked) options.onStartBlocked()
    return
  }
  const next = Array.from(options.files ?? []).map(file => ({
    id: `${file.name}-${file.size}-${file.lastModified}`,
    name: file.name,
    size: file.size,
    type: file.type || 'file',
  }))
  if (next.length === 0) return
  options.setAttachedFiles(current => {
    const existing = new Set(current.map(file => file.id))
    return [...current, ...next.filter(file => !existing.has(file.id))].slice(0, 6)
  })
  options.onAdded(next.length)
}

export function canSubmitComposerTask(input: {
  readonly mode: AgentComposerMode
  readonly availability: ComposerTaskAvailability
  readonly hasText: boolean
  readonly hasAttachments: boolean
  readonly isBusy: boolean
}): boolean {
  return input.mode === 'task' && input.availability.kind === 'available' && input.hasText
    && !input.hasAttachments && !input.isBusy
}

export interface ComposerObjectiveStartPort {
  start(objectiveDraft: string, contextDraft: string, selectedSessionId?: string): Promise<ObjectiveStartResult>
}

export type ComposerObjectiveStartCoordinatorPort = ComposerObjectiveStartPort & { discard(): void }

export interface ComposerTaskAttemptRegistryPort {
  get(target: ComposerTaskTarget, objectiveDraft: string): ComposerObjectiveStartCoordinatorPort
}

export function startComposerTask(
  coordinator: ComposerObjectiveStartPort,
  objectiveDraft: string,
  target: ComposerTaskTarget,
): Promise<ObjectiveStartResult> {
  return target.kind === 'selected-session'
    ? coordinator.start(objectiveDraft, '', target.sessionId)
    : coordinator.start(objectiveDraft, '')
}

export function routeComposerSubmission(
  mode: AgentComposerMode,
  draft: string,
  handlers: { readonly startTask: (objective: string) => void; readonly sendChat: (message: string) => void },
): boolean {
  const text = draft.trim()
  if (!text) return false
  if (mode === 'task') handlers.startTask(text)
  else handlers.sendChat(text)
  return true
}

export function newClientMessageId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `message-${crypto.randomUUID()}`
  return `message-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function canShowObjectiveContextEntry(hasSelectedSession: boolean, isRestoring: boolean, hasTurnComposer: boolean, liveBlockCount: number, waitingForAnswer: boolean) { return !hasSelectedSession && !isRestoring && !hasTurnComposer && liveBlockCount === 0 && !waitingForAnswer }

export function useObjectiveSessionSwitchLock(
  entryAvailable: boolean,
  inputRef: RefObject<HTMLTextAreaElement | null>,
  startInFlightRef: MutableRefObject<boolean>,
) {
  const pendingRef = useRef(false)
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const sync = useCallback(() => {
    if (inputRef.current) inputRef.current.disabled = isOrdinaryComposerInputLocked(startInFlightRef.current, pendingRef.current)
  }, [inputRef, startInFlightRef])
  const release = useCallback(() => {
    pendingRef.current = false
    if (fallbackRef.current !== null) {
      clearTimeout(fallbackRef.current)
      fallbackRef.current = null
    }
    sync()
  }, [sync])
  const wait = useCallback(() => {
    pendingRef.current = true
    sync()
    if (fallbackRef.current !== null) clearTimeout(fallbackRef.current)
    fallbackRef.current = setTimeout(release, 5_000)
  }, [release, sync])
  const previousAvailableRef = useRef(entryAvailable)

  useEffect(() => {
    const shouldReleaseAfterCommit = shouldReleaseInputAfterSessionSelection(
      previousAvailableRef.current,
      entryAvailable,
      pendingRef.current,
    )
    previousAvailableRef.current = entryAvailable
    if (!shouldReleaseAfterCommit) return
    const frameId = window.requestAnimationFrame(release)
    return () => window.cancelAnimationFrame(frameId)
  }, [entryAvailable, release])

  useEffect(() => () => {
    if (fallbackRef.current !== null) clearTimeout(fallbackRef.current)
  }, [])

  return { pendingRef, sync, wait, release }
}

export interface SubmitComposerTaskOptions {
  readonly mode: AgentComposerMode
  readonly availability: ComposerTaskAvailability
  readonly objectiveDraft: string
  readonly attachedFileCount: number
  readonly isBusy: boolean
  readonly selectedSessionId: string | null
  readonly selectedSessionRef: MutableRefObject<string | null>
  readonly attemptRegistry: ComposerTaskAttemptRegistryPort
  readonly startLockRef: MutableRefObject<boolean>
  readonly setTaskStartBusy: (busy: boolean) => void
  readonly setStartBusy: (busy: boolean) => void
  readonly setAddMenuOpen: (open: boolean) => void
  readonly waitForSessionSwitch: () => void
  readonly turnComposerRef: MutableRefObject<{ setChatInput: (value: string) => void } | null>
  readonly setChatInput: Dispatch<SetStateAction<string>>
  readonly shouldFollowScrollRef: MutableRefObject<boolean>
  readonly onSessionRecorded: (sessionId: string, objective: string, status: string) => void
  readonly notifyInfo: (title: string, message: string) => void
  readonly notifyError: (message: string) => void
  readonly preserveDraft: (sessionId: string | null, draft: string) => void
}

export async function submitComposerTask(options: SubmitComposerTaskOptions): Promise<void> {
  const target = options.availability.kind === 'available' ? options.availability.target : null
  if (!target || !canSubmitComposerTask({
    mode: options.mode,
    availability: options.availability,
    hasText: Boolean(options.objectiveDraft.trim()),
    hasAttachments: options.attachedFileCount > 0,
    isBusy: options.isBusy,
  })) {
    if (options.attachedFileCount > 0) options.notifyInfo('Task needs text only', 'Remove the attached files or switch to Chat. Your files and draft are preserved.')
    else if (options.availability.kind === 'unavailable') {
      options.notifyInfo('Task is unavailable', composerTaskUnavailableMessage(options.availability.reason))
    }
    return
  }
  if (options.startLockRef.current) return

  options.startLockRef.current = true
  options.setTaskStartBusy(true)
  options.setStartBusy(true)
  options.setAddMenuOpen(false)
  const selectedSessionAtStart = options.selectedSessionId
  try {
    const objective = options.objectiveDraft.trim()
    const coordinator = options.attemptRegistry.get(target, objective)
    const result = await startComposerTask(coordinator, objective, target)
    coordinator.discard()
    if (options.selectedSessionRef.current !== selectedSessionAtStart) {
      window.dispatchEvent(new Event('applymate:sessions-changed'))
      options.notifyInfo('Task started', 'The selected Session changed while the task was starting; the current selection was kept.')
      return
    }
    if (target.kind === 'new-session') options.waitForSessionSwitch()
    const currentComposer = options.turnComposerRef.current
    if (currentComposer) currentComposer.setChatInput('')
    else options.setChatInput('')
    options.shouldFollowScrollRef.current = true
    options.onSessionRecorded(result.sessionId, result.objective, 'Task · Running')
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Task start failed.'
    if (options.selectedSessionRef.current !== selectedSessionAtStart) {
      options.preserveDraft(selectedSessionAtStart, options.objectiveDraft.trim())
      options.notifyInfo('Task draft saved for its Session', 'Switch back to the original Session to retry this task. The current Session draft was left unchanged.')
    } else {
      const currentComposer = options.turnComposerRef.current
      if (currentComposer) currentComposer.setChatInput(options.objectiveDraft.trim())
      else options.setChatInput(current => current.trim() ? current : options.objectiveDraft.trim())
    }
    options.notifyError(message)
  } finally {
    options.startLockRef.current = false
    options.setTaskStartBusy(false)
    options.setStartBusy(false)
  }
}
