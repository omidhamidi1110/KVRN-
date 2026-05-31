'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useCart }        from '@/context/CartContext'
import { useCurrency }    from '@/context/CurrencyContext'
import { useI18n }        from '@/context/I18nContext'
import { SizeSelector }   from '@/components/product/SizeSelector'
import { cn }             from '@/lib/utils'
import type { Product, ColorOption, SizeLabel } from '@/types'

interface PDPClientProps {
  product:        Product
  relatedProduct: Product | null
}

export function PDPClient({ product, relatedProduct }: PDPClientProps) {
  const { addItem, openCart } = useCart()
  const { formatPrice }       = useCurrency()
  const { t }                 = useI18n()

  const [selectedColor, setSelectedColor] = useState<ColorOption>(product.colors[0])
  const [selectedSize,  setSelectedSize]  = useState<SizeLabel | null>(null)
  const [sizeError,     setSizeError]     = useState(false)
  const [addState,      setAddState]      = useState<'idle' | 'loading' | 'added'>('idle')
  const [stickyVisible, setStickyVisible] = useState(false)
  const stickyTriggerRef = useRef<HTMLDivElement>(null)

  // Sticky ATC observer — shows after hero section scrolls past
  useEffect(() => {
    const el = stickyTriggerRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([entry]) => setStickyVisible(!entry.isIntersecting),
      { threshold: 0 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  const handleAdd = useCallback(async () => {
    if (!selectedSize) { setSizeError(true); return }
    setSizeError(false)
    setAddState('loading')
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
    setTimeout(() => { setAddState('idle'); openCart() }, 700)
  }, [selectedSize, selectedColor, product, addItem, openCart])

  const soldOut  = !product.sizes.some(s => s.inStock)
  const atcLabel = soldOut          ? t.soldOut
    : addState === 'added'          ? t.addedToBag
    : addState === 'loading'        ? '...'
    : selectedSize                  ? t.addToBag
    :                                 t.selectSize

  // Hero image = first image of selected color
  const heroImage = selectedColor.images[0]

  return (
    <div className="overflow-x-hidden w-full">

      {/* ══════════════════════════════════════════════════════════════
          SECTION 1 — FULL-SCREEN HERO
      ══════════════════════════════════════════════════════════════ */}
      <section
        className="relative w-full overflow-hidden bg-[#F0EDE8]"
        style={{ height: '100svh', minHeight: '100svh' }}
        aria-label={`${product.name} — hero`}
      >
        {/* Hero image — full bleed */}
        {heroImage?.src ? (
          <Image
            src={heroImage.src}
            alt={heroImage.alt || product.name}
            fill priority fetchPriority="high"
            sizes="(max-width: 1024px) 100vw, 60vw"
            className="object-cover object-center lg:object-[55%_center]"
            quality={92}
          />
        ) : (
          <div className="absolute inset-0 bg-[#E8E5E0]" />
        )}

        {/* Gradient — bottom overlay for text on mobile, right panel on desktop */}
        <div
          className="absolute inset-0 lg:hidden"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.72) 0%, rgba(0,0,0,0.2) 45%, transparent 80%)' }}
          aria-hidden="true"
        />
        {/* Desktop right side gradient */}
        <div
          className="hidden lg:block absolute inset-y-0 right-0 w-[42%]"
          style={{ background: 'linear-gradient(to right, transparent 0%, rgba(14,14,14,0.55) 100%)' }}
          aria-hidden="true"
        />

        {/* ── Mobile: bottom overlay copy ─────────────────────────── */}
        <div className="lg:hidden absolute bottom-0 left-0 right-0 px-6 pb-10 pt-16">
          <p className="text-[11px] font-light tracking-[0.2em] uppercase text-[#F0EDE8]/60 mb-3">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>
          <h1 className="font-display font-light text-[34px] leading-[0.92] tracking-[-0.025em] text-white mb-2">
            {product.name}
          </h1>
          <p className="text-[20px] font-light text-white/90 mb-4 tabular-nums">
            {formatPrice(product.price)}
          </p>
          <p className="text-[13px] font-light text-white/60 mb-6 leading-relaxed">
            {product.shortDescription}
          </p>
          {/* Size selector inline on mobile hero */}
          <div className="mb-4">
            <SizeSelector
              sizes={product.sizes}
              selectedSize={selectedSize}
              onChange={s => { setSelectedSize(s); setSizeError(false) }}
              hasError={sizeError}
              hideSizeGuideLink
              compact
            />
          </div>
          <button
            disabled={soldOut || addState === 'loading'}
            onClick={handleAdd}
            className={cn(
              'w-full h-12 text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
              soldOut       ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : addState === 'added' ? 'bg-[#15803D] text-white'
              : 'bg-white text-[#0E0E0E] hover:bg-[#F0EDE8]'
            )}
          >
            {atcLabel}
          </button>
          {/* Scroll cue */}
          <div className="flex items-center gap-2 mt-6 opacity-40" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v8M5 8l3 3 3-3" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span className="text-[10px] font-light tracking-[0.12em] uppercase text-white">Explore</span>
          </div>
        </div>

        {/* ── Desktop: right panel ─────────────────────────────────── */}
        <div className="hidden lg:flex absolute inset-y-0 right-0 w-[42%] flex-col justify-end pb-14 px-12 xl:px-16">
          <p className="text-[11px] font-light tracking-[0.2em] uppercase text-[#F0EDE8]/55 mb-5">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>
          <h1 className="font-display font-light text-[38px] xl:text-[46px] leading-[0.9] tracking-[-0.03em] text-white mb-3">
            {product.name}
          </h1>
          <p className="text-[22px] font-light text-white/90 mb-5 tabular-nums">
            {formatPrice(product.price)}
          </p>
          <p className="text-[14px] font-light text-white/65 mb-8 leading-relaxed max-w-[320px]">
            {product.shortDescription}
          </p>
          {/* Specs strip */}
          <div className="flex gap-6 mb-8 border-t border-white/15 pt-5">
            {product.specs?.slice(0, 3).map(s => (
              <div key={s.label}>
                <p className="text-[10px] font-light tracking-[0.1em] uppercase text-white/40 mb-0.5">{s.label}</p>
                <p className="text-[13px] font-light text-white/80">{s.value}</p>
              </div>
            ))}
          </div>
          {/* Size selector */}
          <div className="mb-4">
            <SizeSelector
              sizes={product.sizes}
              selectedSize={selectedSize}
              onChange={s => { setSelectedSize(s); setSizeError(false) }}
              hasError={sizeError}
              hideSizeGuideLink
              compact
              darkMode
            />
          </div>
          <button
            disabled={soldOut || addState === 'loading'}
            onClick={handleAdd}
            className={cn(
              'h-12 px-10 w-fit text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
              soldOut            ? 'bg-white/20 text-white/40 cursor-not-allowed'
              : addState === 'added' ? 'bg-[#15803D] text-white'
              : 'bg-white text-[#0E0E0E] hover:bg-[#F0EDE8]'
            )}
          >
            {atcLabel}
          </button>
          {/* Scroll cue */}
          <div className="flex items-center gap-2 mt-8 opacity-35" aria-hidden="true">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <path d="M8 3v8M5 8l3 3 3-3" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <span className="text-[10px] font-light tracking-[0.12em] uppercase text-white">Explore</span>
          </div>
        </div>
      </section>

      {/* Sticky trigger — when this passes viewport top, sticky bar appears */}
      <div ref={stickyTriggerRef} aria-hidden="true" />

      {/* ══════════════════════════════════════════════════════════════
          SECTION 2 — EDITORIAL IMAGE GALLERY
      ══════════════════════════════════════════════════════════════ */}
      {selectedColor.images.length > 1 && (
        <section
          className="bg-[#0E0E0E] py-16 md:py-20 overflow-hidden"
          aria-label={`${product.name} — gallery`}
        >
          <GallerySection images={selectedColor.images} productName={product.name} />
        </section>
      )}

      {/* ══════════════════════════════════════════════════════════════
          SECTION 3 — PURCHASE + DETAILS (normal scroll)
      ══════════════════════════════════════════════════════════════ */}
      <section className="bg-[#F9F8F6]" aria-label="Product details and purchase">
        <div className="container-kvrn max-w-5xl py-14 md:py-20">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 lg:gap-16">

            {/* ── Left: Color thumbnails + gallery repeat ── */}
            <div>
              {/* Color picker */}
              {product.colors.length > 1 && (
                <div className="mb-8">
                  <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-3">
                    Color — {selectedColor.name}
                  </p>
                  <div className="flex gap-2.5 flex-wrap">
                    {product.colors.map(col => (
                      <button
                        key={col.value}
                        title={col.name}
                        aria-label={col.name}
                        aria-pressed={col.value === selectedColor.value}
                        onClick={() => setSelectedColor(col)}
                        className={cn(
                          'w-8 h-8 rounded-full border-2 transition-all duration-150',
                          col.value === selectedColor.value
                            ? 'border-[#1A1A1A] scale-110'
                            : 'border-transparent hover:border-[#C8C4BF]'
                        )}
                        style={{ backgroundColor: col.hex }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Stacked images — 2-column grid */}
              <div className="grid grid-cols-2 gap-2">
                {selectedColor.images.slice(0, 4).map((img, i) => (
                  <div key={img.src || i}
                    className={cn('relative overflow-hidden bg-[#F0EDE8]', i === 0 && 'col-span-2')}>
                    <div className={i === 0 ? 'aspect-[4/3]' : 'aspect-[3/4]'}>
                      {img.src ? (
                        <Image
                          src={img.src} alt={img.alt || product.name} fill
                          sizes="(max-width: 1024px) 50vw, 25vw"
                          className="object-cover"
                          loading="lazy"
                          onError={() => {}}
                        />
                      ) : (
                        <div className="absolute inset-0 bg-[#E8E5E0]" />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* ── Right: Size, ATC, Details ── */}
            <div>
              {/* Product title + price */}
              <div className="mb-8">
                <h2 className="font-display font-light text-[28px] md:text-[34px] leading-tight tracking-[-0.02em] mb-2">
                  {product.name}
                </h2>
                <p className="text-[22px] font-light tabular-nums">{formatPrice(product.price)}</p>
                {product.founderNote && (
                  <p className="text-[12px] text-[#9B9B9B] mt-1">{product.founderNote}</p>
                )}
              </div>

              {/* Color (desktop duplicate for this section) */}
              {product.colors.length > 1 && (
                <div className="mb-6">
                  <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-3">
                    Color — {selectedColor.name}
                  </p>
                  <div className="flex gap-2.5 flex-wrap">
                    {product.colors.map(col => (
                      <button key={col.value} title={col.name} aria-label={col.name}
                        aria-pressed={col.value === selectedColor.value}
                        onClick={() => setSelectedColor(col)}
                        className={cn(
                          'w-7 h-7 rounded-full border-2 transition-all duration-150',
                          col.value === selectedColor.value ? 'border-[#1A1A1A] scale-110' : 'border-transparent hover:border-[#C8C4BF]'
                        )}
                        style={{ backgroundColor: col.hex }}
                      />
                    ))}
                  </div>
                </div>
              )}

              {/* Size */}
              <div className="mb-6">
                <SizeSelector
                  sizes={product.sizes}
                  selectedSize={selectedSize}
                  onChange={s => { setSelectedSize(s); setSizeError(false) }}
                  hasError={sizeError}
                />
                {sizeError && (
                  <p className="text-[12px] text-[#B91C1C] mt-2">Please select a size</p>
                )}
              </div>

              {/* Add to Bag */}
              <button
                disabled={soldOut || addState === 'loading'}
                onClick={handleAdd}
                className={cn(
                  'w-full h-12 mb-3 text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
                  soldOut            ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
                  : addState === 'added' ? 'bg-[#15803D] text-white'
                  : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
                )}
              >
                {atcLabel}
              </button>

              {/* Description */}
              <p className="text-[14px] text-[#6B6B6B] leading-relaxed mb-8">
                {product.description}
              </p>

              {/* Construction — editorial block */}
              <div className="border-t border-[#E8E5E0] pt-7 mb-7">
                <p className="text-[11px] font-light tracking-[0.14em] uppercase text-[#1A1A1A] mb-5">
                  Construction
                </p>
                <div className="space-y-1.5">
                  {product.constructionDetails?.map((line, i) => (
                    <p key={i} className="text-[14px] font-light text-[#6B6B6B] leading-relaxed">{line}</p>
                  )) ?? (
                    <>
                      {product.specs?.map(s => (
                        <p key={s.label} className="text-[14px] font-light text-[#6B6B6B]">
                          {s.value}.
                        </p>
                      ))}
                    </>
                  )}
                </div>
              </div>

              {/* Shipping & Returns accordion */}
              <div className="border-t border-[#E8E5E0] py-5">
                <details className="group">
                  <summary className="flex items-center justify-between cursor-pointer list-none text-[11px] font-light tracking-[0.14em] uppercase">
                    <span>Shipping & Returns</span>
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"
                      className="transition-transform duration-200 group-open:rotate-180">
                      <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                    </svg>
                  </summary>
                  <div className="mt-4 space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
                    <p>Orders processed within 1–3 business days.</p>
                    <p>Domestic delivery 2–7 business days. International 5–14+ business days.</p>
                    <p>Returns accepted within 14 days of delivery. Items must be unworn and in original condition.</p>
                    <Link href="/support/shipping-returns" className="text-[#1A1A1A] underline underline-offset-2 text-[12px]">
                      Full shipping policy
                    </Link>
                  </div>
                </details>
              </div>

              {/* Complete The Set */}
              {relatedProduct && (
                <div className="border-t border-[#E8E5E0] pt-7">
                  <p className="text-[11px] font-light tracking-[0.14em] uppercase text-[#9B9B9B] mb-5">
                    Complete the Set
                  </p>
                  <div className="flex items-center gap-4">
                    {/* Related product thumbnail */}
                    <Link href={`/products/${relatedProduct.slug}`}
                      className="relative flex-shrink-0 w-16 h-20 bg-[#F0EDE8] overflow-hidden block">
                      {relatedProduct.colors[0]?.images[0]?.src ? (
                        <Image
                          src={relatedProduct.colors[0].images[0].src}
                          alt={relatedProduct.name} fill sizes="64px"
                          className="object-cover" loading="lazy" onError={() => {}}
                        />
                      ) : (
                        <div className="absolute inset-0 bg-[#E8E5E0]" />
                      )}
                    </Link>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-light text-[#1A1A1A] leading-snug mb-0.5">
                        {relatedProduct.name}
                      </p>
                      <p className="text-[13px] font-light text-[#6B6B6B] mb-3">
                        {formatPrice(relatedProduct.price)}
                      </p>
                      <Link href={`/products/${relatedProduct.slug}`}
                        className="inline-flex items-center h-9 px-5 border border-[#1A1A1A] text-[11px] font-light tracking-[0.1em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-all duration-200">
                        {relatedProduct.name.includes('Hoodie') ? 'Add Matching Hoodie' : 'Add Matching Sweatpants'}
                      </Link>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ══════════════════════════════════════════════════════════════
          STICKY ADD-TO-BAG
      ══════════════════════════════════════════════════════════════ */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[200]',
          'bg-white border-t border-[#E8E5E0]',
          'transition-transform duration-300',
          stickyVisible ? 'translate-y-0 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]' : 'translate-y-full'
        )}
        aria-hidden={!stickyVisible}
      >
        <div className="container-kvrn max-w-5xl py-3 flex items-center gap-4">
          <div className="flex-1 min-w-0 flex items-center gap-3">
            <span
              className="w-4 h-4 rounded-full flex-shrink-0 border border-[#E8E5E0]"
              style={{ backgroundColor: selectedColor.hex }}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="text-[12px] font-light text-[#1A1A1A] truncate">{product.name}</p>
              <p className="text-[11px] text-[#9B9B9B]">
                {selectedColor.name}{selectedSize ? ` · ${selectedSize}` : ''}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-shrink-0">
            <span className="text-[13px] font-light tabular-nums hidden sm:block">
              {formatPrice(product.price)}
            </span>
            <button
              disabled={soldOut || addState === 'loading'}
              onClick={handleAdd}
              className={cn(
                'h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase transition-all duration-150 flex-shrink-0',
                soldOut            ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
                : addState === 'added' ? 'bg-[#15803D] text-white'
                : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
              )}
            >
              {soldOut ? t.soldOut : addState === 'added' ? t.addedToBag : t.addToBag}
            </button>
          </div>
        </div>
      </div>

    </div>
  )
}

// ─── Editorial horizontal gallery (Section 2) ─────────────────────────────────
function GallerySection({ images, productName }: { images: any[]; productName: string }) {
  const [active, setActive] = useState(0)
  const [dragging, setDragging] = useState(false)
  const [imgOffset, setImgOffset] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const isHoriz = useRef<boolean | null>(null)
  const mouseStartX = useRef<number | null>(null)
  const mouseDown = useRef(false)

  const go = useCallback((dir: 1 | -1) => {
    setActive(i => Math.max(0, Math.min(images.length - 1, i + dir)))
    setImgOffset(0)
  }, [images.length])

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    isHoriz.current = null
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchStartX.current || !touchStartY.current) return
    const dx = e.touches[0].clientX - touchStartX.current
    const dy = e.touches[0].clientY - touchStartY.current
    if (isHoriz.current === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      isHoriz.current = Math.abs(dx) > Math.abs(dy)
    }
    if (isHoriz.current) { e.preventDefault(); setImgOffset(dx * 0.4); setDragging(true) }
  }
  const onTouchEnd = () => {
    if (isHoriz.current) {
      if (imgOffset < -50) go(1)
      else if (imgOffset > 50) go(-1)
    }
    touchStartX.current = touchStartY.current = null
    isHoriz.current = null
    setDragging(false); setImgOffset(0)
  }
  const onMouseDown = (e: React.MouseEvent) => { mouseStartX.current = e.clientX; mouseDown.current = true }
  const onMouseMove = (e: React.MouseEvent) => {
    if (!mouseDown.current || !mouseStartX.current) return
    const dx = e.clientX - mouseStartX.current
    if (Math.abs(dx) > 5) setDragging(true)
    setImgOffset(dx * 0.35)
  }
  const onMouseUp = (e: React.MouseEvent) => {
    if (!mouseStartX.current) return
    const dx = e.clientX - mouseStartX.current
    if (dx < -60) go(1); else if (dx > 60) go(-1)
    mouseStartX.current = null; mouseDown.current = false
    setDragging(false); setImgOffset(0)
  }
  const onMouseLeave = () => {
    mouseStartX.current = null; mouseDown.current = false
    setDragging(false); setImgOffset(0)
  }

  const current = images[active]

  return (
    <div className="container-kvrn max-w-5xl">
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_auto] gap-6 items-center">

        {/* Main gallery image */}
        <div
          role="region"
          aria-label={`Gallery image ${active + 1} of ${images.length}`}
          onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
          onMouseDown={onMouseDown} onMouseMove={onMouseMove}
          onMouseUp={onMouseUp} onMouseLeave={onMouseLeave}
          className={cn(
            'relative overflow-hidden bg-[#1A1A1A] select-none',
            dragging ? 'cursor-grabbing' : 'cursor-grab'
          )}
          style={{ aspectRatio: '4/5', touchAction: 'pan-y' }}
        >
          {current?.src ? (
            <Image
              key={current.src + active}
              src={current.src}
              alt={current.alt || productName}
              fill sizes="(max-width: 1024px) 100vw, 60vw"
              className="object-cover pointer-events-none"
              loading="lazy"
              onError={() => {}}
              style={{
                transform:  `translateX(${imgOffset}px)`,
                transition: Math.abs(imgOffset) < 3 ? 'transform 0.35s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none',
              }}
            />
          ) : (
            <div className="absolute inset-0 bg-[#2A2A2A]" />
          )}

          {/* Prev/next hint areas */}
          <button onClick={() => go(-1)} aria-label="Previous" disabled={active === 0}
            className={cn('absolute left-0 top-0 bottom-0 w-1/4 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-start pl-4', active === 0 && 'pointer-events-none')}>
            <span className="w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="white" strokeWidth="1.3" strokeLinecap="round"/></svg>
            </span>
          </button>
          <button onClick={() => go(1)} aria-label="Next" disabled={active === images.length - 1}
            className={cn('absolute right-0 top-0 bottom-0 w-1/4 opacity-0 hover:opacity-100 transition-opacity flex items-center justify-end pr-4', active === images.length - 1 && 'pointer-events-none')}>
            <span className="w-8 h-8 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="white" strokeWidth="1.3" strokeLinecap="round"/></svg>
            </span>
          </button>
        </div>

        {/* Vertical numbering indicator — right side */}
        <div className="lg:flex hidden flex-col gap-3 items-center" role="tablist" aria-label="Gallery navigation">
          {images.map((_, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === active}
              onClick={() => setActive(i)}
              className="text-[10px] font-light transition-all duration-300"
              style={{
                color: i === active ? '#F0EDE8' : 'rgba(240,237,232,0.28)',
                letterSpacing: '0.1em',
              }}
            >
              {String(i + 1).padStart(2, '0')}
            </button>
          ))}
        </div>

        {/* Mobile dot indicator */}
        <div className="lg:hidden flex justify-center gap-1.5" aria-hidden="true">
          {images.map((_, i) => (
            <button key={i} onClick={() => setActive(i)}
              className={cn('rounded-full transition-all duration-200', i === active ? 'w-6 h-1 bg-[#F0EDE8]' : 'w-1 h-1 bg-[#F0EDE8]/30')}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
