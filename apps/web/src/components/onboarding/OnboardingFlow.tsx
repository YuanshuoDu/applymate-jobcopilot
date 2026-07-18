'use client'
import React, { useState } from 'react'
import {
  BriefcaseBusiness, Check, FileText, Globe2, GraduationCap, Rocket,
  Settings2, Sparkles, Target, UserRound, WandSparkles,
} from 'lucide-react'
import { Btn, useToast } from '@/components/ui'
import { apiMutate } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import type { Direction } from '@/lib/types'
import { ResumeIntakeDialog } from '@/components/resume/ResumeIntakeDialog'
import './OnboardingFlow.css'

// ── Constants ──────────────────────────────────────────────────────────────────

const GOAL_CHIPS = [
  { id: 'abroad', label: 'International job search', description: 'Find work in a new country.', icon: Globe2 },
  { id: 'grad',   label: 'New graduate', description: 'Start your first role with confidence.', icon: GraduationCap },
  { id: 'switch', label: 'Career change', description: 'Move into a new field or industry.', icon: WandSparkles },
  { id: 'intern', label: 'Internship', description: 'Discover hands-on early-career roles.', icon: BriefcaseBusiness },
]

const STEPS = [
  { label: 'Your goal', detail: 'Why you’re here', icon: Target },
  { label: 'About you', detail: 'Your background', icon: UserRound },
  { label: 'Preferences', detail: 'Roles and locations', icon: Sparkles },
  { label: 'Your resume', detail: 'Ready to tailor', icon: FileText },
  { label: 'Launch', detail: 'Review and start', icon: Rocket },
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
    <div className="onboarding-layout">
      <aside className="onboarding-rail" aria-label="Onboarding progress">
        <div className="onboarding-wordmark"><Sparkles size={21} /> ApplyMate <b>AI</b></div>
        <div className="onboarding-steps">
          {STEPS.map((item, index) => {
            const Icon = item.icon
            const active = index + 1 === step
            const complete = index + 1 < step
            return <div className={`onboarding-rail-step ${active ? 'is-active' : ''} ${complete ? 'is-complete' : ''}`} key={item.label}>
              <div className="onboarding-step-dot">{complete ? <Check size={14} /> : index + 1}</div>
              <div><strong>{item.label}</strong><span>{item.detail}</span></div>
              {active && <Icon size={16} />}
            </div>
          })}
        </div>
        <div className="onboarding-rail-note"><Sparkles size={18} /><p>We’ll personalise your search, save time, and improve each match.</p></div>
      </aside>

      <section className="onboarding-main">
        <div className="onboarding-progress"><div className="onboarding-progress-dots">{Array.from({ length: TOTAL_STEPS }, (_, i) => <i className={i < step ? 'done' : ''} key={i} />)}</div><span>Step {step} of {TOTAL_STEPS}</span></div>
        <header className="onboarding-heading"><h2>{title}</h2><p>{desc}</p></header>
        <div className="onboarding-content">{children}</div>
        <footer className="onboarding-footer">
          {onBack ? <Btn variant="ghost" onClick={onBack}>Back</Btn> : <span />}
          <div>{onSkip && <button className="onboarding-skip" onClick={onSkip}>Skip for now</button>}<Btn variant="primary" onClick={onContinue} disabled={disableContinue}>{continueLabel ?? 'Continue'}</Btn></div>
        </footer>
      </section>

      <aside className="onboarding-plan">
        <div className="onboarding-plan-label">YOUR LAUNCH PLAN <span>Preview</span></div>
        {STEPS.slice(0, 4).map((item, index) => {
          const Icon = item.icon
          const complete = index + 1 < step
          const active = index + 1 === step
          return <div className={`onboarding-plan-item ${active ? 'is-active' : ''}`} key={item.label}>
            <div className="onboarding-plan-icon"><Icon size={22} /></div>
            <div><strong>{item.label}</strong><p>{complete ? 'Ready to power better matches.' : active ? 'We’re setting this up now.' : 'Unlock this in the next step.'}</p></div>
            {complete && <Check size={18} className="onboarding-check" />}
          </div>
        })}
        <div className="onboarding-dashboard-preview"><span>WHAT YOU’LL UNLOCK</span><strong>Personalised job matches</strong><p>AI will identify the best roles and prepare your applications.</p><div><i /><i /><i /><i /></div></div>
      </aside>
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
      title="What brings you here?"
      desc="We’ll build a job-search launch plan around your goals. You can change this any time."
      onContinue={onContinue}
      onSkip={onSkipAll}
      t={t}
    >
      <div className="onboarding-goal-grid">
        {GOAL_CHIPS.map(chip => {
          const selected = goals.includes(chip.id)
          const Icon = chip.icon
          return (
            <button
              key={chip.id}
              onClick={() => onToggle(chip.id)}
              className={`onboarding-goal-card ${selected ? 'is-selected' : ''}`}
            >
              <Icon size={26} strokeWidth={1.7} /><strong>{chip.label}</strong><span>{chip.description}</span>{selected && <Check size={17} className="onboarding-goal-check" />}
            </button>
          )
        })}
      </div>
      <button className="onboarding-skip-all" onClick={onSkipAll}>I’ll set this up later</button>
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
      title="Let’s get the basics right"
      desc="This information lets ApplyMate tailor your materials and spot the right opportunities."
      onBack={onBack}
      onContinue={onContinue}
      onSkip={onSkip}
      disableContinue={!persona.name || !persona.email}
      t={t}
    >
      <div className="onboarding-profile-note"><UserRound size={18} />The basics help us tailor every job, resume, and application. You can refine these later.</div>
      <div className="onboarding-profile-grid">
        {fields.map(f => (
          <div key={f.key} className="onboarding-field">
            <label>
              {f.label}{f.required && <span style={{ color: 'var(--c-danger)' }}> *</span>}
            </label>
            <input
              type={f.type ?? 'text'}
              value={persona[f.key]}
              onChange={e => onChange(f.key, e.target.value)}
              placeholder={f.placeholder}
              className="onboarding-input"
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
      title="Choose your target directions"
      desc="Add the roles or career paths you want ApplyMate to prioritise."
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
      title="Add a resume to tailor"
      desc="We’ll extract your strongest experience and adapt it to every high-match role."
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
      title="You’re ready to launch"
      desc="Choose a default presentation style, connect your tools, and start your job search."
      onBack={onBack}
      onContinue={onFinish}
      continueLabel="Start exploring jobs"
      t={t}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20, paddingTop: 8 }}>
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
        <div className="onboarding-connect-grid">
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
      background: 'var(--bg-mesh)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 28,
    }}>
      <div style={{
        width: '100%', maxWidth: 1360, height: '100%', maxHeight: 840,
        display: 'flex', flexDirection: 'column', minHeight: 0,
        border: '1px solid rgba(99,102,241,0.16)', borderRadius: 22,
        boxShadow: '0 22px 60px rgba(57,50,135,0.18)',
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
