'use client'

type AdminExportLinkProps = {
  resource: string
  params?: Record<string, string | undefined>
  label?: string
}

export function AdminExportLink({ resource, params, label = 'Export CSV' }: AdminExportLinkProps) {
  const query = new URLSearchParams({ resource })
  Object.entries(params ?? {}).forEach(([key, value]) => { if (value) query.set(key, value) })
  return <a className="admin-secondary" href={`/api/admin/v1/export?${query.toString()}`} download>{label}</a>
}
