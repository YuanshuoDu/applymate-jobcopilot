'use client'

import React, { useRef, useState, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import { useToast } from '@/components/ui'
import { useI18n } from '@/lib/i18n'
import { AgentComposer, type ComposerAttachment, type ComposerJob, type ComposerResume } from './AgentComposer'
import { AgentObjectiveContextForm } from './AgentObjectiveContextForm'
import { attachmentComposerContext, jobComposerContext, resumeComposerContext } from './AgentUnifiedStream.helpers'
import { sendAgentTurnMessage, useAgentTurnComposerContext } from './agent-turn-commands'
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
  setRevealThinkingVersion: Dispatch<SetStateAction<number>>
  onSessionRecorded: AgentUnifiedStreamProps['onSessionRecorded']
}

function newClientMessageId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return `message-${crypto.randomUUID()}`
  return `message-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function AgentUnifiedStreamComposer({
  waitingForAnswer, chatInput, setChatInput, chatLoading, setChatLoading, addMenuOpen, setAddMenuOpen,
  attachedFiles, setAttachedFiles, composerJobs, composerResumes, inputRef, fileInputRef,
  chatRequestRef, chatRequestVersionRef, shouldFollowScrollRef, liveBlocks, setRevealThinkingVersion,
  onSessionRecorded,
}: AgentUnifiedStreamComposerProps) {
  const { t } = useI18n()
  const toast = useToast()
  const turnComposer = useAgentTurnComposerContext()
  const [objectiveFormOpen, setObjectiveFormOpen] = useState(false)
  const [objectivePending, setObjectivePending] = useState(false)
  const admissionOwnerRef = useRef<'message' | 'objective' | null>(null)

  function acquireObjectiveAdmission() {
    if (chatLoading || admissionOwnerRef.current) return false
    admissionOwnerRef.current = 'objective'
    return true
  }

  function releaseObjectiveAdmission() {
    if (admissionOwnerRef.current === 'objective') admissionOwnerRef.current = null
  }

  function appendComposerContext(text: string) {
    setChatInput(current => current.trim() ? `${current.trim()}\n\n${text}` : text)
    setAddMenuOpen(false)
    setTimeout(() => inputRef.current?.focus(), 0)
  }

  function addSelectedFiles(files: FileList | null) {
    const next = Array.from(files ?? []).map(file => ({
      id: `${file.name}-${file.size}-${file.lastModified}`,
      name: file.name,
      size: file.size,
      type: file.type || 'file',
    }))
    if (next.length === 0) return
    setAttachedFiles(current => {
      const existing = new Set(current.map(file => file.id))
      return [...current, ...next.filter(file => !existing.has(file.id))].slice(0, 6)
    })
    toast.info(t('agent.filesAttached'), `${next.length} ${t(next.length === 1 ? 'agent.file' : 'agent.files')} ${t('agent.addedAsContext')}`)
  }

  async function sendChat(text: string) {
    if (!text.trim() || chatLoading || admissionOwnerRef.current === 'objective') return
    const draftText = text.trim()
    const draftFiles = attachedFiles
    const outgoing = [draftText, attachmentComposerContext(attachedFiles)].filter(Boolean).join('\n\n')
    if (turnComposer) {
      turnComposer.send(outgoing)
      setAttachedFiles([])
      return
    }
    if (admissionOwnerRef.current) return
    admissionOwnerRef.current = 'message'
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
      if (requestVersion === chatRequestVersionRef.current) {
        chatRequestRef.current = null
        setChatLoading(false)
      }
      if (admissionOwnerRef.current === 'message') admissionOwnerRef.current = null
    }
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
      {!turnComposer && !objectiveFormOpen && (
        <button type="button" data-testid="open-objective-context-form" disabled={chatLoading} onClick={() => setObjectiveFormOpen(true)} style={{ marginBottom: 7, minHeight: 30, padding: '0 10px', border: '1px solid var(--border)', borderRadius: 7, background: 'transparent', color: 'var(--text)', cursor: chatLoading ? 'wait' : 'pointer', font: 'inherit' }}>
          Start with an objective and context
        </button>
      )}
      {!turnComposer && objectiveFormOpen && (
        <AgentObjectiveContextForm
          onClose={() => setObjectiveFormOpen(false)}
          onSessionRecorded={(sessionId, goal, subtitle) => {
            shouldFollowScrollRef.current = true
            onSessionRecorded(sessionId, goal, subtitle)
          }}
          acquireAdmission={acquireObjectiveAdmission}
          releaseAdmission={releaseObjectiveAdmission}
          onBusyChange={setObjectivePending}
        />
      )}
      <AgentComposer
        waitingForAnswer={waitingForAnswer}
        chips={chips}
        chatInput={chatInput}
        chatLoading={chatLoading || objectivePending}
        addMenuOpen={addMenuOpen}
        attachedFiles={attachedFiles}
        composerJobs={composerJobs}
        composerResumes={composerResumes}
        inputRef={inputRef}
        fileInputRef={fileInputRef}
        onChatInputChange={setChatInput}
        onAddMenuOpenChange={setAddMenuOpen}
        onSendChat={sendChat}
        onRemoveAttachedFile={id => setAttachedFiles(current => current.filter(file => file.id !== id))}
        onAddSelectedFiles={addSelectedFiles}
        onAddJobContext={job => appendComposerContext(jobComposerContext(job))}
        onAddResumeContext={resume => appendComposerContext(resumeComposerContext(resume))}
        onAppendComposerContext={appendComposerContext}
      />
    </>
  )
}
