import fs from 'node:fs'
import { chromium } from 'playwright'

const base = (process.env.KVRN_BROWSER_BASE_URL || '').replace(/\/$/, '')
const output = process.env.KVRN_BROWSER_OUTPUT || '/tmp/kvrn-browser.json'
if (!base) {
  console.log('Browser QA skipped: KVRN_BROWSER_BASE_URL not set.')
  fs.writeFileSync(output, JSON.stringify({ skipped: true, checks: [] }, null, 2))
  process.exit(0)
}

const checks = []
let browser
let hardFailures = 0

function record(testCaseId, name, status, started, failureCode = null, evidence = {}) {
  if (status === 'failed') hardFailures++
  checks.push({ testCaseId, name, status, durationMs: Date.now() - started, failureCode, evidence })
}

async function runCheck(testCaseId, name, fn) {
  const started = Date.now()
  try {
    const evidence = await fn()
    record(testCaseId, name, 'passed', started, null, evidence || {})
  } catch (err) {
    const message = String(err?.message || err || 'BROWSER_QA_FAILED').slice(0, 500)
    record(testCaseId, name, 'failed', started, 'BROWSER_QA_FAILED', { message })
    console.error(`FAIL ${name}: ${message}`)
  }
}

async function newPage(viewport) {
  const context = await browser.newContext({
    viewport,
    userAgent: 'KVRN-QA-Browser/1.0',
    locale: 'en-US',
  })
  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', err => pageErrors.push(String(err?.message || err).slice(0, 300)))
  return { context, page, pageErrors }
}

