// Checkout pages are private, transactional and per-visitor: never index them.
// (robots.txt already disallows /checkout, but a disallowed URL that is linked to can still be indexed without
// content — an explicit noindex on the page is the belt to that braces. Adds no markup around the page.)
import type { Metadata } from 'next'

export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
}

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return children
}
