export default function AdminLoading() {
  return <div className="admin-page admin-route-loading" aria-busy="true" aria-live="polite">
    <div className="admin-placeholder" aria-hidden="true">
      <section style={{ height: 24, width: '34%', borderRadius: 8 }} />
      <section style={{ height: 160, width: '100%', borderRadius: 12 }} />
    </div>
  </div>
}
