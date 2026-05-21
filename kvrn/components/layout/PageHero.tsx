import Link from 'next/link'

interface PageHeroProps {
  title:      string
  breadcrumb?: string  // single label, links back to /
}

/**
 * Shared dark hero section for all interior pages.
 * Compact height — just enough for nav clearance + title. No excess space.
 */
export function PageHero({ title, breadcrumb }: PageHeroProps) {
  return (
    <div className="bg-[#0E0E0E] pt-[calc(36px+56px+20px)] pb-8">
      <div className="container-kvrn max-w-3xl">
        {breadcrumb && (
          <nav aria-label="Breadcrumb" className="mb-4">
            <ol className="flex items-center gap-2 text-[11px] text-[#F0EDE8]/40 tracking-wide">
              <li><Link href="/" className="hover:text-[#F0EDE8] transition-colors">Home</Link></li>
              <li aria-hidden="true">·</li>
              <li className="text-[#F0EDE8]/70" aria-current="page">{breadcrumb}</li>
            </ol>
          </nav>
        )}
        <h1 className="font-display font-light text-[32px] md:text-[40px] leading-none tracking-[-0.025em] text-white">
          {title}
        </h1>
      </div>
    </div>
  )
}
