/**
 * KVRN Merchant Center RSS export of PUBLIC canonical catalog facts ONLY.
 * No inventory guesses, personal information, discount mirrors, or variant
 * fabrication. Published products with missing factual price/image/stock are
 * excluded instead of publishing inaccurate offers.
 *
 * This is a baseline PRODUCT-LEVEL feed; apparel variant feeds, shipping and
 * return settings, GTINs, taxes, and Merchant Center account approval remain
 * separate launch gates.
 */
import type {PublishedProduct} from './product-public'

export type MerchantFeedResult={xml:string, included:number, skipped:number}

/**
 * OPTIONAL owner-supplied apparel attributes. Nothing is guessed: an attribute is emitted only when the owner configured a
 * valid value (env KVRN_MERCHANT_GENDER / _AGE_GROUP / _GOOGLE_CATEGORY, see docs/seo/SEO_ACCOUNT_RUNBOOK.md). Unset or invalid = omitted,
 * so the default feed is byte-identical to before. These are per-feed defaults, not per-product facts: set them only if they are true for
 * EVERY product in the feed.
 */
export interface MerchantFeedOptions{gender?:string|null, ageGroup?:string|null, googleProductCategory?:string|null}
const GENDERS=new Set(['male','female','unisex'])
const AGE_GROUPS=new Set(['newborn','infant','toddler','kids','adult'])
/** Google category: numeric taxonomy id or a ">"-separated path of plain words (no markup). */
const CATEGORY=/^(?:\d{1,7}|[A-Za-z0-9&,'\- ]+(?: > [A-Za-z0-9&,'\- ]+)*)$/
export function sanitizeMerchantOptions(o?:MerchantFeedOptions|null):{gender?:string,ageGroup?:string,googleProductCategory?:string}{
  const out:{gender?:string,ageGroup?:string,googleProductCategory?:string}={}
  const g=o?.gender?.trim().toLowerCase(); if(g&&GENDERS.has(g))out.gender=g
  const a=o?.ageGroup?.trim().toLowerCase(); if(a&&AGE_GROUPS.has(a))out.ageGroup=a
  const c=o?.googleProductCategory?.trim(); if(c&&c.length<=250&&CATEGORY.test(c))out.googleProductCategory=c
  return out
}
const MAX_PRODUCTS=1000
const validSlug=/^[a-z0-9]+(?:-[a-z0-9]+)*$/
const xmlEscape=(value:string)=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;')
const printable=(value:string,max:number)=>value.replace(/[\u0000-\u001F\u007F]/g,' ').replace(/\s+/g,' ').trim().slice(0,max)

/** Refuse unknown/unsafe origins instead of constructing crawled URLs. */
export function validatedMerchantOrigin(source:string):string|null{
  try{
    const u=new URL(source)
    if(u.protocol!=='https:'||u.username||u.password||u.search||u.hash||u.pathname!=='/'||u.hostname!== 'kvrn.shop')return null
    return u.origin
  }catch{return null}
}
function publicMediaUrl(src:unknown,origin:string):string|null{
  if(typeof src!=='string'||!src||src.length>2048)return null
  if(src.startsWith('/')&&!src.startsWith('//')){
    if(/[^\x20-\x7E]/.test(src)||/[\s<>"']/.test(src))return null
    return new URL(src,origin).href
  }
  try{
    const u=new URL(src)
    if(u.protocol!=='https:'||!u.hostname||u.username||u.password||u.hash)return null
    return u.href
  }catch{return null}
}

export function makeMerchantProductFeed(products:readonly PublishedProduct[],origin:string,options?:MerchantFeedOptions|null):MerchantFeedResult{
  const opt=sanitizeMerchantOptions(options)
  const extra=(opt.googleProductCategory?`\n      <g:google_product_category>${xmlEscape(opt.googleProductCategory)}</g:google_product_category>`:'')+(opt.gender?`\n      <g:gender>${opt.gender}</g:gender>`:'')+(opt.ageGroup?`\n      <g:age_group>${opt.ageGroup}</g:age_group>`:'')
  const safeOrigin=validatedMerchantOrigin(origin)
  if(!safeOrigin)throw Error('MERCHANT_FEED_ORIGIN_INVALID')
  if(!Array.isArray(products)||products.length>MAX_PRODUCTS)throw Error('MERCHANT_FEED_CATALOG_TOO_LARGE')
  const items:string[]=[]
  const seen=new Set<string>()
  let skipped=0
  for(const entry of products){
    const p=entry?.product
    const identifier=entry?.productId
    // Availability must be canonical and known, not inferred from UI color chips.
    // No stock_count exposed in this public feed.
    if(!p||!identifier||!validSlug.test(entry.slug)||p.hidden===true||entry.availability!=='InStock'&&entry.availability!=='OutOfStock'||
       !Number.isSafeInteger(p.price)||p.price<=0||p.price>100_000_000||seen.has(identifier)){
      skipped++;continue
    }
    const image=publicMediaUrl(entry.ogImage?.url??entry.imageUrls[0],safeOrigin)
    const title=printable(p.name??'',150)
    const description=printable(p.description||p.shortDescription||'',5000)
    if(!image||!title||!description){skipped++;continue}
    seen.add(identifier)
    const url=`${safeOrigin}/products/${entry.slug}`
    const stock=entry.availability==='InStock'?'in_stock':'out_of_stock'
    items.push(`<item>\n      <g:id>${xmlEscape(identifier)}</g:id>\n      <title>${xmlEscape(title)}</title>\n      <description>${xmlEscape(description)}</description>\n      <link>${xmlEscape(url)}</link>\n      <g:image_link>${xmlEscape(image)}</g:image_link>\n      <g:price>${(p.price/100).toFixed(2)} USD</g:price>\n      <g:availability>${stock}</g:availability>\n      <g:condition>new</g:condition>\n      <g:brand>KVRN</g:brand>${extra}\n    </item>`)
  }
  const xml=`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">\n  <channel>\n    <title>KVRN catalog</title>\n    <link>${xmlEscape(safeOrigin)}</link>\n    <description>Published KVRN catalog with verified pricing and availability</description>\n    ${items.join('\n    ')}\n  </channel>\n</rss>\n`
  return {xml,included:items.length,skipped}
}
