'use client'

import Link from 'next/link'
import { ArrowLeft, CalendarDays } from 'lucide-react'
import { useApi } from '@/lib/hooks'

type Detail = { user: { name: string | null; email: string; plan: string; location: string | null; createdAt: string; jobsCount: number; resumeExists: boolean; gmail: { connected: boolean; hasError: boolean } }; applications: { count: number; recent: Array<{ id: number; status: string; mode: string; atsType: string | null; flowUsed: string | null; durationMs: number | null; createdAt: string }> } }

export function AdminUserDetailPage({ userId }: { userId: string }) {
  const { data, loading, error } = useApi<Detail>(`/api/admin/v1/users/${userId}`)
  const user = data?.user
  return <div className="admin-page"><header className="admin-header"><div><Link className="admin-back" href="/admin/users"><ArrowLeft size={16} /> Users</Link><h1>{loading ? 'Loading user...' : user?.name ?? 'User'}</h1><p>Masked account metadata and safe operational history</p></div><div className="admin-header-time"><CalendarDays size={18} /> Internal console</div></header>
    {error ? <div className="admin-alert">{error}</div> : user && <section className="admin-detail"><div className="admin-detail-grid"><section><h2>Account</h2><dl><dt>Email</dt><dd>{user.email}</dd><dt>Plan</dt><dd>{user.plan}</dd><dt>Location</dt><dd>{user.location ?? 'Not provided'}</dd><dt>Joined</dt><dd>{new Date(user.createdAt).toLocaleString()}</dd></dl></section><section><h2>Safe status</h2><dl><dt>Jobs</dt><dd>{user.jobsCount}</dd><dt>Resume</dt><dd>{user.resumeExists ? 'On file' : 'Not uploaded'}</dd><dt>Gmail</dt><dd>{user.gmail.connected ? (user.gmail.hasError ? 'Needs attention' : 'Connected') : 'Not connected'}</dd><dt>Applications</dt><dd>{data.applications.count}</dd></dl></section></div><section className="admin-detail-history"><h2>Recent application metadata</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>Status</th><th>ATS</th><th>Flow</th><th>Mode</th><th>Created</th></tr></thead><tbody>{data.applications.recent.length === 0 ? <tr><td colSpan={5}>No application records.</td></tr> : data.applications.recent.map((item) => <tr key={item.id}><td>{item.status}</td><td>{item.atsType ?? 'unknown'}</td><td>{item.flowUsed ?? 'unknown'}</td><td>{item.mode}</td><td>{new Date(item.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div></section></section>}
  </div>
}
