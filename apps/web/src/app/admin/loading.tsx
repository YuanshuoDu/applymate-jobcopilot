export default function AdminLoading() {
  return <div className="admin-page admin-route-loading" aria-busy="true" aria-live="polite">
    <header className="admin-header">
      <div>
        <h1>Loading admin view…</h1>
        <p>Preparing the selected workspace.</p>
      </div>
    </header>
    <div className="admin-placeholder">
      <section>Loading secure operational data…</section>
    </div>
  </div>
}
