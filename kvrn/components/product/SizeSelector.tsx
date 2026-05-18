'use client'

import { cn } from '@/lib/utils'
import type { SizeLabel, SizeOption } from '@/types'
import Link from 'next/link'

interface SizeSelectorProps {
  sizes:              SizeOption[]
  selectedSize:       SizeLabel | null
  onChange:           (size: SizeLabel) => void
  hasError?:          boolean
  className?:         string
  id?:                string
  hideSizeGuideLink?: boolean  // suppress internal size guide link when parent provides it
}

export function SizeSelector({
  sizes,
  selectedSize,
  onChange,
  hasError = false,
  className,
  id = 'size-selector',
  hideSizeGuideLink = false,
}: SizeSelectorProps) {
  return (
    <fieldset
      id={id}
      className={cn('border-0 p-0 m-0', className)}
    >
      <div className="flex items-center justify-between mb-3">
        <legend className="label-11">Size</legend>
        {!hideSizeGuideLink && (
          <Link
            href="#size-guide"
            className="text-[11px] text-kvrn-muted hover:text-kvrn-text tracking-wide underline underline-offset-2 transition-colors duration-150"
          >
            Size guide
          </Link>
        )}
      </div>

      {/* Size grid */}
      <div
        className={cn(
          'flex flex-wrap gap-2',
          hasError && 'ring-1 ring-kvrn-error ring-offset-4 ring-offset-kvrn-bg rounded-[1px]'
        )}
        role="radiogroup"
        aria-label="Select size"
        aria-required="true"
      >
        {sizes.map((size) => {
          const isSelected = selectedSize === size.label
          const isOutOfStock = !size.inStock

          return (
            <label
              key={size.value}
              className={cn(
                'relative cursor-pointer',
                isOutOfStock && 'cursor-not-allowed'
              )}
              title={isOutOfStock ? `${size.label} — Out of stock. Click to be notified when back.` : size.label}
            >
              {/* Hidden radio */}
              <input
                type="radio"
                name="size"
                value={size.value}
                checked={isSelected}
                disabled={isOutOfStock}
                onChange={() => !isOutOfStock && onChange(size.label)}
                className="sr-only"
                aria-label={
                  isOutOfStock
                    ? `${size.label}, out of stock`
                    : isSelected
                    ? `${size.label}, selected`
                    : size.label
                }
              />

              {/* Visual tile */}
              <span
                className={cn(
                  'flex items-center justify-center',
                  'w-12 h-12 text-[11px] font-light tracking-widest',
                  'border transition-all duration-150',
                  // Default
                  !isSelected && !isOutOfStock && [
                    'border-kvrn-border text-kvrn-text',
                    'hover:border-kvrn-border-strong',
                  ],
                  // Selected
                  isSelected && [
                    'border-kvrn-text bg-kvrn-text text-kvrn-bg',
                  ],
                  // Out of stock
                  isOutOfStock && [
                    'border-kvrn-border text-kvrn-subtle',
                    'relative overflow-hidden',
                  ]
                )}
                aria-hidden="true"
              >
                {size.label}
                {/* Diagonal line for out of stock */}
                {isOutOfStock && (
                  <span
                    className="absolute inset-0 overflow-hidden pointer-events-none"
                    aria-hidden="true"
                  >
                    <svg
                      className="absolute inset-0 w-full h-full"
                      preserveAspectRatio="none"
                      viewBox="0 0 48 48"
                    >
                      <line
                        x1="4" y1="44" x2="44" y2="4"
                        stroke="#E8E5E0"
                        strokeWidth="1"
                      />
                    </svg>
                  </span>
                )}
              </span>
            </label>
          )
        })}
      </div>

      {/* Error state */}
      {hasError && (
        <p
          role="alert"
          className="mt-2 text-[12px] text-kvrn-error"
        >
          Please select a size.
        </p>
      )}
    </fieldset>
  )
}
