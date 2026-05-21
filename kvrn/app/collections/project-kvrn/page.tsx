import { getProductsByType } from '@/data/products'
import { ShopClient } from '@/components/shop/ShopClient'

export const metadata = {
  title: 'Project KVRN — Available Now',
  description: 'Shop the Project KVRN collection. 500 GSM French terry, enzyme washed, pre-shrunk.',
}

export default function ProjectKVRNPage() {
  // Project KVRN products use the phantom slugs
  const allHoodies    = getProductsByType('hoodie')
  const allSweatpants = getProductsByType('sweatpants')

  // Filter to only the Project KVRN (phantom slug) products
  const products = [
    ...allHoodies.filter(p => p.slug.includes('phantom')),
    ...allSweatpants.filter(p => p.slug.includes('phantom')),
  ].map(p => ({
    ...p,
    // Display names with "Heavyweight" prefix as requested
    name: p.name.startsWith('Project KVRN')
      ? p.name.replace('Project KVRN', 'Heavyweight Project KVRN')
      : p.name,
  }))

  return (
    <ShopClient
      products={products}
      type={null}
      headingOverride="Project KVRN"
    />
  )
}
