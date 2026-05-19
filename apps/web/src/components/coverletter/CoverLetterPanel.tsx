'use client'
import React, { useState, useEffect, useRef } from 'react'
import { Btn, useToast, useConfirm } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import type { CoverLetter, Job, ResumeContent } from '@/lib/types'

interface Props {
  job:           Job
  resumeContent: ResumeContent | null
  resumeName:    string
  templateName?: string
  onClose:       () => void
  onSaved?:      (cl: CoverLetter) => void
}

const TONES = ['professional', 'enthusiastic', 'concise'] as const
type Tone = typeof TONES[number]

export function CoverLetterPanel({ job, resumeContent, resumeName, templateName, onClose, onSaved }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  const [confirm, ConfirmDialog] = useConfirm()

  const [coverLetters, setCoverLetters]   = useState<CoverLetter[]>([])
  const [activeId,     setActiveId]       = useState<string | null>(null)
  const [localContent, setLocalContent]   = useState('')
  const [localTone,    setLocalTone]      = useState<Tone>('professional')
  const [loading,      setLoading]        = useState(true)
  const [saving,       setSaving]         = useState(false)
  const [generating,   setGenerating]     = useState(false)
  const [assigning,    setAssigning]      = useState(false)
  const [visible,      setVisible]        = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Animate in on mount
  useEffect(() => {
    const t = setTimeout(() => setVisible(true), 20)
    return () => clearTimeout(t)
  }, [])

  // Load cover letters on mount
  useEffect(() => {
    setLoading(true)
    fetch(`/api/jobs/${job.id}/cover-letters`)
      .then(r => r.json())
      .then((data: CoverLetter[]) => {
        const list = Array.isArray(data) ? data : []
        setCoverLetters(list)
        // Default: finalCoverLetterId if set, else first, else null
        const initialId = list.find(cl => cl.id === job.finalCoverLetterId)?.id ?? list[0]?.id ?? null
        setActiveId(initialId)
        if (initialId) {
          const cl = list.find(c => c.id === initialId)
          if (cl) { setLocalContent(cl.content); setLocalTone((cl.tone as Tone) ?? 'professional') }
        }
      })
      .catch(() => setCoverLetters([]))
      .finally(() => setLoading(false))
  }, [job.id, job.finalCoverLetterId])

  // Auto-grow textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [localContent])

  const activeCL = coverLetters.find(cl => cl.id === activeId) ?? null

  // Version dropdown label: newest = highest index, labeled vN down to v1
  const total = coverLetters.length
  function versionLabel(cl: CoverLetter, idx: number) {
    return `v${total - idx} · ${cl.tone} · ${new Date(cl.createdAt).toLocaleDateString()}`
  }

  function handleVersionChange(id: string) {
    const cl = coverLetters.find(c => c.id === id)
    if (!cl) return
    setActiveId(id)
    setLocalContent(cl.content)
    setLocalTone((cl.tone as Tone) ?? 'professional')
  }

  async function handleSave() {
    if (!activeId) return
    setSaving(true)
    const { data, error } = await apiMutate<CoverLetter>(`/api/cover-letters/${activeId}`, 'PATCH', { content: localContent, tone: localTone })
    setSaving(false)
    if (data) {
      setCoverLetters(prev => prev.map(c => c.id === data.id ? data : c))
      toast.success(t('coverLetter.panel.save'), 'Cover letter saved')
      onSaved?.(data)
    } else {
      toast.error('Save failed', error ?? 'Could not save cover letter')
    }
  }

  async function handleSetFinal() {
    if (!activeId) return
    setAssigning(true)
    const { data, error } = await apiMutate<Job>(`/api/jobs/${job.id}/assign`, 'PATCH', { finalCoverLetterId: activeId })
    setAssigning(false)
    if (data) {
      toast.success(t('coverLetter.panel.setFinal'), `v${total - coverLetters.findIndex(c => c.id === activeId)} set as final`)
    } else {
      toast.error('Failed', error ?? 'Could not set as final')
    }
  }

  async function handleDelete() {
    if (!activeId) return
    const ok = await confirm({
      title:        'Delete cover letter?',
      message:      t('coverLetter.panel.deleteConfirm'),
      danger:       true,
      confirmLabel: t('coverLetter.panel.delete'),
    })
    if (!ok) return
    const { error } = await apiMutate(`/api/cover-letters/${activeId}`, 'DELETE')
    if (error) { toast.error('Delete failed', error); return }
    const idx = coverLetters.findIndex(c => c.id === activeId)
    const next = coverLetters.filter(c => c.id !== activeId)
    setCoverLetters(next)
    const nextActive = next[Math.max(0, idx - 1)]?.id ?? null
    setActiveId(nextActive)
    if (nextActive) {
      const cl = next.find(c => c.id === nextActive)
      if (cl) { setLocalContent(cl.content); setLocalTone((cl.tone as Tone) ?? 'professional') }
    } else {
      setLocalContent(''); setLocalTone('professional')
    }
    toast.info('Deleted', 'Cover letter version removed')
  }

  async function handleGenerate() {
    setGenerating(true)
    let generated = ''
    if (resumeContent) {
      // Use legacy route that works without a saved resumeId
      const { data, error } = await apiMutate<{ coverLetter: string }>('/api/ai/cover-letter', 'POST', {
        resumeContent,
        jobTitle:       job.role,
        jobCompany:     job.company,
        jobDescription: job.description ?? undefined,
        tone:           localTone,
      })
      if (!data?.coverLetter) {
        setGenerating(false)
        toast.error('Generation failed', error ?? 'Check ANTHROPIC_API_KEY')
        return
      }
      generated = data.coverLetter
    } else {
      setGenerating(false)
      toast.info('No resume content', 'Open this panel from the Resume tab to generate with your resume data')
      return
    }

    // Save the generated text as a new CoverLetter record
    const { data: saved, error: saveErr } = await apiMutate<CoverLetter>(`/api/jobs/${job.id}/cover-letters`, 'POST', {
      content: generated,
      tone:    localTone,
    })
    setGenerating(false)
    if (saved) {
      const updated = [saved, ...coverLetters]
      setCoverLetters(updated)
      setActiveId(saved.id)
      setLocalContent(saved.content)
      setLocalTone((saved.tone as Tone) ?? localTone)
      toast.success(t('coverLetter.panel.generate'), 'New version created')
      onSaved?.(saved)
    } else {
      toast.error('Save failed', saveErr ?? 'Cover letter generated but could not be saved')
      // At least show the text to the user
      setLocalContent(generated)
    }
  }

  function handleClose() {
    setVisible(false)
    setTimeout(onClose, 220)
  }

  return (
    <>
      <ConfirmDialog />

      {/* Backdrop */}
      <div
        onClick={handleClose}
        style={{
          position:   'fixed',
          inset:       0,
          zIndex:      299,
          background: visible ? 'rgba(0,0,0,0.2)' : 'rgba(0,0,0,0)',
          transition: 'background 0.22s ease',
        }}
      />

      {/* Panel */}
      <div style={{
        position:   'fixed',
        top:         0,
        right:       0,
        bottom:      0,
        width:       520,
        zIndex:      300,
        background: 'var(--bg)',
        borderLeft: '0.5px solid var(--border)',
        boxShadow:  '-6px 0 28px rgba(0,0,0,0.15)',
        display:    'flex',
        flexDirection: 'column',
        transform:  visible ? 'translateX(0)' : 'translateX(520px)',
        transition: 'transform 0.22s ease',
      }}>

        {/* ── Header ─────────────────────────────────────────────────── */}
        <div style={{
          padding:       '14px 18px',
          borderBottom:  '0.5px solid var(--border)',
          display:       'flex',
          alignItems:    'center',
          gap:           10,
          flexShrink:     0,
        }}>
          <button onClick={handleClose} style={{
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 16, color: 'var(--text-muted)', lineHeight: 1, padding: 0, flexShrink: 0,
          }}>✕</button>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text)' }}>{t('coverLetter.panel.title')}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {job.role} · {job.company}
            </div>
          </div>
        </div>

        {/* ── Controls ────────────────────────────────────────────────── */}
        <div style={{
          padding:       '10px 18px',
          borderBottom:  '0.5px solid var(--border)',
          display:       'flex',
          flexWrap:      'wrap',
          gap:            8,
          alignItems:    'center',
          flexShrink:     0,
        }}>
          {/* Version dropdown */}
          {coverLetters.length > 0 && (
            <select
              value={activeId ?? ''}
              onChange={e => handleVersionChange(e.target.value)}
              style={{
                fontSize: 11, padding: '4px 8px',
                border: '0.5px solid var(--border)', borderRadius: 6,
                background: 'var(--bg)', color: 'var(--text)', outline: 'none',
              }}>
              {coverLetters.map((cl, idx) => (
                <option key={cl.id} value={cl.id}>{versionLabel(cl, idx)}</option>
              ))}
            </select>
          )}

          {/* Tone chips */}
          <div style={{ display: 'flex', gap: 4 }}>
            {TONES.map(tone => (
              <button
                key={tone}
                onClick={() => setLocalTone(tone)}
                style={{
                  fontSize:   10,
                  padding:    '3px 9px',
                  borderRadius: 20,
                  cursor:     'pointer',
                  border:     localTone === tone ? 'none' : '0.5px solid var(--border)',
                  background: localTone === tone ? 'var(--primary)' : 'var(--bg-secondary)',
                  color:      localTone === tone ? '#fff' : 'var(--text)',
                  fontWeight: localTone === tone ? 500 : 400,
                }}>
                {tone.charAt(0).toUpperCase() + tone.slice(1)}
              </button>
            ))}
          </div>

          <div style={{ flex: 1 }} />

          {/* Generate button */}
          <Btn small variant="primary" onClick={handleGenerate} disabled={generating || loading}>
            {generating ? 'Generating…' : t('coverLetter.panel.generate')}
          </Btn>
        </div>

        {/* Action buttons row */}
        <div style={{
          padding:       '8px 18px',
          borderBottom:  '0.5px solid var(--border)',
          display:       'flex',
          gap:            6,
          flexShrink:     0,
          alignItems:    'center',
        }}>
          <Btn small variant="primary" onClick={handleSave} disabled={!activeId || saving}>
            {saving ? 'Saving…' : t('coverLetter.panel.save')}
          </Btn>
          <Btn small variant="success" onClick={handleSetFinal} disabled={!activeId || assigning}>
            {assigning ? 'Setting…' : t('coverLetter.panel.setFinal')}
          </Btn>

          {/* PDF export — M9 */}
          <button
            onClick={async () => {
              if (!activeCL || !activeCL.content) return
              try {
                const { pdf } = await import('@react-pdf/renderer')
                const { saveAs } = await import('file-saver')
                const { renderCoverLetterDoc } = await import('@/lib/cover-letter-pdf')
                const CLDoc = await renderCoverLetterDoc(
                  activeCL.content,
                  undefined,
                  undefined,
                  { name: 'Applicant' },
                  { company: job.company, role: job.role },
                )
                const blob = await pdf(CLDoc as never).toBlob()
                saveAs(blob, `CoverLetter_${job.company}_${job.role}.pdf`)
                toast.success('PDF downloaded', 'Cover letter saved as PDF')
              } catch {
                toast.error('PDF error', 'Could not render cover letter PDF')
              }
            }}
            style={{
              fontSize:     10,
              padding:      '4px 9px',
              border:       '0.5px solid var(--border)',
              borderRadius: 6,
              background:   'var(--bg)',
              color:        'var(--text-muted)',
              cursor:       activeCL ? 'pointer' : 'not-allowed',
              opacity:      activeCL ? 1 : 0.5,
            }}>
            ⬇ PDF
          </button>

          <div style={{ flex: 1 }} />
          <Btn small variant="danger" onClick={handleDelete} disabled={!activeId}>
            {t('coverLetter.panel.delete')}
          </Btn>
        </div>

        {/* ── Editor (middle, scrollable) ─────────────────────────────── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '14px 18px' }}>
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10 }}>
              <div style={{ width: 20, height: 20, border: '2.5px solid rgba(79,70,229,0.20)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('coverLetter.panel.loading')}</span>
            </div>
          ) : coverLetters.length === 0 && !generating ? (
            <div style={{ textAlign: 'center', padding: '60px 24px', color: 'var(--text-muted)', fontSize: 12 }}>
              {t('coverLetter.panel.empty')}
            </div>
          ) : generating ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', gap: 10 }}>
              <div style={{ width: 20, height: 20, border: '2.5px solid rgba(79,70,229,0.20)', borderTopColor: 'var(--primary)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{t('coverLetter.panel.generating')}</span>
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={localContent}
              onChange={e => setLocalContent(e.target.value)}
              onKeyDown={e => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); handleSave() } }}
              placeholder={t('coverLetter.panel.placeholder')}
              style={{
                width:       '100%',
                minHeight:   320,
                fontSize:    12,
                lineHeight:  1.8,
                border:      '0.5px solid var(--border)',
                borderRadius: 6,
                padding:     14,
                outline:     'none',
                color:       'var(--text)',
                background:  'var(--bg)',
                resize:      'none',
                overflow:    'hidden',
                boxSizing:   'border-box',
                fontFamily:  'inherit',
              }}
            />
          )}
        </div>

        {/* ── PDF Preview placeholder (bottom) ────────────────────────── */}
        <div style={{ borderTop: '0.5px solid var(--border)', padding: '10px 16px', background: 'var(--bg-secondary)', flexShrink: 0 }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500, letterSpacing: '0.05em' }}>{t('coverLetter.panel.pdfHeader')}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', fontStyle: 'italic', flex: 1 }}>
              📄 with {resumeName}{templateName ? ` · ${templateName}` : ''} — {t('coverLetter.panel.pdfCaption')}
            </div>
            {activeCL && (
              <button
                onClick={async () => {
                  if (!activeCL.content) return
                  try {
                    const { pdf } = await import('@react-pdf/renderer')
                    const { saveAs } = await import('file-saver')
                    const { renderCoverLetterDoc } = await import('@/lib/cover-letter-pdf')
                    const CLDoc = await renderCoverLetterDoc(
                      activeCL.content,
                      undefined,
                      undefined,
                      { name: 'Applicant' },
                      { company: job.company, role: job.role },
                    )
                    const blob = await pdf(CLDoc as never).toBlob()
                    saveAs(blob, `CoverLetter_${job.company}_${job.role}.pdf`)
                    toast.success('PDF downloaded', 'Cover letter saved as PDF')
                  } catch {
                    toast.error('PDF error', 'Could not render cover letter PDF')
                  }
                }}
                style={{
                  fontSize:     10,
                  padding:      '3px 8px',
                  border:       '0.5px solid var(--border)',
                  borderRadius: 5,
                  background:   'var(--bg)',
                  color:        'var(--text-muted)',
                  cursor:       'pointer',
                  flexShrink:   0,
                }}>
                ⬇ Download PDF
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
