'use client'

import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { Check, KeyRound, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

type Grant = { id: string; requesterId: string; approverId: string | null; permission: string; expiresAt: string; createdAt: string }
type SecurityAction = 'request' | 'approve' | null
type WebAuthnStatus = { mfaLevel: 'none' | 'webauthn'; credentials: Array<{ id: string; deviceName: string | null; deviceType: string | null; createdAt: string; lastUsedAt: string | null }> }
const permissions = ['queues.pause', 'ats.pause', 'ai_budget.reset', 'feature_flags.approve', 'broadcasts.publish']

function requestHeaders() {
  return { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }
}

export function AdminSecurityPage({ canApprove }: { canApprove: boolean }) {
  const [grants, setGrants] = useState<Grant[]>([])
  const [permission, setPermission] = useState(permissions[0])
  const [minutes, setMinutes] = useState(15)
  const [notice, setNotice] = useState('')
  const [securityAction, setSecurityAction] = useState<SecurityAction>(null)
  const [selectedGrant, setSelectedGrant] = useState<Grant | null>(null)
  const [reason, setReason] = useState('')
  const [mfa, setMfa] = useState<WebAuthnStatus | null>(null)
  const [working, setWorking] = useState(false)

  const load = useCallback(async () => {
    const [grantResponse, mfaResponse] = await Promise.all([
      canApprove ? fetch('/api/admin/v1/break-glass', { cache: 'no-store' }) : Promise.resolve(null),
      fetch('/api/admin/v1/security/webauthn', { cache: 'no-store' }),
    ])
    if (grantResponse) {
      const payload = await grantResponse.json().catch(() => null) as { grants?: Grant[]; error?: string } | null
      setGrants(payload?.grants ?? [])
      if (!grantResponse.ok) setNotice(payload?.error ?? 'Unable to load temporary grants.')
    }
    const mfaPayload = await mfaResponse.json().catch(() => null) as WebAuthnStatus | { error?: string } | null
    if (mfaResponse.ok && mfaPayload && 'credentials' in mfaPayload) setMfa(mfaPayload)
  }, [canApprove])

  useEffect(() => { void load() }, [load])

  function openReasonDialog(action: Exclude<SecurityAction, null>, grant?: Grant) {
    setSecurityAction(action)
    setSelectedGrant(grant ?? null)
    setReason('')
  }

  async function submitReason(event: React.FormEvent) {
    event.preventDefault()
    if (!reason.trim()) return
    setWorking(true)
    const url = securityAction === 'approve' && selectedGrant ? `/api/admin/v1/break-glass/${selectedGrant.id}/approve` : '/api/admin/v1/break-glass'
    const body = securityAction === 'approve' ? { reason: reason.trim() } : { permission, durationMinutes: minutes, reason: reason.trim() }
    const response = await fetch(url, { method: 'POST', headers: requestHeaders(), body: JSON.stringify(body) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? securityAction === 'approve' ? 'Temporary access approved.' : 'Temporary access request sent for independent approval.' : payload?.error ?? 'Unable to complete the security action.')
    setWorking(false)
    setSecurityAction(null)
    if (response.ok) await load()
  }

  async function registerSecurityKey() {
    setWorking(true)
    try {
      const optionsResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'register_options' }) })
      const optionsPayload = await optionsResponse.json() as { options?: Parameters<typeof startRegistration>[0]; challengeId?: string; error?: string }
      if (!optionsResponse.ok || !optionsPayload.options || !optionsPayload.challengeId) throw new Error(optionsPayload.error ?? 'Unable to start security-key registration.')
      const response = await startRegistration(optionsPayload.options)
      const verifyResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'register_verify', challengeId: optionsPayload.challengeId, response, deviceName: 'Administrator security key' }) })
      const verifyPayload = await verifyResponse.json() as { error?: string }
      if (!verifyResponse.ok) throw new Error(verifyPayload.error ?? 'Unable to verify security key.')
      setNotice('Security key registered. High-risk actions now require WebAuthn reauthentication.')
      await load()
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Security-key registration was cancelled.')
    } finally {
      setWorking(false)
    }
  }

  async function reauthenticate() {
    setWorking(true)
    try {
      const optionsResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'reauth_options' }) })
      const optionsPayload = await optionsResponse.json() as { options?: Parameters<typeof startAuthentication>[0]; challengeId?: string; error?: string }
      if (!optionsResponse.ok || !optionsPayload.options || !optionsPayload.challengeId) throw new Error(optionsPayload.error ?? 'Unable to start WebAuthn reauthentication.')
      const response = await startAuthentication(optionsPayload.options)
      const verifyResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'reauth_verify', challengeId: optionsPayload.challengeId, response }) })
      const verifyPayload = await verifyResponse.json() as { error?: string }
      if (!verifyResponse.ok) throw new Error(verifyPayload.error ?? 'Unable to reauthenticate.')
      setNotice('WebAuthn reauthentication complete. High-risk actions are unlocked for 15 minutes.')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'WebAuthn reauthentication was cancelled.')
    } finally {
      setWorking(false)
    }
  }

  return <div className="admin-page">
    <header className="admin-header"><div><h1>Security controls</h1><p>Short-lived emergency access with independent approval</p></div><ShieldAlert size={22} aria-hidden="true" /></header>
    <section className="security-layout">
      <section className="security-card"><div className="broadcast-list-title"><div><h2>WebAuthn protection</h2><p>{mfa?.credentials.length ? `${mfa.credentials.length} security key${mfa.credentials.length === 1 ? '' : 's'} registered` : 'No security key registered'}</p></div><KeyRound size={20} aria-hidden="true" /></div><div className="admin-inline-actions"><button className="broadcast-primary" type="button" disabled={working} onClick={() => void registerSecurityKey()}>{mfa?.credentials.length ? 'Register another key' : 'Register security key'}</button>{Boolean(mfa?.credentials.length) && <button className="admin-row-action" type="button" disabled={working} onClick={() => void reauthenticate()}>Reauthenticate</button>}</div><small>High-risk changes require a fresh WebAuthn check. Reauthentication lasts 15 minutes.</small></section>
      <form className="security-card" onSubmit={(event) => { event.preventDefault(); openReasonDialog('request') }}><h2>Request temporary access</h2><label>Permission<select value={permission} onChange={(event) => setPermission(event.target.value)}>{permissions.map((item) => <option value={item} key={item}>{item}</option>)}</select></label><label>Duration (minutes)<input type="number" min="5" max="60" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><button className="broadcast-primary" type="submit">Request approval</button></form>
      <section className="security-card"><div className="broadcast-list-title"><h2>Active requests</h2><span role="status">{notice}</span></div>{!canApprove ? <p>Approval permission is required to inspect requests.</p> : grants.length ? grants.map((grant) => <article className="security-grant" key={grant.id}><div><strong>{grant.permission}</strong><small>{grant.approverId ? 'Approved' : 'Pending approval'} · expires {new Date(grant.expiresAt).toLocaleString()}</small></div>{!grant.approverId && <button className="admin-row-action" title="Approve temporary access" type="button" onClick={() => openReasonDialog('approve', grant)}><Check size={15} /></button>}</article>) : <p>No active temporary-access requests.</p>}</section>
    </section>
    {securityAction && <div className="security-dialog-backdrop"><form className="security-card security-dialog" role="dialog" aria-modal="true" onSubmit={(event) => void submitReason(event)}><h2>{securityAction === 'approve' ? 'Approve temporary access' : 'Request temporary access'}</h2><p>Record a reason in the audit log before continuing.</p><label>Reason<textarea required minLength={10} maxLength={500} rows={4} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label><div className="admin-inline-actions"><button className="admin-row-action" type="button" onClick={() => setSecurityAction(null)}>Cancel</button><button className="broadcast-primary" type="submit" disabled={working || reason.trim().length < 10}>{working ? 'Saving…' : 'Continue'}</button></div></form></div>}
  </div>
}
