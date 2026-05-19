/**
 * PersonaView — User persona/profile management.
 * Shows learned answers from previous form fills, grouped by category.
 * Supports inline editing, deletion, and adding custom fields.
 */
import { useState, useEffect, useCallback } from 'react'
import { getPersonaFields, savePersonaFields, deletePersonaField } from '@/lib/api'
import type { ExtensionSettings } from '@/lib/types'
import type { PersonaField } from '@/lib/api'

const C = {
  primary:  '#185FA5',
  green:    '#3B6D11',
  red:      '#A32D2D',
  amber:    '#854F0B',
  bg:       '#f0f4f8',
  card:     '#ffffff',
  border:   '#e2e8f0',
  text:     '#0f172a',
  muted:    '#64748b',
  subtle:   '#94a3b8',
}

const CATEGORY_META: Record<string, { icon: string; label: string }> = {
  personal:     { icon: '👤', label: 'Personal Info' },
  work:         { icon: '💼', label: 'Work & Career' },
  contact:      { icon: '📋', label: 'Contact Details' },
  education:    { icon: '🎓', label: 'Education' },
  preferences:  { icon: '⚙️', label: 'Preferences' },
}

const CATEGORIES = ['personal', 'contact', 'work', 'education', 'preferences']

interface Props {
  settings: ExtensionSettings
  /** When > 0, persona has been updated from outside — reload fields */
  personaUpdateTrigger: number
}

type ViewMode = 'view' | 'editing' | 'adding'

