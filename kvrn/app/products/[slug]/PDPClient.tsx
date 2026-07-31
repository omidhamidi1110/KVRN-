'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import Link  from 'next/link'
import { useCart }     from '@/context/CartContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n }     from '@/context/I18nContext'
import { cn }          from '@/lib/utils'
import type { Product, ColorOption, SizeLabel, SizeOption } from '@/types'

const NAV = 92 // announcement bar (36) + nav (56)

interface Props { product: Product; relatedProduct: Product | null }

// ════════════════════════════════════════════════════════════════════════════
export function PDPClient({ product, relatedProduct }: Props) {
  const { addItem, openCart } = useCart()
  const { formatPrice }       = useCurrency()
  const { t }                 = useI18n()

  const [color,   setColor]   = useState<ColorOption>(product.colors[0])
  const [size,    setSize]    = useState<SizeLabel | null>(null)
  const [sizeErr, setSizeErr] = useState(false)
  const [cta,     setCta]     = useState<'idle'|'busy'|'done'>('idle')
  const [snapOn,  setSnapOn]  = useState(true)
  const [stage,   setStage]   = useState<0|1>(0)
  const [sticky,  setSticky]  = useState(false)

  const snapRef   = useRef<HTMLDivElement>(null)
  const detailRef = useRef<HTMLDivElement>(null)

  const soldOut  = !product.sizes.some(s => s.inStock)
  const ctaLabel = soldOut         ? t.soldOut
    : cta === 'done'               ? t.addedToBag
    : cta === 'busy'               ? '...'
    : size                         ? t.addToBag
    :                                t.selectSize

  // Lock body while snap active
  useEffect(() => {
    document.body.style.overflow = snapOn ? 'hidden' : ''
    document.documentElement.style.overflow = snapOn ? 'hidden' : ''
    return () => {
      document.body.style.overflow = ''
      document.documentElement.style.overflow = ''
    }
  }, [snapOn])

  // Track snap stage + fire nav color events
  useEffect(() => {
    const el = snapRef.current
    if (!el || !snapOn) return
    const fn = () => {
      const idx = Math.round(el.scrollTop / el.clientHeight) as 0|1
      setStage(idx)
      // Stage 0 (hero): light bg → dark text nav. Stage 1 (gallery): dark bg → white text nav.
      window.dispatchEvent(new CustomEvent('kvrn-slide-change', {
        detail: { dark: idx === 1 }  // gallery is dark bg
      }))
    }
    el.addEventListener('scroll', fn, { passive: true })
    // Fire immediately for initial state (hero has light bg → dark nav)
    window.dispatchEvent(new CustomEvent('kvrn-slide-change', { detail: { dark: false } }))
    return () => el.removeEventListener('scroll', fn)
  }, [snapOn])

  // Sticky ATC: only after snap is done AND stage 3 trigger passes viewport
  useEffect(() => {
    const el = detailRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => {
      setSticky(!e.isIntersecting && !snapOn)
    }, { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [snapOn])

  const addOne = useCallback(async (s?: SizeLabel) => {
    const chosen = s ?? size
    if (!chosen) { setSizeErr(true); return }
    setSizeErr(false); setCta('busy')
    addItem({ productId: product.id, productName: product.name, slug: product.slug,
      color: color.value, colorName: color.name, colorHex: color.hex, size: chosen,
      price: product.price, quantity: 1,
      image: color.images.find(i => i.type === 'front')?.src ?? '' })
    setCta('done')
    setTimeout(() => { setCta('idle'); openCart() }, 700)
  }, [size, color, product, addItem, openCart])

  const addBoth = useCallback(() => {
    if (!relatedProduct) return
    const s = size ?? 'M'
    addItem({ productId: product.id, productName: product.name, slug: product.slug,
      color: color.value, colorName: color.name, colorHex: color.hex, size: s,
      price: product.price, quantity: 1,
      image: color.images.find(i => i.type === 'front')?.src ?? '' })
    addItem({ productId: relatedProduct.id, productName: relatedProduct.name,
      slug: relatedProduct.slug,
      color: relatedProduct.colors[0].value, colorName: relatedProduct.colors[0].name,
      colorHex: relatedProduct.colors[0].hex, size: s, price: relatedProduct.price, quantity: 1,
      image: relatedProduct.colors[0].images.find(i => i.type === 'front')?.src ?? '' })
    openCart()
  }, [size, color, product, relatedProduct, addItem, openCart])

  const exitSnap = useCallback(() => {
    document.body.style.overflow = ''
    document.documentElement.style.overflow = ''
    setSnapOn(false)
    // Stage 3 is light bg — switch nav to dark text
    window.dispatchEvent(new CustomEvent('kvrn-slide-change', { detail: { dark: false } }))
    setTimeout(() => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50)
  }, [])

  const imgs = color.images

  return (
    <div className="overflow-x-hidden w-full bg-[#F9F8F6]">

      {/* ── Snap container: Stage 1 + Stage 2 ─────────────────────────── */}
      {snapOn && (
        <div ref={snapRef} style={{
          position: 'fixed', inset: 0, zIndex: 10,
          overflowY: 'scroll', overflow: 'hidden scroll',
          scrollSnapType: 'y mandatory', scrollBehavior: 'smooth',
          WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'none',
          backgroundColor: '#F9F8F6',
        }}>
          <SnapIndicator stage={stage} />

          {/* STAGE 1 — HERO */}
          <HeroStage
            product={product}
            heroImage={imgs[0]}
            mobileImages={imgs}
            color={color} setColor={setColor}
            size={size} setSize={setSize}
            sizeErr={sizeErr} setSizeErr={setSizeErr}
            cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
            onAdd={() => addOne()}
          />

          {/* STAGE 2 — GALLERY */}
          <GalleryStage
            images={imgs}
            productName={product.name}
            onShop={exitSnap}
          />
        </div>
      )}
      {snapOn && <div style={{ height: '200svh' }} aria-hidden="true" />}

      {/* ── Stage 3: Details (normal scroll) ────────────────────────────── */}
      <div ref={detailRef} />
      <DetailsStage
        product={product} relatedProduct={relatedProduct}
        color={color} setColor={setColor}
        size={size} setSize={setSize}
        sizeErr={sizeErr} setSizeErr={setSizeErr}
        cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={() => addOne()} onAddBoth={addBoth}
        formatPrice={formatPrice} t={t}
      />

      {/* ── Sticky ATC: Stage 3 only ─────────────────────────────────────── */}
      <StickyATC
        product={product} color={color} size={size}
        cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={() => addOne()} t={t} visible={sticky}
      />
    </div>
  )
}

// ─── Snap stage indicator (homepage style) ────────────────────────────────────
function SnapIndicator({ stage }: { stage: 0|1 }) {
  return (
    <div className="fixed left-4 md:left-7 top-1/2 -translate-y-1/2 z-[195] flex flex-col gap-[5px]"
      aria-hidden="true">
      {[0, 1].map(i => (
        <div key={i} style={{
          width: '2px', borderRadius: '1px',
          height: i === stage ? '26px' : '10px',
          backgroundColor: i === stage ? 'rgba(26,26,26,0.65)' : 'rgba(26,26,26,0.17)',
          transition: 'height 0.45s cubic-bezier(0.25,0.46,0.45,0.94)',
        }} />
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  STAGE 1 — HERO
//
//  DESKTOP: Single first image on left (full bleed, no swipe).
//           Product info panel on right. Side-by-side, both fill 100svh.
//
//  MOBILE:  Swipeable images on top (58svh). Static info panel below.
//           Info panel never moves. Only image changes on swipe.
//           Counter 01/05 shows on image.
// ════════════════════════════════════════════════════════════════════════════
function HeroStage({ product, heroImage, mobileImages, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd }: any) {
  // Stage 1: single hero image only — no swipe, no carousel
  // All images shown in Stage 2 (GalleryStage)
  return (
    <section
      aria-label={product.name}
      className="flex flex-col lg:flex-row"
      style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always',
               height: '100svh', minHeight: '100svh', overflow: 'hidden',
               // Mobile: dark bg so no light bleed; desktop: cream handled by panel
               backgroundColor: '#0E0E0E' }}
    >
      {/* ══ IMAGE AREA ══════════════════════════════════════════════════ */}

      {/* DESKTOP: single static hero image — no swipe, no counter */}
      <div className="hidden lg:block relative flex-shrink-0 bg-[#EDEAE4] w-[62%] h-full overflow-hidden">
        {heroImage?.src ? (
          <Image
            src={heroImage.src}
            alt={heroImage.alt || product.name}
            fill priority fetchPriority="high"
            sizes="62vw"
            className="object-cover object-[center_15%]"
            quality={92}
            onError={() => {}}
          />
        ) : (
          <div className="absolute inset-0 bg-[#DDD9D2]" />
        )}
        {/* Preload next gallery image invisibly for smooth Stage 2 transition */}
        {mobileImages?.[1]?.src && (
          <Image src={mobileImages[1].src} alt="" fill
            sizes="62vw" className="opacity-0 pointer-events-none absolute" loading="eager"
            onError={() => {}} />
        )}
      </div>

      {/* MOBILE: static single first image — NO swipe. Stage 2 has the gallery. */}
      <div className="lg:hidden absolute inset-0 bg-[#0E0E0E] overflow-hidden">
        {heroImage?.src ? (
          <Image
            src={heroImage.src}
            alt={heroImage.alt || product.name}
            fill priority fetchPriority="high"
            sizes="100vw"
            className="object-cover object-[center_15%] pointer-events-none"
            quality={92}
            onError={() => {}}
          />
        ) : (
          <div className="absolute inset-0 bg-[#1A1A1A]" />
        )}
        {/* Preload first gallery images for smooth Stage 2 transition */}
        {mobileImages?.[0]?.src && (
          <Image src={mobileImages[0].src} alt="" fill sizes="100vw"
            className="opacity-0 absolute pointer-events-none" loading="eager" onError={() => {}} />
        )}
        {mobileImages?.[1]?.src && (
          <Image src={mobileImages[1].src} alt="" fill sizes="100vw"
            className="opacity-0 absolute pointer-events-none" loading="eager" onError={() => {}} />
        )}
      </div>

      {/* ══ MOBILE: gradient overlay + info at bottom of full-screen hero ══ */}
      {/* This is absolute-positioned, only visible on mobile */}
      {/* Gradient: covers the whole lower section where text lives */}
      <div className="lg:hidden absolute inset-x-0 bottom-0 z-10 pointer-events-none"
        style={{
          height: '75%',
          background: 'linear-gradient(to top, rgba(0,0,0,0.92) 0%, rgba(0,0,0,0.72) 30%, rgba(0,0,0,0.35) 60%, transparent 100%)',
        }}
        aria-hidden="true"
      />
      <div className="lg:hidden absolute inset-x-0 bottom-0 z-20 px-6 pb-7"
        style={{ pointerEvents: 'auto' }}>
        <MobileHeroInfo
          product={product}
          color={color} setColor={setColor}
          size={size} setSize={setSize}
          sizeErr={sizeErr} setSizeErr={setSizeErr}
          cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
          onAdd={onAdd}
        />
      </div>

      {/* ══ DESKTOP INFO PANEL — right column, hidden on mobile ══ */}
      <div className="hidden lg:flex flex-1 flex-col overflow-y-auto bg-[#F9F8F6]">
        <div className="flex-shrink-0" style={{ height: NAV + 24 }} />

        <div className="flex-1 flex flex-col justify-between px-6 py-4 lg:px-14 lg:py-0 lg:pb-12">

          {/* TOP: identity + details */}
          <div className="space-y-4 lg:space-y-5">
            <p className="text-[10px] font-light tracking-[0.22em] uppercase text-[#9B9B9B]">
              {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
            </p>

            <div>
              <h1 className="font-display font-light leading-[0.9] tracking-[-0.025em] text-[#1A1A1A] mb-2.5
                             text-[21px] lg:text-[clamp(22px,2.2vw,36px)]">
                {product.name}
              </h1>
              <div className="flex items-baseline gap-2">
                <span className="text-[19px] lg:text-[22px] font-light tabular-nums text-[#1A1A1A]">$80</span>
                {product.founderNote && (
                  <span className="text-[11px] text-[#9B9B9B] font-light">{product.founderNote}</span>
                )}
              </div>
            </div>

            <div className="border-t border-[#E8E5E0] pt-3.5 space-y-0.5">
              {(product.constructionDetails ?? []).slice(0, 3).map((l: string, i: number) => (
                <p key={i} className="text-[12px] font-light text-[#6B6B6B] leading-relaxed">{l}</p>
              ))}
            </div>

            {product.colors.length > 1 && (
              <div className="flex items-center gap-2 flex-wrap">
                {product.colors.map((c: ColorOption) => (
                  <button key={c.value} title={c.name} aria-label={c.name}
                    aria-pressed={c.value === color.value}
                    onClick={() => setColor(c)}
                    className={cn('w-5 h-5 rounded-full transition-all',
                      c.value === color.value
                        ? 'ring-2 ring-[#1A1A1A] ring-offset-2 ring-offset-[#F9F8F6]'
                        : 'hover:ring-1 hover:ring-[#BBB] hover:ring-offset-1')}
                    style={{ backgroundColor: c.hex }} />
                ))}
                <span className="text-[11px] text-[#9B9B9B]">{color.name}</span>
              </div>
            )}

            <div>
              <p className={cn('text-[10px] font-light tracking-[0.1em] uppercase mb-2',
                sizeErr ? 'text-[#B91C1C]' : 'text-[#9B9B9B]')}>
                {sizeErr ? 'Select a size' : 'Size'}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {product.sizes.map((s: SizeOption) => (
                  <button key={s.value} disabled={!s.inStock}
                    onClick={() => { setSize(s.label); setSizeErr(false) }}
                    className={cn('h-9 w-10 text-[11px] font-light border transition-all',
                      !s.inStock ? 'border-[#E8E5E0] text-[#C8C4BF] cursor-not-allowed'
                      : size === s.label ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                      : 'border-[#D5D1CB] text-[#1A1A1A] hover:border-[#1A1A1A]')}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* BOTTOM: CTA + scroll cue */}
          <div className="space-y-3 mt-4">
            <button disabled={soldOut || cta === 'busy'} onClick={onAdd}
              className={cn('w-full h-11 text-[11px] font-light tracking-[0.14em] uppercase transition-all',
                soldOut         ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
                : cta === 'done' ? 'bg-[#15803D] text-white'
                :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
              {ctaLabel}
            </button>
            <div className="flex items-center gap-1.5 opacity-25" aria-hidden="true">
              <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
                <path d="M5.5 2v5M3 5.5l2.5 2.5L8 5.5" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              <span className="text-[10px] font-light tracking-[0.14em] uppercase text-[#1A1A1A]">Explore</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ─── Mobile hero info overlay ─────────────────────────────────────────────────
function MobileHeroInfo({ product, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd }: any) {
  const shadow = '0 1px 8px rgba(0,0,0,0.5)'
  return (
    <div className="space-y-3">
      {/* Eyebrow */}
      <p className="text-[10px] font-light tracking-[0.2em] uppercase text-white/60"
        style={{ textShadow: shadow }}>
        {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
      </p>
      {/* Title + price */}
      <div>
        <h1 className="font-display font-light text-[24px] leading-[0.92] tracking-[-0.025em] text-white mb-1.5"
          style={{ textShadow: shadow }}>
          {product.name}
        </h1>
        <p className="text-[18px] font-light tabular-nums text-white"
          style={{ textShadow: shadow }}>$80</p>
      </div>
      {/* Specs — 2 lines max on mobile */}
      <div className="space-y-0.5">
        {(product.constructionDetails ?? []).slice(0, 2).map((l: string, i: number) => (
          <p key={i} className="text-[12px] font-light text-white/70 leading-snug"
            style={{ textShadow: shadow }}>{l}</p>
        ))}
      </div>
      {/* Color swatches */}
      {product.colors.length > 1 && (
        <div className="flex items-center gap-2">
          {product.colors.map((c: any) => (
            <button key={c.value} title={c.name} aria-label={c.name}
              aria-pressed={c.value === color.value}
              onClick={() => setColor(c)}
              className={c.value === color.value
                ? 'w-5 h-5 rounded-full ring-2 ring-white ring-offset-1 ring-offset-transparent'
                : 'w-5 h-5 rounded-full opacity-60 hover:opacity-90 transition-opacity'}
              style={{ backgroundColor: c.hex }} />
          ))}
          <span className="text-[11px] text-white/50">{color.name}</span>
        </div>
      )}
      {/* Size */}
      <div>
        <p className={`text-[10px] font-light tracking-[0.1em] uppercase mb-1.5 ${sizeErr ? 'text-[#FF8080]' : 'text-white/60'}`}
          style={{ textShadow: shadow }}>
          {sizeErr ? 'Select a size' : 'Size'}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {product.sizes.map((s: any) => (
            <button key={s.value} disabled={!s.inStock}
              onClick={() => { setSize(s.label); setSizeErr(false) }}
              className={
                !s.inStock
                  ? 'h-9 w-10 text-[11px] font-light border border-white/10 text-white/20 cursor-not-allowed'
                  : size === s.label
                  ? 'h-9 w-10 text-[11px] font-light bg-white text-[#0E0E0E]'
                  : 'h-9 w-10 text-[11px] font-light border border-white/35 text-white hover:border-white transition-colors'
              }>
              {s.label}
            </button>
          ))}
        </div>
      </div>
      {/* CTA */}
      <button disabled={soldOut || cta === 'busy'} onClick={onAdd}
        className={
          soldOut ? 'w-full h-11 text-[11px] font-light tracking-[0.14em] uppercase bg-white/10 text-white/30 cursor-not-allowed'
          : cta === 'done' ? 'w-full h-11 text-[11px] font-light tracking-[0.14em] uppercase bg-[#15803D] text-white'
          : 'w-full h-11 text-[11px] font-light tracking-[0.14em] uppercase bg-white text-[#0E0E0E] hover:bg-[#F0EDE8] transition-colors'
        }>
        {ctaLabel}
      </button>
      {/* Scroll cue */}
      {/* Explore cue — bright and legible, not faded */}
      <div className="flex items-center gap-2" aria-hidden="true">
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 2.5v5M3.5 6l2.5 2.5L8.5 6" stroke="white" strokeWidth="1.4" strokeLinecap="round"/>
        </svg>
        <span className="text-[11px] font-light tracking-[0.16em] uppercase text-white"
          style={{ textShadow: shadow }}>
          Explore
        </span>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  STAGE 2 — GALLERY
//  Desktop: horizontal scroll (trackpad/wheel), full-bleed images, 01/05 counter
//  Mobile:  full-screen swipe, dash indicators
// ════════════════════════════════════════════════════════════════════════════
function GalleryStage({ images, productName, onShop }: {
  images: any[]; productName: string; onShop: () => void
}) {
  return (
    <section
      aria-label={`${productName} — gallery`}
      className="flex flex-col"
      style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always',
               height: '100svh', minHeight: '100svh', overflow: 'hidden',
               backgroundColor: '#0E0E0E' }}
    >
      <div className="hidden lg:flex flex-1 min-h-0">
        <DesktopGallery images={images} productName={productName} />
      </div>
      <div className="lg:hidden flex-1 min-h-0">
        <MobileGallery images={images} productName={productName} onShop={onShop} />
      </div>
      {/* Desktop bottom bar — hidden on mobile so gallery fills full viewport */}
      <div className="hidden lg:block flex-shrink-0 border-t border-[#E8E5E0] bg-[#F9F8F6]">
        <div className="container-kvrn py-3.5 flex items-center justify-between">
          <span className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">
            {productName}
          </span>
          <button onClick={onShop}
            className="flex items-center gap-1.5 text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
            Shop
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M5 1.5v6M2.5 5.5l2.5 2.5L7.5 5.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </section>
  )
}

// ─── Desktop gallery: horizontal scroll, wheel/trackpad driven ────────────────
function DesktopGallery({ images, productName }: any) {
  const [active, setActive] = useState(0)
  const trackRef = useRef<HTMLDivElement>(null)
  const total    = images.length

  const onScroll = useCallback(() => {
    const el = trackRef.current
    if (!el) return
    const itemW = el.scrollWidth / total
    setActive(Math.min(Math.round(el.scrollLeft / itemW), total - 1))
  }, [total])

  const onWheel = useCallback((e: React.WheelEvent) => {
    const el = trackRef.current
    if (!el) return
    const atStart = el.scrollLeft <= 0
    const atEnd   = el.scrollLeft >= el.scrollWidth - el.clientWidth - 2
    if ((e.deltaY < 0 && atStart) || (e.deltaY > 0 && atEnd)) return
    e.preventDefault()
    el.scrollLeft += e.deltaY + e.deltaX
  }, [])

  const goTo = useCallback((i: number) => {
    const el = trackRef.current
    if (!el) return
    el.scrollTo({ left: (el.scrollWidth / total) * i, behavior: 'smooth' })
  }, [total])

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#F9F8F6]">
      <div ref={trackRef} onScroll={onScroll} onWheel={onWheel}
        className="flex h-full overflow-x-scroll"
        style={{
          scrollSnapType: 'x mandatory', scrollBehavior: 'smooth',
          WebkitOverflowScrolling: 'touch',
          scrollbarWidth: 'none', msOverflowStyle: 'none',
        }}>
        {images.map((img: any, i: number) => (
          <div key={i} className="relative flex-shrink-0 h-full bg-[#EDEAE4]"
            style={{ width: '100%', scrollSnapAlign: 'start', scrollSnapStop: 'always',
                     borderRight: i < total - 1 ? '2px solid #F9F8F6' : 'none' }}>
            {img.src
              ? <Image src={img.src} alt={img.alt || productName} fill
                  sizes="100vw"
                  className="object-cover object-[center_15%] pointer-events-none"
                  loading={i < 2 ? 'eager' : 'lazy'}
                  onError={() => {}} />
              : <div className="absolute inset-0 bg-[#DDD9D2]" />}
          </div>
        ))}
      </div>

      {/* Right-side vertical numbering */}
      <div className="absolute right-5 top-1/2 -translate-y-1/2 flex flex-col gap-3"
        role="tablist" aria-label="Gallery image">
        {images.map((_: any, i: number) => (
          <button key={i} role="tab" aria-selected={i === active}
            onClick={() => goTo(i)}
            className="text-[10px] font-light tabular-nums focus-visible:outline-none transition-all duration-300"
            style={{
              letterSpacing: '0.1em',
              color: i === active ? 'rgba(26,26,26,0.75)' : 'rgba(26,26,26,0.2)',
              transform: i === active ? 'translateX(-1px)' : 'none',
            }}>
            {String(i + 1).padStart(2, '0')}
          </button>
        ))}
      </div>

      {/* Counter */}
      <div className="absolute top-5 right-16 text-[11px] font-light tabular-nums text-[#1A1A1A]/35"
        style={{ letterSpacing: '0.1em' }} aria-live="polite">
        {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>

      {/* Scroll hint — only on first image */}
      {active === 0 && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-2 opacity-25 pointer-events-none">
          <span className="text-[10px] font-light tracking-[0.14em] uppercase text-white">Scroll</span>
          <svg width="14" height="9" viewBox="0 0 14 9" fill="none">
            <path d="M1 4.5h12M8 1l4 3.5-4 3.5" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </div>
      )}
    </div>
  )
}

// ─── Mobile gallery — CSS track approach for zero-flash swiping ──────────────
// All slides are rendered in a flex row.
// Moving the track with transform: translate3d() is instant — no image src changes,
// no remounting, no decode delay. All images are eagerly loaded on mount.
function MobileGallery({ images, productName, onShop }: any) {
  const [active, setActive] = useState(0)
  const [drag,   setDrag]   = useState(0)   // px offset during active swipe
  const txX = useRef<number|null>(null)
  const txY = useRef<number|null>(null)
  const hz  = useRef<boolean|null>(null)
  const total = images.length

  // Warm the browser cache for all images on mount
  useEffect(() => {
    images.forEach((img: any) => {
      if (!img?.src) return
      const el = new window.Image()
      el.src = img.src
    })
  }, [images])

  return (
    <div
      style={{ position: 'relative', width: '100%', height: '100%',
               overflow: 'hidden', background: '#0E0E0E',
               touchAction: 'pan-y' }}   // allow vertical scroll, we handle horizontal
      onTouchStart={e => {
        txX.current = e.touches[0].clientX
        txY.current = e.touches[0].clientY
        hz.current  = null
        setDrag(0)
      }}
      onTouchMove={e => {
        if (txX.current === null || txY.current === null) return
        const dx = e.touches[0].clientX - txX.current
        const dy = e.touches[0].clientY - txY.current
        // Decide direction on first meaningful movement
        if (hz.current === null && (Math.abs(dx) > 6 || Math.abs(dy) > 6))
          hz.current = Math.abs(dx) > Math.abs(dy)
        if (hz.current) {
          e.preventDefault()   // stop page scroll during horizontal swipe
          // Clamp drag: don't drag past first or last slide
          const clamped = active === 0
            ? Math.min(dx, 0)
            : active === total - 1
            ? Math.max(dx, 0)
            : dx
          setDrag(clamped)
        }
      }}
      onTouchEnd={() => {
        if (hz.current) {
          const threshold = 44   // px — intentional swipe threshold
          if (drag < -threshold && active < total - 1) {
            setActive(a => a + 1)   // advance exactly one slide
          } else if (drag > threshold && active > 0) {
            setActive(a => a - 1)   // go back exactly one slide
          }
          // Below threshold: spring back to current slide (drag → 0)
        }
        txX.current = null
        txY.current = null
        hz.current  = null
        setDrag(0)
      }}
    >
      {/*
        TRACK — single flex row, all slides mounted simultaneously.
        translateX moves in real px using CSS calc:
          -(activeIndex × 100vw) + dragPx
        Each slide is exactly 100vw wide (not a % of the track).
        This is the only math that produces correct per-slide movement.
      */}
      <div style={{
        display:    'flex',
        flexWrap:   'nowrap',
        height:     '100%',
        width:      '100%',   // track doesn't need to be wide — slides overflow
        transform:  `translateX(calc(${-active * 100}vw + ${drag}px))`,
        transition: drag === 0
          ? 'transform 0.42s cubic-bezier(0.25,0.46,0.45,0.94)'
          : 'none',
        willChange: 'transform',
      }}>
        {images.map((img: any, i: number) => (
          <div key={i} style={{
            // Each slide = exactly one viewport wide, never shrinks
            minWidth:   '100vw',
            width:      '100vw',
            flexShrink: 0,
            height:     '100%',
            position:   'relative',
            background: '#0E0E0E',
          }}>
            {img?.src ? (
              <img
                src={img.src}
                alt={i === active ? (img.alt || productName) : ''}
                loading="eager"
                decoding="async"
                style={{
                  position:      'absolute',
                  inset:         0,
                  width:         '100%',
                  height:        '100%',
                  objectFit:     'cover',
                  objectPosition:'center 15%',
                  pointerEvents: 'none',
                  // Pre-paint next/prev for GPU — prevents decode stutter
                  willChange:    Math.abs(i - active) <= 1 ? 'transform' : 'auto',
                }}
                onError={() => {}}
              />
            ) : (
              <div style={{ position: 'absolute', inset: 0, background: '#1A1A1A' }} />
            )}
          </div>
        ))}
      </div>

      {/* Bottom overlay: counter + progress + shop — all floated together */}
      <div className="absolute inset-x-0 bottom-0 pb-8 flex flex-col items-center gap-2.5 pointer-events-none"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.42) 0%, transparent 70%)' }}>
        {/* Counter — bottom center, above progress */}
        <div aria-live="polite" className="pointer-events-none">
          <span className="text-[11px] font-light tabular-nums text-white/75"
            style={{ letterSpacing: '0.14em', textShadow: '0 1px 5px rgba(0,0,0,0.5)' }}>
            {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
          </span>
        </div>
        {/* Progress bar */}
        <div style={{ width: 80, height: 1, background: 'rgba(255,255,255,0.22)',
                      position: 'relative', overflow: 'hidden' }}>
          <div style={{
            position: 'absolute', inset: '0 auto 0 0',
            background: 'rgba(255,255,255,0.8)',
            width: `${((active + 1) / total) * 100}%`,
            transition: 'width 0.32s cubic-bezier(0.25,0.46,0.45,0.94)',
          }} />
        </div>
        {/* Shop cue */}
        <button onClick={onShop}
          className="flex items-center gap-1.5"
          style={{ pointerEvents: 'auto' }}
          aria-label="View purchase details">
          <span className="text-[10px] font-light tracking-[0.18em] uppercase"
            style={{ color: 'rgba(255,255,255,0.65)', textShadow: '0 1px 3px rgba(0,0,0,0.35)' }}>
            Shop
          </span>
          <svg width="9" height="9" viewBox="0 0 9 9" fill="none">
            <path d="M4.5 1.5v5M2 4.5l2.5 2.5L7 4.5"
              stroke="rgba(255,255,255,0.65)" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  STAGE 3 — DETAILS (normal scroll)
// ════════════════════════════════════════════════════════════════════════════
function DetailsStage({ product, relatedProduct, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd, onAddBoth, formatPrice, t }: any) {
  return (
    <div className="bg-[#F9F8F6] min-h-screen">
      <div className="max-w-[520px] mx-auto px-6 lg:px-0 py-16 md:py-20">

        <div className="mb-9">
          <p className="text-[10px] font-light tracking-[0.2em] uppercase text-[#9B9B9B] mb-2">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>
          <h2 className="font-display font-light text-[24px] md:text-[28px] leading-tight tracking-[-0.02em] mb-2.5">
            {product.name}
          </h2>
          <div className="flex items-baseline gap-2">
            <span className="text-[19px] font-light tabular-nums">$80</span>
            {product.founderNote && (
              <span className="text-[11px] text-[#9B9B9B]">{product.founderNote}</span>
            )}
          </div>
        </div>

        {product.colors.length > 1 && (
          <div className="mb-6">
            <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2.5">
              Color — {color.name}
            </p>
            <div className="flex gap-2.5 flex-wrap">
              {product.colors.map((c: ColorOption) => (
                <button key={c.value} title={c.name} aria-label={c.name}
                  aria-pressed={c.value === color.value} onClick={() => setColor(c)}
                  className={cn('w-7 h-7 rounded-full transition-all',
                    c.value === color.value
                      ? 'ring-2 ring-[#1A1A1A] ring-offset-2 ring-offset-[#F9F8F6]'
                      : 'hover:ring-1 hover:ring-[#C8C4BF] hover:ring-offset-1')}
                  style={{ backgroundColor: c.hex }} />
              ))}
            </div>
          </div>
        )}

        <div className="mb-7">
          <div className="flex items-center justify-between mb-2.5">
            <p className={cn('text-[10px] font-light tracking-[0.1em] uppercase',
              sizeErr ? 'text-[#B91C1C]' : 'text-[#9B9B9B]')}>
              {sizeErr ? 'Select a size' : 'Size'}
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
                className={cn('h-10 w-11 text-[12px] font-light border transition-all',
                  !s.inStock ? 'border-[#E8E5E0] text-[#C8C4BF] cursor-not-allowed'
                  : size === s.label ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                  : 'border-[#D5D1CB] text-[#1A1A1A] hover:border-[#1A1A1A]')}>
                {s.label}
              </button>
            ))}
          </div>
          {product.fitNote && (
            <p className="text-[11px] text-[#9B9B9B] mt-2 leading-relaxed">{product.fitNote}</p>
          )}
        </div>

        <button disabled={soldOut || cta === 'busy'} onClick={onAdd}
          className={cn('w-full h-12 mb-8 text-[11px] font-light tracking-[0.14em] uppercase transition-all',
            soldOut         ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
            : cta === 'done' ? 'bg-[#15803D] text-white'
            :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
          {ctaLabel}
        </button>

        <p className="text-[14px] text-[#6B6B6B] leading-relaxed">{product.description}</p>

        <div className="border-t border-[#E8E5E0] mt-8 pt-8">
          <p className="text-[10px] font-light tracking-[0.16em] uppercase mb-4">Construction</p>
          <div className="space-y-0.5">
            {(product.constructionDetails ?? []).map((l: string, i: number) => (
              <p key={i} className="text-[14px] font-light text-[#6B6B6B]">{l}</p>
            ))}
          </div>
        </div>

        <div className="border-t border-[#E8E5E0] mt-8">
          <details className="group">
            <summary className="flex items-center justify-between py-5 cursor-pointer list-none text-[10px] font-light tracking-[0.16em] uppercase select-none">
              Shipping & Returns
              <svg width="11" height="7" viewBox="0 0 11 7" fill="none"
                className="transition-transform duration-200 group-open:rotate-180 flex-shrink-0">
                <path d="M1 1l4.5 4.5L10 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </summary>
            <div className="pb-6 space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
              <p>Orders processed within 1–3 business days.</p>
              <p>US: 2–7 days. International: 5–14+ days.</p>
              <p>Returns within 14 days, unworn and in original condition.</p>
              <Link href="/support/shipping-returns"
                className="block text-[12px] text-[#1A1A1A] underline underline-offset-2 mt-2 hover:opacity-60 transition-opacity">
                Full policy →
              </Link>
            </div>
          </details>
        </div>

        {relatedProduct && (
          <CompleteSet product={product} related={relatedProduct} onAddBoth={onAddBoth} />
        )}
      </div>
    </div>
  )
}

// ─── Complete the Set ─────────────────────────────────────────────────────────
function CompleteSet({ product, related, onAddBoth }: any) {
  const i1 = product.colors[0]?.images.find((i: any) => i.type === 'front') ?? product.colors[0]?.images[0]
  const i2 = related.colors[0]?.images.find((i: any) => i.type === 'front') ?? related.colors[0]?.images[0]
  return (
    <div className="border-t border-[#E8E5E0] mt-8 pt-8">
      <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] mb-6">
        Complete the Set
      </p>
      <div className="grid grid-cols-2 gap-3 mb-5">
        {[{ p: product, img: i1 }, { p: related, img: i2 }].map(({ p, img }) => (
          <div key={p.id}>
            <div className="relative aspect-[3/4] bg-[#F0EDE8] overflow-hidden mb-2.5">
              {img?.src
                ? <Image src={img.src} alt={p.name} fill sizes="50vw"
                    className="object-cover" loading="lazy" onError={() => {}} />
                : <div className="absolute inset-0 bg-[#E8E5E0]" />}
            </div>
            <p className="text-[11px] font-light text-[#1A1A1A] leading-snug">{p.name}</p>
            <p className="text-[11px] text-[#9B9B9B] tabular-nums">$80</p>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-[#6B6B6B] leading-relaxed mb-5">
        Same fabric. Same weight. Designed to be worn together.
      </p>
      <button onClick={onAddBoth}
        className="w-full h-12 border border-[#1A1A1A] text-[11px] font-light tracking-[0.12em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-all flex items-center justify-center gap-3">
        Add Both to Bag
        <span className="text-[#9B9B9B]">— $160</span>
      </button>
      <Link href={`/products/${related.slug}`}
        className="block text-center mt-3 text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
        View {related.name.includes('Hoodie') ? 'Hoodie' : 'Sweatpants'} separately
      </Link>
    </div>
  )
}

// ─── Sticky ATC ───────────────────────────────────────────────────────────────
function StickyATC({ product, color, size, cta, ctaLabel, soldOut, onAdd, t, visible }: any) {
  return (
    <div className={cn('fixed bottom-0 left-0 right-0 z-[200] overflow-hidden',
      'bg-white border-t border-[#E8E5E0] transition-transform duration-300',
      visible ? 'translate-y-0 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]' : 'translate-y-full')}
      aria-hidden={!visible}>
      <div className="max-w-[520px] mx-auto px-6 lg:px-0 py-3 flex items-center gap-4">
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
          <button disabled={soldOut || cta === 'busy'} onClick={onAdd}
            className={cn('h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase transition-all',
              soldOut         ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : cta === 'done' ? 'bg-[#15803D] text-white'
              :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
            {soldOut ? t.soldOut : cta === 'done' ? t.addedToBag : t.addToBag}
          </button>
        </div>
      </div>
    </div>
  )
}
