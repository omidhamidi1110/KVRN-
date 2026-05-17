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
import { ProductCard } from '@/components/product/ProductCard'
import { formatPrice } from '@/data/products'
import { cn, scrollToElement } from '@/lib/utils'
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

  const addButtonRef = useRef<HTMLButtonElement>(null)
  const sizeSectionRef = useRef<HTMLDivElement>(null)

  // Current images for selected color
  const currentImages = selectedColor.images

  // Detect when add-to-bag button leaves viewport → show sticky
  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setStickyVisible(!entry.isIntersecting),
      { threshold: 0, rootMargin: '-80px 0px 0px 0px' }
    )
    if (addButtonRef.current) observer.observe(addButtonRef.current)
    return () => observer.disconnect()
  }, [])

  const handleColorChange = useCallback((color: ColorOption) => {
    setSelectedColor(color)
    // If selected size is OOS in new color — reset (all colors share same size availability for now)
    // In a real multi-variant system you'd check per-color stock
  }, [])

  const handleAddToCart = useCallback(async () => {
    // Validate size selection
    if (!selectedSize) {
      setSizeError(true)
      // Scroll to size selector and pulse it
      const sizeEl = sizeSectionRef.current
      if (sizeEl) {
        sizeEl.scrollIntoView({ behavior: 'smooth', block: 'center' })
        sizeEl.classList.add('animate-attention-pulse')
        setTimeout(() => sizeEl.classList.remove('animate-attention-pulse'), 800)
      }
      return
    }

    setSizeError(false)
    setAddState('loading')

    // Simulate async (replace with real stock check if needed)
    await new Promise((r) => setTimeout(r, 400))

    const frontImage = selectedColor.images.find((i) => i.type === 'front')

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
      image:       frontImage?.src ?? '',
    })

    setAddState('added')
    setTimeout(() => setAddState('idle'), 2000)
    openCart()
  }, [selectedSize, selectedColor, product, addItem, openCart])

  // Accordion content
  const accordionItems = [
    {
      id: 'construction',
      trigger: 'The Construction',
      content: (
        <div className="space-y-4">
          {product.features.map((feat) => (
            <div key={feat.title}>
              <p className="text-[13px] font-light text-kvrn-text mb-0.5">{feat.title}</p>
              <p className="text-[13px] text-kvrn-muted leading-relaxed">{feat.description}</p>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'specifications',
      trigger: 'Specifications',
      content: (
        <dl className="space-y-2">
          {product.specs.map((spec) => (
            <div key={spec.label} className="flex gap-4">
              <dt className="text-[13px] font-light text-kvrn-text min-w-[110px]">{spec.label}</dt>
              <dd className="text-[13px] text-kvrn-muted">{spec.value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
    {
      id: 'shipping',
      trigger: 'Shipping & Delivery',
      content: (
        <div className="space-y-2 text-[13px] text-kvrn-muted">
          <p><span className="text-kvrn-text font-light">UK Standard</span> — 3–5 business days, £4.99</p>
          <p><span className="text-kvrn-text font-light">UK Express</span> — 1–2 business days, £9.99</p>
          <p><span className="text-kvrn-text font-light">Europe</span> — 5–10 business days, £14.99</p>
          <p><span className="text-kvrn-text font-light">USA / Canada</span> — 7–14 business days, £19.99</p>
          <p className="pt-2">Orders placed before 1pm GMT ship same day. Tracking included with every order.</p>
        </div>
      ),
    },
    {
      id: 'returns',
      trigger: 'Returns',
      content: (
        <div className="space-y-3 text-[13px] text-kvrn-muted">
          <p>30-day returns accepted on unworn, unwashed items with tags attached.</p>
          <p>
            To start a return visit{' '}
            <Link href="/support/shipping-returns" className="text-kvrn-text underline underline-offset-2">
              our returns page
            </Link>
            . We&apos;ll email a prepaid label within 24 hours.
          </p>
          <p>Refunds processed within 5–10 business days of receipt.</p>
        </div>
      ),
    },
  ]

  const addButtonLabel =
    addState === 'added'
      ? 'Added ✓'
      : addState === 'loading'
      ? 'Adding...'
      : selectedSize
      ? `Add to bag — ${formatPrice(product.price)}`
      : 'Select a size'

  return (
    <>
      {/* ─── Breadcrumb ─── */}
      <nav aria-label="Breadcrumb" className="container-kvrn pt-[calc(56px+24px)] pb-4">
        <ol className="flex items-center gap-2 text-[11px] text-kvrn-muted tracking-wide">
          <li><Link href="/" className="hover:text-kvrn-text transition-colors">Home</Link></li>
          <li aria-hidden="true">·</li>
          <li><Link href="/shop" className="hover:text-kvrn-text transition-colors">Shop</Link></li>
          <li aria-hidden="true">·</li>
          <li className="text-kvrn-text" aria-current="page">{product.name}</li>
        </ol>
      </nav>

      {/* ─── Main PDP Layout ─── */}
      <div className="container-kvrn pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-[55fr_45fr] gap-8 lg:gap-16 items-start">

          {/* ─── LEFT: Gallery ─── */}
          <div className="lg:sticky lg:top-[72px]">
            <ProductGallery
              images={currentImages}
              productName={product.name}
              colorName={selectedColor.name}
            />
          </div>

          {/* ─── RIGHT: Product info panel ─── */}
          <div className="space-y-6">
            {/* Name + Price */}
            <div>
              <p className="label-11 mb-2">KVRN</p>
              <h1 className="font-display font-light text-[28px] md:text-[32px] leading-tight tracking-tight">
                {product.name}
              </h1>
              <div className="flex items-baseline gap-3 mt-2">
                <p className="text-[18px] font-light">{formatPrice(product.price)}</p>
                <p className="text-[12px] text-kvrn-muted">incl. VAT</p>
              </div>
            </div>

            <div className="rule" />

            {/* Color selector */}
            <ColorSelector
              colors={product.colors}
              selectedColor={selectedColor.value}
              onChange={handleColorChange}
            />

            <div className="rule" />

            {/* Size selector */}
            <div ref={sizeSectionRef}>
              <SizeSelector
                sizes={product.sizes}
                selectedSize={selectedSize}
                onChange={(size) => { setSelectedSize(size); setSizeError(false) }}
                hasError={sizeError}
              />
              {product.fitNote && (
                <p className="text-[12px] text-kvrn-muted mt-3 leading-relaxed">
                  {product.fitNote}
                </p>
              )}
            </div>

            <div className="rule" />

            {/* Add to bag */}
            <div className="space-y-3">
              <Button
                ref={addButtonRef}
                variant="primary"
                size="lg"
                fullWidth
                onClick={handleAddToCart}
                loading={addState === 'loading'}
                className={cn(addState === 'added' && 'bg-kvrn-success border-kvrn-success hover:bg-kvrn-success')}
                aria-label={addButtonLabel}
              >
                {addButtonLabel}
              </Button>

              {/* Express checkout placeholder
                  Replace with actual Stripe Payment Request Button in checkout page */}
              <div
                className="flex gap-3"
                aria-label="Express checkout options"
              >
                <button
                  className="flex-1 h-12 border border-kvrn-border text-[11px] tracking-widest text-kvrn-muted hover:border-kvrn-border-strong hover:text-kvrn-text transition-colors duration-150"
                  aria-label="Pay with Apple Pay"
                  disabled
                  title="Available at checkout"
                >
                   Pay
                </button>
                <button
                  className="flex-1 h-12 border border-kvrn-border text-[11px] tracking-widest text-kvrn-muted hover:border-kvrn-border-strong hover:text-kvrn-text transition-colors duration-150"
                  aria-label="Pay with Google Pay"
                  disabled
                  title="Available at checkout"
                >
                  G Pay
                </button>
              </div>
            </div>

            {/* Trust signals */}
            <ul className="space-y-2" aria-label="Delivery and returns information">
              {[
                'Ships in 3–5 business days',
                'Free returns within 30 days',
                'Tracked delivery, every order',
              ].map((line) => (
                <li key={line} className="flex items-center gap-2 text-[13px] text-kvrn-muted">
                  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                    <path d="M2 7l3.5 3.5L12 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {line}
                </li>
              ))}
            </ul>

            {/* Accordion */}
            <Accordion items={accordionItems} />
          </div>
        </div>

        {/* ─── Construction callouts ─── */}
        <section className="mt-20 md:mt-32" aria-labelledby="construction-heading">
          <p id="construction-heading" className="label-11 mb-8 md:mb-12 text-center">
            The Construction
          </p>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-8">
            {product.features.map((feat) => (
              <div
                key={feat.title}
                className="border border-kvrn-border p-5 md:p-6 space-y-3"
              >
                <p className="text-[11px] font-light tracking-widest uppercase text-kvrn-text">
                  {feat.title}
                </p>
                <p className="text-[13px] text-kvrn-muted leading-relaxed">
                  {feat.description}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* ─── Complete the Set ─── */}
        {relatedProduct && (
          <section className="mt-20 md:mt-32" aria-labelledby="set-heading">
            <div className="border-t border-kvrn-border pt-12 md:pt-16">
              <p id="set-heading" className="label-11 mb-8 md:mb-12">
                Complete the Set
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 md:gap-16 items-center">
                <div className="grid grid-cols-2 gap-3">
                  {/* Current product mini card */}
                  <div className="relative aspect-[3/4] bg-kvrn-bg-raised overflow-hidden">
                    <Image
                      src={selectedColor.images[0]?.src ?? ''}
                      alt={product.name}
                      fill
                      className="object-cover"
                      sizes="200px"
                    />
                    {!selectedColor.images[0]?.src && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="label-11 text-kvrn-subtle text-center px-2">
                          {product.name}
                        </span>
                      </div>
                    )}
                  </div>
                  {/* Related product mini card */}
                  <Link
                    href={`/products/${relatedProduct.slug}`}
                    className="relative aspect-[3/4] bg-kvrn-bg-raised overflow-hidden block"
                  >
                    <Image
                      src={relatedProduct.colors.find(c => c.value === selectedColor.value)?.images[0]?.src ?? relatedProduct.colors[0]?.images[0]?.src ?? ''}
                      alt={relatedProduct.name}
                      fill
                      className="object-cover"
                      sizes="200px"
                    />
                    {!relatedProduct.colors[0]?.images[0]?.src && (
                      <div className="absolute inset-0 flex items-center justify-center">
                        <span className="label-11 text-kvrn-subtle text-center px-2">
                          {relatedProduct.name}
                        </span>
                      </div>
                    )}
                  </Link>
                </div>

                <div className="space-y-4">
                  <p className="text-[15px] font-light">The KVRN Set</p>
                  <p className="text-[13px] text-kvrn-muted leading-relaxed">
                    The hoodie and sweatpants were designed together. Same fabric weight,
                    same construction standard. Same colorway available in both.
                  </p>
                  <p className="text-[15px] font-light">
                    {formatPrice(product.price)} + {formatPrice(relatedProduct.price)}
                  </p>
                  <Link href={`/products/${relatedProduct.slug}`}>
                    <Button variant="secondary" size="md">
                      View {relatedProduct.name}
                    </Button>
                  </Link>
                </div>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* ─── Sticky Add-to-Bag (mobile) ─── */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[200] bg-kvrn-bg border-t border-kvrn-border',
          'px-4 py-3 md:hidden',
          'transition-transform duration-300',
          stickyVisible ? 'translate-y-0' : 'translate-y-full'
        )}
        aria-hidden={!stickyVisible}
      >
        <div className="flex items-center gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-[12px] font-light truncate">{product.name}</p>
            {selectedSize && selectedColor && (
              <p className="text-[11px] text-kvrn-muted">
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
            {addState === 'added' ? 'Added ✓' : `${formatPrice(product.price)} — Add`}
          </Button>
        </div>
      </div>
    </>
  )
}
