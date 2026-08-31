'use client'

import { Check, Edit3, Flag, RotateCcw, Send, X } from 'lucide-react'
import { type FormEvent, useEffect, useState } from 'react'
import { PLATFORM_FEATURES, type PlatformFeatureKey } from '@jobcopilot/shared/feature-flags'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type FlagRow = { id: string; key: string; environment: string; enabled: boolean; rolloutPercent: number; targetPlans: string[]; targetUserIds: string[]; status: string; version: number; approvedById: string | null; rollbackAt: string | null; updatedAt: string }
const featureKeys = Object.keys(PLATFORM_FEATURES) as PlatformFeatureKey[]

function dateTimeInputValue(value: string | null) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 16)
}

export function AdminPlatformPage({ permissions }: { permissions: readonly string[] }) {
  const { t } = useI18n()
  const [items, setItems] = useState<FlagRow[]>([])
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingVersion, setEditingVersion] = useState(1)
  const [key, setKey] = useState<PlatformFeatureKey>('worker_discovery')
  const [environment, setEnvironment] = useState('development')
  const [enabled, setEnabled] = useState(false)
  const [rolloutPercent, setRolloutPercent] = useState(0)
  const [plan, setPlan] = useState('')
  const [userIds, setUserIds] = useState('')
  const [rollbackAt, setRollbackAt] = useState('')
  const [notice, setNotice] = useState('')
  const planLabel = (value: string) => value === 'free' ? t('admin.free') : value === 'pro' ? t('admin.pro') : value === 'enterprise' ? t('admin.enterprise') : value
  const statusLabel = (value: string) => t(`platformFlags.status.${value}`)
  const environmentLabel = (value: string) => value === 'development' ? t('platformFlags.development') : value === 'staging' ? t('platformFlags.staging') : value === 'production' ? t('platformFlags.production') : value
  const can = (permission: string) => permissions.includes(permission)

  async function load() {
    const response = await fetch('/api/admin/v1/platform/flags', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { items?: FlagRow[]; error?: string } | null
    setItems(payload?.items ?? [])
    if (!response.ok) setNotice(payload?.error ?? t('platformFlags.loadFailed'))
  }

  useEffect(() => { void load() }, [])

  async function request(url: string, payload: Record<string, unknown>, method: 'POST' | 'PATCH' = 'POST') {
    const response = await fetch(url, { method, headers: adminMutationHeaders(), body: JSON.stringify(payload) })
    const result = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) { setNotice(result?.error ?? t('platformFlags.actionFailed')); return false }
    return true
  }

  function resetForm() {
    setEditingId(null)
    setEditingVersion(1)
    setKey('worker_discovery')
    setEnvironment('development')
    setEnabled(false)
    setRolloutPercent(0)
    setPlan('')
    setUserIds('')
    setRollbackAt('')
  }

  function editDraft(flag: FlagRow) {
    setEditingId(flag.id)
    setEditingVersion(flag.version)
    setKey(flag.key as PlatformFeatureKey)
    setEnvironment(flag.environment)
    setEnabled(flag.enabled)
    setRolloutPercent(flag.rolloutPercent)
    setPlan(flag.targetPlans[0] ?? '')
    setUserIds(flag.targetUserIds.join(', '))
    setRollbackAt(dateTimeInputValue(flag.rollbackAt))
    setNotice('')
  }

  async function save(event: FormEvent) {
    event.preventDefault()
    const targetUserIds = userIds.split(',').map((id) => id.trim()).filter(Boolean)
    const payload = { key, environment, enabled, rolloutPercent, targetPlans: plan ? [plan] : [], targetUserIds, rollbackAt: rollbackAt || null, reason: editingId ? 'Correcting reviewed feature flag rollout before resubmission' : 'Creating reviewed platform feature flag draft' }
    const saved = editingId
      ? await request(`/api/admin/v1/platform/flags/${editingId}`, { ...payload, version: editingVersion }, 'PATCH')
      : await request('/api/admin/v1/platform/flags', payload)
    if (saved) { setNotice(editingId ? t('platformFlags.draftUpdated') : t('platformFlags.draftCreated')); resetForm(); await load() }
  }

  async function submit(flag: FlagRow) {
    if (await request(`/api/admin/v1/platform/flags/${flag.id}/submit`, { version: flag.version, reason: 'Submitting reviewed feature flag for approval' })) { setNotice(t('platformFlags.submitted')); await load() }
  }

  async function approve(flag: FlagRow) {
    if (await request(`/api/admin/v1/platform/flags/${flag.id}/approve`, { version: flag.version, reason: 'Approving reviewed feature flag activation' })) { setNotice(`${flag.key} ${t('platformFlags.active')}`); await load() }
  }

  async function reject(flag: FlagRow) {
    if (await request(`/api/admin/v1/platform/flags/${flag.id}/reject`, { version: flag.version, reason: 'Returning feature flag for rollout correction' })) { setNotice(t('platformFlags.rejected')); await load() }
  }

  async function rollback(flag: FlagRow) {
    if (await request(`/api/admin/v1/platform/flags/${flag.id}/rollback`, { version: flag.version, reason: 'Rolling back active platform control after operational review' })) { setNotice(t('platformFlags.rolledBack')); await load() }
  }

  return <div className="admin-page"><header className="admin-header"><div><h1>{t('platformFlags.title')}</h1><p>{t('platformFlags.description')}</p></div><Flag size={22} aria-hidden="true" /></header><section className="flag-layout"><form className="flag-form" onSubmit={(event) => void save(event)}><h2>{editingId ? t('platformFlags.editDraft') : t('platformFlags.newFlag')}</h2><label>{t('platformFlags.control')}<select disabled={Boolean(editingId)} value={key} onChange={(event) => setKey(event.target.value as PlatformFeatureKey)}>{featureKeys.map((featureKey) => <option key={featureKey} value={featureKey}>{featureKey}</option>)}</select></label><div className="flag-grid"><label>{t('platformFlags.environment')}<select disabled={Boolean(editingId)} value={environment} onChange={(event) => setEnvironment(event.target.value)}><option value="development">{t('platformFlags.development')}</option><option value="staging">{t('platformFlags.staging')}</option><option value="production">{t('platformFlags.production')}</option></select></label><label>{t('platformFlags.rollout')}<input type="number" min="0" max="100" value={rolloutPercent} onChange={(event) => setRolloutPercent(Number(event.target.value))} /></label></div><label className="flag-check"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /> {t('admin.enabled')}</label><div className="flag-grid"><label>{t('platformFlags.planTarget')}<select value={plan} onChange={(event) => setPlan(event.target.value)}><option value="">{t('platformFlags.allPlans')}</option><option value="free">{t('admin.free')}</option><option value="pro">{t('admin.pro')}</option><option value="enterprise">{t('admin.enterprise')}</option></select></label><label>{t('platformFlags.rollbackAt')}<input type="datetime-local" value={rollbackAt} onChange={(event) => setRollbackAt(event.target.value)} /></label></div><label>{t('platformFlags.userTargets')}<input value={userIds} onChange={(event) => setUserIds(event.target.value)} placeholder={t('platformFlags.userTargetsPlaceholder')} /></label><div className="broadcast-actions"><button className="broadcast-primary" type="submit"><Flag size={16} /> {editingId ? t('platformFlags.saveDraft') : t('platformFlags.createDraft')}</button>{editingId && <button type="button" onClick={resetForm}><X size={16} /> {t('platformFlags.cancelEdit')}</button>}</div></form><section className="flag-list"><div className="broadcast-list-title"><h2>{t('platformFlags.controls')}</h2>{notice && <span role="status">{notice}</span>}</div>{items.length === 0 ? <p>{t('platformFlags.empty')}</p> : items.map((flag) => <article className="flag-row" key={flag.id}><div><h3>{flag.key}</h3><p>{environmentLabel(flag.environment)} · {flag.enabled ? t('admin.enabled') : t('admin.disabled')} · {flag.rolloutPercent}% {t('platformFlags.rolloutLabel')} · v{flag.version}</p><small>{flag.targetPlans.length ? flag.targetPlans.map(planValue => planLabel(planValue)).join(', ') : t('platformFlags.allPlans')}{flag.targetUserIds.length ? ` · ${flag.targetUserIds.length} ${t('platformFlags.explicitUsers')}` : ''}{flag.rollbackAt ? ` · ${t('platformFlags.rollback')} ${new Date(flag.rollbackAt).toLocaleString()}` : ''}</small></div><div className="broadcast-actions">{flag.status === 'draft' && <><button title={t('platformFlags.editDraft')} onClick={() => void editDraft(flag)} disabled={!can('feature_flags.update')}><Edit3 size={16} /></button><button title={t('platformFlags.submitApproval')} onClick={() => void submit(flag)} disabled={!can('feature_flags.update')}><Send size={16} /></button></>}{flag.status === 'pending_approval' && <><button title={t('platformFlags.reject')} onClick={() => void reject(flag)} disabled={!can('feature_flags.approve')}><X size={16} /></button><button title={t('platformFlags.approve')} onClick={() => void approve(flag)} disabled={!can('feature_flags.approve')}><Check size={16} /></button></>}{flag.status === 'active' && <button title={t('platformFlags.rollback')} onClick={() => void rollback(flag)} disabled={!can('feature_flags.approve')}><RotateCcw size={16} /></button>}<span className={`flag-status ${flag.status}`}>{statusLabel(flag.status)}</span></div></article>)}</section></section></div>
}
