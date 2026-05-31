'use client'

import {
  useState, useRef, useCallback, useEffect,
  type RefObject,
} from 'react'
import Image from 'next/image'
import Link  from 'next/link'
import { useCart }     from '@/context/CartContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n }     from '@/context/I18nContext'
import { cn }          from '@/lib/utils'
import type { Product, ColorOption, SizeLabel, SizeOption } from '@/types'

// ─── NAV HEIGHTS ─────────────────────────────────────────────────────────────
const NAV_H = 92 // 36px bar + 56px nav

// ─── PROP TYPES ──────────────────────────────────────────────────────────────
interface PDPProps {
  product:        Product
  relatedProduct: Product | null
}

// ═════════════════════════════════════════════════════════════════════════════
//  ROOT COMPONENT
// ═════════════════════════════════════════════════════════════════════════════
export function PDPClient({ product, relatedProduct }: PDPProps) {
  const { addItem, openCart } = useCart()
  const { formatPrice }       = useCurrency()
  const { t }                 = useI18n()

  // ── Selection state ──────────────────────────────────────────────────────
  const [color, setColor]       = useState<ColorOption>(product.colors[0])
  const [size,  setSize]        = useState<SizeLabel | null>(null)
  const [sizeErr, setSizeErr]   = useState(false)
  const [atcState, setAtcState] = useState<'idle'|'adding'|'done'>('idle')

  // ── Snap container controls two stages ───────────────────────────────────
  const snapRef      = useRef<HTMLDivElement>(null)
  const [stage, setStage]       = useState<0|1|2>(0)  // 0=hero 1=gallery 2=details
  const [snapActive, setSnap]   = useState(true)

  // ── Sticky ATC trigger (fires when purchase panel scrolls out) ───────────
  const [stickyOn, setStickyOn] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)

  const soldOut  = !product.sizes.some(s => s.inStock)
  const ctaLabel = soldOut          ? t.soldOut
    : atcState === 'done'           ? t.addedToBag
    : atcState === 'adding'         ? '...'
    : size                          ? t.addToBag
    :                                 t.selectSize

  // ── Body lock while snap is active ───────────────────────────────────────
  useEffect(() => {
    if (snapActive) {
      document.body.style.overflow = 'hidden'
      document.documentElement.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
    }
  }, [snapActive])

  // ── Track snap stage ─────────────────────────────────────────────────────
  useEffect(() => {
    const el = snapRef.current
    if (!el || !snapActive) return
    const onScroll = () => {
      const idx = Math.round(el.scrollTop / el.clientHeight)
      setStage((Math.min(idx, 1)) as 0|1)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [snapActive])

  // ── Sticky ATC observer ───────────────────────────────────────────────────
  useEffect(() => {
    const el = triggerRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setStickyOn(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  // ── Add to bag ────────────────────────────────────────────────────────────
  const handleAdd = useCallback(async (overrideSize?: SizeLabel) => {
    const chosen = overrideSize ?? size
    if (!chosen) { setSizeErr(true); return }
    setSizeErr(false)
    setAtcState('adding')
    const img = color.images.find(i => i.type === 'front')
    addItem({
      productId:   product.id,
      productName: product.name,
      slug:        product.slug,
      color:       color.value,
      colorName:   color.name,
      colorHex:    color.hex,
      size:        chosen,
      price:       product.price,
      quantity:    1,
      image:       img?.src ?? '',
    })
    setAtcState('done')
    setTimeout(() => { setAtcState('idle'); openCart() }, 700)
  }, [size, color, product, addItem, openCart])

  // Add both = add product + related (both in black, size S as default if nothing picked)
  const handleAddBoth = useCallback(() => {
    if (!relatedProduct) return
    const chosen = size ?? 'M'
    const img1 = color.images.find(i => i.type === 'front')
    const img2 = relatedProduct.colors[0]?.images.find(i => i.type === 'front')
    addItem({ productId: product.id,        productName: product.name,        slug: product.slug,
      color: color.value, colorName: color.name, colorHex: color.hex,
      size: chosen, price: product.price, quantity: 1, image: img1?.src ?? '' })
    addItem({ productId: relatedProduct.id, productName: relatedProduct.name, slug: relatedProduct.slug,
      color: relatedProduct.colors[0].value, colorName: relatedProduct.colors[0].name,
      colorHex: relatedProduct.colors[0].hex,
      size: chosen, price: relatedProduct.price, quantity: 1, image: img2?.src ?? '' })
    openCart()
  }, [size, color, product, relatedProduct, addItem, openCart])

  // ── Exit snap → jump to details ───────────────────────────────────────────
  const exitSnap = useCallback(() => {
    setSnap(false)
    setStage(2)
    requestAnimationFrame(() =>
      triggerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    )
  }, [])

  // ── Derived ──────────────────────────────────────────────────────────────
  const heroImage = color.images[0]
  const allImages = color.images

  return (
    <div className="overflow-x-hidden w-full min-h-screen bg-[#F9F8F6]">

      {/* ══════════════════════════════════════════════════════════════════
          SNAP CONTAINER — stage 0 (hero) + stage 1 (gallery)
      ══════════════════════════════════════════════════════════════════ */}
      {snapActive && (
        <div
          ref={snapRef}
          style={{
            position:               'fixed',
            inset:                  0,
            overflowY:              'scroll',
            scrollSnapType:         'y mandatory',
            scrollBehavior:         'smooth',
            WebkitOverflowScrolling:'touch',
            overscrollBehaviorY:    'none',
            overflow:               'hidden scroll',
            zIndex:                 10,
            backgroundColor:        '#F9F8F6',
          }}
        >
          {/* Left-side stage indicator (same as homepage) */}
          <StageIndicator current={stage} total={2} />

          {/* STAGE 0 ── HERO */}
          <HeroSection
            product={product}
            heroImage={heroImage}
            color={color}  setColor={setColor}
            size={size}    setSize={setSize}
            sizeErr={sizeErr} setSizeErr={setSizeErr}
            atcState={atcState} ctaLabel={ctaLabel}
            soldOut={soldOut}
            onAdd={() => handleAdd()}
          />

          {/* STAGE 1 ── GALLERY */}
          <GallerySection
            images={allImages}
            productName={product.name}
            onShop={exitSnap}
          />
        </div>
      )}

      {/* Spacer while snap owns the page */}
      {snapActive && <div style={{ height: '200svh' }} aria-hidden="true" />}

      {/* ══════════════════════════════════════════════════════════════════
          STAGE 2 — DETAILS (normal scroll, always in DOM)
      ══════════════════════════════════════════════════════════════════ */}
      <div ref={triggerRef} />

      <DetailsSection
        product={product}
        relatedProduct={relatedProduct}
        color={color} setColor={setColor}
        size={size}   setSize={setSize}
        sizeErr={sizeErr} setSizeErr={setSizeErr}
        atcState={atcState} ctaLabel={ctaLabel}
        soldOut={soldOut}
        onAdd={() => handleAdd()}
        onAddBoth={handleAddBoth}
        formatPrice={formatPrice}
        t={t}
      />

      {/* ── STICKY ATC ────────────────────────────────────────────────── */}
      <StickyBar
        product={product} color={color} size={size}
        atcState={atcState} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={() => handleAdd()} formatPrice={formatPrice}
        visible={stickyOn} t={t}
      />
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  STAGE INDICATOR (homepage-style left bar)
// ═════════════════════════════════════════════════════════════════════════════
function StageIndicator({ current, total }: { current: number; total: number }) {
  return (
    <div className="fixed left-4 md:left-7 top-1/2 -translate-y-1/2 z-[195] flex flex-col gap-[5px]"
      role="tablist" aria-label="Page position">
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          width: '2px', height: i === current ? '26px' : '10px',
          borderRadius: '1px',
          backgroundColor: i === current ? 'rgba(26,26,26,0.75)' : 'rgba(26,26,26,0.2)',
          transition: 'height 0.45s cubic-bezier(0.25,0.46,0.45,0.94)',
        }} />
      ))}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  STAGE 0 — HERO
// ═════════════════════════════════════════════════════════════════════════════
function HeroSection({ product, heroImage, color, setColor, size, setSize, sizeErr, setSizeErr, atcState, ctaLabel, soldOut, onAdd }: any) {
  return (
    <section
      style={{
        scrollSnapAlign: 'start', scrollSnapStop: 'always',
        height: '100svh', minHeight: '100svh',
        position: 'relative', overflow: 'hidden',
        backgroundColor: '#F9F8F6',
        display: 'grid',
      }}
      className="grid-cols-1 lg:grid-cols-2"
      aria-label={`${product.name} — hero`}
    >
      {/* ── Image column ── */}
      <div className="relative h-[55svh] lg:h-full bg-[#F0EDE8] overflow-hidden">
        {heroImage?.src ? (
          <Image
            src={heroImage.src}
            alt={heroImage.alt || product.name}
            fill priority fetchPriority="high"
            sizes="(max-width: 1024px) 100vw, 50vw"
            className="object-cover object-[center_20%]"
            quality={92}
            onError={() => {}}
          />
        ) : (
          <div className="absolute inset-0 bg-[#E8E5E0]" />
        )}
      </div>

      {/* ── Info column ── */}
      <div
        className="flex flex-col justify-between bg-[#F9F8F6] overflow-y-auto"
        style={{ paddingTop: NAV_H + 32, paddingBottom: 48 }}
      >
        <div className="px-8 md:px-10 lg:px-14 space-y-7">

          {/* Eyebrow */}
          <p className="text-[10px] font-light tracking-[0.22em] uppercase text-[#9B9B9B]">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>

          {/* Title + price */}
          <div>
            <h1 className="font-display font-light text-[28px] md:text-[36px] leading-[0.92] tracking-[-0.025em] text-[#1A1A1A] mb-4">
              {product.name}
            </h1>
            <div className="flex items-baseline gap-3">
              <span className="text-[22px] font-light tabular-nums text-[#1A1A1A]">
                $80
              </span>
              {product.founderNote && (
                <span className="text-[11px] text-[#9B9B9B]">{product.founderNote}</span>
              )}
            </div>
          </div>

          {/* Specs */}
          <div className="space-y-1 border-t border-[#E8E5E0] pt-5">
            {(product.constructionDetails ?? []).slice(0, 4).map((line: string, i: number) => (
              <p key={i} className="text-[13px] font-light text-[#6B6B6B] leading-relaxed">{line}</p>
            ))}
          </div>

          {/* Color selector */}
          {product.colors.length > 1 && (
            <div>
              <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-3">
                Color — {color.name}
              </p>
              <div className="flex gap-2.5 flex-wrap">
                {product.colors.map((c: ColorOption) => (
                  <button key={c.value} title={c.name} aria-label={c.name}
                    aria-pressed={c.value === color.value}
                    onClick={() => setColor(c)}
                    className={cn('w-7 h-7 rounded-full transition-all duration-150',
                      c.value === color.value
                        ? 'ring-2 ring-[#1A1A1A] ring-offset-2 ring-offset-[#F9F8F6]'
                        : 'hover:ring-1 hover:ring-[#C8C4BF] hover:ring-offset-1 hover:ring-offset-[#F9F8F6]')}
                    style={{ backgroundColor: c.hex }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Size selector */}
          <div>
            <p className={cn('text-[10px] font-light tracking-[0.1em] uppercase mb-3',
              sizeErr ? 'text-[#B91C1C]' : 'text-[#9B9B9B]')}>
              {sizeErr ? 'Please select a size' : 'Size'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {product.sizes.map((s: SizeOption) => (
                <button key={s.value} disabled={!s.inStock}
                  onClick={() => { setSize(s.label); setSizeErr(false) }}
                  className={cn(
                    'h-10 w-11 text-[12px] font-light border transition-all duration-150',
                    !s.inStock
                      ? 'border-[#E8E5E0] text-[#C8C4BF] cursor-not-allowed'
                      : size === s.label
                      ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                      : 'border-[#D5D1CB] text-[#1A1A1A] hover:border-[#1A1A1A]'
                  )}>
                  {s.label}
                </button>
              ))}
            </div>
            {product.fitNote && (
              <p className="text-[11px] text-[#9B9B9B] mt-2 leading-relaxed">{product.fitNote}</p>
            )}
          </div>

          {/* CTA */}
          <button
            disabled={soldOut || atcState === 'adding'}
            onClick={onAdd}
            className={cn(
              'w-full h-12 text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
              soldOut ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : atcState === 'done' ? 'bg-[#15803D] text-white'
              : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
            )}>
            {ctaLabel}
          </button>
        </div>

        {/* Scroll cue */}
        <div className="px-8 md:px-10 lg:px-14 flex items-center gap-2 opacity-30" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 3v6M4.5 7l2.5 2.5L9.5 7" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[10px] font-light tracking-[0.16em] uppercase text-[#1A1A1A]">Scroll to explore</span>
        </div>
      </div>
    </section>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  STAGE 1 — GALLERY
// ═════════════════════════════════════════════════════════════════════════════
function GallerySection({ images, productName, onShop }: {
  images: any[]; productName: string; onShop: () => void
}) {
  const [active,    setActive]    = useState(0)
  const [offset,    setOffset]    = useState(0)
  const [dragging,  setDragging]  = useState(false)
  const txX    = useRef<number | null>(null)
  const txY    = useRef<number | null>(null)
  const horiz  = useRef<boolean | null>(null)
  const mxDown = useRef(false)
  const mxX    = useRef<number | null>(null)
  const total  = images.length

  const go = useCallback((dir: 1 | -1) => {
    setActive(i => Math.max(0, Math.min(total - 1, i + dir)))
    setOffset(0)
  }, [total])

  const onTS = (e: React.TouchEvent) => {
    txX.current = e.touches[0].clientX
    txY.current = e.touches[0].clientY
    horiz.current = null
  }
  const onTM = (e: React.TouchEvent) => {
    if (!txX.current || !txY.current) return
    const dx = e.touches[0].clientX - txX.current
    const dy = e.touches[0].clientY - txY.current
    if (horiz.current === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5))
      horiz.current = Math.abs(dx) > Math.abs(dy)
    if (horiz.current) { e.preventDefault(); setOffset(dx * 0.45); setDragging(true) }
  }
  const onTE = () => {
    if (horiz.current) { if (offset < -55) go(1); else if (offset > 55) go(-1) }
    txX.current = txY.current = null; horiz.current = null
    setDragging(false); setOffset(0)
  }
  const onMD = (e: React.MouseEvent) => { mxX.current = e.clientX; mxDown.current = true }
  const onMM = (e: React.MouseEvent) => {
    if (!mxDown.current || !mxX.current) return
    const dx = e.clientX - mxX.current
    if (Math.abs(dx) > 5) setDragging(true)
    setOffset(dx * 0.4)
  }
  const onMU = (e: React.MouseEvent) => {
    if (!mxX.current) return
    const dx = e.clientX - mxX.current
    if (dx < -65) go(1); else if (dx > 65) go(-1)
    mxX.current = null; mxDown.current = false; setDragging(false); setOffset(0)
  }
  const onML = () => { mxX.current = null; mxDown.current = false; setDragging(false); setOffset(0) }

  const cur = images[active]

  return (
    <section
      style={{
        scrollSnapAlign: 'start', scrollSnapStop: 'always',
        height: '100svh', minHeight: '100svh', maxHeight: '100svh',
        position: 'relative', overflow: 'hidden',
        backgroundColor: '#F9F8F6',
        display: 'flex', flexDirection: 'column',
      }}
      aria-label={`${productName} — gallery`}
    >
      {/* Image area */}
      <div
        role="region" aria-label={`Image ${active + 1} of ${total}`}
        onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE}
        onMouseDown={onMD}  onMouseMove={onMM} onMouseUp={onMU} onMouseLeave={onML}
        className={cn('flex-1 relative overflow-hidden select-none min-h-0',
          dragging ? 'cursor-grabbing' : 'cursor-grab')}
        style={{ touchAction: 'pan-y' }}
      >
        {cur?.src ? (
          <Image
            key={cur.src + active}
            src={cur.src} alt={cur.alt || productName} fill
            sizes="100vw" className="object-contain object-center pointer-events-none"
            loading="lazy" onError={() => {}}
            style={{
              transform: `translateX(${offset}px)`,
              transition: Math.abs(offset) < 3 ? 'transform 0.4s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none',
            }}
          />
        ) : (
          <div className="absolute inset-0 bg-[#E8E5E0]" />
        )}

        {/* Prev / Next buttons */}
        {active > 0 && (
          <button onClick={() => go(-1)} aria-label="Previous"
            className="absolute left-4 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full border border-[#D5D1CB] bg-white/80 backdrop-blur-sm flex items-center justify-center hover:border-[#1A1A1A] transition-colors">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M7 1L3 5l4 4" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/></svg>
          </button>
        )}
        {active < total - 1 && (
          <button onClick={() => go(1)} aria-label="Next"
            className="absolute right-4 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full border border-[#D5D1CB] bg-white/80 backdrop-blur-sm flex items-center justify-center hover:border-[#1A1A1A] transition-colors">
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1l4 4-4 4" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/></svg>
          </button>
        )}
      </div>

      {/* Bottom bar — counter + thumbnails + shop CTA */}
      <div className="flex-shrink-0 border-t border-[#E8E5E0] bg-[#F9F8F6]">
        <div className="container-kvrn py-4 flex items-center justify-between gap-6">

          {/* Luxury counter */}
          <span className="text-[13px] font-light tabular-nums text-[#9B9B9B] flex-shrink-0 tracking-[0.06em]">
            {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
          </span>

          {/* Thumbnail strip */}
          <div className="flex gap-1.5 overflow-x-auto flex-1 justify-center" aria-label="Gallery thumbnails">
            {images.map((img: any, i: number) => (
              <button key={i} onClick={() => setActive(i)} aria-label={`Image ${i + 1}`}
                className={cn(
                  'relative flex-shrink-0 w-10 h-[52px] overflow-hidden transition-all duration-200',
                  i === active ? 'ring-1 ring-[#1A1A1A]' : 'opacity-35 hover:opacity-70'
                )}>
                {img.src
                  ? <Image src={img.src} alt="" fill sizes="40px" className="object-cover" loading="lazy" onError={() => {}} />
                  : <div className="absolute inset-0 bg-[#E8E5E0]" />}
              </button>
            ))}
          </div>

          {/* Shop CTA */}
          <button onClick={onShop}
            className="flex-shrink-0 flex items-center gap-2 text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
            <span>Shop</span>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M6 2v6M3.5 6l2.5 2.5L8.5 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </section>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  STAGE 2 — DETAILS
// ═════════════════════════════════════════════════════════════════════════════
function DetailsSection({
  product, relatedProduct,
  color, setColor, size, setSize, sizeErr, setSizeErr,
  atcState, ctaLabel, soldOut, onAdd, onAddBoth,
  formatPrice, t,
}: any) {
  return (
    <div className="bg-[#F9F8F6]">
      <div className="container-kvrn max-w-3xl py-16 md:py-20">

        {/* Header */}
        <div className="mb-10">
          <p className="text-[10px] font-light tracking-[0.2em] uppercase text-[#9B9B9B] mb-3">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>
          <h2 className="font-display font-light text-[28px] md:text-[36px] leading-tight tracking-[-0.025em] text-[#1A1A1A] mb-3">
            {product.name}
          </h2>
          <div className="flex items-baseline gap-3">
            <span className="text-[22px] font-light tabular-nums">$80</span>
            {product.founderNote && (
              <span className="text-[11px] text-[#9B9B9B]">{product.founderNote}</span>
            )}
          </div>
        </div>

        {/* Color */}
        {product.colors.length > 1 && (
          <div className="mb-7">
            <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-3">
              Color — {color.name}
            </p>
            <div className="flex gap-2.5 flex-wrap">
              {product.colors.map((c: ColorOption) => (
                <button key={c.value} title={c.name} aria-label={c.name}
                  aria-pressed={c.value === color.value}
                  onClick={() => setColor(c)}
                  className={cn('w-7 h-7 rounded-full transition-all',
                    c.value === color.value
                      ? 'ring-2 ring-[#1A1A1A] ring-offset-2 ring-offset-[#F9F8F6]'
                      : 'hover:ring-1 hover:ring-[#C8C4BF] hover:ring-offset-1 hover:ring-offset-[#F9F8F6]')}
                  style={{ backgroundColor: c.hex }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Size */}
        <div className="mb-7">
          <div className="flex items-center justify-between mb-3">
            <p className={cn('text-[10px] font-light tracking-[0.1em] uppercase',
              sizeErr ? 'text-[#B91C1C]' : 'text-[#9B9B9B]')}>
              {sizeErr ? 'Please select a size' : 'Size'}
            </p>
            <Link href="/support/size-guide"
              className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
              Size guide
            </Link>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {product.sizes.map((s: SizeOption) => (
              <button key={s.value} disabled={!s.inStock}
                onClick={() => { setSize(s.label); setSizeErr(false) }}
                className={cn(
                  'h-10 w-11 text-[12px] font-light border transition-all duration-150',
                  !s.inStock
                    ? 'border-[#E8E5E0] text-[#C8C4BF] cursor-not-allowed line-through'
                    : size === s.label
                    ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                    : 'border-[#D5D1CB] text-[#1A1A1A] hover:border-[#1A1A1A]'
                )}>
                {s.label}
              </button>
            ))}
          </div>
          {product.fitNote && (
            <p className="text-[11px] text-[#9B9B9B] mt-2 leading-relaxed">{product.fitNote}</p>
          )}
        </div>

        {/* CTAs */}
        <div className="flex flex-col gap-2 mb-10">
          <button disabled={soldOut || atcState === 'adding'} onClick={onAdd}
            className={cn(
              'h-12 text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
              soldOut ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : atcState === 'done' ? 'bg-[#15803D] text-white'
              : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
            )}>
            {ctaLabel}
          </button>
        </div>

        {/* Description */}
        <div className="border-t border-[#E8E5E0] pt-8 mb-0">
          <p className="text-[14px] text-[#6B6B6B] leading-relaxed">{product.description}</p>
        </div>

        {/* Construction */}
        <div className="border-t border-[#E8E5E0] mt-8 pt-8">
          <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] mb-5">Construction</p>
          <div className="space-y-1">
            {(product.constructionDetails ?? []).map((line: string, i: number) => (
              <p key={i} className="text-[14px] font-light text-[#6B6B6B]">{line}</p>
            ))}
          </div>
        </div>

        {/* Shipping & Returns */}
        <div className="border-t border-[#E8E5E0] mt-8">
          <details className="group">
            <summary className="flex items-center justify-between py-5 cursor-pointer list-none text-[10px] font-light tracking-[0.16em] uppercase">
              <span>Shipping & Returns</span>
              <svg width="11" height="7" viewBox="0 0 11 7" fill="none"
                className="transition-transform duration-200 group-open:rotate-180 flex-shrink-0">
                <path d="M1 1l4.5 4.5L10 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </summary>
            <div className="pb-5 space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
              <p>Orders processed within 1–3 business days.</p>
              <p>US: 2–7 days. International: 5–14+ days.</p>
              <p>Returns accepted within 14 days, unworn and in original condition.</p>
              <Link href="/support/shipping-returns"
                className="block text-[#1A1A1A] underline underline-offset-2 text-[12px] hover:opacity-60 transition-opacity mt-2">
                Full policy →
              </Link>
            </div>
          </details>
        </div>

        {/* Complete the Set */}
        {relatedProduct && (
          <CompleteTheSet
            product={product}
            relatedProduct={relatedProduct}
            onAddBoth={onAddBoth}
            formatPrice={formatPrice}
          />
        )}
      </div>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  COMPLETE THE SET
// ═════════════════════════════════════════════════════════════════════════════
function CompleteTheSet({ product, relatedProduct, onAddBoth, formatPrice }: any) {
  const img1 = product.colors[0]?.images.find((i: any) => i.type === 'front') ?? product.colors[0]?.images[0]
  const img2 = relatedProduct.colors[0]?.images.find((i: any) => i.type === 'front') ?? relatedProduct.colors[0]?.images[0]
  const total = product.price + relatedProduct.price

  return (
    <div className="border-t border-[#E8E5E0] mt-8 pt-8">
      <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] mb-6">
        Complete the Set
      </p>

      {/* Two product images side by side */}
      <div className="grid grid-cols-2 gap-3 mb-6">
        {/* Product A */}
        <div>
          <div className="relative aspect-[3/4] bg-[#F0EDE8] overflow-hidden mb-3">
            {img1?.src
              ? <Image src={img1.src} alt={product.name} fill sizes="(max-width: 768px) 50vw, 25vw"
                  className="object-cover" loading="lazy" onError={() => {}} />
              : <div className="absolute inset-0 bg-[#E8E5E0]" />}
          </div>
          <p className="text-[12px] font-light text-[#1A1A1A] leading-snug">{product.name}</p>
          <p className="text-[12px] font-light text-[#9B9B9B] tabular-nums">$80</p>
        </div>

        {/* Product B */}
        <div>
          <div className="relative aspect-[3/4] bg-[#F0EDE8] overflow-hidden mb-3">
            {img2?.src
              ? <Image src={img2.src} alt={relatedProduct.name} fill sizes="(max-width: 768px) 50vw, 25vw"
                  className="object-cover" loading="lazy" onError={() => {}} />
              : <div className="absolute inset-0 bg-[#E8E5E0]" />}
          </div>
          <p className="text-[12px] font-light text-[#1A1A1A] leading-snug">{relatedProduct.name}</p>
          <p className="text-[12px] font-light text-[#9B9B9B] tabular-nums">$80</p>
        </div>
      </div>

      {/* Description */}
      <p className="text-[13px] text-[#6B6B6B] leading-relaxed mb-5">
        Same fabric. Same weight. Designed to be worn together.
      </p>

      {/* Add both CTA */}
      <button
        onClick={onAddBoth}
        className="w-full h-12 border border-[#1A1A1A] text-[11px] font-light tracking-[0.14em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-all duration-200 flex items-center justify-center gap-2">
        <span>Add Both to Bag</span>
        <span className="text-[#9B9B9B] group-hover:text-white">— $160</span>
      </button>

      <Link href={`/products/${relatedProduct.slug}`}
        className="block text-center text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors mt-3 underline underline-offset-2">
        View {relatedProduct.name.includes('Hoodie') ? 'Hoodie' : 'Sweatpants'} separately
      </Link>
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  STICKY ATC BAR
// ═════════════════════════════════════════════════════════════════════════════
function StickyBar({ product, color, size, atcState, ctaLabel, soldOut, onAdd, formatPrice, visible, t }: any) {
  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 z-[200] overflow-hidden',
        'bg-white border-t border-[#E8E5E0]',
        'transition-transform duration-300',
        visible
          ? 'translate-y-0 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]'
          : 'translate-y-full'
      )}
      aria-hidden={!visible}
    >
      <div className="container-kvrn max-w-3xl py-3 flex items-center gap-4">
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <span className="w-4 h-4 rounded-full flex-shrink-0 border border-[#E8E5E0]"
            style={{ backgroundColor: color.hex }} aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[12px] font-light text-[#1A1A1A] truncate leading-tight">{product.name}</p>
            <p className="text-[11px] text-[#9B9B9B] mt-0.5">{color.name}{size ? ` · ${size}` : ''}</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-[13px] font-light tabular-nums hidden sm:block">$80</span>
          <button disabled={soldOut || atcState === 'adding'} onClick={onAdd}
            className={cn(
              'h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase transition-all',
              soldOut ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : atcState === 'done' ? 'bg-[#15803D] text-white'
              : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
            )}>
            {soldOut ? t.soldOut : atcState === 'done' ? t.addedToBag : t.addToBag}
          </button>
        </div>
      </div>
    </div>
  )
}
