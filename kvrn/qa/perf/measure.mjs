#!/usr/bin/env node
/**
 * Reproducible LAB performance snapshot for public pages (workstream E). Chromium via Playwright, mobile emulation,
 * CPU 4x slowdown, throttled network. LAB data only: it is a relative baseline for before/after comparison, not field
 * Core Web Vitals and not a Lighthouse score. Run against a PRODUCTION build (`next start`), never `next dev`.
 *
 *   KVRN_PERF_BASE=http://localhost:3112 node qa/perf/measure.mjs [--runs 3] [--json out.json] [--paths /,/shop,...]
 * Refuses non-localhost unless KVRN_PERF_ALLOW_REMOTE=1 (read-only GETs only; no cookies, no forms).
 */
import { chromium } from 'playwright-core'
import fs from 'node:fs'

const base = new URL(process.env.KVRN_PERF_BASE || 'http://localhost:3112')
if (!['localhost', '127.0.0.1'].includes(base.hostname) && process.env.KVRN_PERF_ALLOW_REMOTE !== '1') { console.error('Refusing non-local host.'); process.exit(2) }
const args = process.argv.slice(2)
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const RUNS = Number(arg('--runs', 3))
const PATHS = (arg('--paths', '/,/shop,/products/kvrn-phantom-hoodie,/support/faq,/privacy')).split(',')
const OUT = arg('--json', '')
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null }
const round = (n, d = 0) => n == null ? null : Math.round(n * 10 ** d) / 10 ** d

const INIT = () => {
  window.__m = { lcp: 0, lcpEl: null, cls: 0, longTasks: [], shifts: [] }
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) { window.__m.lcp = e.startTime; window.__m.lcpEl = e.element ? (e.element.tagName + (e.url ? ' ' + e.url.slice(-60) : '')) : null } }).observe({ type: 'largest-contentful-paint', buffered: true }) } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) if (!e.hadRecentInput) { window.__m.cls += e.value; window.__m.shifts.push({ v: +e.value.toFixed(4), t: Math.round(e.startTime), src: (e.sources || []).slice(0, 2).map(s => s.node && (s.node.tagName + (s.node.id ? '#' + s.node.id : ''))) }) } }).observe({ type: 'layout-shift', buffered: true }) } catch {}
  try { new PerformanceObserver(l => { for (const e of l.getEntries()) window.__m.longTasks.push(e.duration) }).observe({ type: 'longtask', buffered: true }) } catch {}
}

async function once(browser, path) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1' })
  const page = await ctx.newPage()
  const cdp = await ctx.newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await cdp.send('Network.enable')
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 })
  await page.addInitScript(INIT)
  const t0 = Date.now()
  await page.goto(new URL(path, base).href, { waitUntil: 'load', timeout: 90000 })
  await page.waitForTimeout(3000)
  const r = await page.evaluate(() => {
    const m = window.__m, nav = performance.getEntriesByType('navigation')[0]
    const res = performance.getEntriesByType('resource')
    const by = { js: 0, css: 0, img: 0, font: 0, other: 0 }, n = { js: 0, css: 0, img: 0, font: 0, other: 0 }
    for (const e of res) {
      const sz = e.transferSize || e.encodedBodySize || 0
      const k = e.initiatorType === 'img' || /\.(webp|png|jpe?g|avif|gif|svg)(\?|$)|\/_next\/image|\/media\//.test(e.name) ? 'img'
        : /\.js(\?|$)/.test(e.name) ? 'js' : /\.css(\?|$)/.test(e.name) ? 'css' : /\.(woff2?|ttf|otf)(\?|$)/.test(e.name) ? 'font' : 'other'
      by[k] += sz; n[k]++
    }
    return {
      lcp: m.lcp, lcpEl: m.lcpEl, cls: m.cls, shifts: m.shifts.slice(0, 5),
      tbt: m.longTasks.reduce((a, d) => a + Math.max(0, d - 50), 0), longTasks: m.longTasks.length,
      dcl: nav ? nav.domContentLoadedEventEnd : null, load: nav ? nav.loadEventEnd : null, ttfb: nav ? nav.responseStart : null,
      bytes: by, counts: n, requests: res.length, domNodes: document.getElementsByTagName('*').length,
      imgsNoDims: [...document.images].filter(i => !(i.getAttribute('width') && i.getAttribute('height')) && !i.closest('[style*="aspect"],[class*="aspect"]')).length,
      imgsLazyAboveFold: [...document.images].filter(i => i.loading === 'lazy' && i.getBoundingClientRect().top < innerHeight).length,
      fontsLoaded: [...document.fonts].filter(f => f.status === 'loaded').length,
    }
  })
  await ctx.close()
  return { ...r, wall: Date.now() - t0 }
}

const browser = await chromium.launch({ args: ['--no-sandbox'] })
const report = { base: base.origin, at: new Date().toISOString(), env: 'mobile 390x844 DPR2, CPU 4x, 1.6Mbps/150ms RTT (LAB)', runs: RUNS, pages: {} }
for (const path of PATHS) {
  const runs = []
  for (let i = 0; i < RUNS; i++) { try { runs.push(await once(browser, path)) } catch (e) { runs.push({ error: String(e.message).slice(0, 120) }) } }
  const good = runs.filter(r => !r.error)
  const med = k => round(median(good.map(r => r[k])), k === 'cls' ? 3 : 0)
  report.pages[path] = {
    ok: good.length, lcpMs: med('lcp'), lcpElement: good[0]?.lcpEl, cls: med('cls'), tbtMs: med('tbt'), longTasks: med('longTasks'), ttfbMs: med('ttfb'), loadMs: med('load'),
    jsKB: round(median(good.map(r => r.bytes.js)) / 1024, 0), cssKB: round(median(good.map(r => r.bytes.css)) / 1024, 0), imgKB: round(median(good.map(r => r.bytes.img)) / 1024, 0), fontKB: round(median(good.map(r => r.bytes.font)) / 1024, 0),
    requests: med('requests'), domNodes: med('domNodes'), imgsWithoutDimensions: med('imgsNoDims'), lazyImagesAboveFold: med('imgsLazyAboveFold'),
    worstShifts: good.flatMap(r => r.shifts).sort((a, b) => b.v - a.v).slice(0, 3), errors: runs.filter(r => r.error).map(r => r.error),
  }
}
await browser.close()
if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 1))
