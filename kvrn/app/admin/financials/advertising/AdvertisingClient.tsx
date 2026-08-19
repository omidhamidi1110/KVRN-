'use client'
// app/admin/financials/advertising/AdvertisingClient.tsx
// Advertising and creative-production spend.
//
// Creative production (photography, video) sits here rather than in the operating
// 'content' bucket: it is marketing investment measured against attributed revenue,
// not fixed overhead. Email infrastructure is NOT advertising — Resend fees are a
// 'communications' operating expense unless a send is deliberately run as a campaign.
//
// provider-reported revenue/orders are the PLATFORM'S OWN claim, shown for
// comparison only and never summed into KVRN revenue or profit.

import { useEffect, useState, useCallback } from 'react'
import { FONT, BORDER, money, SectionTitle } from '@/components/admin/FinancialUI'

type AdSpend = {
  id: string; platform: string; campaignName: string | null
  spendCents: number; periodStart: string; periodEnd: string
  providerReportedRevenueCents: number | null
  providerReportedOrders: number | null
  providerSource: string | null
  notes: string | null
}

const PLATFORMS = [
  'meta', 'instagram', 'tiktok', 'google', 'influencer',
  'photographer', 'videographer', 'creative_production', 'other',
]
const PROVIDER_SOURCES = ['manual', 'api', 'imported']

const MEDIA = new Set(['meta', 'instagram', 'tiktok', 'google', 'influencer'])

const inputStyle = { fontFamily: FONT, fontSize: 12, padding: '8px 10px',
                     border: BORDER, background: '#fff', width: '100%',
                     boxSizing: 'border-box' as const }

