'use client'

import { Check, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

type Grant = { id: string; requesterId: string; approverId: string | null; permission: string; expiresAt: string; createdAt: string }
const permissions = ['queues.pause', 'ats.pause', 'ai_budget.reset', 'feature_flags.approve', 'broadcasts.publish']

export function AdminSecurityPage({ canApprove }: { canApprove: boolean }) {
  const [grants, setGrants] = useState<Grant[]>([])
  const [permission, setPermission] = useState(permissions[0])
  const [minutes, setMinutes] = useState(15)
  const [notice, setNotice] = useState('')
  const load = useCallback(async () => {
    if (!canApprove) return
    const response = await fetch('/api/admin/v1/break-glass', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { grants?: Grant[]; error?: string } | null
    setGrants(payload?.grants ?? [])
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load temporary grants.')
  }, [canApprove])
  useEffect(() => { void load() }, [load])
  async function requestGrant(event: React.FormEvent) {
    event.preventDefault()
    const reason = window.prompt('Enter the incident reason for temporary access')
    if (!reason) return
    const response = await fetch('/api/admin/v1/break-glass', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ permission, durationMinutes: minutes, reason }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? 'Temporary access request sent for independent approval.' : payload?.error ?? 'Unable to request access.')
    if (response.ok) await load()
  }
  async function approve(grant: Grant) {
    const reason = window.prompt('Enter the approval reason')
    if (!reason) return
    const response = await fetch(`/api/admin/v1/break-glass/${grant.id}/approve`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ reason }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? 'Temporary access approved.' : payload?.error ?? 'Unable to approve access.')
    if (response.ok) await load()
  }
  return <div className="admin-page"><header className="admin-header"><div><h1>Security controls</h1><p>Short-lived emergency access with independent approval</p></div><ShieldAlert size={22} aria-hidden="true" /></header><section className="security-layout"><form className="security-card" onSubmit={(event) => void requestGrant(event)}><h2>Request temporary access</h2><label>Permission<select value={permission} onChange={(event) => setPermission(event.target.value)}>{permissions.map((item) => <option value={item} key={item}>{item}</option>)}</select></label><label>Duration (minutes)<input type="number" min="5" max="60" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><button className="broadcast-primary" type="submit">Request approval</button></form><section className="security-card"><div className="broadcast-list-title"><h2>Active requests</h2><span role="status">{notice}</span></div>{!canApprove ? <p>Approval permission is required to inspect requests.</p> : grants.length ? grants.map((grant) => <article className="security-grant" key={grant.id}><div><strong>{grant.permission}</strong><small>{grant.approverId ? 'Approved' : 'Pending approval'} · expires {new Date(grant.expiresAt).toLocaleString()}</small></div>{!grant.approverId && <button className="admin-row-action" title="Approve temporary access" onClick={() => void approve(grant)}><Check size={15} /></button>}</article>) : <p>No active temporary-access requests.</p>}</section></section></div>
}
