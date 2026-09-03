'use client'

import React from 'react'
import { ChevronDown, LockKeyhole, Paperclip } from 'lucide-react'
import { ComposerMenuButton, ComposerMenuEmpty, ComposerMenuSection } from '@/components/agent-workspace/ComposerParts'
import { useI18n } from '@/lib/i18n'
import type { ComposerJob, ComposerResume } from './AgentComposer'

interface AgentComposerToolsProps {
  addMenuOpen: boolean
  composerJobs: ComposerJob[]
  composerResumes: ComposerResume[]
  fileInputRef: React.RefObject<HTMLInputElement | null>
  onAddMenuOpenChange: (value: boolean | ((current: boolean) => boolean)) => void
  onAddSelectedFiles: (files: FileList | null) => void
  onAddJobContext: (job: ComposerJob) => void
  onAddResumeContext: (resume: ComposerResume) => void
  onAppendComposerContext: (text: string) => void
}

export function AgentComposerTools({
  addMenuOpen, fileInputRef, composerJobs, composerResumes, onAddMenuOpenChange,
  onAddSelectedFiles, onAddJobContext, onAddResumeContext, onAppendComposerContext,
}: AgentComposerToolsProps) {
  const { t } = useI18n()
  const [advancedModelOpen, setAdvancedModelOpen] = React.useState(false)

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 7, position: 'relative' }}>
      <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={e => { onAddSelectedFiles(e.currentTarget.files); e.currentTarget.value = '' }} />
      <button onClick={() => { setAdvancedModelOpen(false); onAddMenuOpenChange(open => !open) }} title={t('agent.addContext')} aria-label={t('agent.addContext')} style={{ width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 12, border: 'none', background: 'rgba(79,70,229,0.08)', color: 'var(--primary)', cursor: 'pointer' }}>
        <Paperclip size={17} strokeWidth={2.15} aria-hidden="true" />
      </button>
      {addMenuOpen && (
        <div className="agent-composer-add-menu" style={{ position: 'absolute', bottom: 'calc(100% + 10px)', left: 0, width: 280, maxHeight: 'min(420px, 60vh)', overflowY: 'auto', border: '1px solid rgba(79,70,229,0.14)', borderRadius: 14, background: 'var(--bg)', boxShadow: '0 18px 42px rgba(15,23,42,0.18)', padding: 8, zIndex: 100 }}>
          <ComposerMenuSection title={t('agent.jobs')}>
            {composerJobs.length === 0 && <ComposerMenuEmpty>{t('agent.noSavedJobs')}</ComposerMenuEmpty>}
            {composerJobs.slice(0, 4).map(job => <ComposerMenuButton key={job.id} label={`${job.company} · ${job.role}`} meta={`${job.location ?? 'No location'} · ${job.score ?? '-'} · ${job.status}`} onClick={() => onAddJobContext(job)} />)}
            <ComposerMenuButton label={t('agent.pasteJobUrl')} meta={t('agent.addLinkManually')} onClick={() => onAppendComposerContext('Analyse and prepare an application for this job link:')} />
          </ComposerMenuSection>
          <ComposerMenuSection title={t('agent.resumes')}>
            {composerResumes.length === 0 && <ComposerMenuEmpty>{t('agent.noResumes')}</ComposerMenuEmpty>}
            {composerResumes.slice(0, 3).map(resume => <ComposerMenuButton key={resume.id} label={`${resume.name}${resume.isDefault ? ` · ${t('agent.default')}` : ''}`} meta={resume.kind ?? 'base'} onClick={() => onAddResumeContext(resume)} />)}
          </ComposerMenuSection>
          <ComposerMenuSection title={t('agent.actions')}>
            <ComposerMenuButton label={t('agent.createAutomation')} meta={t('agent.startRoutine')} onClick={() => onAppendComposerContext('Create a new automation for me:')} />
            <ComposerMenuButton label={t('agent.attachFiles')} meta={t('agent.fileDescription')} onClick={() => { onAddMenuOpenChange(false); fileInputRef.current?.click() }} />
          </ComposerMenuSection>
        </div>
      )}
      <div style={{ position: 'relative' }}>
        <button type="button" onClick={() => { onAddMenuOpenChange(false); setAdvancedModelOpen(open => !open) }} aria-expanded={advancedModelOpen} aria-haspopup="dialog" title={t('agent.advancedModel')} style={{ height: 34, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRadius: 12, border: 'none', background: 'rgba(15,23,42,0.045)', color: 'var(--text-muted)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 700 }}>
          <LockKeyhole size={13} aria-hidden="true" />
          <span>{t('agent.model')}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        {advancedModelOpen && (
          <div className="agent-composer-model-dialog" role="dialog" aria-label={t('agent.advancedSelection')} style={{ position: 'absolute', bottom: 'calc(100% + 10px)', left: 0, width: 276, padding: 12, border: '1px solid rgba(79,70,229,0.14)', borderRadius: 14, background: 'var(--bg)', boxShadow: '0 18px 42px rgba(15,23,42,0.18)', zIndex: 100 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12, fontWeight: 700, color: 'var(--text)' }}><LockKeyhole size={14} color="var(--text-muted)" aria-hidden="true" />{t('agent.advancedModel')}</div>
            <p style={{ margin: '6px 0 10px', fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)' }}>{t('agent.advancedDescription')}</p>
            <button type="button" onClick={() => { window.location.assign('/?page=settings&tab=apiKeys') }} style={{ width: '100%', minHeight: 30, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg-secondary)', color: 'var(--text)', cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, fontWeight: 650 }}>{t('agent.openAdvancedSettings')}</button>
          </div>
        )}
      </div>
    </div>
  )
}
