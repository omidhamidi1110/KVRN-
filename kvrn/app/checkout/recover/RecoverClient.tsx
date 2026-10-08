'use client'
import { useEffect, useState } from 'react'
import { formatCheckoutPrice } from '@/lib/format-money'
import { useI18n } from '@/context/I18nContext'
import { fillMessages, format, type MessageKey } from '@/lib/i18n/messages'
import {
  RECOVER_STATUS_COPY, currentBagCount, persistRecoveredCart, type RecoverFailure,
} from '@/lib/abandoned-checkout-ui'

interface Line {
  sku: string; name: string; size: string; color: string
  quantity: number; requestedQuantity: number
  unitPriceCents: number | null; seenUnitPriceCents: number | null; priceChanged: boolean
  status: 'ok' | 'reduced' | 'unavailable'
}
interface Notice { code: string; message: string }
interface Ok {
  status: 'ok'; cart: unknown[]; lines: Line[]; subtotalCents: number; priceChanged: boolean
  currency: string; notices: Notice[]; redirectTo: string
  discount: { code: string; status: string; message: string } | null
}

export function RecoverClient({ token }: { token: string }) {
  const t = fillMessages(useI18n().t)
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'fail'; failure: RecoverFailure } | { kind: 'ok'; data: Ok }>({ kind: 'loading' })
  const [bagCount, setBagCount] = useState(0)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/checkout/recover', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ t: token }),
        })
        const j = await res.json().catch(() => ({}))
        if (cancelled) return
        if (j?.status === 'ok') {
          try { setBagCount(currentBagCount(window.localStorage)) } catch { /* ignore */ }
          setState({ kind: 'ok', data: j as Ok })
        } else if (j?.status && j.status in RECOVER_STATUS_COPY) {
          setState({ kind: 'fail', failure: j.status as RecoverFailure })
        } else {
          setState({ kind: 'fail', failure: 'error' })
        }
      } catch {
        if (!cancelled) setState({ kind: 'fail', failure: 'error' })
      }
    })()
    return () => { cancelled = true }
  }, [token])

  if (state.kind === 'loading') {
    return <p style={{ textAlign: 'center', color: '#9B9B9B' }}>{t['recover.checking']}</p>
  }
  if (state.kind === 'fail') {
    const c = {
      title: t[`recover.fail.${state.failure}.title` as MessageKey],
      body:  t[`recover.fail.${state.failure}.body` as MessageKey],
    }
    return (
      <div style={{ textAlign: 'center' }}>
        <h1 style={{ fontSize: 26, marginBottom: 16, fontWeight: 400, color: '#1A1A1A' }}>{c.title}</h1>
        <p style={{ color: '#6b7280', lineHeight: 1.7, fontSize: 15, maxWidth: 440, margin: '0 auto' }}>{c.body}</p>
        <p style={{ marginTop: 24 }}><a href="/shop" style={{ color: '#1A1A1A', fontSize: 14 }}>{t['recover.goToShop']}</a></p>
      </div>
    )
  }

  const d = state.data
  const live = d.lines.filter(l => l.status !== 'unavailable')
  const gone = d.lines.filter(l => l.status === 'unavailable')

  function proceed() {
    let ok = false
    try { ok = persistRecoveredCart(window.localStorage, d.cart) } catch { ok = false }
    if (!ok) { setProblem(t['recover.storageProblem']); return }
    window.location.assign(d.redirectTo || '/checkout')
  }

  return (
    <div>
      <h1 style={{ fontSize: 26, marginBottom: 8, fontWeight: 400, color: '#1A1A1A', textAlign: 'center' }}>{t['recover.bagSaved']}</h1>
      <p style={{ color: '#6b7280', fontSize: 14, lineHeight: 1.7, textAlign: 'center', marginBottom: 24 }}>
        {t['recover.reviewBelow']}
      </p>

      {d.notices.length > 0 && (
        <ul role="status" style={{ listStyle: 'none', padding: 0, margin: '0 0 20px' }}>
          {d.notices.map(n => (
            <li key={n.code} style={{ border: '1px solid #E8E5E0', background: '#FFFFFF', padding: '10px 14px', fontSize: 13, color: '#1A1A1A', marginBottom: 8, lineHeight: 1.5 }}>
              {n.message}
            </li>
          ))}
        </ul>
      )}

      <ul style={{ listStyle: 'none', padding: 0, margin: 0, borderTop: '1px solid #E8E5E0' }}>
        {live.map(l => (
          <li key={l.sku} style={{ display: 'flex', justifyContent: 'space-between', gap: 16, padding: '14px 0', borderBottom: '1px solid #E8E5E0', fontSize: 14, color: '#1A1A1A' }}>
            <span>
              {l.name}
              <span style={{ display: 'block', fontSize: 12, color: '#9B9B9B' }}>
                {[l.color, l.size].filter(Boolean).join(' / ')} · {format(t['recover.qty'], { n: l.quantity })}
                {l.status === 'reduced' && ` ${format(t['recover.youHad'], { n: l.requestedQuantity })}`}
              </span>
            </span>
            <span style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
              {l.unitPriceCents !== null && formatCheckoutPrice(l.unitPriceCents * l.quantity)}
              {l.priceChanged && l.seenUnitPriceCents !== null && l.unitPriceCents !== null && (
                <span style={{ display: 'block', fontSize: 12, color: '#9B9B9B' }}>
                  {format(t['recover.was'], { price: formatCheckoutPrice(l.seenUnitPriceCents * l.quantity) })}
                </span>
              )}
            </span>
          </li>
        ))}
      </ul>

      {gone.length > 0 && (
        <p style={{ fontSize: 12, color: '#9B9B9B', marginTop: 12 }}>
          {format(t['recover.noLongerAvailable'], { names: gone.map(g => g.name).join(', ') })}
        </p>
      )}

      <p style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14, margin: '16px 0 4px', color: '#1A1A1A' }}>
        <span>{t.subtotal}</span><span>{formatCheckoutPrice(d.subtotalCents)}</span>
      </p>
      <p style={{ fontSize: 12, color: '#9B9B9B', margin: '0 0 20px' }}>{t['recover.shippingNote']}</p>

      {bagCount > 0 && (
        <p style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>{t['recover.replacesBag']}</p>
      )}
      {problem && <p role="alert" style={{ fontSize: 13, color: '#B91C1C', marginBottom: 12 }}>{problem}</p>}

      <button type="button" onClick={proceed}
        style={{ width: '100%', background: '#1A1A1A', color: '#FFFFFF', border: 0, height: 52, fontSize: 13, letterSpacing: '0.04em', cursor: 'pointer' }}>
        {t['recover.continue']}
      </button>
    </div>
  )
}
