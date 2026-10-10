'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { AdminPage, AdminButton, AdminCard, AdminError, AdminField, AdminFieldGrid, AdminLoading, AdminNotice, AdminPageHeader, adminInputClass } from '@/components/admin/ui/AdminUI'

interface Defaults { shippingReturns: { lines: string[]; linkLabel: string; href: string } }

export function DefaultsClient() {
  const [d, setD] = useState<Defaults | null>(null)
  const [rev, setRev] = useState(0)
  const [err, setErr] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ tone: 'success' | 'warning' | 'danger'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  async function load() {
    const r = await fetch('/api/admin/products/defaults', { cache: 'no-store' })
    const b = await r.json().catch(() => null)
    if (!r.ok) { setErr(b?.error ?? 'Could not load.'); return }
    setD(b.data); setRev(b.revision); setErr(null)
  }
  useEffect(() => { void load() }, [])

  async function save() {
    if (!d) return
    setBusy(true); setMsg(null)
    const r = await fetch('/api/admin/products/defaults', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: d, revision: rev }) })
    const b = await r.json().catch(() => null)
    setBusy(false)
    if (!r.ok) { setMsg({ tone: 'danger', text: b?.errors?.join(' ') ?? b?.error ?? 'Could not save.' }); return }
    setRev(b.revision); setD(b.data)
    setMsg(b.cacheInvalidation?.ok === false ? { tone: 'warning', text: 'Saved, but the live site may take a moment to update.' } : { tone: 'success', text: 'Saved.' })
  }

  if (err) return <AdminError message={err} onRetry={() => void load()} />
  if (!d) return <AdminLoading />
  const sr = d.shippingReturns
  return (
    <AdminPage width="narrow">
      <div className="max-w-[720px]">
      <Link href="/admin/products" className="text-[11px] text-[#6B6B66] underline underline-offset-2">← Products</Link>
      <div className="mt-2"><AdminPageHeader title="Product defaults" description="Used by every product that doesn’t override it." /></div>
      {msg && <AdminNotice tone={msg.tone} className="mb-3">{msg.text}</AdminNotice>}
      <AdminCard>
        <div className="space-y-3">
          <AdminField label="Shipping & Returns lines (one per row)" htmlFor="df-lines" info="Shown in the Shipping & Returns section of each product page. A product can override this on its own Content tab.">
            <textarea id="df-lines" rows={5} className="w-full rounded-[9px] border border-black/[0.14] bg-white px-3 py-2 text-[12px] focus:border-[#171717] focus:outline-none focus:ring-1 focus:ring-[#171717]"
              value={sr.lines.join('\n')} onChange={e => setD({ shippingReturns: { ...sr, lines: e.target.value.split('\n') } })} />
          </AdminField>
          <AdminFieldGrid cols={2}>
            <AdminField label="Link text" htmlFor="df-label"><input id="df-label" className={adminInputClass} value={sr.linkLabel} maxLength={60} onChange={e => setD({ shippingReturns: { ...sr, linkLabel: e.target.value } })} /></AdminField>
            <AdminField label="Link to" htmlFor="df-href" hint="A page on this site."><input id="df-href" className={adminInputClass} value={sr.href} onChange={e => setD({ shippingReturns: { ...sr, href: e.target.value } })} /></AdminField>
          </AdminFieldGrid>
          <AdminButton variant="primary" loading={busy} onClick={() => void save()}>Save</AdminButton>
        </div>
      </AdminCard>
      </div>
    </AdminPage>
  )
}
