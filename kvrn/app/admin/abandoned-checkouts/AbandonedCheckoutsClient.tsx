'use client'
import { useCallback, useEffect, useState } from 'react'
import {
  AdminPageHeader, AdminSectionHeader, AdminCard, AdminButton, AdminNotice, AdminField, AdminFieldGrid, adminInputClass, adminSelectClass,
  AdminTable, AdminTh, AdminTd, AdminTabs, StatusBadge, AdminEmpty, AdminLoading, AdminError, InfoTip, useConfirm,
} from '@/components/admin/ui/AdminUI'
import {
  stateBadge, ineligibleLabel, summarizeCart, revenueDisplay, canRetry, formatMoney,
} from '@/lib/abandoned-checkout-ui'

type Row = {
  id: string; email: string | null; locale: string | null; currency: string; cart: unknown; state: string
  ineligible_reason: string | null; recovery_attempts: number; manual_retries: number; last_error: string | null
  abandoned_at: string | null; created_at: string; recovery_sent_at: string | null; recovered_at: string | null
  recovery_revenue_cents: number | null; recovery_revenue_currency: string | null; recovered_order_number: string | null
}
type Config = { enabled: boolean; delay_minutes: number; max_emails: 1; consent_mode: 'require_opt_in' | 'cart_reminder_no_consent'; window_hours: number }
type Summary = { windowDays: number; abandoned: number; sent: number; recovered: number; failed: number; revenueUnknownCount: number; revenue: Array<{ currency: string; cents: number }> }
type Readiness = { flagEnabled: boolean; linkSecretConfigured: boolean; providerConfigured: boolean; originConfigured: boolean }
type Data = { rows: Row[]; summary: Summary; config: Config; revision: number; readiness: Readiness }

type View = 'all' | 'abandoned' | 'sent' | 'recovered' | 'failed' | 'ineligible'
const TABS: Array<{ id: View; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'abandoned', label: 'Abandoned' }, { id: 'sent', label: 'Sent' },
  { id: 'recovered', label: 'Recovered' }, { id: 'failed', label: 'Failed' }, { id: 'ineligible', label: 'Not eligible' },
]

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : '—')

