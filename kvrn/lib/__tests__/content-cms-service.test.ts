// Content service against real PostgreSQL: lifecycle per entity type via the foundation
// functions, redirects on slug change, size-guide sharing vs duplicate independence, FAQ
// ordering/active, archive/restore guards, stale conflicts, audit rows, translations,
// media/block gates, and visible cache-invalidation failure.
import { createFiDb, HAVE_DB, type FiDb } from './helpers/fi-pg'
import { createContentService, ContentError, toHttpError, type ContentService } from '../content-service'
import { CmsError } from '../cms-core'
import { invalidateAfterCommit } from '../cache-invalidation'
import { SEED_FAQ, SEED_SIZE_GUIDE_HOODIE } from '../content-seed-data'
import { para, heading } from '../content-richtext'

const A = 'editor@kvrn.test'
const d = HAVE_DB ? describe : describe.skip

const asset = async (db: FiDb, n: number, status = 'active') => {
  const hex = n.toString(16).padStart(64, '0')
  const r = await db.q(`INSERT INTO media_assets (storage_key, sha256, mime_type, byte_size, filename, alt_text, status)
    VALUES ($1,$2,'image/webp',1000,$3,'Alt text',$4) RETURNING id`, [`media/${hex.slice(0, 2)}/${hex}/original.webp`, hex, `f${n}.webp`, status])
  return r[0].id as string
}
const policyDoc = (extra = '') => ({ v: 1, blocks: [heading('Section'), para('Body text.' + extra)] })
const policy = (slug: string, extra = '') => ({ slug, title: 'My policy', style: 'legal', body: policyDoc(extra), seo: {} })
const page = (slug: string, body: any = policyDoc()) => ({ slug, title: 'Care', body, navEligible: false, seo: {} })
const guide = (name = 'Tee') => ({ ...SEED_SIZE_GUIDE_HOODIE, name, garment: name, showOnGuidePage: false })
const block = (name = 'Care') => ({ name, category: 'care', content: { v: 1, blocks: [para('Machine wash cold.')] } })

