'use client'

import React, { useState, useEffect, useRef, useCallback } from 'react'
import Link from 'next/link'
import { Menu, X } from 'lucide-react'
import { useI18n } from '@/lib/i18n'
import { DEFAULT_PLAN_CATALOGUE, toPublicPlan, type PublicPlan } from '@/lib/plan-catalogue-shared'
import { FOOTER_COLUMNS, SOCIAL_LINKS, landingFeatureHref, landingPlanAction } from './landing-links'

// ── Design tokens ─────────────────────────────────────────────────────────────
const C = {
  bg:         '#080B14',
  glass:      'rgba(255,255,255,0.055)',
  glassBd:    'rgba(255,255,255,0.10)',
  glassBdStr: 'rgba(255,255,255,0.18)',
  text:       '#FFFFFF',
  textMuted:  'rgba(255,255,255,0.55)',
  textSubtle: 'rgba(255,255,255,0.30)',
  primary:    '#6366F1',
  blue:       '#818CF8',
  orange:     '#FB923C',
  green:      '#34D399',
  teal:       '#2DD4BF',
}

const gradientText: React.CSSProperties = {
  background: 'linear-gradient(135deg, #818CF8 0%, #C084FC 55%, #FB923C 100%)',
  WebkitBackgroundClip: 'text',
  WebkitTextFillColor: 'transparent',
  backgroundClip: 'text',
}

// ── Scroll-reveal hook ────────────────────────────────────────────────────────
function useReveal(threshold = 0.12) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([e]) => { if (e.isIntersecting) { setVisible(true); obs.disconnect() } },
      { threshold },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [threshold])
  return { ref, visible }
}

// ── Counter animation hook ────────────────────────────────────────────────────
function useCounter(target: number, duration = 1800, active = false) {
  const [val, setVal] = useState(0)
  useEffect(() => {
    if (!active) return
    const start = performance.now()
    const tick = (now: number) => {
      const p = Math.min((now - start) / duration, 1)
      const ease = 1 - Math.pow(1 - p, 3)
      setVal(Math.floor(ease * target))
      if (p < 1) requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  }, [active, target, duration])
  return val
}

// ── Reveal wrapper ────────────────────────────────────────────────────────────
function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  const { ref, visible } = useReveal()
  return (
    <div ref={ref} style={{
      opacity: visible ? 1 : 0,
      transform: visible ? 'translateY(0)' : 'translateY(28px)',
      transition: `opacity 0.65s ease ${delay}ms, transform 0.65s ease ${delay}ms`,
    }} className={className}>
      {children}
    </div>
  )
}

// ── Glass card ────────────────────────────────────────────────────────────────
function GlassCard({ children, style, gradient, border, hover = true }: {
  children: React.ReactNode; style?: React.CSSProperties
  gradient?: string; border?: string; hover?: boolean
}) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onMouseEnter={() => hover && setHov(true)}
      onMouseLeave={() => hover && setHov(false)}
      style={{
        background: gradient ?? C.glass,
        backdropFilter: 'blur(20px) saturate(180%)',
        WebkitBackdropFilter: 'blur(20px) saturate(180%)',
        border: `1px solid ${hov ? C.glassBdStr : (border ?? C.glassBd)}`,
        borderRadius: 20,
        transition: 'transform 0.25s ease, box-shadow 0.25s ease, border-color 0.2s',
        transform: hov ? 'translateY(-4px)' : 'none',
        boxShadow: hov
          ? '0 24px 64px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)'
          : '0 4px 24px rgba(0,0,0,0.30)',
        ...style,
      }}>
      {children}
    </div>
  )
}

// ── Section label ─────────────────────────────────────────────────────────────
function Label({ children, color = C.primary, bg = 'rgba(99,102,241,0.12)', bd = 'rgba(99,102,241,0.22)' }: {
  children: React.ReactNode; color?: string; bg?: string; bd?: string
}) {
  return (
    <div style={{
      display: 'inline-block', fontSize: 11, fontWeight: 700,
      letterSpacing: '0.12em', textTransform: 'uppercase' as const,
      color, background: bg, border: `1px solid ${bd}`,
      borderRadius: 999, padding: '4px 14px', marginBottom: 18,
    }}>{children}</div>
  )
}

// ── Data ──────────────────────────────────────────────────────────────────────
const FEATURES = [
  { icon: '🤖', titleKey: 'landing.feature.autoApply', page: 'agent' as const, descKey: 'landing.feature.autoApplyDesc', gradient: 'linear-gradient(135deg,rgba(99,102,241,.15) 0%,rgba(139,92,246,.08) 100%)', border: 'rgba(99,102,241,.28)' },
  { icon: '📄', titleKey: 'landing.feature.resume', page: 'resume' as const, descKey: 'landing.feature.resumeDesc', gradient: 'linear-gradient(135deg,rgba(251,146,60,.12) 0%,rgba(245,101,101,.06) 100%)', border: 'rgba(251,146,60,.25)' },
  { icon: '✉️', titleKey: 'landing.feature.coverLetter', page: 'resume' as const, descKey: 'landing.feature.coverLetterDesc', gradient: 'linear-gradient(135deg,rgba(52,211,153,.12) 0%,rgba(16,185,129,.06) 100%)', border: 'rgba(52,211,153,.25)' },
  { icon: '📬', titleKey: 'landing.feature.gmail', page: 'gmail' as const, descKey: 'landing.feature.gmailDesc', gradient: 'linear-gradient(135deg,rgba(129,140,248,.12) 0%,rgba(99,102,241,.06) 100%)', border: 'rgba(129,140,248,.25)' },
  { icon: '📊', titleKey: 'landing.feature.tracker', page: 'jobs' as const, descKey: 'landing.feature.trackerDesc', gradient: 'linear-gradient(135deg,rgba(251,191,36,.10) 0%,rgba(251,146,60,.06) 100%)', border: 'rgba(251,191,36,.22)' },
  { icon: '🔌', titleKey: 'landing.feature.extension', externalHref: 'https://github.com/YuanshuoDu/applymate-jobcopilot/tree/main/apps/extension', descKey: 'landing.feature.extensionDesc', gradient: 'linear-gradient(135deg,rgba(192,132,252,.12) 0%,rgba(139,92,246,.06) 100%)', border: 'rgba(192,132,252,.25)' },
]

