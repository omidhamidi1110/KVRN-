'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import Link  from 'next/link'
import { useCart }     from '@/context/CartContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n }     from '@/context/I18nContext'
import { cn }          from '@/lib/utils'
import type { Product, ColorOption, SizeLabel, SizeOption } from '@/types'

// ─────────────────────────────────────────────────────────────────────────────
interface PDPProps { product: Product; relatedProduct: Product | null }

const NAV_H = 92 // 36px bar + 56px nav

// ═════════════════════════════════════════════════════════════════════════════
export function PDPClient({ product, relatedProduct }: PDPProps) {
  const { addItem, openCart } = useCart()
  const { formatPrice }       = useCurrency()
  const { t }                 = useI18n()

  const [color,    setColor]    = useState<ColorOption>(product.colors[0])
  const [size,     setSize]     = useState<SizeLabel | null>(null)
  const [sizeErr,  setSizeErr]  = useState(false)
  const [cta,      setCta]      = useState<'idle'|'adding'|'done'>('idle')
  const [snapOn,   setSnapOn]   = useState(true)
  const [stage,    setStage]    = useState<0|1>(0)
  const [stickyOn, setStickyOn] = useState(false)

  const snapRef    = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLDivElement>(null)
  const soldOut    = !product.sizes.some(s => s.inStock)

  const ctaLabel = soldOut        ? t.soldOut
    : cta === 'done'              ? t.addedToBag
    : cta === 'adding'            ? '...'
    : size                        ? t.addToBag
    :                               t.selectSize

  // Body lock while snap active
  useEffect(() => {
    if (snapOn) {
      document.body.style.overflow            = 'hidden'
      document.documentElement.style.overflow = 'hidden'
    } else {
      document.body.style.overflow            = ''
      document.documentElement.style.overflow = ''
    }
    return () => {
      document.body.style.overflow            = ''
      document.documentElement.style.overflow = ''
    }
  }, [snapOn])

  // Snap stage tracking
  useEffect(() => {
    const el = snapRef.current
    if (!el || !snapOn) return
    const fn = () => setStage(Math.round(el.scrollTop / el.clientHeight) as 0|1)
    el.addEventListener('scroll', fn, { passive: true })
    return () => el.removeEventListener('scroll', fn)
  }, [snapOn])

  // Sticky ATC
  useEffect(() => {
    const el = triggerRef.current
    if (!el) return
    const io = new IntersectionObserver(([e]) => setStickyOn(!e.isIntersecting), { threshold: 0 })
    io.observe(el)
    return () => io.disconnect()
  }, [])

  const addOne = useCallback(async (overrideSize?: SizeLabel) => {
    const s = overrideSize ?? size
    if (!s) { setSizeErr(true); return }
    setSizeErr(false); setCta('adding')
    const img = color.images.find(i => i.type === 'front')
    addItem({ productId: product.id, productName: product.name, slug: product.slug,
      color: color.value, colorName: color.name, colorHex: color.hex,
      size: s, price: product.price, quantity: 1, image: img?.src ?? '' })
    setCta('done')
    setTimeout(() => { setCta('idle'); openCart() }, 700)
  }, [size, color, product, addItem, openCart])

  const addBoth = useCallback(() => {
    if (!relatedProduct) return
    const s = size ?? 'M'
    const i1 = color.images.find(i => i.type === 'front')
    const i2 = relatedProduct.colors[0]?.images.find(i => i.type === 'front')
    addItem({ productId: product.id, productName: product.name, slug: product.slug,
      color: color.value, colorName: color.name, colorHex: color.hex,
      size: s, price: product.price, quantity: 1, image: i1?.src ?? '' })
    addItem({ productId: relatedProduct.id, productName: relatedProduct.name,
      slug: relatedProduct.slug,
      color: relatedProduct.colors[0].value, colorName: relatedProduct.colors[0].name,
      colorHex: relatedProduct.colors[0].hex,
      size: s, price: relatedProduct.price, quantity: 1, image: i2?.src ?? '' })
    openCart()
  }, [size, color, product, relatedProduct, addItem, openCart])

  const exitSnap = useCallback(() => {
    setSnapOn(false)
    requestAnimationFrame(() =>
      triggerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    )
  }, [])

  return (
    <div className="overflow-x-hidden w-full min-h-screen bg-[#F9F8F6]">

      {/* ══ SNAP CONTAINER (hero + gallery) ═════════════════════════════════ */}
      {snapOn && (
        <div ref={snapRef} style={{
          position: 'fixed', inset: 0, zIndex: 10,
          overflowY: 'scroll', overflow: 'hidden scroll',
          scrollSnapType: 'y mandatory', scrollBehavior: 'smooth',
          WebkitOverflowScrolling: 'touch', overscrollBehaviorY: 'none',
          backgroundColor: '#F9F8F6',
        }}>
          <StageIndicator current={stage} />
          <Hero   product={product} heroImage={color.images[0]} color={color}
            setColor={setColor} size={size} setSize={setSize}
            sizeErr={sizeErr} setSizeErr={setSizeErr}
            cta={cta} ctaLabel={ctaLabel} soldOut={soldOut} onAdd={addOne} />
          <Gallery images={color.images} productName={product.name} onShop={exitSnap} />
        </div>
      )}
      {snapOn && <div style={{ height: '200svh' }} aria-hidden="true" />}

      {/* ══ DETAILS (stage 3 — normal scroll) ═══════════════════════════════ */}
      <div ref={triggerRef} />
      <Stage3
        product={product} relatedProduct={relatedProduct}
        color={color} setColor={setColor}
        size={size}  setSize={setSize}
        sizeErr={sizeErr} setSizeErr={setSizeErr}
        cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={addOne} onAddBoth={addBoth}
        formatPrice={formatPrice} t={t}
      />

      {/* ══ STICKY ATC ═══════════════════════════════════════════════════════ */}
      <StickyBar
        product={product} color={color} size={size}
        cta={cta} ctaLabel={ctaLabel} soldOut={soldOut}
        onAdd={addOne} formatPrice={formatPrice} t={t}
        visible={stickyOn}
      />
    </div>
  )
}

