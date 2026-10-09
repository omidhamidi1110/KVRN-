/**
 * Offline-testable, read-only SEO audit rules. Input is rendered HTML/XML only.
 * This module does not fetch URLs and does not depend on provider credentials.
 * A staging crawler may use its findings, but must never navigate to a URL
 * from XML or HTML without independently validating the staging origin.
 */
const blockedPath = /^\/(?:admin|api|support\/track|privacy-choices|email-preferences|checkout|cart)(?:\/|$)/i
const obsoletePolicy = /\b(?:HMRC|UK GDPR|Information Commissioner(?:’|')?s Office|UK Information Commissioner|returns@kvrn\.shop)\b/i
const clean = s => String(s ?? '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&apos;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>')
const tags = (html, tag) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'ig'))].map(m => m[0])
function attribute(tag, key) {
  const found = tag.match(new RegExp(`(?:^|\\s)${key}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i'))
  return found ? clean(found[1] ?? found[2]) : null
}
function canonicalTags(html) { return tags(html,'link').filter(t => /\bcanonical\b/i.test(attribute(t,'rel') ?? '')) }
function robotsNoindex(html) { return tags(html,'meta').some(t => attribute(t,'name')?.toLowerCase() === 'robots' && /\bnoindex\b/i.test(attribute(t,'content') ?? '')) }
function result(issues, info={}) { return { issues, ...info } }

export function auditRenderedPage(path, html, headers={}) {
  const issues=[]
  const title=html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? ''
  if (!title) issues.push('missing_title')
  if (title.length > 80) issues.push('title_too_long_review')
  const canonicals=canonicalTags(html)
  if(canonicals.length > 1) issues.push('duplicate_canonical')
  const canonical=canonicals.length === 1 ? attribute(canonicals[0],'href') : null
  const noindex=robotsNoindex(html)||/\bnoindex\b/i.test(headers.xRobotsTag??'')
  if(path === '/support/track') {
    if(!noindex) issues.push('private_tracking_must_noindex')
  } else if (!canonical && !noindex) issues.push('missing_canonical_or_noindex')
  if (canonical) {
    try {
      const url = new URL(canonical, 'https://kvrn.shop')
      if (url.origin !== 'https://kvrn.shop' || url.pathname !== path || url.search || url.hash) {
        issues.push('canonical_mismatch_or_nonproduction_origin')
      }
    } catch { issues.push('invalid_canonical') }
  }
  if (['/privacy','/terms','/support/shipping-returns','/cookies'].includes(path) && obsoletePolicy.test(html)) issues.push('stale_policy_reference')
  if (/^\/products\/[a-z0-9-]+$/.test(path) && !noindex) {
    const rawLd = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/ig)]
    const parse = rawLd.flatMap(m => {
      try {
        const obj=JSON.parse(m[1]);return Array.isArray(obj)?obj:[obj]
      } catch { issues.push('invalid_jsonld');return [] }
    })
    function containsProduct(node, depth=0) {
      if (!node || typeof node !== 'object' || depth > 8) return false
      if (Array.isArray(node)) return node.some(n=>containsProduct(n,depth+1))
      if (node['@type'] === 'Product' || (Array.isArray(node['@type']) && node['@type'].includes('Product'))) return true
      return Object.values(node).some(value=>typeof value==='object' && containsProduct(value,depth+1))
    }
    if (!parse.some(node=>containsProduct(node))) issues.push('product_jsonld_missing')
  }
  return result(issues,{title:title.slice(0,120),canonical,noindex})
}

export function auditSitemap(xml) {
  const issues=[]
  if (!/<urlset\b/i.test(xml)) return result(['urlset_missing'],{productPaths:[],count:0})
  const entries=[...xml.matchAll(/<loc\s*>([\s\S]*?)<\/loc\s*>/gi)].map(m=>clean(m[1].trim()))
  if (!entries.length) issues.push('empty_sitemap')
  if (entries.length>50000) issues.push('sitemap_too_large')
  const seen=new Set(),productPaths=[]
  for(const entry of entries) {
    let u
    try {u=new URL(entry)} catch {issues.push('invalid_sitemap_url');continue}
    if(u.origin!=='https://kvrn.shop'||u.search||u.hash||u.username||u.password)issues.push('invalid_sitemap_origin_or_parameters')
    if(seen.has(entry))issues.push('duplicate_sitemap_loc')
    seen.add(entry)
    if(blockedPath.test(u.pathname))issues.push('private_or_utility_url_in_sitemap')
    if(/^\/products\/[a-z0-9-]+$/.test(u.pathname))productPaths.push(u.pathname)
  }
  return result([...new Set(issues)],{count:entries.length,productPaths:[...new Set(productPaths)]})
}

export function auditRobotsTxt(body) {
  const issues=[]
  if (!/^\s*User-agent\s*:/im.test(body))issues.push('missing_user_agent')
  // A crawl-block does not protect customer data, but accidental Admin crawling
  // should still be discouraged in addition to authorization and noindex.
  if (!/^\s*Disallow\s*:\s*\/admin(?:\/|\s|$)/im.test(body)) issues.push('admin_disallow_missing_review')
  return result(issues)
}
