'use client'

import { useState, useEffect, useRef } from 'react'
import Image from 'next/image'
import { useCart }     from '@/context/CartContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useI18n }     from '@/context/I18nContext'
import { cn }          from '@/lib/utils'
import type { Product, ColorOption, SizeLabel, SizeOption } from '@/types'

interface Props {
  product:  Product
  onClose:  () => void
  initialColor?: string
}

export function QuickAddModal({ product, onClose, initialColor }: Props) {
  const { addItem, openCart } = useCart()
  const { formatPrice }       = useCurrency()
  const { t }                 = useI18n()

  const initColor = product.colors.find(c => c.value === initialColor) ?? product.colors[0]
  const [selectedColor, setSelectedColor] = useState<ColorOption>(initColor)
  const [selectedSize,  setSelectedSize]  = useState<SizeLabel | null>(null)
  const [sizeError,     setSizeError]     = useState(false)
  const [added,         setAdded]         = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = ''
    }
  }, [onClose])

  const handleAdd = () => {
    if (!selectedSize) { setSizeError(true); return }
    const img = selectedColor.images.find(i => i.type === 'front')
    addItem({
      productId: product.id, productName: product.name, slug: product.slug,
      color: selectedColor.value, colorName: selectedColor.name, colorHex: selectedColor.hex,
      size: selectedSize, price: product.price, quantity: 1, image: img?.src ?? '',
    })
    setAdded(true)
    setTimeout(() => { onClose(); openCart() }, 600)
  }

  const frontImg = selectedColor.images.find(i => i.type === 'front')

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-[450] bg-black/50 backdrop-blur-[2px]"
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog" aria-modal="true"
        aria-label={`Quick add: ${product.name}`}
        className="fixed z-[460] left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100vw-32px)] max-w-[440px] bg-[#F9F8F6] shadow-2xl"
      >
        {/* Close */}
        <button
          onClick={onClose}
          aria-label="Close"
          className="absolute top-4 right-4 w-8 h-8 flex items-center justify-center text-[#6B6B6B] hover:text-[#1A1A1A] transition-colors z-10"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path d="M2 2l12 12M14 2L2 14" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"/>
          </svg>
        </button>

        <div className="flex gap-4 p-5 pb-4">
          {/* Thumbnail */}
          <div className="relative w-[80px] h-[107px] flex-shrink-0 bg-[#F0EDE8] overflow-hidden">
            {frontImg?.src
              ? <Image src={frontImg.src} alt={frontImg.alt} fill sizes="80px" className="object-cover" />
              : <div className="absolute inset-0" style={{ backgroundColor: selectedColor.hex + '20' }} />
            }
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0 pt-0.5">
            <p className="text-[14px] font-light leading-snug">{product.name}</p>
            <p className="text-[14px] font-light tabular-nums mt-0.5">{formatPrice(product.price)}</p>
            {product.founderNote && (
              <p className="text-[11px] text-[#9B9B9B] mt-1 leading-snug">{product.founderNote}</p>
            )}
          </div>
        </div>

        <div className="px-5 pb-5 space-y-4">
          {/* Color */}
          {product.colors.length > 1 && (
            <div>
              <p className="text-[11px] font-light tracking-[0.09em] uppercase text-[#9B9B9B] mb-2">
                Color — {selectedColor.name}
              </p>
              <div className="flex gap-2">
                {product.colors.map(c => (
                  <button
                    key={c.value} title={c.name} aria-label={c.name}
                    aria-pressed={c.value === selectedColor.value}
                    onClick={() => setSelectedColor(c)}
                    className={cn(
                      'w-5 h-5 rounded-full transition-all',
                      c.value === selectedColor.value
                        ? 'ring-1 ring-[#1A1A1A] ring-offset-1 ring-offset-[#F9F8F6]'
                        : 'hover:scale-110'
                    )}
                    style={{ backgroundColor: c.hex }}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Size */}
          <div>
            <p className={cn(
              'text-[11px] font-light tracking-[0.09em] uppercase mb-2',
              sizeError ? 'text-[#B91C1C]' : 'text-[#9B9B9B]'
            )}>
              {sizeError ? 'Please select a size' : t.size}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {product.sizes.map((size: SizeOption) => (
                <button
                  key={size.value}
                  disabled={!size.inStock}
                  onClick={() => { setSelectedSize(size.label); setSizeError(false) }}
                  className={cn(
                    'w-10 h-9 text-[12px] font-light border transition-all duration-150',
                    !size.inStock
                      ? 'border-[#E8E5E0] text-[#C8C4BF] cursor-not-allowed line-through'
                      : selectedSize === size.label
                      ? 'border-[#1A1A1A] bg-[#1A1A1A] text-white'
                      : 'border-[#E8E5E0] text-[#1A1A1A] hover:border-[#1A1A1A]',
                    sizeError && !selectedSize && 'border-[#B91C1C]/40'
                  )}
                >
                  {size.label}
                </button>
              ))}
            </div>
          </div>

          {/* Add button */}
          <button
            onClick={handleAdd}
            className={cn(
              'w-full h-12 text-[12px] font-light tracking-[0.1em] uppercase transition-all duration-200',
              added
                ? 'bg-[#15803D] text-white border border-[#15803D]'
                : 'bg-[#1A1A1A] text-white border border-[#1A1A1A] hover:bg-[#333]'
            )}
          >
            {added ? t.addedToBag : t.addToBag}
          </button>
        </div>
      </div>
    </>
  )
}
