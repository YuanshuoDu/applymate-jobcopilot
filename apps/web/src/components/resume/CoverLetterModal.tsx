'use client'

import React, { useState } from 'react'
import { Btn, Card, useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import type { ResumeContent, Job } from '@/lib/types'

export function CoverLetterModal({ resumeContent, job, onClose }: {
  resumeContent: ResumeContent
  job:           Job
  onClose:       () => void
}) {
  const toast = useToast()
  const [letter,    setLetter]    = useState('')
  const [loading,   setLoading]   = useState(false)
  const [tone,      setTone]      = useState<'professional' | 'enthusiastic' | 'concise'>('professional')
  const [generated, setGenerated] = useState(false)

  async function generate() {
    setLoading(true)
    const { data, error } = await apiMutate<{ coverLetter: string }>('/api/ai/cover-letter', 'POST', {
      resumeContent,
      jobTitle:       job.role,
      jobCompany:     job.company,
      jobDescription: job.description ?? undefined,
      tone,
    })
    setLoading(false)
    if (data?.coverLetter) {
      setLetter(data.coverLetter)
      setGenerated(true)
    } else {
      toast.error('Generation failed', error ?? 'Check ANTHROPIC_API_KEY')
    }
  }

  function copyToClipboard() {
    navigator.clipboard.writeText(letter).then(() => toast.success('Copied', 'Cover letter copied to clipboard'))
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}
      onClick={e => { if (e.target === e.currentTarget) onClose() }}>
      <Card style={{ width: '100%', maxWidth: 640, padding: 20, display: 'flex', flexDirection: 'column', gap: 14, maxHeight: '90vh' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 500 }}>Cover Letter</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>{job.role} · {job.company}</div>
          </div>
          <Btn small variant="ghost" onClick={onClose}>✕</Btn>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {(['professional', 'enthusiastic', 'concise'] as const).map(t => (
            <button key={t} onClick={() => setTone(t)} style={{
              fontSize: 11, padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
              background: tone === t ? '#185FA5' : 'var(--bg-secondary)',
              color:      tone === t ? '#fff'    : 'var(--text)',
              border:     tone === t ? 'none'    : '0.5px solid var(--border)',
              fontWeight: tone === t ? 500       : 400,
            }}>{t.charAt(0).toUpperCase() + t.slice(1)}</button>
          ))}
          <div style={{ flex: 1 }} />
          <Btn small variant="primary" onClick={generate} disabled={loading}>
            {loading ? 'Generating…' : generated ? '↻ Regenerate' : '✦ Generate'}
          </Btn>
        </div>
        {loading ? (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px 0', gap: 10 }}>
            <div style={{ width: 20, height: 20, border: '2.5px solid rgba(24,95,165,0.2)', borderTopColor: '#185FA5', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Claude is writing your cover letter…</span>
          </div>
        ) : letter ? (
          <textarea
            value={letter}
            onChange={e => setLetter(e.target.value)}
            style={{ flex: 1, minHeight: 340, fontSize: 12, lineHeight: 1.8, border: '0.5px solid var(--border)', borderRadius: 6, padding: 14, outline: 'none', color: 'var(--text)', background: 'var(--bg)', resize: 'vertical', overflowY: 'auto' }}
          />
        ) : (
          <div style={{ padding: '40px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-muted)' }}>
            Select a tone and click Generate to create your cover letter.
          </div>
        )}
        {letter && (
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={copyToClipboard}>⎘ Copy</Btn>
            <Btn variant="primary" onClick={onClose}>Done</Btn>
          </div>
        )}
      </Card>
    </div>
  )
}
