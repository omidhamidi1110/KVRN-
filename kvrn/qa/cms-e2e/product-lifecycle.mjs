#!/usr/bin/env node
// LOCAL-ONLY product CMS lifecycle against a scratch database: draft -> preview-data -> publish -> public PDP -> rollback.
// Changes ONLY the SEO title/description text (never price, stock, variants). Refuses non-localhost.
//   KVRN_E2E_BASE=http://localhost:3111 node qa/cms-e2e/product-lifecycle.mjs [slug]
const base = new URL(process.env.KVRN_E2E_BASE || 'http://localhost:3111')
if (!['localhost', '127.0.0.1'].includes(base.hostname)) { console.error('local only'); process.exit(2) }
const admin = process.env.KVRN_E2E_ADMIN || 'dev@kvrn.test'
const SLUG = process.argv[2] || 'kvrn-phantom-hoodie'
const MARK = `E2E-TITLE-${Date.now()}`
let fails = 0
const ok = (c, m, extra = '') => { console.log(`${c ? 'PASS' : 'FAIL'}  ${m}${!c && extra ? '  ' + extra : ''}`); if (!c) fails++ }
const api = async (method, p, body) => {
  const r = await fetch(new URL(p, base), { method, headers: { 'x-dev-admin-email': admin, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let j = null; try { j = await r.json() } catch {}
  return { status: r.status, j }
}
const title = async () => { const h = await (await fetch(new URL(`/products/${SLUG}`, base))).text(); return (h.match(/<title>([^<]*)<\/title>/) || [])[1] ?? null }
const list = (await api('GET', '/api/admin/products')).j.items
const prod = list.find(p => p.slug === SLUG)
ok(!!prod, `product ${SLUG} exists`)
const U = `/api/admin/products/${prod.id}`
const state = async () => (await api('GET', U)).j.data
let st = await state()
const original = (st.published ?? st.snapshot).seo.title
const t0 = await title(); ok(t0 && t0.includes(original.split('|')[0].trim()), `public title initially ${JSON.stringify(t0)}`)

const snap = JSON.parse(JSON.stringify(st.snapshot)); snap.seo.title = MARK
// Publishing is (correctly) blocked until real parcel data exists. In the SCRATCH database only, fill placeholder parcel data so the
// lifecycle can be exercised; production values must come from the owner (never invent them there).
const ship = snap.commerce?.shipping
if (ship && Object.values(ship).some(v => v == null)) { snap.commerce.shipping = { weightLb: 1.8, lengthIn: 12, widthIn: 10, heightIn: 3 }; console.log('      (scratch DB: filled placeholder parcel data)') }
const sv = await api('PUT', U, { snapshot: snap, revision: st.revision }); ok(sv.status === 200, 'save draft', JSON.stringify(sv.j).slice(0, 200))
ok((await title()) === t0, 'draft is NOT public'); st = await state()
ok(st.hasDraft, 'editor reports a draft')
const stale = await api('PUT', U, { snapshot: snap, revision: 0 }); ok(stale.status === 409, `stale revision rejected (${stale.status})`)
const pv = await api('GET', `${U}/preview-data`); ok(pv.status === 200, `preview-data (${pv.status})`)
const val = await api('POST', U + '/action', { action: 'validate' }); ok(val.status === 200, 'validate runs')
console.log('      blockers:', (st.blockers || []).map(b => b.code).join(',') || 'none')

const pub = await api('POST', U + '/action', { action: 'publish', revision: st.revision })
ok(pub.status === 200, `publish (${pub.status})`, JSON.stringify(pub.j).slice(0, 300))
if (pub.status === 200) {
  ok((await title() ?? '').includes(MARK), 'published title is public')
  st = await state()
  const rb = await api('POST', U + '/action', { action: 'rollback', versionNo: st.publishedVersionNo - 1 || 1, revision: st.revision })
  ok(rb.status === 200, 'rollback to previous version', JSON.stringify(rb.j).slice(0, 200))
  ok(!(await title() ?? '').includes(MARK), 'after rollback the old title is back')
}
// canonical price untouched
const after = await state(); ok(after.snapshot.commerce && JSON.stringify(after.canonical) === JSON.stringify(st.canonical), 'canonical commerce data unchanged')
console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0)
