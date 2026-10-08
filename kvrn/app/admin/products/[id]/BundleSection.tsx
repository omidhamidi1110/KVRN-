'use client'
// Bundle / Complete the Set — Product Editor section.
//
// The definition is saved inside the product's draft (snapshot.bundle) and goes live with the
// product's own publish / rollback / unpublish, so there is one place to edit it and one history.
// Component facts (name, price, image, sizes, stock) are NEVER typed here: the products are picked
// from the catalog and everything else is read live. The preview below uses the same pricing module
// as the storefront and checkout. Problems that would stop publishing are listed in the open.
import { useEffect, useMemo, useState } from 'react'
import {
  AdminButton, AdminCard, AdminField, AdminNotice, AdminSectionHeader, StatusBadge, adminInputClass, adminSelectClass,
} from '@/components/admin/ui/AdminUI'
import { InfoTip } from '@/components/admin/ui/InfoTip'
import { IssueList, Toggle, textareaClass, type SectionProps } from './editor-shared'
import { emptyBundle, BUNDLE_LIMITS, type BundleConfig, type BundleComponentDef } from '@/lib/bundle-model'
import { MAX_BUNDLE_COMPONENTS, formatCents, describeRule, type BundlePricingMode } from '@/lib/bundle-pricing'
import {
  buildBundlePreview, formatValueInput, parseMoneyInput, parsePercentInput,
  type PreviewComponentInput,
} from '@/lib/bundle-preview'
import type { BundleCandidate } from '@/lib/bundle-admin'

const MODES: Array<{ id: BundlePricingMode; label: string; help: string }> = [
  { id: 'set_price', label: 'Set price', help: 'The whole set costs this amount.' },
  { id: 'fixed_discount', label: 'Amount off', help: 'A fixed amount off the products’ combined price.' },
  { id: 'percent_discount', label: 'Percent off', help: 'A percentage off the products’ combined price (rounded down to the cent).' },
]

