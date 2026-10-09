'use client'
import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import {
  AdminPageHeader, AdminSectionHeader, AdminCard, AdminButton, AdminNotice, AdminTable, AdminTh, AdminTd,
  StatusBadge, AdminLoading, AdminError, AdminEmpty,
} from '@/components/admin/ui/AdminUI'

type Flag = { name: string; env: string; label: string; description: string; enabled: boolean; source: 'env' | 'default'; recognised: boolean }
type Inval = { id: string; reason: string; paths: string[]; tags: string[]; status: 'pending' | 'done' | 'failed'; attempts: number; last_error: string | null; created_at: string }

export function SystemClient() {
  const [flags, setFlags] = useState<Flag[] | null>(null)
  const [inv, setInv] = useState<{ rows: Inval[]; open: number } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [retrying, setRetrying] = useState(false)
  const [retryMsg, setRetryMsg] = useState<string | null>(null)
  const [showFeatureDetails, setShowFeatureDetails] = useState(false)
  const [showActivation, setShowActivation] = useState(false)
  const [readiness, setReadiness] = useState<{ name: string; blockers: string[]; readyToActivate: boolean }[] | null>(null)
  const [otherControls, setOtherControls] = useState<{ label: string; env: string; enabled: boolean; note: string }[]>([])
  const [showOtherControls, setShowOtherControls] = useState(false)

  const load = useCallback(async () => {
    setErr(null)
    try {
      const [f, i, r] = await Promise.all([
        fetch('/api/admin/feature-flags'), fetch('/api/admin/cache-invalidations'),
        fetch('/api/admin/feature-readiness', { cache: 'no-store' }),
      ])
      if (r.ok) {
        const json = await r.json()
        setReadiness(json.items ?? null)
        setOtherControls(json.otherControls ?? [])
      }
      if (!f.ok || !i.ok) throw new Error('Request failed')
      setFlags((await f.json()).data)
      const ij = await i.json()
      setInv({ rows: ij.data, open: ij.meta?.open ?? 0 })
    } catch { setErr('Could not load system status.') }
  }, [])
  useEffect(() => { load() }, [load])

  async function retry() {
    setRetrying(true); setRetryMsg(null)
    try {
      const r = await fetch('/api/admin/cache-invalidations', { method: 'POST' })
      const j = await r.json()
      setRetryMsg(r.ok ? `Retried ${j.data.attempted}: ${j.data.done} done, ${j.data.failed} failed.` : 'Retry failed.')
      await load()
    } finally { setRetrying(false) }
  }

  return (
    <div className="mx-auto max-w-[980px] px-4 py-6 sm:px-6">
      <AdminPageHeader title="System" description="Feature switches and site refresh status." />
      {err && <AdminError message={err} onRetry={load} />}
      {!flags && !err && <AdminLoading />}

      {flags && (
        <div className="mb-8">
          <AdminSectionHeader title="Feature switches"
            info={<>Switches are Cloudflare Worker variables named <code>KVRN_FLAG_…</code>. They default to off and are changed only in Cloudflare, so a switch still works if the database is down.</>} />
          <button type="button" onClick={()=>setShowFeatureDetails(v=>!v)}
            className="mb-3 inline-flex items-center gap-2 rounded border border-neutral-300 px-3 py-2 text-xs"
            aria-expanded={showFeatureDetails} aria-controls="kvrn-system-switches">
            <span aria-hidden="true">{showFeatureDetails ? '◉' : '◎'}</span>
            {showFeatureDetails ? 'Hide feature explanations' : 'Show feature explanations'}
          </button>
          <div id="kvrn-system-switches">
          <AdminTable caption="Feature switches" stack>
            <thead><tr><AdminTh>Feature</AdminTh><AdminTh>State</AdminTh><AdminTh>Variable</AdminTh></tr></thead>
            <tbody>
              {flags.map(f => (
                <tr key={f.name}>
                  <AdminTd>
                    <span className="font-medium">{f.label}</span>
                    {showFeatureDetails && <span className="block text-[11px] text-[#6B6B66]">{f.description}</span>}
                  </AdminTd>
                  <AdminTd>
                    <StatusBadge status={f.enabled ? 'Active' : 'Inactive'} label={f.enabled ? 'On' : 'Off'} />
                    {!f.recognised && <span className="mt-1 block text-[11px] text-[#92400E]">Unrecognised value — treated as Off.</span>}
                  </AdminTd>
                  <AdminTd><code className="text-[11px] text-[#4A4A46]">{f.env}</code></AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          </div>
          {readiness && (
            <div className="mt-3 rounded-xl border border-black/10 bg-white p-3 sm:p-4">
              <button type="button" className="text-left text-xs font-medium underline underline-offset-2"
                aria-expanded={showActivation} onClick={() => setShowActivation(v => !v)}>
                {showActivation ? 'Hide' : 'Show'} activation requirements
              </button>
              {showActivation && (
                <div className="mt-3 space-y-3">
                  {readiness.filter(r => r.blockers.length > 0).map(r => (
                    <div key={r.name} className="rounded-lg bg-[#F8F7F4] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong className="text-xs">{flags.find(f => f.name === r.name)?.label ?? r.name}</strong>
                        {({ CMS_PRODUCT_ROUTING: '/admin/products', CMS_PUBLIC_CONTENT: '/admin/content', AFFILIATE_APPLICATIONS: '/admin/financials/affiliates', AFFILIATE_PORTAL: '/admin/financials/affiliates', ABANDONED_CHECKOUT_EMAILS: '/admin/abandoned-checkouts', RADAR_FULFILLMENT_HOLDS: '/admin/orders' } as Record<string,string>)[r.name] &&
                        <Link className="text-[11px] underline underline-offset-2" href={({ CMS_PRODUCT_ROUTING: '/admin/products', CMS_PUBLIC_CONTENT: '/admin/content', AFFILIATE_APPLICATIONS: '/admin/financials/affiliates', AFFILIATE_PORTAL: '/admin/financials/affiliates', ABANDONED_CHECKOUT_EMAILS: '/admin/abandoned-checkouts', RADAR_FULFILLMENT_HOLDS: '/admin/orders' } as Record<string,string>)[r.name]}>Open in Admin</Link>}
                      </div>
                      <ul className="mt-1 list-disc pl-5 text-xs text-[#666660] space-y-1">
                        {r.blockers.map((b, i) => <li key={i}>{b}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <AdminNotice tone="info" className="mt-3">
            USD checkout and manual affiliate payouts are intentional. "On" is a deployed Worker setting, not proof of production readiness. Public CMS, transactional email and fraud holds need their prerequisites confirmed.
          </AdminNotice>
          {otherControls.length > 0 && (
            <div className="mt-4 rounded-xl border border-black/10 bg-white p-3 sm:p-4">
              <button type="button" onClick={() => setShowOtherControls(v => !v)}
                aria-expanded={showOtherControls} aria-controls="kvrn-other-production-gates"
                className="text-left text-xs font-medium underline underline-offset-2">
                {showOtherControls ? 'Hide' : 'Show'} other production controls ({otherControls.filter(c => !c.enabled).length} inactive)
              </button>
              {showOtherControls && <div id="kvrn-other-production-gates" className="mt-3 divide-y divide-black/10">
                {otherControls.map(c => <div key={c.env} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="text-[12px] font-medium">{c.label}</p>
                    <p className="mt-0.5 text-[11px] text-[#777771]">{c.note}</p>
                    <code className="mt-1 block break-all text-[10px] text-[#777771]">{c.env}</code>
                  </div>
                  <StatusBadge status={c.enabled ? 'Active' : 'Inactive'} label={c.enabled ? 'On' : 'Off'} />
                </div>)}
              </div>}
            </div>
          )}
        </div>
      )}

      {inv && (
        <div>
          <AdminSectionHeader title="Site refresh"
            info={<>After content changes are saved, KVRN refreshes the affected storefront pages. A failed refresh stays listed here until it succeeds.</>}
            actions={<AdminButton size="sm" onClick={retry} loading={retrying} disabled={inv.open === 0}>Retry failed</AdminButton>} />
          {inv.open > 0 && <AdminNotice tone="warning" className="mb-3" title={`${inv.open} refresh${inv.open === 1 ? '' : 'es'} not completed.`}>The public site may show older content until these succeed.</AdminNotice>}
          {retryMsg && <AdminNotice tone="info" className="mb-3">{retryMsg}</AdminNotice>}
          {inv.rows.length === 0 ? <AdminEmpty title="No refreshes yet" /> : (
            <AdminTable caption="Recent site refreshes" stack>
              <thead><tr><AdminTh>When</AdminTh><AdminTh>What changed</AdminTh><AdminTh>Status</AdminTh></tr></thead>
              <tbody>
                {inv.rows.map(r => (
                  <tr key={r.id}>
                    <AdminTd>{new Date(r.created_at).toLocaleString()}</AdminTd>
                    <AdminTd>{r.reason}<span className="block text-[11px] text-[#8A8A85]">{r.paths.slice(0, 3).join(', ')}{r.paths.length > 3 ? ` +${r.paths.length - 3}` : ''}</span>
                      {r.last_error && <span className="block text-[11px] text-[#991B1B]">{r.last_error}</span>}</AdminTd>
                    <AdminTd><StatusBadge status={r.status === 'done' ? 'Active' : r.status === 'failed' ? 'Failed' : 'Pending'} label={r.status === 'done' ? 'Done' : undefined} /></AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </div>
      )}
    </div>
  )
}
