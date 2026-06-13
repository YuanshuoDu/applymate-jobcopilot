'use client'

import type { ResumeContent } from '@/lib/types'
import { InlineInput } from './InlineInput'

type ContactData = ResumeContent['contact']

export function ContactSection({ contact, editing, onEdit, onBlur, onChange }: {
  contact:  ContactData
  editing:  boolean
  onEdit:   () => void
  onBlur:   () => void
  onChange: (c: ContactData) => void
}) {
  if (editing) {
    return (
      <div style={{ marginBottom: 20 }} onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node)) onBlur() }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
          <InlineInput value={contact.name}  onChange={v => onChange({ ...contact, name: v })}  placeholder="Full Name" style={{ fontSize: 16, fontWeight: 500 }} />
          <InlineInput value={contact.email} onChange={v => onChange({ ...contact, email: v })} placeholder="Email" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 6 }}>
          <InlineInput value={contact.location}   onChange={v => onChange({ ...contact, location: v })}            placeholder="City, Country" />
          <InlineInput value={contact.phone ?? ''} onChange={v => onChange({ ...contact, phone: v || undefined })} placeholder="Phone (optional)" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <InlineInput value={contact.linkedin ?? ''} onChange={v => onChange({ ...contact, linkedin: v || undefined })} placeholder="LinkedIn URL" />
          <InlineInput value={contact.github ?? ''}   onChange={v => onChange({ ...contact, github: v || undefined })}   placeholder="GitHub URL" />
        </div>
      </div>
    )
  }
  return (
    <div style={{ marginBottom: 20, cursor: 'text', padding: 4, borderRadius: 4 }}
      onClick={onEdit}
      onMouseEnter={e => ((e.currentTarget as HTMLDivElement).style.background = 'var(--bg-secondary)')}
      onMouseLeave={e => ((e.currentTarget as HTMLDivElement).style.background = 'transparent')}>
      <div style={{ fontSize: 22, fontWeight: 500, color: 'var(--text)' }}>
        {contact.name || <span style={{ color: 'var(--text-muted)', fontSize: 16 }}>Your Name — click to edit</span>}
      </div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3, display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        {contact.email    && <span>{contact.email}</span>}
        {contact.location && <span>📍 {contact.location}</span>}
        {contact.phone    && <span>{contact.phone}</span>}
        {contact.linkedin && <span>LinkedIn</span>}
        {contact.github   && <span>GitHub</span>}
      </div>
    </div>
  )
}
