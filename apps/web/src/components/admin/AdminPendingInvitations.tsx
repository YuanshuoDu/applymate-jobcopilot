'use client'

import { XCircle } from 'lucide-react'
import React from 'react'
import { useI18n } from '@/lib/i18n'

export type PendingAdminInvitation = { id: string; email: string; status: string; expiresAt: string; createdAt: string; role: { key: string; name: string } }

export function AdminPendingInvitations({ invitations, onRevoke }: { invitations: PendingAdminInvitation[]; onRevoke: (invitation: PendingAdminInvitation) => void }) {
  const { t } = useI18n()
  if (invitations.length === 0) return null
  return <section className="admin-detail-history"><h2>{t('access.pendingInvitations')}</h2><div className="admin-table-wrap"><table className="admin-table"><thead><tr><th>{t('access.email')}</th><th>{t('access.role')}</th><th>{t('access.expires')}</th><th aria-label={t('access.actions')} /></tr></thead><tbody>{invitations.map(invitation => <tr key={invitation.id}><td>{invitation.email}</td><td>{invitation.role.name}</td><td>{new Date(invitation.expiresAt).toLocaleString()}</td><td><button className="admin-row-action" type="button" title={t('access.revokeInvitation')} aria-label={`${t('access.revokeInvitation')} ${invitation.email}`} onClick={() => onRevoke(invitation)}><XCircle size={15} aria-hidden="true" /></button></td></tr>)}</tbody></table></div></section>
}
