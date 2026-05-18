import type { Metadata } from 'next'
import { products, getProductsByType } from '@/data/products'
import { ShopClient } from '@/components/shop/ShopClient'

interface PageProps {
  searchParams: Promise<{ type?: string }>
}

export async function generateMetadata({ searchParams }: PageProps): Promise<Metadata> {
  const { type } = await searchParams
  if (type === 'hoodies')    return { title: 'Hoodies — KVRN', description: 'Shop KVRN heavyweight hoodies. 400 GSM brushed fleece and 500 GSM French terry.' }
  if (type === 'sweatpants') return { title: 'Sweatpants — KVRN', description: 'Shop KVRN heavyweight sweatpants. Wide-leg and relaxed fits.' }
  return { title: 'Shop — KVRN', description: 'Shop the full KVRN collection. Heavyweight hoodies and sweatpants.' }
}

export default async function ShopPage({ searchParams }: PageProps) {
  const { type } = await searchParams
  const isHoodies    = type === 'hoodies'
  const isSweatpants = type === 'sweatpants'
  const displayed    = isHoodies
    ? getProductsByType('hoodie')
    : isSweatpants
    ? getProductsByType('sweatpants')
    : products

  return <ShopClient products={displayed} type={type ?? null} />
}