try {
  browser = await chromium.launch({ headless: true })

  await runCheck('browser_storefront', 'desktop storefront journey', async () => {
    const { context, page, pageErrors } = await newPage({ width: 1440, height: 1000 })
    try {
      const response = await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 20_000 })
      if (!response || response.status() >= 400) throw new Error(`Homepage HTTP ${response?.status() ?? 'no-response'}`)
      await page.locator('a[href="/shop"]').first().waitFor({ state: 'visible', timeout: 10_000 })
      await page.goto(`${base}/shop`, { waitUntil: 'networkidle', timeout: 20_000 })
      const productLink = page.locator('a[href^="/products/"]').first()
      await productLink.waitFor({ state: 'visible', timeout: 10_000 })
      const href = await productLink.getAttribute('href')
      if (!href?.startsWith('/products/')) throw new Error('No product href found on Shop.')
      if (pageErrors.length) throw new Error(`Uncaught page error: ${pageErrors[0]}`)
      return { productHref: href }
    } finally { await context.close() }
  })

  let productHref = null
  await runCheck('browser_product_detail', 'product detail selection journey', async () => {
    const { context, page, pageErrors } = await newPage({ width: 1440, height: 1000 })
    try {
      await page.goto(`${base}/shop`, { waitUntil: 'networkidle', timeout: 20_000 })
      const productLink = page.locator('a[href^="/products/"]').first()
      await productLink.waitFor({ state: 'visible', timeout: 10_000 })
      productHref = await productLink.getAttribute('href')
      if (!productHref) throw new Error('No product available from Shop.')
      await page.goto(new URL(productHref, base).toString(), { waitUntil: 'networkidle', timeout: 20_000 })
      await page.getByRole('link', { name: /size guide/i }).first().waitFor({ state: 'visible', timeout: 10_000 })
      const cta = page.getByRole('button', { name: /add to bag|select a size|sold out/i }).first()
      await cta.waitFor({ state: 'visible', timeout: 10_000 })
      if (pageErrors.length) throw new Error(`Uncaught page error: ${pageErrors[0]}`)
      return { productHref, cta: (await cta.innerText()).trim() }
    } finally { await context.close() }
  })

  await runCheck('browser_cart', 'product to cart journey', async () => {
    if (!productHref) throw new Error('Product detail prerequisite failed.')
    const { context, page, pageErrors } = await newPage({ width: 1440, height: 1000 })
    try {
      await page.goto(new URL(productHref, base).toString(), { waitUntil: 'networkidle', timeout: 20_000 })
      const sizeButtons = page.locator('button:not([disabled])').filter({ hasText: /^(XS|S|M|L|XL|XXL|XXXL)$/ })
      const count = await sizeButtons.count()
      if (count === 0) {
        const soldOut = await page.getByRole('button', { name: /sold out/i }).count()
        if (soldOut > 0) return { inventoryState: 'sold_out', cartMutation: 'not_applicable' }
        throw new Error('No selectable size and no sold-out state found.')
      }
      await sizeButtons.first().click()
      const cta = page.getByRole('button', { name: /add to bag/i }).first()
      await cta.waitFor({ state: 'visible', timeout: 10_000 })
      await cta.click()
      const bag = page.getByRole('dialog', { name: /bag/i })
      await bag.waitFor({ state: 'visible', timeout: 10_000 })
      await bag.getByRole('link', { name: /checkout/i }).waitFor({ state: 'visible', timeout: 10_000 })
      if (pageErrors.length) throw new Error(`Uncaught page error: ${pageErrors[0]}`)
      return { cartOpened: true }
    } finally { await context.close() }
  })

  await runCheck('browser_checkout_entry', 'safe checkout entry journey', async () => {
    if (!productHref) throw new Error('Product detail prerequisite failed.')
    const { context, page, pageErrors } = await newPage({ width: 1440, height: 1000 })
    try {
      await page.goto(new URL(productHref, base).toString(), { waitUntil: 'networkidle', timeout: 20_000 })
      const sizeButtons = page.locator('button:not([disabled])').filter({ hasText: /^(XS|S|M|L|XL|XXL|XXXL)$/ })
      if (await sizeButtons.count() === 0) return { inventoryState: 'sold_out', checkoutEntry: 'not_applicable' }
      await sizeButtons.first().click()
      await page.getByRole('button', { name: /add to bag/i }).first().click()
      const bag = page.getByRole('dialog', { name: /bag/i })
      await bag.waitFor({ state: 'visible', timeout: 10_000 })
      await bag.getByRole('link', { name: /checkout/i }).click()
      await page.waitForURL(/\/checkout(?:\?|$)/, { timeout: 10_000 })
      await page.getByText('Checkout', { exact: true }).first().waitFor({ state: 'visible', timeout: 10_000 })
      if (pageErrors.length) throw new Error(`Uncaught page error: ${pageErrors[0]}`)
      return { checkoutLoaded: true, paymentSubmitted: false }
    } finally { await context.close() }
  })

  await runCheck('browser_mobile', 'mobile storefront/PDP rendering', async () => {
    const { context, page, pageErrors } = await newPage({ width: 390, height: 844 })
    try {
      await page.goto(`${base}/shop`, { waitUntil: 'networkidle', timeout: 20_000 })
      const productLink = page.locator('a[href^="/products/"]').first()
      await productLink.waitFor({ state: 'visible', timeout: 10_000 })
      const href = await productLink.getAttribute('href')
      await page.goto(new URL(href, base).toString(), { waitUntil: 'networkidle', timeout: 20_000 })
      const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }))
      if (dimensions.scrollWidth > dimensions.clientWidth + 3) throw new Error(`Horizontal overflow ${dimensions.scrollWidth}px > ${dimensions.clientWidth}px`)
      await page.getByRole('link', { name: /size guide/i }).first().waitFor({ state: 'visible', timeout: 10_000 })
      if (pageErrors.length) throw new Error(`Uncaught page error: ${pageErrors[0]}`)
      return dimensions
    } finally { await context.close() }
  })
} catch (err) {
  hardFailures++
  checks.push({ testCaseId:'browser_runner_guard', name:'browser runner', status:'failed', durationMs:0, failureCode:'BROWSER_RUNNER_FAILED', evidence:{ message:String(err?.message || err).slice(0,500) } })
  console.error('Browser QA runner failed:', err)
} finally {
  if (browser) await browser.close().catch(() => {})
  fs.writeFileSync(output, JSON.stringify({ skipped:false, checks }, null, 2))
}

for (const c of checks) console.log(`${c.status === 'passed' ? 'PASS' : c.status === 'skipped' ? 'SKIP' : 'FAIL'} ${c.name}`)
if (hardFailures) process.exit(1)
