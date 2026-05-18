'use client'

import { useState, useRef, useCallback, useEffect } from 'react'
import Link from 'next/link'
import Image from 'next/image'
import { useCart }     from '@/context/CartContext'
import { useCurrency } from '@/context/CurrencyContext'
import { useWishlist } from '@/context/WishlistContext'
import { ProductGallery } from '@/components/product/ProductGallery'
import { ColorSelector }  from '@/components/product/ColorSelector'
import { SizeSelector }   from '@/components/product/SizeSelector'
import { Accordion }      from '@/components/ui/Accordion'
import { Button }         from '@/components/ui/Button'
import { StockBadge, computeStock } from '@/components/ui/StockBadge'
import { cn }             from '@/lib/utils'
import type { ColorOption, SizeLabel, Product } from '@/types'

interface Props {
  product:        Product
  relatedProduct: Product | null
}

export function PDPClient({ product, relatedProduct }: Props) {
  const { addItem, openCart }          = useCart()
  const { formatPrice }                = useCurrency()
  const { isWishlisted, toggleItem }   = useWishlist()

  const [selectedColor, setSelectedColor] = useState<ColorOption>(product.colors[0])
  const [selectedSize,  setSelectedSize]  = useState<SizeLabel | null>(null)
  const [sizeError,     setSizeError]     = useState(false)
  const [addState,      setAddState]      = useState<'idle' | 'loading' | 'added'>('idle')
  const [stickyVisible, setStickyVisible] = useState(false)

  const atcBtnRef    = useRef<HTMLButtonElement>(null)
  const sizePanelRef = useRef<HTMLDivElement>(null)

  const stock   = computeStock(product.sizes)
  const soldOut = stock === 0
  const wished  = isWishlisted(product.id, selectedColor.value)

  useEffect(() => {
    if (!atcBtnRef.current) return
    const obs = new IntersectionObserver(
      ([e]) => setStickyVisible(!e.isIntersecting),
      { threshold: 0, rootMargin: '-60px 0px 0px 0px' }
    )
    obs.observe(atcBtnRef.current)
    return () => obs.disconnect()
  }, [])

  const handleAdd = useCallback(async () => {
    if (!selectedSize) {
      setSizeError(true)
      sizePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      return
    }
    setSizeError(false)
    setAddState('loading')
    await new Promise(r => setTimeout(r, 260))
    const front = selectedColor.images.find(i => i.type === 'front')
    addItem({
      productId:   product.id,
      productName: product.name,
      slug:        product.slug,
      color:       selectedColor.value,
      colorName:   selectedColor.name,
      colorHex:    selectedColor.hex,
      size:        selectedSize,
      price:       product.price,
      quantity:    1,
      image:       front?.src ?? '',
    })
    setAddState('added')
    openCart()
    setTimeout(() => setAddState('idle'), 2000)
  }, [selectedSize, selectedColor, product, addItem, openCart])

  const handleWishlist = useCallback(() => {
    const front = selectedColor.images.find(i => i.type === 'front')
    toggleItem({
      productId:   product.id,
      productName: product.name,
      slug:        product.slug,
      colorValue:  selectedColor.value,
      colorName:   selectedColor.name,
      colorHex:    selectedColor.hex,
      price:       product.price,
      image:       front?.src ?? '',
    })
  }, [selectedColor, product, toggleItem])

  const accordionItems = [
    {
      id: 'details', trigger: 'Details',
      content: (
        <dl className="space-y-3">
          {product.specs.map(s => (
            <div key={s.label} className="flex gap-4">
              <dt className="text-[13px] font-light text-[#1A1A1A] min-w-[110px] flex-shrink-0">{s.label}</dt>
              <dd className="text-[13px] text-[#6B6B6B]">{s.value}</dd>
            </div>
          ))}
        </dl>
      ),
    },
    {
      id: 'shipping', trigger: 'Shipping',
      content: (
        <div className="space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
          <p>Orders are processed within 1 to 3 business days. Shipping costs and delivery times depend on destination and chosen method, calculated at checkout.</p>
          <p>Domestic: approximately 2 to 7 business days. International: 5 to 14 or more business days. Estimates are not guaranteed.</p>
          <Link href="/support/shipping-returns" className="text-[#1A1A1A] underline underline-offset-2">Full shipping policy</Link>
        </div>
      ),
    },
    {
      id: 'returns', trigger: 'Returns',
      content: (
        <div className="space-y-2 text-[13px] text-[#6B6B6B] leading-relaxed">
          <p>Returns are accepted for store credit within 14 days of delivery on unworn, unwashed items with original tags attached. Customer is responsible for return shipping unless the item is faulty or incorrect.</p>
          <Link href="/support/shipping-returns#returns" className="text-[#1A1A1A] underline underline-offset-2">Full returns policy</Link>
        </div>
      ),
    },
  ]

  const atcLabel = soldOut ? 'Sold Out'
    : addState === 'added' ? 'Added'
    : addState === 'loading' ? 'Adding...'
    : selectedSize ? `Add to Bag`
    : 'Select a Size'

  return (
    <>
      {/* Breadcrumb */}
      <nav aria-label="Breadcrumb" className="container-kvrn pt-[calc(36px+56px+20px)] pb-3">
        <ol className="flex items-center gap-2 text-[11px] text-[#9B9B9B]">
          <li><Link href="/" className="hover:text-[#1A1A1A] transition-colors">Home</Link></li>
          <li aria-hidden="true">·</li>
          <li><Link href="/shop" className="hover:text-[#1A1A1A] transition-colors">Shop</Link></li>
          <li aria-hidden="true">·</li>
          <li className="text-[#1A1A1A]" aria-current="page">{product.name}</li>
        </ol>
      </nav>

      <div className="container-kvrn pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-[58fr_42fr] gap-8 lg:gap-14 items-start">

          {/* Gallery */}
          <div className="lg:sticky lg:top-[calc(36px+56px+12px)]">
            <ProductGallery images={selectedColor.images} productName={product.name} colorName={selectedColor.name} />
          </div>

          {/* Info */}
          <div className="space-y-5">
            <div>
              <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-1.5">KVRN</p>
              <div className="flex items-start gap-3 justify-between">
                <h1 className="font-display font-light text-[26px] md:text-[30px] leading-tight tracking-[-0.02em]">
                  {product.name}
                </h1>
                <StockBadge stock={stock} position="pdp" />
              </div>
              <div className="flex items-center gap-3 mt-2">
                <p className="text-[22px] font-light tabular-nums">{formatPrice(product.price)}</p>
                {/* Wishlist on PDP */}
                <button
                  onClick={handleWishlist}
                  aria-label={wished ? 'Remove from saved' : 'Save this item'}
                  className="flex items-center gap-1.5 text-[#9B9B9B] hover:text-[#1A1A1A] transition-colors"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path
                      d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"
                      stroke={wished ? '#B91C1C' : 'currentColor'}
                      strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"
                      fill={wished ? '#B91C1C' : 'none'}
                    />
                  </svg>
                  <span className="text-[11px] tracking-wide">{wished ? 'Saved' : 'Save'}</span>
                </button>
              </div>
              {product.founderNote && (
                <p className="text-[12px] text-[#6B6B6B] mt-1">{product.founderNote}</p>
              )}
            </div>

            <div className="h-px bg-[#E8E5E0]" />
            <ColorSelector colors={product.colors} selectedColor={selectedColor.value} onChange={setSelectedColor} />
            <div className="h-px bg-[#E8E5E0]" />

            <div ref={sizePanelRef}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B]">Size</span>
                <Link href="/support/size-guide"
                  className="text-[11px] text-[#9B9B9B] hover:text-[#1A1A1A] underline underline-offset-2 transition-colors">
                  Size guide
                </Link>
              </div>
              <SizeSelector sizes={product.sizes} selectedSize={selectedSize}
                onChange={s => { setSelectedSize(s); setSizeError(false) }} hasError={sizeError} />
              {sizeError && <p className="text-[12px] text-[#B91C1C] mt-2">Please select a size</p>}
              {product.fitNote && <p className="text-[12px] text-[#6B6B6B] mt-2">{product.fitNote}</p>}
            </div>

            <div className="h-px bg-[#E8E5E0]" />

            <Button
              ref={atcBtnRef}
              variant="primary" size="lg" fullWidth
              loading={addState === 'loading'}
              disabled={soldOut}
              onClick={handleAdd}
              className={cn(addState === 'added' && 'bg-[#15803D] border-[#15803D]')}
            >
              {atcLabel}
            </Button>

            <ul className="space-y-2">
              {['Quality checked before shipment', 'Secure checkout', 'Easy support if something arrives wrong'].map(line => (
                <li key={line} className="flex items-center gap-2 text-[12px] text-[#6B6B6B]">
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
                    <path d="M2 6l2.5 2.5L10 3" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  {line}
                </li>
              ))}
            </ul>

            <p className="text-[14px] text-[#6B6B6B] leading-relaxed">{product.description}</p>
            <Accordion items={accordionItems} />
          </div>
        </div>

        {/* Construction */}
        {product.features.length > 0 && (
          <section className="mt-20 md:mt-28" aria-labelledby="construction-h">
            <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] text-center mb-8" id="construction-h">
              The Construction
            </p>
            <div className={cn(
              'grid gap-4 mx-auto',
              product.features.length === 3 ? 'grid-cols-1 sm:grid-cols-3 max-w-3xl' : 'grid-cols-1 sm:grid-cols-2 max-w-2xl'
            )}>
              {product.features.map(f => (
                <div key={f.title} className="border border-[#E8E5E0] p-5 space-y-2">
                  <p className="text-[11px] font-light tracking-[0.08em] uppercase text-[#1A1A1A]">{f.title}</p>
                  <p className="text-[13px] text-[#6B6B6B] leading-relaxed">{f.description}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Complete the Set */}
        {relatedProduct && (
          <section className="mt-16 md:mt-24 pt-12 border-t border-[#E8E5E0]">
            <p className="text-[11px] font-light tracking-[0.1em] uppercase text-[#9B9B9B] mb-8">Complete the Set</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 items-start max-w-2xl">
              <div className="grid grid-cols-2 gap-3">
                {[product, relatedProduct].map(p => {
                  const color = p.colors.find(c => c.value === selectedColor.value) ?? p.colors[0]
                  const img   = color.images[0]
                  return (
                    <Link key={p.id} href={`/products/${p.slug}`}
                      className="relative aspect-[3/4] bg-[#F3F0EB] overflow-hidden block">
                      {img?.src
                        ? <Image src={img.src} alt={img.alt} fill sizes="200px" className="object-cover" />
                        : <div className="absolute inset-0 flex items-end p-3"><span className="text-[11px] text-[#9B9B9B]">{p.name}</span></div>
                      }
                    </Link>
                  )
                })}
              </div>
              <div className="space-y-3">
                <p className="text-[15px] font-light">The KVRN Set</p>
                <p className="text-[13px] text-[#6B6B6B] leading-relaxed">Same fabric, same standard. Designed to be worn together.</p>
                <p className="text-[15px] font-light tabular-nums">{formatPrice(product.price + relatedProduct.price)}</p>
                <Link href={`/products/${relatedProduct.slug}`}>
                  <Button variant="secondary" size="md">Shop {relatedProduct.name}</Button>
                </Link>
              </div>
            </div>
          </section>
        )}
      </div>

      {/* Sticky ATC — clean, full-width bar */}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-[200]',
          'transition-transform duration-300',
          stickyVisible ? 'translate-y-0' : 'translate-y-full'
        )}
        aria-hidden={!stickyVisible}
      >
        <div className="bg-[#F9F8F6] border-t border-[#E8E5E0] px-4 md:px-8 py-3">
          <div className="max-w-4xl mx-auto flex items-center gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-[13px] font-light truncate">{product.name}</p>
              <p className="text-[11px] text-[#9B9B9B]">
                {selectedSize ? `${selectedColor.name} / ${selectedSize}` : selectedColor.name}
              </p>
            </div>
            <p className="text-[15px] font-light tabular-nums flex-shrink-0">
              {formatPrice(product.price)}
            </p>
            <button
              onClick={handleAdd}
              disabled={soldOut}
              className={cn(
                'flex-shrink-0 h-10 px-8',
                'text-[11px] font-light tracking-[0.1em] uppercase',
                'transition-all duration-200',
                soldOut
                  ? 'bg-[#E8E5E0] text-[#9B9B9B] cursor-not-allowed'
                  : addState === 'added'
                  ? 'bg-[#15803D] text-white'
                  : 'bg-[#1A1A1A] text-white hover:bg-[#333]'
              )}
            >
              {soldOut ? 'Sold Out' : addState === 'added' ? 'Added' : 'Add to Bag'}
            </button>
          </div>
        </div>
      </div>
    </>
  )
}
