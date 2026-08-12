'use client'

import { useState, useEffect, useRef, useCallback } from 'react'

// ── Server-verified offer state (fetched on mount — no NEXT_PUBLIC_SMS_DISCOUNT_CODE) ────
// SMS number is the only public env var here
const SMS_NUMBER = process.env.NEXT_PUBLIC_KVRN_SMS_NUMBER ?? null
const SMS_LINK   = SMS_NUMBER ? `sms:${SMS_NUMBER}?body=JOIN` : null

// ── Persistence keys ──────────────────────────────────────────────────────────
const KEY_DISMISSED       = 'kvrn_sms_dismissed_at'
const KEY_SUBSCRIBED_AT   = 'kvrn_sms_subscribed_at'    // timestamp; 30-day suppression
const KEY_DEEPLINK_AT     = 'kvrn_sms_deeplink_opened_at'
const COOLDOWN_MS         = 7  * 24 * 60 * 60 * 1000   // 7-day dismiss cooldown
const SUBSCRIBED_SUPPRESS = 30 * 24 * 60 * 60 * 1000   // 30-day subscription suppression

const DISCLOSURE = `By signing up, you agree to receive recurring automated marketing text messages from KVRN. Consent is not a condition of purchase. Msg & data rates may apply. Msg frequency varies. Reply STOP to unsubscribe, HELP for help.`

const FONT_BODY  = '-apple-system, Helvetica Neue, Arial, sans-serif'
const FONT_SERIF = "Georgia, 'Times New Roman', serif"
const PANEL_W    = 460

function track(event: string) {
  try { (window as any).gtag?.('event', event, { event_category: 'sms_popup' }) } catch {}
}

function isMobileCapable(): boolean {
  if (typeof window === 'undefined') return false
  return window.innerWidth < 900 || navigator.maxTouchPoints > 0
}

function isRecentlySuppressed(): boolean {
  try {
    const at = localStorage.getItem(KEY_SUBSCRIBED_AT)
    if (at) return Date.now() - Number(at) < SUBSCRIBED_SUPPRESS
    return false
  } catch { return false }
}

function isDismissedRecently(): boolean {
  try {
    const at = localStorage.getItem(KEY_DISMISSED)
    if (at) return Date.now() - Number(at) < COOLDOWN_MS
    return false
  } catch { return false }
}

interface OfferState {
  loading: boolean
  active:  boolean
  amountCents: number
}

