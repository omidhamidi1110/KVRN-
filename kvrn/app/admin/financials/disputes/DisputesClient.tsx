'use client'
// app/admin/financials/disputes/DisputesClient.tsx
//
// Fees and cash movement come from Stripe balance transactions stored verbatim,
// never inferred from dispute status. Whether a fee is retained on a win varies
// by region and contract, so the UI reports what Stripe actually said.
//
// Only a LOST dispute reduces revenue, and only net of refunds already issued on
// the same order — so a refund and a dispute can never reduce revenue twice for
// the same money.

import { useEffect, useState, useCallback } from 'react'
import { money } from '@/components/admin/FinancialUI'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminNotice, AdminStat, AdminStatGrid,
  AdminTable, AdminTh, AdminTd, AdminLoading, AdminEmpty, AdminTag,
} from '@/components/admin/ui/AdminUI'

type Dispute = {
  id: string; stripeDisputeId: string; orderNumber: string
  amountCents: number; status: string; stripeStatus: string
  refundOffsetCents: number; netRevenueImpactCents: number
  disputeFeesCents: number; netCashCents: number; balanceTxnCount: number
  openedAt: string | null; resolvedAt: string | null
}

type Totals = {
  count: number; openCount: number; lostCount: number; wonCount: number
  preventedCount: number
  disputedCents: number; revenueImpactCents: number; feesCents: number
}

const STATUS_TONE: Record<string, 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = {
  open:         'warning',
  under_review: 'info',
  won:          'success',
  lost:         'danger',
  withdrawn:    'neutral',
  // Terminal and favourable, but distinct from a contested win: the dispute
  // was blocked or auto-resolved before becoming a formal chargeback.
  prevented:    'info',
}
function StatusPill({ status }: { status: string }) {
  return <AdminTag tone={STATUS_TONE[status] ?? 'neutral'}>{status.replace(/_/g, ' ')}</AdminTag>
}

export function DisputesClient() {
  const [disputes, setDisputes] = useState<Dispute[]>([])
  const [totals, setTotals]     = useState<Totals | null>(null)
  const [loading, setLoading]   = useState(true)
  const [err, setErr]           = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true); setErr(null)
    try {
      const res  = await fetch('/api/admin/disputes')
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not load disputes.'); return }
      setDisputes(json.disputes ?? [])
      setTotals(json.totals ?? null)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  return (
    <AdminPage>
      <AdminPageHeader
        title="Disputes"
        description="Chargebacks and their revenue impact."
        info="Chargebacks reported by Stripe. Only a lost dispute reduces revenue, and only for the portion not already refunded. A prevented dispute was blocked or auto-resolved before becoming a formal chargeback, so it never reduces revenue here."
      />

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}
      {loading && !totals && <AdminLoading />}

      {totals && (
        <>
          <AdminStatGrid min={200} className="mb-6">
            <AdminStat label="Open" value={String(totals.openCount)} tone={totals.openCount > 0 ? 'warning' : 'default'}
              sub={`${totals.count} total · ${totals.preventedCount} prevented`} />
            <AdminStat label="Disputed amount" value={money(totals.disputedCents)} sub="Gross amount under dispute" />
            <AdminStat label="Revenue impact" value={money(totals.revenueImpactCents)}
              tone={totals.revenueImpactCents > 0 ? 'negative' : 'default'}
              sub={`${totals.lostCount} lost, net of refunds`}
              info="Frozen at the terminal outcome and excludes any amount already refunded, so the same money is never counted against revenue twice." />
            <AdminStat label="Dispute fees" value={money(totals.feesCents)} tone="negative"
              sub="From Stripe balance transactions"
              info="Fees and cash movement are read from Stripe balance transactions, never inferred from status. “Not reported” means Stripe has sent no fee data for that dispute yet." />
          </AdminStatGrid>

          <AdminSectionHeader title="All disputes" />
          {disputes.length === 0 ? (
            <AdminEmpty title="No disputes." description="Stripe dispute webhooks will populate this automatically." />
          ) : (
            <AdminTable minWidth={760} caption="Disputes">
              <thead>
                <tr>
                  {['Order', 'Amount', 'Status', 'Stripe status', 'Refund offset',
                    'Revenue impact', 'Fees', 'Opened'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
                </tr>
              </thead>
              <tbody>
                {disputes.map(d => (
                  <tr key={d.id}>
                    <AdminTd>{d.orderNumber}</AdminTd>
                    <AdminTd className="font-medium">{money(d.amountCents)}</AdminTd>
                    <AdminTd><StatusPill status={d.status} /></AdminTd>
                    <AdminTd className="text-[#6B6B66]">{d.stripeStatus.replace(/_/g, ' ')}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{d.refundOffsetCents > 0 ? money(d.refundOffsetCents) : '—'}</AdminTd>
                    <AdminTd className={d.netRevenueImpactCents > 0 ? 'font-medium text-[#B91C1C]' : 'text-[#6B6B66]'}>
                      {d.netRevenueImpactCents > 0 ? money(d.netRevenueImpactCents) : '—'}
                    </AdminTd>
                    <AdminTd className={d.balanceTxnCount === 0 ? 'text-[#92400E]' : 'text-[#6B6B66]'}>
                      {d.balanceTxnCount === 0 ? 'Not reported' : money(d.disputeFeesCents)}
                    </AdminTd>
                    <AdminTd className="text-[#6B6B66]">
                      {d.openedAt ? new Date(d.openedAt).toISOString().slice(0, 10) : '—'}
                    </AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </>
      )}
    </AdminPage>
  )
}
