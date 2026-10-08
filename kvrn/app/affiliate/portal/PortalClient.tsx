'use client'
// Affiliate portal: Overview · Commissions · Payouts · Onboarding & compliance · Profile.
// Every number comes from the server (SQL). The browser only formats. Unknown values render as "—", never $0.
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  accessBanner, formatCents, labelFor, PAYOUT_STATUS_LABEL, portalFetch, READINESS_LABEL, REVERSAL_LABEL,
  SALE_STATUS_LABEL, setupSteps, toneForStatus, type Tone,
} from '@/lib/affiliate-portal-ui'
import { DocumentView } from './DocumentView'

type TabId = 'overview' | 'commissions' | 'payouts' | 'onboarding' | 'profile'
const TABS: Array<{ id: TabId; label: string }> = [
  { id: 'overview', label: 'Overview' }, { id: 'commissions', label: 'Commissions' }, { id: 'payouts', label: 'Payouts' },
  { id: 'onboarding', label: 'Onboarding & compliance' }, { id: 'profile', label: 'Profile' },
]

const TONE: Record<Tone, string> = {
  good: 'border-[#BBF7D0] bg-[#F0FDF4] text-[#166534]', warn: 'border-[#FDE68A] bg-[#FFFBEB] text-[#92400E]',
  bad: 'border-[#FECACA] bg-[#FEF2F2] text-[#991B1B]', muted: 'border-black/[0.10] bg-[#F5F5F3] text-[#4A4A46]',
}
const Pill = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
  <span className={`inline-flex items-center rounded-full border px-2 py-[2px] text-[10px] font-medium uppercase tracking-[0.06em] ${TONE[tone]}`}>{children}</span>
)
const Card = ({ children, className = '' }: { children: React.ReactNode; className?: string }) => (
  <section className={`rounded-[14px] border border-black/[0.08] bg-white p-4 sm:p-5 ${className}`}>{children}</section>
)
const H2 = ({ children }: { children: React.ReactNode }) => <h2 className="mb-3 text-[13px] font-medium">{children}</h2>
const Banner = ({ tone, children }: { tone: Tone; children: React.ReactNode }) => (
  <div role={tone === 'bad' ? 'alert' : 'status'} className={`mb-4 rounded-[10px] border px-3.5 py-2.5 text-[13px] leading-[1.5] ${TONE[tone]}`}>{children}</div>
)
const dateOnly = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : '—')

function useApi<T>(path: string | null) {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: string | null; status: number }>({ loading: !!path, data: null, error: null, status: 0 })
  const load = useCallback(async () => {
    if (!path) return
    setState(s => ({ ...s, loading: true }))
    const r = await portalFetch<T>(path)
    setState({ loading: false, data: r.ok ? r.data : null, error: r.ok ? null : r.error, status: r.status })
    if (r.status === 401) window.location.replace('/affiliate/login')
  }, [path])
  useEffect(() => { load() }, [load])
  return { ...state, reload: load }
}

type Me = { name: string; code: string; programStatus: string; readOnly: boolean; accessReason: string; requiresReacceptance: boolean }

