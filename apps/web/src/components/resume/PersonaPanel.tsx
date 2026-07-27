'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type { ResumeContent } from '@/lib/types'
import type { PersonaField } from '@/lib/persona'

const categories = ['personal', 'contact', 'work', 'education', 'preferences'] as const
const labels: Record<(typeof categories)[number], string> = {
  personal: 'Personal information', contact: 'Contact details', work: 'Work & career',
  education: 'Education & qualifications', preferences: 'Job preferences',
}

export function PersonaPanel({ content, isDefault, onEditResume, onUseAsProfile }: { content: ResumeContent; isDefault: boolean; onEditResume: (section: string) => void; onUseAsProfile: () => void }) {
  const [fields, setFields] = useState<PersonaField[]>([])
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Partial<PersonaField> | null>(null)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const response = await fetch('/api/me/persona/fields')
    const payload = await response.json().catch(() => null)
    if (response.ok) setFields(payload?.fields ?? [])
    else setError(payload?.error ?? 'Could not load Persona.')
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => categories.map(category => ({ category, fields: fields.filter(field => field.category === category) })), [fields])
  const contactDetails = [content.contact.name, content.contact.email, content.contact.phone, content.contact.location, content.contact.linkedin, content.contact.github, content.contact.website].filter((value): value is string => Boolean(value))

  async function save() {
    if (!draft?.key || !draft.label || !draft.value) { setError('Add a label and value before saving.'); return }
    const field: PersonaField = {
      key: draft.key.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_'), label: draft.label.trim(), value: draft.value.trim(),
      category: draft.category ?? 'personal', confidence: 1, source: 'manual', updatedAt: new Date().toISOString(), consentAt: new Date().toISOString(),
    }
    const response = await fetch('/api/me/persona/fields', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: [field] }) })
    const payload = await response.json().catch(() => null)
    if (!response.ok) { setError(payload?.error ?? 'Could not save Persona field.'); return }
    setFields(payload.fields ?? [])
    setDraft(null); setError('')
  }

  async function remove(key: string) {
    const response = await fetch('/api/me/persona/fields', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    if (response.ok) setFields(current => current.filter(field => field.key !== key))
    else setError('Could not delete Persona field.')
  }

  async function download() {
    const response = await fetch('/api/me/persona/export')
    if (!response.ok) { setError('Could not export Persona data.'); return }
    const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' })
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'applymate-persona-export.json'; link.click(); URL.revokeObjectURL(link.href)
  }

  return <div style={{ padding: 14, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'start', marginBottom: 12 }}>
      <div><div style={{ fontWeight: 700, fontSize: 15 }}>Persona</div><div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45, marginTop: 3 }}>Your reusable application profile, shared with the extension.</div></div>
      <button onClick={() => void download()} title="Download my Persona data" style={iconButton}><Download size={15} /></button>
    </div>

    <div style={privacyStyle}><ShieldCheck size={16} /><span><strong>You stay in control.</strong> Resume facts are read in place; application answers are saved only after you confirm. Sensitive data is not stored here.</span></div>
    {isDefault ? <div style={sharedProfileStyle}>This is your shared profile resume. The extension uses it for future application forms.</div> : <div style={sharedProfileStyle}>The extension currently uses your default resume. <button onClick={onUseAsProfile} style={profileButton}>Use this resume as the shared Persona base</button></div>}

    <PanelTitle title="From this resume" />
    <ResumeDetailCard title="Contact" details={contactDetails} onEdit={() => onEditResume('contact')} />
    <ResumeDetailCard title="Professional summary" details={content.summary ? [content.summary] : []} onEdit={() => onEditResume('summary')} />
    <ResumeDetailCard title="Experience" details={content.experience.flatMap(item => [`${item.role} · ${item.company}${item.period ? ` (${item.period})` : ''}`, ...item.bullets.map(bullet => `↳ ${bullet}`)])} onEdit={() => onEditResume('experience')} />
    <ResumeDetailCard title="Skills & languages" details={[...content.skills, ...(content.languages ?? []).map(language => `${language.lang} · ${language.level}`)]} onEdit={() => onEditResume('skills')} />
    <ResumeDetailCard title="Education & qualifications" details={[...content.education.map(item => `${item.degree} · ${item.institution}${item.year ? ` (${item.year})` : ''}`), ...(content.certifications ?? []).map(item => `${item.name} · ${item.issuer}${item.date ? ` (${item.date})` : ''}`)]} onEdit={() => onEditResume('education')} />
    <ResumeDetailCard title="Projects" details={(content.projects ?? []).flatMap(item => [`${item.name}${item.role ? ` · ${item.role}` : ''}`, ...item.bullets.map(bullet => `↳ ${bullet}`)])} onEdit={() => onEditResume('projects')} />

    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}><PanelTitle title="Saved application answers" /><button onClick={() => { setDraft({ category: 'personal' }); setError('') }} style={addButton}><Plus size={13} /> Add</button></div>
    {draft && <div style={editorStyle}>
      <input value={draft.label ?? ''} onChange={event => setDraft(value => ({ ...value, label: event.target.value, key: value?.key || event.target.value }))} placeholder="Question / label" style={inputStyle} />
      <textarea value={draft.value ?? ''} onChange={event => setDraft(value => ({ ...value, value: event.target.value }))} placeholder="Your answer" rows={2} style={inputStyle} />
      <select value={draft.category ?? 'personal'} onChange={event => setDraft(value => ({ ...value, category: event.target.value }))} style={inputStyle}>{categories.map(category => <option key={category} value={category}>{labels[category]}</option>)}</select>
      <div style={{ display: 'flex', gap: 6 }}><button onClick={() => void save()} style={saveButton}>Save to Persona</button><button onClick={() => setDraft(null)} style={cancelButton}>Cancel</button></div>
    </div>}
    {loading ? <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>Loading Persona…</div> : groups.map(group => group.fields.length > 0 && <section key={group.category} style={{ marginTop: 12 }}><PanelTitle title={labels[group.category]} />{group.fields.map(field => <div key={field.key} style={fieldStyle}><div><strong>{field.label}</strong><small>{field.value}</small><em>{field.source === 'form_scan' ? 'Saved from an application' : 'Added by you'}</em></div><button onClick={() => void remove(field.key)} title={`Delete ${field.label}`} style={iconButton}><Trash2 size={14} /></button></div>)}</section>)}
    {!loading && fields.length === 0 && !draft && <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, padding: '10px 0' }}>Add answers that you want to reuse across applications, such as work authorisation or notice period.</div>}
    {error && <div role="alert" style={{ color: '#b42318', fontSize: 11, marginTop: 10 }}>{error}</div>}
  </div>
}