const STEPS = [
  { num: '01', titleKey: 'landing.step.upload', descKey: 'landing.step.uploadDesc', icon: '📋' },
  { num: '02', titleKey: 'landing.step.search', descKey: 'landing.step.searchDesc', icon: '🤖' },
  { num: '03', titleKey: 'landing.step.track', descKey: 'landing.step.trackDesc', icon: '🎯' },
]

const TESTIMONIALS = [
  { name: 'Zhang Li', role: 'Backend Engineer', city: 'Amsterdam', avatar: 'ZL', color: '#4F46E5', textKey: 'landing.testimonial.zhang' },
  { name: 'Maria García', role: 'Data Scientist', city: 'Berlin', avatar: 'MG', color: '#7C3AED', textKey: 'landing.testimonial.maria' },
  { name: 'Ahmed Hassan', role: 'Product Manager', city: 'London', avatar: 'AH', color: '#059669', textKey: 'landing.testimonial.ahmed' },
]

const FAQS = [
  { qKey: 'landing.faq.freePlan', aKey: 'landing.faq.freePlanAnswer' },
  { qKey: 'landing.faq.autoApply', aKey: 'landing.faq.autoApplyAnswer' },
  { qKey: 'landing.faq.boards', aKey: 'landing.faq.boardsAnswer' },
  { qKey: 'landing.faq.safety', aKey: 'landing.faq.safetyAnswer' },
  { qKey: 'landing.faq.paidPlans', aKey: 'landing.faq.paidPlansAnswer' },
  { qKey: 'landing.faq.coverLetter', aKey: 'landing.faq.coverLetterAnswer' },
  { qKey: 'landing.faq.languages', aKey: 'landing.faq.languagesAnswer' },
]

const STATS_DATA = [
  { value: 50, suffix: 'K+', labelKey: 'landing.stat.jobs' },
  { value: 3,  suffix: '×',  labelKey: 'landing.stat.ats' },
  { value: 14, suffix: 'd',  labelKey: 'landing.stat.trial' },
  { value: 92, suffix: '%',  labelKey: 'landing.stat.satisfaction' },
]

const PLATFORMS = ['LinkedIn', 'Indeed', 'Glassdoor', 'StepStone', 'XING', 'Arbeitsagentur']

// ── Main component ────────────────────────────────────────────────────────────
const FALLBACK_PLANS = DEFAULT_PLAN_CATALOGUE.filter(plan => plan.active).map(toPublicPlan)

function planColor(key: PublicPlan['key']): string {
  return key === 'pro' ? '#818CF8' : key === 'enterprise' ? '#FB923C' : C.textMuted
}

function planPeriod(plan: PublicPlan): string {
  return plan.interval === 'forever' ? 'forever' : plan.interval === 'year' ? '/yr' : '/mo'
}

