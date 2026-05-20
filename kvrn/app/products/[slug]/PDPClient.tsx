'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCart }     from '@/context/CartContext'
import { useI18n }     from '@/context/I18nContext'
import { useCurrency } from '@/context/CurrencyContext'
import { ProductGallery } from '@/components/product/ProductGallery'
import { ColorSelector }  from '@/components/product/ColorSelector'
import { SizeSelector }   from '@/components/product/SizeSelector'
import { Accordion }      from '@/components/ui/Accordion'
import { Button }         from '@/components/ui/Button'
import { StockBadge, computeStock } from '@/components/ui/StockBadge'
import { cn }             from '@/lib/utils'
import type { ColorOption, SizeLabel, Product } from '@/types'

interface PDPClientProps {
  product:        Product
  relatedProduct: Product | null
}

// Specs to suppress from the display list — handled via prose above
const SUPPRESSED_SPEC_LABELS = new Set([
  'Waist', 'Pockets', 'Pre-shrunk', 'Branding',
])

export function PDPClient({ product, relatedProduct }: PDPClientProps) {
  const { addItem, openCart }  = useCart()
  const { t }                  = useI18n()
  const { formatPrice }        = useCurrency()
  const [selectedColor, setSelectedColor] = useState<ColorOption>(product.colors[0])
  const [selectedSize,  setSelectedSize]  = useState<SizeLabel | null>(null)
  const [sizeError,     setSizeError]     = useState(false)
  const [addState,      setAddState]      = useState<'idle' | 'loading' | 'added'>('idle')
  const [stickyVisible, setStickyVisible] = useState(false)

  const atcBtnRef    = useRef<HTMLButtonElement>(null)
  const sizePanelRef = useRef<HTMLDivElement>(null)

  const stock   = computeStock(product.sizes)
  const soldOut = stock === 0

  useEffect(() => {
    if (!atcBtnRef.current) return
    const obs = new IntersectionObserver(
      ([e]) => setStickyVisible(!e.isIntersecting),
      { threshold: 0, rootMargin: '-60px 0px 0px 0px' }
    )
    obs.observe(atcBtnRef.current)
    return () => obs.disconnect()
  }, [])

  const handleAdd = useCallback(async () => {
    if (!selectedSize) {
      setSizeError(true)
      sizePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    setSizeError(false)
    setAddState('loading')
    await new Promise(r => setTimeout(r, 280))
    const front = selectedColor.images.find(i => i.type === 'front')
    addItem({
      productId:   product.id,
      productName: product.name,
      slug:        product.slug,
      color:       selectedColor.value,
      colorName:   selectedColor.name,
      colorHex:    selectedColor.hex,
      size:        selectedSize,
      price:       product.price,
      quantity:    1,
      image:       front?.src ?? '',
    })
    setAddState('added')
    openCart()
    setTimeout(() => setAddState('idle'), 2000)
  }, [selectedSize, selectedColor, product, addItem, openCart])

  const visibleSpecs = product.specs.filter(s => !SUPPRESSED_SPEC_LABELS.has(s.label))

  const accordionItems = [
    {
      id: 'details', trigger: t.details,
      content: (
        <dl className="space-y-3">
          {visibleSpecs.map(s => (
            <div key={s.label} className="flex gap-4">
              <dt className="text-[13px] font-light text-[#1A1A1A] min-w-[110px] flex-shrink-0">{s.label}</dt>
              <dd className="text-[13px] text-[#6B6B6B]">{s.value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
    {
      id: 'shipping', trigger: t.shipping,
      content: (
        <div className="space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
          <p>Orders processed within 1 to 3 business days. Shipping costs and delivery times depend on destination and method selected at checkout.</p>
          <p>Domestic: approximately 2 to 7 business days. International: 5 to 14 or more business days. Delivery estimates are not guaranteed.</p>
          <Link href="/support/shipping-returns" className="text-[#1A1A1A] underline underline-offset-2">Full shipping policy</Link>
        </div>
      ),
    },
    {
      id: 'returns', trigger: t.returns,
      content: (
        <div className="space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
          <p>Returns accepted for store credit on unworn, unwashed items with tags attached, within our return window. Customer covers return shipping unless item arrives faulty or incorrect.</p>
          <Link href="/support/shipping-returns#returns" className="text-[#1A1A1A] underline underline-offset-2">Full returns policy</Link>
        </div>
      ),
    },
  ]

  const atcLabel =
    soldOut           ? t.soldOut   :
    addState === 'added'   ? t.addedToBag   :
    addState === 'loading' ? t.adding   :
    selectedSize           ? t.addToBag :
                             t.selectSize

  return (
    <>
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="container-kvrn pt-[calc(36px+56px+16px)] pb-3">
        <ol className="flex items-center gap-2 text-[11px] text-[#9B9B9B]">
          <li><Link href="/" className="hover:text-[#1A1A1A] transition-colors">Home</Link></li>
          <li aria-hidden="true">·</li>
          <li><Link href="/shop" className="hover:text-[#1A1A1A] transition-colors">Shop</Link></li>
          <li aria-hidden="true">·</li>
          <li className="text-[#1A1A1A]" aria-current="page">{product.name}</li>
        </ol>
      </nav>

      {/* Main grid */}
      <div className="container-kvrn pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-[58fr_42fr] gap-8 lg:gap-14 items-start">

          {/* Gallery — sticky */}
          <div className="lg:sticky lg:top-[calc(36px+56px+12px)]">
            <ProductGallery
              images={selectedColor.images}
              productName={product.name}
              colorName={selectedColor.name}
            />
          </div>

          {/* Info panel */}
          <div className="space-y-5">
            {/* Brand + name + badge + price */}
            <div>
              <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-1.5">KVRN</p>
              <div className="flex items-start gap-3 justify-between">
                <h1 className="font-display font-light text-[26px] md:text-[30px] leading-tight tracking-[-0.02em]">
                  {product.name}
                </h1>
                <StockBadge stock={stock} position="pdp" />
              </div>
              <p className="text-[22px] font-light mt-2 tabular-nums">{formatPrice(product.price)}</p>
              {product.founderNote && (
                <p className="text-[12px] text-[#6B6B6B] mt-1">{product.founderNote}</p>
              )}
            </div>

            <div className="h-px bg-[#E8E5E0]" />

            {/* Color */}
            <ColorSelector
              colors={product.colors}
              selectedColor={selectedColor.value}
              onChange={setSelectedColor}
            />

            <div className="h-px bg-[#E8E5E0]" />

            {/* Size — no duplicate label, size guide link here only */}
            <div ref={sizePanelRef}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">
                  Size{selectedSize ? ` — ${selectedSize}` : ''}
                </span>
                <Link href="/support/size-guide"
                  className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] underline underline-offset-2 transition-colors">
                  Size guide
                </Link>
              </div>
              <SizeSelector
                sizes={product.sizes}
                selectedSize={selectedSize}
                onChange={s => { setSelectedSize(s); setSizeError(false) }}
                hasError={sizeError}
                hideSizeGuideLink  // suppress the internal link — we have it above
              />
              {sizeError && <p className="text-[12px] text-[#B91C1C] mt-2">Please select a size</p>}
              {product.fitNote && <p className="text-[12px] text-[#6B6B6B] mt-2">{product.fitNote}</p>}
            </div>

            <div className="h-px bg-[#E8E5E0]" />

            {/* Add to Bag */}
            <Button
              ref={atcBtnRef}
              variant="primary" size="lg" fullWidth
              loading={addState === 'loading'}
              disabled={soldOut}
              onClick={handleAdd}
              className={cn(addState === 'added' && 'bg-[#15803D] border-[#15803D]')}
            >
              {atcLabel}
            </Button>

            {/* Trust signals */}
            <ul className="space-y-2" aria-label="Purchase assurances">
              {[t.qualityChecked, t.secureCheckout, t.easySupport].map(line => (
                <li key={line} className="flex items-center gap-2 text-[12px] text-[#6B6B6B]">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2 6l2.5 2.5L10 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {line}
                </li>
              ))}
            </ul>

            {/* Description */}
            <p className="text-[14px] text-[#6B6B6B] leading-relaxed">{product.description}</p>

            {/* Accordion details */}
            <Accordion items={accordionItems} />
          </div>
        </div>

        {/* Construction */}
        {product.features.length > 0 && (
          <section className="mt-20 md:mt-28" aria-labelledby="construction-heading">
            <p id="construction-heading"
              className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] text-center mb-8">
              The Construction
            </p>
            <div className={cn(
              'grid gap-4 mx-auto',
              product.features.length === 3
                ? 'grid-cols-1 sm:grid-cols-3 max-w-3xl'
                : 'grid-cols-1 sm:grid-cols-2 max-w-xl'
            )}>
              {product.features.map(f => (
                <div key={f.title} className="border border-[#E8E5E0] p-5 space-y-2">
                  <p className="text-[11px] font-light tracking-[0.08em] uppercase text-[#1A1A1A]">{f.title}</p>
                  <p className="text-[13px] text-[#6B6B6B] leading-relaxed">{f.description}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Complete the Set — redesigned */}
        {relatedProduct && (
          <section className="mt-16 md:mt-24" aria-labelledby="set-heading">
            <div className="bg-[#F3F0EB] p-8 md:p-12">
              <p id="set-heading"
                className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-8">
                Complete the Set
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 items-center">
                {/* Product pair thumbnails */}
                <div className="grid grid-cols-2 gap-3 max-w-sm">
                  {[product, relatedProduct].map((p, i) => {
                    const color = p.colors.find(c => c.value === selectedColor.value) ?? p.colors[0]
                    const img   = color.images[0]
                    return (
                      <Link key={p.id} href={`/products/${p.slug}`}
                        className="relative aspect-[3/4] bg-[#E8E5E0] overflow-hidden block group">
                        {img?.src
                          ? <Image src={img.src} alt={img.alt} fill sizes="200px"
                              className="object-cover group-hover:scale-[1.02] transition-transform duration-500" />
                          : <div className="absolute inset-0 flex items-end p-3">
                              <span className="text-[11px] text-[#9B9B9B]">{p.name}</span>
                            </div>
                        }
                        <div className="absolute bottom-0 left-0 right-0 bg-[#0E0E0E]/70 py-1.5 px-3">
                          <p className="text-[10px] font-light tracking-[0.08em] text-[#F0EDE8] truncate">{p.name}</p>
                        </div>
                      </Link>
                    )
                  })}
                </div>

                {/* Text + CTA */}
                <div>
                  <h3 className="font-display font-light text-[22px] md:text-[26px] leading-tight tracking-[-0.02em] mb-3">
                    The Full Set
                  </h3>
                  <p className="text-[13px] text-[#6B6B6B] leading-relaxed mb-5">
                    Same fabric. Same weight. Designed to be worn together. Both available in the same colorways.
                  </p>
                  <p className="text-[18px] font-light tabular-nums mb-6">
                    {formatPrice(product.price + relatedProduct.price)}
                    <span className="text-[12px] text-[#9B9B9B] ml-2 font-light">for both</span>
                  </p>
                  <Link href={`/products/${relatedProduct.slug}`}>
                    <Button variant="primary" size="md">Add {relatedProduct.name}</Button>
                  </Link>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Sticky ATC — white, refined */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[200]',
          'bg-white border-t border-[#E8E5E0]',
          'transition-all duration-400 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]',
          stickyVisible ? 'translate-y-0 shadow-[0_-4px_24px_rgba(0,0,0,0.06)]' : 'translate-y-full'
        )}
        aria-hidden={!stickyVisible}
      >
        <div className="container-kvrn max-w-[640px] mx-auto py-3.5 flex items-center gap-4">
          {/* Color swatch + info */}
          <div className="flex items-center gap-3 flex-1 min-w-0">
            <span
              className="w-5 h-5 rounded-full flex-shrink-0 border border-[#E8E5E0]"
              style={{ backgroundColor: selectedColor.hex }}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-[12px] font-light text-[#1A1A1A] truncate leading-tight tracking-wide">
                {product.name}
              </p>
              <p className="text-[11px] text-[#9B9B9B] leading-tight mt-0.5">
                {selectedColor.name}{selectedSize ? ` · ${selectedSize}` : ' — select a size'}
              </p>
            </div>
          </div>
          {/* Price + button */}
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-[14px] font-light tabular-nums text-[#1A1A1A] hidden sm:block">
              {formatPrice(product.price)}
            </span>
            <button
              disabled={soldOut || addState === 'loading'}
              onClick={handleAdd}
              className={cn(
                'h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase transition-all duration-200',
                soldOut
                  ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
                  : addState === 'added'
                  ? 'bg-[#15803D] text-white'
                  : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
              )}
            >
              {soldOut ? t.soldOut : addState === 'added' ? t.addedToBag : addState === 'loading' ? '…' : t.addToBag}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
