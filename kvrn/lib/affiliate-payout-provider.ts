// lib/affiliate-payout-provider.ts — payout / onboarding provider abstraction.
// Server-only. NO NETWORK CALLS HERE, and no provider account is ever created by this batch.
//
// Adapters
//   manual          (default)  KVRN pays outside the system and records it through the existing Admin payout flow
//                              (create_affiliate_payout → mark_affiliate_payout_paid). Identity/tax/payout-method
//                              readiness is attested by an Admin with a written note (set_affiliate_readiness).
//   stripe_connect  (skeleton) Documented and deliberately UNCONFIGURED: every method throws
//                              ProviderNotConfiguredError. It exists so the call sites, gating and tests are
//                              provider-shaped; wiring a real provider is a separate, reviewed step.
//
// ── STRIPE CONNECT: EVALUATION NOTES (not a decision; verify every point against current Stripe docs) ───────
//   Fit        KVRN already uses Stripe for checkout, so Connect would share vendor, dashboard and webhooks.
//              Connect Express with Stripe-hosted onboarding (Account Links) would collect identity/DOB, payout
//              details and tax information on Stripe's pages — KVRN would store only the acct_ reference and the
//              status mirrors (affiliate_payout_accounts), which matches the "no vault" principle.
//   Cost       Per-active-account and per-payout fees and cross-border fees apply; pricing changes — confirm on
//              Stripe's current Connect pricing page before committing.
//   Requirements  A Connect platform application/approval; platform liability for negative balances/disputes on
//              Express accounts; Connect-specific terms and an affiliate-facing agreement; webhook endpoint for
//              account.updated / payout.* events (not built here); country coverage limited to Stripe's supported
//              payout countries — the program country allowlist (site_settings affiliate.program) must be a subset;
//              tax-form collection/1099 reporting capabilities and thresholds differ by country and change over time —
//              have the CPA confirm. Sanctions/restricted-party screening is performed by Stripe on onboarding.
//   Recommendation  Keep `manual` until KVRN has: an attorney/CPA-reviewed agreement, a decision on Connect liability,
//              and the webhook handler. Then implement the adapter below behind AFFILIATE_AUTO_PAYOUTS.

export type ProviderId = 'manual' | 'stripe_connect'

export class ProviderNotConfiguredError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED'
  constructor(provider: ProviderId) { super(`Payout provider "${provider}" is not configured.`) }
}

export type OnboardingLinkResult =
  | { kind: 'manual_instructions'; message: string }
  | { kind: 'hosted_link'; url: string; expiresAt: string }

export interface ProviderStatusResult {
  /** null = this provider reports nothing (manual): Admin-attested statuses stay as they are. */
  kyc: 'not_started' | 'pending' | 'verified' | 'problem' | null
  tax: 'not_started' | 'pending' | 'complete' | 'problem' | null
  payoutMethod: 'not_started' | 'pending' | 'ready' | 'failed' | null
  requirementsDue: string[]
}

export type ProviderPayoutResult =
  | { outcome: 'manual_required' }
  | { outcome: 'submitted' | 'failed'; providerReference: string | null; failureCode?: string }

export interface PayoutProvider {
  readonly id: ProviderId
  readonly supportsAutomatedPayouts: boolean
  isConfigured(): boolean
  createOnboardingLink(input: { affiliateId: string; returnUrl: string; refreshUrl: string }): Promise<OnboardingLinkResult>
  getStatus(input: { providerAccountRef: string | null }): Promise<ProviderStatusResult>
  createPayout(input: {
    payoutId: string; amountCents: number; currency: string; providerAccountRef: string | null; idempotencyKey: string
  }): Promise<ProviderPayoutResult>
}

export const manualProvider: PayoutProvider = {
  id: 'manual',
  supportsAutomatedPayouts: false,
  isConfigured: () => true,
  async createOnboardingLink() {
    return {
      kind: 'manual_instructions',
      message: 'KVRN will contact you to complete identity, tax and payout setup. You do not need to send any documents through this portal.',
    }
  },
  async getStatus() { return { kyc: null, tax: null, payoutMethod: null, requirementsDue: [] } },
  async createPayout() { return { outcome: 'manual_required' } },
}

/** UNCONFIGURED skeleton. Never calls Stripe. */
export const stripeConnectProvider: PayoutProvider = {
  id: 'stripe_connect',
  supportsAutomatedPayouts: true,
  isConfigured: () => false,
  async createOnboardingLink() { throw new ProviderNotConfiguredError('stripe_connect') },
  async getStatus() { throw new ProviderNotConfiguredError('stripe_connect') },
  async createPayout() { throw new ProviderNotConfiguredError('stripe_connect') },
}

const REGISTRY: Record<ProviderId, PayoutProvider> = { manual: manualProvider, stripe_connect: stripeConnectProvider }

export function isProviderId(v: unknown): v is ProviderId { return v === 'manual' || v === 'stripe_connect' }

/** Selected by AFFILIATE_PAYOUT_PROVIDER; anything unknown falls back to `manual` (the safe default). */
export function getPayoutProvider(
  id: unknown = process.env.AFFILIATE_PAYOUT_PROVIDER, registry: Record<ProviderId, PayoutProvider> = REGISTRY,
): PayoutProvider {
  return isProviderId(id) ? registry[id] : registry.manual
}

// ── Automated execution (flag-gated; a no-op unless a configured, automation-capable provider exists) ────────
export type AutoPayoutOutcome =
  | { outcome: 'disabled' }                       // AFFILIATE_AUTO_PAYOUTS is OFF
  | { outcome: 'not_configured'; provider: ProviderId }
  | { outcome: 'blocked'; blockers: string[] }
  | { outcome: 'manual_required' }
  | { outcome: 'submitted' | 'failed'; providerReference: string | null }

export interface AutoPayoutDeps {
  flagEnabled: () => boolean
  provider: PayoutProvider
  /** Gate decision for the payout's affiliate (lib/affiliate-payout-gate). */
  gate: (affiliateId: string) => Promise<{ allowed: boolean; blockers: Array<{ code: string }> }>
}

/**
 * Attempt to execute ONE existing draft payout through the provider. Safe by construction:
 *   flag OFF → nothing; provider unconfigured/manual → nothing; gate blocks → nothing.
 * It never creates a payout and never marks one paid — recording the result is the caller's job.
 */
export async function attemptAutomaticPayout(
  deps: AutoPayoutDeps,
  payout: { id: string; affiliateId: string; amountCents: number; currency: string; providerAccountRef: string | null; idempotencyKey: string },
): Promise<AutoPayoutOutcome> {
  if (!deps.flagEnabled()) return { outcome: 'disabled' }
  if (!deps.provider.supportsAutomatedPayouts || !deps.provider.isConfigured()) {
    return deps.provider.id === 'manual' ? { outcome: 'manual_required' } : { outcome: 'not_configured', provider: deps.provider.id }
  }
  const g = await deps.gate(payout.affiliateId)
  if (!g.allowed) return { outcome: 'blocked', blockers: g.blockers.map(b => b.code) }
  const r = await deps.provider.createPayout({
    payoutId: payout.id, amountCents: payout.amountCents, currency: payout.currency,
    providerAccountRef: payout.providerAccountRef, idempotencyKey: payout.idempotencyKey,
  })
  if (r.outcome === 'manual_required') return { outcome: 'manual_required' }
  return { outcome: r.outcome, providerReference: r.providerReference }
}
