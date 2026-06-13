'use client'

import React, { createContext, useCallback, useContext, useState } from 'react'
import type { JobStatus } from '@/lib/types'

export { UserAvatar } from './UserAvatar'

// ─── Status config — Liquid Glass palette ──────────────────────────────────────
export const STATUS_CONFIG: Record<JobStatus, { label: string; color: string; bg: string; glow: string }> = {
  saved:     { label: 'Saved',      color: '#64748B', bg: 'rgba(100,116,139,0.12)', glow: 'rgba(100,116,139,0.20)' },
  applied:   { label: 'Applied',    color: '#4F46E5', bg: 'rgba(79,70,229,0.12)',   glow: 'rgba(79,70,229,0.22)'  },
  review:    { label: 'In Review',  color: '#D97706', bg: 'rgba(217,119,6,0.12)',   glow: 'rgba(217,119,6,0.22)'  },
  interview: { label: 'Interview',  color: '#059669', bg: 'rgba(5,150,105,0.12)',   glow: 'rgba(5,150,105,0.22)'  },
  offer:     { label: 'Offer',      color: '#0284C7', bg: 'rgba(2,132,199,0.12)',   glow: 'rgba(2,132,199,0.22)'  },
  rejected:  { label: 'Rejected',   color: '#DC2626', bg: 'rgba(220,38,38,0.10)',   glow: 'rgba(220,38,38,0.20)'  },
}

// ─── StatusBadge — glass pill ─────────────────────────────────────────────────
export function StatusBadge({ status }: { status: JobStatus }) {
  const cfg = STATUS_CONFIG[status]
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 5,
      background: cfg.bg,
      color: cfg.color,
      borderRadius: 999,
      padding: '2px 9px',
      fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap',
      border: `1px solid ${cfg.glow}`,
      letterSpacing: '0.01em',
    }}>
      <span style={{
        width: 5, height: 5, borderRadius: '50%',
        background: cfg.color,
        boxShadow: `0 0 4px ${cfg.color}`,
        flexShrink: 0,
      }} />
      {cfg.label}
    </span>
  )
}

// ─── MatchScoreRing ────────────────────────────────────────────────────────────
export function MatchScoreRing({
  score,
  size = 'md',
  showLabel = false,
}: {
  score: number
  size?: 'sm' | 'md' | 'lg'
  showLabel?: boolean
}) {
  const sizes = { sm: 36, md: 48, lg: 64 }
  const px = sizes[size]
  const strokeW = 3
  const r = (px - strokeW * 2) / 2
  const circ = 2 * Math.PI * r
  const offset = circ - (score / 100) * circ
  const color = score >= 80 ? '#059669' : score >= 60 ? '#D97706' : '#DC2626'
  const fontSize = size === 'sm' ? 10 : size === 'lg' ? 14 : 11
  const [animated, setAnimated] = useState(false)
  React.useEffect(() => {
    const t = setTimeout(() => setAnimated(true), 50)
    return () => clearTimeout(t)
  }, [])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
      <svg width={px} height={px} style={{ transform: 'rotate(-90deg)' }}>
        <circle cx={px/2} cy={px/2} r={r} fill="none" stroke="rgba(0,0,0,0.07)" strokeWidth={strokeW} />
        <circle cx={px/2} cy={px/2} r={r} fill="none" stroke={color} strokeWidth={strokeW}
          strokeLinecap="round"
          strokeDasharray={circ}
          strokeDashoffset={animated ? offset : circ}
          style={{ transition: 'stroke-dashoffset 0.7s cubic-bezier(.4,0,.2,1)', filter: `drop-shadow(0 0 3px ${color}80)` }} />
        <text x={px/2} y={px/2} textAnchor="middle" dominantBaseline="central"
          style={{ fontSize, fontWeight: 600, fill: color, transform: 'rotate(90deg)', transformOrigin: `${px/2}px ${px/2}px` }}>
          {score}%
        </text>
      </svg>
      {showLabel && <span style={{ fontSize: 9, color: 'var(--text-muted)', letterSpacing: '0.02em' }}>match</span>}
    </div>
  )
}

