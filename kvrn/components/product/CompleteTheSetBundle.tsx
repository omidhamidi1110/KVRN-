'use client'
// "Complete the Set" for an Admin-defined bundle. Rendered by the product page ONLY when the product
// has a published, enabled bundle and CMS product routing is on (the server decides; this component
// never fetches the definition). Names, links, prices, images, eligible variants and availability
// arrive resolved from canonical sources; the customer picks a variant per component and the page
// shows subtotal, discount and the set price using the shared pricing module. "Add set to bag" asks
// the server to quote the exact selection first, then puts the set in the bag as its real component
// lines. The server prices the set again at checkout.
import { useMemo, useState } from 'react'
import { imageSrcSet } from '@/lib/responsive-image'
import Link from 'next/link'
import { useCart } from '@/context/CartContext'
import { useI18n } from '@/context/I18nContext'
import { fillMessages } from '@/lib/i18n/messages'
import { formatProductPrice } from '@/lib/product-price'
import { BUNDLE_COPY_DEFAULTS } from '@/lib/bundle-model'
import { buildBundleCartLines, priceSelection } from '@/lib/bundle-cart'
import type { PublicBundle, PublicBundleComponent } from '@/lib/bundle-types'

const LABEL: React.CSSProperties = { fontSize: 10, fontWeight: 300, letterSpacing: '0.1em', textTransform: 'uppercase', color: '#9B9B9B' }

