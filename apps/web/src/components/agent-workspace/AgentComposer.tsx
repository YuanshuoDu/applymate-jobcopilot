'use client'

import React from 'react'
import { ArrowUp, Sparkles } from 'lucide-react'
import { formatBytes } from '@/components/agent-workspace/ComposerParts'
import { useI18n } from '@/lib/i18n'
import { appendComposerText, useAgentTurnComposerContext } from './agent-turn-commands'
import { attachmentComposerContext, jobComposerContext, resumeComposerContext } from './AgentUnifiedStream.helpers'
import { AgentComposerActiveTurn } from './AgentComposerActiveTurn'
import { AgentComposerTools } from './AgentComposerTools'

export interface ComposerJob {
  id:       string
  company:  string
  role:     string
  location: string | null
  status:   string
  score:    number | null
  url:      string | null
}

export interface ComposerResume {
  id:        string
  name:      string
  isDefault: boolean
  kind:      string | null
  updatedAt: string
}

export interface ComposerAttachment {
  id:   string
  name: string
  size: number
  type: string
}

interface PromptChip {
  label:  string
  prompt: string
  onClick?: () => void
}

interface AgentComposerProps {
  waitingForAnswer: boolean
  chips: PromptChip[]
  chatInput: string
  chatLoading: boolean
  addMenuOpen: boolean
  attachedFiles: ComposerAttachment[]
  composerJobs: ComposerJob[]
  composerResumes: ComposerResume[]
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onChatInputChange: (value: string) => void
  onAddMenuOpenChange: (value: boolean | ((current: boolean) => boolean)) => void
  onSendChat: (text: string) => void
  onRemoveAttachedFile: (id: string) => void
  onAddSelectedFiles: (files: FileList | null) => void
  onAddJobContext: (job: ComposerJob) => void
  onAddResumeContext: (resume: ComposerResume) => void
  onAppendComposerContext: (text: string) => void
}

