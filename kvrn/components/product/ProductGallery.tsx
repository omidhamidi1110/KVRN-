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
  const [dragDelta, setDragDelta] = useState(0)
  const touchStartX = useRef<number | null>(null)
  const mouseStartX = useRef<number | null>(null)
  const isDragging  = useRef(false)

  useEffect(() => { setActive(0) }, [images])

  const go = useCallback((dir: 1 | -1) => {
    setActive(i => Math.max(0, Math.min(images.length - 1, i + dir)))
  }, [images.length])

  // ── Touch ──────────────────────────────────────────────────────────────────
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
  }, [])

  const onTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartX.current === null) return
    setDragDelta(e.touches[0].clientX - touchStartX.current)
  }, [])

  const onTouchEnd = useCallback(() => {
    if (touchStartX.current === null) return
    if (dragDelta < -50) go(1)
    else if (dragDelta > 50) go(-1)
    touchStartX.current = null
    setDragDelta(0)
  }, [dragDelta, go])

  // ── Mouse drag (desktop Gucci-style) ───────────────────────────────────────
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    mouseStartX.current = e.clientX
    isDragging.current  = false
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (mouseStartX.current === null) return
    const delta = e.clientX - mouseStartX.current
    if (Math.abs(delta) > 5) isDragging.current = true
    setDragDelta(delta)
  }, [])

  const onMouseUp = useCallback((e: React.MouseEvent) => {
    if (mouseStartX.current === null) return
    const delta = e.clientX - mouseStartX.current
    if (delta < -60) go(1)
    else if (delta > 60) go(-1)
    mouseStartX.current = null
    setDragDelta(0)
    isDragging.current = false
  }, [go])

  const onMouseLeave = useCallback(() => {
    mouseStartX.current = null
    setDragDelta(0)
    isDragging.current = false
  }, [])

  // ── Keyboard ───────────────────────────────────────────────────────────────
  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight') go(1)
    if (e.key === 'ArrowLeft')  go(-1)
  }, [go])

  // Visual offset while dragging
  const DRAG_THRESHOLD = 0.15  // max 15% of container width
  const imgOffset = Math.max(-120, Math.min(120, dragDelta * 0.4))

  const current = images[active]

  return (
    <div className="flex flex-col gap-3 select-none">

      {/* Main image area */}
      <div
        role="region"
        aria-label={`${productName} images — swipe or drag to navigate`}
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
          'relative aspect-[3/4] bg-[#F0EDE8] overflow-hidden',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[#1A1A1A]',
          isDragging.current ? 'cursor-grabbing' : 'cursor-grab'
        )}
        style={{ userSelect: 'none', WebkitUserSelect: 'none' }}
      >
        {/* Current image */}
        {current?.src ? (
          <Image
            key={current.src}
            src={current.src}
            alt={current.alt}
            fill priority={active === 0}
            sizes="(max-width: 1024px) 100vw, 55vw"
            className="object-cover transition-opacity duration-200 pointer-events-none"
            quality={92}
            draggable={false}
            style={{
              transform:  `translateX(${imgOffset}px)`,
              transition: Math.abs(dragDelta) < 5 ? 'transform 0.35s cubic-bezier(0.25,0.46,0.45,0.94)' : 'none',
            }}
          />
        ) : (
          <div
            className="absolute inset-0 flex items-end p-6"
            style={{ background: 'linear-gradient(145deg, #F2EFE9 0%, #E8E4DC 100%)' }}
          >
            <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">
              {productName} — {colorName}
            </p>
          </div>
        )}

        {/* Prev/next ghost hit areas — desktop */}
        <button
          onClick={() => go(-1)}
          aria-label="Previous image"
          className={cn(
            'absolute left-0 top-0 bottom-0 w-1/3 flex items-center justify-start pl-3',
            'opacity-0 hover:opacity-100 transition-opacity duration-200',
            active === 0 && 'pointer-events-none'
          )}
        >
          <span className={cn(
            'w-8 h-8 rounded-full bg-white/80 backdrop-blur-sm flex items-center justify-center shadow-sm',
            'transition-all duration-150 hover:bg-white'
          )}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M8 2L4 6l4 4" stroke="#1A1A1A" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </span>
        </button>

        <button
          onClick={() => go(1)}
          aria-label="Next image"
          className={cn(
            'absolute right-0 top-0 bottom-0 w-1/3 flex items-center justify-end pr-3',
            'opacity-0 hover:opacity-100 transition-opacity duration-200',
            active === images.length - 1 && 'pointer-events-none'
          )}
        >
          <span className={cn(
            'w-8 h-8 rounded-full bg-white/80 backdrop-blur-sm flex items-center justify-center shadow-sm',
            'transition-all duration-150 hover:bg-white'
          )}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
              <path d="M4 2l4 4-4 4" stroke="#1A1A1A" strokeWidth="1.3" strokeLinecap="round"/>
            </svg>
          </span>
        </button>

        {/* Counter badge */}
        {images.length > 1 && (
          <div
            className="absolute bottom-3 right-3 px-2 py-1 bg-black/40 backdrop-blur-sm text-[10px] font-light text-white tracking-[0.08em]"
            aria-hidden="true"
          >
            {active + 1} / {images.length}
          </div>
        )}

        {/* Dot strip — mobile */}
        {images.length > 1 && (
          <div className="absolute bottom-3 left-0 right-0 flex justify-center gap-1 md:hidden" aria-hidden="true">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={cn(
                  'rounded-full transition-all duration-200',
                  i === active
                    ? 'w-5 h-1 bg-white'
                    : 'w-1 h-1 bg-white/40'
                )}
              />
            ))}
          </div>
        )}

        <span className="sr-only" aria-live="polite">
          Image {active + 1} of {images.length}{current ? `: ${current.alt}` : ''}
        </span>
      </div>

      {/* Thumbnails — desktop */}
      {images.length > 1 && (
        <div className="hidden md:flex gap-2 overflow-x-auto pb-1" aria-label="Image thumbnails">
          {images.map((img, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              aria-label={`Image ${i + 1}${img.alt ? `: ${img.alt}` : ''}`}
              aria-current={i === active}
              className={cn(
                'relative flex-shrink-0 w-[68px] h-[90px] overflow-hidden bg-[#F0EDE8]',
                'transition-all duration-200',
                i === active
                  ? 'ring-1 ring-[#1A1A1A]'
                  : 'opacity-45 hover:opacity-75'
              )}
            >
              {img.src ? (
                <Image src={img.src} alt="" fill sizes="68px" className="object-cover" draggable={false} />
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
