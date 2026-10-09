/** Flag-off default. No live publishing, API keys, PII or provider requests. */
import {NextResponse} from 'next/server'
import {listPublishedProducts} from '@/lib/product-public'
import {isFeatureEnabled} from '@/lib/feature-flags'
import {makeMerchantProductFeed} from '@/lib/google-merchant-feed'
export const dynamic='force-dynamic'
const off=()=>new NextResponse('Not Found',{status:404,headers:{'Cache-Control':'no-store','X-Robots-Tag':'noindex, nofollow'}})
export async function GET(){
  // Never advertise a coded catalog or speculative availability as merchant data.
  if(process.env.KVRN_GOOGLE_MERCHANT_FEED_ENABLED!=='true'||!isFeatureEnabled('CMS_PRODUCT_ROUTING'))return off()
  try{
    const products=await listPublishedProducts({includeUnlisted:false})
    const feed=makeMerchantProductFeed(products,process.env.NEXT_PUBLIC_SITE_URL||'https://kvrn.shop',{
      gender:process.env.KVRN_MERCHANT_GENDER,ageGroup:process.env.KVRN_MERCHANT_AGE_GROUP,googleProductCategory:process.env.KVRN_MERCHANT_GOOGLE_CATEGORY})
    if(feed.included===0)return new NextResponse('Feed temporarily unavailable',{status:503,headers:{'Cache-Control':'no-store'}})
    return new NextResponse(feed.xml,{headers:{
      'Content-Type':'application/rss+xml; charset=utf-8',
      'Cache-Control':'public, max-age=300, s-maxage=300',
      'X-Content-Type-Options':'nosniff',
      'X-Robots-Tag':'noindex, nofollow',
    }})
  }catch{
    // A broken catalog feed must not appear as an empty (valid) inventory.
    return new NextResponse('Feed temporarily unavailable',{status:503,headers:{'Cache-Control':'no-store'}})
  }
}
