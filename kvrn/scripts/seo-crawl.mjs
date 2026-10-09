#!/usr/bin/env node
/**
 * KVRN read-only SEO crawler (workstream D). Fetches ONLY same-origin GET pages; never follows redirects blindly,
 * never calls Google/Bing/Merchant APIs, never writes anything. It measures what is CRAWLABLE and well-formed.
 * It does NOT and cannot say a page is indexed or ranks - that needs Search Console evidence.
 *
 *   KVRN_SEO_BASE=http://localhost:3111 node scripts/seo-crawl.mjs [--json out.json] [--max 60]
 *
 * Production hosts are refused (use the owner's staging URL or localhost).
 */
import fs from 'node:fs'

const rawBase = process.env.KVRN_SEO_BASE || process.env.KVRN_QA_STAGING_URL || ''
if (!rawBase) { console.error('Set KVRN_SEO_BASE (localhost or private staging). Nothing requested.'); process.exit(2) }
const base = new URL(rawBase)
const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)
if (base.hostname === 'kvrn.shop' || base.hostname.endsWith('.kvrn.shop') || (!local && base.protocol !== 'https:')) {
  console.error('Refusing production or non-https remote host.'); process.exit(2)
}
const args = process.argv.slice(2)
const argv = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d }
const MAX = Number(argv('--max', 60))
const outFile = argv('--json', '')

const get = async (path) => {
  const url = new URL(path, base)
  if (url.origin !== base.origin) throw new Error('cross-origin refused')
  const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { Accept: 'text/html,application/xml,text/plain' } })
  const body = res.status >= 300 && res.status < 400 ? '' : (await res.text()).slice(0, 3_000_000)
  return { status: res.status, location: res.headers.get('location'), xrobots: res.headers.get('x-robots-tag') || '', ctype: res.headers.get('content-type') || '', body }
}
const attr = (tag, name) => { const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')); return m ? (m[2] ?? m[3]) : null }
const tags = (html, name) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) || []
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')

export function analyse(html) {
  const head = (html.match(/<head[\s\S]*?<\/head>/i) || [''])[0]
  const metas = tags(head, 'meta')
  const meta = (k) => { for (const t of metas) { if ((attr(t, 'name') || attr(t, 'property'))?.toLowerCase() === k) return decode(attr(t, 'content') ?? '') } return null }
  const links = tags(head, 'link')
  const rel = (r) => links.filter(t => (attr(t, 'rel') || '').toLowerCase().split(/\s+/).includes(r)).map(t => ({ href: attr(t, 'href'), hreflang: attr(t, 'hreflang') }))
  const title = decode(((head.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim())
  const jsonld = []
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try { const j = JSON.parse(decode(m[1])); for (const n of (Array.isArray(j) ? j : j['@graph'] ? j['@graph'] : [j])) jsonld.push(n) } catch { jsonld.push({ '@type': '__INVALID_JSON__' }) }
  }
  const imgs = tags(html, 'img')
  const h1 = (html.match(/<h1\b/gi) || []).length
  return {
    title, description: meta('description'), robots: meta('robots'), canonical: rel('canonical')[0]?.href ?? null,
    hreflang: rel('alternate').filter(x => x.hreflang), ogTitle: meta('og:title'), ogImage: meta('og:image'), ogUrl: meta('og:url'),
    twitterCard: meta('twitter:card'), lang: (html.match(/<html[^>]*\blang="([^"]*)"/i) || [])[1] || null, h1,
    jsonldTypes: jsonld.map(n => [].concat(n['@type'] ?? '?').join('+')), jsonld,
    images: imgs.length, imagesNoAlt: imgs.filter(t => attr(t, 'alt') === null).length, imagesEmptyAlt: imgs.filter(t => attr(t, 'alt') === '').length,
  }
}

function lint(path, r, res) {
  const out = []
  const noindex = /noindex/i.test(r.robots || '') || /noindex/i.test(res.xrobots)
  if (!r.title) out.push('missing <title>')
  else if (r.title.length > 70) out.push(`title long (${r.title.length})`)
  if (!noindex) {
    if (!r.description) out.push('missing meta description')
    else if (r.description.length > 170) out.push(`description long (${r.description.length})`)
    if (!r.canonical) out.push('missing canonical')
    if (!r.ogTitle) out.push('missing og:title')
    if (!r.ogImage) out.push('missing og:image')
  }
  if (r.canonical) { try { const c = new URL(r.canonical, base); if (!noindex && c.pathname.replace(/\/$/, '') !== path.replace(/\/$/, '') && !path.startsWith('/products/')) out.push(`canonical points elsewhere (${c.pathname})`) } catch { out.push('canonical unparsable') } }
  if (r.h1 !== 1) out.push(`h1 count ${r.h1}`)
  if (r.imagesNoAlt) out.push(`${r.imagesNoAlt} <img> without alt attribute`)
  if (r.jsonldTypes.includes('__INVALID_JSON__')) out.push('invalid JSON-LD')
  if (!r.lang) out.push('missing html lang')
  return out
}

function lintProductJsonLd(r) {
  const out = []
  for (const n of r.jsonld) {
    const t = [].concat(n['@type'] ?? [])
    if (t.includes('Product') || t.includes('ProductGroup')) {
      const offers = [].concat(n.offers ?? []).concat((n.hasVariant ?? []).flatMap(v => v.offers ?? []))
      for (const o of offers) {
        if (o.price !== undefined && !(Number(o.price) > 0)) out.push('offer price not > 0')
        if (!o.priceCurrency) out.push('offer without priceCurrency')
        if (!o.availability) out.push('offer without availability')
      }
      if (!n.name) out.push('product without name')
      if (!n.image) out.push('product without image')
    }
  }
  return out
}

const report = { base: base.origin, at: new Date().toISOString(), note: 'Crawlable/well-formed only. Not evidence of indexing or ranking.', robots: null, sitemap: null, pages: [], summary: {} }

// robots.txt
const rb = await get('/robots.txt')
const disallow = [...rb.body.matchAll(/^\s*Disallow:\s*(\S*)/gim)].map(m => m[1]).filter(Boolean)
report.robots = { status: rb.status, disallow, sitemaps: [...rb.body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)].map(m => m[1]), blocksEverything: /^\s*Disallow:\s*\/\s*$/im.test(rb.body) }

