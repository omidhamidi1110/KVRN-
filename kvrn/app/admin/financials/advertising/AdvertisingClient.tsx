'use client'
// app/admin/financials/advertising/AdvertisingClient.tsx
// Advertising and creative-production spend.
//
// Creative production (photography, video) sits here rather than in the operating
// 'content' bucket: it is marketing investment measured against attributed revenue,
// not fixed overhead. Email infrastructure is NOT advertising — Resend fees are a
// 'communications' operating expense unless a send is deliberately run as a campaign.
//
// Provider-reported revenue/orders are the PLATFORM'S OWN claim, shown for
// comparison only and never summed into KVRN revenue or profit.

import { useEffect, useState, useCallback } from 'react'
import { money } from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminNotice, AdminButton, AdminField, AdminStat, AdminStatGrid,
  AdminTable, AdminTh, AdminTd, AdminLoading, AdminEmpty, StatusBadge, adminInputClass, adminSelectClass,
} from '@/components/admin/ui/AdminUI'

type AdSpend = {
  id: string; platform: string; campaignName: string | null
  spendCents: number; periodStart: string; periodEnd: string
  providerReportedRevenueCents: number | null
  providerReportedOrders: number | null
  providerSource: string | null
  notes: string | null
  /** Set when the row was VOIDED: retained as history, counted nowhere. */
  voidedAt?: string | null
  voidedBy?: string | null
  voidReason?: string | null
}

const PLATFORMS = [
  'meta', 'instagram', 'tiktok', 'google', 'influencer',
  'photographer', 'videographer', 'creative_production', 'other',
]
const PROVIDER_SOURCES = ['manual', 'api', 'imported']