export function AbandonedCheckoutsClient() {
  const [view, setView] = useState<View>('all')
  const [data, setData] = useState<Data | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [draft, setDraft] = useState<Config | null>(null)
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [msg, setMsg] = useState<{ tone: 'success' | 'danger'; text: string } | null>(null)
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState<string | null>(null)
  const { confirm, node: confirmNode } = useConfirm()

  const load = useCallback(async () => {
    setErr(null)
    try {
      const r = await fetch(`/api/admin/abandoned-checkouts?view=${view}`, { cache: 'no-store' })
      if (!r.ok) throw new Error('Request failed')
      const j = await r.json()
      setData(j.data)
      setDraft(prev => prev ?? j.data.config)
    } catch { setErr('Could not load abandoned checkouts.') }
  }, [view])
  useEffect(() => { load() }, [load])

  async function save() {
    if (!draft || !data) return
    if (draft.consent_mode === 'cart_reminder_no_consent' && data.config.consent_mode !== 'cart_reminder_no_consent') {
      const ok = await confirm('Cart reminders will also go to people who never opted in to marketing. Only choose this if your legal advisor has approved it for the places you sell to. Switch?')
      if (!ok) return
    }
    setSaving(true); setMsg(null); setFieldErrors({})
    try {
      const r = await fetch('/api/admin/abandoned-checkouts', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: draft, revision: data.revision }),
      })
      const j = await r.json()
      if (r.ok) { setMsg({ tone: 'success', text: 'Settings saved.' }); setDraft(null); await load() }
      else { setFieldErrors(j.errors ?? {}); setMsg({ tone: 'danger', text: j.error ?? 'Could not save.' }) }
    } finally { setSaving(false) }
  }

  async function retry(row: Row) {
    setRetrying(row.id); setMsg(null)
    try {
      const r = await fetch('/api/admin/abandoned-checkouts', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'retry', id: row.id }),
      })
      const j = await r.json().catch(() => ({}))
      setMsg(r.ok ? { tone: 'success', text: 'Queued for one more try. It sends on the next check.' } : { tone: 'danger', text: j.error ?? 'Retry failed.' })
      await load()
    } finally { setRetrying(null) }
  }

  const rd = data?.readiness
  const dirty = !!(draft && data && JSON.stringify(draft) !== JSON.stringify(data.config))

  return (
    <div className="mx-auto max-w-[1100px] px-4 py-6 sm:px-6">
      {confirmNode}
      <AdminPageHeader title="Abandoned checkouts" description="Unfinished checkouts and recovery." />
      {err && <AdminError message={err} onRetry={load} />}
      {!data && !err && <AdminLoading />}
      {msg && <AdminNotice tone={msg.tone} className="mb-4">{msg.text}</AdminNotice>}

      {data && rd && (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-2 text-[12px]">
            <span className="text-[#6B6B66]">Recovery emails</span>
            <StatusBadge status={rd.flagEnabled ? 'Active' : 'Inactive'} label={rd.flagEnabled ? 'On' : 'Off'} />
            <InfoTip label="About the recovery email switch">
              This switch is the Cloudflare variable <code>KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS</code>. It is changed only there. While it is off, checkouts are still recorded but no email is sent and recovery links are disabled.
            </InfoTip>
          </div>
          {!rd.flagEnabled && <AdminNotice tone="info" className="mb-4">Recovery emails are off. Nothing is sent.</AdminNotice>}
          {rd.flagEnabled && !rd.linkSecretConfigured && <AdminNotice tone="danger" className="mb-4" title="Link secret missing.">Emails will not send until ABANDONED_LINK_SECRET is set.</AdminNotice>}
          {rd.flagEnabled && !rd.providerConfigured && <AdminNotice tone="danger" className="mb-4" title="Email provider not configured.">Emails will not send until RESEND_API_KEY is set.</AdminNotice>}
          {rd.flagEnabled && !rd.originConfigured && <AdminNotice tone="danger" className="mb-4" title="Site address missing.">Emails will not send until SITE_URL is set.</AdminNotice>}
          {data.summary.failed > 0 && <AdminNotice tone="warning" className="mb-4" title={`${data.summary.failed} send${data.summary.failed === 1 ? '' : 's'} failed.`}>Each can be retried once.</AdminNotice>}

          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Abandoned', String(data.summary.abandoned)],
              ['Emails sent', String(data.summary.sent)],
              ['Recovered', String(data.summary.recovered)],
              ['Recovered revenue', revenueDisplay(data.summary)],
            ].map(([k, v]) => (
              <AdminCard key={k} className="!p-3">
                <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">{k}</p>
                <p className="mt-1 text-[18px] font-medium text-[#171717]">{v}</p>
              </AdminCard>
            ))}
          </div>
          <p className="-mt-3 mb-6 flex items-center gap-1 text-[11px] text-[#8A8A85]">
            Last {data.summary.windowDays} days.
            <InfoTip label="About these numbers">
              Recovered revenue is the order total of orders placed from a recovery link, in the order’s currency, before refunds. Each order is counted once. A recovered order is a normal order and also appears in Orders.
              Opens are not tracked. Clicks are counted only for people who opted in to marketing.
            </InfoTip>
          </p>

          <AdminSectionHeader title="Checkouts" />
          <AdminTabs tabs={TABS} value={view} onChange={setView} ariaLabel="Checkout status" />
          {data.rows.length === 0 ? <AdminEmpty title="Nothing here yet" description="Abandoned checkouts appear after a checkout expires unpaid." /> : (
            <AdminTable caption="Abandoned checkouts" stack>
              <thead><tr>
                <AdminTh>Customer</AdminTh><AdminTh>Bag</AdminTh><AdminTh>Abandoned</AdminTh>
                <AdminTh>Locale</AdminTh><AdminTh>Status</AdminTh><AdminTh>Recovered</AdminTh><AdminTh />
              </tr></thead>
              <tbody>
                {data.rows.map(r => {
                  const b = stateBadge(r.state)
                  return (
                    <tr key={r.id}>
                      <AdminTd>{r.email ?? <span className="text-[#8A8A85]">No email</span>}</AdminTd>
                      <AdminTd><span className="block max-w-[260px]">{summarizeCart(r.cart)}</span></AdminTd>
                      <AdminTd>{fmt(r.abandoned_at ?? r.created_at)}</AdminTd>
                      <AdminTd>{(r.locale ?? '—')} · {r.currency.toUpperCase()}</AdminTd>
                      <AdminTd>
                        <StatusBadge status={b.status} label={b.label} />
                        {r.state === 'ineligible' && <span className="mt-1 block text-[11px] text-[#6B6B66]">{ineligibleLabel(r.ineligible_reason)}</span>}
                        {r.state === 'send_failed' && (
                          <span className="mt-1 block text-[11px] text-[#991B1B]">
                            Attempt {r.recovery_attempts} failed{r.last_error ? `: ${r.last_error}` : ''}.
                          </span>
                        )}
                        {r.recovery_sent_at && <span className="mt-1 block text-[11px] text-[#8A8A85]">Sent {fmt(r.recovery_sent_at)}</span>}
                      </AdminTd>
                      <AdminTd>
                        {r.state === 'recovered'
                          ? <>{r.recovered_order_number ? `#${r.recovered_order_number}` : 'Order'}
                              <span className="block text-[11px] text-[#6B6B66]">
                                {r.recovery_revenue_cents === null ? 'Unknown' : formatMoney(r.recovery_revenue_cents, r.recovery_revenue_currency ?? 'usd')}
                              </span></>
                          : '—'}
                      </AdminTd>
                      <AdminTd>
                        {canRetry(r, rd.flagEnabled) && (
                          <AdminButton size="sm" loading={retrying === r.id} onClick={() => retry(r)}>Retry once</AdminButton>
                        )}
                        {r.state === 'send_failed' && r.manual_retries >= 1 && <span className="text-[11px] text-[#8A8A85]">Retry used</span>}
                      </AdminTd>
                    </tr>
                  )
                })}
              </tbody>
            </AdminTable>
          )}

          {draft && (
            <div className="mt-8">
              <AdminSectionHeader title="Recovery settings"
                info={<>One email per abandoned checkout, never more. It is sent after the delay, only if no order was placed and the window is still open. The recovery switch itself is not changed here.</>} />
              <AdminCard>
                <AdminFieldGrid cols={4}>
                  <AdminField label="Send reminders" htmlFor="ab-enabled">
                    <select id="ab-enabled" className={adminSelectClass} value={draft.enabled ? 'on' : 'off'}
                      onChange={e => setDraft({ ...draft, enabled: e.target.value === 'on' })}>
                      <option value="on">On</option><option value="off">Off</option>
                    </select>
                  </AdminField>
                  <AdminField label="Delay (minutes)" htmlFor="ab-delay" error={fieldErrors.delay_minutes}
                    info="Time after a checkout is abandoned before the email is sent. 15 to 1,440.">
                    <input id="ab-delay" type="number" className={adminInputClass} value={draft.delay_minutes}
                      onChange={e => setDraft({ ...draft, delay_minutes: Number(e.target.value) })} />
                  </AdminField>
                  <AdminField label="Link window (hours)" htmlFor="ab-window" error={fieldErrors.window_hours}
                    info="How long after abandonment the email may be sent and the link works. 24 to 168.">
                    <input id="ab-window" type="number" className={adminInputClass} value={draft.window_hours}
                      onChange={e => setDraft({ ...draft, window_hours: Number(e.target.value) })} />
                  </AdminField>
                  <AdminField label="Who can receive it" htmlFor="ab-consent" error={fieldErrors.consent_mode}
                    info="Opt-in required: only people already subscribed to marketing. Cart reminder: also people who never opted in. Unsubscribed addresses are always excluded.">
                    <select id="ab-consent" className={adminSelectClass} value={draft.consent_mode}
                      onChange={e => setDraft({ ...draft, consent_mode: e.target.value as Config['consent_mode'] })}>
                      <option value="require_opt_in">Opt-in required</option>
                      <option value="cart_reminder_no_consent">Cart reminder, no opt-in</option>
                    </select>
                  </AdminField>
                </AdminFieldGrid>
                {draft.consent_mode === 'cart_reminder_no_consent' && (
                  <AdminNotice tone="warning" className="mt-4" title="Legal decision.">
                    This sends to people who never opted in to marketing. Rules differ by country. Confirm it is allowed where you sell before using it.
                  </AdminNotice>
                )}
                <div className="mt-4 flex gap-2">
                  <AdminButton variant="primary" onClick={save} loading={saving} disabled={!dirty}>Save settings</AdminButton>
                  <AdminButton onClick={() => { setDraft(data.config); setFieldErrors({}) }} disabled={!dirty}>Reset</AdminButton>
                </div>
              </AdminCard>
            </div>
          )}
        </>
      )}
    </div>
  )
}