// sitemap
const sm = await get('/sitemap.xml')
const locs = [...sm.body.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => decode(m[1]).trim())
const smPaths = [...new Set(locs.map(u => { try { const x = new URL(u); return { origin: x.origin, path: x.pathname || '/' } } catch { return { origin: '?', path: u } } }))]
report.sitemap = { status: sm.status, count: locs.length, duplicates: locs.length - new Set(locs).size, foreignOrigin: smPaths.filter(p => p.origin !== base.origin).length, disallowedInRobots: smPaths.filter(p => disallow.some(d => p.path.startsWith(d))).map(p => p.path) }

const todo = [...new Set(['/', '/shop', '/about', '/contact', '/privacy', '/terms', '/cookies', '/privacy-choices', '/messaging-terms', '/messaging-privacy', '/support/faq', '/support/shipping-returns', '/support/size-guide', ...smPaths.map(p => p.path)])].slice(0, MAX)
for (const path of todo) {
  let res
  try { res = await get(path) } catch (e) { report.pages.push({ path, error: String(e.message || e), issues: ['request failed'] }); continue }
  const entry = { path, status: res.status, inSitemap: smPaths.some(p => p.path === path), issues: [] }
  if (res.status >= 300 && res.status < 400) { entry.redirectTo = res.location; if (entry.inSitemap) entry.issues.push('sitemap URL redirects') }
  else if (res.status !== 200) entry.issues.push(`HTTP ${res.status}`)
  else if (/html/.test(res.ctype)) {
    const r = analyse(res.body)
    Object.assign(entry, { title: r.title, description: r.description, canonical: r.canonical, robots: r.robots || res.xrobots || null, h1: r.h1, jsonldTypes: r.jsonldTypes, images: r.images, imagesNoAlt: r.imagesNoAlt, imagesEmptyAlt: r.imagesEmptyAlt, hreflang: r.hreflang.length, lang: r.lang })
    entry.issues.push(...lint(path, r, res), ...(path.startsWith('/products/') ? lintProductJsonLd(r) : []))
    if (/noindex/i.test(entry.robots || '') && entry.inSitemap) entry.issues.push('noindex page listed in sitemap')
  }
  report.pages.push(entry)
}
// duplicate titles / descriptions
const dup = (k) => { const m = new Map(); for (const p of report.pages) if (p[k] && !/noindex/i.test(p.robots || '')) m.set(p[k], [...(m.get(p[k]) || []), p.path]); return [...m].filter(([, v]) => v.length > 1).map(([value, paths]) => ({ value, paths })) }
report.duplicates = { title: dup('title'), description: dup('description') }
report.summary = { pages: report.pages.length, withIssues: report.pages.filter(p => p.issues.length).length, issueCount: report.pages.reduce((a, p) => a + p.issues.length, 0), duplicateTitles: report.duplicates.title.length, duplicateDescriptions: report.duplicates.description.length }

if (outFile) fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
console.log(JSON.stringify({ robots: report.robots, sitemap: report.sitemap, summary: report.summary, duplicates: report.duplicates, pages: report.pages.map(p => ({ path: p.path, status: p.status, issues: p.issues, jsonld: p.jsonldTypes, robots: p.robots || undefined, redirectTo: p.redirectTo })) }, null, 1))
process.exitCode = report.summary.issueCount ? 1 : 0
