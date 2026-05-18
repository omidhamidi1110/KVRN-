'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCart }     from '@/context/CartContext'
import { useCurrency } from '@/context/CurrencyContext'
import { ProductGallery }  from '@/components/product/ProductGallery'
import { ColorSelector }   from '@/components/product/ColorSelector'
import { SizeSelector }    from '@/components/product/SizeSelector'
import { Accordion }       from '@/components/ui/Accordion'
import { Button }          from '@/components/ui/Button'
import { StockBadge, computeStock } from '@/components/ui/StockBadge'
import { cn }              from '@/lib/utils'
import type { ColorOption, SizeLabel, Product } from '@/types'

interface PDPClientProps {
  product:        Product
  relatedProduct: Product | null
}

export function PDPClient({ product, relatedProduct }: PDPClientProps) {
  const { addItem, openCart }   = useCart()
  const { formatPrice }         = useCurrency()

  const [selectedColor, setSelectedColor] = useState<ColorOption>(product.colors[0])
  const [selectedSize,  setSelectedSize]  = useState<SizeLabel | null>(null)
  const [sizeError,     setSizeError]     = useState(false)
  const [addState,      setAddState]      = useState<'idle' | 'loading' | 'added'>('idle')
  const [stickyVisible, setStickyVisible] = useState(false)

  const addBtnRef   = useRef<HTMLButtonElement>(null)
  const sizeSectionRef = useRef<HTMLDivElement>(null)

  const stock = computeStock(product.sizes)

  // Show sticky ATC when main button scrolls out of view
  useEffect(() => {
    if (!addBtnRef.current) return
    const obs = new IntersectionObserver(
      ([e]) => setStickyVisible(!e.isIntersecting),
      { threshold: 0, rootMargin: '-80px 0px 0px 0px' }
    )
    obs.observe(addBtnRef.current)
    return () => obs.disconnect()
  }, [])

  const handleAddToCart = useCallback(async () => {
    if (!selectedSize) {
      setSizeError(true)
      sizeSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      sizeSectionRef.current?.classList.add('[animation:attention-pulse_0.4s_ease_2]')
      return
    }
    setSizeError(false)
    setAddState('loading')

    await new Promise(r => setTimeout(r, 350))

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

  // Accordion content
  const accordionItems = [
    {
      id: 'construction', trigger: 'The Construction',
      content: (
        <div className="space-y-4">
          {product.features.map(f => (
            <div key={f.title}>
              <p className="text-[13px] font-light text-kvrn-text mb-0.5">{f.title}</p>
              <p className="text-[13px] text-kvrn-muted leading-relaxed">{f.description}</p>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'specs', trigger: 'Specifications',
      content: (
        <dl className="space-y-2">
          {product.specs.map(s => (
            <div key={s.label} className="flex gap-4">
              <dt className="text-[13px] font-light text-kvrn-text min-w-[110px]">{s.label}</dt>
              <dd className="text-[13px] text-kvrn-muted">{s.value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
    {
      id: 'shipping', trigger: 'Shipping',
      content: (
        <div className="space-y-2 text-[13px] text-kvrn-muted">
          <p>Orders are processed within approximately 1–3 business days.</p>
          <p>Domestic delivery: 2–7 business days.</p>
          <p>International delivery: 5–14+ business days.</p>
          <p>Delivery estimates are not guarantees. Actual costs calculated at checkout based on destination and method.</p>
          <Link href="/support/shipping-returns" className="text-kvrn-text underline underline-offset-2">Full shipping policy →</Link>
        </div>
      ),
    },
    {
      id: 'returns', trigger: 'Returns',
      content: (
        <div className="space-y-2 text-[13px] text-kvrn-muted">
          <p>We accept returns for store credit within our return window on unworn, unwashed items with tags attached.</p>
          <p>Customer is responsible for return shipping costs unless the item is faulty, damaged, or incorrect.</p>
          <Link href="/support/shipping-returns#returns" className="text-kvrn-text underline underline-offset-2">Full returns policy →</Link>
        </div>
      ),
    },
  ]

  const addLabel =
    addState === 'added'   ? 'Added ✓' :
    addState === 'loading' ? 'Adding...' :
    stock === 0            ? 'Sold Out' :
    selectedSize ? `Add to Bag — ${formatPrice(product.price)}` : 'Select a Size'

  return (
    <>
      {/* ─── Breadcrumb ─── */}
      <nav
        aria-label="Breadcrumb"
        className="container-kvrn pt-[calc(36px+56px+20px)] pb-4"
      >
        <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
          <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
          <li aria-hidden="true">·</li>
          <li><Link href="/shop" className="hover:text-kvrn-text transition-colors">Shop</Link></li>
          <li aria-hidden="true">·</li>
          <li className="text-kvrn-text" aria-current="page">{product.name}</li>
        </ol>
      </nav>

      {/* ─── PDP Grid ─── */}
      <div className="container-kvrn pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-[55fr_45fr] gap-8 lg:gap-16 items-start">

          {/* Gallery */}
          <div className="lg:sticky lg:top-[calc(36px+56px+16px)]">
            <ProductGallery
              images={selectedColor.images}
              productName={product.name}
              colorName={selectedColor.name}
            />
          </div>

          {/* Info panel */}
          <div className="space-y-5">
            {/* Name + badge + price */}
            <div>
              <p className="label-11 mb-1.5">KVRN</p>
              <div className="flex items-start justify-between gap-3">
                <h1 className="font-display font-light text-[28px] md:text-[32px] leading-tight tracking-tight">
                  {product.name}
                </h1>
                <StockBadge stock={stock} position="pdp" />
              </div>
              <p className="text-[18px] font-light mt-2">{formatPrice(product.price)}</p>
              <p className="text-[11px] text-kvrn-muted mt-1 tracking-wide">
                Price shown in selected currency. Actual charge at checkout.
              </p>
            </div>

            <div className="rule" />

            {/* Color */}
            <ColorSelector
              colors={product.colors}
              selectedColor={selectedColor.value}
              onChange={setSelectedColor}
            />

            <div className="rule" />

            {/* Size */}
            <div ref={sizeSectionRef}>
              <SizeSelector
                sizes={product.sizes}
                selectedSize={selectedSize}
                onChange={size => { setSelectedSize(size); setSizeError(false) }}
                hasError={sizeError}
              />
              {product.fitNote && (
                <p className="text-[12px] text-kvrn-muted mt-3 leading-relaxed">{product.fitNote}</p>
              )}
              <Link href="/support/size-guide"
                className="inline-block text-[11px] text-kvrn-muted underline underline-offset-2 hover:text-kvrn-text transition-colors mt-2">
                Size guide →
              </Link>
            </div>

            <div className="rule" />

            {/* ATC */}
            <div className="space-y-3">
              <Button
                ref={addBtnRef}
                variant="primary" size="lg" fullWidth
                loading={addState === 'loading'}
                disabled={stock === 0}
                onClick={handleAddToCart}
                className={cn(addState === 'added' && 'bg-kvrn-success border-kvrn-success')}
              >
                {addLabel}
              </Button>
            </div>

            {/* Trust signals */}
            <ul className="space-y-2.5" aria-label="Order information">
              {[
                'Secure checkout',
                'Store credit returns within return window',
                'Ships within 1–3 business days',
                'Premium materials, tested per batch',
              ].map(line => (
                <li key={line} className="flex items-center gap-2 text-[12px] text-kvrn-muted">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2 6l2.5 2.5L10 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {line}
                </li>
              ))}
            </ul>

            {/* Accordion */}
            <Accordion items={accordionItems} />
          </div>
        </div>

        {/* Construction callouts */}
        <section className="mt-20 md:mt-28" aria-labelledby="construction-section">
          <p id="construction-section" className="label-11 mb-8 text-center">The Construction</p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {product.features.map(f => (
              <div key={f.title} className="border border-kvrn-border p-5 space-y-2">
                <p className="text-[11px] font-light tracking-widest uppercase">{f.title}</p>
                <p className="text-[13px] text-kvrn-muted leading-relaxed">{f.description}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Complete the Set */}
        {relatedProduct && (
          <section className="mt-20 md:mt-28" aria-labelledby="set-section">
            <div className="border-t border-kvrn-border pt-12">
              <p id="set-section" className="label-11 mb-8">Complete the Set</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 md:gap-16 items-start">
                <div className="grid grid-cols-2 gap-3">
                  {[product, relatedProduct].map((p, i) => {
                    const colorMatch = p.colors.find(c => c.value === selectedColor.value) ?? p.colors[0]
                    const img = colorMatch.images[0]
                    return (
                      <Link key={p.id} href={`/products/${p.slug}`}
                        className="relative aspect-[3/4] bg-kvrn-bg-raised overflow-hidden block">
                        {img?.src ? (
                          <Image src={img.src} alt={img.alt} fill sizes="200px" className="object-cover" />
                        ) : (
                          <div className="absolute inset-0 flex items-center justify-center">
                            <span className="label-11 text-kvrn-subtle text-center px-2">{p.name}</span>
                          </div>
                        )}
                      </Link>
                    )
                  })}
                </div>
                <div className="space-y-4">
                  <p className="text-[15px] font-light">The KVRN Set</p>
                  <p className="text-[13px] text-kvrn-muted leading-relaxed">
                    Designed together. Same fabric weight, same construction standard. Both available in the same colorways.
                  </p>
                  <p className="text-[15px] font-light">
                    {formatPrice(product.price)} + {formatPrice(relatedProduct.price)}
                  </p>
                  <Link href={`/products/${relatedProduct.slug}`}>
                    <Button variant="secondary" size="md">View {relatedProduct.name}</Button>
                  </Link>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* ─── Sticky ATC (mobile + desktop) ─── */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[200]',
          'bg-kvrn-bg/95 backdrop-blur-sm border-t border-kvrn-border',
          'px-4 py-3 transition-transform duration-300',
          stickyVisible ? 'translate-y-0' : 'translate-y-full'
        )}
        aria-hidden={!stickyVisible}
      >
        <div className="max-w-[600px] mx-auto flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-light truncate">{product.name}</p>
            {selectedSize && (
              <p className="text-[11px] text-kvrn-muted">
                {selectedColor.name} / {selectedSize}
              </p>
            )}
          </div>
          <Button
            variant="primary" size="md"
            loading={addState === 'loading'}
            disabled={stock === 0}
            onClick={handleAddToCart}
            className="flex-shrink-0"
          >
            {addState === 'added' ? 'Added ✓' : formatPrice(product.price)}
          </Button>
        </div>
      </div>
    </>
  )
}
