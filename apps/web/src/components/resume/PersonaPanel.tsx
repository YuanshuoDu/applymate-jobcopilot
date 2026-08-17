'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react'
import type { PersonaField, PersonaProfile } from '@/lib/persona'
import { useI18n } from '@/lib/i18n'

const categories = ['personal', 'contact', 'work', 'education', 'preferences'] as const
export function PersonaPanel({ isDefault, onEditResume, onUseAsProfile }: { isDefault: boolean; onEditResume: (section: string) => void; onUseAsProfile: () => void }) {
  const { t } = useI18n()
  const [profile, setProfile] = useState<PersonaProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [draft, setDraft] = useState<Partial<PersonaField> | null>(null)
  const [error, setError] = useState('')
  const [indexing, setIndexing] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    const response = await fetch('/api/me/persona')
    const payload = await response.json().catch(() => null)
    if (response.ok) setProfile(payload?.profile ?? null)
    else setError(payload?.error ?? t('persona.loadFailed'))
    setLoading(false)
  }, [])
  useEffect(() => { void load() }, [load])

  const groups = useMemo(() => categories.map(category => ({ category, fields: (profile?.applicationAnswers ?? []).filter(field => field.category === category) })), [profile])

  async function save() {
    if (!draft?.key || !draft.label || !draft.value) { setError(t('persona.requiredFields')); return }
    const field: PersonaField = {
      key: draft.key.toLowerCase().trim().replace(/[^a-z0-9_]/g, '_'), label: draft.label.trim(), value: draft.value.trim(),
      category: draft.category ?? 'personal', confidence: 1, source: 'manual', updatedAt: new Date().toISOString(), consentAt: new Date().toISOString(),
    }
    const response = await fetch('/api/me/persona/fields', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fields: [field] }) })
    const payload = await response.json().catch(() => null)
    if (!response.ok) { setError(payload?.error ?? t('persona.saveFailed')); return }
    setDraft(null); setError(''); await load()
  }

  async function remove(key: string) {
    const response = await fetch('/api/me/persona/fields', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key }) })
    if (response.ok) await load()
    else setError(t('persona.deleteFailed'))
  }

  async function download() {
    const response = await fetch('/api/me/persona/export')
    if (!response.ok) { setError(t('persona.exportFailed')); return }
    const blob = new Blob([JSON.stringify(await response.json(), null, 2)], { type: 'application/json' })
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'applymate-persona-export.json'; link.click(); URL.revokeObjectURL(link.href)
  }

  async function buildKnowledgeIndex() {
    setIndexing(true); setError('')
    const response = await fetch('/api/me/persona/knowledge-index', { method: 'POST' })
    if (!response.ok) setError(t('persona.indexFailed'))
    else {
      const payload = await response.json().catch(() => null)
      setError(payload?.semanticEnabled ? t('persona.semanticReady') : t('persona.lexicalReady'))
    }
    setIndexing(false)
  }

  return <div style={{ padding: 14, overflowY: 'auto', height: '100%', boxSizing: 'border-box' }}>
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'start', marginBottom: 12 }}>
      <div><div style={{ fontWeight: 700, fontSize: 15 }}>{t('persona.title')}</div><div style={{ color: 'var(--text-muted)', fontSize: 11, lineHeight: 1.45, marginTop: 3 }}>{t('persona.description')}</div></div>
      <button onClick={() => void download()} title={t('persona.download')} style={iconButton}><Download size={15} /></button>
    </div>

    <div style={privacyStyle}><ShieldCheck size={16} /><span><strong>{t('persona.controlled')}</strong> {t('persona.privacy')}</span></div>
    <button onClick={() => void buildKnowledgeIndex()} disabled={indexing} style={indexButton}>{indexing ? t('persona.indexing') : t('persona.buildIndex')}</button>
    <div style={{ fontSize: 10, color: 'var(--text-muted)', lineHeight: 1.4, margin: '-7px 0 12px' }}>{t('persona.indexDescription')}</div>
    {isDefault ? <div style={sharedProfileStyle}>{t('persona.sharedDefault')}</div> : <div style={sharedProfileStyle}>{t('persona.usingDefault')} <button onClick={onUseAsProfile} style={profileButton}>{t('persona.useAsBase')}</button></div>}

    <PanelTitle title={`${t('persona.confirmedFacts')} · ${profile?.sourceResumeCount ?? 0} ${t(profile?.sourceResumeCount === 1 ? 'persona.baseResume' : 'persona.baseResumes')}`} />
    <ResumeDetailCard title={t('persona.identityContact')} details={profile?.identity ?? []} onEdit={() => onEditResume('contact')} t={t} />
    <ResumeDetailCard title={t('persona.jobPreferences')} details={profile?.preferences ?? []} onEdit={() => onEditResume('summary')} t={t} />
    <ResumeDetailCard title={t('persona.professionalSummary')} details={profile?.summaries ?? []} onEdit={() => onEditResume('summary')} t={t} />
    <ResumeDetailCard title={t('persona.experience')} details={profile?.experience ?? []} onEdit={() => onEditResume('experience')} t={t} />
    <ResumeDetailCard title={t('persona.skillsLanguages')} details={[...(profile?.skills ?? []), ...(profile?.languages ?? [])]} onEdit={() => onEditResume('skills')} t={t} />
    <ResumeDetailCard title={t('persona.educationQualifications')} details={[...(profile?.education ?? []), ...(profile?.certifications ?? [])]} onEdit={() => onEditResume('education')} t={t} />
    <ResumeDetailCard title={t('persona.projects')} details={profile?.projects ?? []} onEdit={() => onEditResume('projects')} t={t} />

    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: 18 }}><PanelTitle title={t('persona.savedAnswers')} /><button onClick={() => { setDraft({ category: 'personal' }); setError('') }} style={addButton}><Plus size={13} /> {t('persona.add')}</button></div>
    {draft && <div style={editorStyle}>
      <input value={draft.label ?? ''} onChange={event => setDraft(value => ({ ...value, label: event.target.value, key: value?.key || event.target.value }))} placeholder={t('persona.questionLabel')} style={inputStyle} />
      <textarea value={draft.value ?? ''} onChange={event => setDraft(value => ({ ...value, value: event.target.value }))} placeholder={t('persona.answer')} rows={2} style={inputStyle} />
      <select value={draft.category ?? 'personal'} onChange={event => setDraft(value => ({ ...value, category: event.target.value }))} style={inputStyle}>{categories.map(category => <option key={category} value={category}>{t(`persona.category.${category}`)}</option>)}</select>
      <div style={{ display: 'flex', gap: 6 }}><button onClick={() => void save()} style={saveButton}>{t('persona.save')}</button><button onClick={() => setDraft(null)} style={cancelButton}>{t('common.cancel')}</button></div>
    </div>}
    {loading ? <div style={{ color: 'var(--text-muted)', fontSize: 12 }}>{t('persona.loading')}</div> : groups.map(group => group.fields.length > 0 && <section key={group.category} style={{ marginTop: 12 }}><PanelTitle title={t(`persona.category.${group.category}`)} />{group.fields.map(field => <div key={field.key} style={fieldStyle}><div><strong>{field.label}</strong><small>{field.value}</small><em>{field.source === 'form_scan' ? t('persona.savedFromApplication') : t('persona.addedByYou')}</em></div><button onClick={() => void remove(field.key)} title={`${t('persona.delete')} ${field.label}`} style={iconButton}><Trash2 size={14} /></button></div>)}</section>)}
    {!loading && (profile?.applicationAnswers.length ?? 0) === 0 && !draft && <div style={{ color: 'var(--text-muted)', fontSize: 12, lineHeight: 1.5, padding: '10px 0' }}>{t('persona.emptyAnswers')}</div>}
    {error && <div role="alert" style={{ color: '#b42318', fontSize: 11, marginTop: 10 }}>{error}</div>}
  </div>
}

function PanelTitle({ title }: { title: string }) { return <div style={{ fontSize: 10, color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '.06em', textTransform: 'uppercase', margin: '10px 0 6px' }}>{title}</div> }
function ResumeDetailCard({ title, details, onEdit, t }: { title: string; details: string[]; onEdit: () => void; t: (key: string) => string }) {
  return <div style={resumeDetailStyle}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong>{title}</strong><button onClick={onEdit} title={`${t('persona.edit')} ${title}`} style={iconButton}><Pencil size={13} /></button></div>{details.length ? <div style={{ display: 'grid', gap: 3, marginTop: 5 }}>{details.map((detail, index) => <small key={`${detail}-${index}`} style={{ lineHeight: 1.4 }}>{detail}</small>)}</div> : <small style={{ display: 'block', marginTop: 4 }}>{t('persona.noDetails')}</small>}</div>
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
const indexButton = { width: '100%', border: '1px solid var(--primary)', borderRadius: 6, background: 'transparent', color: 'var(--primary)', padding: '7px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 700, marginBottom: 9 }
