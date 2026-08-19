/**
 * cloudflare-cron-wrapper.js
 *
 * Minimal Cloudflare Worker entry that adds a Cron Trigger (scheduled) handler
 * to the existing OpenNext worker. All fetch handling is delegated unchanged
 * to the OpenNext-generated worker.
 *
 * WHY THIS FILE EXISTS:
 * The OpenNext-generated worker (.open-next/worker.js) exports only a `fetch`
 * handler. Cloudflare Cron Triggers require a `scheduled` export on the default
 * worker export. This wrapper adds it without modifying the OpenNext build output.
 *
 * DEPLOYMENT ORDER:
 *   1. npm run build              # generates .open-next/worker.js
 *   2. wrangler deploy            # bundles this wrapper + .open-next/worker.js
 *
 * FIX: CRON 522 SELF-FETCH ELIMINATED
 * Previous versions called fetch(SITE_URL + '/api/internal/transactional-email-retry'),
 * which caused HTTP 522 because a Cloudflare Worker cannot reliably make outbound HTTP
 * requests back to its own hostname — the request is routed through Cloudflare's edge
 * network and can time out.
 *
 * The fix: call openNextWorker.fetch(syntheticRequest, env, ctx) directly.
 * This invokes the Next.js API route handler within the same Worker process,
 * with no external network round-trip. The CRON_SECRET authentication is still
 * enforced by the route handler, so there is no reduction in security.
 *
 * CRON_SECRET must be set as a Cloudflare Worker secret (never in this file).
 */

// @ts-expect-error: .open-next/worker.js is generated at build time
import openNextWorker from './.open-next/worker.js'

export default {
  // Delegate all fetch requests to the OpenNext worker unchanged
  fetch: openNextWorker.fetch,

  /**
   * Cloudflare Cron Trigger handler — fires every 5 minutes.
   * Directly invokes the retry handler via openNextWorker.fetch (no external HTTP call).
   * Never logs PII. Failures are logged safely and do not affect order state.
   */
  async scheduled(event, env, ctx) {
    const cronSecret = env.CRON_SECRET

    if (!cronSecret) {
      console.error('[cron] CRON_SECRET is not configured — skipping email retry batch')
      return
    }

    // Synthesise an internal Request to the retry route.
    // Using openNextWorker.fetch avoids the 522 self-HTTP issue: the request is
    // handled entirely within this Worker process, with no outbound network call.
    const req = new Request('https://cron-internal/api/internal/transactional-email-retry', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${cronSecret}`,
        'Content-Type':  'application/json',
      },
    })

    // ── 1. Transactional email retry ─────────────────────────────────────────
    try {
      const res = await openNextWorker.fetch(req, env, ctx)
      if (!res.ok) {
        console.error(`[cron] Email retry handler returned HTTP ${res.status}`)
      } else {
        const data = await res.json().catch(() => ({}))
        const { processed = 0, sent = 0, failed = 0 } = data
        console.log(`[cron] Email retry: processed=${processed} sent=${sent} failed=${failed}`)
      }
    } catch (err) {
      console.error('[cron] Email retry failed:', err?.message || String(err))
    }

    // ── 2. Marketing contact sync ─────────────────────────────────────────────
    // Logically separate from transactional email retry.
    // Uses the same openNextWorker.fetch pattern to avoid public self-fetch (522).
    try {
      const syncReq = new Request('https://cron-internal/api/internal/marketing-sync', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${cronSecret}`,
          'Content-Type':  'application/json',
        },
      })
      const syncRes = await openNextWorker.fetch(syncReq, env, ctx)
      if (!syncRes.ok) {
        console.error(`[cron] Marketing sync returned HTTP ${syncRes.status}`)
      } else {
        const data = await syncRes.json().catch(() => ({}))
        const { processed = 0, synced = 0, failed = 0 } = data
        if (processed > 0) console.log(`[cron] Marketing sync: processed=${processed} synced=${synced} failed=${failed}`)
      }
    } catch (err) {
      console.error('[cron] Marketing sync failed:', err?.message || String(err))
    }

    // ── 3. Stripe fee reconciliation ─────────────────────────────────────────
    // Captures the ACTUAL processing fee for paid orders once Stripe settles the
    // charge. Fees are never estimated. Failures here never affect order state.
    try {
      const feeReq = new Request('https://cron-internal/api/internal/stripe-fee-reconcile', {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${cronSecret}`,
          'Content-Type':  'application/json',
        },
      })
      const feeRes = await openNextWorker.fetch(feeReq, env, ctx)
      if (!feeRes.ok) {
        console.error(`[cron] Stripe fee reconcile returned HTTP ${feeRes.status}`)
      } else {
        const data = await feeRes.json().catch(() => ({}))
        const { processed = 0, enriched = 0, notSettled = 0, failed = 0 } = data
        if (processed > 0) {
          console.log(`[cron] Stripe fees: processed=${processed} enriched=${enriched} notSettled=${notSettled} failed=${failed}`)
        }
      }
    } catch (err) {
      console.error('[cron] Stripe fee reconcile failed:', err?.message || String(err))
    }
  },
}
