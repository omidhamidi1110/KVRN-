
/** KVRN free-first creator research: manually reviewed TikTok profile links only.
 * No scraping, outbound messaging, provider API access or paid model calls.
 */
export type CreatorReview = {
  handle: string
  category: string
  profileUrl: string
  sampleVideoUrl: string | null
  fitRating: number | null
  contentRating: number | null
  consistencyRating: number | null
  engagementRating: number | null
  notes: string
  source: 'manual_owner_review'
}

const CATEGORIES = new Set(['streetwear', 'mens_fashion', 'outfits', 'lifestyle', 'ugc', 'other'])
function rating(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5)
    throw new Error('Ratings must be whole numbers from 1 through 5.')
  return value
}
export function normalizeCreatorHandle(value: unknown): string {
  if (typeof value !== 'string') throw new Error('A TikTok handle is required.')
  const raw = value.trim()
  let handle = raw.replace(/^@/, '')
  if (/^https:\/\//i.test(raw)) {
    let url: URL
    try { url = new URL(raw) } catch { throw new Error('Invalid TikTok URL.') }
    if (!['www.tiktok.com', 'tiktok.com', 'm.tiktok.com'].includes(url.hostname.toLowerCase()))
      throw new Error('Only TikTok creator profiles are supported.')
    const match = url.pathname.match(/^\/@([A-Za-z0-9._]{2,24})\/?$/)
    if (!match) throw new Error('Enter a TikTok profile link, not a video or search URL.')
    handle = match[1]
  }
  if (!/^[A-Za-z0-9._]{2,24}$/.test(handle)) throw new Error('Invalid TikTok handle.')
  return handle.toLowerCase()
}
function videoUrl(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 300) throw new Error('Invalid example video link.')
  let url: URL
  try { url = new URL(value.trim()) } catch { throw new Error('Invalid example video link.') }
  if (url.protocol !== 'https:' || url.username || url.password || !['www.tiktok.com', 'tiktok.com', 'm.tiktok.com'].includes(url.hostname.toLowerCase()) ||
      !/^\/@[A-Za-z0-9._]{2,24}\/video\/\d{10,22}\/?$/.test(url.pathname))
    throw new Error('Example must be a public TikTok video link.')
  return `https://www.tiktok.com${url.pathname}`
}
export function validateCreatorReview(input: unknown): CreatorReview {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid creator review.')
  const b = input as Record<string, unknown>
  const handle = normalizeCreatorHandle(b.handle)
  const category = typeof b.category === 'string' ? b.category : ''
  if (!CATEGORIES.has(category)) throw new Error('Choose a creator category.')
  const notes = typeof b.notes === 'string' ? b.notes.trim() : ''
  if (notes.length > 800) throw new Error('Notes must be at most 800 characters.')
  return {
    handle, category, profileUrl: `https://www.tiktok.com/@${handle}`,
    sampleVideoUrl: videoUrl(b.sampleVideoUrl),
    fitRating: rating(b.fitRating), contentRating: rating(b.contentRating),
    consistencyRating: rating(b.consistencyRating), engagementRating: rating(b.engagementRating),
    notes, source: 'manual_owner_review',
  }
}

/** Weighted screening score, not a prediction of sales or evidence of conversion. */
export function scoreCreatorReview(review: Pick<CreatorReview, 'fitRating' | 'contentRating' | 'consistencyRating' | 'engagementRating'>): {
  score: number; evidenceCount: number; label: 'reviewed' | 'needs_review'
} {
  const weighted: Array<[number | null, number]> = [
    [review.fitRating, 40], [review.contentRating, 30],
    [review.consistencyRating, 15], [review.engagementRating, 15],
  ]
  const evidenceCount = weighted.filter(([value]) => value !== null).length
  const totalWeight = weighted.reduce((acc, [value, weight]) => acc + (value === null ? 0 : weight), 0)
  const score = totalWeight ? Math.round(weighted.reduce((acc, [value, weight]) =>
    acc + (value === null ? 0 : (value / 5) * weight), 0) / totalWeight * 100) : 0
  return { score, evidenceCount, label: evidenceCount === 4 ? 'reviewed' : 'needs_review' }
}

/** Draft only. Never dispatch. No compensation, free products or promised rates. */
export function creatorAffiliateOutreachDraft(handle: string): string {
  const safe = normalizeCreatorHandle(handle)
  return `Hey @${safe}! I run KVRN, a minimalist streetwear brand. I came across your content and think your style could be a great fit. We're looking for creators interested in an affiliate collaboration. If you're open to it, I can send the details and you can also apply at https://kvrn.shop/affiliates/apply. No pressure either way!`
}

