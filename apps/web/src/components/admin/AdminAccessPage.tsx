'use client'

import { KeyRound, ShieldCheck } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useAdminPrompt } from './AdminPromptDialog'

type Member = { id: string; status: string; mfaLevel: string; sessionVersion: number; grantedAt: string; user: { name: string | null; email: string }; role: { key: string; name: string } }
type Role = { id: string; key: string; name: string; permissions: string[]; system: boolean }
type Review = { id: string; userId: string; status: string; mfaLevel: string; role: { key: string; name: string }; user: { name: string | null; email: string }; review: { id: string | null; status: string; reviewedAt: string | null; notes: string | null } }
type Invitation = { id: string; email: string; status: string; expiresAt: string; createdAt: string; role: { key: string; name: string } }

export function AdminAccessPage({ canRevoke, canManage, canManageRoles = false, canReview = false }: { canRevoke: boolean; canManage: boolean; canManageRoles?: boolean; canReview?: boolean }) {
  const [items, setItems] = useState<Member[]>([])
  const [roles, setRoles] = useState<Role[]>([])
  const [notice, setNotice] = useState('')
  const [newEmail, setNewEmail] = useState('')
  const [newRole, setNewRole] = useState('')
  const [availablePermissions, setAvailablePermissions] = useState<string[]>([])
  const [roleKey, setRoleKey] = useState('')
  const [roleName, setRoleName] = useState('')
  const [rolePermissions, setRolePermissions] = useState('')
  const [reviews, setReviews] = useState<Review[]>([])
  const [reviewId, setReviewId] = useState('')
  const [reviewStatus, setReviewStatus] = useState('approved')
  const [reviewReason, setReviewReason] = useState('')
  const [reviewNotes, setReviewNotes] = useState('')
  const [invitations, setInvitations] = useState<Invitation[]>([])
  const [inviteUrl, setInviteUrl] = useState('')
  const { request, dialog } = useAdminPrompt()
  async function load() {
    const [response, roleResponse, reviewResponse, invitationResponse] = await Promise.all([fetch('/api/admin/v1/access/members', { cache: 'no-store' }), fetch('/api/admin/v1/access/roles', { cache: 'no-store' }), canReview ? fetch('/api/admin/v1/access/reviews', { cache: 'no-store' }) : Promise.resolve(null), canManage ? fetch('/api/admin/v1/access/invitations', { cache: 'no-store' }) : Promise.resolve(null)])
    const payload = await response.json().catch(() => null) as { items?: Member[]; error?: string } | null
    const rolePayload = await roleResponse.json().catch(() => null) as { roles?: Role[]; permissions?: string[]; error?: string } | null
    setItems(payload?.items ?? [])
    setRoles(rolePayload?.roles ?? [])
    setAvailablePermissions(rolePayload?.permissions ?? [])
    if (invitationResponse) { const invitationPayload = await invitationResponse.json().catch(() => null) as { invitations?: Invitation[] } | null; setInvitations(invitationPayload?.invitations ?? []) }
    if (reviewResponse) { const reviewPayload = await reviewResponse.json().catch(() => null) as { reviews?: Review[] } | null; setReviews(reviewPayload?.reviews ?? []) }
    if (!response.ok) setNotice(payload?.error ?? 'Unable to load admin members.')
    else if (!roleResponse.ok) setNotice(rolePayload?.error ?? 'Unable to load admin roles.')
  }
  useEffect(() => { void load() }, [])
  async function revoke(member: Member) {
    const response = await fetch(`/api/admin/v1/access/members/${member.id}/revoke-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ sessionVersion: member.sessionVersion, reason: 'Revoking active internal sessions for security review' }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok) setNotice(payload?.error ?? 'Unable to revoke sessions.')
    else { setNotice('Sessions revoked.'); await load() }
  }
  async function update(member: Member, roleKey: string, status: string) {
    const reason = await request({ title: 'Update administrator access', label: 'Audit reason', kind: 'reason' })
    if (!reason) return
    const response = await fetch(`/api/admin/v1/access/members/${member.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ roleKey, status, sessionVersion: member.sessionVersion, reason }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? 'Access updated and active sessions invalidated.' : payload?.error ?? 'Unable to update access.')
    if (response.ok) await load()
  }
  async function addMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = await request({ title: 'Grant administrator access', label: 'Audit reason', kind: 'reason' })
    if (!reason || !newEmail || !newRole) return
    const response = await fetch('/api/admin/v1/access/members', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ email: newEmail, roleKey: newRole, reason }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    if (!response.ok && response.status === 404) {
      const invitationResponse = await fetch('/api/admin/v1/access/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ email: newEmail, roleKey: newRole, reason }) })
      const invitationPayload = await invitationResponse.json().catch(() => null) as { error?: string; inviteUrl?: string } | null
      setNotice(invitationResponse.ok ? `Account not found; invitation created: ${invitationPayload?.inviteUrl ?? ''}` : invitationPayload?.error ?? 'Unable to grant or invite admin access.')
      if (invitationResponse.ok) setInviteUrl(invitationPayload?.inviteUrl ?? '')
      if (invitationResponse.ok) { setNewEmail(''); setNewRole(''); await load() }
      return
    }
    setNotice(response.ok ? 'Admin member granted.' : payload?.error ?? 'Unable to grant admin access.')
    if (response.ok) { setNewEmail(''); setNewRole(''); await load() }
  }
  async function inviteMember() {
    const reason = await request({ title: 'Invite administrator', label: 'Audit reason', kind: 'reason', description: 'The invitation is one-time and expires after seven days.' })
    if (!reason || !newEmail || !newRole) return
    const response = await fetch('/api/admin/v1/access/invitations', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ email: newEmail, roleKey: newRole, reason }) })
    const payload = await response.json().catch(() => null) as { error?: string; inviteUrl?: string } | null
    setNotice(response.ok ? 'Invitation created. Copy the one-time link before closing this screen.' : payload?.error ?? 'Unable to create invitation.')
    if (response.ok) { setInviteUrl(payload?.inviteUrl ?? ''); setNewEmail(''); setNewRole(''); await load() }
  }
  async function addRole(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const reason = await request({ title: 'Create custom role', label: 'Audit reason', kind: 'reason' })
    if (!reason) return
    const response = await fetch('/api/admin/v1/access/roles', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ key: roleKey, name: roleName, permissions: rolePermissions.split(',').map(item => item.trim()).filter(Boolean), reason }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? 'Custom role created.' : payload?.error ?? 'Unable to create role.')
    if (response.ok) { setRoleKey(''); setRoleName(''); setRolePermissions(''); await load() }
  }
  async function submitReview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const review = reviews.find((item) => item.id === reviewId)
    if (!review || reviewReason.trim().length < 10) return
    const response = await fetch('/api/admin/v1/access/reviews', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': crypto.randomUUID() }, body: JSON.stringify({ membershipId: review.id, status: reviewStatus, notes: reviewNotes, reason: reviewReason.trim() }) })
    const payload = await response.json().catch(() => null) as { error?: string } | null
    setNotice(response.ok ? 'Access review recorded.' : payload?.error ?? 'Unable to record access review.')
    if (response.ok) { setReviewReason(''); setReviewNotes(''); await load() }
  }
  return <div className="admin-page"><header className="admin-header"><div><h1>Access</h1><p>Internal members, roles and session controls</p></div><ShieldCheck size={22} aria-hidden="true" /></header><section className="admin-list-page">{notice && <div className="admin-alert">{notice}</div>}{canManage && <form className="admin-filter-panel" onSubmit={(event) => void addMember(event)}><label>Existing user email<input type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} placeholder="person@example.com" required /></label><label>Role<select value={newRole} onChange={(event) => setNewRole(event.target.value)} required><option value="">Select role</option>{roles.map((role) => <option key={role.key} value={role.key}>{role.name}</option>)}</select></label><button className="admin-primary-button" type="submit">Grant access</button></form>}{canManageRoles && <form className="admin-filter-panel" onSubmit={(event) => void addRole(event)}><label>Role key<input value={roleKey} onChange={(event) => setRoleKey(event.target.value)} placeholder="incident_manager" required /></label><label>Display name<input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="Incident manager" required /></label><label>Permissions<input value={rolePermissions} onChange={(event) => setRolePermissions(event.target.value)} placeholder={availablePermissions.slice(0, 3).join(', ')} required /></label><button className="admin-primary-button" type="submit">Create custom role</button></form>}<div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Member</th><th>Role</th><th>Status</th><th>MFA</th><th>Sessions</th><th>Granted</th><th aria-label="Actions" /></tr></thead><tbody>{items.length === 0 ? <tr><td colSpan={7}>No internal members.</td></tr> : items.map((member) => <tr key={member.id}><td>{member.user.name ?? 'Unnamed'} · {member.user.email}</td><td>{canManage ? <select aria-label={`Role for ${member.user.email}`} value={member.role.key} onChange={(event) => void update(member, event.target.value, member.status)}>{roles.map((role) => <option key={role.key} value={role.key}>{role.name}</option>)}</select> : member.role.name}</td><td>{canManage ? <select aria-label={`Status for ${member.user.email}`} value={member.status} onChange={(event) => void update(member, member.role.key, event.target.value)}><option value="active">active</option><option value="suspended">suspended</option><option value="revoked">revoked</option></select> : member.status}</td><td>{member.mfaLevel}</td><td>v{member.sessionVersion}</td><td>{new Date(member.grantedAt).toLocaleString()}</td><td>{canRevoke && member.status === 'active' && <button className="admin-row-action" title="Revoke sessions" onClick={() => void revoke(member)}><KeyRound size={15} /></button>}</td></tr>)}</tbody></table></div>{canReview && <section className="admin-detail-history access-review-section"><div><h2>Quarterly access review</h2><p>Every active administrator must be reviewed by a different administrator.</p></div><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Member</th><th>Role</th><th>Review</th><th>Action</th></tr></thead><tbody>{reviews.map((review) => <tr key={review.id}><td>{review.user.name ?? 'Unnamed'} · {review.user.email}</td><td>{review.role.name}</td><td>{review.review.status}{review.review.reviewedAt ? ` · ${new Date(review.review.reviewedAt).toLocaleDateString()}` : ''}</td><td><button className="admin-row-action" type="button" onClick={() => setReviewId(review.id)}>Review</button></td></tr>)}</tbody></table></div>{reviewId && <form className="admin-filter-panel" onSubmit={(event) => void submitReview(event)}><label>Decision<select value={reviewStatus} onChange={(event) => setReviewStatus(event.target.value)}><option value="approved">Approve</option><option value="exception">Exception</option><option value="revoked">Revoke access</option></select></label><label>Reason<textarea required minLength={10} maxLength={500} value={reviewReason} onChange={(event) => setReviewReason(event.target.value)} /></label><label>Notes<textarea maxLength={2000} value={reviewNotes} onChange={(event) => setReviewNotes(event.target.value)} /></label><button className="admin-primary-button" type="submit" disabled={reviewReason.trim().length < 10}>Record review</button></form>}</section>}<section className="admin-role-matrix"><div><h2>Role permission matrix</h2><p>Permissions are loaded from the server allow-list; system roles remain protected.</p></div>{canManageRoles && roles.map(role => <article key={role.id}><strong>{role.name}</strong><small>{role.system ? 'System role' : 'Custom role'} · {role.permissions.length} permissions</small><span>{role.permissions.join(' · ')}</span></article>)}</section></section>{dialog}</div>
}
