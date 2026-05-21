import { cn } from '@/lib/utils'

interface TrustItem {
  label:       string
  description: string
  icon:        React.ReactNode
}

const defaultItems: TrustItem[] = [
  {
    label: 'Ships in 3–5 days',
    description: 'UK & International',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M3 7h10l2 5H3V7z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
        <path d="M3 7L5 3h8" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        <circle cx="6" cy="14" r="1.5" stroke="currentColor" strokeWidth="1"/>
        <circle cx="13" cy="14" r="1.5" stroke="currentColor" strokeWidth="1"/>
      </svg>
    ),
  },
  {
    label: 'Free returns',
    description: '30 days, no questions',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M4 10 C4 6.69 6.69 4 10 4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        <path d="M4 7v3h3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M16 10 C16 13.31 13.31 16 10 16" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
        <path d="M16 13v3h-3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
      </svg>
    ),
  },
  {
    label: 'Tracked delivery',
    description: 'Every order',
    icon: (
      <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
        <path d="M10 3l7 4v6l-7 4-7-4V7l7-4z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round"/>
        <path d="M10 3v14M3 7l7 4 7-4" stroke="currentColor" strokeWidth="1" strokeLinecap="round"/>
      </svg>
    ),
  },
]

interface TrustBlockProps {
  items?:     TrustItem[]
  layout?:    'row' | 'col'
  className?: string
  size?:      'sm' | 'md'
}

export function TrustBlock({
  items     = defaultItems,
  layout    = 'col',
  className,
  size      = 'md',
}: TrustBlockProps) {
  return (
    <div
      className={cn(
        layout === 'row'
          ? 'flex flex-col sm:flex-row gap-4 sm:gap-8'
          : 'flex flex-col gap-3',
        className
      )}
      aria-label="Trust and delivery information"
    >
      {items.map((item) => (
        <div key={item.label} className="flex items-center gap-3">
          <span className="flex-shrink-0 text-kvrn-muted">{item.icon}</span>
          <div>
            <p className={cn(
              'font-light text-kvrn-text',
              size === 'sm' ? 'text-[13px]' : 'text-[14px]'
            )}>
              {item.label}
            </p>
            <p className={cn(
              'text-kvrn-muted',
              size === 'sm' ? 'text-[11px]' : 'text-[12px]'
            )}>
              {item.description}
            </p>
          </div>
        </div>
      ))}
    </div>
  )
}
