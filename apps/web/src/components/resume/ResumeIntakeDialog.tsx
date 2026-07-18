'use client'

import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Btn, useToast } from '@/components/ui'
import { useI18n } from '@/lib/i18n'
import { apiMutate } from '@/lib/hooks'
import type { ResumeContent, Resume, ResumeListItem, Direction } from '@/lib/types'

// ── Types ─────────────────────────────────────────────────────────────────────

interface Props {
  onClose:      () => void
  onSaved:      (resume: Resume) => void
  directions:   Direction[]
  initialDirId?: string | null
}

type TabId   = 'upload' | 'paste' | 'screenshot'
type Stage   = 'idle' | 'uploading' | 'extracting' | 'parsing' | 'preview' | 'error'

interface PersonaFields {
  name?:     boolean
  email?:    boolean
  phone?:    boolean
  location?: boolean
  linkedin?: boolean
}

// ── Component ─────────────────────────────────────────────────────────────────

export function ResumeIntakeDialog({ onClose, onSaved, directions: initialDirections, initialDirId }: Props) {
  const { t } = useI18n()
  const toast = useToast()
  const inputRef = useRef<HTMLInputElement>(null)

  const [activeTab,      setActiveTab]      = useState<TabId>('upload')
  const [stage,          setStage]          = useState<Stage>('idle')
  const [errMsg,         setErrMsg]         = useState('')
  const [dragOver,       setDragOver]       = useState(false)
  const [pasteText,      setPasteText]      = useState('')
  const [parsed,         setParsed]         = useState<ResumeContent | null>(null)
  const [mergedContent,  setMergedContent]  = useState<ResumeContent | null>(null)
  const [personaFields,  setPersonaFields]  = useState<PersonaFields>({})
  const [saving,         setSaving]         = useState(false)

  // Directions state (local copy so we can add new ones)
  const [directions, setDirections] = useState<Direction[]>(initialDirections)
  const [selectedDirId, setSelectedDirId] = useState<string | null>(initialDirId ?? null)

  // Inline new-direction input state
  const [showNewDirInput, setShowNewDirInput] = useState(false)
  const [newDirName,      setNewDirName]      = useState('')
  const [creatingDir,     setCreatingDir]     = useState(false)

  // Unmount guard for timer callbacks (Fix 3)
  const mountedRef = useRef(true)
  useEffect(() => () => { mountedRef.current = false }, [])

  // ── Helpers ────────────────────────────────────────────────────────────────

  const isLoading = stage === 'uploading' || stage === 'extracting' || stage === 'parsing'
  const progress  = stage === 'uploading' ? 30 : stage === 'extracting' ? 60 : stage === 'parsing' ? 85 : 0

  const selectedDirName = directions.find(d => d.id === selectedDirId)?.name ?? null

  // ── Direction select ───────────────────────────────────────────────────────

  function handleDirChange(val: string) {
    if (val === '__new__') {
      setShowNewDirInput(true)
      // Reset select back to previous value — do not actually select __new__
    } else {
      setSelectedDirId(val || null)
    }
  }

  async function createNewDir() {
    const name = newDirName.trim()
    if (!name) return
    setCreatingDir(true)
    const { data, error } = await apiMutate<Direction>('/api/directions', 'POST', { name, color: null, icon: null })
    setCreatingDir(false)
    if (data) {
      setDirections(prev => [...prev, data])
      setSelectedDirId(data.id)
      setShowNewDirInput(false)
      setNewDirName('')
    } else {
      toast.error('Failed to create direction', error ?? 'Unknown error')
    }
  }

  // ── Persona merge ──────────────────────────────────────────────────────────

  async function mergeWithPersona(content: ResumeContent): Promise<{ merged: ResumeContent; persona: PersonaFields }> {
    try {
      const res  = await fetch('/api/me')
      const body = await res.json()
      if (!res.ok) return { merged: content, persona: {} }

      const merged  = { ...content, contact: { ...content.contact } }
      const persona: PersonaFields = {}

      const map: Array<[keyof PersonaFields, string]> = [
        ['name',     body.name],
        ['email',    body.email],
        ['phone',    body.phone],
        ['location', body.location],
        ['linkedin', body.linkedin],
      ]

      for (const [field, profileVal] of map) {
        if (profileVal && typeof profileVal === 'string' && profileVal.trim()) {
          merged.contact[field as keyof typeof merged.contact] = profileVal.trim()
          persona[field] = true
        }
      }

      return { merged, persona }
    } catch {
      return { merged: content, persona: {} }
    }
  }

  // ── Parse result handler ───────────────────────────────────────────────────

  async function handleParseSuccess(content: ResumeContent) {
    const { merged, persona } = await mergeWithPersona(content)
    setMergedContent(merged)
    setPersonaFields(persona)
    setParsed(content)
    setStage('preview')
  }

  // ── Upload tab ─────────────────────────────────────────────────────────────

  async function processFile(file: File) {
    const name   = file.name.toLowerCase()
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
    setMergedContent(null)
    setPersonaFields({})

    const form = new FormData()
    form.append('source', 'upload')
    form.append('file', file)
    if (selectedDirId) form.append('directionId', selectedDirId)

    const extractTimer = setTimeout(() => { if (mountedRef.current) setStage('extracting') }, 400)
    const parseTimer   = setTimeout(() => { if (mountedRef.current) setStage('parsing') },    900)

    try {
      const res  = await fetch('/api/resume/intake', { method: 'POST', body: form })
      clearTimeout(extractTimer)
      clearTimeout(parseTimer)

      const body = await res.json()
      if (!res.ok) {
        setErrMsg(body?.error ?? 'Parsing failed')
        setStage('error')
        return
      }
      await handleParseSuccess(body.parsed as ResumeContent)
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
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDirId])

  const onFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) processFile(file)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDirId])

  // ── Paste tab ──────────────────────────────────────────────────────────────

  async function handleParse() {
    if (!pasteText.trim()) return

    setStage('parsing')
    setErrMsg('')
    setParsed(null)
    setMergedContent(null)
    setPersonaFields({})

    const form = new FormData()
    form.append('source', 'paste')
    form.append('text', pasteText)
    if (selectedDirId) form.append('directionId', selectedDirId)

    try {
      const res  = await fetch('/api/resume/intake', { method: 'POST', body: form })
      const body = await res.json()
      if (!res.ok) {
        setErrMsg(body?.error ?? 'Parsing failed')
        setStage('error')
        return
      }
      await handleParseSuccess(body.parsed as ResumeContent)
    } catch {
      setErrMsg('Network error — please check your connection')
      setStage('error')
    }
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  async function handleSave() {
    if (!mergedContent) return
    setSaving(true)

    const resumeName = mergedContent.contact.name
      ? `${mergedContent.contact.name} — ${selectedDirName || 'General'}`
      : 'Imported Resume'

    const { data, error } = await apiMutate<Resume>('/api/resume', 'POST', {
      name:        resumeName,
      content:     mergedContent,
      directionId: selectedDirId,
      kind:        'base',
      origin:      activeTab === 'upload' ? 'upload' : 'paste',
    })

    setSaving(false)
    if (data) {
      onSaved(data)
      onClose()
    } else {
      toast.error('Save failed', error ?? 'Could not save resume')
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────────────

  function retry() {
    setStage('idle')
    setErrMsg('')
    setParsed(null)
    setMergedContent(null)
    setPersonaFields({})
  }

  // ── Contact field change ───────────────────────────────────────────────────

  function setContactField(field: string, value: string) {
    setMergedContent(prev => prev ? { ...prev, contact: { ...prev.contact, [field]: value } } : prev)
    // Clear persona badge when user manually edits
    setPersonaFields(prev => ({ ...prev, [field]: false }))
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      onClick={e => { if (e.target === e.currentTarget && !isLoading && !saving) onClose() }}
    >
      <div style={{
        background: 'var(--bg)', border: '0.5px solid var(--border)', borderRadius: 12,
        padding: 24, width: 600, maxWidth: '95vw', boxShadow: '0 12px 48px rgba(0,0,0,0.18)',
        maxHeight: '90vh', overflowY: 'auto',
      }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>Add your resume</div>
          {!isLoading && !saving && (
            <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-muted)', fontSize: 16, padding: 4, lineHeight: 1 }}>✕</button>
          )}
        </div>

        {/* Direction select */}
        <div style={{ marginBottom: 16 }}>
          <label style={{ fontSize: 11, color: 'var(--text-muted)', display: 'block', marginBottom: 4 }}>
            Choose a direction (optional)
          </label>
          <select
            value={selectedDirId ?? ''}
            onChange={e => handleDirChange(e.target.value)}
            style={{
              width: '100%', fontSize: 12, padding: '6px 10px',
              border: '0.5px solid var(--border)', borderRadius: 6,
              background: 'var(--bg)', color: 'var(--text)', outline: 'none',
            }}
          >
            <option value="">General resume</option>
            {directions.map(d => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
            <option value="__new__">Create a new direction…</option>
          </select>
          {showNewDirInput && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center' }}>
              <input
                autoFocus
                value={newDirName}
                onChange={e => setNewDirName(e.target.value)}
                onKeyDown={async (e) => {
                  if (e.key === 'Escape') { setShowNewDirInput(false); setNewDirName('') }
                  if (e.key === 'Enter' && newDirName.trim()) await createNewDir()
                }}
                placeholder="Direction name…"
                style={{ flex: 1, fontSize: 12, padding: '5px 8px', border: '0.5px solid var(--primary)', borderRadius: 6, outline: 'none', background: 'var(--bg)', color: 'var(--text)' }}
              />
              <button
                onClick={createNewDir}
                disabled={!newDirName.trim() || creatingDir}
                style={{ fontSize: 11, padding: '5px 10px', background: 'var(--primary)', color: '#fff', border: 'none', borderRadius: 6, cursor: newDirName.trim() ? 'pointer' : 'not-allowed', opacity: newDirName.trim() ? 1 : 0.5 }}>
                {creatingDir ? '…' : 'Add'}
              </button>
              <button
                onClick={() => { setShowNewDirInput(false); setNewDirName('') }}
                style={{ fontSize: 11, padding: '5px 8px', background: 'var(--bg)', color: 'var(--text-muted)', border: '0.5px solid var(--border)', borderRadius: 6, cursor: 'pointer' }}>
                Cancel
              </button>
            </div>
          )}
        </div>

        {/* Tabs */}
        <div style={{ display: 'flex', gap: 0, borderBottom: '0.5px solid var(--border)', marginBottom: 16 }}>
          {(['upload', 'paste', 'screenshot'] as TabId[]).map(tab => {
            const isDisabled = tab === 'screenshot'
            const isActive   = activeTab === tab
            return (
              <button
                key={tab}
                onClick={() => { if (!isDisabled) { setActiveTab(tab); retry() } }}
                title={isDisabled ? t('resume.intake.screenshotSoon') : undefined}
                style={{
                  fontSize: 12, padding: '8px 16px',
                  background: 'none', border: 'none',
                  borderBottom: isActive ? '2px solid var(--primary)' : '2px solid transparent',
                  color: isActive ? 'var(--primary)' : isDisabled ? 'var(--text-muted)' : 'var(--text)',
                  cursor: isDisabled ? 'not-allowed' : 'pointer',
                  opacity: isDisabled ? 0.5 : 1,
                  fontWeight: isActive ? 600 : 400,
                  transition: 'border-color 0.15s, color 0.15s',
                  marginBottom: -1,
                }}
              >
                {tab === 'upload'     ? 'Upload file'
               : tab === 'paste'      ? 'Paste text'
               :                        'Screenshot (coming soon)'}
              </button>
            )
          })}
        </div>

        {/* ── Upload tab content ─────────────────────────────────────────────── */}
        {activeTab === 'upload' && stage === 'idle' && (
          <>
            <div
              onDragOver={e => { e.preventDefault(); setDragOver(true) }}
              onDragLeave={() => setDragOver(false)}
              onDrop={onDrop}
              onClick={() => inputRef.current?.click()}
              style={{
                border: `1.5px dashed ${dragOver ? 'var(--primary)' : 'var(--border)'}`,
                borderRadius: 8, padding: '36px 20px', textAlign: 'center',
                cursor: 'pointer',
                background: dragOver ? 'rgba(24,95,165,0.04)' : 'var(--bg-secondary)',
                transition: 'border-color 0.15s, background 0.15s',
              }}
            >
              <div style={{ fontSize: 28, marginBottom: 10 }}>📄</div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>
                Drop your resume here, or click to browse
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>PDF or DOCX · up to 5 MB</div>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                style={{ display: 'none' }}
                onChange={onFileChange}
              />
            </div>
            <div style={{ marginTop: 8, fontSize: 10, color: 'var(--text-muted)', textAlign: 'center' }}>
              Supports text-based PDFs and DOCX. Scanned/image PDFs are not supported.
            </div>
          </>
        )}

        {/* ── Paste tab content ──────────────────────────────────────────────── */}
        {activeTab === 'paste' && stage === 'idle' && (
          <div>
            <textarea
              value={pasteText}
              onChange={e => setPasteText(e.target.value)}
              placeholder="Paste your resume text here…"
              style={{
                width: '100%', minHeight: 180, fontSize: 12, lineHeight: 1.6,
                padding: '10px 12px', border: '0.5px solid var(--border)', borderRadius: 8,
                background: 'var(--bg-secondary)', color: 'var(--text)', outline: 'none',
                resize: 'vertical', boxSizing: 'border-box', fontFamily: 'inherit',
              }}
            />
            {pasteText.trim().length > 0 && pasteText.trim().length < 50 && (
              <div style={{ fontSize: 10, color: 'var(--c-warning)', marginTop: 4 }}>
                Paste at least 50 characters of resume text
              </div>
            )}
            <div style={{ marginTop: 10, display: 'flex', justifyContent: 'flex-end' }}>
              <Btn small variant="primary" onClick={handleParse} disabled={isLoading || pasteText.trim().length < 50}>
                Parse resume
              </Btn>
            </div>
          </div>
        )}

        {/* ── Loading stages (shared) ────────────────────────────────────────── */}
        {isLoading && (
          <div style={{ padding: '24px 0', textAlign: 'center' }}>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 16 }}>
              {stage === 'uploading' ? 'Uploading file…' : stage === 'extracting' ? 'Extracting text…' : 'AI parsing resume…'}
            </div>
            <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden', margin: '0 auto', maxWidth: 320 }}>
              <div style={{ height: '100%', borderRadius: 2, background: 'var(--primary)', width: `${progress}%`, transition: 'width 0.6s ease' }} />
            </div>
            {activeTab === 'upload' && (
              <div style={{ marginTop: 20, display: 'flex', justifyContent: 'center', gap: 20 }}>
                {(['uploading', 'extracting', 'parsing'] as Stage[]).map((s, i) => {
                  const stageIdx = ['uploading', 'extracting', 'parsing'].indexOf(stage)
                  const done     = stageIdx > i
                  const current  = stage === s
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
            )}
          </div>
        )}

        {/* ── Error ─────────────────────────────────────────────────────────── */}
        {stage === 'error' && (
          <div style={{ padding: '16px 0' }}>
            <div style={{
              padding: '12px 14px', background: 'rgba(163,45,45,0.06)',
              border: '0.5px solid rgba(163,45,45,0.25)', borderRadius: 8,
              fontSize: 12, color: 'var(--c-danger)', marginBottom: 14,
            }}>
              {errMsg}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <Btn small variant="ghost" onClick={onClose}>{t('common.cancel')}</Btn>
              <Btn small variant="primary" onClick={retry}>{t('common.retry')}</Btn>
            </div>
          </div>
        )}

        {/* ── Preview pane ──────────────────────────────────────────────────── */}
        {stage === 'preview' && mergedContent && parsed && (
          <div>
            <div style={{
              display: 'grid', gridTemplateColumns: '45% 55%', gap: 16, marginBottom: 16,
              padding: '14px 16px', background: 'rgba(24,95,165,0.03)',
              border: '0.5px solid rgba(79,70,229,0.15)', borderRadius: 8,
            }}>
              {/* Left: editable contact fields */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--primary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Contact
                </div>
                {(
                  [
                    { field: 'name',     label: 'Name'     },
                    { field: 'email',    label: 'Email'    },
                    { field: 'phone',    label: 'Phone'    },
                    { field: 'location', label: 'Location' },
                    { field: 'linkedin', label: 'LinkedIn' },
                  ] as { field: keyof typeof mergedContent.contact; label: string }[]
                ).map(({ field, label }) => (
                  <div key={field} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 2, textTransform: 'uppercase' }}>{label}</div>
                    <input
                      value={(mergedContent.contact[field] ?? '') as string}
                      onChange={e => setContactField(field, e.target.value)}
                      style={{
                        width: '100%', fontSize: 11, padding: '4px 8px',
                        border: '0.5px solid var(--border)', borderRadius: 5,
                        background: 'var(--bg)', color: 'var(--text)', outline: 'none',
                        boxSizing: 'border-box',
                      }}
                    />
                    {personaFields[field as keyof PersonaFields] && (
                      <div style={{ fontSize: 9, color: 'var(--primary)', marginTop: 2, opacity: 0.8 }}>
                        {t('resume.intake.personaHint')}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              {/* Right: summary stats */}
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--primary)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                  Parsed Content
                </div>
                <StatRow icon="✓" label={`${parsed.experience.length} experience entr${parsed.experience.length === 1 ? 'y' : 'ies'}`} />
                <StatRow icon="✓" label={`${parsed.skills.length} skills`} />
                <StatRow icon="✓" label={`${parsed.education.length} education entr${parsed.education.length === 1 ? 'y' : 'ies'}`} />
                {(parsed.languages?.length ?? 0) > 0 && (
                  <StatRow icon="✓" label={`${parsed.languages!.length} language${parsed.languages!.length === 1 ? '' : 's'}`} />
                )}
                {(parsed.projects?.length ?? 0) > 0 && (
                  <StatRow icon="✓" label={`${parsed.projects!.length} project${parsed.projects!.length === 1 ? '' : 's'}`} />
                )}
                {(parsed.certifications?.length ?? 0) > 0 && (
                  <StatRow icon="✓" label={`${parsed.certifications!.length} certification${parsed.certifications!.length === 1 ? '' : 's'}`} />
                )}
                {parsed.summary && (
                  <div style={{ marginTop: 12 }}>
                    <div style={{ fontSize: 9, color: 'var(--text-muted)', marginBottom: 4, textTransform: 'uppercase' }}>Summary preview</div>
                    <div style={{
                      fontSize: 10, color: 'var(--text)', lineHeight: 1.5,
                      display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical',
                      overflow: 'hidden',
                    }}>
                      {parsed.summary}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Footer */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
              <Btn small variant="ghost" onClick={onClose} disabled={saving}>{t('common.cancel')}</Btn>
              <Btn small variant="primary" onClick={handleSave} disabled={saving}>
                {saving ? t('common.saving') : t('resume.intake.saveBtn')}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Sub-component ─────────────────────────────────────────────────────────────

function StatRow({ icon, label }: { icon: string; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
      <span style={{ color: 'var(--c-success)', fontSize: 11, fontWeight: 600 }}>{icon}</span>
      <span style={{ fontSize: 12, color: 'var(--text)' }}>{label}</span>
    </div>
  )
}