// ─── Left-side stage bar (same as homepage) ───────────────────────────────────
function StageIndicator({ current }: { current: number }) {
  return (
    <div className="fixed left-4 md:left-7 top-1/2 -translate-y-1/2 z-[195] flex flex-col gap-[5px]">
      {[0, 1].map(i => (
        <div key={i} style={{
          width: '2px', height: i === current ? '26px' : '10px', borderRadius: '1px',
          backgroundColor: i === current ? 'rgba(26,26,26,0.75)' : 'rgba(26,26,26,0.2)',
          transition: 'height 0.45s cubic-bezier(0.25,0.46,0.45,0.94)',
        }} />
      ))}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  STAGE 1 — HERO
//  Desktop: true side-by-side columns.  Mobile: stacked.
// ═════════════════════════════════════════════════════════════════════════════
function Hero({ product, heroImage, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd }: any) {

  return (
    <section
      aria-label={`${product.name} — hero`}
      style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always',
               height: '100svh', minHeight: '100svh', overflow: 'hidden' }}
      // CRITICAL: use Tailwind grid classes (not inline display:grid)
      // so responsive breakpoints work correctly
      className="flex flex-col lg:flex-row bg-[#F9F8F6]"
    >
      {/* ── IMAGE — 60% desktop, full-width mobile ── */}
      <div className="relative flex-shrink-0 w-full lg:w-[60%] h-[52svh] lg:h-full bg-[#F0EDE8] overflow-hidden">
        {heroImage?.src ? (
          <Image
            src={heroImage.src}
            alt={heroImage.alt || product.name}
            fill priority fetchPriority="high"
            sizes="(max-width: 1023px) 100vw, 60vw"
            className="object-cover object-[center_15%]"
            quality={92}
            onError={() => {}}
          />
        ) : (
          <div className="absolute inset-0 bg-[#E8E5E0]" />
        )}
      </div>

      {/* ── INFO PANEL — 40% desktop, full-width mobile ── */}
      <div
        className="flex-1 flex flex-col justify-between overflow-y-auto bg-[#F9F8F6]"
        style={{ paddingTop: `${NAV_H + 28}px`, paddingBottom: '28px' }}
      >
        <div className="px-7 md:px-10 lg:px-12 xl:px-16 space-y-6">

          {/* Eyebrow */}
          <p className="text-[10px] font-light tracking-[0.22em] uppercase text-[#9B9B9B]">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>

          {/* Title */}
          <h1 className="font-display font-light text-[26px] lg:text-[30px] xl:text-[36px] leading-[0.92] tracking-[-0.025em] text-[#1A1A1A]">
            {product.name}
          </h1>

          {/* Price */}
          <div className="flex items-baseline gap-2">
            <span className="text-[22px] font-light tabular-nums text-[#1A1A1A]">$80</span>
            {product.founderNote && (
              <span className="text-[11px] text-[#9B9B9B]">{product.founderNote}</span>
            )}
          </div>

          {/* Specs */}
          <div className="pt-3 border-t border-[#E8E5E0] space-y-1">
            {(product.constructionDetails ?? []).slice(0, 4).map((l: string, i: number) => (
              <p key={i} className="text-[12px] lg:text-[13px] font-light text-[#6B6B6B] leading-relaxed">{l}</p>
            ))}
          </div>

          {/* Color swatches */}
          {product.colors.length > 1 && (
            <div>
              <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-2">
                {color.name}
              </p>
              <div className="flex gap-2 flex-wrap">
                {product.colors.map((c: ColorOption) => (
                  <button key={c.value} title={c.name} aria-label={c.name}
                    aria-pressed={c.value === color.value}
                    onClick={() => setColor(c)}
                    className={cn('w-6 h-6 rounded-full transition-all',
                      c.value === color.value
                        ? 'ring-2 ring-[#1A1A1A] ring-offset-2 ring-offset-[#F9F8F6]'
                        : 'hover:ring-1 hover:ring-[#C8C4BF] hover:ring-offset-1')}
                    style={{ backgroundColor: c.hex }} />
                ))}
              </div>
            </div>
          )}

          {/* Size buttons */}
          <div>
            <p className={cn('text-[10px] font-light tracking-[0.1em] uppercase mb-2',
              sizeErr ? 'text-[#B91C1C]' : 'text-[#9B9B9B]')}>
              {sizeErr ? 'Select a size' : 'Size'}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {product.sizes.map((s: SizeOption) => (
                <button key={s.value} disabled={!s.inStock}
                  onClick={() => { setSize(s.label); setSizeErr(false) }}
                  className={cn(
                    'h-9 w-10 text-[11px] font-light border transition-all duration-150',
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
          </div>

          {/* Add to Bag */}
          <button
            disabled={soldOut || cta === 'adding'}
            onClick={() => onAdd()}
            className={cn(
              'w-full h-12 text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
              soldOut          ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : cta === 'done' ? 'bg-[#15803D] text-white'
              :                  'bg-[#1A1A1A] text-white hover:bg-[#333]'
            )}>
            {ctaLabel}
          </button>
        </div>

        {/* Scroll cue */}
        <div className="px-7 md:px-10 lg:px-12 xl:px-16 flex items-center gap-2 opacity-25" aria-hidden="true">
          <svg width="13" height="13" viewBox="0 0 13 13" fill="none">
            <path d="M6.5 2.5v7M3.5 7l3 3 3-3" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[10px] font-light tracking-[0.16em] uppercase text-[#1A1A1A]">Explore</span>
        </div>
      </div>
    </section>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  STAGE 2 — EDITORIAL GALLERY
//  Desktop: horizontal variable-width image strip
//  Mobile:  full-screen swipeable slides
// ═════════════════════════════════════════════════════════════════════════════

// Editorial widths: big → medium → detail → medium → big
const EDITORIAL_WIDTHS = ['55%', '35%', '28%', '40%', '50%']
const EDITORIAL_ASPECTS: Array<[number,number]> = [[3,4],[2,3],[1,1],[4,5],[3,4]]

function Gallery({ images, productName, onShop }: {
  images: any[]; productName: string; onShop: () => void
}) {
  const total = images.length

  return (
    <section
      aria-label={`${productName} — gallery`}
      style={{ scrollSnapAlign: 'start', scrollSnapStop: 'always',
               height: '100svh', minHeight: '100svh', overflow: 'hidden' }}
      className="bg-[#F9F8F6] flex flex-col"
    >
      {/* Desktop: horizontal editorial strip */}
      <div className="hidden lg:flex flex-1 min-h-0">
        <DesktopGallery images={images} productName={productName} />
      </div>

      {/* Mobile: full-screen swipeable */}
      <div className="lg:hidden flex-1 min-h-0">
        <MobileGallery images={images} productName={productName} />
      </div>

      {/* Bottom bar */}
      <div className="flex-shrink-0 border-t border-[#E8E5E0] bg-[#F9F8F6]">
        <div className="container-kvrn py-4 flex items-center justify-between">
          <span className="text-[11px] font-light text-[#9B9B9B] tabular-nums tracking-[0.08em]">
            {productName}
          </span>
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

// ── Desktop gallery: images side-by-side, variable widths ────────────────────
function DesktopGallery({ images, productName }: { images: any[]; productName: string }) {
  const [active, setActive] = useState(0)
  const total = images.length

  return (
    <div className="relative w-full h-full flex items-stretch overflow-hidden">
      {/* Image columns */}
      <div className="flex h-full w-full gap-[2px]">
        {images.map((img: any, i: number) => {
          const isActive = i === active
          return (
            <button
              key={i}
              onClick={() => setActive(i)}
              aria-label={`View image ${i + 1}`}
              className="relative flex-shrink-0 overflow-hidden bg-[#F0EDE8] transition-all duration-600 ease-[cubic-bezier(0.25,0.46,0.45,0.94)]"
              style={{
                // Active: wider. Others: narrow peek.
                flex: isActive ? '4 0 0%' : '1 0 0%',
                transition: 'flex 0.6s cubic-bezier(0.25,0.46,0.45,0.94)',
                cursor: isActive ? 'default' : 'pointer',
              }}
            >
              {img.src ? (
                <Image
                  src={img.src}
                  alt={img.alt || `${productName} — ${i + 1}`}
                  fill
                  sizes="(max-width: 1600px) 33vw, 25vw"
                  className="object-cover object-center"
                  loading={i === 0 ? 'eager' : 'lazy'}
                  onError={() => {}}
                />
              ) : (
                <div className="absolute inset-0 bg-[#E8E5E0]" />
              )}
              {/* Number indicator */}
              <div className="absolute bottom-4 left-4 text-[11px] font-light tabular-nums transition-opacity duration-300"
                style={{ color: isActive ? 'rgba(26,26,26,0.8)' : 'rgba(26,26,26,0.35)', letterSpacing: '0.08em' }}>
                {String(i + 1).padStart(2, '0')}
              </div>
            </button>
          )
        })}
      </div>

      {/* Active counter top-right */}
      <div className="absolute top-6 right-6 text-[12px] font-light tabular-nums text-[#1A1A1A]/50 tracking-[0.1em]" aria-live="polite">
        {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>
    </div>
  )
}

// ── Mobile gallery: full-screen swipe ────────────────────────────────────────
function MobileGallery({ images, productName }: { images: any[]; productName: string }) {
  const [active, setActive]   = useState(0)
  const [offset, setOffset]   = useState(0)
  const [drag,   setDrag]     = useState(false)
  const txX = useRef<number|null>(null)
  const txY = useRef<number|null>(null)
  const hz  = useRef<boolean|null>(null)
  const total = images.length

  const go = useCallback((d: 1|-1) => {
    setActive(i => Math.max(0, Math.min(total - 1, i + d)))
    setOffset(0)
  }, [total])

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
    if (hz.current) { e.preventDefault(); setOffset(dx * 0.45); setDrag(true) }
  }
  const onTE = () => {
    if (hz.current) { if (offset < -50) go(1); else if (offset > 50) go(-1) }
    txX.current = txY.current = null; hz.current = null; setDrag(false); setOffset(0)
  }

  const cur = images[active]

  return (
    <div className="relative w-full h-full overflow-hidden"
      onTouchStart={onTS} onTouchMove={onTM} onTouchEnd={onTE}
      style={{ touchAction: 'pan-y' }}>
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

      {/* Luxury counter */}
      <div className="absolute top-5 right-5 text-[12px] font-light tabular-nums text-[#1A1A1A]/50 tracking-[0.1em]" aria-live="polite">
        {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
      </div>

      {/* Prev / Next */}
      {active > 0 && (
        <button onClick={() => go(-1)} aria-label="Previous"
          className="absolute left-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full border border-[#D5D1CB] bg-white/80 backdrop-blur-sm flex items-center justify-center">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M7 1L3 5l4 4" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/></svg>
        </button>
      )}
      {active < total - 1 && (
        <button onClick={() => go(1)} aria-label="Next"
          className="absolute right-3 top-1/2 -translate-y-1/2 w-9 h-9 rounded-full border border-[#D5D1CB] bg-white/80 backdrop-blur-sm flex items-center justify-center">
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none"><path d="M3 1l4 4-4 4" stroke="#1A1A1A" strokeWidth="1.2" strokeLinecap="round"/></svg>
        </button>
      )}
    </div>
  )
}

// ═════════════════════════════════════════════════════════════════════════════
//  STAGE 3 — PURCHASE DETAILS (normal scroll)
// ═════════════════════════════════════════════════════════════════════════════
function Stage3({ product, relatedProduct, color, setColor, size, setSize,
  sizeErr, setSizeErr, cta, ctaLabel, soldOut, onAdd, onAddBoth, formatPrice, t }: any) {
  return (
    <div className="bg-[#F9F8F6] min-h-screen">
      <div className="max-w-[560px] mx-auto px-6 lg:px-0 py-16 md:py-20">

        {/* Header */}
        <div className="mb-10">
          <p className="text-[10px] font-light tracking-[0.2em] uppercase text-[#9B9B9B] mb-2">
            {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
          </p>
          <h2 className="font-display font-light text-[26px] md:text-[32px] leading-tight tracking-[-0.02em] text-[#1A1A1A] mb-3">
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
                      : 'hover:ring-1 hover:ring-[#C8C4BF] hover:ring-offset-1')}
                  style={{ backgroundColor: c.hex }} />
              ))}
            </div>
          </div>
        )}

        {/* Size */}
        <div className="mb-7">
          <div className="flex items-center justify-between mb-3">
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

        {/* CTAs */}
        <div className="space-y-2 mb-10">
          <button disabled={soldOut || cta === 'adding'} onClick={() => onAdd()}
            className={cn('w-full h-12 text-[11px] font-light tracking-[0.14em] uppercase transition-all',
              soldOut          ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : cta === 'done' ? 'bg-[#15803D] text-white'
              :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
            {ctaLabel}
          </button>
        </div>

        {/* Description */}
        <div className="mb-0">
          <p className="text-[14px] text-[#6B6B6B] leading-relaxed">{product.description}</p>
        </div>

        {/* Construction */}
        <div className="border-t border-[#E8E5E0] mt-8 pt-8">
          <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] mb-4">Construction</p>
          <div className="space-y-1">
            {(product.constructionDetails ?? []).map((l: string, i: number) => (
              <p key={i} className="text-[14px] font-light text-[#6B6B6B]">{l}</p>
            ))}
          </div>
        </div>

        {/* Shipping & Returns */}
        <div className="border-t border-[#E8E5E0] mt-8">
          <details className="group">
            <summary className="flex items-center justify-between py-5 cursor-pointer list-none text-[10px] font-light tracking-[0.16em] uppercase">
              Shipping & Returns
              <svg width="11" height="7" viewBox="0 0 11 7" fill="none" className="transition-transform duration-200 group-open:rotate-180 flex-shrink-0">
                <path d="M1 1l4.5 4.5L10 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
              </svg>
            </summary>
            <div className="pb-5 space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
              <p>Orders processed within 1–3 business days.</p>
              <p>US: 2–7 days. International: 5–14+ days.</p>
              <p>Returns within 14 days, unworn and in original condition.</p>
              <Link href="/support/shipping-returns"
                className="block text-[#1A1A1A] underline underline-offset-2 text-[12px] mt-2 hover:opacity-60 transition-opacity">
                Full policy →
              </Link>
            </div>
          </details>
        </div>

        {/* Complete the Set */}
        {relatedProduct && (
          <CompleteSet
            product={product} related={relatedProduct}
            onAddBoth={onAddBoth}
          />
        )}
      </div>
    </div>
  )
}

// ─── Complete the Set ─────────────────────────────────────────────────────────
function CompleteSet({ product, related, onAddBoth }: any) {
  const img1 = product.colors[0]?.images.find((i: any) => i.type === 'front') ?? product.colors[0]?.images[0]
  const img2 = related.colors[0]?.images.find((i: any) => i.type === 'front') ?? related.colors[0]?.images[0]

  return (
    <div className="border-t border-[#E8E5E0] mt-8 pt-8">
      <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] mb-6">
        Complete the Set
      </p>

      {/* Side by side product images */}
      <div className="grid grid-cols-2 gap-2 mb-5">
        {[{ p: product, img: img1 }, { p: related, img: img2 }].map(({ p, img }) => (
          <div key={p.id}>
            <div className="relative aspect-[3/4] bg-[#F0EDE8] overflow-hidden mb-2">
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

      {/* Single unified CTA */}
      <button onClick={onAddBoth}
        className="w-full h-12 border border-[#1A1A1A] text-[11px] font-light tracking-[0.12em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-all duration-200 flex items-center justify-center gap-3">
        <span>Add Both to Bag</span>
        <span className="text-[#9B9B9B] group-hover:text-white/70">$160</span>
      </button>

      <Link href={`/products/${related.slug}`}
        className="block text-center text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors mt-3 underline underline-offset-2">
        View {related.name.includes('Hoodie') ? 'Hoodie' : 'Sweatpants'} separately
      </Link>
    </div>
  )
}

// ─── Sticky ATC ───────────────────────────────────────────────────────────────
function StickyBar({ product, color, size, cta, ctaLabel, soldOut, onAdd, formatPrice, visible, t }: any) {
  return (
    <div className={cn('fixed bottom-0 left-0 right-0 z-[200] overflow-hidden bg-white border-t border-[#E8E5E0] transition-transform duration-300',
      visible ? 'translate-y-0 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]' : 'translate-y-full')}
      aria-hidden={!visible}>
      <div className="max-w-[560px] mx-auto px-6 py-3 flex items-center gap-4">
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
          <button disabled={soldOut || cta === 'adding'} onClick={() => onAdd()}
            className={cn('h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase transition-all',
              soldOut          ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : cta === 'done' ? 'bg-[#15803D] text-white'
              :                  'bg-[#1A1A1A] text-white hover:bg-[#333]')}>
            {soldOut ? t.soldOut : cta === 'done' ? t.addedToBag : t.addToBag}
          </button>
        </div>
      </div>
    </div>
  )
}
