/**
 * PersonaView — User persona/profile management.
 * Shows learned answers from previous form fills, grouped by category.
 * Supports inline editing, deletion, and adding custom fields.
 */
import { useState, useEffect, useCallback } from 'react'
import {
  BriefcaseBusiness,
  Check,
  ContactRound,
  FileText,
  GraduationCap,
  LoaderCircle,
  Pencil,
  Plus,
  SlidersHorizontal,
  Trash2,
  UserRound,
  X,
} from 'lucide-react'
import { getPersona, getPersonaFields, savePersonaFields, deletePersonaField } from '@/lib/api'
import type { ExtensionSettings } from '@/lib/types'
import type { PersonaField } from '@/lib/api'
import type { PersonaProfile } from '@/lib/api'
import { useExtensionI18n } from '@/lib/i18n'

const CATEGORY_META: Record<string, { label: string }> = {
  personal:     { label: 'Personal info' },
  work:         { label: 'Work & career' },
  contact:      { label: 'Contact details' },
  education:    { label: 'Education' },
  preferences:  { label: 'Preferences' },
}

const CATEGORIES = ['personal', 'contact', 'work', 'education', 'preferences']
const PROFILE_GROUPS: Array<{ key: keyof PersonaProfile; label: string }> = [
  { key: 'identity', label: 'Identity & contact' }, { key: 'preferences', label: 'Job preferences' },
  { key: 'experience', label: 'Experience' }, { key: 'skills', label: 'Skills' },
  { key: 'languages', label: 'Languages' }, { key: 'education', label: 'Education' },
  { key: 'certifications', label: 'Certifications' }, { key: 'projects', label: 'Projects' },
]

interface Props {
  settings: ExtensionSettings
  /** When > 0, persona has been updated from outside — reload fields */
  personaUpdateTrigger: number
}

type ViewMode = 'view' | 'editing' | 'adding'

