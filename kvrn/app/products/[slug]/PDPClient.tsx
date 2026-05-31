'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import Link from 'next/link'
import { useCart }      from '@/context/CartContext'
import { useCurrency }  from '@/context/CurrencyContext'
import { useI18n }      from '@/context/I18nContext'
import { cn }           from '@/lib/utils'
import type { Product, ColorOption, SizeLabel, SizeOption } from '@/types'

interface PDPClientProps {
  product:        Product
  relatedProduct: Product | null
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main PDP shell — snap container for hero + gallery, then normal scroll
// ─────────────────────────────────────────────────────────────────────────────
export function PDPClient({ product, relatedProduct }: PDPClientProps) {
  const { addItem, openCart } = useCart()
  const { formatPrice }       = useCurrency()
  const { t }                 = useI18n()

  const [selectedColor, setSelectedColor] = useState<ColorOption>(product.colors[0])
  const [selectedSize,  setSelectedSize]  = useState<SizeLabel | null>(null)
  const [sizeError,     setSizeError]     = useState(false)
  const [addState,      setAddState]      = useState<'idle' | 'loading' | 'added'>('idle')

  // Snap container for sections 1 + 2; after that normal scroll
  const snapRef    = useRef<HTMLDivElement>(null)
  const [snapDone, setSnapDone] = useState(false)   // true once user reaches details
  const [snapSlide, setSnapSlide] = useState(0)      // 0=hero, 1=gallery

  // Sticky ATC
  const [stickyVisible, setStickyVisible] = useState(false)
  const detailsTriggerRef = useRef<HTMLDivElement>(null)

  const soldOut  = !product.sizes.some(s => s.inStock)
  const atcLabel = soldOut                  ? t.soldOut
    : addState === 'added'                  ? t.addedToBag
    : addState === 'loading'                ? '...'
    : selectedSize                          ? t.addToBag
    :                                         t.selectSize

  const handleAdd = useCallback(async () => {
    if (!selectedSize) { setSizeError(true); return }
    setSizeError(false)
    setAddState('loading')
    const front = selectedColor.images.find(i => i.type === 'front')
    addItem({
      productId: product.id, productName: product.name, slug: product.slug,
      color: selectedColor.value, colorName: selectedColor.name, colorHex: selectedColor.hex,
      size: selectedSize, price: product.price, quantity: 1, image: front?.src ?? '',
    })
    setAddState('added')
    setTimeout(() => { setAddState('idle'); openCart() }, 700)
  }, [selectedSize, selectedColor, product, addItem, openCart])

  // Lock body scroll while snap container is active
  useEffect(() => {
    if (!snapDone) {
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
  }, [snapDone])

  // Track which snap slide we're on
  useEffect(() => {
    const el = snapRef.current
    if (!el || snapDone) return
    const onScroll = () => {
      const idx = Math.round(el.scrollTop / el.clientHeight)
      setSnapSlide(idx)
      // When user scrolls to the last snap section (gallery = index 1),
      // allow transitioning out of snap mode on next scroll
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [snapDone])

  // Sticky ATC observer
  useEffect(() => {
    const el = detailsTriggerRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      ([e]) => setStickyVisible(!e.isIntersecting),
      { threshold: 0 }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [])

  // Exit snap mode: fires once when user wants to scroll past gallery
  const exitSnap = useCallback(() => {
    setSnapDone(true)
    // Scroll to details section smoothly
    requestAnimationFrame(() => {
      detailsTriggerRef.current?.scrollIntoView({ behavior: 'smooth' })
    })
  }, [])

  const heroImage  = selectedColor.images[0]
  const galleryImages = selectedColor.images  // all images for gallery

  // Determine Collection label for eyebrow
  const collectionLabel = product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'

  return (
    <div className="overflow-x-hidden w-full">

      {/* ═══════════════════════════════════════════════════════════════
          SNAP CONTAINER — Hero (slide 0) + Gallery (slide 1)
          Fixed position, owns scrolling until user exits
      ═══════════════════════════════════════════════════════════════ */}
      {!snapDone && (
        <div
          ref={snapRef}
          style={{
            position:               'fixed',
            inset:                  0,
            overflowY:              'scroll',
            scrollSnapType:         'y mandatory',
            scrollBehavior:         'smooth',
            WebkitOverflowScrolling: 'touch',
            overscrollBehaviorY:    'none',
            overflow:               'hidden scroll',
            backgroundColor:        '#0E0E0E',
            zIndex:                 50,
          }}
        >
          {/* ── SLIDE 0: HERO ──────────────────────────────────────── */}
          <HeroSection
            product={product}
            heroImage={heroImage}
            selectedColor={selectedColor}
            setSelectedColor={setSelectedColor}
            selectedSize={selectedSize}
            setSelectedSize={setSelectedSize}
            sizeError={sizeError}
            setSizeError={setSizeError}
            addState={addState}
            atcLabel={atcLabel}
            soldOut={soldOut}
            handleAdd={handleAdd}
            formatPrice={formatPrice}
            collectionLabel={collectionLabel}
            slideIndex={0}
            totalSlides={2}
          />

          {/* ── SLIDE 1: GALLERY ───────────────────────────────────── */}
          <GallerySection
            images={galleryImages}
            productName={product.name}
            onExitSnap={exitSnap}
          />
        </div>
      )}

      {/* Spacer — pushes normal content below the viewport while snap is active */}
      {!snapDone && (
        <div style={{ height: '200svh' }} aria-hidden="true" />
      )}

      {/* ═══════════════════════════════════════════════════════════════
          DETAILS SECTION — normal scroll, always in DOM
      ═══════════════════════════════════════════════════════════════ */}
      <div ref={detailsTriggerRef} aria-hidden="true" />

      <DetailsSection
        product={product}
        relatedProduct={relatedProduct}
        selectedColor={selectedColor}
        setSelectedColor={setSelectedColor}
        selectedSize={selectedSize}
        setSelectedSize={setSelectedSize}
        sizeError={sizeError}
        setSizeError={setSizeError}
        addState={addState}
        atcLabel={atcLabel}
        soldOut={soldOut}
        handleAdd={handleAdd}
        formatPrice={formatPrice}
        t={t}
      />

      {/* Sticky ATC */}
      <StickyATC
        product={product}
        selectedColor={selectedColor}
        selectedSize={selectedSize}
        addState={addState}
        atcLabel={atcLabel}
        soldOut={soldOut}
        handleAdd={handleAdd}
        formatPrice={formatPrice}
        visible={stickyVisible}
        t={t}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  HERO SECTION
// ─────────────────────────────────────────────────────────────────────────────
function HeroSection({
  product, heroImage, selectedColor, setSelectedColor,
  selectedSize, setSelectedSize, sizeError, setSizeError,
  addState, atcLabel, soldOut, handleAdd, formatPrice, collectionLabel,
  slideIndex, totalSlides,
}: any) {
  return (
    <section
      style={{
        scrollSnapAlign: 'start',
        scrollSnapStop:  'always',
        height:          '100svh',
        minHeight:       '100svh',
        position:        'relative',
        overflow:        'hidden',
        backgroundColor: '#0E0E0E',
      }}
      aria-label={`${product.name} — hero`}
    >
      {/* Full-bleed product image */}
      {heroImage?.src ? (
        <Image
          src={heroImage.src}
          alt={heroImage.alt || product.name}
          fill priority fetchPriority="high"
          sizes="(max-width: 1024px) 100vw, 65vw"
          className="object-contain object-center md:object-[48%_center]"
          style={{ objectFit: 'contain' }}
          quality={92}
          onError={() => {}}
        />
      ) : (
        <div className="absolute inset-0 bg-[#1A1A1A]" />
      )}

      {/* Right-side gradient panel on desktop */}
      <div
        className="hidden lg:block absolute inset-y-0 right-0 w-[38%]"
        style={{ background: 'linear-gradient(to right, transparent 0%, rgba(14,14,14,0.82) 35%, rgba(14,14,14,0.95) 100%)' }}
        aria-hidden="true"
      />

      {/* Bottom gradient — mobile */}
      <div
        className="lg:hidden absolute inset-x-0 bottom-0 h-[70%]"
        style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.5) 40%, transparent 100%)' }}
        aria-hidden="true"
      />

      {/* Slide indicator (same style as homepage) */}
      <div className="fixed left-4 md:left-7 top-1/2 -translate-y-1/2 z-[195] flex flex-col gap-[5px]">
        {Array.from({ length: totalSlides }, (_, i) => (
          <div key={i} style={{
            width: '2px', height: i === slideIndex ? '26px' : '10px', borderRadius: '1px',
            backgroundColor: i === slideIndex ? 'rgba(240,237,232,0.9)' : 'rgba(240,237,232,0.22)',
            transition: 'height 0.45s cubic-bezier(0.25,0.46,0.45,0.94)',
          }} />
        ))}
      </div>

      {/* ── Mobile: bottom copy ── */}
      <div className="lg:hidden absolute bottom-0 left-0 right-0 px-6 pb-8 pt-12">
        <HeroCopy
          product={product} selectedColor={selectedColor} setSelectedColor={setSelectedColor}
          selectedSize={selectedSize} setSelectedSize={setSelectedSize}
          sizeError={sizeError} setSizeError={setSizeError}
          addState={addState} atcLabel={atcLabel} soldOut={soldOut}
          handleAdd={handleAdd} formatPrice={formatPrice}
          collectionLabel={collectionLabel} dark
        />
        <div className="flex items-center gap-2 mt-5 opacity-40" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 3v6M4.5 7l2.5 2.5L9.5 7" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[10px] font-light tracking-[0.14em] uppercase text-white">Swipe to explore</span>
        </div>
      </div>

      {/* ── Desktop: right panel ── */}
      <div className="hidden lg:flex absolute inset-y-0 right-0 w-[38%] flex-col justify-end pb-14 px-12 xl:px-16">
        <HeroCopy
          product={product} selectedColor={selectedColor} setSelectedColor={setSelectedColor}
          selectedSize={selectedSize} setSelectedSize={setSelectedSize}
          sizeError={sizeError} setSizeError={setSizeError}
          addState={addState} atcLabel={atcLabel} soldOut={soldOut}
          handleAdd={handleAdd} formatPrice={formatPrice}
          collectionLabel={collectionLabel} dark
        />
        <div className="flex items-center gap-2 mt-6 opacity-35" aria-hidden="true">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M7 3v6M4.5 7l2.5 2.5L9.5 7" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
          <span className="text-[10px] font-light tracking-[0.14em] uppercase text-white">Scroll to explore</span>
        </div>
      </div>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  HERO COPY — shared between mobile and desktop
// ─────────────────────────────────────────────────────────────────────────────
function HeroCopy({
  product, selectedColor, setSelectedColor,
  selectedSize, setSelectedSize, sizeError, setSizeError,
  addState, atcLabel, soldOut, handleAdd, formatPrice, collectionLabel, dark,
}: any) {
  return (
    <div className="space-y-5">
      {/* Eyebrow */}
      <p className="text-[10px] font-light tracking-[0.22em] uppercase text-[#F0EDE8]/50">
        {collectionLabel}
      </p>

      {/* Title */}
      <h1 className="font-display font-light text-[28px] md:text-[34px] leading-[0.9] tracking-[-0.025em] text-white">
        {product.name}
      </h1>

      {/* Price */}
      <p className="text-[22px] font-light text-white/90 tabular-nums">
        {formatPrice(product.price)}
      </p>

      {/* Specs — short 3-line summary */}
      <div className="space-y-0.5">
        {(product.constructionDetails ?? []).slice(0, 3).map((line: string, i: number) => (
          <p key={i} className="text-[12px] font-light text-[#F0EDE8]/55 leading-relaxed">{line}</p>
        ))}
      </div>

      {/* Color swatches */}
      {product.colors.length > 1 && (
        <div className="flex gap-2">
          {product.colors.map((col: ColorOption) => (
            <button
              key={col.value} title={col.name} aria-label={col.name}
              aria-pressed={col.value === selectedColor.value}
              onClick={() => setSelectedColor(col)}
              className={cn(
                'w-6 h-6 rounded-full border-2 transition-all duration-150',
                col.value === selectedColor.value ? 'border-white scale-110' : 'border-transparent hover:border-white/50'
              )}
              style={{ backgroundColor: col.hex }}
            />
          ))}
        </div>
      )}

      {/* Size selector — white-outlined on dark bg */}
      <div>
        <p className={cn(
          'text-[10px] font-light tracking-[0.1em] uppercase mb-2',
          sizeError ? 'text-[#FF6B6B]' : 'text-[#F0EDE8]/50'
        )}>
          {sizeError ? 'Select a size' : 'Size'}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {product.sizes.map((size: SizeOption) => (
            <button
              key={size.value}
              disabled={!size.inStock}
              onClick={() => { setSelectedSize(size.label); setSizeError(false) }}
              className={cn(
                'h-9 w-10 text-[11px] font-light border transition-all duration-150',
                !size.inStock
                  ? 'border-white/10 text-white/20 cursor-not-allowed'
                  : selectedSize === size.label
                  ? 'border-white bg-white text-[#0E0E0E]'
                  : 'border-white/35 text-white/80 hover:border-white'
              )}
            >
              {size.label}
            </button>
          ))}
        </div>
      </div>

      {/* Add to bag */}
      <button
        disabled={soldOut || addState === 'loading'}
        onClick={handleAdd}
        className={cn(
          'h-12 px-10 text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
          soldOut             ? 'bg-white/10 text-white/30 cursor-not-allowed'
          : addState === 'added' ? 'bg-[#15803D] text-white'
          : 'bg-white text-[#0E0E0E] hover:bg-[#F0EDE8]'
        )}
      >
        {atcLabel}
      </button>

      {product.founderNote && (
        <p className="text-[11px] text-[#F0EDE8]/30 leading-relaxed">{product.founderNote}</p>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  GALLERY SECTION (snap slide 2)
// ─────────────────────────────────────────────────────────────────────────────
function GallerySection({ images, productName, onExitSnap }: {
  images:        any[]
  productName:   string
  onExitSnap:    () => void
}) {
  const [active, setActive] = useState(0)
  const [imgOffset, setImgOffset] = useState(0)
  const [dragging, setDragging]   = useState(false)
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const isHoriz     = useRef<boolean | null>(null)
  const mouseStartX = useRef<number | null>(null)
  const mouseDown   = useRef(false)

  const total = images.length
  const go = useCallback((dir: 1 | -1) => {
    setActive(i => Math.max(0, Math.min(total - 1, i + dir)))
    setImgOffset(0); setDragging(false)
  }, [total])

  const onTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
    touchStartY.current = e.touches[0].clientY
    isHoriz.current = null
  }
  const onTouchMove = (e: React.TouchEvent) => {
    if (!touchStartX.current || !touchStartY.current) return
    const dx = e.touches[0].clientX - touchStartX.current
    const dy = e.touches[0].clientY - touchStartY.current
    if (isHoriz.current === null && (Math.abs(dx) > 5 || Math.abs(dy) > 5)) {
      isHoriz.current = Math.abs(dx) > Math.abs(dy)
    }
    if (isHoriz.current) { e.preventDefault(); setImgOffset(dx * 0.45); setDragging(true) }
  }
  const onTouchEnd = () => {
    if (isHoriz.current) {
      if (imgOffset < -55)     go(1)
      else if (imgOffset > 55) go(-1)
    }
    touchStartX.current = touchStartY.current = null
    isHoriz.current = null; setDragging(false); setImgOffset(0)
  }
  const onMouseDown  = (e: React.MouseEvent) => { mouseStartX.current = e.clientX; mouseDown.current = true }
  const onMouseMove  = (e: React.MouseEvent) => {
    if (!mouseDown.current || !mouseStartX.current) return
    const dx = e.clientX - mouseStartX.current
    if (Math.abs(dx) > 5) setDragging(true)
    setImgOffset(dx * 0.4)
  }
  const onMouseUp    = (e: React.MouseEvent) => {
    if (!mouseStartX.current) return
    const dx = e.clientX - mouseStartX.current
    if (dx < -65) go(1); else if (dx > 65) go(-1)
    mouseStartX.current = null; mouseDown.current = false
    setDragging(false); setImgOffset(0)
  }
  const onMouseLeave = () => {
    mouseStartX.current = null; mouseDown.current = false
    setDragging(false); setImgOffset(0)
  }

  const cur = images[active]

  return (
    <section
      style={{
        scrollSnapAlign: 'start',
        scrollSnapStop:  'always',
        height:          '100svh',
        minHeight:       '100svh',
        position:        'relative',
        overflow:        'hidden',
        backgroundColor: '#0E0E0E',
        display:         'flex',
        flexDirection:   'column',
        justifyContent:  'center',
      }}
      aria-label={`${productName} — gallery`}
    >
      <div className="container-kvrn h-full flex flex-col justify-center py-8">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_48px] gap-4 h-full max-h-[85svh] items-center">

          {/* Main image */}
          <div
            role="region"
            aria-label={`Image ${active + 1} of ${total}`}
            onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
            onMouseDown={onMouseDown}   onMouseMove={onMouseMove}
            onMouseUp={onMouseUp}       onMouseLeave={onMouseLeave}
            className={cn(
              'relative overflow-hidden bg-[#111] h-full select-none',
              dragging ? 'cursor-grabbing' : 'cursor-grab'
            )}
            style={{ touchAction: 'pan-y', minHeight: 0 }}
          >
            {cur?.src ? (
              <Image
                key={cur.src + active}
                src={cur.src}
                alt={cur.alt || productName}
                fill
                sizes="(max-width: 1024px) 100vw, 80vw"
                className="object-contain pointer-events-none"
                loading="lazy"
                onError={() => {}}
                style={{
                  transform:  `translateX(${imgOffset}px)`,
                  transition: Math.abs(imgOffset) < 3
                    ? 'transform 0.4s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none',
                }}
              />
            ) : (
              <div className="absolute inset-0 bg-[#1A1A1A]" />
            )}

            {/* Ghost prev/next hit areas */}
            <button onClick={() => go(-1)} aria-label="Previous image" disabled={active === 0}
              className={cn('absolute left-0 top-0 bottom-0 w-1/4 group flex items-center justify-start pl-4',
                active === 0 && 'pointer-events-none')}>
              <span className={cn('w-9 h-9 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center transition-opacity', active === 0 ? 'opacity-0' : 'opacity-0 group-hover:opacity-100')}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M8 2L4 6l4 4" stroke="white" strokeWidth="1.3" strokeLinecap="round"/></svg>
              </span>
            </button>
            <button onClick={() => go(1)} aria-label="Next image" disabled={active === total - 1}
              className={cn('absolute right-0 top-0 bottom-0 w-1/4 group flex items-center justify-end pr-4',
                active === total - 1 && 'pointer-events-none')}>
              <span className={cn('w-9 h-9 rounded-full bg-black/40 backdrop-blur-sm flex items-center justify-center transition-opacity', active === total - 1 ? 'opacity-0' : 'opacity-0 group-hover:opacity-100')}>
                <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M4 2l4 4-4 4" stroke="white" strokeWidth="1.3" strokeLinecap="round"/></svg>
              </span>
            </button>
          </div>

          {/* Vertical luxury numbering — desktop */}
          <div className="hidden lg:flex flex-col justify-center items-center gap-3"
            role="tablist" aria-label="Gallery position">
            {Array.from({ length: total }, (_, i) => (
              <button key={i} role="tab" aria-selected={i === active}
                onClick={() => setActive(i)}
                className="transition-all duration-300"
                style={{
                  fontFamily:    'inherit',
                  fontSize:      '10px',
                  fontWeight:    300,
                  letterSpacing: '0.1em',
                  color:         i === active ? 'rgba(240,237,232,0.95)' : 'rgba(240,237,232,0.22)',
                  lineHeight:    1,
                }}
              >
                {String(i + 1).padStart(2, '0')}
              </button>
            ))}
          </div>

          {/* Mobile: image counter */}
          <div className="lg:hidden absolute bottom-16 right-4 text-[11px] font-light text-[#F0EDE8]/50 tabular-nums" aria-hidden="true">
            {String(active + 1).padStart(2, '0')} / {String(total).padStart(2, '0')}
          </div>
        </div>
      </div>

      {/* Scroll-down cue → exit snap */}
      <button
        onClick={onExitSnap}
        className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 opacity-40 hover:opacity-70 transition-opacity"
        aria-label="View product details"
      >
        <span className="text-[10px] font-light tracking-[0.14em] uppercase text-white">Shop</span>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M7 3v6M4.5 7l2.5 2.5L9.5 7" stroke="white" strokeWidth="1.2" strokeLinecap="round"/>
        </svg>
      </button>
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  DETAILS SECTION — normal vertical scroll
// ─────────────────────────────────────────────────────────────────────────────
function DetailsSection({
  product, relatedProduct, selectedColor, setSelectedColor,
  selectedSize, setSelectedSize, sizeError, setSizeError,
  addState, atcLabel, soldOut, handleAdd, formatPrice, t,
}: any) {
  return (
    <section className="bg-[#F9F8F6] min-h-screen" aria-label="Product details">
      <div className="container-kvrn max-w-4xl py-14 md:py-20">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-10 md:gap-16">

          {/* ── Left: size + ATC ── */}
          <div>
            {/* Product header */}
            <div className="mb-8">
              <p className="text-[10px] font-light tracking-[0.2em] uppercase text-[#9B9B9B] mb-2">
                {product.slug.includes('phantom') ? 'Project KVRN' : 'KVRN'}
              </p>
              <h2 className="font-display font-light text-[26px] md:text-[32px] leading-tight tracking-[-0.02em] mb-2">
                {product.name}
              </h2>
              <p className="text-[20px] font-light tabular-nums">{formatPrice(product.price)}</p>
              {product.founderNote && (
                <p className="text-[12px] text-[#9B9B9B] mt-1">{product.founderNote}</p>
              )}
            </div>

            {/* Color */}
            {product.colors.length > 1 && (
              <div className="mb-6">
                <p className="text-[10px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-3">
                  Color — {selectedColor.name}
                </p>
                <div className="flex gap-2.5 flex-wrap">
                  {product.colors.map((col: ColorOption) => (
                    <button key={col.value} title={col.name} aria-label={col.name}
                      aria-pressed={col.value === selectedColor.value}
                      onClick={() => setSelectedColor(col)}
                      className={cn('w-7 h-7 rounded-full border-2 transition-all',
                        col.value === selectedColor.value ? 'border-[#1A1A1A] scale-110' : 'border-transparent hover:border-[#C8C4BF]')}
                      style={{ backgroundColor: col.hex }} />
                  ))}
                </div>
              </div>
            )}

            {/* Size */}
            <div className="mb-6">
              <div className="flex items-center justify-between mb-3">
                <p className={cn('text-[10px] font-light tracking-[0.1em] uppercase',
                  sizeError ? 'text-[#B91C1C]' : 'text-[#9B9B9B]')}>
                  {sizeError ? 'Select a size' : 'Size'}
                </p>
                <Link href="/support/size-guide"
                  className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors underline underline-offset-2">
                  Size guide
                </Link>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {product.sizes.map((size: SizeOption) => (
                  <button
                    key={size.value}
                    disabled={!size.inStock}
                    onClick={() => { setSelectedSize(size.label); setSizeError(false) }}
                    className={cn(
                      'h-10 w-11 text-[12px] font-light border transition-all duration-150',
                      !size.inStock
                        ? 'border-[#E8E5E0] text-[#C8C4BF] cursor-not-allowed line-through'
                        : selectedSize === size.label
                        ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                        : 'border-[#D5D1CB] text-[#1A1A1A] hover:border-[#1A1A1A]'
                    )}>
                    {size.label}
                  </button>
                ))}
              </div>
              {product.fitNote && (
                <p className="text-[12px] text-[#9B9B9B] mt-2 leading-relaxed">{product.fitNote}</p>
              )}
            </div>

            {/* ATC */}
            <button
              disabled={soldOut || addState === 'loading'}
              onClick={handleAdd}
              className={cn(
                'w-full h-12 mb-4 text-[11px] font-light tracking-[0.14em] uppercase transition-all duration-200',
                soldOut ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
                : addState === 'added' ? 'bg-[#15803D] text-white'
                : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
              )}>
              {atcLabel}
            </button>
          </div>

          {/* ── Right: description + construction + shipping ── */}
          <div className="space-y-0">
            {/* Description */}
            <p className="text-[14px] text-[#6B6B6B] leading-relaxed mb-8">
              {product.description}
            </p>

            {/* Construction */}
            <div className="border-t border-[#E8E5E0] pt-7 pb-7">
              <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#1A1A1A] mb-5">
                Construction
              </p>
              <div className="space-y-1">
                {(product.constructionDetails ?? []).map((line: string, i: number) => (
                  <p key={i} className="text-[14px] font-light text-[#6B6B6B]">{line}</p>
                ))}
              </div>
            </div>

            {/* Shipping & Returns */}
            <div className="border-t border-[#E8E5E0]">
              <details className="group py-5">
                <summary className="flex items-center justify-between cursor-pointer list-none text-[10px] font-light tracking-[0.16em] uppercase">
                  <span>Shipping & Returns</span>
                  <svg width="11" height="7" viewBox="0 0 11 7" fill="none"
                    className="transition-transform duration-200 group-open:rotate-180 flex-shrink-0">
                    <path d="M1 1l4.5 4.5L10 1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
                  </svg>
                </summary>
                <div className="mt-4 space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
                  <p>Orders processed within 1–3 business days.</p>
                  <p>US: 2–7 business days. International: 5–14+ business days.</p>
                  <p>Returns accepted within 14 days, unworn and in original condition.</p>
                  <Link href="/support/shipping-returns"
                    className="text-[#1A1A1A] underline underline-offset-2 text-[12px] hover:opacity-60 transition-opacity">
                    Full policy
                  </Link>
                </div>
              </details>
            </div>

            {/* Complete the Set — premium editorial */}
            {relatedProduct && (
              <div className="border-t border-[#E8E5E0] pt-8 mt-2">
                <p className="text-[10px] font-light tracking-[0.16em] uppercase text-[#9B9B9B] mb-6">
                  Complete the Set
                </p>
                <div className="flex gap-5 items-start">
                  {/* Large thumbnail */}
                  <Link href={`/products/${relatedProduct.slug}`}
                    className="relative flex-shrink-0 w-24 h-32 bg-[#F0EDE8] overflow-hidden block hover:opacity-80 transition-opacity">
                    {relatedProduct.colors[0]?.images[0]?.src ? (
                      <Image src={relatedProduct.colors[0].images[0].src}
                        alt={relatedProduct.name} fill sizes="96px"
                        className="object-cover" loading="lazy" onError={() => {}} />
                    ) : <div className="absolute inset-0 bg-[#E8E5E0]" />}
                  </Link>
                  <div className="flex-1 pt-1">
                    <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-1">
                      {relatedProduct.name.includes('Hoodie') ? 'Matching Hoodie' : 'Matching Sweatpants'}
                    </p>
                    <p className="text-[15px] font-light text-[#1A1A1A] mb-0.5">
                      {relatedProduct.name}
                    </p>
                    <p className="text-[14px] font-light text-[#6B6B6B] mb-4 tabular-nums">
                      {formatPrice(relatedProduct.price)}
                    </p>
                    <p className="text-[12px] text-[#9B9B9B] leading-relaxed mb-5">
                      Same fabric. Same weight. Designed to be worn together.
                    </p>
                    <Link href={`/products/${relatedProduct.slug}`}
                      className="inline-flex items-center h-10 px-6 border border-[#1A1A1A] text-[10px] font-light tracking-[0.14em] uppercase text-[#1A1A1A] hover:bg-[#1A1A1A] hover:text-white transition-all duration-200">
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
  )
}

// ─────────────────────────────────────────────────────────────────────────────
//  STICKY ATC
// ─────────────────────────────────────────────────────────────────────────────
function StickyATC({ product, selectedColor, selectedSize, addState, atcLabel, soldOut, handleAdd, formatPrice, visible, t }: any) {
  return (
    <div
      className={cn(
        'fixed bottom-0 left-0 right-0 z-[200] overflow-hidden',
        'bg-white border-t border-[#E8E5E0]',
        'transition-transform duration-300',
        visible ? 'translate-y-0 shadow-[0_-4px_20px_rgba(0,0,0,0.06)]' : 'translate-y-full'
      )}
      aria-hidden={!visible}
    >
      <div className="container-kvrn max-w-4xl py-3 flex items-center gap-4">
        <div className="flex-1 min-w-0 flex items-center gap-3">
          <span className="w-4 h-4 rounded-full flex-shrink-0 border border-[#E8E5E0]"
            style={{ backgroundColor: selectedColor.hex }} aria-hidden="true" />
          <div className="min-w-0">
            <p className="text-[12px] font-light text-[#1A1A1A] truncate leading-tight">{product.name}</p>
            <p className="text-[11px] text-[#9B9B9B] leading-tight mt-0.5">
              {selectedColor.name}{selectedSize ? ` · ${selectedSize}` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-shrink-0">
          <span className="text-[13px] font-light tabular-nums hidden sm:block">{formatPrice(product.price)}</span>
          <button
            disabled={soldOut || addState === 'loading'}
            onClick={handleAdd}
            className={cn(
              'h-10 px-6 text-[11px] font-light tracking-[0.1em] uppercase transition-all duration-150',
              soldOut ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
              : addState === 'added' ? 'bg-[#15803D] text-white'
              : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
            )}>
            {soldOut ? t.soldOut : addState === 'added' ? t.addedToBag : t.addToBag}
          </button>
        </div>
      </div>
    </div>
  )
}
