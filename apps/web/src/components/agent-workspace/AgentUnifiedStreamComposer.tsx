'use client'
import React, { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useToast } from '@/components/ui'
import { useI18n } from '@/lib/i18n'
import { AgentObjectiveContextForm, canStartOrdinaryChat, isOrdinaryComposerInputLocked } from './AgentObjectiveContextForm'
import { AgentComposer, type ComposerAttachment, type ComposerJob, type ComposerResume } from './AgentComposer'
import { attachmentComposerContext, jobComposerContext, resumeComposerContext } from './AgentUnifiedStream.helpers'
import { AgentTurnComposerProvider, sendAgentTurnMessage, useAgentTurnComposerContext } from './agent-turn-commands'
import { addSelectedComposerFiles, canShowObjectiveContextEntry, newClientMessageId, submitComposerTask, useObjectiveSessionSwitchLock, type AgentComposerMode } from './agent-composer-task-mode'
import { AgentComposerTaskAttemptRegistry } from './agent-composer-task-attempts'
import { composerTaskUnavailableMessage, resolveComposerTaskAvailability } from './agent-composer-task-availability'
import { useTaskDraftRecovery } from './agent-composer-task-draft-recovery'
export { canShowObjectiveContextEntry } from './agent-composer-task-mode'
import type { AgentTranscriptEvent } from './session-view-model'
import type { AgentUnifiedStreamProps } from './AgentUnifiedStream.types'

interface AgentUnifiedStreamComposerProps {
  waitingForAnswer: boolean
  chatInput: string
  setChatInput: Dispatch<SetStateAction<string>>
  chatLoading: boolean
  setChatLoading: Dispatch<SetStateAction<boolean>>
  addMenuOpen: boolean
  setAddMenuOpen: Dispatch<SetStateAction<boolean>>
  attachedFiles: ComposerAttachment[]
  setAttachedFiles: Dispatch<SetStateAction<ComposerAttachment[]>>
  composerJobs: ComposerJob[]
  composerResumes: ComposerResume[]
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  chatRequestRef: MutableRefObject<AbortController | null>
  chatRequestVersionRef: MutableRefObject<number>
  shouldFollowScrollRef: MutableRefObject<boolean>
  liveBlocks: AgentTranscriptEvent[]
  resumeSessionId: AgentUnifiedStreamProps['resumeSessionId']; timelineRestoring: boolean
  setRevealThinkingVersion: Dispatch<SetStateAction<number>>
  onSessionRecorded: AgentUnifiedStreamProps['onSessionRecorded']
}

