export default function AdminOverviewPage() {
  return <div style={{ maxWidth: 980, margin: '0 auto' }}><div style={{ color: '#5b6b80', fontSize: 11, textTransform: 'uppercase', letterSpacing: '.08em' }}>Operations console</div><h1 style={{ margin: '5px 0 8px', fontSize: 28 }}>Admin overview</h1><p style={{ color: '#5b6b80', margin: 0 }}>Use the navigation to manage access and review platform operations.</p><div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 14, marginTop: 24 }}><OverviewTile title="Access control" detail="Dynamic roles, permissions and session revocation." href="/admin/access" /><OverviewTile title="Commercial controls" detail="Plan catalogue and manual adjustments are next in the rollout." /><OverviewTile title="Platform AI" detail="Provider metadata is managed without exposing secrets." /></div></div>
}

function OverviewTile({ title, detail, href }: { title: string; detail: string; href?: string }) {
  const body = <div style={{ minHeight: 116, padding: 16, background: '#fff', border: '1px solid #d9e2ec', borderRadius: 8 }}><h2 style={{ margin: '0 0 8px', fontSize: 15 }}>{title}</h2><p style={{ margin: 0, color: '#5b6b80', lineHeight: 1.5 }}>{detail}</p>{href && <span style={{ display: 'inline-block', marginTop: 12, color: '#146c94', fontWeight: 700, fontSize: 12 }}>Open access →</span>}</div>
  return href ? <a href={href} style={{ color: 'inherit', textDecoration: 'none' }}>{body}</a> : body
}
