'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'

export type DragHandleProps = {
  draggable:   true
  onDragStart: (e: React.DragEvent) => void
}

export function SectionHeader({ title, count, collapsed, onToggle, onAdd, addLabel, onRemove, dragHandleProps, onTitleClick }: {
  title:            string
  count?:           number
  collapsed:        boolean
  onToggle:         () => void
  onAdd?:           () => void
  addLabel?:        string
  onRemove?:        () => void
  dragHandleProps?: DragHandleProps
  onTitleClick?:    () => void
}) {
  const { t } = useI18n()
  const titleKey: Record<string, string> = {
    SUMMARY: 'resume.section.summary', EXPERIENCE: 'resume.section.experience', EDUCATION: 'resume.section.education',
    SKILLS: 'resume.section.skills', LANGUAGES: 'resume.section.languages', PROJECTS: 'resume.section.projects',
    CERTIFICATIONS: 'resume.section.certifications',
  }
  const displayTitle = titleKey[title] ? t(titleKey[title]) : title
  return (
    <div style={{
      fontSize: 11, fontWeight: 500, color: 'var(--text)',
      borderBottom: '0.5px solid var(--border)',
      paddingBottom: 4, marginBottom: 8,
      display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {dragHandleProps && (
          <span
            {...dragHandleProps}
            title={t('resume.dragReorder')}
            style={{ color: 'var(--border)', fontSize: 13, cursor: 'grab', userSelect: 'none', lineHeight: 1, marginRight: 1 }}>
            ⠿
          </span>
        )}
        {onTitleClick ? (
          <button onClick={e => { e.stopPropagation(); onTitleClick() }} title={t('resume.editSectionTitle')}
            style={{ padding: 0, border: 'none', background: 'none', color: 'inherit', font: 'inherit', cursor: 'text', textAlign: 'left' }}>
            {displayTitle}
          </button>
        ) : displayTitle}
        {count !== undefined && count > 0 && (
          <span style={{ fontSize: 9, color: 'var(--text-muted)', fontWeight: 400 }}>({count})</span>
        )}
      </span>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        {!collapsed && onAdd && (
          <button onClick={e => { e.stopPropagation(); onAdd() }}
            style={{ fontSize: 10, color: 'var(--primary)', background: 'none', border: 'none', cursor: 'pointer' }}>
            + {addLabel ?? t('resume.add')}
          </button>
        )}
        {onRemove && (
          <button onClick={e => { e.stopPropagation(); onRemove() }} title={t('resume.removeSection')}
            style={{ fontSize: 11, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', padding: '0 2px', lineHeight: 1 }}>
            ×
          </button>
        )}
        <button onClick={e => { e.stopPropagation(); onToggle() }}
          style={{ fontSize: 10, color: 'var(--text-muted)', background: 'none', border: 'none', cursor: 'pointer', lineHeight: 1, padding: '0 2px' }}>
          {collapsed ? '▶' : '▼'}
        </button>
      </div>
    </div>
  )
}
