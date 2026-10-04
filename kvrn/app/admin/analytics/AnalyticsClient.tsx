'use client'
// app/admin/analytics/AnalyticsClient.tsx
//
// First-party funnel: visit -> product -> cart -> checkout -> purchase, plus a compact
// product table. Counts are SESSIONS that reached each stage OR LATER, so every step is <= the
// one before it. A rate with nothing to divide by is shown as "—", never as 0%.

import { useCallback, useEffect, useState } from 'react'
import { FONT, BORDER, Metric, SectionTitle, pctOrDash, money } from '@/components/admin/FinancialUI'
import type { GaAdminStatus } from '@/lib/ga-common'

type Range = '7d' | '30d' | '90d'
const RANGES: Range[] = ['7d', '30d', '90d']

interface Report {
  range: Range
  window: { start: string; end: string }
  stages: { visits: number; reachedProduct: number; reachedCart: number; reachedCheckout: number; purchased: number }
  rates: { visitToProduct: number | null; productToCart: number | null; cartToCheckout: number | null
           checkoutToPurchase: number | null; visitToPurchase: number | null }
  events: { productViews: number; addToCarts: number; checkoutStarts: number; purchases: number
            purchaseValueCents: number | null }
  coverage: { ordersPaid: number; trackedPurchases: number; trackedPurchaseSharePct: number | null }
  products: Array<{ productId: string; slug: string; name: string; views: number; adds: number
                    checkouts: number; purchases: number; addRatePct: number | null; purchaseRatePct: number | null }>
}

const th = { textAlign: 'left' as const, padding: '9px 10px', fontSize: 9, letterSpacing: '0.1em',
             textTransform: 'uppercase' as const, color: '#9B9B9B', borderBottom: BORDER }

const STATE_LABEL = { unset: 'Not set', malformed: 'Set but malformed (ignored)', ok: 'Configured' } as const
const STATE_COLOR = { unset: '#6B6B6B', malformed: '#B91C1C', ok: '#166534' } as const

/** GA4 configuration status. States only: the secret is never shown, and GA numbers are NOT shown here. */
function GaStatusPanel({ ga }: { ga: GaAdminStatus }) {
  const row = (label: string, state: keyof typeof STATE_LABEL, extra?: string) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, padding: '5px 0', fontSize: 12 }}>
      <span>{label}</span>
      <span style={{ color: STATE_COLOR[state], textAlign: 'right' }}>{STATE_LABEL[state]}{extra ? ` — ${extra}` : ''}</span>
    </div>
  )
  const serverReady = ga.clientState === 'ok' && ga.secretState === 'ok'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(340px,1fr))', gap: 12, marginBottom: 22 }}>
      <div style={{ border: BORDER, background: '#fff', padding: '12px 16px' }}>
        <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9B9B9B', marginBottom: 6 }}>
          KVRN first-party funnel
        </div>
        <p style={{ fontSize: 12, color: '#6B6B6B', margin: 0, lineHeight: 1.5 }}>
          Everything on this page: KVRN&rsquo;s own database, consenting visitors only, purchases from paid orders.
        </p>
      </div>
      <div style={{ border: BORDER, background: '#fff', padding: '12px 16px' }}>
        <div style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9B9B9B', marginBottom: 6 }}>
          Google Analytics 4 (external system)
        </div>
        {row('Measurement ID (browser)', ga.clientState, ga.measurementId ?? undefined)}
        {row('Server-side purchase secret', ga.secretState)}
        <div style={{ fontSize: 11, color: '#6B6B6B', lineHeight: 1.5, margin: '6px 0 8px' }}>
          {ga.clientState !== 'ok'
            ? 'GA is off: no Google script is ever loaded.'
            : serverReady
              ? 'GA loads only after a visitor accepts analytics. Purchases are sent from the order webhook (transaction id = order number).'
              : 'GA loads after consent, but no server-side purchase is sent until the secret is configured.'}
          {' '}GA is a separate system: its numbers will differ from the first-party figures above (sampling, ad blockers,
          processing delay, its own sessionisation).
        </div>
        <a href="https://analytics.google.com/analytics/web/" target="_blank" rel="noopener noreferrer"
           style={{ fontSize: 11, color: '#1A1A1A' }}>
          Open Google Analytics ↗
        </a>
      </div>
    </div>
  )
}