export function BundleSection({ snap, update, state, issues, locked }: Pick<SectionProps, 'snap' | 'update' | 'state' | 'issues' | 'locked'>) {
  const b = snap.bundle
  const cfg: BundleConfig = b ?? emptyBundle()
  const edit = (fn: (b: BundleConfig) => void) => update(s => { const next = s.bundle ?? emptyBundle(); fn(next); s.bundle = next })

  const [q, setQ] = useState('')
  const [cands, setCands] = useState<BundleCandidate[] | null>(null)
  const [loadErr, setLoadErr] = useState(false)
  const [valueText, setValueText] = useState(() => formatValueInput(cfg.pricing.mode, cfg.pricing.value))
  const [valueErr, setValueErr] = useState<string | null>(null)

  // Candidates: the whole picker list (search is applied server-side after a short pause).
  useEffect(() => {
    if (!cfg.enabled) return
    let cancelled = false
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/admin/products/bundle-candidates?exclude=${state.id}&q=${encodeURIComponent(q)}`)
        const body = await r.json()
        if (!cancelled) { if (r.ok) { setCands(body.candidates); setLoadErr(false) } else setLoadErr(true) }
      } catch { if (!cancelled) setLoadErr(true) }
    }, q ? 250 : 0)
    return () => { cancelled = true; clearTimeout(t) }
  }, [cfg.enabled, q, state.id])

  // Everything the preview needs about products already in the set (even when a search hides them).
  const [known, setKnown] = useState<Record<string, BundleCandidate>>({})
  useEffect(() => {
    if (!cands) return
    setKnown(k => { const n = { ...k }; for (const c of cands) n[c.id] = c; return n })
  }, [cands])

  const ownerInput: PreviewComponentInput = useMemo(() => ({
    productId: state.id,
    name: snap.name || 'This product',
    priceCents: state.canonical.priceCents > 0 ? state.canonical.priceCents : snap.commerce.priceCents,
    status: state.status,
    variants: state.canonical.variants.filter(v => v.id).map(v => ({
      id: v.id as string, sku: v.sku, size: v.size, colorName: v.colorCode, active: v.active, available: Math.max(0, v.stockOnHand - v.reserved),
    })),
  }), [state, snap.name, snap.commerce.priceCents])

  const candidateInputs: PreviewComponentInput[] = useMemo(() => Object.values(known).map(c => ({
    productId: c.id, name: c.name, priceCents: c.priceCents, status: c.status, variants: c.variants,
  })), [known])

  const preview = useMemo(() => buildBundlePreview(b, ownerInput, candidateInputs), [b, ownerInput, candidateInputs])
  const myIssues = issues.filter(i => i.field.startsWith('bundle'))
  const added = new Set(cfg.components.map(c => c.productId))

  function setMode(mode: BundlePricingMode) {
    edit(x => { x.pricing.mode = mode; x.pricing.value = 0 })
    setValueText(''); setValueErr(null)
  }
  function onValue(text: string) {
    setValueText(text)
    const v = cfg.pricing.mode === 'percent_discount' ? parsePercentInput(text) : parseMoneyInput(text)
    if (v === null) { setValueErr(cfg.pricing.mode === 'percent_discount' ? 'Enter a percentage from 0 to 99.99.' : 'Enter an amount like 145 or 145.50.'); return }
    setValueErr(null)
    edit(x => { x.pricing.value = v })
  }
  const addComponent = (id: string) => edit(x => {
    if (x.components.length >= MAX_BUNDLE_COMPONENTS || x.components.some(c => c.productId === id)) return
    x.components.push({ productId: id, allowedVariantIds: null, viewSeparately: true })
  })
  const patchComponent = (id: string, fn: (c: BundleComponentDef) => void) => edit(x => { const c = x.components.find(y => y.productId === id); if (c) fn(c) })

  return (
    <AdminCard>
      <AdminSectionHeader title="Bundle" description="Sell this product with others as a set."
        info={<>One set per product. The products’ names, prices, photos, sizes and stock are read live; you choose the products, the price rule and the wording. A set price does not combine with discount codes, and a customer can buy one set per order.</>} />
      <div className="space-y-4">
        <Toggle label="Offer a set on this product’s page" checked={cfg.enabled} disabled={locked}
          onChange={v => edit(x => { x.enabled = v })}
          info="Off means no set is shown or sold. The settings below are kept." />

        {cfg.enabled && (
          <>
            <div className="space-y-2">
              <Toggle label="Include this product in the set" checked={cfg.includeOwner} disabled={locked}
                onChange={v => edit(x => { x.includeOwner = v; if (!v) x.ownerAllowedVariantIds = null })}
                info="On: the customer picks this product’s size too. Off: the set is made of the products below only." />
              {cfg.includeOwner && (
                <VariantPicker label="Sizes allowed for this product" variants={ownerInput.variants}
                  value={cfg.ownerAllowedVariantIds} disabled={locked}
                  onChange={ids => edit(x => { x.ownerAllowedVariantIds = ids })} />
              )}
            </div>

            <div>
              <p className="mb-1 flex items-center gap-1 text-[11px] font-medium text-[#4A4A46]">
                Products in the set
                <InfoTip label="About products in the set">Pick existing products. Their live page, price, photo, sizes and stock are used automatically. You can limit which sizes are offered. Up to {MAX_BUNDLE_COMPONENTS} products in total.</InfoTip>
              </p>
              {cfg.components.length === 0 && <p className="text-[11px] text-[#8A8A85]">No products added yet.</p>}
              <ul className="space-y-2">
                {cfg.components.map((c, i) => {
                  const k = known[c.productId]
                  const pc = preview.components.find(p => p.productId === c.productId)
                  return (
                    <li key={c.productId} className="rounded-[10px] border border-black/[0.08] bg-[#FAFAF8] p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-medium text-[#171717]">{k?.name ?? 'Loading product…'}
                            {k?.productCode ? <span className="ml-1 font-normal text-[#8A8A85]">{k.productCode}</span> : null}</p>
                          <p className="text-[11px] text-[#6B6B66]">
                            {k ? (k.priceCents != null ? formatCents(k.priceCents) : 'No price yet') : ''}
                            {pc?.note ? ` · ${pc.note}` : ''}
                          </p>
                        </div>
                        <div className="flex items-center gap-2">
                          {k && <StatusBadge status={k.status === 'published' ? 'Live' : 'Draft'} />}
                          <AdminButton size="sm" variant="ghost" disabled={locked} onClick={() => edit(x => { x.components.splice(i, 1) })}>Remove</AdminButton>
                        </div>
                      </div>
                      <div className="mt-2 space-y-2">
                        <Toggle label="Show a “View separately” link" checked={c.viewSeparately} disabled={locked}
                          onChange={v => patchComponent(c.productId, x => { x.viewSeparately = v })} />
                        {k && <VariantPicker label="Sizes allowed" variants={k.variants} value={c.allowedVariantIds} disabled={locked}
                          onChange={ids => patchComponent(c.productId, x => { x.allowedVariantIds = ids })} />}
                      </div>
                    </li>
                  )
                })}
              </ul>

              {cfg.components.length < MAX_BUNDLE_COMPONENTS && (
                <div className="mt-3 rounded-[10px] border border-black/[0.08] p-3">
                  <input className={adminInputClass} placeholder="Search products by name or code" value={q} disabled={locked}
                    onChange={e => setQ(e.target.value)} aria-label="Search products" />
                  {loadErr && <p className="mt-2 text-[11px] text-[#B91C1C]">Products could not be loaded. Try again.</p>}
                  {cands && (
                    <ul className="mt-2 max-h-56 space-y-1 overflow-y-auto">
                      {cands.length === 0 && <li className="text-[11px] text-[#8A8A85]">No products found.</li>}
                      {cands.map(c => (
                        <li key={c.id} className="flex items-center justify-between gap-2 text-[12px]">
                          <span className="min-w-0 truncate">{c.name}
                            <span className="ml-1 text-[11px] text-[#8A8A85]">{c.priceCents != null ? formatCents(c.priceCents) : 'No price yet'} · {c.status === 'published' ? 'Live' : 'Not live'}</span></span>
                          <AdminButton size="sm" disabled={locked || added.has(c.id)} onClick={() => addComponent(c.id)}>{added.has(c.id) ? 'Added' : 'Add'}</AdminButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <AdminField label="Price rule" htmlFor="b-mode"
                info="The single rule used on the page, in the bag, at checkout, on the order and in refunds. Checkout never calculates a different price.">
                <select id="b-mode" className={adminSelectClass} value={cfg.pricing.mode} disabled={locked}
                  onChange={e => setMode(e.target.value as BundlePricingMode)}>
                  {MODES.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
                </select>
              </AdminField>
              <AdminField label={cfg.pricing.mode === 'percent_discount' ? 'Percent off' : cfg.pricing.mode === 'set_price' ? 'Set price (USD)' : 'Amount off (USD)'}
                htmlFor="b-value" error={valueErr}
                hint={MODES.find(m => m.id === cfg.pricing.mode)?.help}>
                <input id="b-value" className={adminInputClass} inputMode="decimal" value={valueText} disabled={locked}
                  onChange={e => onValue(e.target.value)} />
              </AdminField>
            </div>

            <div className="space-y-3">
              <p className="text-[11px] font-medium text-[#4A4A46]">Wording</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <AdminField label="Eyebrow" htmlFor="b-eyebrow" hint="Defaults to “Complete the Set”.">
                  <input id="b-eyebrow" className={adminInputClass} maxLength={BUNDLE_LIMITS.eyebrow} disabled={locked} value={cfg.presentation.eyebrow ?? ''}
                    onChange={e => edit(x => { x.presentation.eyebrow = e.target.value || null })} />
                </AdminField>
                <AdminField label="Button label" htmlFor="b-cta" hint="Defaults to “Add the set to bag”.">
                  <input id="b-cta" className={adminInputClass} maxLength={BUNDLE_LIMITS.ctaLabel} disabled={locked} value={cfg.presentation.ctaLabel ?? ''}
                    onChange={e => edit(x => { x.presentation.ctaLabel = e.target.value || null })} />
                </AdminField>
              </div>
              <AdminField label="Headline" htmlFor="b-headline">
                <input id="b-headline" className={adminInputClass} maxLength={BUNDLE_LIMITS.headline} disabled={locked} value={cfg.presentation.headline ?? ''}
                  onChange={e => edit(x => { x.presentation.headline = e.target.value || null })} />
              </AdminField>
              <AdminField label="Supporting copy" htmlFor="b-copy">
                <textarea id="b-copy" className={textareaClass} rows={3} maxLength={BUNDLE_LIMITS.supportingCopy} disabled={locked} value={cfg.presentation.supportingCopy ?? ''}
                  onChange={e => edit(x => { x.presentation.supportingCopy = e.target.value || null })} />
              </AdminField>
              <Toggle label="Show the set section on the page" checked={cfg.presentation.sectionVisible} disabled={locked}
                onChange={v => edit(x => { x.presentation.sectionVisible = v })}
                info="Off hides the section on the product page. The set stays defined." />
            </div>
          </>
        )}

        <IssueList issues={myIssues} />

        <Preview preview={preview} cfg={cfg} />
      </div>
    </AdminCard>
  )
}

function VariantPicker({ label, variants, value, onChange, disabled }: {
  label: string; variants: Array<{ id: string; sku: string; size: string; colorName: string; active: boolean }>
  value: string[] | null; onChange: (ids: string[] | null) => void; disabled?: boolean
}) {
  const active = variants.filter(v => v.active)
  if (active.length === 0) return <p className="text-[11px] text-[#8A8A85]">{label}: no active sizes.</p>
  const all = value === null
  return (
    <details className="text-[11px] text-[#4A4A46]">
      <summary className="cursor-pointer select-none">{label}: {all ? 'all' : `${value!.length} selected`}</summary>
      <div className="mt-2 flex flex-wrap gap-2">
        <label className="flex items-center gap-1"><input type="checkbox" checked={all} disabled={disabled} onChange={e => onChange(e.target.checked ? null : active.map(v => v.id))} /> All</label>
        {active.map(v => (
          <label key={v.id} className="flex items-center gap-1">
            <input type="checkbox" disabled={disabled || all} checked={all || value!.includes(v.id)}
              onChange={e => {
                const cur = new Set(value ?? active.map(x => x.id))
                if (e.target.checked) cur.add(v.id); else cur.delete(v.id)
                onChange(cur.size ? [...cur] : null)
              }} />
            {v.colorName ? `${v.colorName} / ` : ''}{v.size}
          </label>
        ))}
      </div>
    </details>
  )
}

function Preview({ preview, cfg }: { preview: ReturnType<typeof buildBundlePreview>; cfg: BundleConfig }) {
  return (
    <div className="rounded-[12px] border border-black/[0.08] bg-[#FAFAF8] p-3" aria-label="Set preview">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-[11px] font-medium text-[#4A4A46]">Preview</p>
        {preview.state === 'off' ? <StatusBadge status="Inactive" label="Set off" />
          : preview.state === 'ok' ? (preview.available ? <StatusBadge status="Ready" /> : <StatusBadge status="Incomplete" label="Not available" />)
          : <StatusBadge status="Incomplete" />}
      </div>
      {preview.state === 'off' && <p className="text-[12px] text-[#6B6B66]">No set is shown on the page.</p>}
      {preview.state !== 'off' && (
        <>
          <ul className="space-y-1 text-[12px]">
            {preview.components.map(c => (
              <li key={c.productId} className="flex items-center justify-between gap-2">
                <span className="min-w-0 truncate">{c.name}{c.isOwner ? ' (this product)' : ''}</span>
                <span className="shrink-0 tabular-nums">
                  {c.priceCents != null ? formatCents(c.priceCents) : '—'}
                  {c.unavailable && <span className="ml-2 text-[#92400E]">{c.note ?? 'Unavailable'}</span>}
                </span>
              </li>
            ))}
          </ul>
          {preview.pricing && (
            <dl className="mt-3 space-y-1 border-t border-black/[0.08] pt-2 text-[12px]">
              <div className="flex justify-between"><dt className="text-[#6B6B66]">Products separately</dt><dd className="tabular-nums">{formatCents(preview.pricing.setSubtotalCents)}</dd></div>
              <div className="flex justify-between"><dt className="text-[#6B6B66]">Discount ({describeRule(cfg.pricing.mode, cfg.pricing.value)})</dt><dd className="tabular-nums">−{formatCents(preview.pricing.setDiscountCents)}</dd></div>
              <div className="flex justify-between font-medium"><dt>Set price</dt><dd className="tabular-nums">{formatCents(preview.pricing.setNetCents)}</dd></div>
            </dl>
          )}
          {!preview.available && preview.state === 'ok' && (
            <AdminNotice tone="warning" className="mt-3">A product in the set is sold out or has no eligible size. Customers see the set as unavailable.</AdminNotice>
          )}
          {preview.issues.length > 0 && (
            <AdminNotice tone="danger" title="Fix before publishing" className="mt-3">
              <ul className="list-disc pl-4">{preview.issues.map((i, k) => <li key={`${i.code}-${k}`}>{i.message}</li>)}</ul>
            </AdminNotice>
          )}
          {preview.warnings.length > 0 && (
            <AdminNotice tone="warning" className="mt-3">
              <ul className="list-disc pl-4">{preview.warnings.map((i, k) => <li key={`${i.code}-${k}`}>{i.message}</li>)}</ul>
            </AdminNotice>
          )}
        </>
      )}
    </div>
  )
}