// ─── Toast — Glass Notification ───────────────────────────────────────────────
interface ToastItem { id: number; variant: 'success'|'info'|'warning'|'error'; title: string; description?: string }
interface ToastCtx { success(t: string, d?: string): void; info(t: string, d?: string): void; warning(t: string, d?: string): void; error(t: string, d?: string): void }

const ToastContext = createContext<ToastCtx | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const add = useCallback((variant: ToastItem['variant'], title: string, description?: string) => {
    const id = Date.now()
    setToasts(t => [...t, { id, variant, title, description }])
    setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 4200)
  }, [])
  const ctx: ToastCtx = {
    success: (t, d) => add('success', t, d),
    info:    (t, d) => add('info', t, d),
    warning: (t, d) => add('warning', t, d),
    error:   (t, d) => add('error', t, d),
  }
  const variantStyle = {
    success: { icon: '✓', color: '#059669', bg: 'rgba(5,150,105,0.12)',  border: 'rgba(5,150,105,0.25)',  glow: 'rgba(5,150,105,0.15)'  },
    info:    { icon: 'i', color: '#4F46E5', bg: 'rgba(79,70,229,0.12)',  border: 'rgba(79,70,229,0.25)',  glow: 'rgba(79,70,229,0.15)'  },
    warning: { icon: '!', color: '#D97706', bg: 'rgba(217,119,6,0.12)',  border: 'rgba(217,119,6,0.25)',  glow: 'rgba(217,119,6,0.15)'  },
    error:   { icon: '✕', color: '#DC2626', bg: 'rgba(220,38,38,0.10)',  border: 'rgba(220,38,38,0.22)',  glow: 'rgba(220,38,38,0.12)'  },
  }
  return (
    <ToastContext.Provider value={ctx}>
      {children}
      <div style={{ position: 'fixed', bottom: 20, right: 20, zIndex: 9999, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {toasts.map(t => {
          const vs = variantStyle[t.variant]
          return (
            <div key={t.id} style={{
              width: 320,
              background: 'var(--glass-modal)',
              backdropFilter: 'blur(20px) saturate(180%)',
              WebkitBackdropFilter: 'blur(20px) saturate(180%)',
              border: `1px solid ${vs.border}`,
              borderRadius: 12,
              padding: '12px 14px',
              display: 'flex', alignItems: 'flex-start', gap: 12,
              boxShadow: `0 8px 24px rgba(0,0,0,0.12), 0 0 0 1px ${vs.glow}`,
              animation: 'slideUp 0.22s cubic-bezier(.4,0,.2,1)',
            }}>
              <div style={{
                width: 30, height: 30, borderRadius: 8,
                background: vs.bg, color: vs.color, border: `1px solid ${vs.border}`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontWeight: 700, fontSize: 13, flexShrink: 0,
                boxShadow: `0 0 8px ${vs.glow}`,
              }}>
                {vs.icon}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{t.title}</div>
                {t.description && <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>{t.description}</div>}
                <div style={{ marginTop: 8, height: 2, background: 'var(--border)', borderRadius: 999, overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: `linear-gradient(90deg, ${vs.color}, ${vs.color}80)`, borderRadius: 999, animation: 'drain 4s linear forwards' }} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be inside ToastProvider')
  return ctx
}

// ─── Btn — Premium Glass Button ───────────────────────────────────────────────
type BtnVariant = 'primary' | 'ghost' | 'danger' | 'success' | 'glass'

export function Btn({
  variant = 'ghost',
  onClick,
  children,
  style = {},
  disabled = false,
  small = false,
}: {
  variant?: BtnVariant
  onClick?: () => void
  children: React.ReactNode
  style?: React.CSSProperties
  disabled?: boolean
  small?: boolean
}) {
  const [hovered, setHovered] = useState(false)

  const variants: Record<BtnVariant, React.CSSProperties> = {
    primary: {
      background: hovered
        ? 'linear-gradient(135deg, #4338CA 0%, #6D28D9 100%)'
        : 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)',
      color: '#fff',
      border: '1px solid rgba(255,255,255,0.20)',
      boxShadow: hovered
        ? '0 6px 20px rgba(79,70,229,0.45), 0 2px 6px rgba(0,0,0,0.15), inset 0 1px 0 rgba(255,255,255,0.20)'
        : '0 2px 8px rgba(79,70,229,0.30), 0 1px 3px rgba(0,0,0,0.10), inset 0 1px 0 rgba(255,255,255,0.15)',
    },
    ghost: {
      background: hovered ? 'var(--glass-bg-hover)' : 'var(--glass-bg)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      color: 'var(--text)',
      border: '1px solid var(--border-glass)',
      boxShadow: hovered ? 'var(--shadow-sm)' : 'none',
    },
    glass: {
      background: hovered ? 'rgba(79,70,229,0.12)' : 'rgba(79,70,229,0.08)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      color: 'var(--primary)',
      border: '1px solid rgba(79,70,229,0.20)',
      boxShadow: hovered ? '0 2px 8px rgba(79,70,229,0.15)' : 'none',
    },
    danger: {
      background: hovered ? 'rgba(220,38,38,0.12)' : 'rgba(220,38,38,0.08)',
      color: '#DC2626',
      border: '1px solid rgba(220,38,38,0.25)',
      boxShadow: hovered ? '0 2px 8px rgba(220,38,38,0.15)' : 'none',
    },
    success: {
      background: hovered ? 'rgba(5,150,105,0.14)' : 'rgba(5,150,105,0.10)',
      color: '#059669',
      border: '1px solid rgba(5,150,105,0.25)',
      boxShadow: hovered ? '0 2px 8px rgba(5,150,105,0.15)' : 'none',
    },
  }

  return (
    <button
      onClick={disabled ? undefined : onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
        borderRadius: 8,
        fontSize: small ? 11 : 12, fontWeight: 500,
        display: 'inline-flex', alignItems: 'center', gap: 6,
        padding: small ? '4px 10px' : '7px 14px', whiteSpace: 'nowrap',
        transition: 'all 0.18s cubic-bezier(.4,0,.2,1)',
        opacity: disabled ? 0.45 : 1,
        letterSpacing: '0.01em',
        ...variants[variant],
        ...style,
      }}>
      {children}
    </button>
  )
}

// ─── Card — Liquid Glass Card ──────────────────────────────────────────────────
export function Card({ children, style = {}, onClick, onMouseEnter, onMouseLeave }: {
  children: React.ReactNode
  style?: React.CSSProperties
  onClick?: () => void
  onMouseEnter?: React.MouseEventHandler<HTMLDivElement>
  onMouseLeave?: React.MouseEventHandler<HTMLDivElement>
}) {
  return (
    <div
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        background: 'var(--glass-card)',
        backdropFilter: 'var(--glass-blur-sm)',
        WebkitBackdropFilter: 'var(--glass-blur-sm)',
        border: '1px solid var(--border-glass)',
        borderRadius: 14,
        boxShadow: 'var(--shadow-md)',
        cursor: onClick ? 'pointer' : undefined,
        transition: 'box-shadow 0.2s, transform 0.2s',
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// ─── Divider ──────────────────────────────────────────────────────────────────
export function Divider({ style = {} }: { style?: React.CSSProperties }) {
  return <div style={{ height: '1px', background: 'var(--border)', ...style }} />
}

// ─── CompanyLogo ─────────────────────────────────────────────────────────────
export function CompanyLogo({ logo, size = 24 }: { logo: string; size?: number }) {
  const isUrl = logo?.startsWith('http')
  return (
    <div style={{
      width: size, height: size, borderRadius: 7,
      background: 'linear-gradient(135deg, rgba(79,70,229,0.10) 0%, rgba(124,58,237,0.10) 100%)',
      border: '1px solid rgba(79,70,229,0.15)',
      flexShrink: 0, overflow: 'hidden',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      {isUrl ? (
        <img src={logo} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }}
          onError={e => { (e.target as HTMLImageElement).style.display = 'none' }} />
      ) : (
        <span style={{ fontSize: size * 0.38, fontWeight: 700, color: 'var(--primary)' }}>
          {logo.slice(0, 4).toUpperCase()}
        </span>
      )}
    </div>
  )
}

// ─── ScorePill — Glass Score ─────────────────────────────────────────────────
export function ScorePill({ score }: { score: number | null }) {
  if (score == null) return (
    <span style={{
      fontSize: 11, color: 'var(--text-muted)',
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border)',
      borderRadius: 999, padding: '2px 8px',
    }}>
      —
    </span>
  )
  const color  = score >= 80 ? '#059669' : score >= 60 ? '#D97706' : '#DC2626'
  const bg     = score >= 80 ? 'rgba(5,150,105,0.12)' : score >= 60 ? 'rgba(217,119,6,0.12)' : 'rgba(220,38,38,0.10)'
  const border = score >= 80 ? 'rgba(5,150,105,0.25)' : score >= 60 ? 'rgba(217,119,6,0.25)' : 'rgba(220,38,38,0.22)'
  const glow   = score >= 80 ? 'rgba(5,150,105,0.20)' : score >= 60 ? 'rgba(217,119,6,0.20)' : 'rgba(220,38,38,0.18)'
  return (
    <span style={{
      fontSize: 11, fontWeight: 600, color, background: bg,
      border: `1px solid ${border}`,
      borderRadius: 999, padding: '2px 8px',
      boxShadow: `0 0 6px ${glow}`,
    }}>
      {score}%
    </span>
  )
}

// ─── INPUT_STYLE — Glass Input ────────────────────────────────────────────────
export const INPUT_STYLE: React.CSSProperties = {
  width:        '100%',
  padding:      '8px 11px',
  fontSize:     12,
  border:       '1px solid var(--border)',
  borderRadius: 8,
  background:   'var(--glass-bg)',
  backdropFilter: 'blur(8px)',
  color:        'var(--text)',
  outline:      'none',
  boxSizing:    'border-box',
  transition:   'border-color 0.15s, box-shadow 0.15s',
}

// ─── ConfirmDialog ────────────────────────────────────────────────────────────
/**
 * In-design-system replacement for window.confirm.
 *
 * Usage:
 *   const [confirm, ConfirmDialog] = useConfirm()
 *   // in JSX: <ConfirmDialog />
 *   // to trigger: await confirm({ title, message, danger })
 */
interface ConfirmOptions {
  title:    string
  message:  string
  /** If true, the confirm button renders in danger style (default: false) */
  danger?:  boolean
  confirmLabel?: string
  cancelLabel?:  string
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

export function useConfirm(): [ConfirmFn, React.FC] {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null)

  const confirm: ConfirmFn = useCallback(
    (opts) =>
      new Promise<boolean>((resolve) => {
        setState({ ...opts, resolve })
      }),
    [],
  )

  const Dialog: React.FC = useCallback(() => {
    if (!state) return null

    function finish(value: boolean) {
      state!.resolve(value)
      setState(null)
    }

    return (
      <div
        style={{
          position: 'fixed', inset: 0, zIndex: 200,
          background: 'rgba(0,0,0,0.35)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
        onClick={() => finish(false)}
      >
        <div
          onClick={e => e.stopPropagation()}
          style={{
            background: 'var(--bg)', border: '0.5px solid var(--border)',
            borderRadius: 12, width: 380, padding: 24,
            boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          }}
        >
          {/* Icon + Title */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
            {state.danger && (
              <div style={{
                width: 32, height: 32, borderRadius: 8,
                background: 'rgba(163,45,45,0.12)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, flexShrink: 0,
              }}>⚠</div>
            )}
            <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>{state.title}</span>
          </div>

          {/* Message */}
          <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '0 0 20px', lineHeight: 1.6 }}>
            {state.message}
          </p>

          {/* Actions */}
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <Btn variant="ghost" onClick={() => finish(false)}>
              {state.cancelLabel ?? 'Cancel'}
            </Btn>
            <Btn variant={state.danger ? 'danger' : 'primary'} onClick={() => finish(true)}
              style={state.danger ? { background: 'rgba(163,45,45,0.12)', fontWeight: 600 } : {}}>
              {state.confirmLabel ?? 'Confirm'}
            </Btn>
          </div>
        </div>
      </div>
    )
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state])

  return [confirm, Dialog]
}