export function PersonaView({ settings, personaUpdateTrigger }: Props) {
  const { lang, t } = useExtensionI18n()
  const [fields, setFields] = useState<PersonaField[]>([])
  const [profile, setProfile] = useState<PersonaProfile | null>(null)
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<ViewMode>('view')
  const [newField, setNewField] = useState<Partial<PersonaField>>({})
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  const loadFields = useCallback(async () => {
    try {
      const [fieldsResult, personaResult] = await Promise.all([getPersonaFields(settings), getPersona(settings)])
      setFields(fieldsResult.fields)
      setProfile(personaResult.profile)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast(lang === 'zh' ? t('Load failed') : `${t('Load failed')}: ${msg}`)
    } finally { setLoading(false) }
  }, [lang, settings, t])

  useEffect(() => { loadFields() }, [loadFields, personaUpdateTrigger])

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2500) }

  async function handleSaveField(field: PersonaField) {
    setSaving(true)
    try {
      await savePersonaFields(settings, [field])
      await loadFields()
      setMode('view')
      showToast(t('Saved!'))
    } catch { showToast(t('Save failed')) }
    finally { setSaving(false) }
  }

  async function handleDelete(key: string) {
    try {
      await deletePersonaField(settings, key)
      await loadFields()
      showToast(t('Deleted'))
    } catch { showToast(t('Delete failed')) }
  }

  async function handleAddNew() {
    if (!newField.key || !newField.value) return
    setSaving(true)
    try {
      const field: PersonaField = {
        key:        newField.key.toLowerCase().replace(/[^a-z0-9_]/g, '_'),
        category:   newField.category || 'personal',
        label:      newField.label || newField.key,
        value:      newField.value,
        confidence: 1.0,
        source:     'manual',
        updatedAt:  new Date().toISOString(),
        consentAt:  new Date().toISOString(),
      }
      await savePersonaFields(settings, [field])
      await loadFields()
      setMode('view')
      setNewField({})
      showToast(t('Added!'))
    } catch { showToast(t('Add failed')) }
    finally { setSaving(false) }
  }

  const grouped = CATEGORIES
    .map(cat => ({ cat, items: fields.filter(f => f.category === cat) }))
    .filter(g => g.items.length > 0)

  if (loading) {
    return (
      <div className="am-profile-view">
        <div className="am-spinner am-profile-spinner"><LoaderCircle size={20} className="am-spin" aria-label={t('Loading profile')} /></div>
      </div>
    )
  }

  return (
    <div className="am-profile-view">
      <section className="am-profile-card am-profile-intro">
        <div className="am-profile-intro-icon"><UserRound size={17} aria-hidden="true" /></div>
        <div className="am-profile-intro-copy">
          <span className="am-profile-eyebrow">{t('Profile')}</span>
          <h1>{t('Persona profile')}</h1>
          <p>{t('Confirmed facts used to auto-fill future applications.')}</p>
        </div>
        <span className="am-profile-status"><Check size={11} aria-hidden="true" /> {t('Synced')}</span>
      </section>

      {profile && <section className="am-profile-card am-profile-summary">
        <div className="am-profile-card-head">
          <div>
            <span className="am-profile-eyebrow">{t('Knowledge base')}</span>
            <h2>{t('Unified profile')}</h2>
            <p>{profile.sourceResumeCount} {t(profile.sourceResumeCount === 1 ? 'base resume connected' : 'base resumes connected')}</p>
          </div>
          <span className="am-profile-card-icon"><FileText size={15} aria-hidden="true" /></span>
        </div>
        <div className="am-profile-summary-list">
          {PROFILE_GROUPS.map(group => {
            const values = profile[group.key]
            if (!Array.isArray(values) || values.length === 0) return null
            return <div key={group.key} className="am-profile-summary-group">
              <strong>{t(group.label)}</strong>
              {values.map((value, index) => <span key={`${value}-${index}`}>{value}</span>)}
            </div>
          })}
        </div>
      </section>}

      <div className="am-profile-section-label">
        <span>{t('Saved answers')}</span>
        {fields.length > 0 && <span className="am-profile-count">{fields.length}</span>}
      </div>

      {mode === 'adding' ? (
        <section className="am-profile-card am-profile-editor">
          <div className="am-profile-card-head">
            <div>
              <span className="am-profile-eyebrow">{t('Manual entry')}</span>
              <h2>{t('Add a field')}</h2>
            </div>
            <button className="am-profile-icon-button" type="button" onClick={() => { setMode('view'); setNewField({}) }} aria-label={t('Cancel adding field')} title={t('Cancel')}>
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="am-profile-form">
            <label className="am-profile-field"><span>{t('Key')}</span>
            <input
              value={newField.key ?? ''}
              onChange={e => setNewField(p => ({ ...p, key: e.target.value }))}
              placeholder={t('Key (e.g. linkedin_profile)')}
              className="am-profile-input"
            />
            </label>
            <label className="am-profile-field"><span>{t('Label')}</span>
            <input
              value={newField.label ?? ''}
              onChange={e => setNewField(p => ({ ...p, label: e.target.value }))}
              placeholder={t('Label (e.g. LinkedIn Profile URL)')}
              className="am-profile-input"
            />
            </label>
            <label className="am-profile-field"><span>{t('Answer')}</span>
            <input
              value={newField.value ?? ''}
              onChange={e => setNewField(p => ({ ...p, value: e.target.value }))}
              placeholder={t('Value (the answer)')}
              className="am-profile-input"
            />
            </label>
            <label className="am-profile-field"><span>{t('Category')}</span>
            <select
              value={newField.category ?? 'personal'}
              onChange={e => setNewField(p => ({ ...p, category: e.target.value }))}
              className="am-profile-input"
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{t(CATEGORY_META[c]?.label ?? c)}</option>
              ))}
            </select>
            </label>
            <div className="am-profile-actions">
              <button className="am-profile-button primary" type="button" onClick={handleAddNew} disabled={saving}>
                <Check size={13} aria-hidden="true" /> {saving ? t('Saving…') : t('Save field')}
              </button>
              <button className="am-profile-button ghost" type="button" onClick={() => { setMode('view'); setNewField({}) }}>
                {t('Cancel')}
              </button>
            </div>
          </div>
        </section>
      ) : (
        <button
          type="button"
          onClick={() => setMode('adding')}
          className="am-profile-add-button"
        >
          <Plus size={14} aria-hidden="true" /> {t('Add new field')}
        </button>
      )}

      {/* Empty State */}
      {!loading && fields.length === 0 && (
        <div className="am-profile-empty">
          <div className="am-profile-empty-icon"><ContactRound size={18} aria-hidden="true" /></div>
          <div className="am-profile-empty-title">
            {t('No persona fields yet')}
          </div>
          <div className="am-profile-empty-copy">
            {t('After filling a form, you can save your answers here.')}<br/>
            {t("They'll be used to auto-fill future applications.")}
          </div>
        </div>
      )}

      {/* Field Groups */}
      {grouped.map(group => {
        const meta = CATEGORY_META[group.cat] ?? { label: group.cat }
        return (
          <section key={group.cat} className="am-profile-field-group">
            <div className="am-profile-group-heading">
              <span className="am-profile-group-icon"><CategoryIcon category={group.cat} /></span>
              <span>{t(meta.label)}</span>
              <span className="am-profile-group-count">{group.items.length}</span>
            </div>
            {group.items.map(field => (
              <PersonaFieldCard
                key={field.key}
                field={field}
                onSave={handleSaveField}
                onDelete={handleDelete}
                saving={saving}
              />
            ))}
          </section>
        )
      })}

      {/* Toast */}
      {toast && (
        <div className="am-toast">{toast}</div>
      )}
    </div>
  )
}