/** Existing database status values; no schema mutation required. */
export type CreatorStage = 'discovered' | 'qualified' | 'contact_ready' | 'contacted' | 'replied' | 'applied' | 'onboarded' | 'declined' | 'rejected' | 'do_not_contact'
export type CreatorAction = 'qualify' | 'prepare_draft' | 'approve_draft' | 'mark_contacted' | 'record_reply' | 'mark_applied' | 'mark_onboarded' | 'decline' | 'reject' | 'do_not_contact'
export const CREATOR_TRANSITIONS: Record<Exclude<CreatorAction,'prepare_draft'|'approve_draft'|'do_not_contact'>, { from: CreatorStage[], to: CreatorStage }> = {
  qualify: { from:['discovered'], to:'qualified' },
  mark_contacted: { from:['contact_ready'], to:'contacted' },
  record_reply: { from:['contacted'], to:'replied' },
  mark_applied: { from:['replied','contacted'], to:'applied' },
  mark_onboarded: { from:['applied'], to:'onboarded' },
  decline: { from:['qualified','contact_ready','contacted','replied','applied'], to:'declined' },
  reject: { from:['discovered','qualified'], to:'rejected' },
}
export function allowedCreatorAction(status: string, action: string, dnc: boolean, reviewed: boolean, approvedDraft: boolean): boolean {
  if (action === 'do_not_contact') return !dnc
  if (dnc || status === 'do_not_contact' || status === 'declined' || status === 'rejected') return false
  if (action === 'prepare_draft') return ['qualified','contact_ready'].includes(status) && reviewed
  if (action === 'approve_draft') return ['qualified','contact_ready'].includes(status) && reviewed
  const transition = CREATOR_TRANSITIONS[action as keyof typeof CREATOR_TRANSITIONS]
  if (!transition) return false
  if (action === 'qualify' && !reviewed) return false
  if (action === 'mark_contacted' && !approvedDraft) return false
  return transition.from.includes(status as CreatorStage)
}

/** These figures are estimates only: never overwrite canonical order financials. */
export function estimateCreatorOffer(b: {
  salePriceCents:number, productCostCents:number, couponCents:number, commissionRatePct:number,
  paymentFeesCents:number, merchantShippingCents:number, returnAllowanceCents:number, creatorIncentiveCents:number,
}): { contributionCents:number, commissionCents:number, viable:boolean } {
  const vals = [b.salePriceCents,b.productCostCents,b.couponCents,b.paymentFeesCents,
    b.merchantShippingCents,b.returnAllowanceCents,b.creatorIncentiveCents]
  if (vals.some(v=>!Number.isInteger(v)||v<0||v>100000000)||!Number.isFinite(b.commissionRatePct)||b.commissionRatePct<0||b.commissionRatePct>100)
    throw new Error('Use valid nonnegative amounts and a commission rate from 0 to 100%.')
  if(b.couponCents>b.salePriceCents) throw new Error('Discount cannot exceed the selling price.')
  const retained = b.salePriceCents-b.couponCents
  const commissionCents = Math.round(retained*b.commissionRatePct/100)
  const contributionCents=retained-b.productCostCents-commissionCents-b.paymentFeesCents-b.merchantShippingCents-b.returnAllowanceCents-b.creatorIncentiveCents
  return {contributionCents,commissionCents,viable:contributionCents>0}
}

export const FREE_CREATOR_QUERIES: Record<string,string> = {
  streetwear:'site:tiktok.com/@ streetwear outfit styling UGC creator',
  menswear:'site:tiktok.com/@ mens fashion outfits style creator',
  hoodie:'site:tiktok.com/@ oversized hoodie outfit streetwear',
  review:'site:tiktok.com/@ clothing try on UGC review',
  lifestyle:'site:tiktok.com/@ lifestyle fashion creator',
}
export function validatedCreatorQuery(v:unknown): string {
  if(typeof v!=='string' || v.length>120 || v.trim().length<3 || /[\r\n\0]/.test(v)) throw new Error('Enter a search topic (3–120 characters).')
  return v.trim().replace(/\s+/g,' ')
}
export function creatorSearchUrl(query:string): string {
  return 'https://www.google.com/search?q='+encodeURIComponent(query)
}
