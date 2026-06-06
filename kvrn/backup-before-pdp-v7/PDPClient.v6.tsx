'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import Link  from 'next/link'
import { useCart }     from '@/context/CartContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n }     from '@/context/I18nContext'
import { cn }          from '@/lib/utils'
import type { Product, ColorOption, SizeLabel, SizeOption } from '@/types'

const NAV = 92 // bar (36) + nav (56)

interface Props { product: Product; relatedProduct: Product | null }

// ════════════════════════════════════════════════════════════════════════════
export function PDPClient({ product, relatedProduct }: Props) {
  const { addItem, openCart } = useCart()
  const { formatPrice }       = useCurrency()
  const { t }                 = useI18n()

  const [color,   setColor]   = useState<ColorOption>(product.colors[0])
  const [size,    setSize]     = useState<SizeLabel | null>(null)
  const [sizeErr, setSizeErr]  = useState(false)
  const [cta,     setCta]      = useState<'idle'|'busy'|'done'>('idle')

  // Snap manages stages 1+2; when exited, page scrolls normally into stage 3
  const [snapOn,  setSnapOn]   = useState(true)
  const [stage,   setStage]    = useState<0|1>(0)
  const [sticky,  setSticky]   = useState(false)

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
    return () => { document.body.style.overflow = ''; document.documentElement.style.overflow = '' }
  }, [snapOn])

  // Track active snap stage
  useEffect(() => {
    const el = snapRef.current
    if (!el || !snapOn) return
    const fn = () => setStage(Math.round(el.scrollTop / el.clientHeight) as 0|1)
    el.addEventListener('scroll', fn, { passive: true })
    return () => el.removeEventListener('scroll', fn)
  }, [snapOn])

  // Sticky ATC – only when detail section crosses top
  useEffect(() => {
    const el = detailRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setSticky(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const addOne = useCallback(async (overrideSize?: SizeLabel) => {
    const s = overrideSize ?? size
    if (!s) { setSizeErr(true); return }
    setSizeErr(false); setCta('busy')
    addItem({ productId: product.id, productName: product.name, slug: product.slug,
      color: color.value, colorName: color.name, colorHex: color.hex, size: s,
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

  // Exit snap: unlock body, then scroll into detail section
  const exitSnap = useCallback(() => {
    // First unlock
    document.body.style.overflow = ''
    document.documentElement.style.overflow = ''
    setSnapOn(false)
    // Let React flush, then scroll
    setTimeout(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }, [])

  const imgs = color.images

  return (
    <div className="overflow-x-hidden w-full bg-[#F9F8F6]">

      {/*
        ══════════════════════════════════════════════════
        STAGES 1 + 2 — fixed snap container
        ══════════════════════════════════════════════════
      */}
      {snapOn && (
        <div ref={snapRef} style={{
          position: 'fixed', inset: 0, zIndex: 10,
          overflowY: 'scroll', overflow: 'hidden scroll',
          scrollSnapType: 'y mandatory', scrollBehavior: 'smooth',
          WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'none',
          backgroundColor: '#F9F8F6',
        }}>
          <SnapIndicator stage={stage} />
          <Stage1Hero
            product={product} heroImg={imgs[0]}
            color={color} setColor={setColor}
            size={size} setSize={setSize}
            sizeErr={sizeErr} setSizeErr={setSizeErr}
            cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
            onAdd={() => addOne()}
          />
          <Stage2Gallery
            images={imgs} productName={product.name}
            onExitToDetails={exitSnap}
          />
        </div>
      )}

      {/* Spacer keeps page height while snap owns the scroll */}
      {snapOn && <div style={{ height: '200svh' }} aria-hidden="true" />}

      {/*
        ══════════════════════════════════════════════════
        STAGE 3 — normal scroll, always in DOM
        detailRef fires IntersectionObserver for sticky ATC
        ══════════════════════════════════════════════════
      */}
      <div ref={detailRef} />
      <Stage3Details
        product={product} relatedProduct={relatedProduct}
        color={color} setColor={setColor}
        size={size} setSize={setSize}
        sizeErr={sizeErr} setSizeErr={setSizeErr}
        cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={() => addOne()} onAddBoth={addBoth}
        formatPrice={formatPrice} t={t}
      />

      {/* Sticky — only appears after stage 3 */}
      <StickyATC
        product={product} color={color} size={size}
        cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={() => addOne()} t={t} visible={sticky}
      />
    </div>
  )
}

// ─── Stage progress indicator (homepage style) ────────────────────────────────
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
// STAGE 1 — HERO
// Desktop: side-by-side columns. Image left (62%). Panel right (38%).
// Mobile:  stacked. Full-width image. Product info below.
// No text overlaid on garment image.
// ════════════════════════════════════════════════════════════════════════════
function Stage1Hero({ product, heroImg, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd }: any) {
  return (
    <section
      aria-label={product.name}
      className="flex flex-col lg:flex-row bg-[#F9F8F6]"
      style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always',
               height: '100svh', minHeight: '100svh', overflow: 'hidden' }}
    >
      {/* ── PRODUCT IMAGE ── */}
      <div className="relative flex-shrink-0 overflow-hidden bg-[#EDEAE4]
                      w-full h-[58svh]
                      lg:w-[62%] lg:h-full">
        {heroImg?.src ? (
          <Image src={heroImg.src} alt={heroImg.alt || product.name}
            fill priority fetchPriority="high"
            sizes="(max-width: 1023px) 100vw, 62vw"
            className="object-contain object-center"
            style={{ padding: '24px' }}
            quality={92}
            onError={() => {}}
          />
        ) : (
          <div className="absolute inset-0 bg-[#DDD9D2]" />
        )}
      </div>

      {/* ── PRODUCT PANEL ── */}
      <div className="flex-1 flex flex-col overflow-y-auto bg-[#F9F8F6]">
        {/* Top padding: on desktop we need to clear the fixed nav */}
        <div className="hidden lg:block flex-shrink-0" style={{ height: NAV + 24 }} />

        <div className="flex-1 flex flex-col justify-between px-6 py-5 lg:px-14 lg:py-0 lg:pb-12">

          {/* ── TOP BLOCK ── */}
          <div className="space-y-5">
            {/* Eyebrow */}
            <p className="text-[10px] font-light tracking-[0.22em] uppercase text-[#9B9B9B]">
              {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
            </p>

            {/* Title + price */}
            <div>
              <h1 className="font-display font-light leading-[0.9] tracking-[-0.025em] text-[#1A1A1A] mb-3
                             text-[22px] lg:text-[clamp(24px,2.2vw,36px)]">
                {product.name}
              </h1>
              <div className="flex items-baseline gap-2">
                <span className="text-[20px] lg:text-[22px] font-light tabular-nums text-[#1A1A1A]">$80</span>
                {product.founderNote && (
                  <span className="text-[11px] text-[#9B9B9B] font-light">{product.founderNote}</span>
                )}
              </div>
            </div>

            {/* Key specs */}
            <div className="border-t border-[#E8E5E0] pt-4 space-y-0.5">
              {(product.constructionDetails ?? []).slice(0, 3).map((l: string, i: number) => (
                <p key={i} className="text-[12px] lg:text-[13px] font-light text-[#6B6B6B] leading-relaxed">{l}</p>
              ))}
            </div>

            {/* Color swatches */}
            {product.colors.length > 1 && (
              <div className="flex items-center gap-2.5 flex-wrap">
                {product.colors.map((c: ColorOption) => (
                  <button key={c.value} title={c.name} aria-label={c.name}
                    aria-pressed={c.value === color.value}
                    onClick={() => setColor(c)}
                    className={cn('w-5 h-5 rounded-full transition-all',
                      c.value === color.value
                        ? 'ring-2 ring-[#1A1A1A] ring-offset-2 ring-offset-[#F9F8F6]'
                        : 'hover:ring-1 hover:ring-[#BBB] hover:ring-offset-1 hover:ring-offset-[#F9F8F6]')}
                    style={{ backgroundColor: c.hex }} />
                ))}
                <span className="text-[11px] text-[#9B9B9B] font-light">{color.name}</span>
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

          {/* ── BOTTOM BLOCK — CTA + cue ── */}
          <div className="space-y-4 mt-5">
            <button disabled={soldOut || cta === 'busy'} onClick={onAdd}
              className={cn('w-full h-11 text-[11px] font-light tracking-[0.14em] uppercase transition-all',
                soldOut         ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
                : cta === 'done' ? 'bg-[#15803D] text-white'
                :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
              {ctaLabel}
            </button>
            <div className="flex items-center gap-1.5 opacity-25" aria-hidden="true">
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M6 2.5v5M3.5 6l2.5 2.5L8.5 6" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
              <span className="text-[10px] font-light tracking-[0.14em] uppercase text-[#1A1A1A]">Explore</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE 2 — GALLERY
// Desktop: accordion columns — click a strip to expand.
//          Active image is wide. Others show as narrow strips with numbers.
//          No arrows.
// Mobile:  full-screen swipe. 01/05 counter. No arrows. Dash indicators.
// ════════════════════════════════════════════════════════════════════════════
function Stage2Gallery({ images, productName, onExitToDetails }: any) {
  return (
    <section
      aria-label={`${productName} — gallery`}
      className="flex flex-col bg-[#F9F8F6]"
      style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always',
               height: '100svh', minHeight: '100svh', overflow: 'hidden' }}
    >
      <div className="hidden lg:flex flex-1 min-h-0">
        <DesktopAccordion images={images} productName={productName} />
      </div>
      <div className="lg:hidden flex-1 min-h-0">
        <MobileSwipe images={images} productName={productName} />
      </div>

      {/* Thin bottom bar */}
      <div className="flex-shrink-0 border-t border-[#E8E5E0] bg-[#F9F8F6]">
        <div className="container-kvrn py-3.5 flex items-center justify-between">
          <span className="text-[10px] font-light tracking-[0.14em] uppercase text-[#9B9B9B]">
            {productName}
          </span>
          <button onClick={onExitToDetails}
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

// ── Accordion gallery (desktop) ───────────────────────────────────────────────
function DesktopAccordion({ images, productName }: any) {
  const [active, setActive] = useState(0)
  const total = images.length
  return (
    <div className="relative flex w-full h-full overflow-hidden">
      {images.map((img: any, i: number) => {
        const on = i === active
        return (
          <button key={i}
            onClick={() => setActive(i)}
            aria-label={`Image ${i + 1} of ${total}${on ? ' (current)' : ''}`}
            className={cn('relative overflow-hidden bg-[#EDEAE4] h-full flex-shrink-0 focus-visible:outline-none',
              on ? 'cursor-default' : 'cursor-pointer')}
            style={{
              flex: on ? '5 0 0%' : '1 0 0%',
              borderRight: i < total - 1 ? '1px solid #E8E5E0' : 'none',
              transition: 'flex 0.55s cubic-bezier(0.25,0.46,0.45,0.94)',
            }}>
            {img.src
              ? <Image src={img.src} alt={img.alt || productName} fill
                  sizes="40vw" className="object-cover object-center"
                  loading={i === 0 ? 'eager' : 'lazy'} onError={() => {}} draggable={false} />
              : <div className="absolute inset-0 bg-[#DDD9D2]" />}
            {/* Number badge */}
            <div className={cn(
              'absolute bottom-4 left-4 text-[11px] font-light tabular-nums transition-all duration-300',
              on ? 'text-[#1A1A1A] opacity-50' : 'text-[#1A1A1A] opacity-0'
            )} style={{ letterSpacing: '0.08em' }}>
              {String(i + 1).padStart(2, '0')}
            </div>
          </button>
        )
      })}
      <div className="absolute top-5 right-5 text-[11px] font-light tabular-nums text-[#1A1A1A]/40"
        style={{ letterSpacing: '0.1em' }}>
        {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>
    </div>
  )
}

// ── Mobile swipe (no arrows) ──────────────────────────────────────────────────
function MobileSwipe({ images, productName }: any) {
  const [active, setActive] = useState(0)
  const [offset, setOffset] = useState(0)
  const txX = useRef<number|null>(null)
  const txY = useRef<number|null>(null)
  const hz  = useRef<boolean|null>(null)
  const total = images.length

  const go = useCallback((d: 1|-1) =>
    setActive(i => { setOffset(0); return Math.max(0, Math.min(total - 1, i + d)) }),
    [total])

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#EDEAE4]"
      style={{ touchAction: 'pan-y' }}
      onTouchStart={e => {
        txX.current = e.touches[0].clientX
        txY.current = e.touches[0].clientY
        hz.current  = null
      }}
      onTouchMove={e => {
        if (!txX.current || !txY.current) return
        const dx = e.touches[0].clientX - txX.current
        const dy = e.touches[0].clientY - txY.current
        if (hz.current === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5))
          hz.current = Math.abs(dx) > Math.abs(dy)
        if (hz.current) { e.preventDefault(); setOffset(dx * 0.4) }
      }}
      onTouchEnd={() => {
        if (hz.current) {
          if (offset < -50) go(1)
          else if (offset > 50) go(-1)
        }
        txX.current = txY.current = null; hz.current = null; setOffset(0)
      }}>
      {images[active]?.src ? (
        <Image key={images[active].src + active}
          src={images[active].src} alt={images[active].alt || productName} fill
          sizes="100vw" className="object-contain object-center pointer-events-none"
          loading="lazy" onError={() => {}}
          style={{
            transform: `translateX(${offset}px)`,
            transition: Math.abs(offset) < 3 ? 'transform 0.4s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none',
          }}
        />
      ) : <div className="absolute inset-0 bg-[#DDD9D2]" />}
      {/* Counter */}
      <div className="absolute top-4 right-4 text-[11px] font-light tabular-nums text-[#1A1A1A]/45"
        style={{ letterSpacing: '0.1em' }}>
        {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>
      {/* Dash indicators */}
      {total > 1 && (
        <div className="absolute bottom-4 left-1/2 -translate-x-1/2 flex gap-1" aria-hidden="true">
          {images.map((_: any, i: number) => (
            <div key={i} style={{
              height: '2px', borderRadius: '1px', backgroundColor: '#1A1A1A',
              width: i === active ? '20px' : '4px',
              opacity: i === active ? 0.55 : 0.18,
              transition: 'width 0.3s ease, opacity 0.3s ease',
            }} />
          ))}
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════
// STAGE 3 — PURCHASE + DETAILS (normal vertical scroll)
// ════════════════════════════════════════════════════════════════════════════
function Stage3Details({ product, relatedProduct, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd, onAddBoth, formatPrice, t }: any) {
  return (
    <div className="bg-[#F9F8F6] min-h-screen">
      <div className="max-w-[520px] mx-auto px-6 lg:px-0 py-16 md:py-20">

        {/* Header */}
        <div className="mb-9">
          <p className="text-[10px] font-light tracking-[0.2em] uppercase text-[#9B9B9B] mb-2">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>
          <h2 className="font-display font-light text-[24px] md:text-[28px] leading-tight tracking-[-0.02em] text-[#1A1A1A] mb-2.5">
            {product.name}
          </h2>
          <div className="flex items-baseline gap-2">
            <span className="text-[19px] font-light tabular-nums">$80</span>
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

        {/* Add to Bag */}
        <button disabled={soldOut || cta === 'busy'} onClick={onAdd}
          className={cn('w-full h-12 mb-8 text-[11px] font-light tracking-[0.14em] uppercase transition-all',
            soldOut         ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
            : cta === 'done' ? 'bg-[#15803D] text-white'
            :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
          {ctaLabel}
        </button>

        {/* Description */}
        <p className="text-[14px] text-[#6B6B6B] leading-relaxed">{product.description}</p>

        {/* Construction */}
        <div className="border-t border-[#E8E5E0] mt-8 pt-8">
          <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] mb-4">Construction</p>
          <div className="space-y-0.5">
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

// ─── Sticky ATC (visible only during Stage 3) ─────────────────────────────────
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