d('content service (real PG)', () => {
  let db: FiDb, svc: ContentService
  const calls: Array<{ paths: string[]; tags: string[]; reason: string }> = []
  beforeAll(async () => {
    db = await createFiDb('content_svc')
    svc = createContentService(db.sql, {
      invalidate: async (t, c) => { calls.push({ paths: t.paths ?? [], tags: t.tags ?? [], reason: c.reason }); return { id: null, ok: true, paths: t.paths ?? [], tags: t.tags ?? [] } },
    })
  }, 120000)
  afterAll(async () => { await db?.close() })
  beforeEach(() => { calls.length = 0 })

  const expectCode = async (p: Promise<any>, code: string) => {
    try { await p } catch (e: any) { expect(e.code).toBe(code); return e }
    throw new Error('expected rejection ' + code)
  }

  // ── policies ───────────────────────────────────────────────────────────────
  describe('policies', () => {
    test('draft → publish → live at the legacy path; draft edits stay private', async () => {
      const g = await svc.get('policies', 'terms')
      expect(g.status).toBe('published'); expect(g.path).toBe('/terms')
      const s = await svc.saveDraft('policies', 'terms', { ...g.snapshot, title: 'Terms (draft)' }, g.revision, A)
      const pub = await svc.get('policies', 'terms')
      expect(pub.published.title).toBe('Terms of Service')      // live content untouched
      expect(pub.snapshot.title).toBe('Terms (draft)')
      const r = await svc.publish('policies', 'terms', s.data.revision, A)
      expect(r.data.path).toBe('/terms'); expect(r.invalidation?.ok).toBe(true)
      expect(calls[0].paths).toEqual(expect.arrayContaining(['/terms', '/legal/terms', '/sitemap.xml']))
    })

    test('slug change: redirect old→new, BOTH paths invalidated, rollback restores', async () => {
      // v1 is the migration placeholder: it can never be rolled back to. A human-edited v2 (same slug) is the restore target.
      const g0 = await svc.get('policies', 'privacy')
      const e1 = await svc.saveDraft('policies', 'privacy', { ...g0.snapshot, lastUpdatedLabel: 'Last updated (reviewed)' }, g0.revision, A)
      await svc.publish('policies', 'privacy', e1.data.revision, A)
      calls.length = 0
      const g = await svc.get('policies', 'privacy')
      const s = await svc.saveDraft('policies', 'privacy', { ...g.snapshot, slug: 'privacy-notice' }, g.revision, A)
      const r = await svc.publish('policies', 'privacy', s.data.revision, A)
      expect(r.data).toMatchObject({ slug: 'privacy-notice', previousSlug: 'privacy', redirectCreated: true, path: '/legal/privacy-notice' })
      expect(calls[0].paths).toEqual(expect.arrayContaining(['/legal/privacy-notice', '/privacy', '/legal/privacy']))
      expect(await db.q(`SELECT to_path FROM content_redirects WHERE from_path='/privacy'`)).toEqual([{ to_path: '/legal/privacy-notice' }])
      const hist = await svc.history('policies', 'privacy')
      calls.length = 0
      const cur = await svc.get('policies', 'privacy')
      const rb = await svc.rollback('policies', 'privacy', 2, cur.revision, A)
      expect(rb.data.slug).toBe('privacy')
      expect(calls[0].paths).toEqual(expect.arrayContaining(['/privacy', '/legal/privacy-notice']))
      expect(await db.q(`SELECT from_path FROM content_redirects WHERE from_path='/privacy'`)).toEqual([])
      expect(hist.length).toBeGreaterThanOrEqual(2)
    })

    test('custom policy lives under /legal and cannot take a reserved slug', async () => {
      const e = await expectCode(svc.create('policies', policy('terms'), A), 'invalid')
      expect(e.details.join(' ')).toMatch(/reserved/)
      const c = await svc.create('policies', policy('warranty-terms'), A)
      const r = await svc.publish('policies', c.data.id, c.data.revision, A)
      expect(r.data.path).toBe('/legal/warranty-terms')
    })

    test('legacy legal pages cannot be archived or unpublished; custom ones can', async () => {
      const g = await svc.get('policies', 'cookies')
      await expectCode(svc.archive('policies', 'cookies', g.revision, A), 'forbidden')
      await expectCode(svc.unpublish('policies', 'cookies', g.revision, A), 'forbidden')
      const c = await svc.create('policies', policy('temp-policy'), A)
      const p = await svc.publish('policies', c.data.id, c.data.revision, A)
      const u = await svc.unpublish('policies', c.data.id, p.data.revision, A)
      expect((await svc.get('policies', c.data.id)).status).toBe('unpublished')
      const ar = await svc.archive('policies', c.data.id, u.data.revision, A)
      const rs = await svc.restore('policies', c.data.id, ar.data.revision, A)
      expect((await svc.get('policies', c.data.id)).status).not.toBe('published')   // restore never auto-publishes
      expect(rs.invalidation).toBeNull()
    })

    test('publish validates server-side: an invalid stored draft cannot go live', async () => {
      const c = await svc.create('policies', policy('will-break'), A)
      await db.q(`UPDATE content_versions SET snapshot = jsonb_set(snapshot, '{body,blocks,0}', '{"t":"html","html":"<script>"}') WHERE entity_type='policy' AND entity_id=$1`, [c.data.id])
      await expectCode(svc.publish('policies', c.data.id, c.data.revision, A), 'invalid')
    })
  })

  // ── generic pages ──────────────────────────────────────────────────────────
  describe('pages', () => {
    test('publish, slug change redirect (/pages), old+new invalidated, unpublish', async () => {
      const c = await svc.create('pages', page('care'), A)
      const p1 = await svc.publish('pages', c.data.id, c.data.revision, A)
      expect(p1.data.slug).toBe('care')
      const g = await svc.get('pages', c.data.id)
      const s = await svc.saveDraft('pages', c.data.id, { ...g.snapshot, slug: 'care-guide' }, g.revision, A)
      calls.length = 0
      const p2 = await svc.publish('pages', c.data.id, s.data.revision, A)
      expect(p2.data).toMatchObject({ slug: 'care-guide', previousSlug: 'care', redirectCreated: true })
      expect(calls[0].paths).toEqual(expect.arrayContaining(['/pages/care', '/pages/care-guide', '/sitemap.xml']))
      expect(await db.q(`SELECT to_path FROM content_redirects WHERE from_path='/pages/care'`)).toEqual([{ to_path: '/pages/care-guide' }])
      calls.length = 0
      await svc.unpublish('pages', c.data.id, p2.data.revision, A)
      expect(calls[0].paths).toContain('/pages/care-guide')
      expect(await svc.cms.getPublishedBySlug('page', 'care-guide')).toBeNull()
    })

    test('two live pages cannot share a slug', async () => {
      const a = await svc.create('pages', page('dup-slug'), A); await svc.publish('pages', a.data.id, a.data.revision, A)
      const b = await svc.create('pages', page('dup-slug'), A)
      const e = await expectCode(svc.publish('pages', b.data.id, b.data.revision, A), 'slug_taken')
      expect(toHttpError(e).status).toBe(409)
    })

    test('duplicate gets a unique draft slug and never affects the original', async () => {
      const c = await svc.create('pages', page('original-page'), A); await svc.publish('pages', c.data.id, c.data.revision, A)
      const d1 = await svc.duplicate('pages', c.data.id, A)
      const d2 = await svc.duplicate('pages', c.data.id, A)
      const s1 = (await svc.get('pages', d1.data.id)).snapshot, s2 = (await svc.get('pages', d2.data.id)).snapshot
      expect(s1.slug).toBe('original-page-copy'); expect(s2.slug).toBe('original-page-copy-2')
      expect((await svc.get('pages', d1.data.id)).status).toBe('draft')
    })
  })

  // ── stale edit protection + audit ───────────────────────────────────────────
  test('stale revisions are rejected with 409 and never overwrite', async () => {
    const c = await svc.create('blocks', block('Stale'), A)
    await svc.saveDraft('blocks', c.data.id, block('Stale v2'), c.data.revision, A)
    const e = await expectCode(svc.saveDraft('blocks', c.data.id, block('Stale v3'), c.data.revision, A), 'stale')
    expect(toHttpError(e).status).toBe(409)
    expect((await svc.get('blocks', c.data.id)).snapshot.name).toBe('Stale v2')
    await expectCode(svc.publish('blocks', c.data.id, c.data.revision, A), 'stale')
  })

  test('every lifecycle change writes admin_audit_logs (actor, dotted action, no content in payload)', async () => {
    const c = await svc.create('blocks', block('Audited'), A)
    const p = await svc.publish('blocks', c.data.id, (await svc.get('blocks', c.data.id)).revision, A)
    const u = await svc.unpublish('blocks', c.data.id, p.data.revision, A)
    const ar = await svc.archive('blocks', c.data.id, u.data.revision, A)
    await svc.restore('blocks', c.data.id, ar.data.revision, A)
    await svc.duplicate('blocks', c.data.id, A)
    const rows = await db.q(`SELECT action, actor_email, payload FROM admin_audit_logs WHERE resource='content_block' AND actor_email=$1 ORDER BY created_at`, [A])
    const actions = rows.map((r: any) => r.action)
    for (const a of ['cms.publish', 'cms.unpublish', 'cms.archive', 'cms.restore', 'content.duplicate']) expect(actions).toContain(a)
    expect(JSON.stringify(rows)).not.toContain('Machine wash cold')
  })

  // ── size guides ────────────────────────────────────────────────────────────
  describe('size guides', () => {
    let p1: string, p2: string
    beforeAll(async () => {
      const r = await db.q(`INSERT INTO products (drop_code, product_code, name, slug, price_cents)
        VALUES ('D1','SG1','Sg product one','sg-one',1000), ('D1','SG2','Sg product two','sg-two',1000) RETURNING id`)
      p1 = r[0].id; p2 = r[1].id
    })

    test('products sharing a guide share its updates; a duplicate is independent', async () => {
      const g = await svc.create('size-guides', guide('Tee'), A)
      const pub = await svc.publish('size-guides', g.data.id, g.data.revision, A)
      await svc.assignSizeGuide(p1, g.data.id, A); await svc.assignSizeGuide(p2, g.data.id, A)
      expect((await svc.listGuideProducts(g.data.id)).map(p => p.slug).sort()).toEqual(['sg-one', 'sg-two'])
      // duplicate-and-edit for product 2 only
      calls.length = 0
      const dup = await svc.duplicateSizeGuideForProduct(g.data.id, p2, A)
      expect(dup.data.id).not.toBe(g.data.id)
      const dsnap = (await svc.get('size-guides', dup.data.id)).snapshot
      expect(dsnap.name).toBe('Copy of Tee')
      await svc.saveDraft('size-guides', dup.data.id, { ...dsnap, notes: ['changed'] }, dup.data.revision, A)
      const orig = await svc.get('size-guides', g.data.id)
      expect(orig.snapshot.notes).toEqual(SEED_SIZE_GUIDE_HOODIE.notes)           // original unchanged
      expect((await svc.listGuideProducts(g.data.id)).map(p => p.slug)).toEqual(['sg-one'])
      expect((await svc.listGuideProducts(dup.data.id)).map(p => p.slug)).toEqual(['sg-two'])
      expect(pub.invalidation?.ok).toBe(true)
    })

    test('editing a shared guide invalidates every linked product page', async () => {
      const g = await svc.create('size-guides', guide('Shared'), A)
      const rev = (await svc.publish('size-guides', g.data.id, g.data.revision, A)).data.revision
      await svc.assignSizeGuide(p1, g.data.id, A); await svc.assignSizeGuide(p2, g.data.id, A)
      const cur = await svc.get('size-guides', g.data.id)
      const s = await svc.saveDraft('size-guides', g.data.id, { ...cur.snapshot, notes: ['new note'] }, rev, A)
      calls.length = 0
      await svc.publish('size-guides', g.data.id, s.data.revision, A)
      expect(calls[0].paths).toEqual(expect.arrayContaining(['/support/size-guide', '/products/sg-one', '/products/sg-two']))
      expect(calls[0].tags).toContain('cms:size-guides')
    })

    test('archive is blocked while products use it (force unlinks) and archived guides cannot be assigned', async () => {
      const g = await svc.create('size-guides', guide('Archivable'), A)
      await svc.publish('size-guides', g.data.id, g.data.revision, A)
      await svc.assignSizeGuide(p1, g.data.id, A)
      const rev = (await svc.get('size-guides', g.data.id)).revision
      const e = await expectCode(svc.archive('size-guides', g.data.id, rev, A), 'in_use')
      expect(e.details.productCount).toBe(1)
      calls.length = 0
      await svc.archive('size-guides', g.data.id, rev, A, { force: true })
      expect(calls[0].paths).toContain('/products/sg-one')                   // product page refreshed too
      expect(await db.q(`SELECT 1 FROM product_size_guides WHERE size_guide_id=$1`, [g.data.id])).toEqual([])
      await expectCode(svc.assignSizeGuide(p1, g.data.id, A), 'forbidden')
    })

    test('assign/clear is audited and bad input is rejected', async () => {
      await expectCode(svc.assignSizeGuide('not-a-uuid', 'x', A), 'invalid')
      await expectCode(svc.assignSizeGuide(p1, 'no-such-guide', A), 'not_found')
      await svc.assignSizeGuide(p1, null, A)
      const aud = await db.q(`SELECT action FROM admin_audit_logs WHERE action='content.size_guide.assign'`)
      expect(aud.length).toBeGreaterThan(0)
    })

    test('guide validation: ordered rows/cols, units, duplicate ids refused', async () => {
      const bad = { ...guide(), columns: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }
      await expectCode(svc.create('size-guides', bad, A), 'invalid')
      await expectCode(svc.create('size-guides', { ...guide(), shopLink: { label: 'x', href: 'javascript:alert(1)' } }, A), 'invalid')
    })
  })

  // ── FAQ ────────────────────────────────────────────────────────────────────
  test('FAQ: order and active flags persist atomically with versioning + rollback', async () => {
    // v1 is the migration placeholder (never publishable unchanged). A human-edited v2 keeps the original order and is the restore target.
    const g1 = await svc.get('faq')
    const e1 = await svc.saveDraft('faq', undefined, { ...g1.snapshot, heroTitle: 'FAQ & help' }, g1.revision, A)
    await svc.publish('faq', undefined, e1.data.revision, A)
    const g = await svc.get('faq')
    expect(g.snapshot.categories.map((c: any) => c.id)).toEqual(['products', 'sizing', 'shipping', 'returns'])
    const reordered = { ...g.snapshot, categories: [g.snapshot.categories[3], ...g.snapshot.categories.slice(0, 3)] }
    reordered.categories[1] = { ...reordered.categories[1], items: [reordered.categories[1].items[1], { ...reordered.categories[1].items[0], active: false }, ...reordered.categories[1].items.slice(2)] }
    const s = await svc.saveDraft('faq', undefined, reordered, g.revision, A)
    await svc.publish('faq', undefined, s.data.revision, A)
    const now = await svc.get('faq')
    expect(now.snapshot.categories[0].id).toBe('returns')
    expect(now.snapshot.categories[1].items[1].active).toBe(false)
    expect(calls.at(-1)!.paths).toContain('/support/faq')
    const rb = await svc.rollback('faq', undefined, 2, now.revision, A)
    expect((await svc.get('faq')).snapshot.categories[0].id).toBe('products')
    expect(rb.invalidation?.ok).toBe(true)
    await expectCode(svc.saveDraft('faq', undefined, { ...SEED_FAQ, categories: [SEED_FAQ.categories[0], SEED_FAQ.categories[0]] }, (await svc.get('faq')).revision, A), 'invalid')  // duplicate ids
  })

  // ── reusable blocks ────────────────────────────────────────────────────────
  describe('reusable blocks', () => {
    test('pages reference blocks by id; only LIVE blocks can be referenced; usage blocks archive/unpublish', async () => {
      const b = await svc.create('blocks', block('Care instructions'), A)
      const withRef = (id: string) => page('uses-block', { v: 1, blocks: [para('Intro'), { t: 'blockref', blockId: id }] })
      const pg = await svc.create('pages', withRef(b.data.id), A)
      const miss = await expectCode(svc.publish('pages', pg.data.id, pg.data.revision, A), 'missing_block')   // block not published yet
      expect(miss.details.blockIds).toEqual([b.data.id])
      const bp = await svc.publish('blocks', b.data.id, b.data.revision, A)
      const pp = await svc.publish('pages', pg.data.id, pg.data.revision, A)
      expect((await svc.blockUsage(b.data.id)).map((u: any) => `${u.owner_type}:${u.scope}`)).toEqual(['page:published'])
      const e1 = await expectCode(svc.archive('blocks', b.data.id, bp.data.revision, A), 'in_use')
      expect(e1.details.usages).toHaveLength(1)
      await expectCode(svc.unpublish('blocks', b.data.id, bp.data.revision, A), 'in_use')
      // editing the block refreshes the page that uses it
      const cur = await svc.get('blocks', b.data.id)
      const s = await svc.saveDraft('blocks', b.data.id, { ...cur.snapshot, name: 'Care v2' }, bp.data.revision, A)
      calls.length = 0
      await svc.publish('blocks', b.data.id, s.data.revision, A)
      expect(calls[0].paths).toContain('/pages/uses-block')
      // remove the page → usage cleared → block can be archived
      await svc.unpublish('pages', pg.data.id, pp.data.revision, A)
      expect(await svc.blockUsage(b.data.id)).toEqual([])
      const rev = (await svc.get('blocks', b.data.id)).revision
      await svc.archive('blocks', b.data.id, rev, A)
    })

    test('a reusable block cannot embed another block (no nesting)', async () => {
      const id = '123e4567-e89b-12d3-a456-426614174000'
      await expectCode(svc.create('blocks', { name: 'N', category: 'care', content: { v: 1, blocks: [{ t: 'blockref', blockId: id }] } }, A), 'invalid')
    })
  })

  // ── media gates + usages ───────────────────────────────────────────────────
  describe('media', () => {
    test('draft and published usages are tracked; archived/missing images block publishing', async () => {
      const a1 = await asset(db, 1), a2 = await asset(db, 2, 'archived')
      const mk = (id: string) => page('with-media', { v: 1, blocks: [para('x'), { t: 'media', assetId: id }] })
      const c = await svc.create('pages', mk(a1), A)
      expect(await db.q(`SELECT scope FROM media_usages WHERE owner_type='page' AND owner_id=$1`, [c.data.id])).toEqual([{ scope: 'draft' }])
      const p = await svc.publish('pages', c.data.id, c.data.revision, A)
      expect(await db.q(`SELECT scope FROM media_usages WHERE owner_type='page' AND owner_id=$1`, [c.data.id])).toEqual([{ scope: 'published' }])
      const s = await svc.saveDraft('pages', c.data.id, { ...mk(a2), slug: 'with-media' }, p.data.revision, A)
      const e = await expectCode(svc.publish('pages', c.data.id, s.data.revision, A), 'unusable_media')
      expect(e.details.assetIds).toEqual([a2])
      await svc.unpublish('pages', c.data.id, s.data.revision, A)
      expect(await db.q(`SELECT scope FROM media_usages WHERE owner_type='page' AND owner_id=$1 AND scope='published'`, [c.data.id])).toEqual([])
    })
  })

  // ── translations ───────────────────────────────────────────────────────────
  describe('translations', () => {
    test('overview lists per-locale completeness: missing legal translations are visible', async () => {
      const ov = await svc.translationOverview('policies', 'terms')
      expect(ov.legal).toBe(true)
      expect(ov.locales).toEqual(['es', 'fr', 'ar', 'zh', 'hi', 'pt', 'de', 'ja', 'ko'])
      const es = ov.completeness.find(c => c.locale === 'es')!
      expect(es.translated).toBe(0); expect(es.missing).toBe(es.total); expect(es.complete).toBe(false)
      expect(Object.keys(ov.source)).toEqual(expect.arrayContaining(['title', 'body', 'heroTitle']))
    })

    test('policy translations cannot be published directly; per-locale publish needs acknowledgement', async () => {
      await svc.saveTranslation('policies', 'terms', { locale: 'es', field: 'title', value: 'Términos de servicio' }, A)
      await expectCode(svc.saveTranslation('policies', 'terms', { locale: 'es', field: 'title', value: 'x', status: 'published' }, A), 'forbidden')
      await expectCode(svc.publishLocale('policies', 'terms', 'es', A), 'forbidden')
      const r = await svc.publishLocale('policies', 'terms', 'es', A, { acknowledge: true })
      expect(r.data.published).toBe(1)
      const ov = await svc.translationOverview('policies', 'terms')
      expect(ov.completeness.find(c => c.locale === 'es')!.translated).toBe(1)
      expect(ov.completeness.find(c => c.locale === 'es')!.missing).toBeGreaterThan(0)    // still visibly incomplete
      expect(r.invalidation?.ok).toBe(true)
      const u = await svc.unpublishLocale('policies', 'terms', 'es', A)
      expect(u.data.unpublished).toBe(1)
    })

    test('machine-generated text can never be published (service + DB)', async () => {
      await svc.saveTranslation('policies', 'cookies', { locale: 'fr', field: 'title', value: 'Politique de cookies', machineGenerated: true }, A)
      const r = await svc.publishLocale('policies', 'cookies', 'fr', A, { acknowledge: true })
      expect(r.data).toMatchObject({ published: 0, skippedMachine: 1 })
      expect(await db.err(`UPDATE content_translations SET status='published' WHERE entity_type='policy' AND entity_id='cookies' AND locale='fr'`)).toMatch(/no_machine_publish/)
    })

    test('stale detection after the source text changes; unknown fields/locales rejected', async () => {
      const b = await svc.create('blocks', block('Fabric'), A)
      await svc.saveTranslation('blocks', b.data.id, { locale: 'de', field: 'name', value: 'Stoff', status: 'published' }, A)
      const cur = await svc.get('blocks', b.data.id)
      await svc.saveDraft('blocks', b.data.id, { ...cur.snapshot, name: 'Fabric v2' }, cur.revision, A)
      const ov = await svc.translationOverview('blocks', b.data.id)
      expect(ov.completeness.find(c => c.locale === 'de')!.stale).toBe(1)
      await expectCode(svc.saveTranslation('blocks', b.data.id, { locale: 'de', field: 'nope', value: 'x' }, A), 'invalid')
      await expectCode(svc.saveTranslation('blocks', b.data.id, { locale: 'en', field: 'name', value: 'x' }, A), 'invalid')
      await expectCode(svc.saveTranslation('blocks', b.data.id, { locale: 'xx-bad-locale!', field: 'name', value: 'x' }, A), 'invalid')
    })

    test('rich-text translations must be valid structured text', async () => {
      const b = await svc.create('blocks', block('Rich'), A)
      await expectCode(svc.saveTranslation('blocks', b.data.id, { locale: 'es', field: 'content', value: '<script>alert(1)</script>' }, A), 'invalid')
      await expectCode(svc.saveTranslation('blocks', b.data.id, { locale: 'es', field: 'content', value: JSON.stringify({ v: 1, blocks: [{ t: 'html' }] }) }, A), 'invalid')
      await svc.saveTranslation('blocks', b.data.id, { locale: 'es', field: 'content', value: JSON.stringify({ v: 1, blocks: [para('Lavar en frío.')] }) }, A)
    })
  })

  // ── cache invalidation visibility ──────────────────────────────────────────
  test('a failed cache invalidation is returned to the caller (never silent) and logged as failed', async () => {
    const failing = createContentService(db.sql, {
      invalidate: (t, c) => invalidateAfterCommit(db.sql, t, c, { revalidatePath: () => { throw new Error('boom') }, revalidateTag: () => {} }),
    })
    const b = await failing.create('blocks', block('Inv'), A)
    const r = await failing.publish('blocks', b.data.id, b.data.revision, A)
    expect(await failing.get('blocks', b.data.id)).toMatchObject({ status: 'published' })   // content change committed
    // blocks with no usage have no paths, so use a page for a concrete path
    const pg = await failing.create('pages', page('inv-page'), A)
    const pr = await failing.publish('pages', pg.data.id, pg.data.revision, A)
    expect(pr.invalidation?.ok).toBe(false)
    expect(pr.invalidation?.error).toMatch(/boom/)
    expect(await db.q(`SELECT status FROM cache_invalidations WHERE status='failed'`)).not.toHaveLength(0)
    expect(r).toBeTruthy()
  })

  test('toHttpError maps typed errors and hides unknown ones', () => {
    expect(toHttpError(new ContentError('in_use', 'x')).status).toBe(409)
    expect(toHttpError(new CmsError('stale', 'x')).status).toBe(409)
    const u = toHttpError(new Error('SELECT * FROM secrets; password=abc'))
    expect(u.status).toBe(500); expect(JSON.stringify(u.body)).not.toMatch(/secrets|password/)
  })

  test('singletons cannot be archived/duplicated; unknown kinds/ids are rejected', async () => {
    const f = await svc.get('footer')
    await expectCode(svc.archive('footer', undefined, f.revision, A), 'forbidden')
    await expectCode(svc.duplicate('footer', undefined, A), 'forbidden')
    await expectCode(svc.get('support-pages', 'nope'), 'invalid')
    await expectCode(svc.get('pages', '../etc'), 'invalid')
  })

  test('announcement / navigation / footer: publish invalidates the global shell; protected links enforced', async () => {
    const n = await svc.get('navigation')
    const noShop = { ...n.snapshot, desktop: n.snapshot.desktop.filter((l: any) => l.href !== '/shop') }
    await expectCode(svc.saveDraft('navigation', undefined, noShop, n.revision, A), 'invalid')
    const s = await svc.saveDraft('navigation', undefined, { ...n.snapshot, desktop: [...n.snapshot.desktop, { id: 'd-faq', label: 'FAQ', href: '/support/faq' }] }, n.revision, A)
    calls.length = 0
    await svc.publish('navigation', undefined, s.data.revision, A)
    expect(calls[0]).toMatchObject({ paths: ['/'], tags: ['cms:nav'] })
    const a = await svc.get('announcement')
    const sa = await svc.saveDraft('announcement', undefined, { ...a.snapshot, enabled: false }, a.revision, A)
    calls.length = 0
    await svc.publish('announcement', undefined, sa.data.revision, A)
    expect(calls[0].tags).toEqual(['cms:announcement'])
  })
})
