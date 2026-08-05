'use client'

import { KeyRound, ShieldCheck } from 'lucide-react'
import { useEffect, useState } from 'react'

type Member = { id: string; status: string; mfaLevel: string; sessionVersion: number; grantedAt: string; user: { name: string | null; email: string }; role: { key: string; name: string } }

export function AdminAccessPage({ canRevoke }: { canRevoke: boolean }) {
  const [items, setItems] = useState<Member[]>([])
  const [notice, setNotice] = useState('')
  async function load() {
    const response = await fetch('/api/admin/v1/access/members', { cache: 'no-store' })
    const payload = await response.json().catch(() => null) as { items?: Member[]; error?: string } | null
    setItems(payload?.items ?? [])
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load admin members.')
  }
  useEffect(() => { void load() }, [])
  async function revoke(member: Member) {
    const response = await fetch(`/api/admin/v1/access/members/${member.id}/revoke-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ sessionVersion: member.sessionVersion, reason: 'Revoking active internal sessions for security review' }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) setNotice(payload?.error ?? 'Unable to revoke sessions.')
    else { setNotice('Sessions revoked.'); await load() }
  }
  return <div className="admin-page"><header className="admin-header"><div><h1>Access</h1><p>Internal members, roles and session controls</p></div><ShieldCheck size={22} aria-hidden="true" /></header><section className="admin-list-page">{notice && <div className="admin-alert">{notice}</div>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Member</th><th>Role</th><th>Status</th><th>MFA</th><th>Sessions</th><th>Granted</th><th aria-label="Actions" /></tr></thead><tbody>{items.length === 0 ? <tr><td colSpan={7}>No internal members.</td></tr> : items.map((member) => <tr key={member.id}><td>{member.user.name ?? 'Unnamed'} · {member.user.email}</td><td>{member.role.name}</td><td>{member.status}</td><td>{member.mfaLevel}</td><td>v{member.sessionVersion}</td><td>{new Date(member.grantedAt).toLocaleString()}</td><td>{canRevoke && member.status === 'active' && <button className="admin-row-action" title="Revoke sessions" onClick={() => void revoke(member)}><KeyRound size={15} /></button>}</td></tr>)}</tbody></table></div></section></div>
}
