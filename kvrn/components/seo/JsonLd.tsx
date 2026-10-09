// Server component: one <script type="application/ld+json"> with the '<' / U+2028 / U+2029 escaping that keeps
// CMS-sourced strings from closing the tag. Renders nothing for null.
import { jsonLdString } from '@/lib/product-seo'

export function JsonLd({ data }: { data: Record<string, unknown> | null | undefined }) {
  if (!data) return null
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdString(data) }} />
}
