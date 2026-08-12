import type { CSSProperties, ReactNode } from 'react'
import { Check, ChevronRight, ExternalLink, LoaderCircle, Search } from 'lucide-react'
import { C, type PopupLabels } from './popup-constants'

export function ActionRow({ icon, title, subtitle, onClick, loading, success }: { icon: ReactNode; title: string; subtitle: string; onClick: () => void; loading?: boolean; success?: boolean }) {
  return <button type="button" onClick={onClick} disabled={loading || success} style={{ display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '13px 12px', border: 'none', background: C.panel, textAlign: 'left', cursor: loading || success ? 'default' : 'pointer', color: C.navy, opacity: loading ? 0.72 : 1 }}>
    <span style={{ width: 40, height: 40, display: 'grid', placeItems: 'center', flexShrink: 0, border: `1px solid ${success ? '#BFE8D4' : C.border}`, borderRadius: 12, color: success ? C.green : C.primary, background: success ? C.greenBg : '#FCFCFF' }}>{success ? <Check size={20} strokeWidth={2.3} /> : icon}</span>
    <span style={{ flex: 1, minWidth: 0 }}><strong style={{ display: 'block', fontSize: 14, lineHeight: 1.25, fontWeight: 650 }}>{loading ? 'Analyzing…' : title}</strong><small style={{ display: 'block', marginTop: 4, fontSize: 11, lineHeight: 1.3, color: C.muted, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{subtitle}</small></span>
    {!loading && !success && <ChevronRight size={20} strokeWidth={1.9} color={C.muted} />}
    {loading && <LoaderCircle size={18} color={C.primary} className="am-spin" />}
  </button>
}

export function Divider() { return <div style={{ height: 1, margin: '0 12px', background: C.border }} /> }

export const primaryAction: CSSProperties = { display: 'flex', alignItems: 'center', gap: 11, width: '100%', padding: '13px 14px', border: 'none', borderRadius: 12, background: `linear-gradient(135deg, ${C.primary} 0%, #5B4BE8 100%)`, color: '#fff', cursor: 'pointer', boxShadow: '0 6px 14px rgba(81,70,229,0.24)', fontFamily: 'inherit' }
export const footerLink: CSSProperties = { display: 'inline-flex', alignItems: 'center', gap: 7, padding: 0, border: 'none', background: 'transparent', color: C.muted, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }
export const countPill: CSSProperties = { minWidth: 25, padding: '4px 7px', borderRadius: 999, background: '#EAEAFF', color: C.primary, fontWeight: 700, textAlign: 'center' }

export function InlineMessage({ text }: { text: string }) {
  return <div role="alert" style={{ marginTop: 10, padding: '9px 11px', borderRadius: 9, background: '#FFF2F2', color: '#B54747', fontSize: 11, lineHeight: 1.4 }}>{text}</div>
}

export function EmptyJob({ labels }: { labels: PopupLabels }) {
  return <section style={{ marginTop: 12, padding: '28px 20px', border: `1px solid ${C.border}`, borderRadius: 16, background: C.panel, boxShadow: C.shadow, textAlign: 'center' }}>
    <div style={{ width: 44, height: 44, display: 'grid', placeItems: 'center', margin: '0 auto 12px', borderRadius: 13, background: C.lavender, color: C.primary }}><Search size={22} strokeWidth={1.8} /></div>
    <h2 style={{ margin: 0, fontSize: 15, color: C.navy }}>{labels.noJobTitle}</h2>
    <p style={{ margin: '8px 0 18px', fontSize: 12, lineHeight: 1.55, color: C.muted }}>{labels.noJobSub}</p>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <a href="https://www.linkedin.com/jobs/" target="_blank" rel="noreferrer" style={{ color: C.primary, fontSize: 12, textDecoration: 'none', fontWeight: 650 }}>{labels.browseLinkedIn} <ExternalLink size={13} style={{ verticalAlign: '-2px' }} /></a>
      <a href="https://www.indeed.com/" target="_blank" rel="noreferrer" style={{ color: C.muted, fontSize: 12, textDecoration: 'none' }}>{labels.browseIndeed} <ExternalLink size={13} style={{ verticalAlign: '-2px' }} /></a>
    </div>
  </section>
}
