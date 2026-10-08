// lib/feature-flags.ts — independent production kill switches for high-risk features.
//
// DESIGN
//   * Every flag is read from its OWN environment variable `KVRN_FLAG_<NAME>` (a
//     Cloudflare Worker variable). There is deliberately NO database dependency: a kill
//     switch must keep working when the feature it guards — or the database — is broken.
//   * Default is OFF. Deploying code never turns a high-risk behavior on. A flag is ON only
//     when its variable is exactly one of: on, true, 1, yes, enabled (case-insensitive).
//     Anything else — unset, empty, "off", a typo — is OFF (fail closed).
//   * Flags are independent: enabling one never implies another.
//   * Reading a flag is synchronous, side-effect free and safe in Edge/Worker/Node/tests.
//
// To enable one (no code deploy needed beyond the Worker variable change):
//   Cloudflare dashboard → Workers → kvrn → Settings → Variables → add KVRN_FLAG_<NAME> = on
// To kill it: set to off (or delete the variable). See docs/KVRN-feature-flags-and-cache-invalidation-plan.md.

export const FEATURE_FLAGS = {
  /** Foreign-currency payable checkout (Stripe presentment). OFF = USD only, exactly as before. */
  MULTI_CURRENCY_CHECKOUT: {
    env: 'KVRN_FLAG_MULTI_CURRENCY_CHECKOUT',
    label: 'Multi-currency checkout',
    description: 'Lets customers pay in a non-USD presentment currency. Off keeps checkout USD-only.',
  },
  /** Abandoned-checkout recovery EMAILS (record keeping may run without sending). */
  ABANDONED_CHECKOUT_EMAILS: {
    env: 'KVRN_FLAG_ABANDONED_CHECKOUT_EMAILS',
    label: 'Abandoned-checkout emails',
    description: 'Sends the single recovery email for abandoned checkouts. Off sends nothing.',
  },
  /** Radar-driven fulfillment holds. OFF = no new holds are created and none are enforced as new behavior. */
  RADAR_FULFILLMENT_HOLDS: {
    env: 'KVRN_FLAG_RADAR_FULFILLMENT_HOLDS',
    label: 'Radar fulfillment holds',
    description: 'Creates review holds from Stripe Radar signals and blocks fulfillment while held.',
  },
  /** Storefront product pages/shop read the Admin-managed catalog instead of coded data. */
  CMS_PRODUCT_ROUTING: {
    env: 'KVRN_FLAG_CMS_PRODUCT_ROUTING',
    label: 'CMS product routing',
    description: 'Serves product pages and the shop from Admin-managed products. Off serves the coded catalog.',
  },
  /** Storefront policy/FAQ/size-guide/page/nav/footer/announcement read Admin-managed content. */
  CMS_PUBLIC_CONTENT: {
    env: 'KVRN_FLAG_CMS_PUBLIC_CONTENT',
    label: 'CMS public content',
    description: 'Serves policies, FAQ, size guides, pages, navigation, footer and announcement from Admin content. Off serves coded content.',
  },
  /** Public /affiliates/apply form and its API. */
  AFFILIATE_APPLICATIONS: {
    env: 'KVRN_FLAG_AFFILIATE_APPLICATIONS',
    label: 'Affiliate applications',
    description: 'Opens the public affiliate application form. Off returns 404 / closed.',
  },
  /** Affiliate-only magic-link login and portal. */
  AFFILIATE_PORTAL: {
    env: 'KVRN_FLAG_AFFILIATE_PORTAL',
    label: 'Affiliate portal',
    description: 'Enables affiliate magic-link login and the private portal. Off blocks all affiliate sessions.',
  },
  /** Any automated affiliate payout execution. Manual Admin payouts are governed by existing code. */
  AFFILIATE_AUTO_PAYOUTS: {
    env: 'KVRN_FLAG_AFFILIATE_AUTO_PAYOUTS',
    label: 'Automated affiliate payouts',
    description: 'Allows payouts to be executed automatically through a payout provider. Off = manual only.',
  },
} as const

export type FeatureFlagName = keyof typeof FEATURE_FLAGS

const TRUTHY = new Set(['on', 'true', '1', 'yes', 'enabled'])

type EnvLike = Record<string, string | undefined>

/** Pure parser — exported for tests. Unknown / empty / non-string values are OFF. */
export function parseFlagValue(raw: unknown): boolean {
  if (typeof raw !== 'string') return false
  return TRUTHY.has(raw.trim().toLowerCase())
}

/** Is the flag ON? Reads the environment at call time (never cached across requests). */
export function isFeatureEnabled(name: FeatureFlagName, env: EnvLike = process.env as EnvLike): boolean {
  const def = FEATURE_FLAGS[name]
  if (!def) return false
  return parseFlagValue(env[def.env])
}

export interface FeatureFlagStatus {
  name: FeatureFlagName
  env: string
  label: string
  description: string
  enabled: boolean
  /** 'env' when the variable is set to something, 'default' when unset (default OFF). */
  source: 'env' | 'default'
  /** The raw value is NEVER returned (could be mistyped); only whether it was recognised. */
  recognised: boolean
}

/** Status of every flag, for the read-only Admin panel. */
export function listFeatureFlags(env: EnvLike = process.env as EnvLike): FeatureFlagStatus[] {
  return (Object.keys(FEATURE_FLAGS) as FeatureFlagName[]).map(name => {
    const def = FEATURE_FLAGS[name]
    const raw = env[def.env]
    const set = typeof raw === 'string' && raw.trim() !== ''
    const lowered = set ? raw!.trim().toLowerCase() : ''
    return {
      name,
      env: def.env,
      label: def.label,
      description: def.description,
      enabled: parseFlagValue(raw),
      source: set ? 'env' : 'default',
      // "off"/"false"/"0"/"no"/"disabled" are recognised OFF values; anything else non-truthy is a typo.
      recognised: !set || TRUTHY.has(lowered) || ['off', 'false', '0', 'no', 'disabled'].includes(lowered),
    }
  })
}
