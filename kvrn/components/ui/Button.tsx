import { cn } from '@/lib/utils'
import { ButtonHTMLAttributes, forwardRef } from 'react'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'text'
export type ButtonSize    = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?:   ButtonVariant
  size?:      ButtonSize
  loading?:   boolean
  fullWidth?: boolean
  as?:        'button' | 'span'
}

const variantClasses: Record<ButtonVariant, string> = {
  primary:
    'bg-kvrn-text text-kvrn-bg border border-kvrn-text ' +
    'hover:bg-[#333333] hover:border-[#333333] ' +
    'active:bg-black active:border-black ' +
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none',

  secondary:
    'bg-transparent text-kvrn-text border border-kvrn-text ' +
    'hover:bg-kvrn-text hover:text-kvrn-bg ' +
    'active:bg-[#333333] ' +
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none',

  ghost:
    'bg-transparent text-kvrn-text-on-dark border border-kvrn-text-on-dark ' +
    'hover:bg-kvrn-text-on-dark hover:text-kvrn-text ' +
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none',

  text:
    'bg-transparent text-kvrn-text border border-transparent p-0 h-auto ' +
    'hover:opacity-60 ' +
    'disabled:opacity-40 disabled:cursor-not-allowed disabled:pointer-events-none',
}

const sizeClasses: Record<ButtonSize, string> = {
  sm: 'h-10 px-5 text-[11px]',
  md: 'h-12 px-7 text-[11px]',
  lg: 'h-[56px] px-9 text-[13px]',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      variant    = 'primary',
      size       = 'md',
      loading    = false,
      fullWidth  = false,
      className,
      children,
      disabled,
      ...props
    },
    ref
  ) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={loading}
        className={cn(
          // Base
          'relative inline-flex items-center justify-center',
          'font-body font-light tracking-widest uppercase',
          'transition-all duration-150 ease-out',
          'select-none whitespace-nowrap',
          '-webkit-tap-highlight-color: transparent',
          // Variant
          variantClasses[variant],
          // Size (skip for text variant)
          variant !== 'text' && sizeClasses[size],
          // Full width
          fullWidth && 'w-full',
          // Loading
          loading && 'cursor-wait',
          className
        )}
        {...props}
      >
        {/* Loading spinner */}
        {loading && (
          <span
            aria-hidden="true"
            className={cn(
              'absolute inset-0 flex items-center justify-center',
              variant === 'primary' ? 'text-kvrn-bg' : 'text-kvrn-text'
            )}
          >
            <svg
              className="animate-spin w-4 h-4"
              viewBox="0 0 24 24"
              fill="none"
            >
              <circle
                className="opacity-25"
                cx="12" cy="12" r="10"
                stroke="currentColor" strokeWidth="2"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
              />
            </svg>
          </span>
        )}
        {/* Content — invisible when loading */}
        <span className={cn('flex items-center gap-2', loading && 'invisible')}>
          {children}
        </span>
      </button>
    )
  }
)