export function PortalClient() {
  const me = useApi<Me>('/api/affiliate/me')
  const [tab, setTab] = useState<TabId>('overview')

  useEffect(() => {
    try {
      const t = new URLSearchParams(window.location.search).get('tab')
      if (t && TABS.some(x => x.id === t)) setTab(t as TabId)
    } catch { /* ignore */ }
  }, [])

  async function logout() {
    await portalFetch('/api/affiliate/auth/logout', { method: 'POST', body: {} })
    window.location.replace('/affiliate/login')
  }

  if (me.loading && !me.data) return <p className="text-[13px] text-[#6B6B66]" role="status">Loading…</p>
  if (!me.data) return <Banner tone="bad">{me.error ?? 'Could not load your portal.'} <a className="underline" href="/affiliate/login">Sign in</a></Banner>

  const banner = accessBanner(me.data)
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-[20px] font-medium leading-tight">{me.data.name}</h1>
          <p className="text-[12px] text-[#6B6B66]">Code <span className="font-medium text-[#171717]">{me.data.code}</span></p>
        </div>
        <button type="button" onClick={logout} className="h-9 rounded-[9px] border border-black/[0.14] bg-white px-3 text-[12px]">Sign out</button>
      </div>
      {banner && <Banner tone={banner.tone}>{banner.text}</Banner>}
      <div role="tablist" aria-label="Portal sections" className="mb-4 flex gap-1 overflow-x-auto border-b border-black/[0.08]">
        {TABS.map(t => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[13px] font-medium ${tab === t.id ? 'border-[#171717] text-[#171717]' : 'border-transparent text-[#6B6B66]'}`}>{t.label}</button>
        ))}
      </div>
      {tab === 'overview' && <OverviewTab />}
      {tab === 'commissions' && <CommissionsTab />}
      {tab === 'payouts' && <PayoutsTab />}
      {tab === 'onboarding' && <OnboardingTab readOnly={me.data.readOnly} />}
      {tab === 'profile' && <ProfileTab readOnly={me.data.readOnly} />}
    </div>
  )
}

// ── Overview ─────────────────────────────────────────────────────────────────
function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-[12px] border border-black/[0.08] bg-white p-3.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.1em] text-[#8A8A85]">{label}</p>
      <p className="mt-1 text-[20px] font-medium leading-tight">{value}</p>
      {hint && <p className="mt-1 text-[11px] text-[#6B6B66]">{hint}</p>}
    </div>
  )
}

function OverviewTab() {
  const [range, setRange] = useState('30d')
  const o = useApi<any>(`/api/affiliate/overview?range=${range}`)
  const [copied, setCopied] = useState<string | null>(null)
  if (o.loading && !o.data) return <p className="text-[13px] text-[#6B6B66]" role="status">Loading…</p>
  if (!o.data) return <Banner tone="bad">{o.error ?? 'Could not load your overview.'}</Banner>
  const { summary: s, balances: b, performance: p } = o.data
  const links: string[] = (s?.referralPaths ?? []).map((x: string) => `${s.siteOrigin ?? ''}${x}`)
  const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); setCopied(t); setTimeout(() => setCopied(null), 1500) } catch { /* ignore */ } }
  const rule = s?.commissionRule
  const ruleText = rule ? (rule.type === 'percentage' && rule.rateBps !== null ? `${(rule.rateBps / 100).toFixed(rule.rateBps % 100 ? 2 : 0)}% of ${rule.basis}` : rule.fixedCents !== null ? `${formatCents(rule.fixedCents)} per order` : '—') : '—'

  return (
    <div className="space-y-4">
      <Card>
        <H2>Your code and links</H2>
        {!s?.codeLive && <Banner tone="warn">Your code is not currently active, so new sales are not being tracked.</Banner>}
        <dl className="grid gap-3 text-[13px] sm:grid-cols-2">
          <div><dt className="text-[11px] text-[#6B6B66]">Affiliate code</dt><dd className="font-medium">{s?.code}</dd></div>
          <div><dt className="text-[11px] text-[#6B6B66]">Customer discount</dt>
            <dd className="font-medium">{s?.discount ? `${s.discount.code}${s.discount.percentageBps ? ` · ${(s.discount.percentageBps / 100).toFixed(0)}% off` : s.discount.amountCents ? ` · ${formatCents(s.discount.amountCents)} off` : ''}${s.discount.active ? '' : ' (inactive)'}` : 'None'}</dd></div>
          <div><dt className="text-[11px] text-[#6B6B66]">Your commission</dt><dd className="font-medium">{ruleText}</dd></div>
          <div><dt className="text-[11px] text-[#6B6B66]">Tracking window · hold</dt><dd className="font-medium">{s?.attributionWindowDays} days · {s?.holdDays} days before payable</dd></div>
        </dl>
        {links.length > 0 && (
          <div className="mt-3 space-y-2">
            {links.map(l => (
              <div key={l} className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-[8px] bg-[#F5F5F3] px-2.5 py-2 text-[12px]">{l}</code>
                <button type="button" onClick={() => copy(l)} className="h-9 rounded-[9px] border border-black/[0.14] px-3 text-[12px]">{copied === l ? 'Copied' : 'Copy'}</button>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <H2>Balances</H2>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Pending" value={formatCents(b.pendingCents)} hint="Still in the hold window" />
          <Stat label="Available" value={formatCents(b.availableCents)} hint="Ready for the next payout" />
          <Stat label="In payout" value={formatCents(b.inPayoutCents)} hint="Reserved in a payout" />
          <Stat label="Paid" value={formatCents(b.paidCents)} hint="Sent to you" />
        </div>
        {b.unresolvedCount > 0 && (
          <Banner tone="warn"><span className="mt-3 block">{b.unresolvedCount} sale{b.unresolvedCount === 1 ? ' is' : 's are'} under review (refund or dispute not settled). Their final value is not included above until resolved.</span></Banner>
        )}
        {(b.reversedCents !== 0 || b.owedBackCents > 0) && (
          <p className="mt-3 text-[12px] text-[#6B6B66]">
            Reversed: {formatCents(b.reversedCents)}{b.recoveredCents ? ` · Recovered: ${formatCents(b.recoveredCents)}` : ''}{b.owedBackCents > 0 ? ` · Owed back: ${formatCents(b.owedBackCents)}` : ''}
          </p>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex items-center justify-between gap-2">
          <h2 className="text-[13px] font-medium">Performance</h2>
          <select aria-label="Date range" value={range} onChange={e => setRange(e.target.value)} className="h-9 rounded-[9px] border border-black/[0.14] bg-white px-2 text-[12px]">
            <option value="30d">Last 30 days</option><option value="90d">Last 90 days</option><option value="ytd">Year to date</option><option value="all">All time</option>
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Clicks" value={String(p.clicks)} />
          <Stat label="Orders" value={String(p.attributedOrders)} />
          <Stat label="Referred sales" value={formatCents(p.grossReferredSalesCents)} hint="Before refunds" />
          <Stat label="Net referred revenue" value={formatCents(p.netReferredRevenueCents)} hint={p.netIsPartial ? `Excludes ${p.ordersUnderReview} order${p.ordersUnderReview === 1 ? '' : 's'} under review` : 'After refunds and disputes'} />
        </div>
      </Card>
    </div>
  )
}

// ── Commissions ──────────────────────────────────────────────────────────────
function CommissionsTab() {
  const [offset, setOffset] = useState(0)
  const c = useApi<{ sales: any[]; hasMore: boolean }>(`/api/affiliate/commissions?limit=25&offset=${offset}`)
  if (c.loading && !c.data) return <p className="text-[13px] text-[#6B6B66]" role="status">Loading…</p>
  if (!c.data) return <Banner tone="bad">{c.error ?? 'Could not load your commissions.'}</Banner>
  return (
    <Card>
      <H2>Sales and commission status</H2>
      {c.data.sales.length === 0 ? <p className="text-[13px] text-[#6B6B66]">No sales yet. When someone buys with your code or link, it shows up here.</p> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-[12px]">
            <thead><tr className="text-[10px] uppercase tracking-[0.08em] text-[#8A8A85]">
              <th className="py-2 pr-3">Date</th><th className="pr-3">Sale ref</th><th className="pr-3">Items</th><th className="pr-3 text-right">Net sale</th><th className="pr-3 text-right">Commission</th><th>Status</th></tr></thead>
            <tbody>
              {c.data.sales.map((s: any) => (
                <tr key={s.ref} className="border-t border-black/[0.06] align-top">
                  <td className="py-2.5 pr-3 whitespace-nowrap">{dateOnly(s.date)}</td>
                  <td className="pr-3 font-mono text-[11px]">{s.ref}</td>
                  <td className="pr-3 text-[#4A4A46]">{s.items ?? '—'}</td>
                  <td className="pr-3 text-right">{formatCents(s.netSaleCents)}</td>
                  <td className="pr-3 text-right">{formatCents(s.netCommissionCents)}{s.netCommissionCents !== null && s.netCommissionCents !== s.commissionCents && <span className="block text-[10px] text-[#8A8A85]">was {formatCents(s.commissionCents)}</span>}</td>
                  <td><Pill tone={toneForStatus(s.status)}>{labelFor(SALE_STATUS_LABEL, s.status)}</Pill>{REVERSAL_LABEL[s.reversalStatus] && <span className="mt-1 block text-[10px] text-[#8A8A85]">{REVERSAL_LABEL[s.reversalStatus]}</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="mt-3 flex items-center justify-between">
        <button type="button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))} className="h-9 rounded-[9px] border border-black/[0.14] px-3 text-[12px] disabled:opacity-40">Newer</button>
        <button type="button" disabled={!c.data.hasMore} onClick={() => setOffset(offset + 25)} className="h-9 rounded-[9px] border border-black/[0.14] px-3 text-[12px] disabled:opacity-40">Older</button>
      </div>
      <p className="mt-3 text-[11px] text-[#8A8A85]">To protect customer privacy, sales are identified by a reference, not by customer or order number.</p>
    </Card>
  )
}

// ── Payouts ──────────────────────────────────────────────────────────────────
function PayoutsTab() {
  const p = useApi<{ payouts: any[] }>('/api/affiliate/payouts')
  const [open, setOpen] = useState<string | null>(null)
  if (p.loading && !p.data) return <p className="text-[13px] text-[#6B6B66]" role="status">Loading…</p>
  if (!p.data) return <Banner tone="bad">{p.error ?? 'Could not load your payouts.'}</Banner>
  return (
    <div className="space-y-4">
      <Card>
        <H2>Payout history</H2>
        {p.data.payouts.length === 0 ? <p className="text-[13px] text-[#6B6B66]">No payouts yet.</p> : (
          <ul className="divide-y divide-black/[0.06]">
            {p.data.payouts.map((x: any) => (
              <li key={x.ref} className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div><span className="font-mono text-[12px]">{x.ref}</span> <span className="ml-2 text-[12px] text-[#6B6B66]">{dateOnly(x.date)}{x.method ? ` · ${x.method}` : ''}</span></div>
                  <div className="flex items-center gap-2"><span className="text-[14px] font-medium">{formatCents(x.amountCents, x.currency)}</span><Pill tone={toneForStatus(x.status)}>{labelFor(PAYOUT_STATUS_LABEL, x.status)}</Pill></div>
                </div>
                {x.status === 'failed' && <p className="mt-1 text-[12px] text-[#991B1B]">This payout did not go through. Your commission is safe and still reserved; we will retry.</p>}
                <div className="mt-2 flex gap-3 text-[12px]">
                  <button type="button" className="underline underline-offset-2" onClick={() => setOpen(open === x.ref ? null : x.ref)}>{open === x.ref ? 'Hide statement' : 'View statement'}</button>
                  <a className="underline underline-offset-2" href={`/api/affiliate/payouts/${encodeURIComponent(x.ref)}/statement?format=csv`}>Download CSV</a>
                </div>
                {open === x.ref && <Statement payoutRef={x.ref} />}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function Statement({ payoutRef }: { payoutRef: string }) {
  const s = useApi<{ statement: any }>(`/api/affiliate/payouts/${encodeURIComponent(payoutRef)}/statement`)
  if (s.loading && !s.data) return <p className="mt-2 text-[12px] text-[#6B6B66]" role="status">Loading statement…</p>
  if (!s.data) return <Banner tone="bad">{s.error ?? 'Could not load the statement.'}</Banner>
  const st = s.data.statement
  return (
    <div className="mt-3 rounded-[10px] bg-[#FAFAF8] p-3 text-[12px]">
      {!st.totals.reconciled && <Banner tone="warn">This statement needs review. Contact support and quote reference {st.payoutRef}.</Banner>}
      <dl className="grid grid-cols-2 gap-y-1">
        <dt>Commission earned</dt><dd className="text-right">{formatCents(st.totals.grossEarnedCents)}</dd>
        <dt>Adjustments (reversals and corrections)</dt><dd className="text-right">{formatCents(st.totals.adjustmentsCents)}</dd>
        <dt>Already paid on earlier payouts</dt><dd className="text-right">{formatCents(-st.totals.previouslyPaidCents)}</dd>
        {st.totals.recoveredCents !== 0 && (<><dt>Recovered from you</dt><dd className="text-right">{formatCents(st.totals.recoveredCents)}</dd></>)}
        <dt className="font-medium">Net payout</dt><dd className="text-right font-medium">{formatCents(st.totals.netCents)}</dd>
      </dl>
      <div className="mt-3 overflow-x-auto"><table className="w-full min-w-[420px] text-left">
        <thead><tr className="text-[10px] uppercase tracking-[0.08em] text-[#8A8A85]"><th className="py-1 pr-2">Sale</th><th className="pr-2">Date</th><th className="pr-2 text-right">Earned</th><th className="pr-2 text-right">Adjust.</th><th className="text-right">Line</th></tr></thead>
        <tbody>{st.lines.map((l: any) => (
          <tr key={l.saleRef} className="border-t border-black/[0.06]"><td className="py-1.5 pr-2 font-mono text-[11px]">{l.saleRef}</td><td className="pr-2">{dateOnly(l.saleDate)}</td>
            <td className="pr-2 text-right">{formatCents(l.earnedCents)}</td><td className="pr-2 text-right">{formatCents(l.adjustmentsCents)}</td><td className="text-right">{formatCents(l.lineAmountCents)}</td></tr>))}</tbody>
      </table></div>
    </div>
  )
}

// ── Onboarding & compliance ──────────────────────────────────────────────────
function OnboardingTab({ readOnly }: { readOnly: boolean }) {
  const o = useApi<any>('/api/affiliate/onboarding')
  const [viewDoc, setViewDoc] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  const steps = useMemo(() => setupSteps(o.data), [o.data])
  if (o.loading && !o.data) return <p className="text-[13px] text-[#6B6B66]" role="status">Loading…</p>
  if (!o.data) return <Banner tone="bad">{o.error ?? 'Could not load your setup.'}</Banner>
  const d = o.data
  const pendingDocs = (d.terms.documents as any[]).filter(x => x.needsAcceptance)

  async function accept() {
    setBusy(true); setMsg(null)
    const r = await portalFetch('/api/affiliate/onboarding/accept', { method: 'POST', body: { docTypes: pendingDocs.map(x => x.docType) } })
    setBusy(false)
    if (r.ok) { setMsg({ tone: 'good', text: 'Thank you. Your acceptance is recorded.' }); o.reload() } else setMsg({ tone: 'bad', text: r.error ?? 'Could not record your acceptance.' })
  }
  async function startSetup() {
    setBusy(true); setMsg(null)
    const r = await portalFetch<any>('/api/affiliate/payout-setup', { method: 'POST', body: {} })
    setBusy(false)
    if (!r.ok) { setMsg({ tone: 'bad', text: r.error ?? 'Could not start payout setup.' }); return }
    if (r.data?.kind === 'hosted_link' && typeof r.data.url === 'string' && r.data.url.startsWith('https://')) { window.location.assign(r.data.url); return }
    setMsg({ tone: 'good', text: r.data?.message ?? 'We will be in touch to finish setup.' })
  }

  return (
    <div className="space-y-4">
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <Card>
        <H2>Setup checklist</H2>
        <ul className="space-y-2">
          {steps.map(s => (
            <li key={s.id} className="flex items-center justify-between gap-2 text-[13px]">
              <span>{s.done ? '✓ ' : '○ '}{s.label}</span>
              <Pill tone={s.done ? 'good' : toneForStatus(s.status)}>{s.id === 'terms' ? (s.done ? 'Accepted' : 'Needs acceptance') : labelFor(READINESS_LABEL, s.status)}</Pill>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[12px] text-[#6B6B66]">Payouts start once every step is complete. You never need to email documents or bank details; sensitive details are handled by our payout provider, not this portal.</p>
        {!readOnly && <button type="button" onClick={startSetup} disabled={busy} className="mt-3 h-9 rounded-[9px] border border-black/[0.14] px-3 text-[12px] disabled:opacity-50">Set up identity, tax and payout details</button>}
        {d.readiness.payoutMethodDisplay && Object.keys(d.readiness.payoutMethodDisplay).length > 0 && (
          <p className="mt-3 text-[12px] text-[#4A4A46]">On file: {Object.values(d.readiness.payoutMethodDisplay).filter(v => typeof v === 'string').join(' · ')}</p>
        )}
      </Card>

      <Card>
        <H2>Program documents</H2>
        <ul className="divide-y divide-black/[0.06]">
          {(d.terms.documents as any[]).map(x => (
            <li key={x.docType} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-[13px]">
              <div><span className="font-medium">{x.title}</span> <span className="text-[11px] text-[#8A8A85]">v{x.version}</span></div>
              <div className="flex items-center gap-2">
                {x.needsAcceptance ? <Pill tone="warn">Needs acceptance</Pill> : <Pill tone="good">Accepted</Pill>}
                <button type="button" className="text-[12px] underline underline-offset-2" onClick={() => setViewDoc(viewDoc === x.docType ? null : x.docType)}>{viewDoc === x.docType ? 'Hide' : 'Read'}</button>
              </div>
            </li>
          ))}
        </ul>
        {viewDoc && <DocumentView docType={viewDoc} />}
        {pendingDocs.length > 0 && !readOnly && (
          <button type="button" onClick={accept} disabled={busy} className="mt-3 h-10 rounded-[9px] bg-[#171717] px-4 text-[13px] font-medium text-white disabled:opacity-50">
            I have read and accept the updated {pendingDocs.length === 1 ? 'document' : 'documents'}
          </button>
        )}
      </Card>

      <Card>
        <H2>Compliance</H2>
        <p className="text-[13px]">Paid advertising: <strong>{d.paidAdsPolicy === 'approved' ? 'Approved' : d.paidAdsPolicy === 'written_approval' ? 'Allowed with written approval from KVRN' : 'Not permitted'}</strong></p>
        <p className="mt-1 text-[12px] text-[#6B6B66]">Always disclose that you earn a commission when you promote KVRN. Read the disclosure policy above.</p>
        {d.warnings.length > 0 && (
          <div className="mt-3 space-y-2">
            <p className="text-[12px] font-medium">Notices from KVRN</p>
            {(d.warnings as any[]).map((w, i) => (
              <div key={i} className={`rounded-[10px] border px-3 py-2 text-[12px] ${TONE[w.status === 'open' ? (w.severity === 'notice' ? 'warn' : 'bad') : 'muted']}`}>
                <div className="font-medium">{w.severity === 'final' ? 'Final notice' : w.severity === 'warning' ? 'Warning' : 'Notice'} · {dateOnly(w.date)}{w.status === 'resolved' ? ' · resolved' : ''}</div>
                <div className="mt-0.5">{w.message}</div>
              </div>
            ))}
          </div>
        )}
        <p className="mt-3 text-[12px] text-[#6B6B66]">Questions? Contact {d.help?.contact}.</p>
      </Card>
    </div>
  )
}

// ── Profile ──────────────────────────────────────────────────────────────────
const PLATFORMS = ['instagram', 'tiktok', 'youtube', 'x', 'facebook', 'pinterest', 'twitch', 'website', 'other']
function ProfileTab({ readOnly }: { readOnly: boolean }) {
  const p = useApi<{ profile: any }>('/api/affiliate/profile')
  const [form, setForm] = useState<{ displayName: string; website: string; links: Array<{ platform: string; url: string }> } | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: Tone; text: string } | null>(null)
  useEffect(() => {
    if (p.data) setForm({ displayName: p.data.profile.displayName ?? '', website: p.data.profile.website ?? '', links: (p.data.profile.socialLinks ?? []).map((l: any) => ({ platform: l.platform, url: l.url })) })
  }, [p.data])
  if (p.loading && !p.data) return <p className="text-[13px] text-[#6B6B66]" role="status">Loading…</p>
  if (!p.data || !form) return <Banner tone="bad">{p.error ?? 'Could not load your profile.'}</Banner>

  async function save(e: React.FormEvent) {
    e.preventDefault(); if (!form) return
    setBusy(true); setMsg(null)
    const r = await portalFetch('/api/affiliate/profile', { method: 'PATCH', body: {
      displayName: form.displayName, website: form.website.trim() === '' ? null : form.website.trim(),
      socialLinks: form.links.filter(l => l.url.trim() !== '').map(l => ({ platform: l.platform, url: l.url.trim() })),
    } })
    setBusy(false)
    setMsg(r.ok ? { tone: 'good', text: 'Saved.' } : { tone: 'bad', text: r.error ?? 'Could not save.' })
  }
  const input = 'h-10 w-full rounded-[9px] border border-black/[0.18] bg-white px-3 text-[13px] disabled:bg-black/[0.03]'
  return (
    <Card>
      <H2>Public details</H2>
      <p className="mb-3 text-[12px] text-[#6B6B66]">Commission rate, code and payout settings are managed by KVRN. Contact support to change them.</p>
      {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
      <form onSubmit={save} className="space-y-3">
        <div><label htmlFor="pf-name" className="mb-1 block text-[12px] font-medium">Display name</label>
          <input id="pf-name" className={input} disabled={readOnly} maxLength={80} value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} /></div>
        <div><label htmlFor="pf-web" className="mb-1 block text-[12px] font-medium">Website</label>
          <input id="pf-web" className={input} disabled={readOnly} inputMode="url" placeholder="https://" maxLength={200} value={form.website} onChange={e => setForm({ ...form, website: e.target.value })} /></div>
        <fieldset><legend className="mb-1 text-[12px] font-medium">Social links</legend>
          <div className="space-y-2">
            {form.links.map((l, i) => (
              <div key={i} className="flex gap-2">
                <select aria-label="Platform" disabled={readOnly} className="h-10 rounded-[9px] border border-black/[0.18] bg-white px-2 text-[13px]" value={l.platform}
                  onChange={e => setForm({ ...form, links: form.links.map((x, j) => j === i ? { ...x, platform: e.target.value } : x) })}>
                  {PLATFORMS.map(pl => <option key={pl} value={pl}>{pl}</option>)}</select>
                <input aria-label="Link" className={input} disabled={readOnly} placeholder="https://" maxLength={300} value={l.url}
                  onChange={e => setForm({ ...form, links: form.links.map((x, j) => j === i ? { ...x, url: e.target.value } : x) })} />
                {!readOnly && <button type="button" aria-label="Remove link" className="h-10 rounded-[9px] border border-black/[0.14] px-3 text-[12px]" onClick={() => setForm({ ...form, links: form.links.filter((_, j) => j !== i) })}>×</button>}
              </div>
            ))}
          </div>
          {!readOnly && form.links.length < 8 && <button type="button" className="mt-2 text-[12px] underline underline-offset-2" onClick={() => setForm({ ...form, links: [...form.links, { platform: 'instagram', url: '' }] })}>Add a link</button>}
        </fieldset>
        {!readOnly && <button type="submit" disabled={busy} className="h-10 rounded-[9px] bg-[#171717] px-4 text-[13px] font-medium text-white disabled:opacity-50">{busy ? 'Saving…' : 'Save'}</button>}
      </form>
    </Card>
  )
}