// ── PersonaFieldCard ─────────────────────────────────────────────

function PersonaFieldCard({ field, onSave, onDelete, saving }: {
  field: PersonaField
  onSave: (f: PersonaField) => void
  onDelete: (key: string) => void
  saving: boolean
}) {
  const { t } = useExtensionI18n()
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(field.value)
  const [label, setLabel] = useState(field.label)

  return (
    <div className={`am-profile-field-card${editing ? ' is-editing' : ''}`}>
      {editing ? (
        <>
          <label className="am-profile-field"><span>{t('Label')}</span><input value={label} onChange={e => setLabel(e.target.value)} className="am-profile-input" /></label>
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            rows={2}
            className="am-profile-input am-profile-textarea"
            aria-label={`${t('Answer for')} ${label}`}
          />
          <div className="am-profile-actions">
            <button className="am-profile-button primary" type="button" onClick={() => {
              onSave({ ...field, value, label, updatedAt: new Date().toISOString() })
              setEditing(false)
            }} disabled={saving}>
              <Check size={13} aria-hidden="true" /> {saving ? t('Saving…') : t('Save')}
            </button>
            <button className="am-profile-button ghost" type="button" onClick={() => { setEditing(false); setValue(field.value); setLabel(field.label) }}>
              {t('Cancel')}
            </button>
          </div>
        </>
      ) : (
        <div className="am-profile-field-row">
          <div className="am-profile-field-copy">
            <div className="am-profile-field-label">{field.label}</div>
            <div className="am-profile-field-value">
              {field.value}
            </div>
          </div>
          <div className="am-profile-field-actions">
            <button className="am-profile-icon-button" type="button" onClick={() => setEditing(true)} aria-label={`${t('Edit')} ${field.label}`} title={t('Edit')}>
              <Pencil size={13} aria-hidden="true" />
            </button>
            <button className="am-profile-icon-button danger" type="button" onClick={() => onDelete(field.key)} aria-label={`${t('Delete')} ${field.label}`} title={t('Delete')}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function CategoryIcon({ category }: { category: string }) {
  const Icon = {
    personal: UserRound,
    contact: ContactRound,
    work: BriefcaseBusiness,
    education: GraduationCap,
    preferences: SlidersHorizontal,
  }[category] ?? UserRound
  return <Icon size={13} aria-hidden="true" />
}
