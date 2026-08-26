'use client'

import { Pencil, Power, PowerOff, Save, X } from 'lucide-react'
import React from 'react'
import { useMemo, useState } from 'react'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useApi } from '@/lib/hooks'
import { useI18n } from '@/lib/i18n'
import { useAdminPrompt } from './AdminPromptDialog'

type RegistryItem = {
  id: number
  atsType: 'greenhouse' | 'lever'
  slug: string
  name: string | null
  country: string | null
  enabled: boolean
  version: number
  jobCount: number
  lastSeen: string | null
}

type RegistryPage = { items: RegistryItem[]; nextCursor: string | null }
type RegistryForm = { atsType: 'greenhouse' | 'lever'; slug: string; name: string; country: string; enabled: boolean }

const EMPTY_FORM: RegistryForm = { atsType: 'greenhouse', slug: '', name: '', country: '', enabled: true }

export function AdminAtsRegistry({ canManage }: { canManage: boolean }) {
  const { t } = useI18n()
  const { request: askReason, dialog } = useAdminPrompt()
  const [query, setQuery] = useState('')
  const [source, setSource] = useState('')
  const [state, setState] = useState('')
  const [cursor, setCursor] = useState<string | null>(null)
  const [cursorStack, setCursorStack] = useState<string[]>([])
  const [form, setForm] = useState<RegistryForm>(EMPTY_FORM)
  const [editing, setEditing] = useState<RegistryItem | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const params = useMemo(() => {
    const value = new URLSearchParams({ limit: '25' })
    if (query.trim()) value.set('q', query.trim())
    if (source) value.set('atsType', source)
    if (state) value.set('enabled', state)
    if (cursor) value.set('cursor', cursor)
    return value
  }, [cursor, query, source, state])
  const { data, loading, error, refetch } = useApi<RegistryPage>(`/api/admin/v1/ats?${params}`, { cache: false, timeoutMs: 10_000 })
  const items = data?.items ?? []

  function resetPage() { setCursor(null); setCursorStack([]) }
  function resetForm() { setEditing(null); setForm(EMPTY_FORM) }
  function startEdit(item: RegistryItem) {
    setEditing(item)
    setForm({ atsType: item.atsType, slug: item.slug, name: item.name ?? item.slug, country: item.country ?? '', enabled: item.enabled })
    document.getElementById('ats-registry-form')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  async function save(event: React.FormEvent) {
    event.preventDefault()
    const reason = await askReason({ title: editing ? t('adminAts.editEmployer') : t('adminAts.registerEmployer'), label: t('adminAts.registryReason'), kind: 'reason' })
    if (!reason) return
    setBusy(true)
    const url = editing ? `/api/admin/v1/ats/registry/${editing.id}` : '/api/admin/v1/ats/registry'
    const body = editing ? { name: form.name, country: form.country, enabled: form.enabled, version: editing.version, reason } : { ...form, reason }
    try {
      const response = await fetch(url, { method: editing ? 'PATCH' : 'POST', headers: adminMutationHeaders(), body: JSON.stringify(body) })
      const payload = await response.json().catch(() => null) as { error?: string } | null
      setNotice(response.ok ? t('adminAts.registrySaved') : payload?.error ?? t('adminAts.registryFailed'))
      if (response.ok) { resetForm(); await refetch() }
    } catch {
      setNotice(t('adminAts.registryFailed'))
    } finally {
      setBusy(false)
    }
  }
  async function toggle(item: RegistryItem) {
    const reason = await askReason({ title: item.enabled ? t('adminAts.disableEmployer') : t('adminAts.enableEmployer'), label: t('adminAts.registryReason'), kind: 'reason' })
    if (!reason) return
    setBusy(true)
    try {
      const response = await fetch(`/api/admin/v1/ats/registry/${item.id}`, {
        method: 'PATCH', headers: adminMutationHeaders(),
        body: JSON.stringify({ name: item.name ?? item.slug, country: item.country ?? '', enabled: !item.enabled, version: item.version, reason }),
      })
      const payload = await response.json().catch(() => null) as { error?: string } | null
      setNotice(response.ok ? t('adminAts.registrySaved') : payload?.error ?? t('adminAts.registryFailed'))
      if (response.ok) await refetch()
    } catch {
      setNotice(t('adminAts.registryFailed'))
    } finally {
      setBusy(false)
    }
  }
  function nextPage() {
    if (!data?.nextCursor) return
    setCursorStack(current => [...current, cursor ?? ''])
    setCursor(data.nextCursor)
  }
  function previousPage() {
    const previous = cursorStack[cursorStack.length - 1]
    setCursorStack(current => current.slice(0, -1))
    setCursor(previous || null)
  }
  const exportHref = `/api/admin/v1/export?resource=ats&${new URLSearchParams({ ...(query.trim() ? { q: query.trim() } : {}), ...(source ? { atsType: source } : {}), ...(state ? { enabled: state } : {}) })}`
  return <section className="admin-list-page ats-registry-section">
    <div className="admin-controls-title"><div><h2>{t('adminAts.registryTitle')}</h2><p>{t('adminAts.registryDescription')}</p></div><span role="status" aria-live="polite">{notice}</span></div>
    {canManage && <form id="ats-registry-form" className="ats-registry-form" onSubmit={(event) => void save(event)}>
      <label>{t('adminAts.atsLabel')}<select disabled={Boolean(editing) || busy} value={form.atsType} onChange={event => setForm(current => ({ ...current, atsType: event.target.value as RegistryForm['atsType'] }))}><option value="greenhouse">Greenhouse</option><option value="lever">Lever</option></select></label>
      <label>{t('adminAts.employerSlug')}<input required disabled={Boolean(editing) || busy} value={form.slug} onChange={event => setForm(current => ({ ...current, slug: event.target.value }))} placeholder="company-slug" /></label>
      <label>{t('adminAts.employerName')}<input required disabled={busy} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
      <label>{t('adminAts.country')}<input disabled={busy} maxLength={2} pattern="[A-Za-z]{2}" value={form.country} onChange={event => setForm(current => ({ ...current, country: event.target.value }))} placeholder="DE" /></label>
      <label className="flag-check"><input type="checkbox" disabled={busy} checked={form.enabled} onChange={event => setForm(current => ({ ...current, enabled: event.target.checked }))} /> {t('adminAts.enabledForDiscovery')}</label>
      <span className="admin-action-group"><button className="admin-primary-button" disabled={busy} type="submit"><Save size={15} /> {editing ? t('common.save') : t('adminAts.register')}</button>{editing && <button className="admin-secondary" disabled={busy} type="button" onClick={resetForm}><X size={15} /> {t('common.cancel')}</button>}</span>
    </form>}
    <div className="admin-table-toolbar"><label className="admin-search"><span className="sr-only">{t('adminAts.searchRegistry')}</span><input value={query} onChange={event => { setQuery(event.target.value); resetPage() }} placeholder={t('adminAts.searchRegistry')} /></label><label className="admin-table-filter">{t('adminAts.atsLabel')}<select value={source} onChange={event => { setSource(event.target.value); resetPage() }}><option value="">{t('admin.all')}</option><option value="greenhouse">Greenhouse</option><option value="lever">Lever</option></select></label><label className="admin-table-filter">{t('admin.status')}<select value={state} onChange={event => { setState(event.target.value); resetPage() }}><option value="">{t('admin.all')}</option><option value="true">{t('admin.active')}</option><option value="false">{t('admin.disabled')}</option></select></label><a className="admin-secondary" href={exportHref} download>{t('admin.exportFilteredCsv')}</a></div>
    {error && <div className="admin-alert" role="alert">{error}</div>}
    <div className="admin-table-wrap"><table className="admin-table ats-registry-table"><thead><tr><th>{t('ops.source')}</th><th>{t('adminAts.employerSlug')}</th><th>{t('adminAts.country')}</th><th>{t('admin.status')}</th><th>{t('ops.jobs')}</th><th>{t('ops.lastSeen')}</th><th>{t('admin.actions')}</th></tr></thead><tbody>{loading ? <tr><td colSpan={7}>{t('admin.loadingSafeData')}</td></tr> : items.length === 0 ? <tr><td colSpan={7}>{t('adminAts.registryEmpty')}</td></tr> : items.map(item => <tr key={item.id}><td><strong>{item.name ?? item.slug}</strong><small>{item.atsType}</small></td><td>{item.slug}</td><td>{item.country?.toUpperCase() ?? '—'}</td><td><span className="admin-status-pill" data-active={item.enabled}>{item.enabled ? t('admin.active') : t('admin.disabled')}</span></td><td>{item.jobCount}</td><td>{item.lastSeen ? new Date(item.lastSeen).toLocaleString() : t('adminAts.neverSeen')}</td><td><span className="admin-action-group"><button className="admin-row-action" type="button" title={t('common.edit')} aria-label={t('common.edit')} disabled={!canManage || busy} onClick={() => startEdit(item)}><Pencil size={15} /></button><button className="admin-row-action" type="button" title={item.enabled ? t('adminAts.disableEmployer') : t('adminAts.enableEmployer')} aria-label={item.enabled ? t('adminAts.disableEmployer') : t('adminAts.enableEmployer')} disabled={!canManage || busy} onClick={() => void toggle(item)}>{item.enabled ? <PowerOff size={15} /> : <Power size={15} />}</button></span></td></tr>)}</tbody></table></div>
    <div className="admin-pagination"><button className="admin-secondary" disabled={!cursorStack.length || loading} onClick={previousPage}>{t('admin.previous')}</button><span>{loading ? t('common.loading') : `${items.length} ${t('admin.records')}`}</span><button className="admin-secondary" disabled={!data?.nextCursor || loading} onClick={nextPage}>{t('admin.next')}</button></div>
    {dialog}
  </section>
}
