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
      // Stage 0 (hero) = product-stage-1 (black nav), Stage 1 (gallery) = product-stage-2 (white nav)
      window.dispatchEvent(new CustomEvent('kvrn-navbar-mode', {
        detail: { mode: idx === 0 ? 'product-stage-1' : 'product-stage-2' }
      }))
    }
    el.addEventListener('scroll', fn, { passive: true })
    // Fire immediately for initial state (hero has light bg → dark nav)
    window.dispatchEvent(new CustomEvent('kvrn-navbar-mode', { detail: { mode: 'product-stage-1' } }))
    return () => el.removeEventListener('scroll', fn)
  }, [snapOn])

  // On mount: immediately initialize navbar to product-transparent (Stage 1)
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('kvrn-navbar-mode', {
      detail: { mode: 'product-stage-1' }
    }))
  }, [])

  // Sticky ATC + navbar: when snap is off (Stage 3), track scroll position
  useEffect(() => {
    if (snapOn) return   // snap container handles Stage 1/2 events
    // Dispatch cream immediately on entering Stage 3
    window.dispatchEvent(new CustomEvent('kvrn-navbar-mode', {
      detail: { mode: 'product-cream' }
    }))
    const onScroll = () => {
      // If user somehow scrolls back above Stage 3 content, restore transparent
      // Stage 3 content begins at scrollY > 0 when snap is off
      const mode = window.scrollY > 10 ? 'product-stage-3' : 'product-stage-1'
      window.dispatchEvent(new CustomEvent('kvrn-navbar-mode', { detail: { mode } }))
      setSticky(window.scrollY > 80)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    onScroll()
    return () => window.removeEventListener('scroll', onScroll)
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

  // addBoth receives independent sizes from the CompleteSet bundle cards
  const addBoth = useCallback((bundleHoodieSize: string, bundlePantsSize: string) => {
    if (!relatedProduct) return
    const isHoodie = (p: any) => p.name.toLowerCase().includes('hoodie')
    const productSize  = isHoodie(product)        ? bundleHoodieSize : bundlePantsSize
    const relatedSize  = isHoodie(relatedProduct) ? bundleHoodieSize : bundlePantsSize
    addItem({ productId: product.id, productName: product.name, slug: product.slug,
      color: color.value, colorName: color.name, colorHex: color.hex, size: productSize as any,
      price: product.price, quantity: 1,
      image: color.images.find(i => i.type === 'front')?.src ?? '' })
    addItem({ productId: relatedProduct.id, productName: relatedProduct.name,
      slug: relatedProduct.slug,
      color: relatedProduct.colors[0].value, colorName: relatedProduct.colors[0].name,
      colorHex: relatedProduct.colors[0].hex, size: relatedSize as any,
      price: relatedProduct.price, quantity: 1,
      image: relatedProduct.colors[0].images.find(i => i.type === 'front')?.src ?? '' })
    openCart()
  }, [color, product, relatedProduct, addItem, openCart])

  const exitSnap = useCallback(() => {
    document.body.style.overflow = ''
    document.documentElement.style.overflow = ''
    setSnapOn(false)
    // Stage 3 is light bg — switch nav to dark text
    window.dispatchEvent(new CustomEvent('kvrn-navbar-mode', { detail: { mode: 'product-stage-3' } }))
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
          <div className="absolute inset-0 flex items-center justify-center">
            <Image
              src={heroImage.src}
              alt={heroImage.alt || product.name}
              fill priority fetchPriority="high"
              sizes="62vw"
              className="object-cover object-[center_30%]"
              quality={92}
              onError={() => {}}
            />
          </div>
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
// ─── Desktop gallery: luxury 70/30 accordion ─────────────────────────────────
// Active image = ~70% width. Remaining images = narrow vertical strips sharing ~30%.
// Width transitions smoothly (not fade). One scroll = exactly one image advance.
// Scroll events are throttled: a new one is only accepted after the current
// transition completes (450ms lock). This prevents any image skipping.
function DesktopGallery({ images, productName }: any) {
  const [active,       setActive]       = useState(0)
  const [transitioning, setTransitioning] = useState(false)  // scroll lock
  const total = images.length

  // TRANSITION DURATION — must match CSS transition below
  const DURATION_MS = 480

  // Advance active index by ±1, with transition lock
  const go = useCallback((dir: 1 | -1) => {
    setActive(prev => {
      const next = prev + dir
      if (next < 0 || next >= total) return prev   // at boundary — ignore
      return next
    })
    setTransitioning(true)
    setTimeout(() => setTransitioning(false), DURATION_MS)
  }, [total])

  // Wheel handler — one event = one image, locked during transition
  const wheelAccum = useRef(0)
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Touch swipe — all coords in refs, zero state updates during gesture
  const touchStartX = useRef<number | null>(null)
  const touchCurX   = useRef<number | null>(null)

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchCurX.current   = e.touches[0].clientX
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    touchCurX.current = e.touches[0].clientX
  }, [])

  const onTouchEnd = useCallback(() => {
    const start = touchStartX.current
    const cur   = touchCurX.current
    touchStartX.current = null
    touchCurX.current   = null
    if (start === null || cur === null) return
    const dx = cur - start
    if (Math.abs(dx) < 36) return          // below threshold — ignore
    if (!transitioning) go(dx < 0 ? 1 : -1)
  }, [go, transitioning])

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault()
    if (transitioning) return   // locked — ignore all events during animation

    // Accumulate delta — reset after short idle
    const delta = e.deltaX + e.deltaY
    wheelAccum.current += delta
    if (wheelTimer.current) clearTimeout(wheelTimer.current)
    wheelTimer.current = setTimeout(() => { wheelAccum.current = 0 }, 150)

    // Threshold: require meaningful intent before advancing
    const THRESHOLD = 30
    if (wheelAccum.current > THRESHOLD) {
      wheelAccum.current = 0
      go(1)
    } else if (wheelAccum.current < -THRESHOLD) {
      wheelAccum.current = 0
      go(-1)
    }
  }, [go, transitioning])

  // Width calculation
  // Active: ~70% of container. Each inactive: share remaining ~30% equally.
  const inactiveCount  = total - 1
  const activeWidthPct = 70
  const inactiveWidthPct = inactiveCount > 0 ? (30 / inactiveCount) : 30

  return (
    <div
      className="relative w-full h-full overflow-hidden bg-[#0E0E0E] flex"
      onWheel={onWheel}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      role="region"
      aria-label={`${productName} gallery`}
    >
      {/* ── Image panels ── */}
      {images.map((img: any, i: number) => {
        const isActive = i === active
        const widthPct = isActive ? activeWidthPct : inactiveWidthPct
        return (
          <div
            key={i}
            role="button"
            tabIndex={0}
            aria-label={`Image ${i + 1}${isActive ? ' (current)' : ' — click to view'}`}
            onClick={() => {
              if (!isActive && !transitioning) {
                const dir = i > active ? 1 : -1
                go(dir)
              }
            }}
            onKeyDown={e => {
              if ((e.key === 'Enter' || e.key === ' ') && !isActive && !transitioning) {
                e.preventDefault()
                go(i > active ? 1 : -1)
              }
            }}
            style={{
              width:      `${widthPct}%`,
              transition: `width ${DURATION_MS}ms cubic-bezier(0.4,0,0.2,1)`,
              position:   'relative',
              height:     '100%',
              flexShrink: 0,
              overflow:   'hidden',
              cursor:     isActive ? 'default' : 'pointer',
              backgroundColor: '#EDEAE4',
              borderRight: i < total - 1 ? '1px solid #F9F8F6' : 'none',
            }}
          >
            {img.src ? (
              <Image
                key={img.src}
                src={img.src}
                alt={isActive ? (img.alt || productName) : ''}
                fill
                sizes="(max-width: 1600px) 70vw, 1100px"
                // object-contain: shows entire garment, no aggressive crop
                className="pointer-events-none"
                style={{
                  objectFit:      'cover',
                  objectPosition: 'center 30%',  // torso/artwork focus, not face
                  transition:     `filter ${DURATION_MS}ms ease`,
                  filter:         isActive ? 'none' : 'brightness(0.7)',
                }}
                loading={i < 2 ? 'eager' : 'lazy'}
                onError={() => {}}
              />
            ) : (
              <div className="absolute inset-0 bg-[#1A1A1A]" />
            )}

            {/* Number label on inactive strips */}
            {!isActive && (
              <div
                className="absolute inset-0 flex items-end justify-center pb-4"
                aria-hidden="true">
                <span
                  className="text-[10px] font-light tabular-nums text-white/40"
                  style={{ letterSpacing: '0.1em', writingMode: 'vertical-lr' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
              </div>
            )}
          </div>
        )
      })}

      {/* ── Overlay UI on active image ── */}

      {/* Counter — top right of active area */}
      <div
        className="absolute top-5 left-5 text-[11px] font-light tabular-nums text-white/50"
        style={{ letterSpacing: '0.12em' }}
        aria-live="polite">
        {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>

      {/* Vertical number indicator — right edge, always visible */}
      <div
        className="absolute right-4 top-1/2 -translate-y-1/2 flex flex-col gap-3 z-10"
        role="tablist"
        aria-label="Gallery position">
        {images.map((_: any, i: number) => (
          <button
            key={i}
            role="tab"
            aria-selected={i === active}
            onClick={() => {
              if (!transitioning) go(i > active ? 1 : -1)
            }}
            className="focus-visible:outline-none"
            style={{
              background:    'none',
              border:        'none',
              padding:       0,
              fontFamily:    'inherit',
              fontWeight:    300,
              fontSize:      '10px',
              letterSpacing: '0.1em',
              lineHeight:    1,
              color: i === active ? 'rgba(240,237,232,0.85)' : 'rgba(240,237,232,0.25)',
              transform: i === active ? 'translateX(-1px)' : 'none',
              transition: `color ${DURATION_MS}ms ease, transform ${DURATION_MS}ms ease`,
              cursor: i === active ? 'default' : 'pointer',
            }}>
            {String(i + 1).padStart(2, '0')}
          </button>
        ))}
      </div>

      {/* Scroll cue — bottom center, fades after first advance */}
      {active === 0 && (
        <div
          className="absolute bottom-5 left-[35%] -translate-x-1/2 flex items-center gap-2 pointer-events-none"
          style={{ opacity: 0.45 }}
          aria-hidden="true">
          <span className="text-[10px] font-light tracking-[0.14em] uppercase text-white">Scroll</span>
          <svg width="14" height="9" viewBox="0 0 14 9" fill="none">
            <path d="M1 4.5h12M8 1l4 3.5-4 3.5" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
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

// ═════════════════════════════════════════════════════════════════════════════
//  STAGE 3 — Gallery and Purchase
// ═════════════════════════════════════════════════════════════════════════════

/* One-at-a-time wheel gate */
let _wLocked = false, _wTimer: ReturnType<typeof setTimeout> | null = null

// ─── Shared carousel hook ────────────────────────────────────────────────────
function useCarousel(images: any[]) {
  const [idx, setIdx] = useState(0)
  useEffect(() => { setIdx(0) }, [images])
  const go = useCallback((dir: 1 | -1) =>
    setIdx(i => Math.max(0, Math.min(images.length - 1, i + dir))), [images.length])
  return { idx, setIdx, go }
}

// ─── Desktop gallery (thumbnail + main + chevrons) ────────────────────────────
function DesktopGallery3({ images, productName }: { images: any[]; productName: string }) {
  const { idx, setIdx, go } = useCarousel(images)
  const total = images.length

  const onWheel = useCallback((e: React.WheelEvent) => {
    const d = e.deltaX + e.deltaY
    if (Math.abs(d) < 5) return
    e.preventDefault()
    if (_wLocked) return
    go(d > 0 ? 1 : -1)
    _wLocked = true
    if (_wTimer) clearTimeout(_wTimer)
    _wTimer = setTimeout(() => { _wLocked = false }, 420)
  }, [go])

  const txS = useRef<number|null>(null), txC = useRef<number|null>(null)

  return (
    <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>

      {/* Thumbnail rail */}
      <div style={{ width: 80, flexShrink: 0, display: 'flex', flexDirection: 'column',
                    gap: 8, maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
        {images.map((img: any, i: number) => (
          <button key={i} onClick={() => setIdx(i)}
            aria-label={`Image ${i+1}`}
            style={{ width: '100%', aspectRatio: '3/4', position: 'relative',
                     overflow: 'hidden', background: '#EDEAE4', border: 'none', padding: 0,
                     cursor: 'pointer', flexShrink: 0,
                     outline: i === idx ? '1.5px solid #111' : '1.5px solid transparent',
                     outlineOffset: 2, transition: 'outline-color 150ms' }}
          >
            {img?.src && <img src={img.src} alt="" loading="lazy" style={{
              position: 'absolute', inset: 0, width: '100%', height: '100%',
              objectFit: 'cover', objectPosition: 'center top', pointerEvents: 'none'
            }} onError={e=>{(e.target as HTMLImageElement).style.display='none'}} />}
          </button>
        ))}
      </div>

      {/* Main image */}
      <div style={{ flex: '1 1 0', minWidth: 0, maxWidth: 620 }}>
        <div onWheel={onWheel}
          onTouchStart={e => { txS.current = e.touches[0].clientX; txC.current = e.touches[0].clientX }}
          onTouchMove={e => { txC.current = e.touches[0].clientX }}
          onTouchEnd={() => {
            const s=txS.current, c2=txC.current; txS.current=null; txC.current=null
            if(s!==null && c2!==null && Math.abs(c2-s)>36) go(c2<s?1:-1)
          }}
          style={{ position: 'relative', width: '100%', aspectRatio: '3/4',
                   overflow: 'hidden', background: '#EDEAE4' }}>
          {images.map((img: any, i: number) => img?.src ? (
            <img key={img.src} src={img.src}
              alt={i===idx ? (img.alt||productName) : ''}
              loading={i<2?'eager':'lazy'}
              style={{ position: 'absolute', inset: 0, width: '100%', height: '100%',
                       objectFit: 'cover', objectPosition: 'center top',
                       pointerEvents: 'none',
                       opacity: i===idx ? 1 : 0, transition: 'opacity 220ms ease' }}
              onError={e=>{(e.target as HTMLImageElement).style.display='none'}} />
          ) : null)}

          {/* Chevrons */}
          {idx > 0 && (
            <button type="button" aria-label="Previous" onClick={()=>go(-1)}
              style={{ position:'absolute', top:0, bottom:0, left:0, width:'22%',
                       background:'transparent', border:0, cursor:'pointer', zIndex:2,
                       display:'flex', alignItems:'center', paddingLeft:20 }}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none"
                style={{opacity:.55, transition:'opacity 180ms'}}
                onMouseEnter={e=>(e.currentTarget.style.opacity='1')}
                onMouseLeave={e=>(e.currentTarget.style.opacity='.55')}>
                <path d="M13 3L7 10l6 7" stroke="#111" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
          {idx < total-1 && (
            <button type="button" aria-label="Next" onClick={()=>go(1)}
              style={{ position:'absolute', top:0, bottom:0, right:0, width:'22%',
                       background:'transparent', border:0, cursor:'pointer', zIndex:2,
                       display:'flex', alignItems:'center', justifyContent:'flex-end', paddingRight:20 }}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none"
                style={{opacity:.55, transition:'opacity 180ms'}}
                onMouseEnter={e=>(e.currentTarget.style.opacity='1')}
                onMouseLeave={e=>(e.currentTarget.style.opacity='.55')}>
                <path d="M7 3l6 7-6 7" stroke="#111" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          )}
        </div>

        {/* Counter */}
        <p style={{ textAlign:'center', marginTop:10, fontSize:11, fontWeight:300,
                    letterSpacing:'0.1em', color:'#9B9B9B' }}>
          {String(idx+1).padStart(2,'0')} / {String(total).padStart(2,'0')}
        </p>
      </div>
    </div>
  )
}

// ─── Mobile carousel (full-width, no thumbnails) ─────────────────────────────
function MobileCarousel3({ images, productName }: { images: any[]; productName: string }) {
  const { idx, go } = useCarousel(images)
  const total = images.length
  const txS = useRef<number|null>(null), txC = useRef<number|null>(null)
  const locked = useRef(false)

  return (
    <div style={{ marginBottom: 24 }}>
      <div
        onTouchStart={e => {
          txS.current = e.touches[0].clientX
          txC.current = e.touches[0].clientX
          locked.current = false
        }}
        onTouchMove={e => { txC.current = e.touches[0].clientX }}
        onTouchEnd={() => {
          if (locked.current) return
          const s=txS.current, c2=txC.current; txS.current=null; txC.current=null
          if(s!==null && c2!==null && Math.abs(c2-s)>36) {
            locked.current = true
            go(c2<s?1:-1)
          }
        }}
        style={{ position:'relative', width:'100%', aspectRatio:'3/4',
                 overflow:'hidden', background:'#EDEAE4', touchAction:'pan-y' }}
      >
        {images.map((img: any, i: number) => img?.src ? (
          <img key={img.src} src={img.src}
            alt={i===idx ? (img.alt||productName) : ''}
            loading={i<2?'eager':'lazy'}
            style={{ position:'absolute', inset:0, width:'100%', height:'100%',
                     objectFit:'cover', objectPosition:'center top',
                     pointerEvents:'none',
                     opacity: i===idx ? 1 : 0, transition:'opacity 220ms ease' }}
            onError={e=>{(e.target as HTMLImageElement).style.display='none'}} />
        ) : null)}
      </div>
      {total > 1 && (
        <p style={{ textAlign:'center', marginTop:10, fontSize:11, fontWeight:300,
                    letterSpacing:'0.1em', color:'#9B9B9B' }}>
          {String(idx+1).padStart(2,'0')} / {String(total).padStart(2,'0')}
        </p>
      )}
    </div>
  )
}

// ─── Shared purchase controls (color, size, ATC, accordions) ─────────────────
function PurchasePanel({ product, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd }: any) {
  return (
    <>
      {/* Color */}
      <div style={{ marginBottom: 24 }}>
        <p style={{ fontSize:10, fontWeight:300, letterSpacing:'0.12em',
                    textTransform:'uppercase', color:'#9B9B9B', marginBottom:10 }}>
          Color
        </p>
        <div style={{ display:'flex', alignItems:'center', gap:10 }}>
          {product.colors.map((c: ColorOption) => (
            <button key={c.value} title={c.name} aria-label={c.name}
              aria-pressed={c.value === color.value}
              onClick={() => setColor(c)}
              className={cn('rounded-full transition-all',
                c.value === color.value
                  ? 'ring-2 ring-[#1A1A1A] ring-offset-2 ring-offset-[#F9F8F6]'
                  : 'hover:ring-1 hover:ring-[#C8C4BF] hover:ring-offset-1')}
              style={{ width:24, height:24, backgroundColor:c.hex,
                       border:'none', cursor:'pointer', flexShrink:0 }} />
          ))}
          <span style={{ fontSize:13, fontWeight:300, color:'#1A1A1A' }}>{color.name}</span>
        </div>
      </div>

      <div style={{ borderTop:'1px solid #E8E5E0', marginBottom:24 }} />

      {/* Size */}
      <div style={{ marginBottom:24 }}>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
          <p style={{ fontSize:10, fontWeight:300, letterSpacing:'0.12em',
                      textTransform:'uppercase', color: sizeErr ? '#B91C1C' : '#9B9B9B', margin:0 }}>
            {sizeErr ? 'Select a size' : 'Size'}
          </p>
          <Link href="/support/size-guide"
            style={{ fontSize:11, fontWeight:300, color:'#9B9B9B', textDecoration:'underline',
                     textUnderlineOffset:2 }}
            className="hover:text-[#1A1A1A] transition-colors">
            Size guide
          </Link>
        </div>
        <div style={{ display:'flex', flexWrap:'wrap', gap:8 }}>
          {product.sizes.map((s: SizeOption) => (
            <button key={s.value} disabled={!s.inStock}
              onClick={() => { setSize(s.label); setSizeErr(false) }}
              style={{
                height:40, minWidth:44, padding:'0 8px',
                fontSize:12, fontWeight:300, cursor: s.inStock ? 'pointer' : 'not-allowed',
                border: size === s.label ? '1.5px solid #1A1A1A'
                        : s.inStock ? '1px solid #D5D1CB' : '1px solid #E8E5E0',
                background: size === s.label ? '#1A1A1A' : 'transparent',
                color: !s.inStock ? '#C8C4BF' : size === s.label ? '#fff' : '#1A1A1A',
                transition:'all 150ms',
              }}>
              {s.label}
            </button>
          ))}
        </div>
        {product.fitNote && (
          <p style={{ fontSize:12, color:'#9B9B9B', marginTop:8, lineHeight:1.5 }}>{product.fitNote}</p>
        )}
      </div>

      {/* Add to Bag */}
      <button disabled={soldOut || cta === 'busy'} onClick={onAdd}
        style={{
          width:'100%', minHeight:52, fontSize:11, fontWeight:300,
          letterSpacing:'0.14em', textTransform:'uppercase', border:'none',
          cursor: soldOut ? 'not-allowed' : 'pointer', marginBottom:32,
          background: soldOut ? '#E8E5E0' : cta === 'done' ? '#15803D' : '#1A1A1A',
          color: soldOut ? '#9B9B9B' : '#fff', transition:'background 200ms',
        }}>
        {ctaLabel}
      </button>

      {/* Accordions */}
      {[
        { label: 'Description', content: product.description },
        { label: 'Details', content: (product.constructionDetails ?? []).join('\n') },
      ].map(({ label, content }) => content ? (
        <div key={label} style={{ borderTop:'1px solid #E8E5E0' }}>
          <details className="group">
            <summary className="flex items-center justify-between py-4 cursor-pointer list-none select-none"
              style={{ fontSize:10, fontWeight:300, letterSpacing:'0.12em', textTransform:'uppercase' }}>
              {label}
              <svg width="11" height="7" viewBox="0 0 11 7" fill="none"
                className="transition-transform duration-200 group-open:rotate-180 flex-shrink-0">
                <path d="M1 1l4.5 4.5L10 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </summary>
            <div style={{ paddingBottom:20, fontSize:13, color:'#6B6B6B', lineHeight:1.7, whiteSpace:'pre-line' }}>
              {content}
            </div>
          </details>
        </div>
      ) : null)}

      <div style={{ borderTop:'1px solid #E8E5E0' }}>
        <details className="group">
          <summary className="flex items-center justify-between py-4 cursor-pointer list-none select-none"
            style={{ fontSize:10, fontWeight:300, letterSpacing:'0.12em', textTransform:'uppercase' }}>
            Shipping & Returns
            <svg width="11" height="7" viewBox="0 0 11 7" fill="none"
              className="transition-transform duration-200 group-open:rotate-180 flex-shrink-0">
              <path d="M1 1l4.5 4.5L10 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </summary>
          <div style={{ paddingBottom:20, fontSize:13, color:'#6B6B6B', lineHeight:1.7 }}>
            <p>Orders processed within 1–3 business days.</p>
            <p>US: 2–7 days. International: 5–14+ days.</p>
            <p>Returns within 14 days, unworn and in original condition.</p>
            <Link href="/support/shipping-returns"
              style={{ display:'block', marginTop:8, fontSize:12, color:'#1A1A1A',
                       textDecoration:'underline', textUnderlineOffset:2 }}>
              Full policy →
            </Link>
          </div>
        </details>
      </div>
    </>
  )
}

// ─── DetailsStage ─────────────────────────────────────────────────────────────
function DetailsStage({ product, relatedProduct, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd, onAddBoth, formatPrice, t }: any) {

  const eyebrow = product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'

  return (
    <div className="bg-[#F9F8F6]">

      {/* ══ MOBILE LAYOUT (< lg) ══ */}
      <div className="lg:hidden" style={{ padding:'0 0 0' }}>
        {/* Portrait carousel — full width, edge to edge */}
        <MobileCarousel3 images={color.images} productName={product.name} />

        {/* Title + price below carousel */}
        <div style={{ padding:'24px 20px 0' }}>
        <p style={{ fontSize:10, fontWeight:300, letterSpacing:'0.26em',
                    textTransform:'uppercase', color:'#9B9B9B', marginBottom:10 }}>
          {eyebrow}
        </p>
        <h2 style={{ fontFamily:'var(--font-display)', fontWeight:300, lineHeight:1.06,
                     letterSpacing:'-0.03em', color:'#1A1A1A', marginBottom:12,
                     fontSize:'clamp(26px, 7.5vw, 34px)' }}>
          {product.name}
        </h2>
        <p style={{ fontSize:24, fontWeight:300, fontVariantNumeric:'tabular-nums',
                    color:'#1A1A1A', marginBottom: product.founderNote ? 6 : 0 }}>
          $80
        </p>
        {product.founderNote && (
          <p style={{ fontSize:12, color:'#9B9B9B', lineHeight:1.5, marginBottom:0 }}>
            {product.founderNote}
          </p>
        )}
        </div>

        {/* Purchase controls */}
        <div style={{ padding:'0 20px' }}>
        <PurchasePanel
          product={product} color={color} setColor={setColor}
          size={size} setSize={setSize} sizeErr={sizeErr} setSizeErr={setSizeErr}
          cta={cta} ctaLabel={ctaLabel} soldOut={soldOut} onAdd={onAdd}
        />
        </div>
      </div>

      {/* ══ DESKTOP LAYOUT (≥ lg) ══ */}
      <div className="hidden lg:block"
        style={{ maxWidth:1380, margin:'0 auto', padding:'calc(36px + 56px + 0px) 48px 24px', boxSizing:'border-box' }}>
        <div style={{ display:'grid',
                      gridTemplateColumns:'88px minmax(480px,620px) minmax(380px,460px)',
                      gap:40, alignItems:'start', justifyContent:'center' }}>

          {/* Column 1: thumbnail rail (rendered inside DesktopGallery3) */}
          {/* Column 2: main gallery */}
          {/* DesktopGallery3 handles both thumbnails + main image in one flex row */}
          {/* We use a 2-column span trick: grid places [thumb+gallery] then [panel] */}
          {/* Actually simpler: nest thumbnail+gallery in col 1+2, purchase in col 3 */}
          {/* Use a sub-grid approach: outer grid col1=80px, col2=gallery, col3=panel */}

          {/* Thumbnail + gallery spanning cols 1-2 */}
          <div style={{ gridColumn:'1 / 3', marginTop:0, alignSelf:'start' }}>
            <DesktopGallery3 images={color.images} productName={product.name} />
          </div>

          {/* Purchase panel col 3 */}
          <div style={{ marginTop:0, alignSelf:'start', position:'sticky', top:'calc(36px + 56px + 24px)' }}>
            <p style={{ fontSize:10, fontWeight:300, letterSpacing:'0.22em',
                        textTransform:'uppercase', color:'#9B9B9B', marginBottom:14 }}>
              {eyebrow}
            </p>
            <h2 style={{ fontFamily:'var(--font-display)', fontWeight:300,
                         fontSize:'clamp(28px,2.2vw,38px)', lineHeight:1.08,
                         letterSpacing:'-0.03em', color:'#1A1A1A', marginBottom:14 }}>
              {product.name}
            </h2>
            <p style={{ fontSize:22, fontWeight:300, fontVariantNumeric:'tabular-nums',
                        marginBottom: product.founderNote ? 6 : 24 }}>
              $80
            </p>
            {product.founderNote && (
              <p style={{ fontSize:12, color:'#9B9B9B', marginBottom:24, lineHeight:1.55 }}>
                {product.founderNote}
              </p>
            )}

            <div style={{ borderTop:'1px solid #E8E5E0', marginBottom:24 }} />

            <PurchasePanel
              product={product} color={color} setColor={setColor}
              size={size} setSize={setSize} sizeErr={sizeErr} setSizeErr={setSizeErr}
              cta={cta} ctaLabel={ctaLabel} soldOut={soldOut} onAdd={onAdd}
            />
          </div>
        </div>
      </div>

      {/* ══ COMPLETE THE SET ══ */}
      {relatedProduct && (
        <CompleteSet product={product} related={relatedProduct} onAddBoth={onAddBoth} />
      )}
    </div>
  )
}

// ─── Complete the Set ─────────────────────────────────────────────────────────
function CompleteSet({ product, related, onAddBoth }: any) {
  const [hSize, setHSize] = useState<string|null>(null)
  const [pSize, setPSize] = useState<string|null>(null)

  const isHoodie = (p: any) => p.name.toLowerCase().includes('hoodie')
  const img1 = product.colors[0]?.images.find((i: any) => i.type === 'front') ?? product.colors[0]?.images[0]
  const img2  = related.colors[0]?.images.find((i: any) => i.type === 'front') ?? related.colors[0]?.images[0]

  return (
    <section style={{ background:'#F3F0EA' }}>
      <div style={{ maxWidth:1380, margin:'0 auto', padding:'64px 28px' }}>

        {/* Responsive: stacked on mobile, 4-col grid on desktop */}
        <div className="flex flex-col lg:grid gap-8 lg:gap-10"
          style={{ gridTemplateColumns:'minmax(200px,0.85fr) minmax(260px,1fr) minmax(260px,1fr) minmax(230px,0.9fr)',
                   alignItems:'center' } as any}>

          {/* 1. Intro */}
          <div style={{ paddingRight:8 }}>
            <p style={{ fontSize:10, fontWeight:300, letterSpacing:'0.22em',
                        textTransform:'uppercase', color:'#9B9B9B', marginBottom:16 }}>
              Complete the Set
            </p>
            <h3 style={{ fontFamily:'var(--font-display)', fontWeight:300, fontSize:'clamp(26px,2.4vw,32px)',
                         lineHeight:1.1, letterSpacing:'-0.025em', color:'#1A1A1A', marginBottom:16 }}>
              Designed to be worn together.
            </h3>
            <p style={{ fontSize:13, color:'#6B6B6B', lineHeight:1.65 }}>
              Same fabric. Same weight.<br/>
              Built for comfort. Made to move as one.
            </p>
          </div>

          {/* 2. Hoodie card */}
          <BundleCard product={product} img={img1}
            selectedSize={isHoodie(product)?hSize:pSize}
            onSize={isHoodie(product)?setHSize:setPSize} />

          {/* 3. Sweatpants card */}
          <BundleCard product={related} img={img2}
            selectedSize={isHoodie(related)?hSize:pSize}
            onSize={isHoodie(related)?setHSize:setPSize} />

          {/* 4. Bundle CTA */}
          <div style={{ display:'flex', flexDirection:'column' }}>
            <svg width="34" height="34" viewBox="0 0 34 34" fill="none" style={{ marginBottom:20, opacity:.45 }}>
              <rect x="3" y="10" width="28" height="21" rx="1" stroke="#1A1A1A" strokeWidth="1.2"/>
              <path d="M3 15h28" stroke="#1A1A1A" strokeWidth="1.2"/>
              <path d="M12 10V7a5 5 0 0 1 10 0v3" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
              <path d="M13 15v3h8v-3" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
            <p style={{ fontSize:14, fontWeight:300, color:'#1A1A1A', marginBottom:4 }}>Complete the set.</p>
            <p style={{ fontSize:14, fontWeight:300, color:'#6B6B6B', marginBottom:24 }}>Save when you add both.</p>
            <div style={{ borderTop:'1px solid #C8C4BC', paddingTop:20, marginBottom:20 }}>
              <div style={{ display:'flex', alignItems:'baseline', justifyContent:'space-between' }}>
                <span style={{ fontSize:10, fontWeight:300, letterSpacing:'0.1em',
                               textTransform:'uppercase', color:'#9B9B9B' }}>Total</span>
                <span style={{ fontSize:22, fontWeight:300, fontVariantNumeric:'tabular-nums' }}>$160</span>
              </div>
            </div>
            {/* Button label guides user to select missing sizes */}
            {(() => {
              const bundleReady = Boolean(hSize) && Boolean(pSize)
              const label = !hSize && !pSize
                ? 'Select Both Sizes'
                : !hSize ? 'Select Hoodie Size'
                : !pSize ? 'Select Sweatpants Size'
                : 'Add the Complete Set — $160'
              return (
                <button
                  disabled={!bundleReady}
                  onClick={() => bundleReady && onAddBoth(hSize!, pSize!)}
                  style={{ width:'100%', minWidth:0, minHeight:60, fontSize:11, fontWeight:300,
                           letterSpacing:'0.08em', textTransform:'uppercase',
                           background: bundleReady ? '#1A1A1A' : '#E8E5E0',
                           color: bundleReady ? '#fff' : '#9B9B9B',
                           border:'none', cursor: bundleReady ? 'pointer' : 'default',
                           transition:'background 200ms', marginBottom:14, padding:'0 12px',
                           display:'flex', alignItems:'center', justifyContent:'center',
                           boxSizing:'border-box', overflow:'hidden',
                           whiteSpace:'nowrap', textAlign:'center', lineHeight:1 }}>
                  {label}
                </button>
              )
            })()}
            <Link href={`/products/${related.slug}`}
              style={{ display:'block', textAlign:'center', fontSize:11, color:'#9B9B9B',
                       textDecoration:'underline', textUnderlineOffset:2 }}
              className="hover:text-[#1A1A1A] transition-colors">
              View {related.name.includes('Hoodie')?'Hoodie':'Sweatpants'} separately
            </Link>
          </div>
        </div>
      </div>
    </section>
  )
}

function BundleCard({ product, img, selectedSize, onSize }: {
  product:any; img:any; selectedSize:string|null; onSize:(s:string)=>void
}) {
  return (
    <div style={{ background:'transparent' }}>
      <div style={{ position:'relative', width:'100%', aspectRatio:'3/4',
                    overflow:'hidden', background:'#EDEAE4', marginBottom:14 }}>
        {img?.src && <img src={img.src} alt={product.name} loading="lazy"
          style={{ position:'absolute', inset:0, width:'100%', height:'100%',
                   objectFit:'cover', objectPosition:'center top' }}
          onError={e=>{(e.target as HTMLImageElement).style.display='none'}} />}
      </div>
      <div style={{ padding:'0 16px 20px' }}>
        <p style={{ fontSize:13, fontWeight:300, color:'#1A1A1A', marginBottom:4, lineHeight:1.3 }}>
          {product.name}
        </p>
        <p style={{ fontSize:13, fontWeight:300, color:'#9B9B9B', marginBottom:14, fontVariantNumeric:'tabular-nums' }}>
          $80
        </p>
        <p style={{ fontSize:10, fontWeight:300, letterSpacing:'0.1em',
                    textTransform:'uppercase', color:'#9B9B9B', marginBottom:8 }}>Size</p>
        <div style={{ display:'flex', flexWrap:'wrap', gap:6 }}>
          {product.sizes.filter((s:any)=>s.inStock).map((s:any)=>(
            <button key={s.value} onClick={()=>onSize(s.label)}
              style={{ height:34, minWidth:36, padding:'0 8px', fontSize:11, fontWeight:300,
                       cursor:'pointer', transition:'all 150ms',
                       border: selectedSize===s.label ? '1.5px solid #1A1A1A' : '1px solid #D5D1CB',
                       background: selectedSize===s.label ? '#1A1A1A' : 'transparent',
                       color: selectedSize===s.label ? '#fff' : '#1A1A1A' }}>
              {s.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}


// ─── Sticky ATC ───────────────────────────────────────────────────────────────
function StickyATC({ product, color, size, cta, ctaLabel, soldOut, onAdd, t, visible }: any) {
  return (
    <div className={cn('fixed bottom-0 left-0 right-0 z-[200] overflow-hidden lg:hidden',
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
