'use client'

import { Pause, Play, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toAtsPolicyPayload } from './admin-ats-policy-form'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'

type Policy = { configured: boolean; state: string; enabled: boolean; rolloutPercent: number; globalRpsLimit: number; perTenantRpsLimit: number; maxRetries: number; backoffBaseMs: number; allowAutoApply: boolean; version: number; lastAcknowledgedVersion: number | null }
type Source = { sourceKey: string; policy: Policy; propagation: string; registryCount: number; lastSeenAt: string | null }
const sources = ['greenhouse', 'lever', 'workday', 'smartrecruiters', 'personio']

export function AdminAtsControls({ permissions }: { permissions: readonly string[] }) {
  const [items, setItems] = useState<Source[]>([])
  const [notice, setNotice] = useState('')
  const [history, setHistory] = useState<{ id: string; sourceKey: string; action: string; outcome: string; reason: string | null; createdAt: string }[]>([])
  const [registry, setRegistry] = useState({ atsType: 'greenhouse', slug: '', name: '' })
  const [registryId, setRegistryId] = useState('')
  const { request: askReason, dialog } = useAdminPrompt()
  const can = (permission: string) => permissions.includes(permission)
  async function load() {
    const responses = await Promise.all(sources.map(async (sourceKey) => {
      const response = await fetch(`/api/admin/v1/ats/${sourceKey}/health`, { cache: 'no-store' })
      return response.ok ? await response.json() as Source : null
    }))
    setItems(responses.filter((item): item is Source => Boolean(item)))
  }
  useEffect(() => { void load() }, [])
  async function request(url: string, body: Record<string, unknown>) {
    const reason = await askReason({ title: 'Change ATS source state', label: 'Operational reason', kind: 'reason' })
    if (!reason) return false
    const response = await fetch(url, { method: 'POST', headers: adminMutationHeaders(), body: JSON.stringify({ ...body, reason }) })
    const payload = await response.json().catch(() => null) as { error?: string; state?: string } | null
    setNotice(response.ok ? `Source state: ${payload?.state ?? 'updated'}.` : payload?.error ?? 'Source operation failed.')
    return response.ok
  }
  async function save(source: Source) {
    const reason = await askReason({ title: 'Save ATS source policy', label: 'Policy change reason', kind: 'reason' })
    if (!reason) return
    const policy = source.policy
    const response = await fetch(`/api/admin/v1/ats/${source.sourceKey}/policy`, { method: 'PATCH', headers: adminMutationHeaders(), body: JSON.stringify({ ...toAtsPolicyPayload(policy), reason }) })
    const payload = await response.json().catch(() => null) as { error?: string; propagation?: string } | null
    setNotice(response.ok ? `Policy saved; Worker propagation ${payload?.propagation ?? 'pending'}.` : payload?.error ?? 'Policy save failed.')
    if (response.ok) await load()
  }
  async function loadHistory(sourceKey: string) {
    const response = await fetch(`/api/admin/v1/ats/${sourceKey}/history`, { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { events?: typeof history; error?: string } | null
    setHistory(response.ok ? (payload?.events ?? []).map(event => ({ ...event, sourceKey })) : [])
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load source history.')
  }
  async function updateRegistry() {
    const reason = await askReason({ title: registryId ? 'Rename ATS employer' : 'Register ATS employer', label: 'Registry change reason', kind: 'reason' })
    if (!reason) return
    const url = registryId ? `/api/admin/v1/ats/registry/${registryId}` : '/api/admin/v1/ats/registry'
    const body = registryId ? { name: registry.name, reason } : { ...registry, reason }
    const response = await fetch(url, { method: registryId ? 'PATCH' : 'POST', headers: adminMutationHeaders(), body: JSON.stringify(body) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? 'ATS employer registry saved.' : payload?.error ?? 'Unable to save ATS employer registry entry.')
    if (response.ok) { setRegistryId(''); setRegistry({ atsType: 'greenhouse', slug: '', name: '' }) }
  }
  function update(sourceKey: string, patch: Partial<Policy>) { setItems((current) => current.map((item) => item.sourceKey === sourceKey ? { ...item, policy: { ...item.policy, ...patch } } : item)) }
  return <><section className="admin-controls"><div className="admin-controls-title"><div><h2>Source policy</h2><p>Hard ceilings remain enforced by the service.</p></div><span role="status">{notice}</span></div>{can('ats.registry.manage') && <form className="admin-filter-panel" onSubmit={(event) => { event.preventDefault(); void updateRegistry() }}><label>ATS<select value={registry.atsType} onChange={event => setRegistry(current => ({ ...current, atsType: event.target.value }))}>{sources.map(source => <option key={source} value={source}>{source}</option>)}</select></label><label>Employer slug<input required value={registry.slug} disabled={Boolean(registryId)} onChange={event => setRegistry(current => ({ ...current, slug: event.target.value }))} placeholder="company-slug" /></label><label>Employer name<input required value={registry.name} onChange={event => setRegistry(current => ({ ...current, name: event.target.value }))} placeholder="Company name" /></label><label>Existing ID (for rename)<input inputMode="numeric" value={registryId} onChange={event => setRegistryId(event.target.value.replace(/\D/g, ''))} placeholder="optional" /></label><button className="admin-primary-button" type="submit">{registryId ? 'Rename employer' : 'Register employer'}</button></form>}<div className="ats-control-grid">{items.map((source) => <article className="ats-control" key={source.sourceKey}><div className="ats-control-heading"><div><h3>{source.sourceKey}</h3><small>{source.registryCount} employers · {source.policy.state} · {source.policy.configured ? source.propagation : 'default effective policy - not saved'}</small></div>{source.policy.state === 'paused' ? <button className="admin-row-action" title="Resume source" disabled={!can('ats.resume')} onClick={async () => { if (await request(`/api/admin/v1/ats/${source.sourceKey}/resume`, { version: source.policy.version })) await load() }}><Play size={15} /></button> : <button className="admin-row-action" title="Request or approve pause" disabled={!can('ats.pause')} onClick={async () => { if (await request(`/api/admin/v1/ats/${source.sourceKey}/pause`, {})) await load() }}><Pause size={15} /></button>}</div><div className="ats-control-fields"><label>Rollout<input type="number" min="0" max="100" value={source.policy.rolloutPercent} onChange={(event) => update(source.sourceKey, { rolloutPercent: Number(event.target.value) })} /></label><label>Global RPS<input type="number" min="1" value={source.policy.globalRpsLimit} onChange={(event) => update(source.sourceKey, { globalRpsLimit: Number(event.target.value) })} /></label><label>Tenant RPS<input type="number" min="1" value={source.policy.perTenantRpsLimit} onChange={(event) => update(source.sourceKey, { perTenantRpsLimit: Number(event.target.value) })} /></label><label>Retries<input type="number" min="0" max="10" value={source.policy.maxRetries} onChange={(event) => update(source.sourceKey, { maxRetries: Number(event.target.value) })} /></label><label>Backoff ms<input type="number" min="100" max="120000" value={source.policy.backoffBaseMs} onChange={(event) => update(source.sourceKey, { backoffBaseMs: Number(event.target.value) })} /></label><label className="flag-check"><input type="checkbox" checked={source.policy.allowAutoApply} onChange={(event) => update(source.sourceKey, { allowAutoApply: event.target.checked })} /> Allow auto apply</label></div><span className="admin-action-group"><button className="admin-secondary" disabled={!can('ats.update') || source.policy.state === 'paused'} onClick={() => void save(source)}><Save size={15} /> Save policy</button><button className="admin-secondary" onClick={() => void loadHistory(source.sourceKey)}>History</button></span></article>)}</div>{history.length > 0 && <section className="admin-detail-history"><h3>Policy and operational history · {history[0]?.sourceKey}</h3><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Action</th><th>Outcome</th><th>Reason</th><th>Time</th></tr></thead><tbody>{history.map(event => <tr key={event.id}><td>{event.action}</td><td>{event.outcome}</td><td>{event.reason ?? '—'}</td><td>{new Date(event.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div></section>}</section>{dialog}</>
}
