'use client'
import { useEffect, useState } from 'react'
import { AdminCard, AdminSectionHeader, AdminField, AdminNotice, adminInputClass, InfoTip } from '@/components/admin/ui/AdminUI'
import { validateCountryCode, validateHsCode } from '@/lib/product-model'
import { formatProductPrice } from '@/lib/product-price'
import { type SectionProps, IssueList, Toggle, Row } from '../editor-shared'

const toNum = (v: string): number | null => { if (v.trim() === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null }

export function PricingSection({ snap, update, state, options, issues, locked, onCollections }: SectionProps & { onCollections: (ids: string[]) => Promise<void> }) {
  const c = snap.commerce
  const [priceText, setPriceText] = useState(c.priceCents ? (c.priceCents / 100).toFixed(2) : '')
  useEffect(() => { setPriceText(c.priceCents ? (c.priceCents / 100).toFixed(2) : '') }, [state.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const origin = validateCountryCode(c.originCountry)
  const hs = validateHsCode(c.hsCode)
  const live = state.canonical.priceCents
  const inCollections = new Set(state.collections.map(x => x.id))
  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Price" info="Checkout always charges the live price. A change here takes effect when you publish, and past orders keep the price they were bought at." />
        <Row>
          <AdminField label="Price (USD)" htmlFor="p-price">
            <input id="p-price" inputMode="decimal" className={adminInputClass} value={priceText} disabled={locked} placeholder="80.00"
              onChange={e => {
                setPriceText(e.target.value)
                const n = toNum(e.target.value)
                update(s => { s.commerce.priceCents = n === null ? null : Math.round(n * 100) })
              }} />
            <IssueList issues={issues.filter(i => i.field === 'commerce.priceCents')} />
          </AdminField>
          <div className="self-end text-[12px] text-[#6B6B66]">
            Live now: <strong className="font-medium text-[#171717]">{state.publishedVersionNo !== null ? formatProductPrice(live) : 'Not live yet'}</strong>
            {state.publishedVersionNo !== null && c.priceCents !== null && c.priceCents !== live && <span className="ml-2 text-[#92400E]">Changes on publish</span>}
          </div>
        </Row>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Shipping package" description="Required before publishing."
          info="Used to get shipping rates. Enter the packed weight and dimensions of one unit. A product without these can’t go live, so it never ships with a guessed size." />
        <Row cols={4}>
          {([['weightLb', 'Weight (lb)'], ['lengthIn', 'Length (in)'], ['widthIn', 'Width (in)'], ['heightIn', 'Height (in)']] as const).map(([k, label]) => (
            <AdminField key={k} label={label} htmlFor={`p-${k}`}>
              <input id={`p-${k}`} inputMode="decimal" className={adminInputClass} disabled={locked} value={c.shipping[k] ?? ''}
                onChange={e => update(s => { s.commerce.shipping[k] = toNum(e.target.value) })} />
              <IssueList issues={issues.filter(i => i.field === `commerce.shipping.${k}`)} />
            </AdminField>
          ))}
        </Row>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Customs details" description="Optional." />
        <Row>
          <AdminField label="Country of origin" htmlFor="p-origin" error={origin.ok ? null : origin.error}
            info="Where the product was made, as a 2-letter code like US or VN. Leave blank if unsure. It does not affect domestic checkout.">
            <input id="p-origin" className={adminInputClass} value={c.originCountry ?? ''} disabled={locked} maxLength={2} placeholder="e.g. US"
              onChange={e => update(s => { s.commerce.originCountry = e.target.value.toUpperCase() || null })} />
          </AdminField>
          <AdminField label="HS / tariff code" htmlFor="p-hs" error={hs.ok ? null : hs.error}
            info="6–10 digits, dots optional (for example 6110.20). Never guess: ask your broker or leave blank. It does not affect checkout today.">
            <input id="p-hs" className={adminInputClass} value={c.hsCode ?? ''} disabled={locked} maxLength={13} placeholder="e.g. 6110.20"
              onChange={e => update(s => { s.commerce.hsCode = e.target.value || null })} />
          </AdminField>
        </Row>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Shop and collections" />
        <div className="space-y-3">
          <Toggle label="Show in the shop and listings" checked={snap.shop.listed} disabled={locked}
            info="Off keeps the product page reachable by its link but hides it from the shop and sitemap."
            onChange={v => update(s => { s.shop.listed = v })} />
          <AdminField label="Shop order" htmlFor="p-sort" info="Lower numbers come first.">
            <input id="p-sort" type="number" className={`${adminInputClass} !w-[110px]`} value={snap.shop.sortPosition} disabled={locked}
              onChange={e => update(s => { s.shop.sortPosition = Math.round(Number(e.target.value) || 0) })} />
          </AdminField>
          <div>
            <p className="mb-1 flex items-center gap-0.5 text-[11px] font-medium text-[#4A4A46]">Collections
              <InfoTip label="About collections">Collection changes save immediately and aren’t part of the draft.</InfoTip></p>
            {(options?.collections ?? []).length === 0 ? <p className="text-[11px] text-[#8A8A85]">No collections yet.</p> : (
              <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                {options!.collections.map(col => (
                  <Toggle key={col.id} label={col.name} checked={inCollections.has(col.id)} disabled={locked && false}
                    onChange={v => { const next = new Set(inCollections); if (v) next.add(col.id); else next.delete(col.id); void onCollections([...next]) }} />
                ))}
              </div>
            )}
          </div>
        </div>
      </AdminCard>
      <AdminNotice tone="info">Stock and costs are managed in Inventory and Product costs.</AdminNotice>
    </div>
  )
}
