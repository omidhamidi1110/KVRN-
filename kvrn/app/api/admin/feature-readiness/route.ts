import { type NextRequest, NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/admin-auth'
import { isFeatureEnabled, type FeatureFlagName } from '@/lib/feature-flags'
import { sql } from '@/lib/db'
import { SEED_ACTOR } from '@/lib/content-seed-actor'

export const dynamic = 'force-dynamic'

type Readiness = { name: FeatureFlagName; readyToActivate: boolean; blockers: string[] }

/** Read-only feature activation planner. No secrets, DB writes, flags, or provider calls. */
export async function GET(req: NextRequest) {
  const { error } = await requireAdmin(req)
  if (error) return error
  const present = (key: string) => Boolean((process.env[key] || '').trim())
  const items: Readiness[] = []
  const add = (name: FeatureFlagName, blockers: string[]) => items.push({ name, readyToActivate: blockers.length === 0, blockers })

  const contentBlockers: string[] = []
  try {
    const [r] = await sql`
      SELECT COUNT(*)::integer AS reviewed_count FROM content_entities e
      JOIN content_versions v ON v.entity_type=e.entity_type AND v.entity_id=e.entity_id
         AND v.version_no=e.published_version_no
      WHERE e.status='published' AND v.published_by IS DISTINCT FROM ${SEED_ACTOR}
    `
    if (!Number(r?.reviewed_count)) contentBlockers.push('No owner-reviewed published CMS versions detected; coded policy pages are still authoritative.')
    const required = ['privacy', 'terms', 'cookies', 'shipping-returns']
    const rows = await sql`
      SELECT e.entity_id FROM content_entities e
      JOIN content_versions v ON v.entity_type=e.entity_type AND v.entity_id=e.entity_id
        AND v.version_no=e.published_version_no
      WHERE e.entity_type='policy' AND e.status='published'
        AND v.published_by IS DISTINCT FROM ${SEED_ACTOR}
    `
    const published = new Set(rows.map(row => String(row.entity_id)))
    const missing = required.filter(id => !published.has(id))
    if (missing.length) contentBlockers.push('Owner-reviewed CMS policy versions not published: ' + missing.join(', ') + '. Coded fallbacks remain in use.')
    const [faq] = await sql`
      SELECT COUNT(*)::integer AS count FROM content_entities e
      JOIN content_versions v ON v.entity_type=e.entity_type AND v.entity_id=e.entity_id
        AND v.version_no=e.published_version_no
      WHERE e.entity_type='faq' AND e.status='published'
        AND v.published_by IS DISTINCT FROM ${SEED_ACTOR}
    `
    if (!Number(faq?.count)) contentBlockers.push('FAQ has no owner-published CMS version; coded FAQ remains authoritative.')
    contentBlockers.push('Owner must confirm reviewed CMS copy matches approved policies, FAQ, footer and navigation before enabling.')
  } catch {
    contentBlockers.push('Cannot read CMS published-version status. Leave public content flag off.')
  }
  add('CMS_PUBLIC_CONTENT', contentBlockers)
  const productBlockers: string[] = []
  try {
    const [counts] = await sql`
      SELECT
        COUNT(*) FILTER (WHERE p.active)::integer AS active_count,
        COUNT(*) FILTER (WHERE p.active AND (e.status IS DISTINCT FROM 'published'
          OR e.published_version_no IS NULL))::integer AS unpublished_count,
        COUNT(*) FILTER (WHERE p.active AND e.draft_version_no IS DISTINCT FROM e.published_version_no)::integer AS pending_drafts,
        COUNT(*) FILTER (WHERE p.active AND p.price_cents <= 0)::integer AS invalid_prices
      FROM products p LEFT JOIN content_entities e ON e.entity_type='product' AND e.entity_id=p.id::text
      WHERE p.catalog_origin IS NOT NULL
    `
    if (!Number(counts?.active_count)) productBlockers.push('No active CMS catalog products found.')
    if (Number(counts?.unpublished_count)) productBlockers.push(`${counts.unpublished_count} active product(s) missing a published CMS version.`)
    if (Number(counts?.pending_drafts)) productBlockers.push(`${counts.pending_drafts} product(s) have unpublished CMS changes.`)
    if (Number(counts?.invalid_prices)) productBlockers.push(`${counts.invalid_prices} active product(s) lack a positive canonical price.`)
    // Name the records that must be corrected, so an operator does not have to infer
    // which published product is blocking an activation from aggregate counts.
    const products = await sql`
      SELECT p.product_code, p.id::text AS id, e.slug, p.price_cents,
             e.status AS cms_status, e.published_version_no, e.draft_version_no,
             (SELECT COUNT(*)::integer FROM product_variants pv WHERE pv.product_id=p.id AND pv.active) AS variant_count
      FROM products p LEFT JOIN content_entities e
        ON e.entity_type='product' AND e.entity_id=p.id::text
      WHERE p.catalog_origin IS NOT NULL AND p.active = TRUE
      ORDER BY p.product_code NULLS LAST, p.id LIMIT 100
    `
    for (const p of products) {
      const label = String(p.product_code || p.slug || p.id)
      if (p.cms_status !== 'published' || p.published_version_no == null)
        productBlockers.push(`${label}: publish a CMS product version before enabling routing.`)
      else if (p.draft_version_no != null && p.draft_version_no !== p.published_version_no)
        productBlockers.push(`${label}: has unpublished draft changes. Review, publish or discard in Admin → Products.`)
      if (Number(p.price_cents) <= 0) productBlockers.push(`${label}: canonical price is invalid.`)
      if (Number(p.variant_count) === 0) productBlockers.push(`${label}: no active canonical variants.`)
    }
    // Price/media/checkout source alignment still requires an explicit owner review.
    productBlockers.push('Owner must confirm product images, variant stock, USD prices and existing URLs in Admin before activating CMS routing.')
  } catch { productBlockers.push('Cannot read canonical product CMS readiness; leave product routing OFF.') }
  add('CMS_PRODUCT_ROUTING', productBlockers)
  add('RADAR_FULFILLMENT_HOLDS', ['Verify Stripe Radar webhook event coverage and actual hold/release authorization flow.'])
  add('ABANDONED_CHECKOUT_EMAILS', [
    ...(!present('ABANDONED_LINK_SECRET') ? ['ABANDONED_LINK_SECRET is missing.'] : []),
    ...(!present('RESEND_API_KEY') ? ['RESEND_API_KEY is missing.'] : []),
    'Review recipients’ email consent, recovery schedule, and idempotency before sending.',
  ])
  add('AFFILIATE_APPLICATIONS', [
    ...(!present('AFFILIATE_HASH_PEPPER') ? ['AFFILIATE_HASH_PEPPER is missing.'] : []),
    'Owner-approved affiliate terms and program documents must be published.',
  ])
  add('AFFILIATE_PORTAL', [
    ...(!present('AFFILIATE_AUTH_PEPPER') ? ['AFFILIATE_AUTH_PEPPER is missing.'] : []),
    ...(!present('RESEND_API_KEY') ? ['RESEND_API_KEY is missing for magic links.'] : []),
    'Portal privacy/cookie disclosure must be published and access provisioning confirmed.',
  ])
  add('MULTI_CURRENCY_CHECKOUT', ['Intentionally disabled: KVRN charges in USD.'])
  add('AFFILIATE_AUTO_PAYOUTS', ['Intentionally disabled: manual payouts and Pushover reminders are preferred.'])

  // Additional production gates, beyond the eight explicit feature flags on System.
  // These read-only booleans expose no provider tokens or customer details.
  const otherControls = [
    { label: 'Live checkout', env: 'ENABLE_CHECKOUT', enabled: process.env.ENABLE_CHECKOUT === 'true', note: 'Stripe live-mode and webhook credentials must be configured separately.' },
    { label: 'AI Operations', env: 'AI_ENABLED', enabled: process.env.AI_ENABLED === 'true', note: 'Deferred until owner supplies AI provider credentials.' },
    { label: 'AI Chief phone notifications', env: 'AI_CHIEF_NOTIFICATION_GATE', enabled: process.env.AI_CHIEF_NOTIFICATION_GATE === 'true', note: 'Pushover credentials and rate limits are required.' },
    { label: 'SMS marketing sends', env: 'TWILIO_MARKETING_SEND_ENABLED', enabled: process.env.TWILIO_MARKETING_SEND_ENABLED === 'true', note: 'Do not activate for legacy contacts without verifiable, KVRN-specific consent.' },
    { label: 'SMS signup', env: 'TWILIO_SIGNUP_ENABLED', enabled: process.env.TWILIO_SIGNUP_ENABLED === 'true', note: 'Requires registered A2P campaign and opt-in flow.' },
    { label: 'A2P carrier approval', env: 'TWILIO_A2P_APPROVED', enabled: process.env.TWILIO_A2P_APPROVED === 'true', note: 'This reflects provider approval, not a switch to bypass.' },
    { label: 'SMS legal pages', env: 'KVRN_SMS_POLICY_PUBLIC_ENABLED', enabled: process.env.KVRN_SMS_POLICY_PUBLIC_ENABLED === 'true', note: 'Publish reviewed messaging terms/privacy before opting in.' },
    { label: 'Store credit issuance', env: 'STORE_CREDIT_ISSUANCE_ENABLED', enabled: process.env.STORE_CREDIT_ISSUANCE_ENABLED === 'true', note: 'Owner-restricted issuance, separate from checkout redemption.' },
    { label: 'Store credit checkout release', env: 'STORE_CREDIT_CHECKOUT_RELEASE_ENABLED', enabled: process.env.STORE_CREDIT_CHECKOUT_RELEASE_ENABLED === 'true' && process.env.STRIPE_MODE === 'test', note: 'Test-mode only; live USD credit redemption not supported.' },
    { label: 'Google Merchant feed', env: 'KVRN_GOOGLE_MERCHANT_FEED_ENABLED', enabled: process.env.KVRN_GOOGLE_MERCHANT_FEED_ENABLED === 'true', note: 'Requires verified CMS product data and Google Merchant account.' },
  ]
  return NextResponse.json({ items, otherControls,
    note: 'Read-only; requires review before activation. This endpoint never changes a feature.',
    enabled: Object.fromEntries(items.map(it => [it.name, isFeatureEnabled(it.name)])) },
    { headers: { 'Cache-Control': 'private, no-store' } })
}
