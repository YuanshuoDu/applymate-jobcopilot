'use client'

import React from 'react'
import { MODEL_CATALOGUE, PROVIDER_LABELS } from '@/lib/model-router'
import { ComposerMenuButton, ComposerMenuEmpty, ComposerMenuSection, formatBytes } from '@/components/agent-workspace/ComposerParts'

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
  selectedModel: string
  addMenuOpen: boolean
  attachedFiles: ComposerAttachment[]
  composerJobs: ComposerJob[]
  composerResumes: ComposerResume[]
  inputRef: React.RefObject<HTMLTextAreaElement | null>
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onChatInputChange: (value: string) => void
  onSelectedModelChange: (value: string) => void
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
  selectedModel,
  addMenuOpen,
  attachedFiles,
  composerJobs,
  composerResumes,
  inputRef,
  fileInputRef,
  onChatInputChange,
  onSelectedModelChange,
  onAddMenuOpenChange,
  onSendChat,
  onRemoveAttachedFile,
  onAddSelectedFiles,
  onAddJobContext,
  onAddResumeContext,
  onAppendComposerContext,
}: AgentComposerProps) {
  const canSend = chatInput.trim().length > 0 && !chatLoading
  const [modelMenuOpen, setModelMenuOpen] = React.useState(false)
  const activeModel = MODEL_CATALOGUE.find(model => `${model.provider}::${model.model}` === selectedModel) ?? MODEL_CATALOGUE[0]

  return (
    <div style={{ borderTop: '0.5px solid var(--border)', padding: '10px 14px', background: 'var(--bg-secondary)', flexShrink: 0 }}>
      {waitingForAnswer && (
        <div style={{ marginBottom: 8, padding: '6px 10px', borderRadius: 7, background: 'rgba(245,158,11,0.08)', border: '1px solid rgba(245,158,11,0.25)', fontSize: 11, color: '#b45309' }}>
          ⏸ Orchestrator 正在等待你回答上方问题，或直接在下方输入指令
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginBottom: 8 }}>
        {chips.map(chip => (
          <button key={chip.label} onClick={() => chip.onClick ? chip.onClick() : onSendChat(chip.prompt)} style={{
            padding: '6px 10px',
            fontSize: 11,
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--bg)',
            cursor: 'pointer',
            color: 'var(--text)',
            fontFamily: 'inherit',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}>
            {chip.label}
          </button>
        ))}
      </div>
      <div style={{
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--bg)',
        boxShadow: '0 2px 10px rgba(15,23,42,0.04)',
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
          placeholder={waitingForAnswer
            ? '回答问题或发送指令给 Orchestrator… (Enter 发送)'
            : '发送指令给 Orchestrator… (Enter 发送)'}
          rows={2}
          style={{ width: '100%', boxSizing: 'border-box', padding: '10px 12px 6px', fontSize: 12, border: 'none', background: 'transparent', color: 'var(--text)', outline: 'none', resize: 'none', fontFamily: 'inherit', lineHeight: 1.55 }}
        />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '7px 8px 8px', borderTop: '1px solid var(--border)' }}>
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
                setModelMenuOpen(false)
                onAddMenuOpenChange(open => !open)
              }}
              title="Add context"
              style={{ width: 28, height: 28, borderRadius: 7, border: '1px solid var(--border)', background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer', fontSize: 16, lineHeight: 1 }}
            >
              +
            </button>
            {addMenuOpen && (
              <div style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: 280, maxHeight: 'min(420px, 60vh)', overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, background: 'var(--bg)', boxShadow: '0 16px 36px rgba(15,23,42,0.18)', padding: 7, zIndex: 100 }}>
                <ComposerMenuSection title="Jobs">
                  {composerJobs.length === 0 && <ComposerMenuEmpty>No saved jobs yet</ComposerMenuEmpty>}
                  {composerJobs.slice(0, 4).map(job => (
                    <ComposerMenuButton
                      key={job.id}
                      label={`${job.company} · ${job.role}`}
                      meta={`${job.location ?? 'No location'} · ${job.score ?? '-'} · ${job.status}`}
                      onClick={() => onAddJobContext(job)}
                    />
                  ))}
                  <ComposerMenuButton
                    label="Paste job URL"
                    meta="Add a new link manually"
                    onClick={() => onAppendComposerContext('请基于这个职位链接分析并准备申请：')}
                  />
                </ComposerMenuSection>
                <ComposerMenuSection title="Resumes">
                  {composerResumes.length === 0 && <ComposerMenuEmpty>No resumes found</ComposerMenuEmpty>}
                  {composerResumes.slice(0, 3).map(resume => (
                    <ComposerMenuButton
                      key={resume.id}
                      label={`${resume.name}${resume.isDefault ? ' · default' : ''}`}
                      meta={resume.kind ?? 'base'}
                      onClick={() => onAddResumeContext(resume)}
                    />
                  ))}
                </ComposerMenuSection>
                <ComposerMenuSection title="Actions">
                  <ComposerMenuButton
                    label="Create automation"
                    meta="Start an agent-created routine"
                    onClick={() => onAppendComposerContext('帮我创建一个新的自动化任务：')}
                  />
                  <ComposerMenuButton
                    label="Attach files"
                    meta="Resume, note, or supporting file"
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
                  setModelMenuOpen(open => !open)
                }}
                aria-expanded={modelMenuOpen}
                aria-haspopup="listbox"
                style={{ height: 30, minWidth: 178, maxWidth: 230, borderRadius: 8, border: '1px solid rgba(79,70,229,0.22)', background: 'rgba(79,70,229,0.05)', color: 'var(--text)', cursor: 'pointer', padding: '0 9px', fontFamily: 'inherit', display: 'flex', alignItems: 'center', gap: 7 }}
              >
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--primary)', flexShrink: 0 }} />
                <span style={{ minWidth: 0, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'left', fontSize: 11, fontWeight: 700 }}>{activeModel.label}</span>
                <span aria-hidden="true" style={{ color: 'var(--text-muted)', fontSize: 13 }}>⌄</span>
              </button>
              {modelMenuOpen && (
                <div role="listbox" aria-label="Choose AI model" style={{ position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, width: 330, maxHeight: 'min(420px, 60vh)', overflowY: 'auto', border: '1px solid rgba(79,70,229,0.22)', borderRadius: 10, background: 'var(--bg)', boxShadow: '0 16px 36px rgba(15,23,42,0.18)', padding: 7, zIndex: 100 }}>
                  <div style={{ padding: '5px 7px 7px', fontSize: 10, fontWeight: 750, color: 'var(--text-muted)' }}>Choose a model</div>
                  {MODEL_CATALOGUE.map(model => {
                    const value = `${model.provider}::${model.model}`
                    const selected = value === selectedModel
                    return (
                      <button
                        key={value}
                        type="button"
                        role="option"
                        aria-selected={selected}
                        onClick={() => {
                          onSelectedModelChange(value)
                          setModelMenuOpen(false)
                        }}
                        style={{ width: '100%', padding: '9px 10px', border: selected ? '1px solid rgba(79,70,229,0.28)' : '1px solid transparent', borderRadius: 8, background: selected ? 'rgba(79,70,229,0.08)' : 'transparent', color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 9 }}
                      >
                        <span style={{ width: 8, height: 8, borderRadius: '50%', background: selected ? 'var(--primary)' : 'var(--border)', flexShrink: 0 }} />
                        <span style={{ minWidth: 0, flex: 1 }}>
                          <span style={{ display: 'block', fontSize: 11, fontWeight: 700 }}>{model.label}</span>
                          <span style={{ display: 'block', marginTop: 2, fontSize: 9, lineHeight: 1.35, color: 'var(--text-muted)' }}>{model.description}</span>
                        </span>
                        <span style={{ flexShrink: 0, fontSize: 9, color: selected ? 'var(--primary)' : 'var(--text-muted)', fontWeight: 700 }}>{PROVIDER_LABELS[model.provider]}</span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
          <button onClick={() => onSendChat(chatInput)} disabled={!canSend}
            title="Send message"
            style={{ width: 30, height: 30, borderRadius: 8, border: 'none', background: !canSend ? 'var(--border)' : 'var(--primary)', color: '#fff', fontSize: 15, cursor: !canSend ? 'not-allowed' : 'pointer' }}>
            {chatLoading ? '…' : '↑'}
          </button>
        </div>
      </div>
    </div>
  )
}
