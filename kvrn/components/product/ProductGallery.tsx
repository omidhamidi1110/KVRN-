'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import type { ProductImage } from '@/types'

interface ProductGalleryProps {
  images:      ProductImage[]
  productName: string
  colorName:   string
}

export function ProductGallery({ images, productName, colorName }: ProductGalleryProps) {
  const [active,    setActive]    = useState(0)
  const [dragging,  setDragging]  = useState(false)
  const [imgOffset, setImgOffset] = useState(0)

  // Touch refs
  const touchStartX = useRef<number | null>(null)
  const touchStartY = useRef<number | null>(null)
  const isHorizontal = useRef<boolean | null>(null)  // null = undecided, true = horiz, false = vert

  // Mouse refs
  const mouseStartX  = useRef<number | null>(null)
  const mouseDown    = useRef(false)

  useEffect(() => { setActive(0) }, [images])

  const go = useCallback((dir: 1 | -1) => {
    setActive(i => Math.max(0, Math.min(images.length - 1, i + dir)))
    setImgOffset(0)
  }, [images.length])

  // ── Touch handlers ────────────────────────────────────────────────────────
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current  = e.touches[0].clientX
    touchStartY.current  = e.touches[0].clientY
    isHorizontal.current = null   // direction undecided
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return
    const dx = e.touches[0].clientX - touchStartX.current
    const dy = e.touches[0].clientY - touchStartY.current

    // Decide direction on first significant movement
    if (isHorizontal.current === null && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
      isHorizontal.current = Math.abs(dx) > Math.abs(dy)
    }

    if (isHorizontal.current) {
      // Captured horizontal — prevent page scroll
      e.preventDefault()
      setImgOffset(dx * 0.4)  // subtle follow
      setDragging(true)
    }
    // If vertical, do nothing — let the page scroll naturally
  }, [])

  const onTouchEnd = useCallback(() => {
    if (isHorizontal.current && touchStartX.current !== null) {
      const dx = imgOffset / 0.4  // recover original delta
      if (dx < -50) go(1)
      else if (dx > 50) go(-1)
    }
    touchStartX.current  = null
    touchStartY.current  = null
    isHorizontal.current = null
    setDragging(false)
    setImgOffset(0)
  }, [imgOffset, go])

  // ── Mouse drag (desktop) ──────────────────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    mouseStartX.current = e.clientX
    mouseDown.current   = true
    setDragging(false)
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!mouseDown.current || mouseStartX.current === null) return
    const dx = e.clientX - mouseStartX.current
    if (Math.abs(dx) > 5) setDragging(true)
    setImgOffset(dx * 0.35)
  }, [])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (mouseStartX.current === null) return
    const dx = e.clientX - mouseStartX.current
    if (dx < -60) go(1)
    else if (dx > 60) go(-1)
    mouseStartX.current = null
    mouseDown.current   = false
    setDragging(false)
    setImgOffset(0)
  }, [go])

  const onMouseLeave = useCallback(() => {
    mouseStartX.current = null
    mouseDown.current   = false
    setDragging(false)
    setImgOffset(0)
  }, [])

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(1)
    if (e.key === 'ArrowLeft')  go(-1)
  }, [go])

  const current = images[active]

  return (
    // overflow-hidden here prevents any gallery content from causing page overflow
    <div className="flex flex-col gap-3 select-none overflow-hidden">

      {/* Main image area */}
      <div
        role="region"
        aria-label={`${productName} — image ${active + 1} of ${images.length}`}
        tabIndex={0}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onKeyDown={onKey}
        className={cn(
          'relative bg-[#F0EDE8] overflow-hidden w-full',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#1A1A1A]',
          dragging ? 'cursor-grabbing' : 'cursor-grab'
        )}
        style={{
          aspectRatio:    '3/4',
          // touch-action: pan-y allows vertical scrolling but lets us capture horizontal
          touchAction:    'pan-y',
          userSelect:     'none',
          WebkitUserSelect: 'none',
        }}
      >
        {current?.src ? (
          <Image
            key={current.src + active}
            src={current.src}
            alt={current.alt || `${productName} — ${colorName}`}
            fill
            priority={active === 0}
            sizes="(max-width: 1024px) 100vw, 55vw"
            className="object-cover pointer-events-none"
            quality={90}
            onError={() => {}}  // fail gracefully if image missing
            draggable={false}
            style={{
              transform:  `translateX(${imgOffset}px)`,
              transition: Math.abs(imgOffset) < 3
                ? 'transform 0.35s cubic-bezier(0.25,0.46,0.45,0.94)'
                : 'none',
            }}
          />
        ) : (
          <div className="absolute inset-0 flex items-end p-4"
            style={{ background: 'linear-gradient(145deg,#F2EFE9 0%,#E8E4DC 100%)' }}>
            <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">
              {productName} — {colorName}
            </p>
          </div>
        )}

        {/* Prev/Next ghost buttons */}
        <button onClick={() => go(-1)} aria-label="Previous image"
          className={cn(
            'absolute left-0 top-0 bottom-0 w-1/3 flex items-center justify-start pl-3',
            'opacity-0 hover:opacity-100 transition-opacity duration-150',
            active === 0 && 'pointer-events-none'
          )}>
          <span className="w-8 h-8 rounded-full bg-white/80 backdrop-blur-sm shadow-sm flex items-center justify-center hover:bg-white transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M8 2L4 6l4 4" stroke="#1A1A1A" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </span>
        </button>

        <button onClick={() => go(1)} aria-label="Next image"
          className={cn(
            'absolute right-0 top-0 bottom-0 w-1/3 flex items-center justify-end pr-3',
            'opacity-0 hover:opacity-100 transition-opacity duration-150',
            active === images.length - 1 && 'pointer-events-none'
          )}>
          <span className="w-8 h-8 rounded-full bg-white/80 backdrop-blur-sm shadow-sm flex items-center justify-center hover:bg-white transition-colors">
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M4 2l4 4-4 4" stroke="#1A1A1A" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </span>
        </button>

        {/* Counter badge */}
        {images.length > 1 && (
          <div className="absolute bottom-3 right-3 px-2 py-1 bg-black/35 backdrop-blur-sm text-[10px] font-light text-white tracking-wide" aria-hidden="true">
            {active + 1} / {images.length}
          </div>
        )}

        {/* Mobile dot strip */}
        {images.length > 1 && (
          <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-1 md:hidden" aria-hidden="true">
            {images.map((_, i) => (
              <button key={i} onClick={() => setActive(i)}
                className={cn('rounded-full transition-all duration-200', i === active ? 'w-5 h-1 bg-white' : 'w-1 h-1 bg-white/40')}
              />
            ))}
          </div>
        )}

        <span className="sr-only" aria-live="polite">
          Image {active + 1} of {images.length}{current?.alt ? `: ${current.alt}` : ''}
        </span>
      </div>

      {/* Thumbnails — desktop only */}
      {images.length > 1 && (
        <div className="hidden md:flex gap-2 overflow-x-auto pb-1" aria-label="Image thumbnails">
          {images.map((img, i) => (
            <button key={i} onClick={() => setActive(i)}
              aria-label={`Image ${i + 1}`} aria-current={i === active}
              className={cn(
                'relative flex-shrink-0 w-[68px] h-[90px] overflow-hidden bg-[#F0EDE8] transition-all duration-150',
                i === active ? 'ring-1 ring-[#1A1A1A]' : 'opacity-45 hover:opacity-75'
              )}>
              {img.src ? (
                <Image src={img.src} alt="" fill sizes="68px" className="object-cover" draggable={false} onError={() => {}} />
              ) : (
                <div className="absolute inset-0 bg-[#E8E5E0]" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
