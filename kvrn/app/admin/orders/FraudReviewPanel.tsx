'use client'
// Fraud / Risk panel for one order. Risk comes from what Stripe/Radar actually reported; absent data is shown
// as "Unknown". The KVRN hold is a separate, server-enforced fulfillment gate: payment stays Paid, and releasing
// it does NOT change anything in Stripe (the panel says so). Warnings and Unknown / Failed states are always
// visible; only definitions live in the InfoTip.

import { useCallback, useEffect, useState } from 'react'
import {
  AdminSectionHeader, AdminButton, AdminNotice, AdminLoading, AdminError, StatusBadge, InfoTip, adminInputClass,
} from '@/components/admin/ui/AdminUI'
import type { FraudView } from '@/lib/fraud-review'
import {
  riskBadge, holdBadge, reviewBadge, checkLabel, threeDSLabel, countryLabel, eventLabel, holdNotAppliedWhy,
} from './orders-ui'

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-[3px] text-[12px]">
      <span className="shrink-0 text-[#8A8A85]">{label}</span>
      <span className="min-w-0 text-right text-[#171717]">{children}</span>
    </div>
  )
}

export function FraudReviewPanel({
  orderId, orderNumber, paymentStatus, fulfillmentStatus, onChanged,
}: {
  orderId: string
  orderNumber: string
  paymentStatus: string
  fulfillmentStatus: string
  /** Called after any action that can change fulfillment availability (release / confirm / refresh). */
  onChanged: () => void
}) {
  const [view, setView] = useState<FraudView | null>(null)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [busy, setBusy] = useState<null | 'refresh' | 'release' | 'confirm'>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setLoadErr(null)
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/fraud`, { cache: 'no-store' })
      const json = await res.json()
      if (!res.ok) { setLoadErr(json.error ?? 'Request failed.'); return }
      setView(json.data)
    } catch { setLoadErr('Network error.') }
  }, [orderId])

  useEffect(() => { setView(null); setMsg(null); setNote(''); load() }, [load])

  async function act(kind: 'refresh' | 'release' | 'confirm') {
    if (!view) return
    if (kind === 'release' && !window.confirm(
      `Release the fraud hold on order ${orderNumber}?\n\nThe order can then be fulfilled. Stripe is not changed.`)) return
    if (kind === 'confirm' && !window.confirm(
      `Mark order ${orderNumber} as confirmed fraud?\n\nThis keeps the order on hold and is recorded in the audit log. ` +
      'It does not refund or cancel anything: refund the payment in Stripe, then cancel the order here.')) return
    setBusy(kind); setMsg(null)
    try {
      const res = await fetch(`/api/admin/orders/${orderId}/fraud/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: kind === 'refresh' ? undefined : JSON.stringify({ confirm: true, ...(note.trim() ? { note: note.trim() } : {}) }),
      })
      const json = await res.json()
      if (!res.ok) { setMsg({ ok: false, text: json.error ?? 'Failed.' }); if (kind === 'refresh') load(); return }
      setView(json.data)
      setNote('')
      setMsg({ ok: true, text: kind === 'refresh' ? 'Updated from Stripe.' : kind === 'release' ? 'Hold released. Stripe was not changed.' : 'Recorded as confirmed fraud.' })
      onChanged()
    } catch { setMsg({ ok: false, text: 'Network error.' }) } finally { setBusy(null) }
  }

  const refunded = paymentStatus === 'refunded'
  const unshipped = fulfillmentStatus === 'unfulfilled' || fulfillmentStatus === 'processing'

  return (
    <section aria-label="Fraud and risk">
      <AdminSectionHeader
        title="Fraud / risk"
        info={<>
          Risk comes from Stripe Radar. KVRN does not score payments or decline them. “Unknown” means Stripe sent no data.
          A hold only blocks fulfillment; the payment stays paid. Releasing a hold does not change Stripe.
        </>}
        actions={<AdminButton size="sm" onClick={() => act('refresh')} loading={busy === 'refresh'} disabled={busy !== null || !view}>Refresh</AdminButton>}
      />

      {!view && !loadErr && <AdminLoading label="Loading risk…" />}
      {loadErr && <AdminError message={loadErr} onRetry={load} />}

      {view && (
        <div className="space-y-2.5">
          {view.hold.state === 'active' && (
            <AdminNotice tone="warning" title="On fraud hold — fulfillment is blocked.">
              {view.hold.reasonLabel}{view.hold.since ? ` Since ${fmt(view.hold.since)}.` : ''} The payment is still paid.
            </AdminNotice>
          )}
          {view.flaggedButHoldsOff && (
            <AdminNotice tone="warning" title="Stripe flagged this payment.">
              Fraud holds are switched off, so fulfillment is not blocked. Review it before shipping.
            </AdminNotice>
          )}
          {view.syncError && (
            <AdminNotice tone="danger" title="Last Stripe check failed. Risk is unknown.">
              Use Refresh to try again.
            </AdminNotice>
          )}
          {!view.hasRecord && !view.syncError && (
            <AdminNotice tone="info" title="No Stripe risk data recorded. Risk is unknown.">
              Use Refresh to read it from Stripe.
            </AdminNotice>
          )}
          {view.earlyFraudWarning?.actionable && (
            <AdminNotice tone="warning" title="Early fraud warning from the card issuer." />
          )}
          {view.fraudConfirmed && (
            <AdminNotice tone="danger" title="Marked as confirmed fraud.">
              By {view.fraudConfirmed.by} on {fmt(view.fraudConfirmed.at)}.
              {view.fraudConfirmed.note ? ` Note: ${view.fraudConfirmed.note}` : ''}
              {' '}Refund the payment in Stripe, then cancel the order below.
            </AdminNotice>
          )}

          <div className="rounded-[10px] bg-[#F8F8F6] px-3.5 py-2.5">
            <Row label="Risk"><StatusBadge {...riskBadge(view)} /></Row>
            <Row label="Radar score">{view.riskScore === null ? 'Not available' : `${view.riskScore} / 100`}</Row>
            <Row label="Stripe review">
              <StatusBadge {...reviewBadge(view.stripeReview)} />
              {view.stripeReview?.closedReason && <span className="ml-1.5 text-[11px] text-[#6B6B66]">{view.stripeReview.closedReason.replace(/_/g, ' ')}</span>}
            </Row>
            <Row label="KVRN hold"><StatusBadge {...holdBadge(view.hold.state)} /></Row>
            {view.hold.state === 'released' && (
              <Row label="Released">{view.hold.releasedBy} · {fmt(view.hold.releasedAt)}</Row>
            )}
            {view.hold.state === 'released' && view.hold.releaseNote && <Row label="Note">{view.hold.releaseNote}</Row>}
            <Row label="Last checked">{fmt(view.lastSyncedAt)}</Row>
          </div>

          <details className="rounded-[10px] border border-black/[0.08] px-3.5 py-2 text-[12px]">
            <summary className="cursor-pointer select-none py-1 font-medium text-[#171717]">
              Checks and signals
              <span className="ml-1 align-middle"><InfoTip label="About checks and signals">
                Results come straight from Stripe. A failed check or a country mismatch is shown for your review; KVRN does not decline on it.
              </InfoTip></span>
            </summary>
            <div className="mt-1.5">
              <Row label="CVC check">{checkLabel(view.checks.cvc)}</Row>
              <Row label="Address check">{checkLabel(view.checks.addressLine1)}</Row>
              <Row label="Postal code check">{checkLabel(view.checks.postalCode)}</Row>
              <Row label="3-D Secure">{threeDSLabel(view.threeDSecure)}</Row>
              <Row label="Card country">{countryLabel(view.cardCountry)}</Row>
              <Row label="Billing country">{countryLabel(view.billingCountry)}</Row>
              <Row label="Shipping country">{countryLabel(view.shippingCountry)}</Row>
              <Row label="Visitor country">{countryLabel(view.ipCountry)}</Row>
              {(view.countryMismatch.billingVsShipping || view.countryMismatch.cardVsBilling || view.countryMismatch.cardVsShipping) && (
                <p className="mt-1 text-[11px] text-[#92400E]">Some countries differ. This alone is not a reason to refuse an order.</p>
              )}
              {view.outcomeType && <Row label="Radar outcome">{view.outcomeType.replace(/_/g, ' ')}{view.outcomeReason ? ` · ${view.outcomeReason.replace(/_/g, ' ')}` : ''}</Row>}
              {view.sellerMessage && <p className="mt-1 text-[11px] text-[#6B6B66]">{view.sellerMessage}</p>}
            </div>
          </details>

          {view.canRelease && (
            <div className="rounded-[10px] border border-black/[0.08] p-3">
              <label htmlFor="fraud-note" className="mb-1 block text-[11px] font-medium text-[#4A4A46]">Note (optional)</label>
              <input id="fraud-note" value={note} onChange={e => setNote(e.target.value)} maxLength={500}
                placeholder="What you checked" className={adminInputClass} />
              <div className="mt-2 flex flex-wrap gap-2">
                <AdminButton variant="primary" onClick={() => act('release')} loading={busy === 'release'} disabled={busy !== null}>Release hold</AdminButton>
                {!view.fraudConfirmed && (
                  <AdminButton variant="danger" onClick={() => act('confirm')} loading={busy === 'confirm'} disabled={busy !== null}>Confirm fraud</AdminButton>
                )}
              </div>
              <p className="mt-2 text-[11px] text-[#6B6B66]">Releasing lets the order be fulfilled. Stripe is not changed.</p>
            </div>
          )}
          {!view.canRelease && !view.fraudConfirmed && view.hasRecord && unshipped && !refunded && view.flagged && (
            <AdminButton variant="danger" size="sm" onClick={() => act('confirm')} loading={busy === 'confirm'} disabled={busy !== null}>Confirm fraud</AdminButton>
          )}

          <div className="flex flex-wrap items-center gap-3 text-[12px]">
            {view.links.payment && <a href={view.links.payment} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Open payment in Stripe</a>}
            {view.links.review && <a href={view.links.review} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">Open review in Stripe</a>}
          </div>

          {msg && <AdminNotice tone={msg.ok ? 'success' : 'danger'}>{msg.text}</AdminNotice>}

          {view.events.length > 0 && (
            <details className="text-[12px]">
              <summary className="cursor-pointer select-none py-1 text-[#6B6B66]">History ({view.events.length})</summary>
              <ul className="mt-1 space-y-1">
                {view.events.map(e => (
                  <li key={e.id} className="flex justify-between gap-3 text-[11px] text-[#4A4A46]">
                    <span>
                      {eventLabel(e.type)}
                      {e.type === 'hold_not_applied' ? ` — ${holdNotAppliedWhy((e.detail as any)?.why)}` : ''}
                    </span>
                    <span className="shrink-0 text-[#8A8A85]">{fmt(e.createdAt)}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  )
}
