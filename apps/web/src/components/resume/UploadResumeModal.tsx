'use client'

import React, { useCallback, useRef, useState } from 'react'
import { Btn, useToast } from '@/components/ui'
import type { ResumeContent } from '@/lib/types'

type Stage = 'idle' | 'uploading' | 'extracting' | 'parsing' | 'preview' | 'error'

const STAGE_LABELS: Record<Stage, string> = {
  idle:       '',
  uploading:  'Uploading file…',
  extracting: 'Extracting text…',
  parsing:    'AI parsing resume…',
  preview:    '',
  error:      '',
}

interface Props {
  onClose:  () => void
  onImport: (content: ResumeContent, mode: 'replace' | 'new') => void
}

export function UploadResumeModal({ onClose, onImport }: Props) {
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [stage,   setStage]   = useState<Stage>('idle')
  const [errMsg,  setErrMsg]  = useState('')
  const [parsed,  setParsed]  = useState<ResumeContent | null>(null)
  const [dragOver, setDragOver] = useState(false)

  const progress = stage === 'uploading' ? 30 : stage === 'extracting' ? 60 : stage === 'parsing' ? 85 : 0

  async function processFile(file: File) {
    const name = file.name.toLowerCase()
    const isPdf  = file.type === 'application/pdf' || name.endsWith('.pdf')
    const isDocx = file.type === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')

    if (!isPdf && !isDocx) {
      setErrMsg('Only PDF and DOCX files are supported'); setStage('error'); return
    }
    if (file.size > 5 * 1024 * 1024) {
      setErrMsg('File is too large — maximum 5 MB'); setStage('error'); return
    }

    setStage('uploading')
    setErrMsg('')
    setParsed(null)

    const form = new FormData()
    form.append('file', file)

    // Fake stage transitions for UX feedback
    const extractTimer = setTimeout(() => setStage('extracting'), 400)
    const parseTimer   = setTimeout(() => setStage('parsing'),    900)

    try {
      const res = await fetch('/api/resume/parse', { method: 'POST', body: form })
      clearTimeout(extractTimer)
      clearTimeout(parseTimer)

      const body = await res.json()
      if (!res.ok) {
        setErrMsg(body?.error ?? 'Parsing failed')
        setStage('error')
        return
      }
      setParsed(body.content as ResumeContent)
      setStage('preview')
    } catch {
      clearTimeout(extractTimer)
      clearTimeout(parseTimer)
      setErrMsg('Network error — please check your connection')
      setStage('error')
    }
  }

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) processFile(file)
  }, [])

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  }, [])

  function retry() { setStage('idle'); setErrMsg(''); setParsed(null) }

  const isLoading = stage === 'uploading' || stage === 'extracting' || stage === 'parsing'

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget && !isLoading) onClose() }}
    >
      <div style={{ background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 12, padding: 24, width: 480, maxWidth: '95vw', boxShadow: '0 12px 48px rgba(0,0,0,0.18)' }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>Import Resume</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>AI will extract and fill your resume automatically</div>
          </div>
          {!isLoading && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16, padding: 4, lineHeight: 1 }}>✕</button>
          )}
        </div>

        {/* Upload zone */}
        {stage === 'idle' && (
          <>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              style={{
                border: `1.5px dashed ${dragOver ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 8,
                padding: '36px 20px',
                textAlign: 'center',
                cursor: 'pointer',
                background: dragOver ? 'rgba(24,95,165,0.04)' : 'var(--bg-secondary)',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 10 }}>📄</div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>
                Drop your resume here, or click to browse
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>PDF or DOCX — up to 5 MB</div>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                style={{ display: 'none' }}
                onChange={onFileChange}
              />
            </div>
            <div style={{ marginTop: 10, fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
              Supports text-based PDFs and DOCX. Scanned/image PDFs are not supported.
            </div>
          </>
        )}

        {/* Loading stages */}
        {isLoading && (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>{STAGE_LABELS[stage]}</div>
            {/* Progress bar */}
            <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', margin: '0 auto', maxWidth: 320 }}>
              <div style={{
                height: '100%', borderRadius: 2, background: 'var(--primary)',
                width: `${progress}%`,
                transition: 'width 0.6s ease',
              }} />
            </div>
            <div style={{ marginTop: 20, display: 'flex', justifyContent: 'center', gap: 20 }}>
              {(['uploading', 'extracting', 'parsing'] as Stage[]).map((s, i) => {
                const done    = (['uploading', 'extracting', 'parsing'] as Stage[]).indexOf(stage) > i
                const current = stage === s
                return (
                  <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <div style={{
                      width: 18, height: 18, borderRadius: '50%',
                      background: done ? 'var(--primary)' : current ? 'rgba(79,70,229,0.15)' : 'var(--border)',
                      border: `1.5px solid ${done || current ? 'var(--primary)' : 'var(--border)'}`,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 9, color: done ? '#fff' : current ? 'var(--primary)' : 'var(--text-muted)',
                      transition: 'all 0.3s',
                    }}>
                      {done ? '✓' : i + 1}
                    </div>
                    <span style={{ fontSize: 10, color: current ? 'var(--primary)' : done ? 'var(--text)' : 'var(--text-muted)' }}>
                      {s === 'uploading' ? 'Upload' : s === 'extracting' ? 'Extract' : 'AI Parse'}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Error */}
        {stage === 'error' && (
          <div style={{ padding: '16px 0' }}>
            <div style={{ padding: '12px 14px', background: 'rgba(163,45,45,0.06)', border: '0.5px solid rgba(163,45,45,0.25)', borderRadius: 8, fontSize: 12, color: 'var(--c-danger)', marginBottom: 14 }}>
              {errMsg}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn small variant="ghost" onClick={onClose}>Cancel</Btn>
              <Btn small variant="primary" onClick={retry}>Try Again</Btn>
            </div>
          </div>
        )}

        {/* Preview & import */}
        {stage === 'preview' && parsed && (
          <div style={{ marginTop: 0 }}>
            <div style={{ padding: '10px 12px', background: 'rgba(24,95,165,0.05)', border: '0.5px solid rgba(79,70,229,0.20)', borderRadius: 8, marginBottom: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--primary)', marginBottom: 8 }}>Parsed successfully</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 16px' }}>
                <PreviewRow label="Name"       value={parsed.contact.name} />
                <PreviewRow label="Email"      value={parsed.contact.email} />
                <PreviewRow label="Location"   value={parsed.contact.location} />
                <PreviewRow label="Phone"      value={parsed.contact.phone} />
                <PreviewRow label="Experience" value={`${parsed.experience.length} item${parsed.experience.length !== 1 ? 's' : ''}`} />
                <PreviewRow label="Education"  value={`${parsed.education.length} item${parsed.education.length !== 1 ? 's' : ''}`} />
                <PreviewRow label="Skills"     value={`${parsed.skills.length} skills`} />
                {parsed.languages?.length ? <PreviewRow label="Languages" value={`${parsed.languages.length}`} /> : null}
                {parsed.projects?.length   ? <PreviewRow label="Projects"  value={`${parsed.projects.length}`} /> : null}
              </div>
            </div>

            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 12 }}>
              Choose how to import:
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Btn small variant="ghost" onClick={onClose}>Cancel</Btn>
              <div style={{ flex: 1 }} />
              <Btn small variant="ghost" onClick={() => { onImport(parsed!, 'new'); onClose() }}>
                Import as New Resume
              </Btn>
              <Btn small variant="primary" onClick={() => { onImport(parsed!, 'replace'); onClose() }}>
                Replace Current
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function PreviewRow({ label, value }: { label: string; value?: string | null }) {
  if (!value) return null
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
      <span style={{ fontSize: 10, color: 'var(--text-muted)', minWidth: 64, flexShrink: 0 }}>{label}</span>
      <span style={{ fontSize: 11, color: 'var(--text)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{value}</span>
    </div>
  )
}
