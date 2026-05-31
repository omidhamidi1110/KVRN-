'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import Link  from 'next/link'
import { useCart }     from '@/context/CartContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n }     from '@/context/I18nContext'
import { cn }          from '@/lib/utils'
import type { Product, ColorOption, SizeLabel, SizeOption } from '@/types'

// Announcement bar (36) + nav (56)
const NAV_OFFSET = 92

interface PDPProps { product: Product; relatedProduct: Product | null }

// ════════════════════════════════════════════════════════════════════════════
export function PDPClient({ product, relatedProduct }: PDPProps) {
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

  const snapRef    = useRef<HTMLDivElement>(null)
  const stage3Ref  = useRef<HTMLDivElement>(null)

  const soldOut  = !product.sizes.some(s => s.inStock)
  const ctaLabel = soldOut       ? t.soldOut
    : cta === 'done'             ? t.addedToBag
    : cta === 'busy'             ? '...'
    : size                       ? t.addToBag
    :                              t.selectSize

  // Lock body while snap active
  useEffect(() => {
    document.body.style.overflow            = snapOn ? 'hidden' : ''
    document.documentElement.style.overflow = snapOn ? 'hidden' : ''
    return () => {
      document.body.style.overflow            = ''
      document.documentElement.style.overflow = ''
    }
  }, [snapOn])

  // Stage tracking inside snap container
  useEffect(() => {
    const el = snapRef.current
    if (!el || !snapOn) return
    const fn = () => setStage(Math.round(el.scrollTop / el.clientHeight) as 0|1)
    el.addEventListener('scroll', fn, { passive: true })
    return () => el.removeEventListener('scroll', fn)
  }, [snapOn])

  // Sticky ATC — only after Stage 3 enters viewport
  useEffect(() => {
    const el = stage3Ref.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setSticky(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const addOne = useCallback(async (s?: SizeLabel) => {
    const chosen = s ?? size
    if (!chosen) { setSizeErr(true); return }
    setSizeErr(false); setCta('busy')
    addItem({ productId: product.id, productName: product.name, slug: product.slug,
      color: color.value, colorName: color.name, colorHex: color.hex,
      size: chosen, price: product.price, quantity: 1,
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
      colorHex: relatedProduct.colors[0].hex, size: s,
      price: relatedProduct.price, quantity: 1,
      image: relatedProduct.colors[0].images.find(i => i.type === 'front')?.src ?? '' })
    openCart()
  }, [size, color, product, relatedProduct, addItem, openCart])

  const exitSnap = useCallback(() => {
    setSnapOn(false)
    requestAnimationFrame(() =>
      stage3Ref.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }, [])

  const images = color.images

  return (
    <div className="overflow-x-hidden w-full">
      {/* ── Snap: Stage 1 + 2 ───────────────────────────────────────────── */}
      {snapOn && (
        <div ref={snapRef} style={{
          position: 'fixed', inset: 0, zIndex: 10,
          overflowY: 'scroll', overflow: 'hidden scroll',
          scrollSnapType: 'y mandatory', scrollBehavior: 'smooth',
          WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'none',
          backgroundColor: '#F9F8F6',
        }}>
          {/* Left indicator bar */}
          <NavIndicator stage={stage} />

          {/* Stage 1 — Hero */}
          <HeroSlide
            product={product} image={images[0]}
            color={color} setColor={setColor}
            size={size} setSize={setSize}
            sizeErr={sizeErr} setSizeErr={setSizeErr}
            cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
            onAdd={addOne}
          />

          {/* Stage 2 — Gallery */}
          <GallerySlide images={images} productName={product.name} onShop={exitSnap} />
        </div>
      )}
      {snapOn && <div style={{ height: '200svh' }} aria-hidden="true" />}

      {/* ── Stage 3: Details (normal scroll) ────────────────────────────── */}
      <div ref={stage3Ref} />
      <Stage3
        product={product} relatedProduct={relatedProduct}
        color={color} setColor={setColor}
        size={size}   setSize={setSize}
        sizeErr={sizeErr} setSizeErr={setSizeErr}
        cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={addOne} onAddBoth={addBoth}
        formatPrice={formatPrice} t={t}
      />

      {/* ── Sticky ATC (Stage 3 only) ────────────────────────────────────── */}
      <StickyATC
        product={product} color={color} size={size}
        cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={addOne} t={t}
        visible={sticky}
      />
    </div>
  )
}

// ─── Stage indicator (homepage bar style) ─────────────────────────────────────
function NavIndicator({ stage }: { stage: 0|1 }) {
  return (
    <div className="fixed left-4 md:left-7 top-1/2 -translate-y-1/2 z-[195] flex flex-col gap-[5px]"
      aria-hidden="true">
      {[0, 1].map(i => (
        <div key={i} style={{
          width: '2px', borderRadius: '1px',
          height: i === stage ? '26px' : '10px',
          backgroundColor: i === stage ? 'rgba(26,26,26,0.7)' : 'rgba(26,26,26,0.18)',
          transition: 'height 0.4s cubic-bezier(0.25,0.46,0.45,0.94)',
        }} />
      ))}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  STAGE 1 — HERO
//  Desktop: image left 62%, panel right 38%. Always side-by-side.
//  Mobile:  full-viewport composed layout — image top 54svh, panel bottom 46svh.
//  NO text overlaid on the garment image.
// ════════════════════════════════════════════════════════════════════════════
function HeroSlide({ product, image, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd }: any) {
  return (
    <section
      aria-label={`${product.name}`}
      style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always', height: '100svh', minHeight: '100svh' }}
      className="flex flex-col lg:flex-row bg-[#F9F8F6]" 
    >
      {/* ── IMAGE ────────────────────────────────────────────────────────── */}
      {/*   Mobile: 54svh tall, full width, object-cover centered            */}
      {/*   Desktop: full height, 62% width                                  */}
      <div className="relative overflow-hidden bg-[#EDEAE4] flex-shrink-0
                      w-full h-[54svh]
                      lg:w-[62%] lg:h-full">
        {image?.src ? (
          <Image
            src={image.src}
            alt={image.alt || product.name}
            fill priority fetchPriority="high"
            sizes="(max-width: 1023px) 100vw, 62vw"
            // object-contain shows full garment without crop
            className="object-contain object-[center_top] lg:object-[center_center]"
            style={{ padding: '16px 0' }}
            quality={92}
            onError={() => {}}
          />
        ) : (
          <div className="absolute inset-0 bg-[#DDD9D2]" />
        )}
      </div>

      {/* ── INFO PANEL ───────────────────────────────────────────────────── */}
      {/*   Mobile: fills remaining 46svh, no top nav offset needed          */}
      {/*   Desktop: fills 38%, has top offset for nav                       */}
      <div className="flex-1 overflow-y-auto bg-[#F9F8F6] flex flex-col"
        style={{ paddingTop: `clamp(20px, 2svh, ${NAV_OFFSET + 24}px)` }}>

        {/* Panel inner — centered vertically on desktop, top-anchored mobile */}
        <div className="flex-1 flex flex-col justify-between
                        px-6 pb-6 lg:px-14 lg:pb-10
                        pt-0 lg:pt-0">

          {/* TOP: identity + key details */}
          <div className="space-y-[clamp(12px,1.8svh,22px)]">
            {/* Eyebrow */}
            <p className="text-[10px] font-light tracking-[0.22em] uppercase text-[#9B9B9B]">
              {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
            </p>

            {/* Title */}
            <h1 className="font-display font-light leading-[0.9] tracking-[-0.025em] text-[#1A1A1A]
                           text-[24px] lg:text-[clamp(22px,2.4vw,34px)]">
              {product.name}
            </h1>

            {/* Price */}
            <p className="text-[19px] lg:text-[22px] font-light tabular-nums text-[#1A1A1A]">
              $80
              {product.founderNote && (
                <span className="ml-2 text-[11px] text-[#9B9B9B] font-light">{product.founderNote}</span>
              )}
            </p>

            {/* Key specs — 3 lines */}
            <div className="border-t border-[#E8E5E0] pt-[clamp(10px,1.4svh,18px)] space-y-1">
              {(product.constructionDetails ?? []).slice(0, 3).map((l: string, i: number) => (
                <p key={i} className="text-[12px] lg:text-[13px] font-light text-[#6B6B6B] leading-relaxed">
                  {l}
                </p>
              ))}
            </div>

            {/* Color */}
            {product.colors.length > 1 && (
              <div className="flex items-center gap-2.5">
                {product.colors.map((c: ColorOption) => (
                  <button key={c.value} title={c.name} aria-label={c.name}
                    aria-pressed={c.value === color.value}
                    onClick={() => setColor(c)}
                    className={cn('w-5 h-5 lg:w-6 lg:h-6 rounded-full transition-all',
                      c.value === color.value
                        ? 'ring-2 ring-[#1A1A1A] ring-offset-[2px] ring-offset-[#F9F8F6]'
                        : 'hover:ring-1 hover:ring-[#BBB] hover:ring-offset-1')}
                    style={{ backgroundColor: c.hex }} />
                ))}
                <span className="text-[11px] font-light text-[#9B9B9B] ml-1">{color.name}</span>
              </div>
            )}

            {/* Size */}
            <div>
              <p className={cn('text-[10px] font-light tracking-[0.1em] uppercase mb-2',
                sizeErr ? 'text-[#B91C1C]' : 'text-[#9B9B9B]')}>
                {sizeErr ? 'Select a size' : 'Size'}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {product.sizes.map((s: SizeOption) => (
                  <button key={s.value} disabled={!s.inStock}
                    onClick={() => { setSize(s.label); setSizeErr(false) }}
                    className={cn('h-9 w-10 text-[11px] font-light border transition-all duration-150',
                      !s.inStock
                        ? 'border-[#E8E5E0] text-[#C8C4BF] cursor-not-allowed'
                        : size === s.label
                        ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                        : 'border-[#D5D1CB] text-[#1A1A1A] hover:border-[#1A1A1A]')}>
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* BOTTOM: CTA + cue */}
          <div className="space-y-4 mt-[clamp(12px,2svh,24px)]">
            <button
              disabled={soldOut || cta === 'busy'}
              onClick={() => onAdd()}
              className={cn('w-full h-11 text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
                soldOut         ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
                : cta === 'done' ? 'bg-[#15803D] text-white'
                :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
              {ctaLabel}
            </button>
            {/* Scroll cue */}
            <div className="flex items-center gap-2 opacity-30" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 2.5v5M3.5 6l2.5 2.5L8.5 6" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              <span className="text-[10px] font-light tracking-[0.14em] uppercase text-[#1A1A1A]">
                Explore
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  STAGE 2 — GALLERY
//
//  Desktop: accordion strip — all images shown as columns.
//           Active image is wide, others are narrow 'peek' strips.
//           Click a strip to expand it.
//           NO circle arrows.
//           01 02 03 04 05 numbers per column.
//
//  Mobile: full-screen single image, swipe left/right (no arrows).
//          01 / 05 counter top-right.
// ════════════════════════════════════════════════════════════════════════════
function GallerySlide({ images, productName, onShop }: {
  images: any[]; productName: string; onShop: () => void
}) {
  return (
    <section
      aria-label={`${productName} — gallery`}
      style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always',
               height: '100svh', minHeight: '100svh', overflow: 'hidden' }}
      className="flex flex-col bg-[#F9F8F6]"
    >
      {/* Desktop accordion gallery */}
      <div className="hidden lg:block flex-1 min-h-0">
        <DesktopAccordion images={images} productName={productName} />
      </div>

      {/* Mobile swipe gallery — no arrows */}
      <div className="lg:hidden flex-1 min-h-0">
        <MobileSwipe images={images} productName={productName} />
      </div>

      {/* Bottom strip — minimal */}
      <div className="flex-shrink-0 border-t border-[#E8E5E0]">
        <div className="container-kvrn py-4 flex items-center justify-between">
          <p className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">
            {productName}
          </p>
          <button onClick={onShop}
            className="flex items-center gap-2 text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors">
            Shop
            <svg width="11" height="11" viewBox="0 0 11 11" fill="none">
              <path d="M5.5 2v5.5M3 6l2.5 2.5L8 6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
            </svg>
          </button>
        </div>
      </div>
    </section>
  )
}

// ── Desktop accordion strip ────────────────────────────────────────────────────
function DesktopAccordion({ images, productName }: { images: any[]; productName: string }) {
  const [active, setActive] = useState(0)
  const total = images.length

  return (
    <div className="relative flex h-full w-full overflow-hidden" aria-label="Gallery">
      {images.map((img: any, i: number) => {
        const isActive = i === active
        return (
          <div
            key={i}
            role="button"
            aria-label={`Image ${i + 1}${isActive ? ' (current)' : ', click to view'}`}
            tabIndex={0}
            onClick={() => setActive(i)}
            onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') setActive(i) }}
            className={cn('relative overflow-hidden bg-[#EDEAE4] cursor-pointer',
              isActive ? 'cursor-default' : 'hover:brightness-95 transition-[filter]')}
            style={{
              flex: isActive ? '5 0 0%' : '1 0 0%',
              transition: 'flex 0.55s cubic-bezier(0.25,0.46,0.45,0.94)',
              borderRight: i < total - 1 ? '1px solid #E8E5E0' : 'none',
            }}
          >
            {img.src ? (
              <Image
                src={img.src}
                alt={img.alt || `${productName} ${i + 1}`}
                fill
                sizes="(max-width: 1600px) 40vw"
                className="object-cover object-center"
                loading={i < 2 ? 'eager' : 'lazy'}
                onError={() => {}}
                draggable={false}
              />
            ) : (
              <div className="absolute inset-0 bg-[#DDD9D2]" />
            )}

            {/* Number at bottom */}
            <div className={cn(
              'absolute bottom-4 px-4 text-[11px] font-light tabular-nums transition-all duration-300',
              isActive ? 'opacity-60 text-[#1A1A1A]' : 'opacity-0',
            )} style={{ letterSpacing: '0.08em' }}>
              {String(i + 1).padStart(2, '0')}
            </div>

            {/* Hover number for inactive strips */}
            {!isActive && (
              <div className="absolute inset-0 flex items-end justify-center pb-4 opacity-0 hover:opacity-60 transition-opacity">
                <span className="text-[10px] font-light tabular-nums text-[#1A1A1A]"
                  style={{ letterSpacing: '0.08em', writingMode: 'vertical-lr' }}>
                  {String(i + 1).padStart(2, '0')}
                </span>
              </div>
            )}
          </div>
        )
      })}

      {/* Active counter top-right */}
      <div className="absolute top-6 right-6 text-[12px] font-light tabular-nums text-[#1A1A1A]/45"
        style={{ letterSpacing: '0.1em' }} aria-live="polite" aria-atomic="true">
        {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>
    </div>
  )
}

// ── Mobile swipe — no arrows, no thumbnails, clean swipe gestures only ─────────
function MobileSwipe({ images, productName }: { images: any[]; productName: string }) {
  const [active, setActive] = useState(0)
  const [offset, setOffset] = useState(0)
  const txX = useRef<number|null>(null)
  const txY = useRef<number|null>(null)
  const hz  = useRef<boolean|null>(null)
  const total = images.length

  const go = useCallback((d: 1|-1) =>
    setActive(i => { setOffset(0); return Math.max(0, Math.min(total - 1, i + d)) }),
    [total])

  const onTS = (e: React.TouchEvent) => {
    txX.current = e.touches[0].clientX
    txY.current = e.touches[0].clientY
    hz.current  = null
  }
  const onTM = (e: React.TouchEvent) => {
    if (!txX.current || !txY.current) return
    const dx = e.touches[0].clientX - txX.current
    const dy = e.touches[0].clientY - txY.current
    if (hz.current === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5))
      hz.current = Math.abs(dx) > Math.abs(dy)
    if (hz.current) { e.preventDefault(); setOffset(dx * 0.4) }
  }
  const onTE = () => {
    if (hz.current) {
      if (offset < -52) go(1)
      else if (offset > 52) go(-1)
    }
    txX.current = txY.current = null; hz.current = null; setOffset(0)
  }

  const cur = images[active]

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#EDEAE4]"
      onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE}
      style={{ touchAction: 'pan-y' }}>
      {cur?.src ? (
        <Image
          key={cur.src + active}
          src={cur.src} alt={cur.alt || productName} fill
          sizes="100vw"
          className="object-contain object-center pointer-events-none"
          loading="lazy" onError={() => {}}
          style={{
            transform: `translateX(${offset}px)`,
            transition: Math.abs(offset) < 3
              ? 'transform 0.4s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none',
          }}
        />
      ) : (
        <div className="absolute inset-0 bg-[#DDD9D2]" />
      )}

      {/* Counter — no arrows, swipe only */}
      <div className="absolute top-4 right-4 text-[12px] font-light tabular-nums text-[#1A1A1A]/50"
        style={{ letterSpacing: '0.1em' }} aria-live="polite">
        {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>

      {/* Swipe hint — fades after first swipe */}
      {active === 0 && total > 1 && (
        <div className="absolute bottom-5 left-1/2 -translate-x-1/2 flex items-center gap-1.5 opacity-30"
          aria-hidden="true">
          <svg width="16" height="10" viewBox="0 0 16 10" fill="none">
            <path d="M2 5h12M9 1l4 4-4 4" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[10px] font-light tracking-[0.12em] uppercase text-[#1A1A1A]">Swipe</span>
        </div>
      )}

      {/* Dot positions as minimal line indicators */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1" aria-hidden="true">
        {images.map((_: any, i: number) => (
          <div key={i} style={{
            width: i === active ? '20px' : '4px', height: '2px',
            borderRadius: '1px', backgroundColor: '#1A1A1A',
            opacity: i === active ? 0.6 : 0.2,
            transition: 'width 0.3s ease, opacity 0.3s ease',
          }} />
        ))}
      </div>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
//  STAGE 3 — PURCHASE DETAILS (normal vertical scroll)
// ════════════════════════════════════════════════════════════════════════════
function Stage3({ product, relatedProduct, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd, onAddBoth, formatPrice, t }: any) {
  return (
    <div className="bg-[#F9F8F6]">
      <div className="max-w-[540px] mx-auto px-6 lg:px-0 py-16 md:py-20">

        {/* Identity */}
        <div className="mb-9">
          <p className="text-[10px] font-light tracking-[0.2em] uppercase text-[#9B9B9B] mb-2.5">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>
          <h2 className="font-display font-light text-[26px] md:text-[30px] leading-tight tracking-[-0.02em] text-[#1A1A1A] mb-3">
            {product.name}
          </h2>
          <div className="flex items-baseline gap-2">
            <span className="text-[20px] font-light tabular-nums">$80</span>
            {product.founderNote && (
              <span className="text-[11px] text-[#9B9B9B]">{product.founderNote}</span>
            )}
          </div>
        </div>

        {/* Color */}
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

        {/* Size */}
        <div className="mb-6">
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
                  !s.inStock
                    ? 'border-[#E8E5E0] text-[#C8C4BF] cursor-not-allowed'
                    : size === s.label
                    ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                    : 'border-[#D5D1CB] text-[#1A1A1A] hover:border-[#1A1A1A]')}>
                {s.label}
              </button>
            ))}
          </div>
          {product.fitNote && (
            <p className="text-[11px] text-[#9B9B9B] mt-2 leading-relaxed">{product.fitNote}</p>
          )}
        </div>

        {/* Primary CTA */}
        <button disabled={soldOut || cta === 'busy'} onClick={() => onAdd()}
          className={cn('w-full h-12 mb-8 text-[11px] font-light tracking-[0.14em] uppercase transition-all',
            soldOut         ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
            : cta === 'done' ? 'bg-[#15803D] text-white'
            :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
          {ctaLabel}
        </button>

        {/* Description */}
        <p className="text-[14px] text-[#6B6B6B] leading-relaxed mb-0">
          {product.description}
        </p>

        {/* Construction */}
        <div className="border-t border-[#E8E5E0] mt-8 pt-8">
          <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] mb-4">
            Construction
          </p>
          <div className="space-y-1">
            {(product.constructionDetails ?? []).map((l: string, i: number) => (
              <p key={i} className="text-[14px] font-light text-[#6B6B6B]">{l}</p>
            ))}
          </div>
        </div>

        {/* Shipping & Returns */}
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

        {/* Complete the Set */}
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
      {/* Side-by-side product thumbnails */}
      <div className="grid grid-cols-2 gap-2.5 mb-5">
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
        className="w-full h-12 border border-[#1A1A1A] text-[11px] font-light tracking-[0.12em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-all duration-200 flex items-center justify-center gap-3">
        Add Both to Bag
        <span className="text-[#9B9B9B]">— $160</span>
      </button>
      <Link href={`/products/${related.slug}`}
        className="block text-center text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors mt-3 underline underline-offset-2">
        View {related.name.includes('Hoodie') ? 'Hoodie' : 'Sweatpants'} separately
      </Link>
    </div>
  )
}

// ─── Sticky ATC — only shown during Stage 3 ──────────────────────────────────
function StickyATC({ product, color, size, cta, ctaLabel, soldOut, onAdd, t, visible }: any) {
  return (
    <div className={cn(
      'fixed bottom-0 left-0 right-0 z-[200] overflow-hidden',
      'bg-white border-t border-[#E8E5E0]',
      'transition-transform duration-300',
      visible ? 'translate-y-0 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]' : 'translate-y-full'
    )} aria-hidden={!visible}>
      <div className="max-w-[540px] mx-auto px-6 lg:px-0 py-3 flex items-center gap-4">
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <span className="w-4 h-4 rounded-full flex-shrink-0 border border-[#E8E5E0]"
            style={{ backgroundColor: color.hex }} aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[12px] font-light text-[#1A1A1A] truncate leading-tight">{product.name}</p>
            <p className="text-[11px] text-[#9B9B9B] mt-0.5 leading-tight">
              {color.name}{size ? ` · ${size}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-[13px] font-light tabular-nums hidden sm:block">$80</span>
          <button disabled={soldOut || cta === 'busy'} onClick={() => onAdd()}
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