export function AgentComposer({
  waitingForAnswer,
  chips,
  chatInput,
  chatLoading,
  addMenuOpen,
  attachedFiles,
  composerJobs,
  composerResumes,
  inputRef,
  fileInputRef,
  onChatInputChange,
  onAddMenuOpenChange,
  onSendChat,
  onRemoveAttachedFile,
  onAddSelectedFiles,
  onAddJobContext,
  onAddResumeContext,
  onAppendComposerContext,
}: AgentComposerProps) {
  const { t } = useI18n()
  const turnComposer = useAgentTurnComposerContext()
  const composerInput = turnComposer?.chatInput ?? chatInput
  const composerLoading = turnComposer?.sending ?? chatLoading
  const handleInputChange = turnComposer?.setChatInput ?? onChatInputChange
  const handleSend = (text: string) => {
    if (!turnComposer) {
      onSendChat(text)
      return
    }
    const outgoing = [text.trim(), attachmentComposerContext(attachedFiles)].filter(Boolean).join('\n\n')
    turnComposer.send(outgoing)
    for (const file of attachedFiles) onRemoveAttachedFile(file.id)
  }
  const appendContext = (text: string) => {
    if (!turnComposer) {
      onAppendComposerContext(text)
      return
    }
    turnComposer.setChatInput(appendComposerText(turnComposer.chatInput, text))
    onAddMenuOpenChange(false)
    setTimeout(() => inputRef.current?.focus(), 0)
  }
  const handleAddJobContext = (job: ComposerJob) => {
    if (turnComposer) appendContext(jobComposerContext(job))
    else onAddJobContext(job)
  }
  const handleAddResumeContext = (resume: ComposerResume) => {
    if (turnComposer) appendContext(resumeComposerContext(resume))
    else onAddResumeContext(resume)
  }
  const canSend = composerInput.trim().length > 0 && !composerLoading
  return (
    <div className="agent-composer" style={{ borderTop: '1px solid rgba(79,70,229,0.08)', padding: '12px 14px max(14px, env(safe-area-inset-bottom))', background: 'linear-gradient(180deg, rgba(248,250,252,0.72), var(--bg-secondary))', flexShrink: 0 }}>
      {waitingForAnswer && (
        <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 7, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', fontSize: 11, color: '#b45309' }}>
          ⏸ {t('agent.waitingAnswer')}
        </div>
      )}
      {turnComposer && <AgentComposerActiveTurn controller={turnComposer} />}
      <div style={{ display: 'flex', gap: 7, marginBottom: 10, overflowX: 'auto', scrollbarWidth: 'none', padding: '1px 1px 3px' }}>
        {chips.map(chip => (
          <button className="agent-composer-chip" key={chip.label} onClick={() => chip.onClick ? chip.onClick() : handleSend(chip.prompt)} style={{
            minHeight: 34,
            flexShrink: 0,
            padding: '0 12px',
            fontSize: 11.5,
            fontWeight: 650,
            borderRadius: 999,
            border: '1px solid rgba(79,70,229,0.14)',
            background: 'rgba(255,255,255,0.82)',
            cursor: 'pointer',
            color: 'var(--text)',
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 7,
            boxShadow: '0 2px 7px rgba(15,23,42,0.035)',
          }}>
            <Sparkles size={13} color="var(--primary)" strokeWidth={2.1} aria-hidden="true" />
            {chip.label}
          </button>
        ))}
      </div>
      <div style={{
        border: '1px solid rgba(99,102,241,0.22)',
        borderRadius: 18,
        background: 'rgba(255,255,255,0.96)',
        boxShadow: '0 12px 28px rgba(49,46,129,0.10), 0 2px 7px rgba(15,23,42,0.04)',
        overflow: 'visible',
      }}>
        {attachedFiles.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 10px 0' }}>
            {attachedFiles.map(file => (
              <span key={file.id} style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                maxWidth: 210,
                border: '1px solid var(--border)',
                borderRadius: 999,
                background: 'var(--bg-secondary)',
                padding: '4px 7px',
                fontSize: 10,
                color: 'var(--text)',
              }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{file.name}</span>
                <span style={{ color: 'var(--text-muted)', flexShrink: 0 }}>{formatBytes(file.size)}</span>
                <button
                  type="button"
                  onClick={() => onRemoveAttachedFile(file.id)}
                  aria-label={`Remove ${file.name}`}
                  style={{ border: 'none', background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 12, lineHeight: 1, padding: 0 }}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        )}
        <textarea
          ref={inputRef}
          value={composerInput}
          onChange={e => handleInputChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(composerInput) } }}
          placeholder={waitingForAnswer ? t('agent.messageAnswer') : t('agent.message')}
          rows={2}
          style={{ width: '100%', boxSizing: 'border-box', minHeight: 66, padding: '13px 14px 7px', fontSize: 14, border: 'none', background: 'transparent', color: 'var(--text)', outline: 'none', resize: 'none', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 7px 7px 8px' }}>
          <AgentComposerTools
            addMenuOpen={addMenuOpen}
            composerJobs={composerJobs}
            composerResumes={composerResumes}
            fileInputRef={fileInputRef}
            onAddMenuOpenChange={onAddMenuOpenChange}
            onAddSelectedFiles={onAddSelectedFiles}
            onAddJobContext={handleAddJobContext}
            onAddResumeContext={handleAddResumeContext}
            onAppendComposerContext={appendContext}
          />
          <button onClick={() => handleSend(composerInput)} disabled={!canSend}
            title={t('agent.sendMessage')}
            aria-label={t('agent.sendMessage')}
            style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', borderRadius: 14, border: 'none', background: !canSend ? 'rgba(148,163,184,0.35)' : 'var(--brand-gradient)', color: '#fff', cursor: !canSend ? 'not-allowed' : 'pointer', boxShadow: canSend ? '0 8px 16px rgba(79,70,229,0.28)' : 'none', transition: 'transform 160ms ease, box-shadow 160ms ease' }}>
            {composerLoading ? '…' : <ArrowUp size={19} strokeWidth={2.7} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  )
}