export function PersonaView({ settings, personaUpdateTrigger }: Props) {
  const [fields, setFields] = useState<PersonaField[]>([])
  const [loading, setLoading] = useState(true)
  const [mode, setMode] = useState<ViewMode>('view')
  const [editingField, setEditingField] = useState<PersonaField | null>(null)
  const [newField, setNewField] = useState<Partial<PersonaField>>({})
  const [saving, setSaving] = useState(false)
  const [toast, setToast] = useState('')

  const loadFields = useCallback(async () => {
    try {
      const result = await getPersonaFields(settings)
      setFields(result.fields)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      showToast(`Load failed: ${msg}`)
    } finally { setLoading(false) }
  }, [settings])

  useEffect(() => { loadFields() }, [loadFields, personaUpdateTrigger])

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(''), 2500) }

  async function handleSaveField(field: PersonaField) {
    setSaving(true)
    try {
      await savePersonaFields(settings, [field])
      await loadFields()
      setMode('view')
      showToast('Saved!')
    } catch { showToast('Save failed') }
    finally { setSaving(false) }
  }

  async function handleDelete(key: string) {
    try {
      await deletePersonaField(settings, key)
      await loadFields()
      showToast('Deleted')
    } catch { showToast('Delete failed') }
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
      }
      await savePersonaFields(settings, [field])
      await loadFields()
      setMode('view')
      setNewField({})
      showToast('Added!')
    } catch { showToast('Add failed') }
    finally { setSaving(false) }
  }

  const grouped = CATEGORIES
    .map(cat => ({ cat, items: fields.filter(f => f.category === cat) }))
    .filter(g => g.items.length > 0)

  if (loading) return <Spinner />

  return (
    <div style={{ padding: '16px', paddingBottom: 80, fontFamily: 'inherit' }}>
      {/* Header */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 2 }}>
          Persona Profile
        </div>
        <div style={{ fontSize: 11, color: C.muted }}>
          Answers learned from your job applications. Used to auto-fill future forms.
        </div>
      </div>

      {/* Add New Field */}
      {mode === 'adding' ? (
        <div style={{
          background: C.card, border: `1px solid ${C.primary}30`, borderRadius: 10,
          padding: 12, marginBottom: 12,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: C.text, marginBottom: 8 }}>Add New Field</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              value={newField.key ?? ''}
              onChange={e => setNewField(p => ({ ...p, key: e.target.value }))}
              placeholder="Key (e.g. linkedin_profile)"
              style={inputStyle}
            />
            <input
              value={newField.label ?? ''}
              onChange={e => setNewField(p => ({ ...p, label: e.target.value }))}
              placeholder="Label (e.g. LinkedIn Profile URL)"
              style={inputStyle}
            />
            <input
              value={newField.value ?? ''}
              onChange={e => setNewField(p => ({ ...p, value: e.target.value }))}
              placeholder="Value (the answer)"
              style={inputStyle}
            />
            <select
              value={newField.category ?? 'personal'}
              onChange={e => setNewField(p => ({ ...p, category: e.target.value }))}
              style={{ ...inputStyle, cursor: 'pointer' }}
            >
              {CATEGORIES.map(c => (
                <option key={c} value={c}>{CATEGORY_META[c]?.label ?? c}</option>
              ))}
            </select>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button onClick={handleAddNew} disabled={saving} style={btnStyle(C.green)}>
                {saving ? '...' : 'Save'}
              </button>
              <button onClick={() => { setMode('view'); setNewField({}) }} style={btnStyleGhost()}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setMode('adding')}
          style={{
            ...btnStyleGhost(), width: '100%', marginBottom: 12,
            border: `1px dashed ${C.border}`,
          }}
        >
          + Add New Field
        </button>
      )}

      {/* Empty State */}
      {!loading && fields.length === 0 && (
        <div style={{ textAlign: 'center', padding: '40px 16px', color: C.muted }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>📝</div>
          <div style={{ fontSize: 12, fontWeight: 600, color: C.text, marginBottom: 4 }}>
            No persona fields yet
          </div>
          <div style={{ fontSize: 11, lineHeight: 1.6 }}>
            After filling a form, you can save your answers here.<br/>
            They'll be used to auto-fill future applications.
          </div>
        </div>
      )}

      {/* Field Groups */}
      {grouped.map(group => {
        const meta = CATEGORY_META[group.cat] ?? { icon: '📌', label: group.cat }
        return (
          <div key={group.cat} style={{ marginBottom: 14 }}>
            <div style={{
              fontSize: 11, fontWeight: 600, color: C.subtle,
              textTransform: 'uppercase', letterSpacing: '0.05em',
              marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4,
            }}>
              <span>{meta.icon}</span>
              <span>{meta.label}</span>
              <span style={{ fontSize: 9, color: C.subtle, marginLeft: 4 }}>
                ({group.items.length})
              </span>
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
          </div>
        )
      })}

      {/* Toast */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 60, left: '50%', transform: 'translateX(-50%)',
          background: '#0f172a', color: '#fff', padding: '8px 18px',
          borderRadius: 20, fontSize: 11, zIndex: 9999,
          boxShadow: '0 4px 16px rgba(0,0,0,0.2)', fontWeight: 600,
        }}>
          {toast}
        </div>
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
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(field.value)
  const [label, setLabel] = useState(field.label)

  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 8, padding: '9px 12px', marginBottom: 6,
      display: 'flex', flexDirection: 'column', gap: editing ? 6 : 0,
    }}>
      {editing ? (
        <>
          <input value={label} onChange={e => setLabel(e.target.value)} style={{ ...inputStyle, fontWeight: 600 }} />
          <textarea
            value={value}
            onChange={e => setValue(e.target.value)}
            rows={2}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => {
              onSave({ ...field, value, label, updatedAt: new Date().toISOString() })
              setEditing(false)
            }} disabled={saving} style={{ ...btnStyle(C.green), fontSize: 10, padding: '4px 10px' }}>
              {saving ? '...' : 'Save'}
            </button>
            <button onClick={() => { setEditing(false); setValue(field.value); setLabel(field.label) }} style={{ ...btnStyleGhost(), fontSize: 10, padding: '4px 10px' }}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: C.text }}>{field.label}</div>
            <div style={{ fontSize: 11, color: C.muted, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {field.value}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
            <button onClick={() => setEditing(true)} style={iconBtn}>
              ✏️
            </button>
            <button onClick={() => onDelete(field.key)} style={iconBtn}>
              🗑️
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Helpers ──────────────────────────────────────────────────────

function Spinner() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, flexDirection: 'column', gap: 10 }}>
      <div style={{
        width: 22, height: 22,
        border: `2.5px solid rgba(24,95,165,0.15)`, borderTopColor: C.primary,
        borderRadius: '50%', animation: 'spin 0.7s linear infinite',
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%', border: `1px solid #e2e8f0`, borderRadius: 4,
  padding: '6px 8px', fontSize: 11, color: '#0f172a',
  boxSizing: 'border-box', fontFamily: 'inherit',
}

function btnStyle(bg: string): React.CSSProperties {
  return {
    background: bg, color: '#fff', border: 'none',
    borderRadius: 6, padding: '6px 12px', fontSize: 11,
    fontWeight: 600, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 4,
  }
}

function btnStyleGhost(): React.CSSProperties {
  return {
    background: 'transparent', color: C.primary,
    border: `1px solid ${C.primary}30`, borderRadius: 6,
    padding: '6px 12px', fontSize: 11,
    fontWeight: 600, cursor: 'pointer',
  }
}

const iconBtn: React.CSSProperties = {
  background: 'transparent', border: 'none',
  cursor: 'pointer', fontSize: 12, padding: 2,
  opacity: 0.6,
}