export function LandingPage({ plans = FALLBACK_PLANS }: { plans?: PublicPlan[] }) {
  const { t } = useI18n()
  const [scrolled, setScrolled]   = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [openFaq, setOpenFaq]     = useState<number | null>(null)
  const [contactForm, setContactForm] = useState({ name: '', email: '', message: '' })
  const [contactSent, setContactSent] = useState(false)
  const [contactError, setContactError] = useState<string | null>(null)
  const [sending, setSending]     = useState(false)
  const { ref: statsRef, visible: statsVisible } = useReveal(0.3)
  const proPlan = plans.find(plan => plan.key === 'pro')
  const proTrialDays = proPlan?.trialDays ?? 0
  const statsData = STATS_DATA.map(stat => stat.labelKey === 'landing.stat.trial' ? { ...stat, value: proTrialDays } : stat)

  useEffect(() => {
    const fn = () => setScrolled(window.scrollY > 60)
    window.addEventListener('scroll', fn, { passive: true })
    return () => window.removeEventListener('scroll', fn)
  }, [])

  useEffect(() => {
    if (!mobileMenuOpen) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileMenuOpen(false)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [mobileMenuOpen])

  const closeMobileMenu = useCallback(() => setMobileMenuOpen(false), [])
  const prepareContact = useCallback((message: string) => {
    setContactSent(false)
    setContactError(null)
    setContactForm(current => ({ ...current, message }))
  }, [])

  const handleContact = useCallback(async (e: React.FormEvent) => {
    e.preventDefault()
    setContactError(null)
    setSending(true)
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(contactForm),
      })
      const payload = await response.json().catch(() => ({})) as { error?: string }
      if (!response.ok) throw new Error(payload.error ?? 'We could not send your message. Please try again.')
      setContactSent(true)
      setContactForm({ name: '', email: '', message: '' })
    } catch (error) {
      setContactError(error instanceof Error ? error.message : 'We could not send your message. Please try again.')
    } finally {
      setSending(false)
    }
  }, [contactForm])

  return (
    <div style={{ background: C.bg, minHeight: '100vh', color: C.text, fontFamily: "'Inter', system-ui, sans-serif", overflowX: 'hidden' }}>

      {/* ── Global keyframes & utilities ──────────────────────────────── */}
      <style>{`
        @keyframes ambientDrift1 {
          0%,100% { transform: translate(0,0) scale(1); }
          33%      { transform: translate(40px,-30px) scale(1.08); }
          66%      { transform: translate(-20px,20px) scale(0.95); }
        }
        @keyframes ambientDrift2 {
          0%,100% { transform: translate(0,0) scale(1); }
          40%      { transform: translate(-50px,30px) scale(1.12); }
          70%      { transform: translate(30px,-20px) scale(0.92); }
        }
        @keyframes ambientDrift3 {
          0%,100% { transform: translate(-50%,-50%) scale(1); }
          50%      { transform: translate(-50%,-50%) scale(1.15); }
        }
        @keyframes floatBadge {
          0%,100% { transform: translateY(0); }
          50%      { transform: translateY(-7px); }
        }
        @keyframes floatDown {
          0%,100% { transform: translateX(-50%) translateY(0); }
          50%      { transform: translateX(-50%) translateY(8px); }
        }
        @keyframes pulseGlow {
          0%,100% { box-shadow: 0 0 0 0 rgba(99,102,241,0); }
          50%      { box-shadow: 0 0 0 8px rgba(99,102,241,0.18); }
        }
        @keyframes gradientShift {
          0%   { background-position: 0% 50%; }
          50%  { background-position: 100% 50%; }
          100% { background-position: 0% 50%; }
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes typewriter {
          from { width: 0; }
          to   { width: 100%; }
        }
        .hover-bright:hover { filter: brightness(1.15); }
        .btn-shine {
          position: relative; overflow: hidden;
        }
        .btn-shine::after {
          content:''; position:absolute; inset:0;
          background: linear-gradient(105deg, transparent 40%, rgba(255,255,255,0.18) 50%, transparent 60%);
          transform: translateX(-100%);
          transition: transform 0.5s ease;
        }
        .btn-shine:hover::after { transform: translateX(100%); }
        .landing-nav-links { display: flex; gap: 28px; font-size: 13px; align-items: center; }
        .landing-nav-actions { display: flex; gap: 10px; align-items: center; }
        .landing-menu-toggle { display: none; }
        .landing-mobile-menu { display: none; }
        @media (max-width: 780px) {
          .landing-nav-links, .landing-nav-actions { display: none !important; }
          .landing-menu-toggle { display: inline-flex !important; }
          .landing-mobile-menu { display: flex; }
          .landing-mobile-menu a { min-height: 42px; display: flex; align-items: center; }
        }
        @media (max-width: 560px) {
          .landing-header { padding-left: 12px !important; padding-right: 12px !important; }
          .landing-nav { padding-left: 14px !important; padding-right: 14px !important; }
          .landing-contact-fields { grid-template-columns: 1fr !important; }
        }
      `}</style>

      {/* ── Ambient lights (animated) ───────────────────────────────────── */}
      <div aria-hidden style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 0, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', width: 750, height: 750, borderRadius: '50%', background: 'radial-gradient(circle, rgba(124,58,237,0.26) 0%, transparent 70%)', top: -200, left: -100, animation: 'ambientDrift1 18s ease-in-out infinite' }} />
        <div style={{ position: 'absolute', width: 650, height: 650, borderRadius: '50%', background: 'radial-gradient(circle, rgba(180,60,10,0.24) 0%, transparent 70%)', bottom: -100, right: -80, animation: 'ambientDrift2 22s ease-in-out infinite' }} />
        <div style={{ position: 'absolute', width: 900, height: 450, borderRadius: '50%', background: 'radial-gradient(ellipse, rgba(59,130,246,0.12) 0%, transparent 70%)', top: '50%', left: '50%', animation: 'ambientDrift3 28s ease-in-out infinite' }} />
      </div>

      {/* ── Navbar ──────────────────────────────────────────────────────── */}
      <header className="landing-header" style={{ position: 'fixed', top: 0, left: 0, right: 0, zIndex: 100, padding: '12px 24px', transition: 'all 0.3s' }}>
        <nav style={{
          maxWidth: 1140, margin: '0 auto',
          background: scrolled ? 'rgba(8,11,20,0.88)' : 'rgba(255,255,255,0.05)',
          backdropFilter: 'blur(28px) saturate(200%)',
          WebkitBackdropFilter: 'blur(28px) saturate(200%)',
          border: `1px solid ${scrolled ? 'rgba(255,255,255,0.11)' : 'rgba(255,255,255,0.07)'}`,
          borderRadius: 16, padding: '10px 22px',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between', position: 'relative',
          boxShadow: scrolled ? '0 8px 40px rgba(0,0,0,0.45)' : 'none',
          transition: 'all 0.35s ease',
        }}>
          {/* Logo */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div style={{ width: 32, height: 32, borderRadius: 10, background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 14, fontWeight: 800, boxShadow: '0 4px 16px rgba(79,70,229,0.55)', animation: 'pulseGlow 3s ease-in-out infinite' }}>A</div>
            <div>
              <div style={{ fontSize: 14, fontWeight: 700, color: '#fff', lineHeight: 1.1 }}>ApplyMate AI</div>
              <div style={{ fontSize: 9, color: C.textSubtle, lineHeight: 1 }}>Job Copilot · Europe</div>
            </div>
          </div>

          {/* Links */}
          <div className="landing-nav-links">
            {[[ '#features', t('landing.features') ], [ '#how-it-works', t('landing.howItWorks') ], [ '#pricing', t('landing.pricing') ], [ '#faq', t('landing.faq') ], [ '#contact', t('landing.contact') ]].map(([href,label]) => (
              <a key={href} href={href} onClick={closeMobileMenu} style={{ color: C.textMuted, textDecoration: 'none', fontWeight: 500, transition: 'color 0.15s' }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = C.textMuted)}
              >{label}</a>
            ))}
          </div>

          {/* CTA */}
          <div className="landing-nav-actions">
            <Link href="/login" style={{ fontSize: 12, fontWeight: 600, color: C.textMuted, textDecoration: 'none', padding: '6px 14px', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 9, background: 'rgba(255,255,255,0.04)', transition: 'all 0.15s' }}
              onMouseEnter={e => { e.currentTarget.style.color='#fff'; e.currentTarget.style.borderColor='rgba(255,255,255,0.24)' }}
              onMouseLeave={e => { e.currentTarget.style.color=C.textMuted; e.currentTarget.style.borderColor='rgba(255,255,255,0.12)' }}
            >{t('landing.signIn')}</Link>
            <Link href="/register" className="btn-shine" style={{ fontSize: 12, fontWeight: 700, color: '#fff', textDecoration: 'none', padding: '7px 18px', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', borderRadius: 9, boxShadow: '0 4px 16px rgba(79,70,229,0.50)', transition: 'all 0.2s', letterSpacing: '0.01em' }}
              onMouseEnter={e => { e.currentTarget.style.transform='translateY(-1px)'; e.currentTarget.style.boxShadow='0 6px 22px rgba(79,70,229,0.65)' }}
              onMouseLeave={e => { e.currentTarget.style.transform='none'; e.currentTarget.style.boxShadow='0 4px 16px rgba(79,70,229,0.50)' }}
            >{t('landing.getStarted')}</Link>
          </div>

          <button
            type="button"
            className="landing-menu-toggle"
            aria-label={mobileMenuOpen ? t('landing.closeMenu') : t('landing.openMenu')}
            aria-expanded={mobileMenuOpen}
            aria-controls="landing-mobile-menu"
            onClick={() => setMobileMenuOpen(open => !open)}
            style={{ width: 38, height: 38, alignItems: 'center', justifyContent: 'center', color: '#fff', background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 10, cursor: 'pointer' }}
          >
            {mobileMenuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
          </button>

          {mobileMenuOpen && (
            <div id="landing-mobile-menu" className="landing-mobile-menu" style={{ position: 'absolute', top: 'calc(100% + 8px)', left: 0, right: 0, flexDirection: 'column', gap: 2, padding: 10, background: 'rgba(8,11,20,0.96)', backdropFilter: 'blur(24px)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 14, boxShadow: '0 18px 40px rgba(0,0,0,0.45)' }}>
              {[
                ['#features', t('landing.features')], ['#how-it-works', t('landing.howItWorks')], ['#pricing', t('landing.pricing')], ['#faq', t('landing.faq')], ['#contact', t('landing.contact')],
              ].map(([href, label]) => (
                <a key={href} href={href} onClick={closeMobileMenu} style={{ color: C.textMuted, textDecoration: 'none', fontSize: 13, fontWeight: 600, padding: '0 12px' }}>{label}</a>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, padding: '8px 0 0', borderTop: '1px solid rgba(255,255,255,0.08)', marginTop: 4 }}>
                <Link href="/login" onClick={closeMobileMenu} style={{ color: C.textMuted, textDecoration: 'none', fontSize: 12, fontWeight: 600, padding: '10px 12px', textAlign: 'center', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 9 }}>{t('landing.signIn')}</Link>
                <Link href="/register" onClick={closeMobileMenu} style={{ color: '#fff', textDecoration: 'none', fontSize: 12, fontWeight: 700, padding: '10px 12px', textAlign: 'center', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', borderRadius: 9 }}>{t('landing.getStartedShort')}</Link>
              </div>
            </div>
          )}
        </nav>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section style={{ position: 'relative', zIndex: 1, minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '120px 24px 80px' }}>

        {/* Floating platform badges */}
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 38 }}>
          {PLATFORMS.map((p, i) => (
            <span key={p} style={{
              fontSize: 11, fontWeight: 500,
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.12)',
              borderRadius: 999, padding: '4px 13px',
              color: C.textMuted, backdropFilter: 'blur(8px)',
              animation: `floatBadge ${2.8 + i * 0.4}s ease-in-out infinite`,
              animationDelay: `${i * 0.3}s`,
            }}>{p}</span>
          ))}
        </div>

        {/* Headline */}
        <h1 style={{ fontSize: 'clamp(42px, 7.5vw, 84px)', fontWeight: 900, lineHeight: 1.06, letterSpacing: '-0.045em', marginBottom: 26, maxWidth: 860 }}>
          <span style={gradientText}>{t('landing.heroLead')}</span>
          <br />
          <span style={{ color: '#fff' }}>{t('landing.hiredEurope')}</span>
        </h1>

        {/* Sub */}
        <p style={{ fontSize: 'clamp(15px, 2vw, 19px)', color: C.textMuted, maxWidth: 560, lineHeight: 1.72, marginBottom: 44 }}>
          {t('landing.heroDescription')}
          <br />{t('landing.heroDescription2')}
        </p>

        {/* CTA */}
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', justifyContent: 'center', marginBottom: 64 }}>
          <Link href="/register" className="btn-shine" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '15px 34px', fontSize: 15, fontWeight: 700, background: 'linear-gradient(135deg, #4F46E5 0%, #7C3AED 100%)', color: '#fff', borderRadius: 14, textDecoration: 'none', boxShadow: '0 6px 30px rgba(79,70,229,0.60), inset 0 1px 0 rgba(255,255,255,0.18)', letterSpacing: '0.01em', transition: 'all 0.22s' }}
            onMouseEnter={e => { e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow='0 10px 40px rgba(79,70,229,0.70), inset 0 1px 0 rgba(255,255,255,0.18)' }}
            onMouseLeave={e => { e.currentTarget.style.transform='none'; e.currentTarget.style.boxShadow='0 6px 30px rgba(79,70,229,0.60), inset 0 1px 0 rgba(255,255,255,0.18)' }}
          >🚀 {t('landing.startFree')}</Link>
          <a href="#features" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '15px 28px', fontSize: 15, fontWeight: 600, background: 'rgba(255,255,255,0.07)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.85)', borderRadius: 14, textDecoration: 'none', transition: 'all 0.2s' }}
            onMouseEnter={e => { e.currentTarget.style.background='rgba(255,255,255,0.13)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.26)' }}
            onMouseLeave={e => { e.currentTarget.style.background='rgba(255,255,255,0.07)'; e.currentTarget.style.borderColor='rgba(255,255,255,0.14)' }}
          >{t('landing.seeFeatures')}</a>
        </div>

        {/* Stats (animated counters) */}
        <div ref={statsRef} style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
          {statsData.map((s, i) => (
            <StatCard key={s.labelKey} {...s} active={statsVisible} delay={i * 180} />
          ))}
        </div>

        {/* Scroll cue */}
        <div style={{ position: 'absolute', bottom: 28, left: '50%', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, animation: 'floatDown 2.4s ease-in-out infinite' }}>
          <div style={{ fontSize: 10, color: C.textSubtle, letterSpacing: '0.06em', textTransform: 'uppercase' }}>{t('landing.scroll')}</div>
          <div style={{ width: 1, height: 36, background: 'linear-gradient(180deg, rgba(255,255,255,0.35), transparent)' }} />
        </div>
      </section>

      {/* ── Features ────────────────────────────────────────────────────── */}
      <section id="features" style={{ position: 'relative', zIndex: 1, padding: '90px 24px', maxWidth: 1140, margin: '0 auto' }}>
        <Reveal>
          <div style={{ textAlign: 'center', marginBottom: 60 }}>
            <Label>{t('landing.features')}</Label>
            <h2 style={{ fontSize: 'clamp(28px, 4vw, 46px)', fontWeight: 800, letterSpacing: '-0.035em', marginBottom: 14 }}>
              {t('landing.everyStep')}<br /><span style={gradientText}>{t('landing.handledByAi')}</span>
            </h2>
            <p style={{ fontSize: 15, color: C.textMuted, maxWidth: 480, margin: '0 auto', lineHeight: 1.75 }}>
              {t('landing.featuresDescription')}
            </p>
          </div>
        </Reveal>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 330px), 1fr))', gap: 18 }}>
          {FEATURES.map((f, i) => (
            <Reveal key={f.titleKey} delay={i * 80}>
              <a
                href={f.externalHref ?? landingFeatureHref(f.page)}
                {...(f.externalHref ? { target: '_blank', rel: 'noreferrer' } : {})}
                aria-label={t(f.titleKey)}
                style={{ display: 'block', height: '100%', textDecoration: 'none' }}
              >
                <GlassCard gradient={f.gradient} border={f.border} style={{ padding: '30px 26px', height: '100%' }}>
                  <div style={{ fontSize: 34, marginBottom: 16 }}>{f.icon}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#fff', marginBottom: 10 }}>{t(f.titleKey)}</div>
                  <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.75 }}>{t(f.descKey)}</div>
                </GlassCard>
              </a>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ── How it Works ────────────────────────────────────────────────── */}
      <section id="how-it-works" style={{ position: 'relative', zIndex: 1, padding: '90px 24px' }}>
        <div style={{ maxWidth: 960, margin: '0 auto' }}>
          <Reveal>
            <div style={{ textAlign: 'center', marginBottom: 60 }}>
              <Label color="#FB923C" bg="rgba(251,146,60,0.12)" bd="rgba(251,146,60,0.22)">{t('landing.howItWorks')}</Label>
              <h2 style={{ fontSize: 'clamp(28px, 4vw, 46px)', fontWeight: 800, letterSpacing: '-0.035em', marginBottom: 14 }}>
                {t('landing.howItWorks')}<span style={{ color: '#FB923C' }}> {t('landing.automatedHunting')}</span>
              </h2>
            </div>
          </Reveal>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 18 }}>
            {STEPS.map((s, i) => (
              <Reveal key={s.num} delay={i * 120}>
                <GlassCard style={{ padding: '34px 28px', position: 'relative', overflow: 'hidden', height: '100%' }}>
                  <div style={{ position: 'absolute', top: -12, right: -6, fontSize: 96, fontWeight: 900, color: 'rgba(255,255,255,0.04)', lineHeight: 1, userSelect: 'none', pointerEvents: 'none' }}>{s.num}</div>
                  <div style={{ fontSize: 34, marginBottom: 18 }}>{s.icon}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, color: C.textSubtle, letterSpacing: '0.12em', marginBottom: 8 }}>{t('landing.stepLabel')} {s.num}</div>
                  <div style={{ fontSize: 17, fontWeight: 700, color: '#fff', marginBottom: 12 }}>{t(s.titleKey)}</div>
                  <div style={{ fontSize: 13, color: C.textMuted, lineHeight: 1.75 }}>{t(s.descKey)}</div>
                </GlassCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Testimonials ────────────────────────────────────────────────── */}
      <section style={{ position: 'relative', zIndex: 1, padding: '90px 24px' }}>
        <div style={{ maxWidth: 1140, margin: '0 auto' }}>
          <Reveal>
            <div style={{ textAlign: 'center', marginBottom: 60 }}>
              <Label color={C.teal} bg="rgba(45,212,191,0.10)" bd="rgba(45,212,191,0.22)">{t('landing.successStories')}</Label>
              <h2 style={{ fontSize: 'clamp(28px, 4vw, 46px)', fontWeight: 800, letterSpacing: '-0.035em' }}>
                {t('landing.landedJob')} <span style={gradientText}>{t('landing.hiredEurope')}</span>
              </h2>
            </div>
          </Reveal>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: 18 }}>
            {TESTIMONIALS.map((testimonial, i) => (
              <Reveal key={testimonial.name} delay={i * 100}>
                <GlassCard style={{ padding: '28px 26px', height: '100%' }}>
                  <div style={{ fontSize: 28, color: 'rgba(255,255,255,0.12)', fontFamily: 'Georgia,serif', marginBottom: 10, lineHeight: 1 }}>&ldquo;</div>
                  <p style={{ fontSize: 13, color: 'rgba(255,255,255,0.80)', lineHeight: 1.80, marginBottom: 20 }}>{t(testimonial.textKey)}</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: `linear-gradient(135deg, ${testimonial.color}, ${testimonial.color}88)`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 700, color: '#fff', flexShrink: 0 }}>{testimonial.avatar}</div>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: '#fff' }}>{testimonial.name}</div>
                      <div style={{ fontSize: 11, color: C.textMuted }}>{testimonial.role} · {testimonial.city}</div>
                    </div>
                  </div>
                </GlassCard>
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ─────────────────────────────────────────────────────── */}
      <section id="pricing" style={{ position: 'relative', zIndex: 1, padding: '90px 24px' }}>
        <div style={{ maxWidth: 1020, margin: '0 auto' }}>
          <Reveal>
            <div style={{ textAlign: 'center', marginBottom: 60 }}>
              <Label color={C.green} bg="rgba(52,211,153,0.10)" bd="rgba(52,211,153,0.20)">{t('landing.pricing')}</Label>
              <h2 style={{ fontSize: 'clamp(28px, 4vw, 46px)', fontWeight: 800, letterSpacing: '-0.035em', marginBottom: 12 }}>
                {t('landing.simplePricing')}<span style={gradientText}> {t('landing.pricingWord')}</span>
              </h2>
              <p style={{ fontSize: 15, color: C.textMuted }}>{t('landing.trialDetails')}</p>
            </div>
          </Reveal>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: 18 }}>
            {plans.map((plan, i) => {
              const isPro = plan.key === 'pro'
              const action = landingPlanAction(plan.key)
              return (
                <Reveal key={plan.key} delay={i * 100}>
                  <GlassCard
                    gradient={isPro ? 'linear-gradient(145deg, rgba(99,102,241,0.18) 0%, rgba(139,92,246,0.12) 100%)' : C.glass}
                    border={isPro ? 'rgba(99,102,241,0.45)' : C.glassBd}
                    style={{ padding: '34px 28px', position: 'relative', height: '100%', display: 'flex', flexDirection: 'column' }}
                  >
                    {isPro && <div style={{ position: 'absolute', top: -1, left: 0, right: 0, height: 2, background: 'linear-gradient(90deg, transparent, #6366F1, #7C3AED, transparent)', borderRadius: '20px 20px 0 0' }} />}
                    {plan.badge && <div style={{ display: 'inline-block', marginBottom: 14, fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', color: '#fff', borderRadius: 999, padding: '3px 10px' }}>{plan.badge}</div>}
                    <div style={{ fontSize: 13, fontWeight: 600, color: planColor(plan.key), marginBottom: 6 }}>{plan.name}</div>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 4, marginBottom: 6 }}>
                      <span style={{ fontSize: 40, fontWeight: 900, color: '#fff', letterSpacing: '-0.045em' }}>{plan.price}</span>
                      <span style={{ fontSize: 13, color: C.textMuted }}>{planPeriod(plan)}</span>
                    </div>
                    <div style={{ fontSize: 12, color: C.textMuted, marginBottom: 10 }}>{plan.description}</div>
                    {plan.trialDays > 0 && <div style={{ fontSize: 11, color: C.green, marginBottom: 18 }}>{plan.trialDays}-{t('landing.freeTrial')}</div>}
                    <div style={{ flex: 1, marginBottom: 28 }}>
                      {plan.features.map(f => (
                        <div key={f} style={{ display: 'flex', alignItems: 'center', gap: 9, marginBottom: 11, fontSize: 13, color: 'rgba(255,255,255,0.82)' }}>
                          <span style={{ color: C.green, fontSize: 12, flexShrink: 0 }}>✓</span>{f}
                        </div>
                      ))}
                    </div>
                    <Link href={action.href} onClick={() => action.message && prepareContact(action.message)} className="btn-shine" style={{ display: 'block', textAlign: 'center', padding: '12px 20px', fontSize: 13, fontWeight: 700, borderRadius: 12, textDecoration: 'none', ...(isPro ? { background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', color: '#fff', boxShadow: '0 4px 20px rgba(79,70,229,0.50)' } : { background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)', color: 'rgba(255,255,255,0.82)' }), transition: 'all 0.18s' }}
                      onMouseEnter={e => { e.currentTarget.style.transform = 'translateY(-1px)' }}
                      onMouseLeave={e => { e.currentTarget.style.transform = 'none' }}
                  >{plan.cta}</Link>
                  </GlassCard>
                </Reveal>
              )
            })}
          </div>
        </div>
      </section>

      {/* ── FAQ ─────────────────────────────────────────────────────────── */}
      <section id="faq" style={{ position: 'relative', zIndex: 1, padding: '90px 24px' }}>
        <div style={{ maxWidth: 760, margin: '0 auto' }}>
          <Reveal>
            <div style={{ textAlign: 'center', marginBottom: 60 }}>
              <Label color="#C084FC" bg="rgba(192,132,252,0.10)" bd="rgba(192,132,252,0.22)">{t('landing.faq')}</Label>
              <h2 style={{ fontSize: 'clamp(28px, 4vw, 46px)', fontWeight: 800, letterSpacing: '-0.035em' }}>
                {t('landing.frequentlyAsked')} <span style={gradientText}>{t('landing.questions')}</span>
              </h2>
            </div>
          </Reveal>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {FAQS.map((faq, i) => (
              <Reveal key={i} delay={i * 50}>
                <FaqItem
                  question={t(faq.qKey)}
                  answer={t(faq.aKey)}
                  open={openFaq === i}
                  onToggle={() => setOpenFaq(openFaq === i ? null : i)}
                />
              </Reveal>
            ))}
          </div>
        </div>
      </section>

      {/* ── Contact ─────────────────────────────────────────────────────── */}
      <section id="contact" style={{ position: 'relative', zIndex: 1, padding: '90px 24px' }}>
        <div style={{ maxWidth: 700, margin: '0 auto' }}>
          <Reveal>
            <div style={{ textAlign: 'center', marginBottom: 50 }}>
              <Label color="#FB923C" bg="rgba(251,146,60,0.10)" bd="rgba(251,146,60,0.22)">{t('landing.contactLabel')}</Label>
              <h2 style={{ fontSize: 'clamp(28px, 4vw, 46px)', fontWeight: 800, letterSpacing: '-0.035em', marginBottom: 12 }}>
                {t('landing.question')}<span style={{ color: '#FB923C' }}> {t('landing.reachOut')}</span>
              </h2>
              <p style={{ fontSize: 15, color: C.textMuted, lineHeight: 1.7 }}>{t('landing.responseTime')} <span style={{ color: '#818CF8' }}>hello@applymate.ai</span></p>
            </div>
          </Reveal>

          <Reveal delay={100}>
            <GlassCard style={{ padding: '40px 36px' }}>
              {contactSent ? (
                <div style={{ textAlign: 'center', padding: '20px 0' }}>
                  <div style={{ fontSize: 48, marginBottom: 16 }}>✅</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: '#fff', marginBottom: 8 }}>{t('landing.messageSent')}</div>
                  <div style={{ fontSize: 13, color: C.textMuted }}>{t('landing.replyTime')}</div>
                  <button type="button" onClick={() => { setContactSent(false); setContactError(null) }} style={{ marginTop: 22, padding: '10px 16px', color: C.textMuted, background: 'rgba(255,255,255,0.07)', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 10, cursor: 'pointer', fontSize: 12, fontWeight: 600 }}>{t('landing.sendAnother')}</button>
                </div>
              ) : (
                <form onSubmit={handleContact} style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  <div className="landing-contact-fields" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
                    <InputField label={t('landing.name')} value={contactForm.name} onChange={v => setContactForm(f => ({ ...f, name: v }))} placeholder={t('landing.yourName')} required />
                    <InputField label={t('landing.email')} type="email" value={contactForm.email} onChange={v => setContactForm(f => ({ ...f, email: v }))} placeholder="your@email.com" required />
                  </div>
                  <InputField label={t('landing.message')} value={contactForm.message} onChange={v => setContactForm(f => ({ ...f, message: v }))} placeholder={t('landing.messagePlaceholder')} multiline required />
                  {contactError && <div role="alert" style={{ color: '#FCA5A5', fontSize: 12, lineHeight: 1.5, padding: '10px 12px', borderRadius: 9, background: 'rgba(220,38,38,0.12)', border: '1px solid rgba(248,113,113,0.25)' }}>{contactError}</div>}
                  <button type="submit" disabled={sending} className="btn-shine" style={{ padding: '13px 0', fontSize: 14, fontWeight: 700, background: sending ? 'rgba(99,102,241,0.5)' : 'linear-gradient(135deg, #4F46E5, #7C3AED)', color: '#fff', border: 'none', borderRadius: 12, cursor: sending ? 'not-allowed' : 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, boxShadow: '0 4px 20px rgba(79,70,229,0.45)', transition: 'all 0.2s' }}>
                    {sending ? (
                      <><div style={{ width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(255,255,255,0.3)', borderTopColor: '#fff', animation: 'spin 0.7s linear infinite' }} />{t('landing.sending')}</>
                    ) : `✉️ ${t('landing.sendMessage')}`}
                  </button>
                </form>
              )}
            </GlassCard>
          </Reveal>
        </div>
      </section>

      {/* ── Final CTA ───────────────────────────────────────────────────── */}
      <section style={{ position: 'relative', zIndex: 1, padding: '60px 24px 90px' }}>
        <div style={{ maxWidth: 720, margin: '0 auto' }}>
          <Reveal>
            <GlassCard style={{ padding: '60px 48px', textAlign: 'center' }} gradient="linear-gradient(135deg, rgba(79,70,229,0.17) 0%, rgba(124,58,237,0.11) 50%, rgba(251,146,60,0.09) 100%)" border="rgba(99,102,241,0.32)">
              <div style={{ fontSize: 'clamp(24px, 4vw, 40px)', fontWeight: 900, letterSpacing: '-0.035em', lineHeight: 1.2, marginBottom: 16 }}>
                {t('landing.nextOffer')}<br /><span style={gradientText}>{t('landing.startsHere')}</span>
              </div>
              <p style={{ fontSize: 14, color: C.textMuted, marginBottom: 36, lineHeight: 1.75 }}>
                {t('landing.joinSeekers')}<br />
                {proTrialDays > 0 ? `${proTrialDays} days free on Pro, no credit card required.` : t('landing.startFreePlan')}
              </p>
              <Link href="/register" className="btn-shine" style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '15px 40px', fontSize: 15, fontWeight: 700, background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', color: '#fff', borderRadius: 14, textDecoration: 'none', boxShadow: '0 6px 30px rgba(79,70,229,0.58)', transition: 'all 0.22s' }}
                onMouseEnter={e => { e.currentTarget.style.transform='translateY(-2px)'; e.currentTarget.style.boxShadow='0 10px 40px rgba(79,70,229,0.72)' }}
                onMouseLeave={e => { e.currentTarget.style.transform='none'; e.currentTarget.style.boxShadow='0 6px 30px rgba(79,70,229,0.58)' }}
              >🚀 {t('landing.startFree')}</Link>
            </GlassCard>
          </Reveal>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer style={{ position: 'relative', zIndex: 1, borderTop: '1px solid rgba(255,255,255,0.06)', padding: '48px 24px 36px' }}>
        <div style={{ maxWidth: 1140, margin: '0 auto', display: 'flex', flexWrap: 'wrap', gap: 36, justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ maxWidth: 240 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
              <div style={{ width: 28, height: 28, borderRadius: 8, background: 'linear-gradient(135deg, #4F46E5, #7C3AED)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontSize: 12, fontWeight: 800 }}>A</div>
              <span style={{ fontSize: 14, fontWeight: 700, color: '#fff' }}>ApplyMate AI</span>
            </div>
            <p style={{ fontSize: 12, color: C.textSubtle, lineHeight: 1.75 }}>{t('landing.aiFooter')}</p>
            <div style={{ display: 'flex', gap: 10, marginTop: 18 }}>
              {SOCIAL_LINKS.map(link => (
                <a key={link.label} href={link.href} {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})} style={{ fontSize: 11, color: C.textSubtle, textDecoration: 'none', background: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 7, padding: '4px 9px', transition: 'all 0.15s' }}
                  onMouseEnter={e => { e.currentTarget.style.color='#fff'; e.currentTarget.style.borderColor='rgba(255,255,255,0.22)' }}
                  onMouseLeave={e => { e.currentTarget.style.color=C.textSubtle; e.currentTarget.style.borderColor='rgba(255,255,255,0.10)' }}
                >{link.label}</a>
              ))}
            </div>
          </div>

          {FOOTER_COLUMNS.map(col => (
            <div key={col.title}>
              <div style={{ fontSize: 11, fontWeight: 700, color: C.textSubtle, letterSpacing: '0.08em', textTransform: 'uppercase', marginBottom: 14 }}>{col.title}</div>
              {col.links.map(link => (
                <div key={link.label} style={{ marginBottom: 9 }}>
                  <a href={link.href} {...(link.external ? { target: '_blank', rel: 'noreferrer' } : {})} style={{ fontSize: 13, color: C.textMuted, textDecoration: 'none', transition: 'color 0.15s' }}
                    onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                    onMouseLeave={e => (e.currentTarget.style.color = C.textMuted)}
                  >{link.label}</a>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div style={{ maxWidth: 1140, margin: '32px auto 0', paddingTop: 24, borderTop: '1px solid rgba(255,255,255,0.06)', display: 'flex', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 12, color: C.textSubtle }}>© 2026 ApplyMate AI. All rights reserved.</div>
          <div style={{ fontSize: 12, color: C.textSubtle }}>Made with ❤️ for European job seekers · 🇪🇺</div>
        </div>
      </footer>
    </div>
  )
}

// ── StatCard (animated counter) ───────────────────────────────────────────────
function StatCard({ value, suffix, labelKey, active, delay }: { value: number; suffix: string; labelKey: string; active: boolean; delay: number }) {
  const { t } = useI18n()
  const [started, setStarted] = useState(false)
  useEffect(() => {
    if (active && !started) {
      const t = setTimeout(() => setStarted(true), delay)
      return () => clearTimeout(t)
    }
  }, [active, started, delay])
  const count = useCounter(value, 1600, started)

  return (
    <div style={{ background: 'rgba(255,255,255,0.05)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.10)', borderRadius: 16, padding: '16px 24px', textAlign: 'center', minWidth: 115 }}>
      <div style={{ fontSize: 24, fontWeight: 800, marginBottom: 3, ...gradientText }}>
        {count}{suffix}
      </div>
      <div style={{ fontSize: 11, color: C.textMuted }}>{t(labelKey)}</div>
    </div>
  )
}

// ── FaqItem ───────────────────────────────────────────────────────────────────
function FaqItem({ question, answer, open, onToggle }: { question: string; answer: string; open: boolean; onToggle: () => void }) {
  const [hov, setHov] = useState(false)
  return (
    <div
      onMouseEnter={() => setHov(true)}
      onMouseLeave={() => setHov(false)}
      style={{
        width: '100%',
        background: open ? 'rgba(99,102,241,0.10)' : (hov ? 'rgba(255,255,255,0.07)' : 'rgba(255,255,255,0.04)'),
        backdropFilter: 'blur(16px)',
        border: `1px solid ${open ? 'rgba(99,102,241,0.35)' : (hov ? 'rgba(255,255,255,0.14)' : 'rgba(255,255,255,0.09)')}`,
        borderRadius: 14, overflow: 'hidden',
        cursor: 'pointer',
        transition: 'all 0.2s ease',
      }}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={`faq-answer-${question.slice(0, 12).replace(/\W+/g, '-').toLowerCase()}`}
        onClick={onToggle}
        style={{ width: '100%', padding: '18px 22px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, textAlign: 'left', font: 'inherit', color: 'inherit', background: 'transparent', border: 'none', cursor: 'pointer' }}
      >
        <span style={{ fontSize: 14, fontWeight: 600, color: open ? '#fff' : 'rgba(255,255,255,0.85)', flex: 1 }}>{question}</span>
        <span style={{ fontSize: 18, color: open ? '#818CF8' : C.textMuted, flexShrink: 0, transition: 'transform 0.25s', transform: open ? 'rotate(45deg)' : 'none' }}>+</span>
      </button>
      <div style={{ maxHeight: open ? '200px' : '0', overflow: 'hidden', transition: 'max-height 0.35s ease' }}>
        <div id={`faq-answer-${question.slice(0, 12).replace(/\W+/g, '-').toLowerCase()}`} style={{ padding: '0 22px 20px', fontSize: 13, color: C.textMuted, lineHeight: 1.80 }}>{answer}</div>
      </div>
    </div>
  )
}

// ── InputField ────────────────────────────────────────────────────────────────
function InputField({ label, value, onChange, placeholder, type = 'text', multiline = false, required = false }: {
  label: string; value: string; onChange: (v: string) => void
  placeholder?: string; type?: string; multiline?: boolean; required?: boolean
}) {
  const [focused, setFocused] = useState(false)
  const base: React.CSSProperties = {
    width: '100%', padding: '10px 13px', fontSize: 13,
    background: focused ? 'rgba(255,255,255,0.09)' : 'rgba(255,255,255,0.05)',
    border: `1px solid ${focused ? 'rgba(99,102,241,0.55)' : 'rgba(255,255,255,0.12)'}`,
    borderRadius: 10, color: '#fff', outline: 'none',
    boxShadow: focused ? '0 0 0 3px rgba(99,102,241,0.15)' : 'none',
    transition: 'all 0.18s', resize: 'none' as const,
  }
  return (
    <div>
      <div style={{ fontSize: 12, fontWeight: 500, color: C.textMuted, marginBottom: 7 }}>{label}</div>
      {multiline ? (
        <textarea value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required} rows={4} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={{ ...base, fontFamily: 'inherit' }} />
      ) : (
        <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} style={base} />
      )}
    </div>
  )
}
