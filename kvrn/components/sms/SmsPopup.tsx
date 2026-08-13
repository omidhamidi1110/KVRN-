'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ── Config ────────────────────────────────────────────────────────────────────
const SMS_RAW = process.env.NEXT_PUBLIC_KVRN_SMS_NUMBER ?? null
// SMS deep link: RFC-standard ?body= works on modern iOS + Android
// SMS link is built dynamically with an embedded claim token (pre-fetched when popup opens)
// If token fetch fails, fallback body is used — customer still subscribes
const SMS_CONSENT_TEXT = ' \u2014 I agree to receive recurring automated marketing texts from KVRN. Msg & data rates may apply. Reply STOP to unsubscribe.'
const SMS_NUMBER_DISPLAY = SMS_RAW
  ? SMS_RAW.replace(/^\+1(\d{3})(\d{3})(\d{4})$/, '+1 ($1) $2-$3')
  : null

// ── Persistence ───────────────────────────────────────────────────────────────
const KEY_DISMISSED    = 'kvrn_sms_dismissed_at'
const KEY_SUBSCRIBED   = 'kvrn_sms_subscribed_at'
const KEY_DEEPLINK     = 'kvrn_sms_deeplink_opened_at'
const KEY_CODE         = 'kvrn_sms_discount_code'   // surfaced in checkout
const COOLDOWN_MS      = 7  * 24 * 60 * 60 * 1000
const SUBSCRIBED_SUPP  = 30 * 24 * 60 * 60 * 1000

const DISCLOSURE = 'By signing up, you agree to receive recurring automated marketing text messages from KVRN. Consent is not a condition of purchase. Msg & data rates may apply. Msg frequency varies. Reply STOP to unsubscribe, HELP for help.'

// ── Design tokens (dark editorial) ────────────────────────────────────────────
const BG    = '#0F0F0F'
const FG    = '#F2EFE9'
const MUTED = '#606060'
const DIM   = '#3A3A3A'
const SERIF = "Georgia, 'Times New Roman', serif"
const SANS  = '-apple-system, Helvetica Neue, Arial, sans-serif'

function track(e: string) {
  try { (window as any).gtag?.('event', e, { event_category: 'sms_popup' }) } catch {}
}
function isMobile(): boolean {
  if (typeof window === 'undefined') return false
  return window.innerWidth < 900 || navigator.maxTouchPoints > 0
}
function isSupp(): boolean {
  try {
    const a = localStorage.getItem(KEY_SUBSCRIBED)
    return !!a && Date.now() - Number(a) < SUBSCRIBED_SUPP
  } catch { return false }
}
function isDism(): boolean {
  try {
    const a = localStorage.getItem(KEY_DISMISSED)
    return !!a && Date.now() - Number(a) < COOLDOWN_MS
  } catch { return false }
}

interface Offer { loading: boolean; active: boolean; amountCents: number }

