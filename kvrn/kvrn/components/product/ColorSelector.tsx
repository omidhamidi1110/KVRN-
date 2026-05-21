'use client'

import { cn } from '@/lib/utils'
import type { ColorOption } from '@/types'

interface ColorSelectorProps {
  colors:          ColorOption[]
  selectedColor:   string
  onChange:        (color: ColorOption) => void
  className?:      string
}

export function ColorSelector({
  colors,
  selectedColor,
  onChange,
  className,
}: ColorSelectorProps) {
  const selected = colors.find((c) => c.value === selectedColor)

  return (
    <fieldset className={cn('border-0 p-0 m-0', className)}>
      <legend className="sr-only">Select color</legend>

      {/* Selected color name */}
      <p className="label-11 mb-3">
        Color
        {selected && (
          <span className="normal-case tracking-normal ml-2 text-kvrn-text font-light">
            — {selected.name}
          </span>
        )}
      </p>

      <div className="flex items-center gap-2" role="radiogroup" aria-label="Product color">
        {colors.map((color) => {
          const isSelected = color.value === selectedColor

          return (
            <label
              key={color.value}
              title={color.name}
              className="relative cursor-pointer group"
            >
              {/* Hidden radio input for accessibility */}
              <input
                type="radio"
                name="color"
                value={color.value}
                checked={isSelected}
                onChange={() => onChange(color)}
                className="sr-only"
                aria-label={color.name}
              />

              {/* Swatch */}
              <span
                className={cn(
                  'block w-6 h-6 rounded-full border transition-all duration-150',
                  // Border changes based on lightness
                  color.value === 'off-white'
                    ? 'border-kvrn-border'
                    : 'border-transparent',
                  // Selection ring
                  isSelected
                    ? 'ring-2 ring-kvrn-text ring-offset-2 ring-offset-kvrn-bg'
                    : 'group-hover:ring-1 group-hover:ring-kvrn-border-strong group-hover:ring-offset-1 group-hover:ring-offset-kvrn-bg'
                )}
                style={{ backgroundColor: color.hex }}
                aria-hidden="true"
              />
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}
