import assert from 'node:assert/strict'
import {auditRenderedPage,auditRobotsTxt,auditSitemap} from './staging-seo-rules.mjs'
const goodPage=(path)=>`<html><head><title>KVRN Policy</title><link rel="canonical" href="https://kvrn.shop${path}"></head><body>Safe</body></html>`
const get=(path,html)=>auditRenderedPage(path,html).issues
const cases=[
 ['good policy canonical',()=>assert.deepEqual(get('/privacy',goodPage('/privacy')),[])],
 ['duplicate canonical',()=>assert.ok(get('/privacy',goodPage('/privacy').replace('</head>','<link rel="canonical" href="https://kvrn.shop/privacy"></head>')).includes('duplicate_canonical'))],
 ['mismatched canonical',()=>assert.ok(get('/privacy',goodPage('/terms')).includes('canonical_mismatch_or_nonproduction_origin'))],
 ['old contact',()=>assert.ok(get('/privacy',goodPage('/privacy').replace('Safe','returns@kvrn.shop')).includes('stale_policy_reference'))],
 ['old UK policy reference',()=>assert.ok(get('/terms',goodPage('/terms').replace('Safe','HMRC')).includes('stale_policy_reference'))],
 ['track form private',()=>assert.ok(get('/support/track',goodPage('/support/track')).includes('private_tracking_must_noindex'))],
 ['track noindex',()=>assert.deepEqual(get('/support/track',goodPage('/support/track').replace('</head>','<meta name="robots" content="noindex,nofollow"></head>')),[])],
 ['missing product structured data',()=>assert.ok(get('/products/test',goodPage('/products/test')).includes('product_jsonld_missing'))],
 ['correct product JSONLD',()=>assert.deepEqual(get('/products/test',goodPage('/products/test').replace('</head>',`<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Test"}</script></head>`)),[])],
 ['reject malformed JSONLD',()=>assert.ok(get('/products/test',goodPage('/products/test').replace('</head>','<script type="application/ld+json">{oops</script></head>')).includes('invalid_jsonld'))],
 ['sitemap duplicates',()=>assert.ok(auditSitemap(`<urlset><url><loc>https://kvrn.shop/shop</loc></url><url><loc>https://kvrn.shop/shop</loc></url></urlset>`).issues.includes('duplicate_sitemap_loc'))],
 ['no leakage of tracking URLs',()=>assert.ok(auditSitemap('<urlset><url><loc>https://kvrn.shop/support/track</loc></url></urlset>').issues.includes('private_or_utility_url_in_sitemap'))],
 ['bad sitemap domain',()=>assert.ok(auditSitemap('<urlset><url><loc>https://other.test/shop</loc></url></urlset>').issues.includes('invalid_sitemap_origin_or_parameters'))],
 ['valid product page extraction',()=>assert.deepEqual(auditSitemap('<urlset><url><loc>https://kvrn.shop/products/hoodie</loc></url></urlset>').productPaths,['/products/hoodie'])],
 ['invalid xml',()=>assert.ok(auditSitemap('bad').issues.includes('urlset_missing'))],
 ['robots review',()=>assert.ok(auditRobotsTxt('User-agent: *\nDisallow: /').issues.includes('admin_disallow_missing_review'))],
 ['robots valid',()=>assert.deepEqual(auditRobotsTxt('User-agent: *\nDisallow: /admin\n').issues,[])],
]
for(const [name,fn] of cases){fn();console.log('PASS',name)}
console.log(`${cases.length}/${cases.length} staging SEO rules tests passed`)
