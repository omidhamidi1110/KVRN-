'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Image from 'next/image'
import { cn } from '@/lib/utils'
import type { ProductImage } from '@/types'

interface ProductGalleryProps {
  images:     ProductImage[]
  productName: string
  colorName:  string
}

export function ProductGallery({
  images,
  productName,
  colorName,
}: ProductGalleryProps) {
  const [activeIndex, setActiveIndex] = useState(0)
  const touchStartX  = useRef<number | null>(null)
  const galleryRef   = useRef<HTMLDivElement>(null)

  // Reset to first image when images array changes (color switch)
  useEffect(() => {
    setActiveIndex(0)
  }, [images])

  // Touch/swipe handlers for mobile
  const onTouchStart = useCallback((e: React.TouchEvent) => {
    touchStartX.current = e.touches[0].clientX
  }, [])

  const onTouchEnd = useCallback(
    (e: React.TouchEvent) => {
      if (touchStartX.current === null) return
      const delta = e.changedTouches[0].clientX - touchStartX.current
      const threshold = 50

      if (delta < -threshold && activeIndex < images.length - 1) {
        setActiveIndex((i) => i + 1)
      } else if (delta > threshold && activeIndex > 0) {
        setActiveIndex((i) => i - 1)
      }
      touchStartX.current = null
    },
    [activeIndex, images.length]
  )

  // Keyboard navigation
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'ArrowRight' && activeIndex < images.length - 1) {
        setActiveIndex((i) => i + 1)
      } else if (e.key === 'ArrowLeft' && activeIndex > 0) {
        setActiveIndex((i) => i - 1)
      }
    },
    [activeIndex, images.length]
  )

  const activeImage = images[activeIndex]

  return (
    <div className="flex flex-col gap-3" ref={galleryRef}>
      {/* ─── Main Image ─── */}
      <div
        role="region"
        aria-label={`${productName} product images`}
        aria-roledescription="image gallery"
        tabIndex={0}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onKeyDown={onKeyDown}
        className="relative aspect-[3/4] bg-kvrn-bg-raised overflow-hidden focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-kvrn-text"
      >
        {activeImage ? (
          <Image
            key={`${activeImage.src}-${activeIndex}`}
            src={activeImage.src}
            alt={activeImage.alt}
            fill
            sizes="(max-width: 1024px) 100vw, 55vw"
            className="object-cover"
            priority={activeIndex === 0}
            quality={90}
          />
        ) : (
          /* Placeholder when real images not added yet */
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-kvrn-bg-raised">
            <div
              className="w-16 h-16 rounded-full opacity-20"
              style={{ backgroundColor: '#C8B89A' }}
            />
            <p className="label-11 text-kvrn-subtle text-center px-4">
              {productName}<br />{colorName}
              <br /><br />
              Add product images to<br />
              /public/images/products/
            </p>
          </div>
        )}

        {/* Mobile dot indicators */}
        <div
          className="absolute bottom-4 left-0 right-0 flex justify-center gap-1.5 md:hidden"
          aria-hidden="true"
        >
          {images.map((_, i) => (
            <button
              key={i}
              onClick={() => setActiveIndex(i)}
              className={cn(
                'w-1 h-1 rounded-full transition-all duration-200',
                i === activeIndex ? 'bg-kvrn-text w-3' : 'bg-kvrn-muted/50'
              )}
            />
          ))}
        </div>

        {/* Screen reader navigation */}
        <span className="sr-only" aria-live="polite">
          Image {activeIndex + 1} of {images.length}: {activeImage?.alt}
        </span>
      </div>

      {/* ─── Thumbnail Strip — desktop only ─── */}
      {images.length > 1 && (
        <div
          className="hidden md:flex gap-2 overflow-x-auto scrollbar-thin pb-1"
          aria-label="Image thumbnails"
          role="list"
        >
          {images.map((img, i) => (
            <button
              key={img.src + i}
              onClick={() => setActiveIndex(i)}
              role="listitem"
              aria-label={`View image ${i + 1}: ${img.alt}`}
              aria-current={i === activeIndex}
              className={cn(
                'relative flex-shrink-0 w-[72px] h-[96px] overflow-hidden',
                'bg-kvrn-bg-raised transition-all duration-150',
                i === activeIndex
                  ? 'ring-1 ring-kvrn-text ring-offset-1'
                  : 'opacity-60 hover:opacity-100'
              )}
            >
              {img.src ? (
                <Image
                  src={img.src}
                  alt=""
                  fill
                  sizes="72px"
                  className="object-cover"
                />
              ) : (
                <div className="absolute inset-0 bg-kvrn-bg-raised flex items-center justify-center">
                  <span className="text-[9px] label-11 text-kvrn-subtle text-center px-1">
                    {i + 1}
                  </span>
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
