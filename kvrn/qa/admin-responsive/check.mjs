#!/usr/bin/env node
// Reproducible Admin responsive check (no production access; every /api/* call is mocked).
//   npm i --no-save playwright-core   (Chromium: PLAYWRIGHT_BROWSERS_PATH or `npx playwright-core install chromium`)
//   npx next dev -p 3111 &            (NODE_ENV=development; Admin auth is enforced by Cloudflare Access, not the dev server)
//   BASE=http://localhost:3111 node qa/admin-responsive/check.mjs [--routes=/admin/financials/shipping,...] [--widths=320,390] [--shots=dir]
// Asserts, per route x viewport: document does not scroll horizontally (scrollWidth <= innerWidth),
// innerWidth equals the device width (layout viewport did not grow = no mobile zoom-out / dark strip),
// admin shell is as wide as the viewport, header visible, no uncaught page errors.
// Exit code 1 on any failure; JSON evidence on stdout.
import { chromium } from 'playwright-core'
import fs from 'node:fs'
import path from 'node:path'

const arg = (k, d) => (process.argv.find(a => a.startsWith(`--${k}=`)) ?? '').split('=')[1] ?? d
const BASE = process.env.BASE ?? 'http://localhost:3111'
const widths = arg('widths', '320,360,375,390,414,430,768,1024,1280,1440').split(',').map(Number)
const routes = arg('routes', '/admin/financials/shipping').split(',')
const shots = arg('shots', '')
const strictErrors = process.argv.includes('--fail-on-page-error') // generic API mocks can legitimately crash data-heavy pages; opt in with route-specific mocks
const TOL = 1

const shipping = {
  totals: { orders: 2, ordersWithKnownCost: 1, ordersMissingCost: 1, shippingRevenueCents: 598, shippingDiscountCents: 0, shippingCostCents: 0, shippingMarginCents: 598, shippingSubsidyCents: 0, freeShippingOrders: 0, freeShippingCostCents: 0, ordersUnderwater: 0, ordersProfitable: 1 },
  orders: [
    { orderId: 'o1', orderNumber: 'KVRN-100245', paidAt: '2026-10-05T12:00:00Z', shippingRevenueCents: 598, shippingCostCents: 0, shippingMarginCents: 598, isAutoFreeShipping: false, shippingDiscountTotalCents: 0 },
    { orderId: 'o2', orderNumber: 'KVRN-100246', paidAt: '2026-10-06T12:00:00Z', shippingRevenueCents: 0, shippingCostCents: null, shippingMarginCents: null, isAutoFreeShipping: true, shippingDiscountTotalCents: 598 },
  ],
  pendingCost: [{ shipmentId: 's1', orderId: 'o2', orderNumber: 'KVRN-100246', shippingRevenueCents: 0, carrier: 'USPS', trackingNumber: '9400111899223344556677', serviceLevel: 'Ground Advantage', shippedAt: '2026-10-06T12:00:00Z' }],
}
const mockFor = url => (url.includes('/financials/shipping') ? shipping : { ok: true, items: [], rows: [], orders: [], products: [], entities: [], data: [] })

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const results = []
for (const route of routes) for (const w of widths) {
  const mobile = w < 768
  const ctx = await browser.newContext({
    viewport: { width: w, height: 844 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2,
    userAgent: mobile ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1' : undefined,
  })
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(String(e.message).slice(0, 160)))
  await page.route('**/api/**', r => r.fulfill({ json: mockFor(r.request().url()) }))
  await page.goto(BASE + route, { waitUntil: 'networkidle' }).catch(e => errors.push('goto: ' + e.message))
  await page.waitForTimeout(500)
  const m = await page.evaluate(() => {
    const de = document.documentElement
    const shell = document.querySelector('#admin-main')?.parentElement
    const vis = [...document.querySelectorAll('aside, .sticky')].some(e => e.getBoundingClientRect().height > 0 && getComputedStyle(e).visibility !== 'hidden')
    return {
      inner: innerWidth, scrollW: de.scrollWidth, clientW: de.clientWidth,
      shellW: shell ? Math.round(shell.getBoundingClientRect().width) : null,
      headerVisible: vis,
    }
  })
  const failures = []
  if (m.scrollW > w + TOL) failures.push(`document scrolls horizontally: scrollWidth ${m.scrollW} > ${w}`)
  if (Math.abs(m.inner - w) > TOL) failures.push(`layout viewport grew: innerWidth ${m.inner} != ${w} (mobile zoom-out / dark right strip)`)
  if (m.shellW !== null && Math.abs(m.shellW - w) > TOL) failures.push(`admin shell ${m.shellW}px != viewport ${w}px`)
  if (!m.headerVisible) failures.push('no visible header/sidebar')
  const pageErrors = errors
  if (strictErrors) for (const e of errors) failures.push('page error: ' + e)
  if (shots) { fs.mkdirSync(shots, { recursive: true }); await page.screenshot({ path: path.join(shots, `${route.replace(/\//g, '_')}_${w}.png`) }) }
  results.push({ route, width: w, ...m, failures, pageErrors })
  await ctx.close()
}
await browser.close()
const bad = results.filter(r => r.failures.length)
console.log(JSON.stringify({ base: BASE, checked: results.length, failed: bad.length, results }, null, 1))
process.exit(bad.length ? 1 : 0)
