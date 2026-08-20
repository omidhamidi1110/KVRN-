'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

type NavItem = {
  label: string
  href: string
  icon: ReactNode
}

type NavGroup = {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      {
        label: 'Overview',
        href: '/admin',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        ),
      },
      {
        label: 'Orders',
        href: '/admin/orders',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M6 3h12l2 4v14H4V7l2-4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M4 7h16M9 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        ),
      },
      {
        label: 'Inventory',
        href: '/admin/inventory',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Commerce',
    items: [
      {
        label: 'Discounts',
        href: '/admin/discounts',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M9 9h.01M15 15h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
            <path d="M7 3H3v4l10 10 4-4L7 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="m14 14 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Financials',
    items: [
      {
        label: 'Overview',
        href: '/admin/financials',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 3v18h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <path d="m7 14 3.5-4 3 3L20 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        ),
      },
      {
        label: 'Shipping',
        href: '/admin/financials/shipping',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 7h11v10H3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M14 10h4l3 3v4h-7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <circle cx="7" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.5"/>
            <circle cx="17" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        ),
      },
      {
        label: 'Product Costs',
        href: '/admin/financials/costs',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v18M8 7.5h6a2.5 2.5 0 0 1 0 5h-4a2.5 2.5 0 0 0 0 5h6"
                  stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        ),
      },
      {
        label: 'Advertising',
        href: '/admin/financials/advertising',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M3 10v4h4l6 4V6l-6 4H3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
            <path d="M17 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        ),
      },
      {
        label: 'Infrastructure',
        href: '/admin/financials/infrastructure',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="4" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            <rect x="3" y="14" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M7 7h.01M7 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          </svg>
        ),
      },
      {
        label: 'Expenses',
        href: '/admin/financials/expenses',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
            <path d="M3 10h18M7 15h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Marketing',
    items: [
      {
        label: 'SMS',
        href: '/admin/sms',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          </svg>
        ),
      },
    ],
  },
]

// Flat list for mobile nav (preserves existing mobile pattern)
const navItems: NavItem[] = navGroups.flatMap(g => g.items)

/**
 * Resolve which single nav href is active for the current path.
 *
 * MOST-SPECIFIC MATCH WINS. A plain prefix test is not enough: /admin/financials
 * is a prefix of /admin/financials/costs, so Overview and Product Costs would both
 * highlight. Exact-match-only is also wrong, because it would un-highlight Orders
 * while viewing /admin/orders/<id>.
 *
 * Taking the longest matching href satisfies both:
 *   /admin/financials/costs -> Product Costs only (longest match)
 *   /admin/orders/<id>      -> Orders            (only match)
 *   /admin                  -> Overview          (exact, see below)
 *
 * /admin is special-cased to exact match because it prefixes every admin route.
 */
function resolveActiveHref(pathname: string, hrefs: string[]): string | null {
  let best: string | null = null
  for (const href of hrefs) {
    const matches = href === '/admin'
      ? pathname === '/admin'
      : pathname === href || pathname.startsWith(`${href}/`)
    if (!matches) continue
    if (best === null || href.length > best.length) best = href
  }
  return best
}

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  // Resolved once so desktop and mobile navigation can never disagree.
  const activeHref = resolveActiveHref(pathname, navItems.map(i => i.href))

  return (
    <div className="min-h-screen bg-[#F5F5F3] text-[#171717]">

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-black/[0.07] bg-[#111111] text-white lg:flex lg:flex-col">
        <div className="px-7 pt-8 pb-7 border-b border-white/[0.08]">
          <Link href="/admin" className="block">
            <p className="text-[15px] font-light tracking-[0.20em] uppercase">KVRN</p>
            <p className="mt-1.5 text-[10px] tracking-[0.16em] uppercase text-white/35">
              Administration
            </p>
          </Link>
        </div>

        <nav className="flex-1 px-3 py-5 overflow-y-auto" aria-label="Admin navigation">
          <div className="space-y-6">
            {navGroups.map(group => (
              <div key={group.label}>
                <p className="px-4 pb-2 text-[9px] font-medium tracking-[0.18em] uppercase text-white/25">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map(item => {
                    const active = item.href === activeHref
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        className={[
                          'group flex items-center gap-3 rounded-[7px] px-4 py-2.5 text-[13px] transition-all',
                          active
                            ? 'bg-white text-[#111111]'
                            : 'text-white/55 hover:bg-white/[0.06] hover:text-white',
                        ].join(' ')}
                      >
                        <span className={active ? 'text-[#111111]' : 'text-white/40 group-hover:text-white/80'}>
                          {item.icon}
                        </span>
                        <span className="font-medium tracking-[0.01em]">{item.label}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>

        <div className="px-3 pb-5">
          <div className="border-t border-white/[0.08] pt-4">
            <Link
              href="/"
              className="group flex items-center justify-between rounded-[7px] px-4 py-3 text-[12px] text-white/45 transition-all hover:bg-white/[0.06] hover:text-white"
            >
              <span>View storefront</span>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </Link>
          </div>

          <div className="px-4 pt-5">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              <span className="text-[9px] tracking-[0.14em] uppercase text-white/25">
                Production
              </span>
            </div>
          </div>
        </div>
      </aside>

      {/* Mobile header */}
      <div className="sticky top-0 z-40 border-b border-black/[0.08] bg-[#111111] text-white lg:hidden">
        <div className="flex h-[58px] items-center justify-between px-5">
          <Link href="/admin">
            <span className="text-[13px] font-light tracking-[0.18em] uppercase">KVRN</span>
            <span className="ml-2 text-[9px] tracking-[0.12em] uppercase text-white/30">Admin</span>
          </Link>

          <Link
            href="/"
            className="flex items-center gap-1.5 text-[10px] tracking-[0.08em] uppercase text-white/45"
          >
            Store
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </Link>
        </div>

        <nav className="flex overflow-x-auto border-t border-white/[0.07] px-3" aria-label="Admin mobile navigation">
          {navItems.map(item => {
            const active = item.href === activeHref
            return (
              <Link
                key={item.href}
                href={item.href}
                className={[
                  'relative flex min-w-max items-center gap-2 px-4 py-3 text-[11px] transition-colors',
                  active ? 'text-white' : 'text-white/40',
                ].join(' ')}
              >
                {item.icon}
                <span>{item.label}</span>
                {active && (
                  <span className="absolute inset-x-4 bottom-0 h-px bg-white" />
                )}
              </Link>
            )
          })}
        </nav>
      </div>

      {/* Admin content */}
      <main className="min-h-screen lg:pl-[248px]">
        {children}
      </main>
    </div>
  )
}