export function SmsPopup() {
  const [visible,      setVisible]      = useState(false)
  const [showTab,      setShowTab]      = useState(false)
  const [mobile,       setMobile]       = useState(false)
  const [phone,        setPhone]        = useState('')
  const [submitting,   setSubmitting]   = useState(false)
  const [error,        setError]        = useState('')
  const [successCode,  setSuccessCode]  = useState<string | null>(null)
  const [copied,       setCopied]       = useState(false)
  const [offer,        setOffer]        = useState<OfferState>({ loading: true, active: false, amountCents: 0 })

  const panelRef   = useRef<HTMLDivElement>(null)
  const closeRef   = useRef<HTMLButtonElement>(null)
  const priorFocus = useRef<HTMLElement | null>(null)

  // ── Fetch server-verified offer state ────────────────────────────────────────
  useEffect(() => {
    fetch('/api/sms/offer')
      .then(r => r.json())
      .then(d => setOffer({ loading: false, active: Boolean(d.offerActive), amountCents: Number(d.amountCents ?? 0) }))
      .catch(() => setOffer({ loading: false, active: false, amountCents: 0 }))
  }, [])

  // ── Derive copy from offer state ──────────────────────────────────────────────
  const hasOffer  = !offer.loading && offer.active
  const HEADLINE1 = hasOffer ? '$10 OFF'              : 'EARLY ACCESS'
  const HEADLINE2 = hasOffer ? 'YOUR NEXT ORDER'      : 'KVRN RELEASES'
  const CTA_DESK  = hasOffer ? 'GET $10 OFF'          : 'JOIN THE LIST'
  const CTA_MOB   = hasOffer ? 'YES, SEND ME $10 OFF' : 'YES, KEEP ME UPDATED'

  // ── Mount: show popup after 5s delay ─────────────────────────────────────────
  useEffect(() => {
    if (typeof window === 'undefined') return
    if (isRecentlySuppressed() || isDismissedRecently()) {
      setShowTab(true)   // show reopen tab even if popup suppressed
      return
    }
    const m  = isMobileCapable()
    setMobile(m)
    const id = setTimeout(() => {
      setVisible(true)
      setShowTab(true)
      track('sms_popup_shown')
    }, 5000)
    return () => clearTimeout(id)
  }, [])

  // ── Focus management ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!visible) return
    priorFocus.current = document.activeElement as HTMLElement
    // Focus close button or first interactive element after a paint
    requestAnimationFrame(() => closeRef.current?.focus())
  }, [visible])

  // Focus trap inside panel
  useEffect(() => {
    if (!visible) return
    const panel = panelRef.current
    if (!panel) return
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { handleClose(); return }
      if (e.key !== 'Tab') return
      const focusable = panel.querySelectorAll<HTMLElement>(
        'button, input, [tabindex]:not([tabindex="-1"])'
      )
      const first = focusable[0]
      const last  = focusable[focusable.length - 1]
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last?.focus()
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first?.focus()
      }
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [visible])

  const restoreFocus = () => {
    try { priorFocus.current?.focus() } catch {}
  }

  const handleClose = useCallback(() => {
    try { localStorage.setItem(KEY_DISMISSED, String(Date.now())) } catch {}
    setVisible(false)
    setShowTab(true)
    track('sms_popup_dismissed')
    restoreFocus()
  }, [])

  const handleDeeplinkTap = useCallback(() => {
    track('sms_deeplink_open')
    try { localStorage.setItem(KEY_DEEPLINK_AT, String(Date.now())) } catch {}
    // Close popup (not decline — they may still send JOIN)
    setVisible(false)
    setShowTab(true)  // leave tab available so they can confirm later
    // Do NOT set KEY_SUBSCRIBED_AT — we don't know if they sent JOIN
  }, [])

  const handleSubmit = useCallback(async () => {
    if (!phone.trim()) { setError('Enter your phone number.'); return }
    setSubmitting(true)
    setError('')
    try {
      const res  = await fetch('/api/sms/subscribe', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ phone: phone.trim(), source: 'homepage' }),
      })
      const data = await res.json()
      if (!res.ok || !data.success) { setError(data.error ?? 'Could not sign up. Please try again.'); return }
      // Store subscribed timestamp (30-day suppression, not permanent)
      try { localStorage.setItem(KEY_SUBSCRIBED_AT, String(Date.now())) } catch {}
      setSuccessCode(data.discountCode ?? null)
      track('sms_manual_subscribed')
    } catch {
      setError('Network error. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }, [phone])

  const handleCopy = useCallback(async () => {
    if (!successCode) return
    try { await navigator.clipboard.writeText(successCode); setCopied(true); setTimeout(() => setCopied(false), 2000) } catch {}
  }, [successCode])

  // ── Persistent tab ───────────────────────────────────────────────────────────
  if (showTab && !visible) {
    if (mobile) {
      // Right-edge tab — two horizontal spans in flex column (no writingMode)
      return (
        <button
          onClick={() => { setVisible(true); track('sms_tab_opened') }}
          aria-label="Open SMS signup"
          style={{
            position: 'fixed', right: 0, top: '65%', transform: 'translateY(-50%)',
            zIndex: 9997, width: 48, height: 60,
            background: '#0D0D0D', color: '#FAFAF8',
            border: 'none', cursor: 'pointer',
            borderRadius: '6px 0 0 6px',
            display: 'flex', flexDirection: 'column',
            alignItems: 'center', justifyContent: 'center', gap: 2,
            padding: 0,
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', lineHeight: 1.1 }}>
            {hasOffer ? '$10' : 'SMS'}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', lineHeight: 1.1 }}>
            {hasOffer ? 'OFF' : 'LIST'}
          </span>
        </button>
      )
    }
    // Desktop bottom-left tab
    return (
      <button
        onClick={() => { setVisible(true); track('sms_tab_opened') }}
        aria-label="Open SMS signup"
        style={{
          position: 'fixed', bottom: 0, left: 32, zIndex: 9997,
          background: '#0D0D0D', color: '#FAFAF8',
          border: 'none', cursor: 'pointer',
          padding: '10px 20px',
          fontFamily: FONT_BODY, fontSize: 11, fontWeight: 500,
          letterSpacing: '0.10em', textTransform: 'uppercase',
          borderRadius: '6px 6px 0 0',
        }}
      >
        {hasOffer ? '$10 OFF' : 'JOIN THE LIST'}
      </button>
    )
  }

  if (!visible) return null

  // Don't render until offer is loaded (prevents copy flash)
  if (offer.loading) return null

  // ── Success state ─────────────────────────────────────────────────────────────
  if (successCode !== null || (successCode === null && submitting === false && phone && !error)) {
    const isSuccess = successCode !== null || (phone && !submitting && !error)
  }

  const isSuccess = successCode !== null

  // ── Panel ─────────────────────────────────────────────────────────────────────
  return (
    <>
      <div
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.52)', zIndex: 9998 }}
        onClick={handleClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={hasOffer ? '$10 off SMS signup' : 'SMS list signup'}
        style={{
          position: 'fixed', zIndex: 9999,
          left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
          width: `min(${PANEL_W}px, calc(100vw - 32px))`,
          background: '#FAFAF8', padding: '40px 40px 32px',
          outline: 'none',
        }}
        tabIndex={-1}
      >
        <button
          ref={closeRef}
          onClick={handleClose}
          aria-label="Close"
          style={{
            position: 'absolute', top: 14, right: 16,
            background: 'none', border: 'none', cursor: 'pointer',
            fontSize: 20, color: '#888', lineHeight: 1, padding: '4px 6px',
          }}
        >
          ×
        </button>

        {isSuccess ? (
          // ── Success ──────────────────────────────────────────────────────────
          <div>
            <p style={{ fontFamily: FONT_BODY, fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: '#888', marginBottom: 12 }}>
              {hasOffer ? 'YOUR $10 CODE' : 'YOU\'RE IN'}
            </p>
            <h1 style={{ fontFamily: FONT_SERIF, fontSize: 'clamp(26px,6vw,34px)', fontWeight: 400, color: '#0D0D0D', margin: '0 0 8px' }}>
              {hasOffer ? 'You\'re In.' : 'Exclusive Access'}
            </h1>
            <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: '#5A5A5A', marginBottom: 24 }}>
              {hasOffer ? 'Apply this code at checkout.' : 'Confirmed. Watch for our next drop.'}
            </p>
            {successCode && (
              <div style={{ background: '#F1EEE8', padding: '16px 20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <span style={{ fontFamily: FONT_BODY, fontSize: 17, fontWeight: 600, letterSpacing: '0.06em', color: '#0D0D0D' }}>
                  {successCode}
                </span>
                <button
                  onClick={handleCopy}
                  style={{ background: '#0D0D0D', color: '#fff', border: 'none', cursor: 'pointer', padding: '8px 16px', fontFamily: FONT_BODY, fontSize: 11, fontWeight: 500, letterSpacing: '0.08em', textTransform: 'uppercase' }}
                >
                  {copied ? 'COPIED' : 'COPY'}
                </button>
              </div>
            )}
            <button
              onClick={handleClose}
              style={{ background: 'none', border: '1px solid #D0CCC5', color: '#5A5A5A', cursor: 'pointer', padding: '10px 20px', fontFamily: FONT_BODY, fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase' }}
            >
              Close
            </button>
          </div>
        ) : mobile && SMS_LINK ? (
          // ── Mobile: deep-link primary ─────────────────────────────────────────
          <div>
            <h1 style={{ fontFamily: FONT_SERIF, fontSize: 'clamp(28px,7vw,38px)', fontWeight: 400, color: '#0D0D0D', margin: '0 0 2px', lineHeight: 1.08 }}>{HEADLINE1}</h1>
            <h2 style={{ fontFamily: FONT_SERIF, fontSize: 'clamp(28px,7vw,38px)', fontWeight: 400, color: '#0D0D0D', margin: '0 0 16px', lineHeight: 1.08 }}>{HEADLINE2}</h2>
            <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: '#5A5A5A', marginBottom: 24 }}>
              Private access to drops, restocks, and KVRN releases.
            </p>
            <a
              href={SMS_LINK}
              onClick={handleDeeplinkTap}
              style={{
                display: 'block', width: '100%', padding: '13px 0', boxSizing: 'border-box',
                background: '#0D0D0D', color: '#fff', textDecoration: 'none', textAlign: 'center',
                fontFamily: FONT_BODY, fontSize: 12, fontWeight: 500, letterSpacing: '0.10em', textTransform: 'uppercase',
                marginBottom: 12,
              }}
            >
              {CTA_MOB}
            </a>
            {/* Manual fallback always visible on mobile */}
            <label style={{ display: 'block', fontFamily: FONT_BODY, fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#888', marginBottom: 6 }}>
              Or enter your number
            </label>
            <input
              type="tel" value={phone} placeholder="+1 555 000 0000"
              onChange={e => setPhone(e.target.value)}
              style={{ width: '100%', padding: '11px 14px', fontFamily: FONT_BODY, fontSize: 14, background: '#fff', border: '1px solid #D0CCC5', outline: 'none', boxSizing: 'border-box', marginBottom: 10 }}
            />
            <button
              onClick={handleSubmit} disabled={submitting}
              style={{ width: '100%', padding: '13px 0', background: '#0D0D0D', color: '#fff', border: 'none', cursor: 'pointer', fontFamily: FONT_BODY, fontSize: 12, fontWeight: 500, letterSpacing: '0.10em', textTransform: 'uppercase', marginBottom: 12, opacity: submitting ? 0.6 : 1 }}
            >
              {submitting ? 'SIGNING UP…' : CTA_DESK}
            </button>
            {error && <p style={{ fontFamily: FONT_BODY, fontSize: 12, color: '#B91C1C', marginBottom: 8 }}>{error}</p>}
            <p style={{ fontFamily: FONT_BODY, fontSize: 10, color: '#9B9B9B', lineHeight: 1.5, marginTop: 8 }}>{DISCLOSURE}</p>
            <button onClick={handleClose} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontFamily: FONT_BODY, fontSize: 11, letterSpacing: '0.04em', marginTop: 12, padding: 0 }}>
              No thanks
            </button>
          </div>
        ) : (
          // ── Desktop: manual phone entry ───────────────────────────────────────
          <div>
            <h1 style={{ fontFamily: FONT_SERIF, fontSize: 'clamp(28px,7vw,38px)', fontWeight: 400, color: '#0D0D0D', margin: '0 0 2px', lineHeight: 1.08 }}>{HEADLINE1}</h1>
            <h2 style={{ fontFamily: FONT_SERIF, fontSize: 'clamp(28px,7vw,38px)', fontWeight: 400, color: '#0D0D0D', margin: '0 0 16px', lineHeight: 1.08 }}>{HEADLINE2}</h2>
            <p style={{ fontFamily: FONT_BODY, fontSize: 13, color: '#5A5A5A', marginBottom: 24 }}>
              Private access to drops, restocks, and KVRN releases.
            </p>
            <label style={{ display: 'block', fontFamily: FONT_BODY, fontSize: 10, letterSpacing: '0.10em', textTransform: 'uppercase', color: '#888', marginBottom: 6 }}>
              Phone number
            </label>
            <input
              type="tel" value={phone} placeholder="+1 555 000 0000"
              onChange={e => setPhone(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
              style={{ width: '100%', padding: '11px 14px', fontFamily: FONT_BODY, fontSize: 14, background: '#fff', border: '1px solid #D0CCC5', outline: 'none', boxSizing: 'border-box', marginBottom: 10 }}
            />
            <button
              onClick={handleSubmit} disabled={submitting}
              style={{ width: '100%', padding: '13px 0', background: '#0D0D0D', color: '#fff', border: 'none', cursor: 'pointer', fontFamily: FONT_BODY, fontSize: 12, fontWeight: 500, letterSpacing: '0.10em', textTransform: 'uppercase', marginBottom: 12, opacity: submitting ? 0.6 : 1 }}
            >
              {submitting ? 'SIGNING UP…' : CTA_DESK}
            </button>
            {error && <p style={{ fontFamily: FONT_BODY, fontSize: 12, color: '#B91C1C', marginBottom: 8 }}>{error}</p>}
            <p style={{ fontFamily: FONT_BODY, fontSize: 10, color: '#9B9B9B', lineHeight: 1.5, marginTop: 8 }}>{DISCLOSURE}</p>
            <button onClick={handleClose} style={{ background: 'none', border: 'none', color: '#888', cursor: 'pointer', fontFamily: FONT_BODY, fontSize: 11, letterSpacing: '0.04em', marginTop: 12, padding: 0 }}>
              No thanks
            </button>
          </div>
        )}
      </div>
    </>
  )
}