const MEDIA = new Set(['meta', 'instagram', 'tiktok', 'google', 'influencer'])

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

  // Booked spend is a money fact: it is VOIDED (kept as history, counted nowhere), never erased.
  async function voidRow(id: string) {
    setErr(null)
    const reason = window.prompt(
      'Void this ad spend? It stays in the history but stops counting.\n\nReason (required):')
    if (!reason || !reason.trim()) return
    try {
      const res = await fetch(`/api/admin/ad-spend/${id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? 'Could not void.'); return }
      await load()
    } catch { setErr('Network error.') }
  }

  // Voided rows are history only: excluded from every total shown here.
  const activeAds     = ads.filter(a => !a.voidedAt)
  const mediaTotal    = activeAds.filter(a =>  MEDIA.has(a.platform)).reduce((s, a) => s + a.spendCents, 0)
  const creativeTotal = activeAds.filter(a => !MEDIA.has(a.platform)).reduce((s, a) => s + a.spendCents, 0)

  const reportedInfo = "Platform-reported figures are the platform's own attribution claim. They are stored for comparison only and never counted as KVRN revenue."

  return (
    <AdminPage>
      <AdminPageHeader
        title="Advertising"
        description="Media buying and creative production."
        info="Tracked apart from operating expenses because it is a marketing investment measured against attributed revenue."
      />

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}

      <AdminStatGrid min={200} className="mb-6">
        <AdminStat label="Media spend" value={money(mediaTotal)} />
        <AdminStat label="Creative production" value={money(creativeTotal)} sub="Photography, video, production" />
      </AdminStatGrid>

      <AdminCard className="mb-7">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <AdminField label="Platform" htmlFor="ad-platform">
            <select id="ad-platform" value={form.platform} onChange={e => setForm({ ...form, platform: e.target.value })}
                    className={adminSelectClass}>
              {PLATFORMS.map(p => <option key={p} value={p}>{p.replace(/_/g, ' ')}</option>)}
            </select>
          </AdminField>
          <AdminField label="Campaign" htmlFor="ad-campaign">
            <input id="ad-campaign" value={form.campaignName}
                   onChange={e => setForm({ ...form, campaignName: e.target.value })}
                   className={adminInputClass} />
          </AdminField>
          <AdminField label="Spend $ *" htmlFor="ad-spend">
            <input id="ad-spend" type="number" step="0.01" min="0" value={form.spend}
                   onChange={e => setForm({ ...form, spend: e.target.value })}
                   placeholder="250.00" className={adminInputClass} />
          </AdminField>
          <AdminField label="Period start *" htmlFor="ad-start">
            <input id="ad-start" type="date" value={form.periodStart}
                   onChange={e => setForm({ ...form, periodStart: e.target.value })}
                   className={adminInputClass} />
          </AdminField>
          <AdminField label="Period end *" htmlFor="ad-end">
            <input id="ad-end" type="date" value={form.periodEnd}
                   onChange={e => setForm({ ...form, periodEnd: e.target.value })}
                   className={adminInputClass} />
          </AdminField>
          <AdminField label="Platform-reported revenue $" htmlFor="ad-rrev" info={reportedInfo}>
            <input id="ad-rrev" type="number" step="0.01" min="0" value={form.reportedRevenue}
                   onChange={e => setForm({ ...form, reportedRevenue: e.target.value })}
                   className={adminInputClass} />
          </AdminField>
          <AdminField label="Platform-reported orders" htmlFor="ad-rord" info={reportedInfo}>
            <input id="ad-rord" type="number" min="0" value={form.reportedOrders}
                   onChange={e => setForm({ ...form, reportedOrders: e.target.value })}
                   className={adminInputClass} />
          </AdminField>
          <AdminField label="Reported-metric source" htmlFor="ad-rsrc">
            <select id="ad-rsrc" value={form.providerSource}
                    onChange={e => setForm({ ...form, providerSource: e.target.value })}
                    className={adminSelectClass}>
              <option value="">—</option>
              {PROVIDER_SOURCES.map(s2 => <option key={s2} value={s2}>{s2}</option>)}
            </select>
          </AdminField>
        </div>
        <AdminButton variant="primary" className="mt-4" onClick={save} loading={saving} disabled={!form.spend}>
          Add spend
        </AdminButton>
      </AdminCard>

      <AdminSectionHeader title="Recorded spend"
        info="Spend straddling a report boundary is pro-rated by overlapping days." />
      {loading ? <AdminLoading /> : ads.length === 0 ? <AdminEmpty title="No advertising spend recorded." /> : (
        <AdminTable minWidth={760} caption="Recorded advertising spend">
          <thead><tr>
            {['Platform','Campaign','Spend','From','To','Reported rev.','Source'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
            <AdminTh><span className="sr-only">Actions</span></AdminTh>
          </tr></thead>
          <tbody>
            {ads.map(a => (
              <tr key={a.id} className={a.voidedAt ? 'opacity-60' : undefined}>
                <AdminTd className={a.voidedAt ? 'line-through' : undefined}>{a.platform.replace(/_/g, ' ')}</AdminTd>
                <AdminTd className={`text-[#6B6B66] ${a.voidedAt ? 'line-through' : ''}`}>{a.campaignName ?? '—'}</AdminTd>
                <AdminTd className={a.voidedAt ? 'line-through' : undefined}>{money(a.spendCents)}</AdminTd>
                <AdminTd className="text-[#6B6B66]">{a.periodStart}</AdminTd>
                <AdminTd className="text-[#6B6B66]">{a.periodEnd}</AdminTd>
                <AdminTd className="text-[#6B6B66]">
                  {a.providerReportedRevenueCents === null
                    ? '—' : `${money(a.providerReportedRevenueCents)} (claimed)`}
                </AdminTd>
                <AdminTd className="text-[#6B6B66]">{a.providerSource ?? '—'}</AdminTd>
                <AdminTd>
                  {a.voidedAt ? (
                    <span className="block text-[11px] text-[#4A4A46]">
                      <StatusBadge status="Archived" label="Voided" />
                      {a.voidReason ? ` ${a.voidReason}` : ''}
                      <span className="block text-[#8A8A85]">{a.voidedBy ?? 'unknown'} · {a.voidedAt}</span>
                    </span>
                  ) : (
                    <AdminButton size="sm" variant="ghost" onClick={() => voidRow(a.id)}>Void</AdminButton>
                  )}
                </AdminTd>
              </tr>
            ))}
          </tbody>
        </AdminTable>
      )}
    </AdminPage>
  )
}
