'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

interface AccordionItem {
  id:      string
  trigger: string
  content: React.ReactNode
}

interface AccordionProps {
  items:          AccordionItem[]
  defaultOpen?:   string
  className?:     string
  borderTop?:     boolean
}

export function Accordion({
  items,
  defaultOpen,
  className,
  borderTop = true,
}: AccordionProps) {
  const [openId, setOpenId] = useState<string | undefined>(defaultOpen)

  const toggle = (id: string) => {
    setOpenId((prev) => (prev === id ? undefined : id))
  }

  return (
    <div className={cn('divide-y divide-kvrn-border', borderTop && 'border-t border-kvrn-border', className)}>
      {items.map((item) => {
        const isOpen = openId === item.id

        return (
          <div key={item.id}>
            <button
              type="button"
              onClick={() => toggle(item.id)}
              aria-expanded={isOpen}
              aria-controls={`accordion-${item.id}`}
              className={cn(
                'w-full flex items-center justify-between py-4',
                'text-[13px] font-body font-light tracking-widest uppercase text-left',
                'hover:text-kvrn-muted transition-colors duration-150',
                'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-kvrn-text'
              )}
            >
              {item.trigger}
              {/* Plus/Minus indicator */}
              <span
                aria-hidden="true"
                className="ml-4 flex-shrink-0 w-4 h-4 relative"
              >
                <span className="absolute top-1/2 left-0 right-0 h-px bg-current -translate-y-1/2" />
                <span
                  className={cn(
                    'absolute top-0 bottom-0 left-1/2 w-px bg-current -translate-x-1/2',
                    'transition-transform duration-300',
                    isOpen && 'rotate-90 opacity-0'
                  )}
                />
              </span>
            </button>

            {/* Content */}
            <div
              id={`accordion-${item.id}`}
              role="region"
              aria-labelledby={`accordion-trigger-${item.id}`}
              className={cn(
                'overflow-hidden transition-all duration-300 ease-out',
                isOpen ? 'max-h-[800px] opacity-100' : 'max-h-0 opacity-0'
              )}
            >
              <div className="pb-6 text-[14px] text-kvrn-muted leading-relaxed">
                {item.content}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}