export function SmsPopup() {
  const [visible,    setVisible]    = useState(false)
  const [claimToken, setClaimToken] = useState<string | null>(null)
  const [showTab,    setShowTab]    = useState(false)
  const [mobile,     setMobile]     = useState(false)
  const [showManual, setShowManual] = useState(false)  // mobile manual-entry toggle
  const [phone,      setPhone]      = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error,      setError]      = useState('')
  const [successCode,setSuccessCode]= useState<string|null>(null)
  const [copied,     setCopied]     = useState(false)
  const [offer,      setOffer]      = useState<Offer>({ loading: true, active: false, amountCents: 0 })
  const closeRef  = useRef<HTMLButtonElement>(null)
  const panelRef  = useRef<HTMLDivElement>(null)
  const priorFocus= useRef<HTMLElement|null>(null)

  // Fetch offer state
  useEffect(() => {
    fetch('/api/sms/offer')
      .then(r => r.json())
      .then(d => setOffer({ loading: false, active: Boolean(d.offerActive), amountCents: Number(d.amountCents ?? 0) }))
      .catch(() => setOffer({ loading: false, active: false, amountCents: 0 }))
  }, [])

  const hasOffer = !offer.loading && offer.active
  const EYEBROW  = 'PRIVATE ACCESS'
  const HEAD1    = hasOffer ? '$10 OFF'        : 'EARLY ACCESS'
  const HEAD2    = hasOffer ? 'YOUR FIRST ORDER' : 'KVRN RELEASES'
  const CTA_MOB  = hasOffer ? `TEXT US → ${SMS_NUMBER_DISPLAY ?? 'JOIN'}` : `TEXT US → ${SMS_NUMBER_DISPLAY ?? 'JOIN'}`
  const CTA_DESK = hasOffer ? 'GET $10 OFF' : 'JOIN THE LIST'

  // Mount timer
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isSupp()) return
    if (isDism()) { setShowTab(true); setMobile(isMobile()); return }
    setMobile(isMobile())
    const id = setTimeout(() => { setVisible(true); setShowTab(true); track('sms_popup_shown') }, 5000)
    return () => clearTimeout(id)
  }, [])

  // Pre-fetch claim token when popup becomes visible (mobile only)
  // Done here so the href is already populated when user taps TEXT US
  useEffect(() => {
    if (!visible || !mobile || !SMS_RAW) return
    fetch('/api/sms/claim/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
      .then(r => r.json())
      .then(d => {
        if (d.token) {
          setClaimToken(d.token)
          try {
            localStorage.setItem('kvrn_sms_claim_token', JSON.stringify({
              token: d.token, expiresAt: d.expiresAt ?? new Date(Date.now() + 3600000).toISOString(),
            }))
          } catch {}
        }
      })
      .catch(() => {})  // silently fail — fallback body still works for subscribe
  }, [visible, mobile])

  // Focus management
  useEffect(() => {
    if (!visible) return
    priorFocus.current = document.activeElement as HTMLElement
    requestAnimationFrame(() => closeRef.current?.focus())
  }, [visible])

  // Focus trap + Escape
  useEffect(() => {
    if (!visible) return
    const panel = panelRef.current
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { dismiss(); return }
      if (e.key !== 'Tab' || !panel) return
      const els = panel.querySelectorAll<HTMLElement>('button,input,[tabindex]:not([tabindex="-1"])')
      const first = els[0]; const last = els[els.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus() }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [visible])

  const dismiss = useCallback(() => {
    try { localStorage.setItem(KEY_DISMISSED, String(Date.now())) } catch {}
    setVisible(false); setShowTab(true)
    try { priorFocus.current?.focus() } catch {}
    track('sms_popup_dismissed')
  }, [])

  const onDeeplink = useCallback(() => {
    track('sms_deeplink_open')
    try { localStorage.setItem(KEY_DEEPLINK, String(Date.now())) } catch {}
    setVisible(false); setShowTab(true)
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!phone.trim()) { setError('Enter your mobile number.'); return }
    setSubmitting(true); setError('')
    try {
      const res  = await fetch('/api/sms/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: phone.trim(), source: 'homepage' }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) { setError(data.error ?? 'Could not sign up. Please try again.'); return }
      try { localStorage.setItem(KEY_SUBSCRIBED, String(Date.now())) } catch {}
      if (data.discountCode) {
        try { localStorage.setItem(KEY_CODE, data.discountCode) } catch {}
        setSuccessCode(data.discountCode)
      }
      track('sms_manual_subscribed')
    } catch { setError('Network error. Please try again.') }
    finally { setSubmitting(false) }
  }, [phone])

  const handleCopy = useCallback(async () => {
    if (!successCode) return
    try { await navigator.clipboard.writeText(successCode); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch {}
  }, [successCode])

  // ── Tab ───────────────────────────────────────────────────────────────────
  if (showTab && !visible) {
    const open = () => { setVisible(true); track('sms_tab_opened') }
    if (mobile) {
      return (
        <button onClick={open} aria-label="Open KVRN private access offer"
          style={{
            position:'fixed', right:0, top:'62%', transform:'translateY(-50%)',
            zIndex:9997, width:36, height:80,
            background:'rgba(15,15,15,0.88)', backdropFilter:'blur(6px)',
            WebkitBackdropFilter:'blur(6px)',
            border:'1px solid rgba(255,255,255,0.10)', borderRight:'none',
            borderRadius:'4px 0 0 4px',
            display:'flex', flexDirection:'column', alignItems:'center', justifyContent:'center',
            gap:3, padding:0, cursor:'pointer',
          }}>
          <span style={{ fontSize:9, color:FG, fontWeight:600, letterSpacing:'0.12em', textTransform:'uppercase', lineHeight:1.1 }}>
            {hasOffer ? '$10' : 'JOIN'}
          </span>
          {hasOffer && <span style={{ width:16, height:'1px', background:DIM }} />}
          {hasOffer && (
            <span style={{ fontSize:9, color:MUTED, fontWeight:500, letterSpacing:'0.10em', textTransform:'uppercase', lineHeight:1.1 }}>
              OFF
            </span>
          )}
        </button>
      )
    }
    return (
      <button onClick={open} aria-label="Open KVRN private access offer"
        style={{
          position:'fixed', bottom:0, left:28, zIndex:9997,
          background:'rgba(15,15,15,0.92)', backdropFilter:'blur(8px)',
          WebkitBackdropFilter:'blur(8px)',
          border:'1px solid rgba(255,255,255,0.10)', borderBottom:'none',
          borderRadius:'4px 4px 0 0',
          padding:'10px 18px',
          fontFamily:SANS, fontSize:10, fontWeight:500,
          letterSpacing:'0.12em', textTransform:'uppercase', color:FG,
          cursor:'pointer', display:'flex', alignItems:'center', gap:8,
        }}>
        PRIVATE ACCESS <span style={{ opacity:0.45 }}>+</span>
      </button>
    )
  }

  if (!visible) return null
  if (offer.loading) return null

  // ── Success ───────────────────────────────────────────────────────────────
  if (successCode !== null) {
    return (
      <>
        <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.72)', backdropFilter:'blur(2px)', WebkitBackdropFilter:'blur(2px)', zIndex:9998 }} onClick={dismiss} aria-hidden="true" />
        <div ref={panelRef} role="dialog" aria-modal="true" aria-label="Signup confirmed"
          style={{ position:'fixed', zIndex:9999, left:'50%', top:'50%', transform:'translate(-50%,-50%)',
            width:`min(420px, calc(100vw - 32px))`, background:BG, padding:'44px 40px 36px', outline:'none' }}
          tabIndex={-1}>
          <button ref={closeRef} onClick={dismiss} aria-label="Close"
            style={{ position:'absolute', top:16, right:18, background:'none', border:'none', cursor:'pointer',
              fontSize:18, color:MUTED, padding:'4px 6px' }}>×</button>
          <p style={{ fontFamily:SANS, fontSize:9, letterSpacing:'0.15em', textTransform:'uppercase', color:MUTED, margin:'0 0 20px' }}>
            CONFIRMED
          </p>
          <h1 style={{ fontFamily:SERIF, fontSize:'clamp(28px,7vw,36px)', fontWeight:300, color:FG, margin:'0 0 6px', lineHeight:1.05 }}>
            You're in.
          </h1>
          <p style={{ fontFamily:SANS, fontSize:13, color:MUTED, margin:'0 0 24px', lineHeight:1.5 }}>
            {hasOffer ? '$10 off your first order. Apply at checkout.' : 'Welcome to KVRN private access.'}
          </p>
          {successCode && (
            <div style={{ background:'#1A1A1A', border:'1px solid #2A2A2A', padding:'14px 18px',
              display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:8 }}>
              <span style={{ fontFamily:'monospace', fontSize:16, fontWeight:600, letterSpacing:'0.08em', color:FG }}>
                {successCode}
              </span>
              <button onClick={handleCopy}
                style={{ background:'none', border:'1px solid #3A3A3A', color:FG, cursor:'pointer',
                  fontFamily:SANS, fontSize:10, fontWeight:500, letterSpacing:'0.10em',
                  textTransform:'uppercase', padding:'6px 12px' }}>
                {copied ? 'COPIED' : 'COPY'}
              </button>
            </div>
          )}
          <button onClick={dismiss}
            style={{ background:'none', border:'none', color:MUTED, cursor:'pointer', fontFamily:SANS,
              fontSize:11, letterSpacing:'0.06em', padding:0, marginTop:12 }}>
            Continue shopping
          </button>
        </div>
      </>
    )
  }

  // ── Main panel ─────────────────────────────────────────────────────────────
  const Backdrop = (
    <div style={{ position:'fixed', inset:0, background:'rgba(0,0,0,0.72)',
      backdropFilter:'blur(2px)', WebkitBackdropFilter:'blur(2px)', zIndex:9998 }}
      onClick={dismiss} aria-hidden="true" />
  )

  const panelStyle: React.CSSProperties = {
    position:'fixed', zIndex:9999, left:'50%', top:'50%', transform:'translate(-50%,-50%)',
    width:`min(440px, calc(100vw - 24px))`,
    background:BG, outline:'none',
    padding: mobile ? '36px 28px 28px' : '44px 40px 36px',
  }

  const CloseBtn = (
    <button ref={closeRef} onClick={dismiss} aria-label="Close"
      style={{ position:'absolute', top:16, right:18, background:'none', border:'none', cursor:'pointer',
        fontSize:18, color:MUTED, padding:'4px 6px' }}>×</button>
  )

  const Eyebrow = (
    <p style={{ fontFamily:SANS, fontSize:9, letterSpacing:'0.16em', textTransform:'uppercase',
      color:MUTED, margin:'0 0 18px' }}>{EYEBROW}</p>
  )

  const Headline = (
    <>
      <h1 style={{ fontFamily:SERIF, fontSize:'clamp(34px,9vw,50px)', fontWeight:300,
        color:FG, margin:'0 0 2px', lineHeight:1.0 }}>{HEAD1}</h1>
      <h2 style={{ fontFamily:SERIF, fontSize:'clamp(34px,9vw,50px)', fontWeight:300,
        color:FG, margin:'0 0 20px', lineHeight:1.0 }}>{HEAD2}</h2>
    </>
  )

  const Body = (
    <p style={{ fontFamily:SANS, fontSize:13, color:MUTED, margin:'0 0 24px', lineHeight:1.55, letterSpacing:'0.01em' }}>
      Private access to drops, restocks, and KVRN releases.
    </p>
  )

  const Disc = (
    <p style={{ fontFamily:SANS, fontSize:10, color:'#3E3E3E', lineHeight:1.6, margin:'16px 0 0' }}>
      {DISCLOSURE}{' '}
      <a href="/legal/terms" style={{ color:'#4A4A4A', textDecoration:'underline' }}>Terms</a>
      {' · '}
      <a href="/legal/privacy" style={{ color:'#4A4A4A', textDecoration:'underline' }}>Privacy</a>
    </p>
  )

  const PhoneForm = (
    <div>
      <label htmlFor="sms-phone" style={{ display:'block', fontFamily:SANS, fontSize:9,
        letterSpacing:'0.12em', textTransform:'uppercase', color:MUTED, marginBottom:6 }}>
        Mobile number
      </label>
      <input id="sms-phone" type="tel" value={phone} autoComplete="tel"
        placeholder="+1 (555) 000-0000"
        onChange={e => setPhone(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
        style={{ width:'100%', padding:'12px 14px', background:'#1A1A1A',
          border:'1px solid #2A2A2A', color:FG, fontFamily:SANS, fontSize:14,
          outline:'none', boxSizing:'border-box', marginBottom:10 }}
        disabled={submitting} aria-required="true" />
      {error && <p style={{ fontFamily:SANS, fontSize:11, color:'#C0392B', marginBottom:8 }} role="alert">{error}</p>}
      <button onClick={handleSubmit} disabled={submitting}
        style={{ width:'100%', padding:'13px 0', background:FG, color:BG,
          border:'none', cursor:'pointer', fontFamily:SANS, fontSize:11, fontWeight:500,
          letterSpacing:'0.12em', textTransform:'uppercase', opacity:submitting ? 0.5 : 1 }}
        aria-busy={submitting}>
        {submitting ? 'SIGNING UP…' : CTA_DESK}
      </button>
    </div>
  )

  const NoThanks = (
    <button onClick={dismiss}
      style={{ display:'block', background:'none', border:'none', color:'#3A3A3A', cursor:'pointer',
        fontFamily:SANS, fontSize:10, letterSpacing:'0.08em', textTransform:'uppercase',
        padding:0, marginTop:16 }}>
      No thanks
    </button>
  )

  // ── DESKTOP layout ────────────────────────────────────────────────────────
  if (!mobile) {
    return (
      <>
        {Backdrop}
        <div ref={panelRef} role="dialog" aria-modal="true" aria-label="KVRN SMS offer" style={panelStyle} tabIndex={-1}>
          {CloseBtn}
          {Eyebrow}
          {Headline}
          {Body}
          {Disc}
          <div style={{ height:1, background:DIM, margin:'24px 0' }} />
          {PhoneForm}
          {NoThanks}
        </div>
      </>
    )
  }

  // ── MOBILE layout — Messages primary, manual secondary ────────────────────
  return (
    <>
      {Backdrop}
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label="KVRN SMS offer" style={panelStyle} tabIndex={-1}>
        {CloseBtn}
        {Eyebrow}
        {Headline}
        {Body}

        {/* Disclosure before CTAs */}
        {Disc}

        <div style={{ height:1, background:DIM, margin:'20px 0 18px' }} />

        {/* Primary CTA: open Messages app — link includes claim token if pre-fetched */}
        {SMS_RAW ? (
          <a
            href={`sms:${SMS_RAW}?body=${encodeURIComponent(
              claimToken
                ? `JOIN KVRN TK-${claimToken}${SMS_CONSENT_TEXT}`
                : `JOIN KVRN${SMS_CONSENT_TEXT}`
            )}`}
            onClick={onDeeplink}
            style={{ display:'block', width:'100%', padding:'14px 0', boxSizing:'border-box',
              background:FG, color:BG, textDecoration:'none', textAlign:'center',
              fontFamily:SANS, fontSize:11, fontWeight:500, letterSpacing:'0.12em',
              textTransform:'uppercase', marginBottom:12 }}
            aria-label={CTA_MOB}>
            {CTA_MOB}
          </a>
        ) : null}

        {/* Secondary: manual entry toggle */}
        {!showManual ? (
          <button onClick={() => setShowManual(true)}
            style={{ display:'block', width:'100%', padding:'12px 0', background:'none',
              border:'1px solid #2A2A2A', color:MUTED, cursor:'pointer',
              fontFamily:SANS, fontSize:10, fontWeight:400, letterSpacing:'0.10em',
              textTransform:'uppercase' }}>
            Enter your number instead
          </button>
        ) : (
          <div style={{ marginTop:4 }}>
            {PhoneForm}
          </div>
        )}

        {NoThanks}
      </div>
    </>
  )
}