function PanelTitle({ title }: { title: string }) { return <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', margin: '10px 0 6px' }}>{title}</div> }
function ResumeDetailCard({ title, details, onEdit }: { title: string; details: string[]; onEdit: () => void }) {
  return <div style={resumeDetailStyle}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{title}</strong><button onClick={onEdit} title={`Edit ${title}`} style={iconButton}><Pencil size={13} /></button></div>{details.length ? <div style={{ display: 'grid', gap: 3, marginTop: 5 }}>{details.map((detail, index) => <small key={`${detail}-${index}`} style={{ lineHeight: 1.4 }}>{detail}</small>)}</div> : <small style={{ display: 'block', marginTop: 4 }}>No details added yet</small>}</div>
}
const iconButton = { border: 'none', background: 'transparent', color: 'var(--text-muted)', padding: 4, cursor: 'pointer' }
const inputStyle = { width: '100%', boxSizing: 'border-box' as const, padding: '7px 8px', border: '1px solid var(--border)', borderRadius: 6, font: 'inherit', fontSize: 12, background: 'var(--bg)' }
const privacyStyle = { display: 'flex', gap: 7, padding: '9px 10px', borderRadius: 8, fontSize: 11, lineHeight: 1.45, background: 'rgba(16, 185, 129, .08)', color: 'var(--text)', marginBottom: 12 }
const sharedProfileStyle = { padding: '8px 10px', borderRadius: 8, fontSize: 11, lineHeight: 1.45, background: 'rgba(79, 70, 229, .07)', color: 'var(--text)', marginBottom: 12 }
const profileButton = { display: 'block', border: 'none', background: 'transparent', color: 'var(--primary)', padding: 0, marginTop: 4, font: 'inherit', fontWeight: 700, cursor: 'pointer', textAlign: 'left' as const }
const resumeDetailStyle = { padding: '8px 9px', marginBottom: 5, border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', color: 'var(--text)' }
const fieldStyle = { display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 6, padding: '8px 9px', border: '1px solid var(--border)', borderRadius: 7, background: 'var(--bg)', marginBottom: 5 }
const editorStyle = { padding: 9, border: '1px solid rgba(79,70,229,.3)', borderRadius: 8, display: 'grid', gap: 7, background: 'var(--bg)' }
const addButton = { display: 'inline-flex', alignItems: 'center', gap: 3, border: 'none', background: 'transparent', color: 'var(--primary)', cursor: 'pointer', fontSize: 11, fontWeight: 600 }
const saveButton = { border: 'none', borderRadius: 6, background: 'var(--primary)', color: '#fff', padding: '6px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 600 }
const cancelButton = { border: '1px solid var(--border)', borderRadius: 6, background: 'transparent', color: 'var(--text-muted)', padding: '6px 9px', cursor: 'pointer', fontSize: 11 }
