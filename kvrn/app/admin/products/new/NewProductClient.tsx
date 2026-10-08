'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { AdminButton, AdminCard, AdminField, AdminNotice, AdminPageHeader, adminInputClass } from '@/components/admin/ui/AdminUI'
import { slugify } from '@/lib/product-model'

export function NewProductClient() {
  const router = useRouter()
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [type, setType] = useState('')
  const [slug, setSlug] = useState('')
  const [slugTouched, setSlugTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function create() {
    setBusy(true); setError(null)
    const r = await fetch('/api/admin/products', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, code, type, slug: slug || undefined }) })
    const b = await r.json().catch(() => null)
    setBusy(false)
    if (!r.ok) { setError(b?.error ?? 'Could not create the product.'); return }
    router.push(`/admin/products/${b.id}`)
  }
  const ok = name.trim() && /^[A-Z0-9]{2,12}$/.test(code) && !/^D\d{3}$/.test(code)

  return (
    <div className="max-w-[640px]">
      <AdminPageHeader title="New product" description="Starts as a draft. Nothing goes live yet." />
      <AdminCard>
        <div className="space-y-3">
          {error && <AdminNotice tone="danger">{error}</AdminNotice>}
          <AdminField label="Name" htmlFor="np-name">
            <input id="np-name" className={adminInputClass} value={name} maxLength={120} autoFocus
              onChange={e => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)) }} />
          </AdminField>
          <AdminField label="Product code" htmlFor="np-code" hint="2–12 capital letters or digits, e.g. TEE1. It can’t be changed later."
            info="Used inside SKUs (KVRN-CODE-COLOR-SIZE) and to look up shipping data. Must be unique.">
            <input id="np-code" className={adminInputClass} value={code} maxLength={12} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
          </AdminField>
          <AdminField label="Type" htmlFor="np-type" hint="e.g. hoodie, sweatpants, tee">
            <input id="np-type" className={adminInputClass} value={type} maxLength={40} onChange={e => setType(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))} />
          </AdminField>
          <AdminField label="URL" htmlFor="np-slug" hint="You can change this until it is published.">
            <div className="flex items-center gap-1"><span className="text-[11px] text-[#8A8A85]">/products/</span>
              <input id="np-slug" className={adminInputClass} value={slug} maxLength={80} onChange={e => { setSlugTouched(true); setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-')) }} /></div>
          </AdminField>
          <div className="flex gap-2 pt-1">
            <AdminButton variant="primary" loading={busy} disabled={!ok || busy} onClick={() => void create()}>Create draft</AdminButton>
            <Link href="/admin/products" className="inline-flex h-9 items-center px-3 text-[12px] underline underline-offset-2">Cancel</Link>
          </div>
        </div>
      </AdminCard>
    </div>
  )
}
