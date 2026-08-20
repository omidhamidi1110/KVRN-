// lib/provider-portals.ts — official provider dashboard links
//
// These are NAVIGATION SHORTCUTS ONLY. No credentials, no tokens, no embedded
// sessions. Every link opens the provider's own dashboard where the operator
// authenticates normally.
//
// Only official first-party dashboard URLs are listed. Nothing here is derived
// from scraping, and no billing data is read from these pages.
//
// These remain available regardless of whether an automated provider adapter is
// configured (Batch 4), so the operator can always reach the real source of truth.

export interface ProviderPortal {
  /** Must match the `provider` string used in expense_transactions / usage snapshots. */
  provider: string
  label:    string
  url:      string
  /** What the operator would typically go there to do. */
  purpose:  string
}

export const PROVIDER_PORTALS: ProviderPortal[] = [
  {
    provider: 'Stripe',
    label:    'Stripe',
    url:      'https://dashboard.stripe.com/',
    purpose:  'Payouts, balance, processing fees, disputes',
  },
  {
    provider: 'Shippo',
    label:    'Shippo',
    url:      'https://apps.goshippo.com/',
    purpose:  'Labels purchased, shipment costs, invoices',
  },
  {
    provider: 'Twilio',
    label:    'Twilio',
    url:      'https://console.twilio.com/',
    purpose:  'Message usage, phone number charges, billing',
  },
  {
    provider: 'Resend',
    label:    'Resend',
    url:      'https://resend.com/overview',
    purpose:  'Emails sent, plan usage, invoices',
  },
  {
    provider: 'Neon',
    label:    'Neon',
    url:      'https://console.neon.tech/',
    purpose:  'Compute and storage usage, plan, billing',
  },
  {
    provider: 'Cloudflare',
    label:    'Cloudflare',
    url:      'https://dash.cloudflare.com/',
    purpose:  'Worker requests, plan limits, billing',
  },
  {
    provider: 'GitHub',
    label:    'GitHub',
    url:      'https://github.com/settings/billing',
    purpose:  'Codespaces compute and storage, billing usage',
  },
  {
    provider: 'Namecheap',
    label:    'Namecheap',
    url:      'https://ap.www.namecheap.com/',
    purpose:  'Domain renewal date and registration cost',
  },
]

/** Look up a portal by the provider name stored on an expense or usage record. */
export function portalForProvider(provider: string): ProviderPortal | null {
  const needle = provider.trim().toLowerCase()
  return PROVIDER_PORTALS.find(p => p.provider.toLowerCase() === needle) ?? null
}
