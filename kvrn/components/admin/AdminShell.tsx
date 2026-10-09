'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useState, type ReactNode } from 'react'

type NavItem = {
  label: string
  href: string
  icon: ReactNode
}

type NavGroup = {
  label: string
  items: NavItem[]
}

// 17px line icon. Decorative: the label next to it carries the meaning.
const icon = (paths: ReactNode) => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">{paths}</svg>
)

const navGroups: NavGroup[] = [
  {
    label: 'Workspace',
    items: [
      {
        label: 'Overview',
        href: '/admin',
        icon: icon(<>
          <rect x="3" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/>
          <rect x="14" y="3" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/>
          <rect x="3" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/>
          <rect x="14" y="14" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1.5"/>
        </>),
      },
      {
        label: 'Orders',
        href: '/admin/orders',
        icon: icon(<>
          <path d="M6 3h12l2 4v14H4V7l2-4Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M4 7h16M9 11h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </>),
      },
      {
        label: 'Support',
        href: '/admin/support',
        icon: icon(<>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
          <path d="m3.5 7 8.5 6 8.5-6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </>),
      },
      {
        label: 'Inventory',
        href: '/admin/inventory',
        icon: icon(<>
          <path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5v-9Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="m4.5 7.7 7.5 4.2 7.5-4.2M12 12v9" stroke="currentColor" strokeWidth="1.5"/>
        </>),
      },
    ],
  },
  {
    label: 'AI',
    items: [
      {
        label: 'AI Operations',
        href: '/admin/ai',
        icon: (
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
            <circle cx="12" cy="12" r="4" stroke="currentColor" strokeWidth="1.5"/>
          </svg>
        ),
      },
    ],
  },
  {
    label: 'Commerce',
    items: [
      {
        label: 'Products',
        href: '/admin/products',
        icon: icon(<>
          <path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="m7.7 5.2 8.6 4.6" stroke="currentColor" strokeWidth="1.5"/>
        </>),
      },
      {
        label: 'Store Credit',
        href: '/admin/store-credit',
        icon: icon(<><rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/><path d="M3 10h18" stroke="currentColor" strokeWidth="1.5"/></>),
      },
      {
        label: 'Discounts',
        href: '/admin/discounts',
        icon: icon(<>
          <path d="M9 9h.01M15 15h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
          <path d="M7 3H3v4l10 10 4-4L7 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="m14 14 5 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </>),
      },
      {
        label: 'Live View',
        href: '/admin/live',
        icon: icon(<><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5"/><path d="M5 12h14M12 5v14" stroke="currentColor" strokeWidth="1.5"/></>),
      },
      {
        label: 'Analytics',
        href: '/admin/analytics',
        icon: icon(<path d="M4 5h16l-6 7v6l-4 2v-8L4 5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>),
      },
    ],
  },
  {
    label: 'Content',
    items: [
      {
        label: 'Content',
        href: '/admin/content',
        icon: icon(<>
          <path d="M6 3h8l4 4v14H6V3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M14 3v4h4M9 12h6M9 16h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </>),
      },
      {
        label: 'Media',
        href: '/admin/media',
        icon: icon(<>
          <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.5"/>
          <circle cx="9" cy="10" r="1.6" stroke="currentColor" strokeWidth="1.5"/>
          <path d="m4 18 5-5 4 4 3-3 4 4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </>),
      },
    ],
  },
  {
    label: 'Financials',
    items: [
      {
        label: 'Overview',
        href: '/admin/financials',
        icon: icon(<>
          <path d="M3 3v18h18" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <path d="m7 14 3.5-4 3 3L20 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </>),
      },
      {
        label: 'Shipping',
        href: '/admin/financials/shipping',
        icon: icon(<>
          <path d="M3 7h11v10H3z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M14 10h4l3 3v4h-7z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <circle cx="7" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.5"/>
          <circle cx="17" cy="18" r="1.6" stroke="currentColor" strokeWidth="1.5"/>
        </>),
      },
      {
        label: 'Product Costs',
        href: '/admin/financials/costs',
        icon: icon(<path d="M12 3v18M8 7.5h6a2.5 2.5 0 0 1 0 5h-4a2.5 2.5 0 0 0 0 5h6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>),
      },
      {
        label: 'Advertising',
        href: '/admin/financials/advertising',
        icon: icon(<>
          <path d="M3 10v4h4l6 4V6l-6 4H3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M17 9a4 4 0 0 1 0 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </>),
      },
      {
        label: 'Infrastructure',
        href: '/admin/financials/infrastructure',
        icon: icon(<>
          <rect x="3" y="4" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
          <rect x="3" y="14" width="18" height="6" rx="1.5" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M7 7h.01M7 17h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/>
        </>),
      },
      {
        label: 'Affiliates',
        href: '/admin/financials/affiliates',
        icon: icon(<>
          <circle cx="9" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M3.5 20a5.5 5.5 0 0 1 11 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <path d="M16.5 7.5h4M18.5 5.5v4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </>),
      },
      {
        label: 'Inventory Value',
        href: '/admin/financials/inventory',
        icon: icon(<>
          <path d="M3 8.5 12 4l9 4.5-9 4.5-9-4.5Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M3 12.5 12 17l9-4.5M3 16.5 12 21l9-4.5" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
        </>),
      },
      {
        label: 'Returns',
        href: '/admin/financials/returns',
        icon: icon(<>
          <path d="M9 14 4 9l5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M4 9h10a6 6 0 0 1 0 12h-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
        </>),
      },
      {
        label: 'Disputes',
        href: '/admin/financials/disputes',
        icon: icon(<>
          <path d="M12 3 3 20h18L12 3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="M12 10v4M12 17h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
        </>),
      },
      {
        label: 'Reconciliation',
        href: '/admin/financials/integrity',
        icon: icon(<>
          <path d="M12 3 4 6v6c0 4.5 3.2 8 8 9 4.8-1 8-4.5 8-9V6l-8-3Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>
          <path d="m8.5 12 2.5 2.5L15.5 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
        </>),
      },
      {
        label: 'Expenses',
        href: '/admin/financials/expenses',
        icon: icon(<>
          <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M3 10h18M7 15h4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
        </>),
      },
    ],
  },
  {
    label: 'Marketing',
    items: [
      {
        label: 'Marketing Suite',
        href: '/admin/marketing',
        icon: icon(<><path d="M4 6h16v12H4zM4 7l8 6 8-6" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/></>),
      },
      {
        label: 'SMS',
        href: '/admin/sms',
        icon: icon(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round"/>),
      },
      {
        label: 'Abandoned checkouts',
        href: '/admin/abandoned-checkouts',
        icon: icon(<>
          <path d="M3 4h2.5l2 11h10l2-8H7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          <circle cx="9.5" cy="19" r="1.3" stroke="currentColor" strokeWidth="1.5"/>
          <circle cx="16.5" cy="19" r="1.3" stroke="currentColor" strokeWidth="1.5"/>
        </>),
      },
    ],
  },
  {
    label: 'Operations',
    items: [
      {
        label: 'Backups',
        href: '/admin/backups',
        icon: icon(<>
          <ellipse cx="12" cy="6" rx="8" ry="3" stroke="currentColor" strokeWidth="1.5"/>
          <path d="M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" stroke="currentColor" strokeWidth="1.5"/>
        </>),
      },
      {
        label: 'System',
        href: '/admin/system',
        icon: icon(<>
          <path d="M4 7h10M18 7h2M4 17h2M10 17h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
          <circle cx="16" cy="7" r="2" stroke="currentColor" strokeWidth="1.5"/>
          <circle cx="8" cy="17" r="2" stroke="currentColor" strokeWidth="1.5"/>
        </>),
      },
    ],
  },
]

// Flat list used to resolve the single active item (desktop and mobile share it).
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

const ExternalArrow = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M7 17 17 7M9 7h8v8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const [menuOpen, setMenuOpen] = useState(false)
  // Resolved once so desktop and mobile navigation can never disagree.
  const activeHref = resolveActiveHref(pathname, navItems.map(i => i.href))
  const activeLabel = navItems.find(i => activeHref === i.href)?.label ?? 'Admin'

  // Close the mobile menu after navigating, on Escape, and keep the page behind it still.
  useEffect(() => { setMenuOpen(false) }, [pathname])
  useEffect(() => {
    if (!menuOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.removeEventListener('keydown', onKey); document.body.style.overflow = prev }
  }, [menuOpen])

  // The private product preview is a full-screen storefront render (embedded in the editor's
  // iframe): no admin chrome around it. Placed after the hooks so hook order never changes.
  if (/^\/admin\/products\/[^/]+\/preview\/?$/.test(pathname)) return <>{children}</>

  return (
    <div className="w-full min-w-0 min-h-screen bg-[#F5F5F3] font-normal leading-[1.5] text-[#171717]">
      <a href="#admin-main"
        className="sr-only z-[60] rounded-[8px] bg-white px-3 py-2 text-[12px] font-medium text-[#171717] focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>

      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-[248px] border-r border-black/[0.07] bg-[#111111] text-white lg:flex lg:flex-col">
        <div className="border-b border-white/[0.08] px-6 pb-6 pt-7">
          <Link href="/admin" className="block">
            <p className="text-[15px] font-light uppercase tracking-[0.20em]">KVRN</p>
            <p className="mt-1.5 text-[10px] uppercase tracking-[0.16em] text-white/40">Administration</p>
          </Link>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4" aria-label="Admin navigation">
          <div className="space-y-5">
            {navGroups.map(group => (
              <div key={group.label}>
                <p className="px-3 pb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
                  {group.label}
                </p>
                <div className="space-y-0.5">
                  {group.items.map(item => {
                    const active = item.href === activeHref
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        className={[
                          'group relative flex items-center gap-3 rounded-[8px] px-3 py-2 text-[13px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
                          active
                            ? 'bg-white/[0.12] text-white'
                            : 'text-white/60 hover:bg-white/[0.06] hover:text-white',
                        ].join(' ')}
                      >
                        {active && <span aria-hidden="true" className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-white" />}
                        <span className={active ? 'text-white' : 'text-white/45 group-hover:text-white/80'}>
                          {item.icon}
                        </span>
                        <span className="font-medium">{item.label}</span>
                      </Link>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
        </nav>

        <div className="px-3 pb-5">
          <div className="border-t border-white/[0.08] pt-3">
            <Link
              href="/"
              className="group flex items-center justify-between rounded-[8px] px-3 py-2.5 text-[12px] text-white/55 transition-colors hover:bg-white/[0.06] hover:text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
            >
              <span>View storefront</span>
              <ExternalArrow />
            </Link>
          </div>
          <div className="flex items-center gap-2 px-3 pt-3">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
            <span className="text-[10px] uppercase tracking-[0.14em] text-white/40">Production</span>
          </div>
        </div>
      </aside>

      {/* Mobile header: brand, current page, one Menu button. All routes live in the panel. */}
      <div className="sticky top-0 z-40 w-full min-w-0 border-b border-white/[0.08] bg-[#111111] text-white lg:hidden">
        <div className="flex h-[56px] items-center justify-between gap-3 px-4">
          <Link href="/admin" className="flex min-w-0 items-baseline gap-2">
            <span className="text-[13px] font-light uppercase tracking-[0.18em]">KVRN</span>
            <span className="truncate text-[12px] text-white/60">{activeLabel}</span>
          </Link>
          <button
            type="button"
            onClick={() => setMenuOpen(o => !o)}
            aria-expanded={menuOpen}
            aria-controls="admin-mobile-menu"
            className="inline-flex h-10 items-center gap-2 rounded-[9px] border border-white/[0.18] px-3 text-[12px] font-medium text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              {menuOpen
                ? <path d="m6 6 12 12M18 6 6 18" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                : <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>}
            </svg>
            {menuOpen ? 'Close' : 'Menu'}
          </button>
        </div>

        {menuOpen && (
          <div id="admin-mobile-menu" className="fixed inset-x-0 bottom-0 top-[56px] z-40 overflow-y-auto overscroll-contain bg-[#111111] pb-8">
            <nav className="px-4 pt-3" aria-label="Admin mobile navigation">
              {navGroups.map(group => (
                <div key={group.label} className="mb-4">
                  <p className="pb-1.5 text-[10px] font-medium uppercase tracking-[0.16em] text-white/40">{group.label}</p>
                  <div className="grid grid-cols-2 gap-1.5">
                    {group.items.map(item => {
                      const active = item.href === activeHref
                      return (
                        <Link
                          key={item.href}
                          href={item.href}
                          aria-current={active ? 'page' : undefined}
                          className={[
                            'flex min-h-[44px] items-center gap-2.5 rounded-[9px] border px-3 text-[13px] font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60',
                            active
                              ? 'border-white/30 bg-white/[0.12] text-white'
                              : 'border-white/[0.08] text-white/70 active:bg-white/[0.06]',
                          ].join(' ')}
                        >
                          <span className={active ? 'text-white' : 'text-white/45'}>{item.icon}</span>
                          <span className="min-w-0 leading-tight">{item.label}</span>
                        </Link>
                      )
                    })}
                  </div>
                </div>
              ))}
              <div className="mt-2 flex items-center justify-between border-t border-white/[0.08] pt-4">
                <Link href="/" className="inline-flex min-h-[44px] items-center gap-1.5 text-[12px] text-white/70">
                  View storefront <ExternalArrow size={12} />
                </Link>
                <span className="flex items-center gap-2 text-[10px] uppercase tracking-[0.14em] text-white/40">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />Production
                </span>
              </div>
            </nav>
          </div>
        )}
      </div>

      {/* Admin content */}
      {/* The root layout already wraps every route (admin included) in the single main landmark (id "main-content"); a second main element would nest
          landmarks (invalid HTML, flagged by axe). This is a plain region that the "Skip to content" link can focus. */}
      <div id="admin-main" tabIndex={-1} className="w-full min-w-0 min-h-screen bg-[#F5F5F3] outline-none lg:pl-[248px]">
        {children}
      </div>
    </div>
  )
}
