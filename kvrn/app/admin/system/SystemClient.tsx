'use client'
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

  const load = useCallback(async () => {
    setErr(null)
    try {
      const [f, i] = await Promise.all([fetch('/api/admin/feature-flags'), fetch('/api/admin/cache-invalidations')])
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
          <AdminTable caption="Feature switches">
            <thead><tr><AdminTh>Feature</AdminTh><AdminTh>State</AdminTh><AdminTh>Variable</AdminTh></tr></thead>
            <tbody>
              {flags.map(f => (
                <tr key={f.name}>
                  <AdminTd>
                    <span className="font-medium">{f.label}</span>
                    <span className="block text-[11px] text-[#6B6B66]">{f.description}</span>
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
      )}

      {inv && (
        <div>
          <AdminSectionHeader title="Site refresh"
            info={<>After content changes are saved, KVRN refreshes the affected storefront pages. A failed refresh stays listed here until it succeeds.</>}
            actions={<AdminButton size="sm" onClick={retry} loading={retrying} disabled={inv.open === 0}>Retry failed</AdminButton>} />
          {inv.open > 0 && <AdminNotice tone="warning" className="mb-3" title={`${inv.open} refresh${inv.open === 1 ? '' : 'es'} not completed.`}>The public site may show older content until these succeed.</AdminNotice>}
          {retryMsg && <AdminNotice tone="info" className="mb-3">{retryMsg}</AdminNotice>}
          {inv.rows.length === 0 ? <AdminEmpty title="No refreshes yet" /> : (
            <AdminTable caption="Recent site refreshes">
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