function ComponentCard({ c, colorCode, sku, onColor, onSku }: {
  c: PublicBundleComponent; colorCode: string; sku: string | null
  onColor: (code: string) => void; onSku: (sku: string) => void
}) {
  const t = fillMessages(useI18n().t)
  const color = c.colors.find(x => x.code === colorCode) ?? c.colors[0]
  const img = color?.image ?? c.image
  const sizes = c.variants.filter(v => v.colorCode === (color?.code ?? ''))
  return (
    <div data-bundle-component={c.productId} style={{ background: 'transparent' }}>
      <div style={{ position: 'relative', width: '100%', aspectRatio: '3/4', overflow: 'hidden', background: '#EDEAE4', marginBottom: 14 }}>
        {img?.src && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={img.src} srcSet={imageSrcSet(img.src)} sizes="(max-width: 640px) 50vw, 300px" alt={img.alt || c.name} loading="lazy"
            style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center top' }} />
        )}
        {!c.available && (
          <span style={{ position: 'absolute', top: 10, left: 10, background: '#fff', padding: '4px 8px', ...LABEL }}>{t.soldOut}</span>
        )}
      </div>
      <div style={{ padding: '0 4px 12px' }}>
        <p style={{ fontSize: 13, fontWeight: 300, color: '#1A1A1A', marginBottom: 4, lineHeight: 1.3 }}>{c.name}</p>
        <p style={{ fontSize: 13, fontWeight: 300, color: '#9B9B9B', marginBottom: 14, fontVariantNumeric: 'tabular-nums' }}>
          {formatProductPrice(c.priceCents)}
        </p>
        {c.colors.length > 1 && (
          <div style={{ marginBottom: 12 }}>
            <p style={{ ...LABEL, marginBottom: 8 }}>{t.color}{color ? ` · ${color.name}` : ''}</p>
            <div style={{ display: 'flex', gap: 8 }}>
              {c.colors.map(col => (
                <button key={col.code} onClick={() => onColor(col.code)} aria-label={col.name} aria-pressed={col.code === color?.code}
                  style={{ width: 22, height: 22, borderRadius: '50%', background: col.hex, cursor: 'pointer',
                           border: col.code === color?.code ? '2px solid #1A1A1A' : '1px solid #D5D1CB' }} />
              ))}
            </div>
          </div>
        )}
        <p style={{ ...LABEL, marginBottom: 8 }}>{t.size}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {sizes.map(v => {
            const out = v.available <= 0
            const on = sku === v.sku
            return (
              <button key={v.sku} disabled={out} onClick={() => onSku(v.sku)} aria-pressed={on}
                style={{ height: 34, minWidth: 36, padding: '0 8px', fontSize: 11, fontWeight: 300, cursor: out ? 'default' : 'pointer',
                         border: on ? '1.5px solid #1A1A1A' : '1px solid #D5D1CB',
                         background: on ? '#1A1A1A' : 'transparent', color: on ? '#fff' : out ? '#C8C4BC' : '#1A1A1A',
                         textDecoration: out ? 'line-through' : 'none' }}>
                {v.size}
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

export function CompleteTheSetBundle({ bundle, preview = false }: { bundle: PublicBundle; preview?: boolean }) {
  const { addBundle, openCart } = useCart()
  const t = fillMessages(useI18n().t)
  const comps = bundle.components
  const [colorCodes, setColorCodes] = useState<Record<string, string>>({})
  const [skus, setSkus] = useState<Record<string, string | null>>({})
  const [busy, setBusy] = useState<'idle' | 'busy' | 'done'>('idle')
  const [error, setError] = useState<string | null>(null)

  const p = bundle.presentation
  const eyebrow = p.eyebrow ?? BUNDLE_COPY_DEFAULTS.eyebrow
  const headline = p.headline ?? BUNDLE_COPY_DEFAULTS.headline
  const cta = p.ctaLabel ?? BUNDLE_COPY_DEFAULTS.ctaLabel

  const chosen = comps.map(c => skus[c.productId] ?? null)
  const priced = useMemo(() => priceSelection(bundle, chosen), [bundle, skus]) // eslint-disable-line react-hooks/exhaustive-deps
  const allChosen = chosen.every(Boolean)
  const anyUnavailable = comps.some(c => !c.available)
  const nextMissing = comps.find(c => !skus[c.productId])
  const ready = allChosen && priced.ok && !anyUnavailable

  async function onAdd() {
    if (!ready || preview || busy === 'busy') return
    setBusy('busy'); setError(null)
    try {
      const body = {
        bundleId: bundle.bundleId, quantity: 1,
        selections: comps.map((c, i) => ({ productId: c.productId, sku: chosen[i] })),
        expectedSetNetCents: priced.ok ? priced.setNetCents : null,
      }
      const res = await fetch('/api/bundles/quote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store', body: JSON.stringify(body) })
      const q = await res.json().catch(() => null)
      if (!q?.ok) {
        setError(q?.code === 'BUNDLE_PRICE_CHANGED'
          ? 'The price of this set just changed. Reload the page to see the current price.'
          : (q?.message ?? 'This set can’t be added right now. Please try again.'))
        setBusy('idle'); return
      }
      const lines = buildBundleCartLines(bundle, chosen, headline, 1, q)
      if (!lines) { setError('This set can’t be added right now. Please try again.'); setBusy('idle'); return }
      addBundle(lines)
      setBusy('done')
      setTimeout(() => { setBusy('idle'); openCart() }, 700)
    } catch {
      setError('This set can’t be added right now. Please try again.'); setBusy('idle')
    }
  }

  const label = anyUnavailable ? t['bundle.unavailable']
    : busy === 'done' ? t.addedToBag
    : busy === 'busy' ? '...'
    : !allChosen ? (nextMissing ? `${t['bundle.chooseSize']} · ${nextMissing.name}` : t['bundle.chooseSize'])
    : cta

  return (
    <section style={{ background: '#F3F0EA' }} data-bundle-section={bundle.bundleId}>
      <div className="mx-auto w-full max-w-[1380px] px-6 py-12 sm:px-7 sm:py-16">
        <div className="flex flex-col lg:grid gap-8 lg:gap-12"
          style={{ gridTemplateColumns: 'minmax(0,0.8fr) minmax(0,2.2fr)', alignItems: 'start' } as React.CSSProperties}>

          <div style={{ minWidth: 0, width: '100%' }}>
            <p style={{ ...LABEL, letterSpacing: '0.22em', marginBottom: 16 }}>{eyebrow}</p>
            <h3 style={{ fontFamily: 'var(--font-display)', fontWeight: 300, fontSize: 'clamp(26px,2.4vw,32px)',
                         lineHeight: 1.1, letterSpacing: '-0.025em', color: '#1A1A1A', marginBottom: 16 }}>
              {headline}
            </h3>
            {p.supportingCopy && <p style={{ fontSize: 13, color: '#6B6B6B', lineHeight: 1.65, marginBottom: 24 }}>{p.supportingCopy}</p>}

            <div style={{ borderTop: '1px solid #C8C4BC', paddingTop: 20, marginBottom: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {priced.ok ? (
                <>
                  <Row label={t['bundle.subtotal']} value={formatProductPrice(priced.setSubtotalCents)} />
                  {priced.setDiscountCents > 0 && <Row label={t['bundle.discount']} value={`−${formatProductPrice(priced.setDiscountCents)}`} />}
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 6 }}>
                    <span style={LABEL}>{t['bundle.total']}</span>
                    <span style={{ fontSize: 22, fontWeight: 300, fontVariantNumeric: 'tabular-nums' }}>{formatProductPrice(priced.setNetCents)}</span>
                  </div>
                </>
              ) : (
                <p style={{ fontSize: 12, color: '#9B9B9B' }}>{t['bundle.unavailable']}</p>
              )}
            </div>

            <button disabled={!ready || preview} onClick={onAdd} data-bundle-cta
              style={{ width: '100%', minWidth: 0, maxWidth: '100%', boxSizing: 'border-box', minHeight: 60, fontSize: 11, fontWeight: 300, letterSpacing: '0.08em', textTransform: 'uppercase', overflowWrap: 'anywhere', textAlign: 'center', transition: 'background-color 200ms, color 200ms',
                       background: ready ? '#1A1A1A' : '#E8E5E0', color: ready ? '#fff' : '#9B9B9B', border: 'none',
                       cursor: ready && !preview ? 'pointer' : 'default', padding: '8px 12px', marginBottom: 14, lineHeight: 1.3 }}>
              {label}
            </button>
            {error && <p role="alert" style={{ fontSize: 12, color: '#B91C1C', marginBottom: 12 }}>{error}</p>}
            {comps.filter(c => c.viewSeparately).map(c => (
              <Link key={c.productId} href={c.href}
                style={{ display: 'block', textAlign: 'center', fontSize: 11, color: '#9B9B9B', textDecoration: 'underline', textUnderlineOffset: 2, marginBottom: 6 }}
                className="hover:text-[#1A1A1A] transition-colors">
                {t['bundle.viewSeparately']} · {c.name}
              </Link>
            ))}
          </div>

          <div style={{ display: 'grid', gap: 24, minWidth: 0, gridTemplateColumns: 'repeat(auto-fit,minmax(min(200px,100%),1fr))' }}>
            {comps.map(c => (
              <ComponentCard key={c.productId} c={c}
                colorCode={colorCodes[c.productId] ?? c.colors[0]?.code ?? ''}
                sku={skus[c.productId] ?? null}
                onColor={code => { setColorCodes(s => ({ ...s, [c.productId]: code })); setSkus(s => ({ ...s, [c.productId]: null })) }}
                onSku={sku => setSkus(s => ({ ...s, [c.productId]: sku }))} />
            ))}
          </div>
        </div>
      </div>
    </section>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
      <span style={{ fontSize: 12, color: '#6B6B6B' }}>{label}</span>
      <span style={{ fontSize: 13, fontWeight: 300, fontVariantNumeric: 'tabular-nums' }}>{value}</span>
    </div>
  )
}