export function AgentUnifiedStreamComposer({
  waitingForAnswer, chatInput, setChatInput, chatLoading, setChatLoading, addMenuOpen, setAddMenuOpen,
  attachedFiles, setAttachedFiles, composerJobs, composerResumes, inputRef, fileInputRef,
  chatRequestRef, chatRequestVersionRef, shouldFollowScrollRef, liveBlocks, resumeSessionId, timelineRestoring, setRevealThinkingVersion,
  onSessionRecorded,
}: AgentUnifiedStreamComposerProps) {
  const { t } = useI18n()
  const toast = useToast()
  const turnComposer = useAgentTurnComposerContext()
  const turnComposerRef = useRef<{ sessionId: string; chatInput: string; setChatInput: (value: string) => void } | null>(turnComposer)
  turnComposerRef.current = turnComposer
  const selectedSessionRef = useRef(resumeSessionId ?? null)
  selectedSessionRef.current = resumeSessionId ?? null
  const preserveTaskDraft = useTaskDraftRecovery(resumeSessionId ?? null, turnComposer?.sessionId ?? null,
    timelineRestoring, turnComposer?.chatInput ?? chatInput, turnComposerRef, setChatInput)
  const sessionStartLockRef = useRef(false)
  const objectiveDraftPendingRef = useRef(false)
  const objectiveStartInFlightRef = useRef(false)
  const objectiveContextEntryAvailable = canShowObjectiveContextEntry(Boolean(resumeSessionId), timelineRestoring, Boolean(turnComposer), liveBlocks.length, waitingForAnswer)
  const objectiveSwitchLock = useObjectiveSessionSwitchLock(objectiveContextEntryAvailable, inputRef, objectiveStartInFlightRef)
  const objectiveSessionSwitchPendingRef = objectiveSwitchLock.pendingRef
  const [objectiveDraftPending, setObjectiveDraftPending] = useState(false)
  const [composerMode, setComposerMode] = useState<AgentComposerMode>('chat')
  const [taskStartBusy, setTaskStartBusy] = useState(false)
  const taskAttemptRegistryRef = useRef<AgentComposerTaskAttemptRegistry | null>(null)
  if (!taskAttemptRegistryRef.current) taskAttemptRegistryRef.current = new AgentComposerTaskAttemptRegistry()
  const taskAvailability = resolveComposerTaskAvailability({
    selectedSessionId: resumeSessionId ?? null,
    composerSessionId: turnComposer?.sessionId ?? null,
    hasActiveTurn: Boolean(turnComposer?.activeTurn), sessionStatus: turnComposer ? turnComposer.sessionStatus : null,
    turnStateReadiness: resumeSessionId ? turnComposer?.turnStateReadiness ?? 'loading' : 'ready',
    isRestoring: timelineRestoring,
    waitingForAnswer,
    isBusy: chatLoading || taskStartBusy || objectiveDraftPending || objectiveStartInFlightRef.current
      || objectiveSessionSwitchPendingRef.current || Boolean(turnComposer?.sending),
    hasLiveBlocks: liveBlocks.length > 0,
  })
  const taskModeHelp = taskAvailability.kind === 'unavailable' ? composerTaskUnavailableMessage(taskAvailability.reason) : 'Start a plan-first task from this blank workspace or idle Session.'
  function refuseSendDuringSessionSwitch() {
    if (!objectiveSessionSwitchPendingRef.current) return false
    toast.info('Task is switching', 'Wait for the new task to finish opening before sending more context.'); return true
  }

  const turnComposerForAgentComposer = turnComposer ? { ...turnComposer, send: (text: string) => {
    if (refuseSendDuringSessionSwitch()) return; turnComposer.send(text)
  } } : null

  function setObjectiveStartBusy(busy: boolean) {
    objectiveStartInFlightRef.current = busy
    setChatLoading(busy)
    objectiveSwitchLock.sync()
  }

  const waitForObjectiveSessionSwitch = objectiveSwitchLock.wait
  function appendComposerContext(text: string) {
    if (isOrdinaryComposerInputLocked(objectiveStartInFlightRef.current, objectiveSessionSwitchPendingRef.current)) {
      toast.info('Task is starting', 'Wait for the current task start to finish before adding context.')
      return
    }
    setChatInput(current => current.trim() ? `${current.trim()}\n\n${text}` : text)
    setAddMenuOpen(false)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function addSelectedFiles(files: FileList | null) {
    addSelectedComposerFiles({
      files, sessionStartLocked: sessionStartLockRef.current,
      refuseSendDuringSessionSwitch, setAttachedFiles,
      onStartBlocked: () => toast.info('Task is starting', 'Wait for the current task start to finish before adding files.'),
      onAdded: count => toast.info(t('agent.filesAttached'), `${count} ${t(count === 1 ? 'agent.file' : 'agent.files')} ${t('agent.addedAsContext')}`),
    })
  }

  async function sendChat(text: string) {
    if (refuseSendDuringSessionSwitch()) return
    if (!text.trim() || chatLoading) return
    const draftText = text.trim()
    const draftFiles = attachedFiles
    const outgoing = [draftText, attachmentComposerContext(attachedFiles)].filter(Boolean).join('\n\n')
    if (turnComposer) {
      turnComposer.send(outgoing)
      setAttachedFiles([])
      return
    }
    if (objectiveContextEntryAvailable && !canStartOrdinaryChat(objectiveDraftPendingRef.current)) {
      toast.info('Finish the objective draft first', 'Discard or start that draft before sending ordinary chat. Your regular draft and attachments will stay here.')
      return
    }
    if (sessionStartLockRef.current) return
    sessionStartLockRef.current = true
    setChatInput('')
    setAttachedFiles([])
    setChatLoading(true)
    const requestVersion = chatRequestVersionRef.current + 1
    chatRequestVersionRef.current = requestVersion
    const controller = new AbortController()
    chatRequestRef.current?.abort()
    chatRequestRef.current = controller

    try {
      const sessionResponse = await fetch('/api/agent/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: draftText }),
        signal: controller.signal,
      })
      const sessionBody = await sessionResponse.json().catch(() => null) as unknown
      const sessionRecord = sessionBody && typeof sessionBody === 'object' && !Array.isArray(sessionBody)
        ? (sessionBody as Record<string, unknown>).session
        : null
      const recordedSessionId = sessionRecord && typeof sessionRecord === 'object' && !Array.isArray(sessionRecord)
        && typeof (sessionRecord as Record<string, unknown>).id === 'string'
        ? (sessionRecord as Record<string, unknown>).id as string
        : null
      if (!sessionResponse.ok || !recordedSessionId) throw new Error('Could not create an Agent session.')
      if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
      const fetcher: typeof fetch = (input, init) => fetch(input, { ...init, signal: controller.signal })
      await sendAgentTurnMessage(recordedSessionId, outgoing, 'steer', null, newClientMessageId(), fetcher)
      if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
      shouldFollowScrollRef.current = true
      chatRequestRef.current = null
      setChatLoading(false)
      onSessionRecorded(recordedSessionId, draftText, 'Chat · Running')
    } catch (err) {
      if (controller.signal.aborted || requestVersion !== chatRequestVersionRef.current) return
      const message = (err as Error).message || 'Agent chat failed.'
      setChatInput(current => current.trim() ? current : draftText)
      setAttachedFiles(current => current.length > 0 ? current : draftFiles)
      toast.error(t('agent.chatFailed'), message)
    } finally {
      sessionStartLockRef.current = false
      if (requestVersion === chatRequestVersionRef.current) {
        chatRequestRef.current = null
        setChatLoading(false)
      }
    }
  }

  function startTask(text: string) {
    void submitComposerTask({
      mode: composerMode,
      availability: taskAvailability,
      objectiveDraft: text,
      attachedFileCount: attachedFiles.length,
      isBusy: chatLoading || taskStartBusy || objectiveDraftPending || objectiveStartInFlightRef.current
        || objectiveSessionSwitchPendingRef.current || Boolean(turnComposer?.sending),
      selectedSessionId: resumeSessionId ?? null,
      selectedSessionRef,
      attemptRegistry: taskAttemptRegistryRef.current!,
      startLockRef: sessionStartLockRef,
      setTaskStartBusy,
      setStartBusy: setObjectiveStartBusy,
      setAddMenuOpen: value => setAddMenuOpen(value),
      waitForSessionSwitch: waitForObjectiveSessionSwitch,
      turnComposerRef,
      setChatInput,
      shouldFollowScrollRef,
      onSessionRecorded,
      notifyInfo: (title, message) => toast.info(title, message),
      notifyError: message => toast.error(t('agent.chatFailed'), message),
      preserveDraft: preserveTaskDraft,
    })
  }

  const chips = [
    { label: t('agent.quickAutomate'), prompt: t('agent.quickAutomatePrompt') },
    { label: t('agent.quickReview'), prompt: t('agent.quickReviewPrompt') },
    { label: t('agent.quickExplainScore'), prompt: t('agent.quickExplainScorePrompt') },
    {
      label: t('agent.quickThinking'),
      prompt: t('agent.quickThinkingPrompt'),
      onClick: () => liveBlocks.some(block => block.type === 'thinking_summary')
        ? setRevealThinkingVersion(v => v + 1)
        : appendComposerContext(t('agent.quickThinkingPrompt')),
    },
  ]

  return (
    <>
      <AgentObjectiveContextForm
        available={objectiveContextEntryAvailable}
        startLockRef={sessionStartLockRef}
        onDraftPendingChange={pending => { objectiveDraftPendingRef.current = pending; setObjectiveDraftPending(pending) }}
        attachedFileCount={attachedFiles.length}
        ordinaryComposerDraftPresent={Boolean(chatInput.trim())}
        disabled={chatLoading}
        onBusyChange={setObjectiveStartBusy}
        onAccepted={(sessionId, objective) => {
          shouldFollowScrollRef.current = true
          waitForObjectiveSessionSwitch()
          onSessionRecorded(sessionId, objective, 'Task · Running')
        }}
      />
      <AgentTurnComposerProvider value={turnComposerForAgentComposer}><AgentComposer
        waitingForAnswer={waitingForAnswer} chips={chips} chatInput={chatInput}
        chatLoading={chatLoading} addMenuOpen={addMenuOpen} attachedFiles={attachedFiles}
        composerJobs={composerJobs} composerResumes={composerResumes}
        inputRef={inputRef} fileInputRef={fileInputRef}
        composerMode={composerMode} taskModeAvailable={taskAvailability.kind === 'available'} taskModeUnavailableMessage={taskModeHelp}
        taskStartBusy={taskStartBusy} onComposerModeChange={setComposerMode} onStartTask={startTask}
        onChatInputChange={value => { if (isOrdinaryComposerInputLocked(objectiveStartInFlightRef.current, objectiveSessionSwitchPendingRef.current)) return; setChatInput(value) }}
        onAddMenuOpenChange={setAddMenuOpen} onSendChat={sendChat}
        onRemoveAttachedFile={id => { if (!objectiveSessionSwitchPendingRef.current) setAttachedFiles(current => current.filter(file => file.id !== id)) }}
        onAddSelectedFiles={addSelectedFiles}
        onAddJobContext={job => appendComposerContext(jobComposerContext(job))}
        onAddResumeContext={resume => appendComposerContext(resumeComposerContext(resume))}
        onAppendComposerContext={appendComposerContext}
      /></AgentTurnComposerProvider>
    </>
  )
}