export function AnalyticsClient({ ga }: { ga: GaAdminStatus }) {
  const [range, setRange] = useState<Range>('30d')
  const [data, setData] = useState<Report | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async (r: Range) => {
    setLoading(true); setErr(null)
    try {
      const res = await fetch(`/api/admin/analytics/funnel?range=${r}`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load analytics.'); setData(null); return }
      setData(json)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load(range) }, [range, load])

  const s = data?.stages
  const r = data?.rates
  const rows: Array<[string, number | undefined, string | null]> = s ? [
    ['Visits', s.visits, null],
    ['Reached a product', s.reachedProduct, pctOrDash(r!.visitToProduct) + ' of visits'],
    ['Added to cart', s.reachedCart, pctOrDash(r!.productToCart) + ' of product'],
    ['Started checkout', s.reachedCheckout, pctOrDash(r!.cartToCheckout) + ' of cart'],
    ['Purchased', s.purchased, pctOrDash(r!.checkoutToPurchase) + ' of checkout'],
  ] : []
  const maxBar = Math.max(1, s?.visits ?? 0)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1180, fontFamily: FONT }}>
      <h1 style={{ fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>Analytics</h1>
      <p style={{ fontSize: 12, color: '#6B6B6B', margin: '0 0 20px', maxWidth: 720, lineHeight: 1.5 }}>
        First-party storefront funnel. Only visitors who accepted analytics cookies are counted
        (no choice, decline, Do Not Track and Global Privacy Control are never tracked), so these
        are the behaviour of consenting visitors, not total traffic.
      </p>

      <GaStatusPanel ga={ga} />

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {RANGES.map(o => (
          <button key={o} onClick={() => setRange(o)}
            style={{ fontSize: 11, letterSpacing: '0.04em', padding: '7px 14px', cursor: 'pointer',
                     border: range === o ? '1px solid #1A1A1A' : BORDER,
                     background: range === o ? '#1A1A1A' : '#fff',
                     color: range === o ? '#fff' : '#1A1A1A' }}>
            {o.replace('d', ' days')}
          </button>
        ))}
      </div>

      {err && (
        <div role="alert" style={{ fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                                   border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}
      {loading && !data && <p style={{ fontSize: 12, color: '#6B6B6B' }}>Loading…</p>}

      {data && s && r && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 10, marginBottom: 22 }}>
            <Metric label="Visits / sessions" value={String(s.visits)} />
            <Metric label="Product views" value={String(data.events.productViews)} sub="unique per session and product" />
            <Metric label="Add-to-cart events" value={String(data.events.addToCarts)} />
            <Metric label="Checkout starts" value={String(data.events.checkoutStarts)} />
            <Metric label="Purchases" value={String(data.events.purchases)}
                    sub={data.events.purchaseValueCents === null ? 'order value unknown'
                         : `${money(data.events.purchaseValueCents)} charged (incl. shipping and tax; not revenue)`} />
            <Metric label="Visit → purchase" value={pctOrDash(r.visitToPurchase)} />
          </div>

          <SectionTitle note="Sessions that reached each stage or any later one, so each step is never larger than the one before.">
            Funnel
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', padding: '8px 16px 14px', marginBottom: 22 }}>
            {rows.map(([label, n, rate]) => (
              <div key={label} style={{ display: 'grid', gridTemplateColumns: '170px 1fr 70px 170px', gap: 12,
                                         alignItems: 'center', padding: '8px 0', fontSize: 12 }}>
                <span>{label}</span>
                <span style={{ background: '#F1EEE8', height: 10, display: 'block' }}>
                  <span style={{ display: 'block', height: 10, background: '#1A1A1A',
                                 width: `${Math.max(0, Math.min(100, ((n ?? 0) / maxBar) * 100))}%` }} />
                </span>
                <span style={{ fontWeight: 500, textAlign: 'right' }}>{n}</span>
                <span style={{ color: '#6B6B6B' }}>{rate ?? ''}</span>
              </div>
            ))}
          </div>

          <p style={{ fontSize: 11, color: '#6B6B6B', margin: '0 0 22px', lineHeight: 1.5 }}>
            {data.coverage.ordersPaid === 0
              ? 'No paid orders in this window, so tracked-purchase coverage is not available.'
              : `${data.coverage.trackedPurchases} of ${data.coverage.ordersPaid} paid orders in this window ` +
                `(${pctOrDash(data.coverage.trackedPurchaseSharePct)}) are linked to a tracked analytics session. ` +
                'Untracked orders may reflect declined/no analytics consent or unavailable analytics data.'}
          </p>

          <SectionTitle note="Distinct sessions per stage within the window. Rates use sessions that reached the product at any stage as the base.">
            Products
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Product', 'Views', 'Add to cart', 'Checkout starts', 'Purchases', 'Cart rate', 'Purchase rate'].map(h =>
                  <th key={h} style={th}>{h}</th>)}
              </tr></thead>
              <tbody>
                {data.products.length === 0 && (
                  <tr><td colSpan={7} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No product activity recorded in this window yet.
                  </td></tr>
                )}
                {data.products.map(p => (
                  <tr key={p.productId} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{p.name}</td>
                    <td style={{ padding: '9px 10px' }}>{p.views}</td>
                    <td style={{ padding: '9px 10px' }}>{p.adds}</td>
                    <td style={{ padding: '9px 10px' }}>{p.checkouts}</td>
                    <td style={{ padding: '9px 10px' }}>{p.purchases}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{pctOrDash(p.addRatePct)}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{pctOrDash(p.purchaseRatePct)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