export function AdvertisingClient() {
  const [ads, setAds]         = useState<AdSpend[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  const [form, setForm] = useState({
    platform: 'meta', campaignName: '', spend: '',
    periodStart: new Date().toISOString().slice(0, 10),
    periodEnd:   new Date().toISOString().slice(0, 10),
    reportedRevenue: '', reportedOrders: '', providerSource: '', notes: '',
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await fetch('/api/admin/ad-spend')
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load advertising spend.'); return }
      setAds(json.adSpend ?? [])
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const toCents = (v: string) => {
    if (!v.trim()) return null
    const n = Math.round(parseFloat(v) * 100)
    return Number.isFinite(n) ? n : null
  }

  async function save() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/ad-spend', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform:     form.platform,
          campaignName: form.campaignName || null,
          spendCents:   toCents(form.spend),
          periodStart:  form.periodStart,
          periodEnd:    form.periodEnd,
          providerReportedRevenueCents: toCents(form.reportedRevenue),
          providerReportedOrders: form.reportedOrders ? Number(form.reportedOrders) : null,
          providerSource: form.providerSource || null,
          notes: form.notes || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not save.'); return }
      setForm({ ...form, campaignName: '', spend: '', reportedRevenue: '', reportedOrders: '', notes: '' })
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  async function remove(id: string) {
    setErr(null)
    try {
      const res = await fetch(`/api/admin/ad-spend/${id}`, { method: 'DELETE' })
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? 'Could not delete.'); return }
      await load()
    } catch { setErr('Network error.') }
  }

  const mediaTotal    = ads.filter(a =>  MEDIA.has(a.platform)).reduce((s, a) => s + a.spendCents, 0)
  const creativeTotal = ads.filter(a => !MEDIA.has(a.platform)).reduce((s, a) => s + a.spendCents, 0)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1180 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Advertising
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Media buying and creative production. Tracked separately from operating expenses
        because it is a marketing investment measured against attributed revenue.
      </p>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
                    gap: 10, marginBottom: 24 }}>
        <div style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
          <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                      textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>Media spend</p>
          <p style={{ fontFamily: FONT, fontSize: 22, fontWeight: 500, margin: '6px 0 0' }}>
            {money(mediaTotal)}
          </p>
        </div>
        <div style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
          <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                      textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>Creative production</p>
          <p style={{ fontFamily: FONT, fontSize: 22, fontWeight: 500, margin: '6px 0 0' }}>
            {money(creativeTotal)}
          </p>
          <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '4px 0 0' }}>
            Photography, video, production
          </p>
        </div>
      </div>

      <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 26 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(180px,1fr))', gap: 12 }}>
          <label style={{ fontFamily: FONT, fontSize: 11 }}>Platform
            <select value={form.platform} onChange={e => setForm({ ...form, platform: e.target.value })}
                    style={{ ...inputStyle, marginTop: 4 }}>
              {PLATFORMS.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
            </select></label>
          <label style={{ fontFamily: FONT, fontSize: 11 }}>Campaign
            <input value={form.campaignName}
                   onChange={e => setForm({ ...form, campaignName: e.target.value })}
                   style={{ ...inputStyle, marginTop: 4 }} /></label>
          <label style={{ fontFamily: FONT, fontSize: 11 }}>Spend $ *
            <input type="number" step="0.01" min="0" value={form.spend}
                   onChange={e => setForm({ ...form, spend: e.target.value })}
                   placeholder="250.00" style={{ ...inputStyle, marginTop: 4 }} /></label>
          <label style={{ fontFamily: FONT, fontSize: 11 }}>Period start *
            <input type="date" value={form.periodStart}
                   onChange={e => setForm({ ...form, periodStart: e.target.value })}
                   style={{ ...inputStyle, marginTop: 4 }} /></label>
          <label style={{ fontFamily: FONT, fontSize: 11 }}>Period end *
            <input type="date" value={form.periodEnd}
                   onChange={e => setForm({ ...form, periodEnd: e.target.value })}
                   style={{ ...inputStyle, marginTop: 4 }} /></label>
          <label style={{ fontFamily: FONT, fontSize: 11 }}>Platform-reported revenue $
            <input type="number" step="0.01" min="0" value={form.reportedRevenue}
                   onChange={e => setForm({ ...form, reportedRevenue: e.target.value })}
                   style={{ ...inputStyle, marginTop: 4 }} /></label>
          <label style={{ fontFamily: FONT, fontSize: 11 }}>Platform-reported orders
            <input type="number" min="0" value={form.reportedOrders}
                   onChange={e => setForm({ ...form, reportedOrders: e.target.value })}
                   style={{ ...inputStyle, marginTop: 4 }} /></label>
          <label style={{ fontFamily: FONT, fontSize: 11 }}>Reported-metric source
            <select value={form.providerSource}
                    onChange={e => setForm({ ...form, providerSource: e.target.value })}
                    style={{ ...inputStyle, marginTop: 4 }}>
              <option value="">—</option>
              {PROVIDER_SOURCES.map(s2 => <option key={s2} value={s2}>{s2}</option>)}
            </select></label>
        </div>
        <p style={{ fontFamily: FONT, fontSize: 11, color: '#92400E', margin: '12px 0 0' }}>
          Platform-reported figures are the platform&apos;s own attribution claim. They are stored
          for comparison and never counted as KVRN revenue.
        </p>
        <button onClick={save} disabled={saving || !form.spend}
          style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em',
                   textTransform: 'uppercase', padding: '9px 16px', marginTop: 14,
                   background: '#1A1A1A', color: '#fff', border: 'none',
                   cursor: 'pointer', opacity: saving || !form.spend ? 0.45 : 1 }}>
          {saving ? 'Saving…' : 'Add spend'}
        </button>
      </div>

      <SectionTitle note="Spend straddling a report boundary is pro-rated by overlapping days.">
        Recorded spend
      </SectionTitle>
      <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
          <thead><tr style={{ background: '#FAF9F7' }}>
            {['Platform','Campaign','Spend','From','To','Reported rev.','Source',''].map((h,i) => (
              <th key={i} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 9,
                                   letterSpacing: '0.1em', textTransform: 'uppercase',
                                   color: '#9B9B9B', borderBottom: BORDER }}>{h}</th>))}
          </tr></thead>
          <tbody>
            {loading && <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>Loading…</td></tr>}
            {!loading && ads.length === 0 && (
              <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                No advertising spend recorded.
              </td></tr>
            )}
            {ads.map(a => (
              <tr key={a.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                <td style={{ padding: '9px 12px' }}>{a.platform.replace(/_/g, ' ')}</td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{a.campaignName ?? '—'}</td>
                <td style={{ padding: '9px 12px' }}>{money(a.spendCents)}</td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{a.periodStart}</td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{a.periodEnd}</td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>
                  {a.providerReportedRevenueCents === null
                    ? '—' : `${money(a.providerReportedRevenueCents)} (claimed)`}
                </td>
                <td style={{ padding: '9px 12px', color: '#6B6B6B' }}>{a.providerSource ?? '—'}</td>
                <td style={{ padding: '9px 12px' }}>
                  <button onClick={() => remove(a.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer',
                             color: '#6b7280', fontSize: 11, textDecoration: 'underline' }}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
