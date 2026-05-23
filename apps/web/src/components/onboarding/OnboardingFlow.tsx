'use client'
import React, { useState } from 'react'
import { Btn, useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import type { Direction } from '@/lib/types'
import { ResumeIntakeDialog } from '@/components/resume/ResumeIntakeDialog'

// ── Constants ──────────────────────────────────────────────────────────────────

const GOAL_CHIPS = [
  { id: 'abroad', label: '🌍 Studying abroad job hunt' },
  { id: 'grad',   label: '🎓 New grad' },
  { id: 'switch', label: '🔄 Career switch' },
  { id: 'intern', label: '💼 Internship' },
]

const STARTER_GROUPS = [
  { group: 'Business',       items: ['Marketing', 'Consulting', 'Finance', 'Operations'] },
  { group: 'Data & Tech',    items: ['Data Analysis', 'Software Engineering', 'Product Management'] },
  { group: 'Culture & Media',items: ['Journalism', 'UX Design', 'Content Creation', 'Education'] },
  { group: 'Legal & Public', items: ['Law', 'Policy', 'Non-profit', 'Healthcare'] },
  { group: 'Creative',       items: ['Graphic Design', 'Photography', 'Architecture'] },
]

const TEMPLATE_OPTIONS = [
  { id: 'clean',     name: 'Modern' },
  { id: 'executive', name: 'Classic' },
  { id: 'compact',   name: 'Minimal' },
]

const ACCENT_COLORS = ['var(--primary)', 'var(--c-success)', 'var(--c-danger)', 'var(--c-warning)', '#6B3F9E', '#0F7A8C']

const TOTAL_STEPS = 5

// ── Step layout wrapper ────────────────────────────────────────────────────────

function StepLayout({ step, title, desc, children, onBack, onContinue, onSkip, continueLabel, disableContinue, t }: {
  step: number
  title: string
  desc: string
  children: React.ReactNode
  onBack?: () => void
  onContinue: () => void
  onSkip?: () => void
  continueLabel?: string
  disableContinue?: boolean
  t: (k: string) => string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {/* Progress */}
      <div style={{ padding: '20px 32px 0', display: 'flex', alignItems: 'center', gap: 8 }}>
        {Array.from({ length: TOTAL_STEPS }, (_, i) => (
          <div key={i} style={{
            width: i === step - 1 ? 20 : 8, height: 8, borderRadius: 4, transition: 'width 0.2s',
            background: i < step ? 'var(--primary)' : i === step - 1 ? 'var(--primary)' : 'var(--border)',
          }} />
        ))}
        <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 8 }}>
          {t('onboarding.step' + step + '.title') !== ('onboarding.step' + step + '.title')
            ? `Step ${step} ${t('onboarding.of')} ${TOTAL_STEPS}`
            : `Step ${step} ${t('onboarding.of')} ${TOTAL_STEPS}`
          }
        </span>
      </div>

      {/* Header */}
      <div style={{ padding: '24px 32px 16px' }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>{title}</h2>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: 'var(--text-muted)' }}>{desc}</p>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 32px' }}>
        {children}
      </div>

      {/* Footer */}
      <div style={{ padding: '16px 32px 28px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderTop: '0.5px solid var(--border)', marginTop: 16 }}>
        <div>
          {onBack && (
            <Btn variant="ghost" onClick={onBack}>{t('onboarding.back')}</Btn>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {onSkip && (
            <button onClick={onSkip} style={{ fontSize: 12, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: '0 4px' }}>
              {t('onboarding.step1.skip')}
            </button>
          )}
          <Btn variant="primary" onClick={onContinue} disabled={disableContinue}>
            {continueLabel ?? t('onboarding.continue')}
          </Btn>
        </div>
      </div>
    </div>
  )
}

// ── Step 1: Welcome & Goals ────────────────────────────────────────────────────

function Step1({ goals, onToggle, onContinue, onSkipAll, t }: {
  goals: string[]
  onToggle: (id: string) => void
  onContinue: () => void
  onSkipAll: () => void
  t: (k: string) => string
}) {
  return (
    <StepLayout
      step={1}
      title={t('onboarding.step1.title')}
      desc={t('onboarding.step1.desc')}
      onContinue={onContinue}
      onSkip={onSkipAll}
      t={t}
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, paddingTop: 8 }}>
        {GOAL_CHIPS.map(chip => {
          const selected = goals.includes(chip.id)
          return (
            <button
              key={chip.id}
              onClick={() => onToggle(chip.id)}
              style={{
                padding: '10px 18px',
                borderRadius: 999,
                border: `1.5px solid ${selected ? 'var(--primary)' : 'var(--border)'}`,
                background: selected ? 'rgba(79,70,229,0.08)' : 'var(--bg)',
                color: selected ? 'var(--primary)' : 'var(--text)',
                fontSize: 13,
                fontFamily: 'inherit',
                cursor: 'pointer',
                transition: 'all 0.15s',
                fontWeight: selected ? 600 : 400,
              }}
            >
              {chip.label}
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 24 }}>
        <button
          onClick={onSkipAll}
          style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline' }}
        >
          {t('onboarding.skipAll')}
        </button>
      </div>
    </StepLayout>
  )
}

// ── Step 2: About You ──────────────────────────────────────────────────────────

interface PersonaForm {
  name: string
  email: string
  phone: string
  location: string
  nationality: string
  visaStatus: string
  linkedin: string
  website: string
}

function Step2({ persona, onChange, onBack, onContinue, onSkip, t }: {
  persona: PersonaForm
  onChange: (field: keyof PersonaForm, value: string) => void
  onBack: () => void
  onContinue: () => void
  onSkip: () => void
  t: (k: string) => string
}) {
  const fields: { key: keyof PersonaForm; label: string; placeholder: string; required?: boolean; type?: string }[] = [
    { key: 'name',        label: 'Full Name',        placeholder: 'Jane Smith',                  required: true },
    { key: 'email',       label: 'Email',             placeholder: 'jane@example.com',            required: true, type: 'email' },
    { key: 'phone',       label: 'Phone',             placeholder: '+1 555 000 0000' },
    { key: 'location',    label: 'City / Country',    placeholder: 'Berlin, Germany' },
    { key: 'nationality', label: 'Nationality',       placeholder: 'German' },
    { key: 'visaStatus',  label: 'Visa / Work Status',placeholder: 'EU Citizen / Work Permit' },
    { key: 'linkedin',    label: 'LinkedIn URL',      placeholder: 'linkedin.com/in/janesmith' },
    { key: 'website',     label: 'Personal Site',     placeholder: 'https://janesmith.com' },
  ]

  return (
    <StepLayout
      step={2}
      title={t('onboarding.step2.title')}
      desc={t('onboarding.step2.desc')}
      onBack={onBack}
      onContinue={onContinue}
      onSkip={onSkip}
      disableContinue={!persona.name || !persona.email}
      t={t}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 20px', paddingTop: 8 }}>
        {fields.map(f => (
          <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <label style={{ fontSize: 11, color: 'var(--text-muted)', fontWeight: 500 }}>
              {f.label}{f.required && <span style={{ color: 'var(--c-danger)' }}> *</span>}
            </label>
            <input
              type={f.type ?? 'text'}
              value={persona[f.key]}
              onChange={e => onChange(f.key, e.target.value)}
              placeholder={f.placeholder}
              style={{
                padding: '8px 10px',
                borderRadius: 7,
                border: '0.5px solid var(--border)',
                background: 'var(--bg)',
                color: 'var(--text)',
                fontSize: 13,
                fontFamily: 'inherit',
                outline: 'none',
              }}
            />
          </div>
        ))}
      </div>
    </StepLayout>
  )
}

// ── Step 3: Directions ─────────────────────────────────────────────────────────

function Step3({ directions, onAdd, onRemove, onBack, onContinue, onSkip, t }: {
  directions: string[]
  onAdd: (name: string) => void
  onRemove: (name: string) => void
  onBack: () => void
  onContinue: () => void
  onSkip: () => void
  t: (k: string) => string
}) {
  const [input, setInput] = useState('')
  const [showIdeas, setShowIdeas] = useState(false)

  function addDirection(name: string) {
    const trimmed = name.trim()
    if (!trimmed || directions.includes(trimmed)) return
    onAdd(trimmed)
  }

  return (
    <StepLayout
      step={3}
      title={t('onboarding.step3.title')}
      desc={t('onboarding.step3.desc')}
      onBack={onBack}
      onContinue={onContinue}
      onSkip={onSkip}
      disableContinue={directions.length === 0}
      t={t}
    >
      {/* Input row */}
      <div style={{ display: 'flex', gap: 8, paddingTop: 8 }}>
        <input
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { addDirection(input); setInput('') } }}
          placeholder="e.g. Software Engineering"
          style={{
            flex: 1, padding: '8px 12px', borderRadius: 7,
            border: '0.5px solid var(--border)', background: 'var(--bg)',
            color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', outline: 'none',
          }}
        />
        <Btn variant="primary" small onClick={() => { addDirection(input); setInput('') }}>+ Add</Btn>
      </div>

      {/* Added directions */}
      {directions.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14 }}>
          {directions.map(d => (
            <div key={d} style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 999,
              background: 'rgba(79,70,229,0.08)', border: '1.5px solid var(--primary)',
              fontSize: 12, color: 'var(--primary)',
            }}>
              {d}
              <button onClick={() => onRemove(d)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--primary)', padding: 0, fontSize: 14, lineHeight: 1 }}>×</button>
            </div>
          ))}
        </div>
      )}

      {/* Need ideas? */}
      <div style={{ marginTop: 20 }}>
        <button
          onClick={() => setShowIdeas(v => !v)}
          style={{ fontSize: 12, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}
        >
          <span style={{ transform: showIdeas ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform 0.15s', display: 'inline-block' }}>▶</span>
          {t('onboarding.step3.needIdeas')}
        </button>
        {showIdeas && (
          <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {STARTER_GROUPS.map(grp => (
              <div key={grp.group}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.05em' }}>{grp.group}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {grp.items.map(item => {
                    const added = directions.includes(item)
                    return (
                      <button
                        key={item}
                        onClick={() => added ? onRemove(item) : addDirection(item)}
                        style={{
                          padding: '5px 12px', borderRadius: 999, fontSize: 12,
                          border: `0.5px solid ${added ? 'var(--primary)' : 'var(--border)'}`,
                          background: added ? 'rgba(79,70,229,0.08)' : 'var(--bg)',
                          color: added ? 'var(--primary)' : 'var(--text)',
                          cursor: 'pointer', fontFamily: 'inherit',
                        }}
                      >
                        {added ? '✓ ' : ''}{item}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </StepLayout>
  )
}

// ── Step 4: Resume(s) ──────────────────────────────────────────────────────────

function Step4({ directions, doneSet, onOpen, onBack, onContinue, onSkip, t }: {
  directions: string[]
  doneSet: Set<string>
  onOpen: (dirName: string) => void
  onBack: () => void
  onContinue: () => void
  onSkip: () => void
  t: (k: string) => string
}) {
  const rows = directions.length > 0 ? directions : ['General']

  return (
    <StepLayout
      step={4}
      title={t('onboarding.step4.title')}
      desc={t('onboarding.step4.desc')}
      onBack={onBack}
      onContinue={onContinue}
      onSkip={onSkip}
      disableContinue={doneSet.size === 0}
      t={t}
    >
      {doneSet.size === 0 && (
        <div style={{ fontSize: 10, color: 'var(--c-warning)', marginTop: 4, marginBottom: 4 }}>
          Upload at least one resume to continue, or click &quot;Skip&quot; to do this later.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 8 }}>
        {rows.map(dir => (
          <div key={dir} style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '12px 16px', borderRadius: 10,
            border: `0.5px solid ${doneSet.has(dir) ? 'var(--c-success)' : 'var(--border)'}`,
            background: doneSet.has(dir) ? 'rgba(59,109,17,0.04)' : 'var(--bg)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {doneSet.has(dir) && <span style={{ color: 'var(--c-success)', fontSize: 14 }}>✓</span>}
              <span style={{ fontSize: 13, fontWeight: 500 }}>{dir}</span>
            </div>
            {doneSet.has(dir) ? (
              <span style={{ fontSize: 11, color: 'var(--c-success)' }}>Resume added</span>
            ) : (
              <div style={{ display: 'flex', gap: 8 }}>
                <Btn small variant="primary" onClick={() => onOpen(dir)}>Upload / Paste</Btn>
              </div>
            )}
          </div>
        ))}
      </div>
    </StepLayout>
  )
}

// ── Step 5: Style + Connect ────────────────────────────────────────────────────

function Step5({ templateId, accentColor, fontFamily, onTemplate, onColor, onFont, onBack, onFinish, t }: {
  templateId: string
  accentColor: string
  fontFamily: string
  onTemplate: (id: string) => void
  onColor: (c: string) => void
  onFont: (f: string) => void
  onBack: () => void
  onFinish: () => void
  t: (k: string) => string
}) {
  const fonts = ['Inter', 'Georgia', 'Times New Roman', 'Arial', 'Helvetica']

  return (
    <StepLayout
      step={5}
      title={t('onboarding.step5.title')}
      desc={t('onboarding.step5.desc')}
      onBack={onBack}
      onContinue={onFinish}
      continueLabel={t('onboarding.step5.finish')}
      t={t}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 24, paddingTop: 8 }}>
        {/* Template picker */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Default Template</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
            {TEMPLATE_OPTIONS.map(tpl => (
              <button
                key={tpl.id}
                onClick={() => onTemplate(tpl.id)}
                style={{
                  padding: '20px 12px', borderRadius: 10, cursor: 'pointer',
                  border: `2px solid ${templateId === tpl.id ? accentColor : 'var(--border)'}`,
                  background: templateId === tpl.id ? `${accentColor}10` : 'var(--bg)',
                  fontFamily: 'inherit', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                  transition: 'all 0.15s',
                }}
              >
                <div style={{ width: 40, height: 52, borderRadius: 4, background: 'var(--bg-tertiary)', border: '0.5px solid var(--border)' }} />
                <span style={{ fontSize: 12, fontWeight: templateId === tpl.id ? 600 : 400, color: templateId === tpl.id ? accentColor : 'var(--text)' }}>{tpl.name}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Accent color */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Accent Color</div>
          <div style={{ display: 'flex', gap: 10 }}>
            {ACCENT_COLORS.map(c => (
              <button
                key={c}
                onClick={() => onColor(c)}
                style={{
                  width: 28, height: 28, borderRadius: '50%', background: c, cursor: 'pointer',
                  border: accentColor === c ? `3px solid ${c}` : '2px solid transparent',
                  outline: accentColor === c ? `2px solid ${c}` : 'none',
                  outlineOffset: 2, transition: 'all 0.15s',
                }}
              />
            ))}
          </div>
        </div>

        {/* Font */}
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: '0.05em' }}>Font Family</div>
          <select
            value={fontFamily}
            onChange={e => onFont(e.target.value)}
            style={{
              padding: '8px 12px', borderRadius: 7, border: '0.5px solid var(--border)',
              background: 'var(--bg)', color: 'var(--text)', fontSize: 13, fontFamily: 'inherit', cursor: 'pointer',
            }}
          >
            {fonts.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
        </div>

        {/* Connect cards */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          <div style={{ padding: 16, borderRadius: 10, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🧩</span>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Chrome Extension</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Auto-fill job apps as you browse</div>
            <a href="https://chrome.google.com/webstore" target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: 'var(--primary)', textDecoration: 'none' }}>Install →</a>
          </div>
          <div style={{ padding: 16, borderRadius: 10, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 18 }}>✉️</span>
            <div style={{ fontSize: 12, fontWeight: 600 }}>Connect Gmail</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Track replies and follow-ups</div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Available in Settings</span>
          </div>
          <div style={{ padding: 16, borderRadius: 10, border: '0.5px solid var(--border)', background: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ fontSize: 18 }}>🤖</span>
            <div style={{ fontSize: 12, fontWeight: 600 }}>AI Auto-Pilot</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>Let AI suggest and apply automatically</div>
            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Configure in Agent settings</span>
          </div>
        </div>
      </div>
    </StepLayout>
  )
}

// ── Main OnboardingFlow ────────────────────────────────────────────────────────

interface Props {
  onComplete: () => void
}

export function OnboardingFlow({ onComplete }: Props) {
  const { t } = useI18n()
  const toast = useToast()

  const [step, setStep]       = useState(1)
  const [saving, setSaving]   = useState(false)

  // Step 1
  const [goals, setGoals]     = useState<string[]>([])

  // Step 2
  const [persona, setPersona] = useState<{
    name: string; email: string; phone: string; location: string
    nationality: string; visaStatus: string; linkedin: string; website: string
  }>({ name: '', email: '', phone: '', location: '', nationality: '', visaStatus: '', linkedin: '', website: '' })

  // Step 3
  const [directions, setDirections]   = useState<string[]>([])

  // Step 4 — which directions have resumes
  const [resumeDoneSet, setResumeDoneSet] = useState<Set<string>>(new Set())
  const [intakeOpen, setIntakeOpen]       = useState(false)
  const [intakeDirName, setIntakeDirName] = useState<string | null>(null)
  // Fake directions list for ResumeIntakeDialog (it needs Direction[] objects)
  const [createdDirs, setCreatedDirs]     = useState<Direction[]>([])

  // Step 5
  const [templateId, setTemplateId]   = useState('clean')
  const [accentColor, setAccentColor] = useState('var(--primary)')
  const [fontFamily, setFontFamily]   = useState('Inter')

  // ── Helpers ────────────────────────────────────────────────────────────────

  async function saveStep(payload: Record<string, unknown>) {
    const { error } = await apiMutate('/api/me/onboarding', 'PATCH', payload)
    if (error) toast.error('Save failed', error)
  }

  async function ensureDirectionsCreated(names: string[]): Promise<Direction[]> {
    const created: Direction[] = []
    for (const name of names) {
      const existing = createdDirs.find(d => d.name === name)
      if (existing) { created.push(existing); continue }
      const { data, error } = await apiMutate<Direction>('/api/directions', 'POST', { name, color: null, icon: null })
      if (!error && data) {
        created.push(data)
      }
    }
    setCreatedDirs(prev => {
      const map = new Map(prev.map(d => [d.name, d]))
      for (const d of created) map.set(d.name, d)
      return Array.from(map.values())
    })
    return created
  }

  // ── Step handlers ──────────────────────────────────────────────────────────

  function toggleGoal(id: string) {
    setGoals(prev => prev.includes(id) ? prev.filter(g => g !== id) : [...prev, id])
  }

  async function handleStep1Continue() {
    setSaving(true)
    await saveStep({ step: 1, goals })
    setSaving(false)
    setStep(2)
  }

  async function handleStep2Continue() {
    setSaving(true)
    await saveStep({ step: 2, persona: { name: persona.name, email: persona.email, phone: persona.phone, location: persona.location, linkedin: persona.linkedin, github: persona.website } })
    setSaving(false)
    setStep(3)
  }

  async function handleStep3Continue() {
    setSaving(true)
    if (directions.length > 0) {
      await ensureDirectionsCreated(directions)
    }
    setSaving(false)
    setStep(4)
  }

  function handleStep4Continue() {
    setStep(5)
  }

  async function handleFinish() {
    setSaving(true)
    await saveStep({
      step: 5,
      defaultTemplateId: templateId,
      defaultAccentColor: accentColor,
      defaultFontFamily: fontFamily,
      complete: true,
    })
    setSaving(false)
    onComplete()
  }

  async function handleSkipAll() {
    setSaving(true)
    await saveStep({ complete: true })
    setSaving(false)
    onComplete()
  }

  function openIntake(dirName: string) {
    setIntakeDirName(dirName)
    setIntakeOpen(true)
  }

  function handleIntakeSaved() {
    if (intakeDirName) {
      setResumeDoneSet(prev => new Set([...prev, intakeDirName]))
    }
    setIntakeOpen(false)
    setIntakeDirName(null)
  }

  // Find direction id for intake dialog
  const intakeDir = intakeDirName ? createdDirs.find(d => d.name === intakeDirName) : null

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 400,
      background: 'var(--bg)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', maxWidth: 680, height: '100%', maxHeight: 680,
        display: 'flex', flexDirection: 'column',
        border: '0.5px solid var(--border)', borderRadius: 16,
        boxShadow: '0 8px 32px rgba(0,0,0,0.12)',
        background: 'var(--bg)', overflow: 'hidden',
      }}>
        {step === 1 && (
          <Step1
            goals={goals}
            onToggle={toggleGoal}
            onContinue={saving ? () => {} : handleStep1Continue}
            onSkipAll={saving ? () => {} : handleSkipAll}
            t={t}
          />
        )}
        {step === 2 && (
          <Step2
            persona={persona}
            onChange={(field, value) => setPersona(prev => ({ ...prev, [field]: value }))}
            onBack={() => setStep(1)}
            onContinue={saving ? () => {} : handleStep2Continue}
            onSkip={() => setStep(3)}
            t={t}
          />
        )}
        {step === 3 && (
          <Step3
            directions={directions}
            onAdd={name => setDirections(prev => [...prev, name])}
            onRemove={name => setDirections(prev => prev.filter(d => d !== name))}
            onBack={() => setStep(2)}
            onContinue={saving ? () => {} : handleStep3Continue}
            onSkip={() => setStep(4)}
            t={t}
          />
        )}
        {step === 4 && (
          <Step4
            directions={directions}
            doneSet={resumeDoneSet}
            onOpen={openIntake}
            onBack={() => setStep(3)}
            onContinue={handleStep4Continue}
            onSkip={() => setStep(5)}
            t={t}
          />
        )}
        {step === 5 && (
          <Step5
            templateId={templateId}
            accentColor={accentColor}
            fontFamily={fontFamily}
            onTemplate={setTemplateId}
            onColor={setAccentColor}
            onFont={setFontFamily}
            onBack={() => setStep(4)}
            onFinish={saving ? () => {} : handleFinish}
            t={t}
          />
        )}
      </div>

      {/* ResumeIntakeDialog for step 4 */}
      {intakeOpen && (
        <ResumeIntakeDialog
          onClose={() => { setIntakeOpen(false); setIntakeDirName(null) }}
          onSaved={handleIntakeSaved}
          directions={createdDirs}
          initialDirId={intakeDir?.id ?? null}
        />
      )}
    </div>
  )
}
