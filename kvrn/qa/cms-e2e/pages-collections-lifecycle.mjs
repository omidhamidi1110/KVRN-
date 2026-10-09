#!/usr/bin/env node
// LOCAL-ONLY: generic CMS page + collection lifecycle against the scratch DB (dev server with KVRN_FLAG_CMS_PUBLIC_CONTENT=on).
//   page:       create (draft) -> 404 publicly -> publish -> 200 -> unpublish -> 404
//   collection: create -> public -> rename slug (old URL redirects) -> archive (404) -> restore (hidden) -> re-activate
// Refuses anything that is not localhost. Writes to the scratch database only.
const base = new URL(process.env.KVRN_E2E_BASE || 'http://localhost:3111')
if (!['localhost', '127.0.0.1'].includes(base.hostname)) { console.error('local only'); process.exit(2) }
const h = { 'x-dev-admin-email': process.env.KVRN_E2E_ADMIN || 'dev@kvrn.test', 'content-type': 'application/json' }
let fails = 0
const ok = (c, m, x = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${!c && x ? '  ' + x : ''}`); if (!c) fails++ }
const api = async (method, p, body) => { const r = await fetch(new URL(p, base), { method, headers: h, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json() } catch {} ; return { status: r.status, j } }
const pub = async (p) => { const r = await fetch(new URL(p, base), { redirect: 'manual' }); return { status: r.status, loc: r.headers.get('location'), text: r.status < 300 ? await r.text() : '' } }
const RUN = Date.now().toString(36)

console.log('== generic page ==')
const slug = `e2e-page-${RUN}`, MARK = `PAGEBODY${RUN}`
const para = t => ({ t: 'p', c: [{ t: 'text', text: t }] })
const snap = { slug, title: `E2E Page ${RUN}`, body: { v: 1, blocks: [{ t: 'h2', c: [{ t: 'text', text: 'Heading' }] }, para(MARK)] }, navEligible: false, seo: {} }
const cr = await api('POST', '/api/admin/content/pages', { snapshot: snap })
ok(cr.status === 201, 'create page', JSON.stringify(cr.j).slice(0, 300))
const id = cr.j?.data?.id ?? cr.j?.id
ok(!!id, 'got id', JSON.stringify(cr.j).slice(0, 200))
if (id) {
  const U = `/api/admin/content/pages/${id}`
  ok((await pub(`/pages/${slug}`)).status === 404, 'draft page is 404 publicly')
  let cur = (await api('GET', U)).j.data
  const p = await api('POST', U, { action: 'publish', revision: cur.revision }); ok(p.status === 200, 'publish page', JSON.stringify(p.j).slice(0, 300))
  const r = await pub(`/pages/${slug}`); ok(r.status === 200 && r.text.includes(MARK), 'published page renders its body', `status ${r.status}`)
  ok(/<title>[^<]*E2E Page/.test(r.text), 'page <title> from CMS')
  ok(/rel="canonical"/.test(r.text), 'page has a canonical link')
  ok((await pub('/sitemap.xml')).text.includes(`/pages/${slug}`), 'published page IS in the sitemap')
  cur = (await api('GET', U)).j.data
  const u = await api('POST', U, { action: 'unpublish', revision: cur.revision }); ok(u.status === 200, 'unpublish page', JSON.stringify(u.j).slice(0, 200))
  ok((await pub(`/pages/${slug}`)).status === 404, 'unpublished page is 404 again')
  const sm = await pub('/sitemap.xml'); ok(!sm.text.includes(slug), 'unpublished page is not in the sitemap')
}

console.log('== collection ==')
const cslug = `e2e-coll-${RUN}`
const cc = await api('POST', '/api/admin/content/collections', { slug: cslug, name: `E2E Collection ${RUN}`, description: 'Test collection', isActive: true, sortOrder: 50, seo: {} })
ok(cc.status === 201, 'create collection', JSON.stringify(cc.j).slice(0, 300))
const cid = cc.j?.data?.id ?? cc.j?.id
if (cid) {
  let g = (await api('GET', `/api/admin/content/collections/${cid}`)).j; let col = g.data ?? g
  const r1 = await pub(`/collections/${cslug}`); ok(r1.status === 200 && r1.text.includes(`E2E Collection ${RUN}`), 'collection page renders', `status ${r1.status}`)
  ok(/rel="canonical"/.test(r1.text), 'collection has canonical')
  ok((await pub('/sitemap.xml')).text.includes(`/collections/${cslug}`), 'active collection IS in the sitemap')
  const ns = `${cslug}-renamed`
  const up = await api('PUT', `/api/admin/content/collections/${cid}`, { collection: { slug: ns, name: `E2E Collection ${RUN}`, description: 'Test collection', isActive: true, sortOrder: 50, seo: {} }, version: col.version })
  ok(up.status === 200, 'rename slug', JSON.stringify(up.j).slice(0, 300))
  const old = await pub(`/collections/${cslug}`); ok([301, 308].includes(old.status) && (old.loc || '').endsWith(`/collections/${ns}`), `old slug redirects to the new one (${old.status} ${old.loc})`)
  ok((await pub(`/collections/${ns}`)).status === 200, 'new slug serves')
  g = (await api('GET', `/api/admin/content/collections/${cid}`)).j; col = g.data ?? g
  const ar = await api('POST', `/api/admin/content/collections/${cid}`, { action: 'archive', version: col.version }); ok(ar.status === 200, 'archive', JSON.stringify(ar.j).slice(0, 200))
  ok((await pub(`/collections/${ns}`)).status === 404, 'archived collection is 404')
  g = (await api('GET', `/api/admin/content/collections/${cid}`)).j; col = g.data ?? g
  const rs = await api('POST', `/api/admin/content/collections/${cid}`, { action: 'restore', version: col.version }); ok(rs.status === 200, 'restore')
  // By design a restored collection stays hidden until "Show on the site" is switched back on (UI says so).
  ok((await pub(`/collections/${ns}`)).status === 404, 'restored collection stays hidden until re-activated')
  g = (await api('GET', `/api/admin/content/collections/${cid}`)).j; col = g.data ?? g
  const re = await api('PUT', `/api/admin/content/collections/${cid}`, { collection: { slug: ns, name: `E2E Collection ${RUN}`, description: 'Test collection', isActive: true, sortOrder: 50, seo: {} }, version: col.version })
  ok(re.status === 200, 're-activate', JSON.stringify(re.j).slice(0, 200))
  ok((await pub(`/collections/${ns}`)).status === 200, 'collection serves again once re-activated')
}
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0)
