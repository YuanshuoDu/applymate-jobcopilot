'use client'

import React from 'react'
import { useI18n } from '@/lib/i18n'
import { getApplicationTaskState, type ApplicationTaskView } from './application-task-model'
import { applicationTaskAllowsManualWork } from './application-attention-safety'

/** Material checks are not evidence that an application has been submitted. */
export function ApplicationProgress({ hasMaterials, checked, recorded, task }: {
  hasMaterials: boolean
  checked: boolean
  recorded: boolean
  task?: ApplicationTaskView
}) {
  const { t } = useI18n()
  const state = task ? getApplicationTaskState(task) : null
  const steps = [
    { key: 'application.materials', complete: hasMaterials },
    { key: 'application.materialCheck', complete: checked },
    { key: 'application.submission', complete: state ? state.kind === 'submitted' || (recorded && applicationTaskAllowsManualWork(task)) : recorded },
  ]
  return <ol aria-label={t('application.progress')} style={{ listStyle: 'none', margin: 0, display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 8, padding: '18px 28px', borderBottom: '1px solid var(--border)' }}>
    {steps.map(step => <li key={step.key} style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center' }}>
      <strong style={{ display: 'block', marginBottom: 6, color: step.complete ? 'var(--c-success)' : 'var(--text)' }}>{t(step.key)}</strong>
      <span>{t(step.complete ? 'application.recordAvailable' : 'application.notComplete')}</span>
    </li>)}
  </ol>
}
