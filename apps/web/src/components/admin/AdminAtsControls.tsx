'use client'

import { Pause, Play, Save } from 'lucide-react'
import { useEffect, useState } from 'react'
import { toAtsPolicyPayload } from './admin-ats-policy-form'

type Policy = { configured: boolean; state: string; enabled: boolean; rolloutPercent: number; globalRpsLimit: number; perTenantRpsLimit: number; maxRetries: number; backoffBaseMs: number; allowAutoApply: boolean; version: number; lastAcknowledgedVersion: number | null }
type Source = { sourceKey: string; policy: Policy; propagation: string; registryCount: number; lastSeenAt: string | null }
const sources = ['greenhouse', 'lever', 'workday', 'smartrecruiters', 'personio']

export function AdminAtsControls({ permissions }: { permissions: readonly string[] }) {
  const [items, setItems] = useState<Source[]>([])
  const [notice, setNotice] = useState('')
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
    const reason = window.prompt('Enter the operational reason')
    if (!reason) return false
    const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ ...body, reason }) })
    const payload = await response.json().catch(() => null) as { error?: string; state?: string } | null
    setNotice(response.ok ? `Source state: ${payload?.state ?? 'updated'}.` : payload?.error ?? 'Source operation failed.')
    return response.ok
  }
  async function save(source: Source) {
    const reason = window.prompt('Enter the policy change reason')
    if (!reason) return
    const policy = source.policy
    const response = await fetch(`/api/admin/v1/ats/${source.sourceKey}/policy`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ ...toAtsPolicyPayload(policy), reason }) })
    const payload = await response.json().catch(() => null) as { error?: string; propagation?: string } | null
    setNotice(response.ok ? `Policy saved; Worker propagation ${payload?.propagation ?? 'pending'}.` : payload?.error ?? 'Policy save failed.')
    if (response.ok) await load()
  }
  function update(sourceKey: string, patch: Partial<Policy>) { setItems((current) => current.map((item) => item.sourceKey === sourceKey ? { ...item, policy: { ...item.policy, ...patch } } : item)) }
  return <section className="admin-controls"><div className="admin-controls-title"><div><h2>Source policy</h2><p>Hard ceilings remain enforced by the service.</p></div><span role="status">{notice}</span></div><div className="ats-control-grid">{items.map((source) => <article className="ats-control" key={source.sourceKey}><div className="ats-control-heading"><div><h3>{source.sourceKey}</h3><small>{source.registryCount} employers · {source.policy.state} · {source.policy.configured ? source.propagation : 'default effective policy - not saved'}</small></div>{source.policy.state === 'paused' ? <button className="admin-row-action" title="Resume source" disabled={!can('ats.resume')} onClick={async () => { if (await request(`/api/admin/v1/ats/${source.sourceKey}/resume`, { version: source.policy.version })) await load() }}><Play size={15} /></button> : <button className="admin-row-action" title="Request or approve pause" disabled={!can('ats.pause')} onClick={async () => { if (await request(`/api/admin/v1/ats/${source.sourceKey}/pause`, {})) await load() }}><Pause size={15} /></button>}</div><div className="ats-control-fields"><label>Rollout<input type="number" min="0" max="100" value={source.policy.rolloutPercent} onChange={(event) => update(source.sourceKey, { rolloutPercent: Number(event.target.value) })} /></label><label>Global RPS<input type="number" min="1" value={source.policy.globalRpsLimit} onChange={(event) => update(source.sourceKey, { globalRpsLimit: Number(event.target.value) })} /></label><label>Tenant RPS<input type="number" min="1" value={source.policy.perTenantRpsLimit} onChange={(event) => update(source.sourceKey, { perTenantRpsLimit: Number(event.target.value) })} /></label><label>Retries<input type="number" min="0" max="10" value={source.policy.maxRetries} onChange={(event) => update(source.sourceKey, { maxRetries: Number(event.target.value) })} /></label><label>Backoff ms<input type="number" min="100" max="120000" value={source.policy.backoffBaseMs} onChange={(event) => update(source.sourceKey, { backoffBaseMs: Number(event.target.value) })} /></label><label className="flag-check"><input type="checkbox" checked={source.policy.allowAutoApply} onChange={(event) => update(source.sourceKey, { allowAutoApply: event.target.checked })} /> Allow auto apply</label></div><button className="admin-secondary" disabled={!can('ats.update') || source.policy.state === 'paused'} onClick={() => void save(source)}><Save size={15} /> Save policy</button></article>)}</div></section>
}
