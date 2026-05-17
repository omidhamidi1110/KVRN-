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
  const [active, setActive] = useState(0)
  const touchStart = useRef<number | null>(null)

  useEffect(() => { setActive(0) }, [images])

  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStart.current = e.touches[0].clientX
  }, [])

  const onTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStart.current === null) return
    const delta = e.changedTouches[0].clientX - touchStart.current
    if (delta < -50 && active < images.length - 1) setActive(i => i + 1)
    if (delta >  50 && active > 0)                 setActive(i => i - 1)
    touchStart.current = null
  }, [active, images.length])

  const onKey = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowRight' && active < images.length - 1) setActive(i => i + 1)
    if (e.key === 'ArrowLeft'  && active > 0)                 setActive(i => i - 1)
  }, [active, images.length])

  const current = images[active]

  return (
    <div className="flex flex-col gap-3">

      {/* Main image */}
      <div
        role="region"
        aria-label={`${productName} images`}
        tabIndex={0}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onKeyDown={onKey}
        className="relative aspect-[3/4] bg-[var(--color-bg-raised)] overflow-hidden select-none focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-text)]"
      >
        {current?.src ? (
          <Image
            key={current.src}
            src={current.src}
            alt={current.alt}
            fill
            priority={active === 0}
            sizes="(max-width: 1024px) 100vw, 55vw"
            className="object-cover transition-opacity duration-300"
            quality={92}
          />
        ) : (
          /* Clean color-tinted placeholder — no instructional text */
          <div
            className="absolute inset-0 flex items-end p-6"
            style={{ background: 'linear-gradient(145deg, #F2EFE9 0%, #E8E4DC 100%)' }}
          >
            <p className="kvrn-label text-[var(--color-subtle)]">
              {productName} — {colorName}
            </p>
          </div>
        )}

        {/* Mobile dot indicators */}
        {images.length > 1 && (
          <div className="absolute bottom-4 left-0 right-0 flex justify-center gap-1.5 md:hidden" aria-hidden="true">
            {images.map((_, i) => (
              <button
                key={i}
                onClick={() => setActive(i)}
                className={cn(
                  'rounded-full transition-all duration-200',
                  i === active
                    ? 'w-4 h-1 bg-[var(--color-text)]'
                    : 'w-1 h-1 bg-[var(--color-text)]/30'
                )}
              />
            ))}
          </div>
        )}

        <span className="sr-only" aria-live="polite">
          Image {active + 1} of {images.length}{current ? `: ${current.alt}` : ''}
        </span>
      </div>

      {/* Thumbnails — desktop only */}
      {images.length > 1 && (
        <div className="hidden md:flex gap-2 overflow-x-auto scrollbar-thin pb-1" aria-label="Image thumbnails">
          {images.map((img, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              aria-label={`View image ${i + 1}${img.alt ? `: ${img.alt}` : ''}`}
              aria-current={i === active}
              className={cn(
                'relative flex-shrink-0 w-[68px] h-[90px] overflow-hidden bg-[var(--color-bg-raised)]',
                'transition-all duration-150',
                i === active
                  ? 'ring-1 ring-[var(--color-text)]'
                  : 'opacity-50 hover:opacity-80'
              )}
            >
              {img.src ? (
                <Image src={img.src} alt="" fill sizes="68px" className="object-cover" />
              ) : (
                <div className="absolute inset-0 bg-[var(--color-bg-raised)]" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
