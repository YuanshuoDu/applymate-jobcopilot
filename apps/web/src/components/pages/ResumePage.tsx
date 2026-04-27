'use client'

import React, { useState, useEffect, useRef } from 'react'
import { TopBar } from '@/components/layout/TopBar'
import { Btn, useToast } from '@/components/ui'
import { useApi, apiMutate } from '@/lib/hooks'
import type { ResumeListItem, ResumeContent, Resume, Job, ScoreResult, Suggestion } from '@/lib/types'
import { InlineInput } from '@/components/resume/InlineInput'
import { CoverLetterModal } from '@/components/resume/CoverLetterModal'
import { TemplateModal, TEMPLATES } from '@/components/resume/TemplateModal'
import { ContactSection } from '@/components/resume/ContactSection'
import { SummarySection } from '@/components/resume/SummarySection'
import { ExperienceSection } from '@/components/resume/ExperienceSection'
import { SkillsSection } from '@/components/resume/SkillsSection'
import { EducationSection } from '@/components/resume/EducationSection'
import { AiPanel } from '@/components/resume/AiPanel'

const EMPTY_CONTENT: ResumeContent = {
  contact:    { name: '', email: '', location: '' },
  summary:    '',
  experience: [],
  education:  [],
  skills:     [],
}

export function ResumePage() {
  const toast = useToast()

  // ── Resume list & selection ──
  const { data: resumeList, loading: loadingList } = useApi<ResumeListItem[]>('/api/resume')
  const [resumes,          setResumes]          = useState<ResumeListItem[]>([])
  const [selectedResumeId, setSelectedResumeId] = useState<string | null>(null)

  // ── Content state ──
  const [content,     setContent]     = useState<ResumeContent | null>(null)
  const [resumeName,  setResumeName]  = useState('My Resume')
  const [templateId,  setTemplateId]  = useState('minimal')
  const [loadingCont, setLoadingCont] = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [dirty,       setDirty]       = useState(false)
  const [editSection, setEditSection] = useState<string | null>(null)

  // ── Jobs for tailoring ──
  const { data: jobData } = useApi<{ jobs: Job[] }>('/api/jobs?pageSize=30')
  const [jobs,          setJobs]          = useState<Job[]>([])
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null)

  // ── AI panel ──
  const [scoreResult, setScoreResult] = useState<ScoreResult | null>(null)
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [scoring,     setScoring]     = useState(false)
  const [suggesting,  setSuggesting]  = useState(false)

  // ── UI ──
  const [showTemplates,   setShowTemplates]   = useState(false)
  const [showCoverLetter, setShowCoverLetter] = useState(false)
  const initDone = useRef(false)

  // ── Sync resume list ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!resumeList) return
    setResumes(resumeList)
    if (!selectedResumeId && resumeList.length > 0) {
      const def = resumeList.find(r => r.isDefault) ?? resumeList[0]
      setSelectedResumeId(def.id)
    }
  }, [resumeList])

  // ── Auto-create default resume if none exist ──────────────────────────────
  useEffect(() => {
    if (loadingList || initDone.current) return
    if (!resumeList) return
    initDone.current = true

    if (resumeList.length === 0) {
      apiMutate<Resume>('/api/resume', 'POST', {
        name: 'My Resume', content: EMPTY_CONTENT, isDefault: true,
      }).then(({ data, error }) => {
        if (data) {
          setResumes([{ id: data.id, name: data.name, isDefault: data.isDefault, createdAt: data.createdAt, updatedAt: data.updatedAt }])
          setSelectedResumeId(data.id)
          setContent(EMPTY_CONTENT)
          setResumeName(data.name)
          toast.info('Resume created', 'Fill in your details to get started')
        } else {
          toast.error('Error', error ?? 'Could not create resume')
        }
      })
    }
  }, [resumeList, loadingList])

  // ── Load full resume when selection changes ───────────────────────────────
  useEffect(() => {
    if (!selectedResumeId) return
    setLoadingCont(true)
    setDirty(false)
    setScoreResult(null)
    setSuggestions([])

    fetch(`/api/resume/${selectedResumeId}`)
      .then(r => r.json())
      .then((r: Resume) => {
        setContent((r.content ?? EMPTY_CONTENT) as ResumeContent)
        setResumeName(r.name)
        setTemplateId(r.templateId ?? 'minimal')
      })
      .catch(() => toast.error('Error', 'Could not load resume'))
      .finally(() => setLoadingCont(false))
  }, [selectedResumeId])

  // ── Sync job list ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (jobData?.jobs) setJobs(jobData.jobs)
  }, [jobData])

  // ── Auto-run analysis when job selection or jobs list changes ─────────────
  useEffect(() => {
    if (!selectedJobId || !content || jobs.length === 0) return
    runAnalysis(content, selectedJobId)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJobId, jobs])

  // ── Helpers ───────────────────────────────────────────────────────────────

  function patch(updater: (prev: ResumeContent) => ResumeContent) {
    setContent(prev => {
      if (!prev) return prev
      setDirty(true)
      return updater(prev)
    })
  }

  async function runAnalysis(c: ResumeContent, jobId: string) {
    const job = jobs.find(j => j.id === jobId)
    if (!job) return

    setScoring(true)
    setSuggesting(true)

    const [scoreRes, suggestRes] = await Promise.allSettled([
      apiMutate<ScoreResult>('/api/ai/score', 'POST', {
        resumeContent:   c,
        jobTitle:        job.role,
        jobCompany:      job.company,
        jobDescription:  job.description ?? undefined,
      }),
      apiMutate<{ suggestions: Suggestion[] }>('/api/ai/suggest', 'POST', {
        resumeContent:   c,
        jobTitle:        job.role,
        jobCompany:      job.company,
        jobDescription:  job.description ?? undefined,
      }),
    ])

    setScoring(false)
    setSuggesting(false)

    if (scoreRes.status === 'fulfilled' && scoreRes.value.data) {
      setScoreResult(scoreRes.value.data)
    } else {
      const msg = scoreRes.status === 'fulfilled' ? (scoreRes.value.error ?? 'Unknown error') : scoreRes.reason
      toast.error('Analysis failed', typeof msg === 'string' ? msg : 'Check ANTHROPIC_API_KEY')
    }

    if (suggestRes.status === 'fulfilled' && suggestRes.value.data?.suggestions) {
      setSuggestions(suggestRes.value.data.suggestions)
    }
  }

  async function handleSave() {
    if (!selectedResumeId || !content) return
    setSaving(true)
    const { error } = await apiMutate(`/api/resume/${selectedResumeId}`, 'PATCH', {
      name: resumeName, content, templateId,
    })
    setSaving(false)
    if (error) {
      toast.error('Save failed', error)
    } else {
      setDirty(false)
      toast.success('Saved', 'Resume updated successfully')
      if (selectedJobId) runAnalysis(content, selectedJobId)
    }
  }

  function applySuggestion(i: number) {
    setSuggestions(prev => {
      const next = [...prev]
      next[i] = { ...next[i], applied: true }
      return next
    })
    toast.success('Noted', 'Update your resume to reflect this suggestion')
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const selectedJob = jobs.find(j => j.id === selectedJobId) ?? null

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TopBar title="Resume">
        <select
          value={selectedResumeId ?? ''}
          onChange={e => {
            if (dirty && !window.confirm('Discard unsaved changes?')) return
            setSelectedResumeId(e.target.value)
          }}
          style={{ fontSize: 11, padding: '4px 8px', border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', maxWidth: 160 }}>
          {resumes.map(r => (
            <option key={r.id} value={r.id}>{r.name}{r.isDefault ? ' ★' : ''}</option>
          ))}
        </select>

        <Btn variant="ghost" onClick={() => setShowTemplates(true)}>⊞ Templates</Btn>

        <select
          value={selectedJobId ?? ''}
          onChange={e => setSelectedJobId(e.target.value || null)}
          style={{ fontSize: 11, padding: '4px 8px', border: '0.5px solid var(--border)', borderRadius: 6, background: 'var(--bg)', color: 'var(--text)', outline: 'none', maxWidth: 200 }}>
          <option value="">— No tailoring —</option>
          {jobs.map(j => (
            <option key={j.id} value={j.id}>{j.company} · {j.role}</option>
          ))}
        </select>

        <Btn variant="ghost" onClick={() => {
          if (!selectedJobId) { toast.info('Select a job first', 'Choose a job from the dropdown to tailor your cover letter'); return }
          setShowCoverLetter(true)
        }}>✉ Cover Letter</Btn>
        <Btn variant="ghost" onClick={() => {
          if (!selectedResumeId) { toast.info('Select a resume first'); return }
          window.open(`/resume/${selectedResumeId}/print`, '_blank')
        }}>↓ PDF</Btn>
        <Btn variant="primary" onClick={handleSave} disabled={!dirty || saving}>
          {saving ? 'Saving…' : dirty ? 'Save*' : 'Saved'}
        </Btn>
      </TopBar>

      {loadingCont ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 28, height: 28, border: '2.5px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Loading resume…</div>
          </div>
        </div>
      ) : !content ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg-tertiary)' }}>
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 13 }}>Select or create a resume to get started.</div>
        </div>
      ) : (
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden', background: 'var(--bg-tertiary)' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 24 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 16, padding: '6px 10px', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              {['B','I','U','H1','H2','•'].map(f => (
                <button key={f} onClick={() => toast.info(`Format: ${f}`)} style={{
                  width: f.length > 1 ? 'auto' : 26, height: 26, padding: f.length > 1 ? '0 8px' : 0,
                  borderRadius: 4, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)',
                  fontSize: 11, fontWeight: f === 'B' ? 700 : 400, cursor: 'pointer', color: 'var(--text)',
                }}>{f}</button>
              ))}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: dirty ? '#854F0B' : 'var(--text-muted)' }}>
                {dirty ? '● Unsaved' : '✓ Saved'}
              </span>
            </div>

            <div style={{ maxWidth: 680, margin: '0 auto', background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 10, padding: '32px 36px' }}>
              <ContactSection
                contact={content.contact}
                editing={editSection === 'contact'}
                onEdit={() => setEditSection('contact')}
                onBlur={() => setEditSection(null)}
                onChange={c => patch(p => ({ ...p, contact: c }))}
              />
              <SummarySection
                summary={content.summary}
                matchedKeywords={scoreResult?.matchedKeywords ?? []}
                editing={editSection === 'summary'}
                onEdit={() => setEditSection('summary')}
                onBlur={() => setEditSection(null)}
                onChange={s => patch(p => ({ ...p, summary: s }))}
              />
              <ExperienceSection
                experience={content.experience}
                onChange={exp => patch(p => ({ ...p, experience: exp }))}
              />
              <SkillsSection
                skills={content.skills}
                matchedKeywords={scoreResult?.matchedKeywords ?? []}
                onChange={sk => patch(p => ({ ...p, skills: sk }))}
              />
              <EducationSection
                education={content.education}
                onChange={ed => patch(p => ({ ...p, education: ed }))}
              />
            </div>
          </div>

          <AiPanel
            selectedJob={selectedJob}
            scoreResult={scoreResult}
            suggestions={suggestions}
            scoring={scoring}
            suggesting={suggesting}
            noJobSelected={!selectedJobId}
            onApplySuggestion={applySuggestion}
            onAnalyze={() => content && selectedJobId && runAnalysis(content, selectedJobId)}
            onAddKeyword={kw => patch(p => ({ ...p, skills: [...(p.skills ?? []), kw] }))}
          />
        </div>
      )}

      {showTemplates && (
        <TemplateModal
          current={templateId}
          onSelect={id => {
            setTemplateId(id)
            setDirty(true)
            toast.success('Template applied', TEMPLATES.find(t => t.id === id)?.name + ' — content preserved')
          }}
          onClose={() => setShowTemplates(false)}
        />
      )}

      {showCoverLetter && content && selectedJob && (
        <CoverLetterModal
          resumeContent={content}
          job={selectedJob}
          onClose={() => setShowCoverLetter(false)}
        />
      )}
    </div>
  )
}
