'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useCart } from '@/context/CartContext'
import { ProductGallery } from '@/components/product/ProductGallery'
import { ColorSelector } from '@/components/product/ColorSelector'
import { SizeSelector } from '@/components/product/SizeSelector'
import { Accordion } from '@/components/ui/Accordion'
import { Button } from '@/components/ui/Button'
import { formatPrice } from '@/data/products'
import { cn } from '@/lib/utils'
import type { ColorOption, SizeLabel, Product } from '@/types'

interface PDPClientProps {
  product:        Product
  relatedProduct: Product | null
}

export function PDPClient({ product, relatedProduct }: PDPClientProps) {
  const { addItem, openCart } = useCart()

  const [selectedColor, setSelectedColor] = useState<ColorOption>(product.colors[0])
  const [selectedSize,  setSelectedSize]  = useState<SizeLabel | null>(null)
  const [sizeError,     setSizeError]     = useState(false)
  const [addState,      setAddState]      = useState<'idle' | 'loading' | 'added'>('idle')
  const [stickyVisible, setStickyVisible] = useState(false)

  const addBtnRef    = useRef<HTMLButtonElement>(null)
  const sizePanelRef = useRef<HTMLDivElement>(null)

  // Reset selected image index when color changes
  const [, setColorKey] = useState(0)

  // Sticky CTA detection
  useEffect(() => {
    const obs = new IntersectionObserver(
      ([e]) => setStickyVisible(!e.isIntersecting),
      { threshold: 0, rootMargin: '-80px 0px 0px 0px' }
    )
    if (addBtnRef.current) obs.observe(addBtnRef.current)
    return () => obs.disconnect()
  }, [])

  const handleColorChange = useCallback((color: ColorOption) => {
    setSelectedColor(color)
    setColorKey(k => k + 1)
  }, [])

  const handleAddToCart = useCallback(async () => {
    if (!selectedSize) {
      setSizeError(true)
      sizePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    setSizeError(false)
    setAddState('loading')
    await new Promise(r => setTimeout(r, 350))

    const frontImg = selectedColor.images.find(i => i.type === 'front')
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
      image:       frontImg?.src ?? '',
    })
    setAddState('added')
    setTimeout(() => setAddState('idle'), 2200)
    openCart()
  }, [selectedSize, selectedColor, product, addItem, openCart])

  const accordionItems = [
    {
      id: 'construction',
      trigger: 'Construction',
      content: (
        <div className="space-y-5">
          {product.features.map(f => (
            <div key={f.title}>
              <p className="text-[13px] font-light text-[var(--color-text)] mb-1">{f.title}</p>
              <p className="text-[13px] font-light text-[var(--color-muted)] leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'specifications',
      trigger: 'Specifications',
      content: (
        <dl className="space-y-2.5">
          {product.specs.map(s => (
            <div key={s.label} className="flex gap-6">
              <dt className="text-[13px] font-light text-[var(--color-text)] min-w-[110px] flex-shrink-0">{s.label}</dt>
              <dd className="text-[13px] font-light text-[var(--color-muted)]">{s.value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
    {
      id: 'shipping',
      trigger: 'Shipping',
      content: (
        <div className="space-y-2 text-[13px] font-light text-[var(--color-muted)]">
          <p><span className="text-[var(--color-text)]">USA Standard</span> — 5–7 business days, $8</p>
          <p><span className="text-[var(--color-text)]">USA Express</span> — 2–3 business days, $18</p>
          <p><span className="text-[var(--color-text)]">International</span> — 7–14 business days, from $22</p>
          <p className="pt-2">Orders before 1pm EST ship same day. Tracked delivery included.</p>
        </div>
      ),
    },
    {
      id: 'returns',
      trigger: 'Returns',
      content: (
        <div className="space-y-3 text-[13px] font-light text-[var(--color-muted)]">
          <p>30-day returns on unworn, unwashed items with original tags attached.</p>
          <p>Email <a href="mailto:hello@kvrn.com" className="text-[var(--color-text)] underline underline-offset-2">hello@kvrn.com</a> with your order number to initiate. Prepaid label for US returns.</p>
          <p>Refunds processed within 5–10 business days of receipt.</p>
        </div>
      ),
    },
  ]

  const btnLabel =
    addState === 'added'   ? 'Added ✓' :
    addState === 'loading' ? '' :
    `Add to bag — ${formatPrice(product.price)}`

  return (
    <>
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="kvrn-container pt-[calc(60px+20px)] pb-4">
        <ol className="flex items-center gap-2 text-[11px] font-light text-[var(--color-muted)] tracking-wide">
          <li><Link href="/" className="hover:text-[var(--color-text)] transition-colors">Home</Link></li>
          <li aria-hidden="true">·</li>
          <li><Link href="/shop" className="hover:text-[var(--color-text)] transition-colors">Collection</Link></li>
          <li aria-hidden="true">·</li>
          <li className="text-[var(--color-text)]" aria-current="page">{product.name}</li>
        </ol>
      </nav>

      {/* Main PDP layout */}
      <div className="kvrn-container pb-24 md:pb-32">
        <div className="grid grid-cols-1 lg:grid-cols-[55fr_45fr] gap-8 lg:gap-16 items-start">

          {/* Gallery */}
          <div className="lg:sticky lg:top-[76px]">
            <ProductGallery
              images={selectedColor.images}
              productName={product.name}
              colorName={selectedColor.name}
            />
          </div>

          {/* Product panel */}
          <div className="space-y-6">

            {/* Name + price */}
            <div>
              <p className="kvrn-label mb-2">KVRN</p>
              <h1 className="text-[28px] md:text-[34px] font-light leading-tight tracking-tight">
                {product.name}
              </h1>
              <div className="flex items-baseline gap-3 mt-3">
                <p className="text-[20px] font-light">{formatPrice(product.price)}</p>
                <p className="text-[12px] font-light text-[var(--color-muted)]">USD, incl. tax</p>
              </div>
            </div>

            <div className="kvrn-rule" />

            {/* Color */}
            <ColorSelector
              colors={product.colors}
              selectedColor={selectedColor.value}
              onChange={handleColorChange}
            />

            <div className="kvrn-rule" />

            {/* Size */}
            <div ref={sizePanelRef}>
              <SizeSelector
                sizes={product.sizes}
                selectedSize={selectedSize}
                onChange={s => { setSelectedSize(s); setSizeError(false) }}
                hasError={sizeError}
              />
              {product.fitNote && (
                <p className="text-[12px] font-light text-[var(--color-muted)] mt-3">
                  {product.fitNote}
                </p>
              )}
            </div>

            <div className="kvrn-rule" />

            {/* Add to bag + express */}
            <div className="space-y-3">
              <Button
                ref={addBtnRef}
                variant="primary"
                size="lg"
                fullWidth
                onClick={handleAddToCart}
                loading={addState === 'loading'}
                className={cn(addState === 'added' && 'bg-[var(--color-success)] border-[var(--color-success)]')}
              >
                {btnLabel}
              </Button>
              <div className="grid grid-cols-2 gap-3" aria-label="Express checkout">
                {[' Pay', 'G Pay'].map(label => (
                  <button
                    key={label}
                    className="h-12 border border-[var(--color-border)] text-[12px] font-light text-[var(--color-muted)] hover:border-[var(--color-border-strong)] hover:text-[var(--color-text)] transition-all duration-150"
                    aria-label={`${label} — available at checkout`}
                    disabled
                    title="Available at checkout"
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Trust signals */}
            <ul className="space-y-2.5" aria-label="Shipping and returns">
              {[
                'Ships in 3–5 business days',
                'Free returns within 30 days',
                'Tracked delivery on every order',
              ].map(line => (
                <li key={line} className="flex items-center gap-2.5 text-[13px] font-light text-[var(--color-muted)]">
                  <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                    <path d="M2 6.5l3 3 6-6" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {line}
                </li>
              ))}
            </ul>

            {/* Accordion */}
            <Accordion items={accordionItems} />
          </div>
        </div>

        {/* ─── Construction details ─── */}
        <section className="mt-20 md:mt-32 pt-12 md:pt-16 border-t border-[var(--color-border)]" aria-labelledby="pdp-construction">
          <p id="pdp-construction" className="kvrn-label mb-8 md:mb-12">Construction</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {product.features.map(f => (
              <div key={f.title} className="border border-[var(--color-border)] p-5 md:p-6 space-y-3">
                <p className="text-[11px] font-light tracking-[0.12em] uppercase">{f.title}</p>
                <p className="text-[13px] font-light text-[var(--color-muted)] leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Complete the set ─── */}
        {relatedProduct && (
          <section className="mt-20 md:mt-32 pt-12 md:pt-16 border-t border-[var(--color-border)]" aria-labelledby="complete-set">
            <p id="complete-set" className="kvrn-label mb-8 md:mb-12">Complete the set</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 md:gap-16 items-center max-w-2xl">
              <div className="grid grid-cols-2 gap-3">
                {/* Current + related thumbnails */}
                {[selectedColor.images[0], (() => {
                  const matchingColor = relatedProduct.colors.find(c => c.value === selectedColor.value)
                  return (matchingColor ?? relatedProduct.colors[0]).images[0]
                })()].map((img, i) => (
                  <div key={i} className="relative aspect-[3/4] bg-[var(--color-bg-raised)] overflow-hidden">
                    {img?.src ? (
                      <Image src={img.src} alt={img.alt} fill sizes="200px" className="object-cover" />
                    ) : (
                      <div
                        className="absolute inset-0"
                        style={{ background: i === 0 ? selectedColor.hex + '30' : (relatedProduct.colors.find(c => c.value === selectedColor.value) ?? relatedProduct.colors[0]).hex + '30' }}
                      />
                    )}
                  </div>
                ))}
              </div>
              <div className="space-y-4">
                <p className="text-[15px] font-light">The KVRN Set</p>
                <p className="text-[13px] font-light text-[var(--color-muted)] leading-relaxed">
                  The hoodie and sweatpants share the same fabric weight, the same
                  construction standard, and the same colorways. Designed together.
                </p>
                <p className="text-[14px] font-light text-[var(--color-muted)]">
                  {formatPrice(product.price)} + {formatPrice(relatedProduct.price)}
                </p>
                <Link href={`/products/${relatedProduct.slug}`}>
                  <Button variant="secondary" size="md">
                    View {relatedProduct.name}
                  </Button>
                </Link>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Sticky mobile CTA */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[200] bg-[var(--color-bg)] border-t border-[var(--color-border)]',
          'px-4 py-3 md:hidden',
          'transition-transform duration-300',
          stickyVisible ? 'translate-y-0' : 'translate-y-full'
        )}
        aria-hidden={!stickyVisible}
      >
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-light truncate">{product.name}</p>
            {selectedSize && (
              <p className="text-[11px] text-[var(--color-muted)] font-light">
                {selectedColor.name} / {selectedSize}
              </p>
            )}
          </div>
          <Button
            variant="primary"
            size="md"
            onClick={handleAddToCart}
            loading={addState === 'loading'}
            className="flex-shrink-0"
          >
            {addState === 'added' ? 'Added ✓' : `${formatPrice(product.price)}`}
          </Button>
        </div>
      </div>
    </>
  )
}
