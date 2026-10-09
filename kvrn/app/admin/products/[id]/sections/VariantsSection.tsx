'use client'
import { useState } from 'react'
import { AdminCard, AdminSectionHeader, AdminButton, AdminField, AdminNotice, adminInputClass, InfoTip } from '@/components/admin/ui/AdminUI'
import { isHexColor } from '@/lib/product-model'
import { STANDARD_SIZES, generateVariants, newColor, variantIssues, buildVariantSku } from '@/lib/product-variants'
import { type SectionProps, IssueList, Toggle, Row } from '../editor-shared'

export function VariantsSection({ snap, update, state, issues, locked }: SectionProps) {
  const code = state.productCode ?? ''
  const existingSkus = state.canonical.variants.map(v => v.sku)
  const stock = new Map(state.canonical.variants.map(v => [v.sku, v] as const))
  const [name, setName] = useState('')
  const [hex, setHex] = useState('#111111')
  const [sizes, setSizes] = useState<string[]>(() => {
    const s = [...new Set(snap.commerce.variants.map(v => v.size))]
    return s.length ? s : ['S', 'M', 'L', 'XL']
  })
  const [custom, setCustom] = useState('')
  const local = variantIssues(code, snap.commerce.variants, existingSkus)
  const colorByCode = new Map(snap.colors.map(c => [c.code, c] as const))

  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Colours" description="One colour hides the colour picker on the product page."
          info="Each colour gets a short code used in SKUs. Colours are not deleted once they have variants: switch the variants off instead." />
        <ul className="space-y-2">
          {snap.colors.map((c, i) => (
            <li key={c.key + i} className="grid grid-cols-[28px_1fr_90px_90px_auto] items-center gap-2">
              <input type="color" aria-label={`${c.name} swatch`} value={isHexColor(c.hex) ? c.hex : '#000000'} disabled={locked}
                onChange={e => update(s => { s.colors[i].hex = e.target.value.toUpperCase() })} className="h-7 w-7 cursor-pointer rounded border border-black/20 p-0" />
              <input aria-label="Colour name" className={adminInputClass} value={c.name} disabled={locked} maxLength={40}
                onChange={e => update(s => { s.colors[i].name = e.target.value })} />
              <input aria-label="Colour code" className={adminInputClass} value={c.code} disabled={locked || snap.commerce.variants.some(v => v.colorCode === c.code && v.id)} maxLength={6}
                onChange={e => update(s => { const old = s.colors[i].code; const nc = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); s.colors[i].code = nc; s.commerce.variants.forEach(v => { if (v.colorCode === old && !v.id) v.colorCode = nc }) })} />
              <input aria-label="Colour hex" className={adminInputClass} value={c.hex} disabled={locked} maxLength={7}
                onChange={e => update(s => { s.colors[i].hex = e.target.value })} />
              <AdminButton size="sm" variant="ghost" aria-label={`Remove ${c.name}`} disabled={locked || snap.commerce.variants.some(v => v.colorCode === c.code && v.id)}
                onClick={() => update(s => { const code2 = s.colors[i].code; s.colors.splice(i, 1); s.commerce.variants = s.commerce.variants.filter(v => v.colorCode !== code2) })}>✕</AdminButton>
            </li>
          ))}
        </ul>
        <IssueList issues={issues.filter(i => i.field === 'colors' || /^colors\.\d+$/.test(i.field))} />
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <AdminField label="Add colour" className="min-w-[160px] flex-1">
            <input aria-label="New colour name" className={adminInputClass} placeholder="Black" value={name} disabled={locked} onChange={e => setName(e.target.value)} />
          </AdminField>
          <input type="color" aria-label="New colour swatch" value={hex} disabled={locked} onChange={e => setHex(e.target.value)} className="h-9 w-9 cursor-pointer rounded border border-black/20 p-0" />
          <AdminButton disabled={locked || !name.trim()} onClick={() => { update(s => { s.colors.push(newColor(name, hex.toUpperCase(), s.colors)) }); setName('') }}>Add</AdminButton>
        </div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Sizes and variants" description="Colour × size. Stock is managed in Inventory."
          info={<>SKUs look like <code>KVRN-{code || 'CODE'}-BLK-M</code>. A SKU never changes once it has been published. Removing a size switches it off; it is never deleted.</>} />
        <div className="mb-3 flex flex-wrap items-center gap-3">
          {STANDARD_SIZES.map(sz => (
            <Toggle key={sz} label={sz} checked={sizes.includes(sz)} disabled={locked} onChange={v => setSizes(p => v ? [...p, sz] : p.filter(x => x !== sz))} />
          ))}
          {sizes.filter(s => !(STANDARD_SIZES as readonly string[]).includes(s)).map(s => (
            <Toggle key={s} label={s} checked disabled={locked} onChange={() => setSizes(p => p.filter(x => x !== s))} />
          ))}
          <span className="flex items-center gap-1">
            <input aria-label="Custom size" className={`${adminInputClass} !w-[90px]`} placeholder="Custom" value={custom} maxLength={20} disabled={locked} onChange={e => setCustom(e.target.value)} />
            <AdminButton size="sm" disabled={locked || !custom.trim()} onClick={() => { setSizes(p => [...new Set([...p, custom.trim()])]); setCustom('') }}>Add size</AdminButton>
          </span>
          <AdminButton variant="primary" disabled={locked || !snap.colors.length || !sizes.length}
            onClick={() => update(s => { s.commerce.variants = generateVariants({ productCode: code, colors: s.colors, sizes, existing: s.commerce.variants }) })}>Generate variants</AdminButton>
        </div>
        {!snap.colors.length && <AdminNotice tone="warning" className="mb-3">Add a colour first.</AdminNotice>}
        <IssueList issues={issues.filter(i => i.field === 'commerce.variants')} />
        {snap.commerce.variants.length > 0 && (
          <div className="relative overflow-x-auto overscroll-x-contain">
            <table className="w-full min-w-[620px] border-collapse text-left text-[12px]">
              <thead><tr className="text-[10px] uppercase tracking-[0.08em] text-[#8A8A85]">
                <th className="py-1 pr-2">Colour</th><th className="px-2">Size</th><th className="px-2">SKU</th><th className="px-2">Order</th><th className="px-2">On sale</th><th className="px-2">Stock</th><th /></tr></thead>
              <tbody>
                {snap.commerce.variants.map((v, i) => {
                  const rowIssues = [...issues.filter(x => x.field === `commerce.variants.${i + 1}`), ...local.filter(x => x.index === i).map(x => ({ code: x.code, field: '', message: x.message }))]
                  const dedup = rowIssues.filter((x, k) => rowIssues.findIndex(y => y.message === x.message) === k)
                  const st = stock.get(v.sku)
                  return (
                    <tr key={`${v.sku}-${i}`} className="border-t border-black/[0.06] align-top">
                      <td className="py-1.5 pr-2">{colorByCode.get(v.colorCode)?.name ?? v.colorCode}</td>
                      <td className="px-2">{v.size}</td>
                      <td className="px-2">
                        {v.id ? <code className="text-[11px]">{v.sku}</code> : (
                          <input aria-label="SKU" className={`${adminInputClass} !h-8`} value={v.sku} disabled={locked} maxLength={60}
                            onChange={e => update(s => { s.commerce.variants[i].sku = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '') })} />
                        )}
                        {!v.id && !v.sku && <button type="button" className="mt-1 text-[10px] underline" onClick={() => update(s => { s.commerce.variants[i].sku = buildVariantSku(code, v.colorCode, v.size) })}>Suggest SKU</button>}
                        <IssueList issues={dedup} />
                      </td>
                      <td className="px-2"><input aria-label="Order" type="number" className={`${adminInputClass} !h-8 !w-[64px]`} value={v.sizeSort} min={0} max={999} disabled={locked}
                        onChange={e => update(s => { s.commerce.variants[i].sizeSort = Math.max(0, Math.min(999, Math.round(Number(e.target.value) || 0))) })} /></td>
                      <td className="px-2"><input type="checkbox" aria-label={`${v.size} on sale`} checked={v.active} disabled={locked} onChange={e => update(s => { s.commerce.variants[i].active = e.target.checked })} /></td>
                      <td className="px-2 text-[11px] text-[#6B6B66]">{st ? `${Math.max(0, st.stockOnHand - st.reserved)} available` : 'New'}</td>
                      <td className="px-2">{!v.id && <AdminButton size="sm" variant="ghost" aria-label="Remove variant" disabled={locked} onClick={() => update(s => { s.commerce.variants.splice(i, 1) })}>✕</AdminButton>}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 flex items-center text-[11px] text-[#8A8A85]">New variants start with 0 stock. Add stock in Inventory.
          <InfoTip label="About stock">Stock and reservations are never changed here, so the product editor can’t oversell or reset inventory.</InfoTip></p>
      </AdminCard>
    </div>
  )
}

export { Row }
