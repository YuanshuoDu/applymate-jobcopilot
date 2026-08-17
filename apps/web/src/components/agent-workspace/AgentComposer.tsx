'use client'

import React from 'react'
import { ArrowUp, ChevronDown, LockKeyhole, Paperclip, Sparkles } from 'lucide-react'
import { ComposerMenuButton, ComposerMenuEmpty, ComposerMenuSection, formatBytes } from '@/components/agent-workspace/ComposerParts'
import { useI18n } from '@/lib/i18n'

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
  const canSend = chatInput.trim().length > 0 && !chatLoading
  const [advancedModelOpen, setAdvancedModelOpen] = React.useState(false)

  return (
    <div className="agent-composer" style={{ borderTop: '1px solid rgba(79,70,229,0.08)', padding: '12px 14px max(14px, env(safe-area-inset-bottom))', background: 'linear-gradient(180deg, rgba(248,250,252,0.72), var(--bg-secondary))', flexShrink: 0 }}>
      {waitingForAnswer && (
        <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 7, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', fontSize: 11, color: '#b45309' }}>
          ⏸ {t('agent.waitingAnswer')}
        </div>
      )}
      <div style={{ display: 'flex', gap: 7, marginBottom: 10, overflowX: 'auto', scrollbarWidth: 'none', padding: '1px 1px 3px' }}>
        {chips.map(chip => (
          <button className="agent-composer-chip" key={chip.label} onClick={() => chip.onClick ? chip.onClick() : onSendChat(chip.prompt)} style={{
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
          value={chatInput}
          onChange={e => onChatInputChange(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSendChat(chatInput) } }}
          placeholder={waitingForAnswer ? t('agent.messageAnswer') : t('agent.message')}
          rows={2}
          style={{ width: '100%', boxSizing: 'border-box', minHeight: 66, padding: '13px 14px 7px', fontSize: 14, border: 'none', background: 'transparent', color: 'var(--text)', outline: 'none', resize: 'none', fontFamily: 'inherit', lineHeight: 1.5 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 7px 7px 8px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, position: 'relative' }}>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={e => {
                onAddSelectedFiles(e.currentTarget.files)
                e.currentTarget.value = ''
              }}
            />
            <button
              onClick={() => {
                setAdvancedModelOpen(false)
                onAddMenuOpenChange(open => !open)
              }}
              title={t('agent.addContext')}
              aria-label={t('agent.addContext')}
              style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 12, border: 'none', background: 'rgba(79,70,229,0.08)', color: 'var(--primary)', cursor: 'pointer' }}
            >
              <Paperclip size={17} strokeWidth={2.15} aria-hidden="true" />
            </button>
            {addMenuOpen && (
                <div className="agent-composer-add-menu" style={{ position: 'absolute', bottom: 'calc(100% + 10px)', left: 0, width: 280, maxHeight: 'min(420px, 60vh)', overflowY: 'auto', border: '1px solid rgba(79,70,229,0.14)', borderRadius: 14, background: 'var(--bg)', boxShadow: '0 18px 42px rgba(15,23,42,0.18)', padding: 8, zIndex: 100 }}>
                <ComposerMenuSection title={t('agent.jobs')}>
                  {composerJobs.length === 0 && <ComposerMenuEmpty>{t('agent.noSavedJobs')}</ComposerMenuEmpty>}
                  {composerJobs.slice(0, 4).map(job => (
                    <ComposerMenuButton
                      key={job.id}
                      label={`${job.company} · ${job.role}`}
                      meta={`${job.location ?? 'No location'} · ${job.score ?? '-'} · ${job.status}`}
                      onClick={() => onAddJobContext(job)}
                    />
                  ))}
                  <ComposerMenuButton
                    label={t('agent.pasteJobUrl')}
                    meta={t('agent.addLinkManually')}
                    onClick={() => onAppendComposerContext('Analyse and prepare an application for this job link:')}
                  />
                </ComposerMenuSection>
                <ComposerMenuSection title={t('agent.resumes')}>
                  {composerResumes.length === 0 && <ComposerMenuEmpty>{t('agent.noResumes')}</ComposerMenuEmpty>}
                  {composerResumes.slice(0, 3).map(resume => (
                    <ComposerMenuButton
                      key={resume.id}
                      label={`${resume.name}${resume.isDefault ? ` · ${t('agent.default')}` : ''}`}
                      meta={resume.kind ?? 'base'}
                      onClick={() => onAddResumeContext(resume)}
                    />
                  ))}
                </ComposerMenuSection>
                <ComposerMenuSection title={t('agent.actions')}>
                  <ComposerMenuButton
                    label={t('agent.createAutomation')}
                    meta={t('agent.startRoutine')}
                    onClick={() => onAppendComposerContext('Create a new automation for me:')}
                  />
                  <ComposerMenuButton
                    label={t('agent.attachFiles')}
                    meta={t('agent.fileDescription')}
                    onClick={() => {
                      onAddMenuOpenChange(false)
                      fileInputRef.current?.click()
                    }}
                  />
                </ComposerMenuSection>
              </div>
            )}
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => {
                  onAddMenuOpenChange(false)
                  setAdvancedModelOpen(open => !open)
                }}
                aria-expanded={advancedModelOpen}
                aria-haspopup="dialog"
                title={t('agent.advancedModel')}
                style={{ height: 34, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRadius: 12, border: 'none', background: 'rgba(15,23,42,0.045)', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}
              >
                <LockKeyhole size={13} aria-hidden="true" />
                <span>{t('agent.model')}</span>
                <ChevronDown size={13} aria-hidden="true" />
              </button>
              {advancedModelOpen && (
                <div className="agent-composer-model-dialog" role="dialog" aria-label={t('agent.advancedSelection')} style={{ position: 'absolute', bottom: 'calc(100% + 10px)', left: 0, width: 276, padding: 12, border: '1px solid rgba(79,70,229,0.14)', borderRadius: 14, background: 'var(--bg)', boxShadow: '0 18px 42px rgba(15,23,42,0.18)', zIndex: 100 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700, color: 'var(--text)' }}>
                    <LockKeyhole size={14} color="var(--text-muted)" aria-hidden="true" />
                    {t('agent.advancedModel')}
                  </div>
                  <p style={{ margin: '6px 0 10px', fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)' }}>
                    {t('agent.advancedDescription')}
                  </p>
                  <button
                    type="button"
                    onClick={() => { window.location.assign('/?page=settings&tab=apiKeys') }}
                    style={{ width: '100%', minHeight: 30, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 650 }}
                  >
                    {t('agent.openAdvancedSettings')}
                  </button>
                </div>
              )}
            </div>
          </div>
          <button onClick={() => onSendChat(chatInput)} disabled={!canSend}
            title={t('agent.sendMessage')}
            aria-label={t('agent.sendMessage')}
            style={{ width: 38, height: 38, display: 'grid', placeItems: 'center', borderRadius: 14, border: 'none', background: !canSend ? 'rgba(148,163,184,0.35)' : 'var(--brand-gradient)', color: '#fff', cursor: !canSend ? 'not-allowed' : 'pointer', boxShadow: canSend ? '0 8px 16px rgba(79,70,229,0.28)' : 'none', transition: 'transform 160ms ease, box-shadow 160ms ease' }}>
            {chatLoading ? '…' : <ArrowUp size={19} strokeWidth={2.7} aria-hidden="true" />}
          </button>
        </div>
      </div>
    </div>
  )
}
