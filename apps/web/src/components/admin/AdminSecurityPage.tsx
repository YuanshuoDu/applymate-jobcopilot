'use client'

import { startAuthentication, startRegistration } from '@simplewebauthn/browser'
import { Check, KeyRound, ShieldAlert } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'
import { adminMutationHeaders } from '@/lib/admin/client'
import { useI18n } from '@/lib/i18n'

type Grant = { id: string; requesterId: string; approverId: string | null; permission: string; expiresAt: string; createdAt: string }
type SecurityAction = 'request' | 'approve' | null
type WebAuthnStatus = { mfaLevel: 'none' | 'webauthn'; credentials: Array<{ id: string; deviceName: string | null; deviceType: string | null; createdAt: string; lastUsedAt: string | null }> }
const permissions = ['queues.pause', 'ats.pause', 'ai_budget.reset', 'feature_flags.approve', 'broadcasts.publish']

function requestHeaders() {
  return adminMutationHeaders()
}

function webAuthnErrorMessage(error: unknown, fallback: string, t: (key: string) => string) {
  const message = error instanceof Error ? error.message : ''
  return /notallowederror|does not have focus|not allowed at this time/i.test(message)
    ? t('adminSecurity.focusWebAuthn')
    : message || fallback
}

export function AdminSecurityPage({ canRequest = false, canApprove }: { canRequest?: boolean; canApprove: boolean }) {
  const { t } = useI18n()
  const [grants, setGrants] = useState<Grant[]>([])
  const [permission, setPermission] = useState(permissions[0])
  const [minutes, setMinutes] = useState(15)
  const [notice, setNotice] = useState('')
  const [securityAction, setSecurityAction] = useState<SecurityAction>(null)
  const [selectedGrant, setSelectedGrant] = useState<Grant | null>(null)
  const [reason, setReason] = useState('')
  const [mfa, setMfa] = useState<WebAuthnStatus | null>(null)
  const [working, setWorking] = useState(false)
  const { request, dialog } = useAdminPrompt()

  const load = useCallback(async () => {
    const [grantResponse, mfaResponse] = await Promise.all([
      canApprove ? fetch('/api/admin/v1/break-glass', { cache: 'no-store' }) : Promise.resolve(null),
      fetch('/api/admin/v1/security/webauthn', { cache: 'no-store' }),
    ])
    if (grantResponse) {
      const payload = await grantResponse.json().catch(() => null) as { grants?: Grant[]; error?: string } | null
      setGrants(payload?.grants ?? [])
      if (!grantResponse.ok) setNotice(payload?.error ?? t('adminSecurity.loadFailed'))
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
    setNotice(response.ok ? securityAction === 'approve' ? t('adminSecurity.accessApproved') : t('adminSecurity.requestSent') : payload?.error ?? t('adminSecurity.actionFailed'))
    setWorking(false)
    setSecurityAction(null)
    if (response.ok) await load()
  }

  async function registerSecurityKey() {
    setWorking(true)
    try {
      const optionsResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'register_options' }) })
      const optionsPayload = await optionsResponse.json() as { options?: Parameters<typeof startRegistration>[0]; challengeId?: string; error?: string }
      if (!optionsResponse.ok || !optionsPayload.options || !optionsPayload.challengeId) throw new Error(optionsPayload.error ?? t('adminSecurity.startRegistrationFailed'))
      const response = await startRegistration(optionsPayload.options)
      const verifyResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'register_verify', challengeId: optionsPayload.challengeId, response, deviceName: 'Administrator security key' }) })
      const verifyPayload = await verifyResponse.json() as { error?: string }
      if (!verifyResponse.ok) throw new Error(verifyPayload.error ?? t('adminSecurity.verifyKeyFailed'))
      setNotice(t('adminSecurity.keyRegistered'))
      await load()
    } catch (error) {
      setNotice(webAuthnErrorMessage(error, t('adminSecurity.registrationCancelled'), t))
    } finally {
      setWorking(false)
    }
  }

  async function reauthenticate() {
    setWorking(true)
    try {
      const optionsResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'reauth_options' }) })
      const optionsPayload = await optionsResponse.json() as { options?: Parameters<typeof startAuthentication>[0]; challengeId?: string; error?: string }
      if (!optionsResponse.ok || !optionsPayload.options || !optionsPayload.challengeId) throw new Error(optionsPayload.error ?? t('adminSecurity.startReauthFailed'))
      const response = await startAuthentication(optionsPayload.options)
      const verifyResponse = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'reauth_verify', challengeId: optionsPayload.challengeId, response }) })
      const verifyPayload = await verifyResponse.json() as { error?: string }
      if (!verifyResponse.ok) throw new Error(verifyPayload.error ?? t('adminSecurity.reauthFailed'))
      setNotice(t('adminSecurity.reauthComplete'))
    } catch (error) {
      setNotice(webAuthnErrorMessage(error, t('adminSecurity.reauthCancelled'), t))
    } finally {
      setWorking(false)
    }
  }

  async function revokeSecurityKey(credentialId: string) {
    const confirmation = await request({ title: t('adminSecurity.revokeKey'), label: t('adminSecurity.reason'), kind: 'reason', description: t('adminSecurity.revokeDescription'), submitLabel: t('adminSecurity.revoke') })
    if (!confirmation) return
    setWorking(true)
    const response = await fetch('/api/admin/v1/security/webauthn', { method: 'POST', headers: requestHeaders(), body: JSON.stringify({ action: 'revoke', credentialId, reason: confirmation }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? t('adminSecurity.keyRevoked') : payload?.error ?? t('adminSecurity.revokeFailed'))
    setWorking(false)
    if (response.ok) await load()
  }

  return <><div className="admin-page">
    <header className="admin-header"><div><h1>{t('adminSecurity.title')}</h1><p>{t('adminSecurity.description')}</p></div><ShieldAlert size={22} aria-hidden="true" /></header>
    <section className="security-layout">
      <section className="security-card"><div className="broadcast-list-title"><div><h2>{t('adminSecurity.webAuthn')}</h2><p>{mfa?.credentials.length ? `${mfa.credentials.length} ${t('adminSecurity.securityKeysRegistered')}` : t('adminSecurity.noSecurityKey')}</p></div><KeyRound size={20} aria-hidden="true" /></div><div className="admin-inline-actions"><button className="broadcast-primary" type="button" disabled={working} onClick={() => void registerSecurityKey()}>{mfa?.credentials.length ? t('adminSecurity.registerAnother') : t('adminSecurity.registerKey')}</button>{Boolean(mfa?.credentials.length) && <button className="admin-row-action" type="button" disabled={working} onClick={() => void reauthenticate()}>{t('adminSecurity.reauthenticate')}</button>}</div><div className="security-key-list">{mfa?.credentials.map((credential) => <article className="security-grant" key={credential.id}><div><strong>{credential.deviceName ?? t('adminSecurity.unnamedKey')}</strong><small>{t('adminSecurity.added')} {new Date(credential.createdAt).toLocaleDateString()} · {credential.lastUsedAt ? `${t('adminSecurity.lastUsed')} ${new Date(credential.lastUsedAt).toLocaleString()}` : t('adminSecurity.notUsed')}</small></div><button className="admin-row-action" type="button" disabled={working} onClick={() => void revokeSecurityKey(credential.id)}>{t('adminSecurity.revoke')}</button></article>)}</div><small>{t('adminSecurity.highRiskDescription')}</small></section>
      {canRequest && <form className="security-card" onSubmit={(event) => { event.preventDefault(); openReasonDialog('request') }}><h2>{t('adminSecurity.requestAccess')}</h2><label>{t('adminSecurity.permission')}<select value={permission} onChange={(event) => setPermission(event.target.value)}>{permissions.map((item) => <option value={item} key={item}>{item}</option>)}</select></label><label>{t('adminSecurity.duration')}<input type="number" min="5" max="60" value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} /></label><button className="broadcast-primary" type="submit">{t('adminSecurity.requestApproval')}</button></form>}
      {(canRequest || canApprove) && <section className="security-card"><div className="broadcast-list-title"><h2>{t('adminSecurity.activeRequests')}</h2><span role="status">{notice}</span></div>{!canApprove ? <p>{t('adminSecurity.approvalRequired')}</p> : grants.length ? grants.map((grant) => <article className="security-grant" key={grant.id}><div><strong>{grant.permission}</strong><small>{grant.approverId ? t('adminSecurity.approved') : t('adminSecurity.pendingApproval')} · {t('adminSecurity.expires')} {new Date(grant.expiresAt).toLocaleString()}</small></div>{!grant.approverId && <button className="admin-row-action" title={t('adminSecurity.approveAccess')} type="button" onClick={() => openReasonDialog('approve', grant)}><Check size={15} /></button>}</article>) : <p>{t('adminSecurity.noActiveRequests')}</p>}</section>}
    </section>
    {securityAction && <div className="security-dialog-backdrop"><form className="security-card security-dialog" role="dialog" aria-modal="true" onSubmit={(event) => void submitReason(event)}><h2>{securityAction === 'approve' ? t('adminSecurity.approveAccess') : t('adminSecurity.requestAccess')}</h2><p>{t('adminSecurity.auditReason')}</p><label>{t('adminSecurity.reason')}<textarea required minLength={10} maxLength={500} rows={4} value={reason} onChange={(event) => setReason(event.target.value)} autoFocus /></label><div className="admin-inline-actions"><button className="admin-row-action" type="button" onClick={() => setSecurityAction(null)}>{t('common.cancel')}</button><button className="broadcast-primary" type="submit" disabled={working || reason.trim().length < 10}>{working ? t('adminUsers.saving') : t('adminPrompt.continue')}</button></div></form></div>}
  </div>{dialog}</>
}
