'use client'

import { useEffect, useMemo, useState } from 'react'
import { Check, Plus, RefreshCw, Shield, UserX } from 'lucide-react'
import { ADMIN_PERMISSION_KEYS, type Permission } from '@/lib/admin/permissions'
import { useI18n } from '@/lib/i18n'

export interface PermissionItem { key: string; domain: string; label: string }
export interface RoleItem { id: string; key: string; name: string; permissions: string[]; system: boolean; version: number }
export interface MemberItem { id: string; userId: string; status: string; sessionVersion: number; role: { key: string; name: string; permissions: string[] }; user: { email: string; name: string; plan: string } }

export function groupPermissions(items: PermissionItem[]) {
  const groups = new Map<string, PermissionItem[]>()
  for (const item of items) groups.set(item.domain, [...(groups.get(item.domain) ?? []), item])
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([domain, values]) => ({ domain, items: values.sort((a, b) => a.key.localeCompare(b.key)) }))
}

function idempotencyKey() {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `admin-${Date.now()}`
}

export function AccessPage() {
  const { t } = useI18n()
  const [permissions, setPermissions] = useState<PermissionItem[]>([])
  const [roles, setRoles] = useState<RoleItem[]>([])
  const [members, setMembers] = useState<MemberItem[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [draft, setDraft] = useState<string[]>([])
  const [name, setName] = useState('')
  const [reason, setReason] = useState('')
  const [newKey, setNewKey] = useState('')
  const [tab, setTab] = useState<'roles' | 'matrix'>('roles')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const selected = roles.find(role => role.id === selectedId)
  const groups = useMemo(() => groupPermissions(permissions), [permissions])

  async function load() {
    setLoading(true); setError('')
    try {
      const [permissionResponse, roleResponse, memberResponse] = await Promise.all([
        fetch('/api/admin/v1/access/permissions', { cache: 'no-store' }),
        fetch('/api/admin/v1/access/roles', { cache: 'no-store' }),
        fetch('/api/admin/v1/access/members', { cache: 'no-store' }),
      ])
      if (![permissionResponse, roleResponse, memberResponse].every(response => response.ok)) throw new Error('Unable to load admin access data')
      const permissionBody = await permissionResponse.json() as { permissions?: PermissionItem[] }
      const roleBody = await roleResponse.json() as { items?: RoleItem[] }
      const memberBody = await memberResponse.json() as { items?: MemberItem[] }
      setPermissions(permissionBody.permissions ?? [])
      setRoles(roleBody.items ?? [])
      setMembers(memberBody.items ?? [])
      const first = roleBody.items?.[0]
      if (first) { setSelectedId(current => current || first.id); setName(first.name); setDraft(first.permissions) }
    } catch (loadError) { setError(loadError instanceof Error ? loadError.message : 'Unable to load admin access data') }
    finally { setLoading(false) }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => { if (selected) { setName(selected.name); setDraft(selected.permissions) } }, [selectedId, selected])

  async function saveRole() {
    if (!selected || reason.trim().length < 10) { setError('Add a 10-500 character reason before saving'); return }
    setSaving(true); setError('')
    try {
      const response = await fetch(`/api/admin/v1/access/roles/${selected.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: window.location.origin, 'Idempotency-Key': idempotencyKey() }, body: JSON.stringify({ name, permissions: draft, version: selected.version, reason: reason.trim() }) })
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? 'Role update failed')
      await load(); setReason('')
    } catch (saveError) { setError(saveError instanceof Error ? saveError.message : 'Role update failed') }
    finally { setSaving(false) }
  }

  async function createRole() {
    if (!newKey.trim() || !name.trim() || reason.trim().length < 10) { setError('Key, name and a 10-500 character reason are required'); return }
    setSaving(true); setError('')
    try {
      const response = await fetch('/api/admin/v1/access/roles', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: window.location.origin, 'Idempotency-Key': idempotencyKey() }, body: JSON.stringify({ key: newKey.trim(), name, permissions: draft, reason: reason.trim() }) })
      if (!response.ok) throw new Error((await response.json() as { error?: string }).error ?? 'Role creation failed')
      setNewKey(''); setReason(''); await load()
    } catch (createError) { setError(createError instanceof Error ? createError.message : 'Role creation failed') }
    finally { setSaving(false) }
  }

  async function updateMember(member: MemberItem, status: string, roleId: string) {
    const memberReason = window.prompt('Reason (10-500 characters)')?.trim() ?? ''
    if (memberReason.length < 10) return
    const role = roles.find(item => item.id === roleId)
    if (!role) return
    const response = await fetch(`/api/admin/v1/access/members/${member.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', Origin: window.location.origin, 'Idempotency-Key': idempotencyKey() }, body: JSON.stringify({ status, roleId, version: member.sessionVersion, reason: memberReason }) })
    if (response.ok) await load(); else setError((await response.json() as { error?: string }).error ?? 'Member update failed')
  }

  async function revoke(member: MemberItem) {
    const memberReason = window.prompt('Reason (10-500 characters)')?.trim() ?? ''
    if (memberReason.length < 10) return
    const response = await fetch(`/api/admin/v1/access/members/${member.id}/revoke-sessions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: window.location.origin, 'Idempotency-Key': idempotencyKey() }, body: JSON.stringify({ reason: memberReason }) })
    if (response.ok) await load(); else setError((await response.json() as { error?: string }).error ?? 'Session revoke failed')
  }

  if (loading) return <div style={{ color: 'var(--text-muted)' }}>{t('access.loading')}</div>
  return <div style={{ maxWidth: 1180, margin: '0 auto' }}>
    <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, marginBottom: 22 }}><div><div style={{ color: '#5b6b80', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em' }}>{t('access.security')}</div><h1 style={{ margin: '5px 0 0', fontSize: 26 }}>{t('access.title')}</h1><p style={{ margin: '6px 0 0', color: '#5b6b80' }}>{t('access.description')}</p></div><button type="button" onClick={() => void load()} title={t('access.refresh')} style={{ border: '1px solid #ccd7e3', background: '#fff', color: '#31475f', padding: 9, borderRadius: 6, cursor: 'pointer' }}><RefreshCw size={16} aria-hidden="true" /></button></header>
    {error && <div role="alert" style={{ marginBottom: 14, padding: 10, border: '1px solid #e6b8b8', color: '#a32d2d', background: '#fff8f8', borderRadius: 6 }}>{error}</div>}
    <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}><button type="button" onClick={() => setTab('roles')} aria-pressed={tab === 'roles'} style={tabButton(tab === 'roles')}>{t('access.roleEditor')}</button><button type="button" onClick={() => setTab('matrix')} aria-pressed={tab === 'matrix'} style={tabButton(tab === 'matrix')}>{t('access.permissionMatrix')}</button></div>
    {tab === 'roles' ? <>
      <section style={sectionStyle}><div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 14 }}><label style={labelStyle}>{t('access.role')}<select value={selectedId} onChange={event => setSelectedId(event.target.value)} style={inputStyle}>{roles.map(role => <option key={role.id} value={role.id}>{role.name} {role.system ? '(system)' : ''}</option>)}</select></label><label style={labelStyle}>{t('access.newKey')}<input value={newKey} onChange={event => setNewKey(event.target.value)} placeholder="custom_support" style={inputStyle} /></label><label style={labelStyle}>{t('access.name')}<input value={name} onChange={event => setName(event.target.value)} style={inputStyle} /></label></div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 14 }}>{groups.map(group => <fieldset key={group.domain} style={{ border: '1px solid #d9e2ec', borderRadius: 6, padding: 12 }}><legend style={{ padding: '0 5px', fontWeight: 700 }}>{group.domain.replaceAll('_', ' ')}</legend>{group.items.map(item => <label key={item.key} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', fontSize: 12 }}><input type="checkbox" checked={draft.includes(item.key)} onChange={event => setDraft(current => event.target.checked ? [...current, item.key] : current.filter(value => value !== item.key))} />{item.label}</label>)}</fieldset>)}</div>
        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'end', flexWrap: 'wrap' }}><label style={{ ...labelStyle, flex: 1, minWidth: 220 }}>{t('access.reason')}<input value={reason} onChange={event => setReason(event.target.value)} placeholder={t('access.reasonPlaceholder')} style={inputStyle} /></label>{newKey.trim() ? <button type="button" onClick={() => void createRole()} disabled={saving} style={primaryButton}><Plus size={14} aria-hidden="true" /> {t('access.createRole')}</button> : <button type="button" onClick={() => void saveRole()} disabled={saving || !selected} style={primaryButton}><Check size={14} aria-hidden="true" /> {t('access.saveRole')}</button>}</div>
      </section>
      <section style={sectionStyle}><h2 style={headingStyle}>Administrator members</h2><div style={{ overflowX: 'auto' }}><table style={tableStyle}><thead><tr><th>Member</th><th>Role</th><th>Status</th><th>Session</th><th /></tr></thead><tbody>{members.map(member => <tr key={member.id}><td><strong>{member.user.name || 'Unnamed'}</strong><span style={{ display: 'block', color: '#687b90', fontSize: 11 }}>{member.user.email}</span></td><td><select value={roles.find(role => role.key === member.role.key)?.id ?? ''} onChange={event => void updateMember(member, member.status, event.target.value)} style={compactInput}>{member.role.name}</select></td><td><select value={member.status} onChange={event => void updateMember(member, event.target.value, roles.find(role => role.key === member.role.key)?.id ?? '')} style={compactInput}><option value="active">Active</option><option value="suspended">Suspended</option><option value="revoked">Revoked</option></select></td><td>v{member.sessionVersion}</td><td><button type="button" title="Revoke sessions" onClick={() => void revoke(member)} style={iconButton}><UserX size={15} aria-hidden="true" /></button></td></tr>)}</tbody></table></div></section>
    </> : <section style={sectionStyle}><h2 style={headingStyle}>Read-only permission matrix</h2><div style={{ overflowX: 'auto' }}><table style={tableStyle}><thead><tr><th>Permission</th>{roles.map(role => <th key={role.id}>{role.name}</th>)}</tr></thead><tbody>{ADMIN_PERMISSION_KEYS.map(key => <tr key={key}><td>{key}</td>{roles.map(role => <td key={role.id} style={{ textAlign: 'center' }}>{role.permissions.includes(key) ? <Check size={15} color="#138a5b" aria-label="Granted" /> : '—'}</td>)}</tr>)}</tbody></table></div></section>}
  </div>
}

const sectionStyle = { background: '#fff', border: '1px solid #d9e2ec', borderRadius: 8, padding: 18, marginBottom: 16 }
const headingStyle = { margin: '0 0 14px', fontSize: 16 }
const tableStyle = { width: '100%', borderCollapse: 'collapse' as const, fontSize: 12 }
const labelStyle = { display: 'grid', gap: 6, fontSize: 11, color: '#687b90', fontWeight: 700 }
const inputStyle = { minHeight: 34, border: '1px solid #c9d5e1', borderRadius: 5, padding: '0 9px', background: '#fff', color: '#172033', font: 'inherit' }
const compactInput = { minHeight: 30, border: '1px solid #c9d5e1', borderRadius: 5, padding: '0 5px', background: '#fff', color: '#172033', font: 'inherit' }
const primaryButton = { display: 'inline-flex', alignItems: 'center', gap: 6, minHeight: 34, border: 0, borderRadius: 6, padding: '0 13px', background: '#146c94', color: '#fff', cursor: 'pointer', fontWeight: 700 }
const iconButton = { width: 30, height: 30, display: 'inline-grid', placeItems: 'center', border: '1px solid #c9d5e1', borderRadius: 5, background: '#fff', color: '#a32d2d', cursor: 'pointer' }
function tabButton(active: boolean) { return { border: `1px solid ${active ? '#146c94' : '#c9d5e1'}`, borderRadius: 6, background: active ? '#e7f3f8' : '#fff', color: active ? '#0b5778' : '#516579', padding: '8px 12px', cursor: 'pointer', fontWeight: 700 } }
