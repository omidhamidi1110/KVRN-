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
 * This file is referenced by wrangler.toml `main`. It is NOT compiled by Next.js
 * or TypeScript — wrangler bundles it at deploy time after `npm run build` has
 * generated `.open-next/worker.js`.
 *
 * DEPLOYMENT ORDER:
 *   1. npm run build              # generates .open-next/worker.js
 *   2. wrangler deploy            # bundles this wrapper + .open-next/worker.js
 *
 * The cron handler self-calls the internal authenticated HTTP route.
 * CRON_SECRET must be set as a Cloudflare Worker secret (never in this file).
 */

// @ts-expect-error: .open-next/worker.js is generated at build time
import openNextWorker from './.open-next/worker.js'

export default {
  // Delegate all fetch requests to the OpenNext worker unchanged
  fetch: openNextWorker.fetch,

  /**
   * Cloudflare Cron Trigger handler — fires every 5 minutes.
   * Calls /api/internal/transactional-email-retry with CRON_SECRET auth.
   * Never logs PII. Failures are logged safely and do not affect order state.
   */
  async scheduled(event, env, ctx) {
    const siteUrl    = (env.SITE_URL || env.NEXT_PUBLIC_SITE_URL || '').replace(/\/$/, '')
    const cronSecret = env.CRON_SECRET

    if (!siteUrl) {
      console.error('[cron] SITE_URL is not configured — skipping email retry batch')
      return
    }
    if (!cronSecret) {
      console.error('[cron] CRON_SECRET is not configured — skipping email retry batch')
      return
    }

    try {
      const res = await fetch(`${siteUrl}/api/internal/transactional-email-retry`, {
        method:  'POST',
        headers: {
          'Authorization': `Bearer ${cronSecret}`,
          'Content-Type':  'application/json',
        },
      })

      if (!res.ok) {
        console.error(`[cron] Email retry route returned HTTP ${res.status}`)
        return
      }

      const data = await res.json().catch(() => ({}))
      const { processed = 0, sent = 0, failed = 0 } = data
      console.log(`[cron] Email retry: processed=${processed} sent=${sent} failed=${failed}`)
    } catch (err) {
      // Log only the error message — no PII
      console.error('[cron] Email retry fetch failed:', err?.message || String(err))
    }
  },
}
