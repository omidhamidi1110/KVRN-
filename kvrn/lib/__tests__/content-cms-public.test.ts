// Collections, global SEO and the public read path against real PostgreSQL.
import { createFiDb, HAVE_DB, type FiDb } from './helpers/fi-pg'
import { createContentService, ContentError, type ContentService } from '../content-service'
import { createCollectionsService, type CollectionsService } from '../content-collections'
import { createSeoService, type SeoService } from '../content-seo-service'
import { createContentPublic, type ContentPublic } from '../content-public'
import { para, heading } from '../content-richtext'
import { activeAnnouncementMessages } from '../content-shell'
import { DEFAULT_ANNOUNCEMENT } from '../content-defaults'
import { adoptSeeds } from './helpers/cms-adopt'

const A = 'editor@kvrn.test'
const d = HAVE_DB ? describe : describe.skip
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

const asset = async (db: FiDb, n: number, status = 'active') => {
  const hex = n.toString(16).padStart(64, '0')
  const r = await db.q(`INSERT INTO media_assets (storage_key, sha256, mime_type, byte_size, filename, alt_text, status, width, height)
    VALUES ($1,$2,'image/webp',1000,$3,'Alt text',$4,800,600) RETURNING id`, [`media/${hex.slice(0, 2)}/${hex}/original.webp`, hex, `p${n}.webp`, status])
  return r[0].id as string
}
const col = (slug: string, extra: Record<string, unknown> = {}) => ({ slug, name: 'Winter', description: 'Warm things', heroMediaId: null, isActive: true, sortOrder: 0, seo: {}, ...extra })
const rejects = async (p: Promise<any>, code: string) => {
  try { await p } catch (e: any) { expect(e.code).toBe(code); return e }
  throw new Error('expected rejection ' + code)
}

d('collections, SEO and public loaders (real PG)', () => {
  let db: FiDb, svc: ContentService, cols: CollectionsService, seo: SeoService, pub: ContentPublic
  const calls: Array<{ paths: string[]; tags: string[] }> = []
  const invalidate = async (t: any) => { calls.push({ paths: t.paths ?? [], tags: t.tags ?? [] }); return { id: null, ok: true, paths: t.paths ?? [], tags: t.tags ?? [] } }
  let p1: string, p2: string, p3: string

  beforeAll(async () => {
    db = await createFiDb('content_pub')
    svc = createContentService(db.sql, { invalidate })
    cols = createCollectionsService(db.sql, { invalidate })
    seo = createSeoService(db.sql, { invalidate })
    pub = createContentPublic(db.sql)
    const ps = await db.q(`INSERT INTO products (drop_code, product_code, name, slug, price_cents, active) VALUES
      ('D1','PA','Alpha','alpha',1000,true), ('D1','PB','Bravo','bravo',2000,true), ('D1','PC','Charlie','charlie',3000,false) RETURNING id, slug`)
    const by = (s: string) => ps.find((p: any) => p.slug === s).id
    p1 = by('alpha'); p2 = by('bravo'); p3 = by('charlie')
  }, 120000)
  afterAll(async () => { await db?.close() })
  beforeEach(() => { calls.length = 0 })

  // ── collections ─────────────────────────────────────────────────────────────
  describe('collections', () => {
    test('create validates, is live, invalidates its path after commit', async () => {
      await rejects(cols.create(col('Bad Slug!'), A), 'invalid')
      await rejects(cols.create(col('ok', { name: '' }), A), 'invalid')
      const c = await cols.create(col('winter'), A)
      expect(c.invalidation?.ok).toBe(true)
      expect(calls[0].paths).toEqual(expect.arrayContaining(['/collections/winter', '/shop', '/sitemap.xml']))
      expect((await pub.getCollection('winter'))?.text.en.name).toBe('Winter')
      await rejects(cols.create(col('winter'), A), 'slug_taken')
    })

    test('product order is the array order; inactive products are hidden publicly but kept', async () => {
      const c = await cols.create(col('ordered'), A)
      const s = await cols.setProducts(c.data.id, [p2, p1, p3], c.data.version, A)
      const adm = await cols.get(c.data.id)
      expect(adm.products.map(p => p.slug)).toEqual(['bravo', 'alpha', 'charlie'])
      const view = await pub.getCollection('ordered')
      expect(view!.products.map(p => p.slug)).toEqual(['bravo', 'alpha'])
      expect(await pub.getCollectionProductSlugs('ordered')).toEqual(['bravo', 'alpha'])
      const re = await cols.setProducts(c.data.id, [p1], s.data.version, A)
      expect((await cols.get(c.data.id)).products.map(p => p.slug)).toEqual(['alpha'])
      expect(re.data.count).toBe(1)
      await rejects(cols.setProducts(c.data.id, ['not-a-uuid'], re.data.version, A), 'invalid')
    })

    test('slug change creates old→new redirect and invalidates old AND new paths', async () => {
      const c = await cols.create(col('old-name'), A)
      calls.length = 0
      const u = await cols.update(c.data.id, col('new-name'), c.data.version, A)
      expect(u.data.redirectCreated).toBe(true); expect(u.data.previousSlug).toBe('old-name')
      expect(calls[0].paths).toEqual(expect.arrayContaining(['/collections/old-name', '/collections/new-name']))
      expect(await pub.findRedirect('/collections/old-name')).toEqual({ to: '/collections/new-name', status: 301 })
      expect(await pub.getCollection('old-name')).toBeNull()
      expect(await pub.getCollection('new-name')).not.toBeNull()
    })

    test('stale version is rejected (409) and never overwrites', async () => {
      const c = await cols.create(col('stale-one'), A)
      await sleep(15)
      await cols.update(c.data.id, col('stale-one', { name: 'Second' }), c.data.version, A)
      const e = await rejects(cols.update(c.data.id, col('stale-one', { name: 'Third' }), c.data.version, A), 'stale')
      expect(e.status ?? 409).toBe(409)
      expect((await cols.get(c.data.id)).name).toBe('Second')
    })

    test('inactive and archived collections are not public; restore does not reactivate', async () => {
      const c = await cols.create(col('hidden', { isActive: false }), A)
      expect(await pub.getCollection('hidden')).toBeNull()
      const live = await cols.create(col('goes-away'), A)
      expect(await pub.getCollection('goes-away')).not.toBeNull()
      await sleep(15)
      const a = await cols.setArchived(live.data.id, true, live.data.version, A)
      expect(await pub.getCollection('goes-away')).toBeNull()
      expect((await cols.list()).map(x => x.slug)).not.toContain('goes-away')
      expect((await cols.list({ archived: true })).map(x => x.slug)).toContain('goes-away')
      await sleep(15)
      const r = await cols.setArchived(live.data.id, false, a.data.version, A)
      expect(await pub.getCollection('goes-away')).toBeNull()          // restore never silently re-publishes
      await sleep(15)
      await cols.update(live.data.id, col('goes-away'), r.data.version, A)
      expect(await pub.getCollection('goes-away')).not.toBeNull()      // an explicit save re-activates
      expect(c.data.id).toBeTruthy()
    })

    test('unusable hero image is refused; hero usage tracked while live', async () => {
      const bad = await asset(db, 9001, 'archived')
      await rejects(cols.create(col('badhero', { heroMediaId: bad }), A), 'unusable_media')
      const good = await asset(db, 9002)
      const c = await cols.create(col('goodhero', { heroMediaId: good }), A)
      const used = await db.q(`SELECT slot FROM media_usages WHERE owner_type='collection' AND owner_id=$1`, [c.data.id])
      expect(used.map((r: any) => r.slot)).toContain('hero')
      expect((await pub.getCollection('goodhero'))!.hero?.url).toMatch(/^\/media\//)
    })

    test('translations: only enabled languages, only real fields, completeness reported', async () => {
      const c = await cols.create(col('translated', { seo: { title: 'SEO title' } }), A)
      await rejects(cols.saveTranslation(c.data.id, { locale: 'xx', field: 'name', value: 'x' }, A), 'invalid')
      await rejects(cols.saveTranslation(c.data.id, { locale: 'es', field: 'bogus', value: 'x' }, A), 'invalid')
      await cols.saveTranslation(c.data.id, { locale: 'es', field: 'name', value: 'Invierno', status: 'published' }, A)
      const ov = await cols.translationOverview(c.data.id)
      expect(ov.source).toHaveProperty('name'); expect(ov.source).toHaveProperty('seoTitle')
      const view = await pub.getCollection('translated')
      expect(view!.text.es.name).toBe('Invierno')
      expect(view!.text.es.description).toBe('Warm things')   // untranslated field falls back, never blank
      await cols.clearTranslation(c.data.id, 'es', 'name', A)
      expect((await pub.getCollection('translated'))!.text.es).toBeUndefined()
    })

    test('writes leave admin audit rows with the actor', async () => {
      const r = await db.q(`SELECT DISTINCT action FROM admin_audit_logs WHERE resource='collection' AND actor_email=$1`, [A])
      expect(r.length).toBeGreaterThan(0)
    })
  })

  // ── global SEO ──────────────────────────────────────────────────────────────
  describe('global SEO', () => {
    test('defaults read back, put validates, stale revision rejected, invalidates / and sitemap', async () => {
      const g = await seo.get()
      expect(g.value.siteName).toBe('KVRN')
      await rejects(seo.put({ ...g.value, titleTemplate: 'no placeholder' }, g.revision, A), 'invalid')
      calls.length = 0
      const r = await seo.put({ ...g.value, description: 'A new default description' }, g.revision, A)
      expect(calls[0].paths).toEqual(expect.arrayContaining(['/', '/sitemap.xml']))
      expect((await pub.getGlobalSeo()).description).toBe('A new default description')
      await rejects(seo.put({ ...g.value }, g.revision, A), 'conflict')
      expect(r.data.revision).toBeGreaterThan(g.revision)
    })

    test('share image: resolved to a /media url; archived asset refused', async () => {
      const bad = await asset(db, 9101, 'archived')
      const cur = await seo.get()
      await rejects(seo.put({ ...cur.value, shareImageId: bad }, cur.revision, A), 'unusable_media')
      const ok = await asset(db, 9102)
      const r = await seo.put({ ...cur.value, shareImageId: ok }, cur.revision, A)
      expect((await seo.get()).value.shareImageUrl).toMatch(/^\/media\//)
      expect(r.invalidation.ok).toBe(true)
      expect((await pub.getGlobalSeo()).shareImageUrl).toMatch(/^\/media\//)
    })

    test('hand-edited garbage in the setting falls back to defaults per field', async () => {
      await db.q(`INSERT INTO site_settings (key, value, revision, updated_by) VALUES ('seo.global', '{"siteName": 5, "keywords": "x", "organization": {"sameAs": ["http://insecure"]}}'::jsonb, 1, 'x') ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`)
      const g = await pub.getGlobalSeo()
      expect(g.siteName).toBe('KVRN'); expect(Array.isArray(g.keywords)).toBe(true)
      expect(g.organization.sameAs.every(u => u.startsWith('https://'))).toBe(true)
    })
  })

  // ── public loaders ──────────────────────────────────────────────────────────
  describe('public loaders return published content only', () => {
    const body = (t: string) => ({ v: 1, blocks: [heading('H'), para(t)] })

    test('seed-published content is NOT served (it would override the Oct 6 coded copy); a human publish/adoption makes it live', async () => {
      expect(await pub.getPolicyById('terms')).toBeNull()
      expect(await pub.getPolicyBySlug('privacy')).toBeNull()
      expect(await pub.getFaq()).toBeNull()
      const sh = await pub.getShell()
      expect(sh.navigation).toBeNull(); expect(sh.footer).toBeNull()
      expect((await pub.getSitemapEntries()).map(e => e.path)).not.toContain('/terms')
      expect(await adoptSeeds(db.q)).toBeGreaterThan(0)
    })

    test('after adoption policies are public; a new draft is not; an edited draft does not change the live text', async () => {
      const terms = await pub.getPolicyById('terms')
      expect(terms?.path).toBe('/terms')
      const before = JSON.stringify(terms!.variants.en.data)
      const cur = await svc.get('policies', 'terms')
      await svc.saveDraft('policies', 'terms', { ...cur.snapshot, body: body('DRAFT ONLY') }, cur.revision, A)
      expect(JSON.stringify((await pub.getPolicyById('terms'))!.variants.en.data)).toBe(before)
      expect(JSON.stringify(await pub.getPolicyById('terms'))).not.toContain('DRAFT ONLY')
      const c = await svc.create('policies', { slug: 'draftpol', title: 'D', style: 'legal', body: body('x'), seo: {} }, A)
      expect(await pub.getPolicyBySlug('draftpol')).toBeNull()
      expect(c.data.id).toBeTruthy()
    })

    test('pages: published only; unpublish removes; sitemap lists only published indexable', async () => {
      const mk = (slug: string, noindex = false) => ({ slug, title: 'P', body: body('b'), navEligible: false, seo: { noindex } })
      const a = await svc.create('pages', mk('pg-live'), A); await svc.publish('pages', a.data.id, a.data.revision, A)
      const b = await svc.create('pages', mk('pg-draft'), A)
      const n = await svc.create('pages', mk('pg-noindex', true), A); await svc.publish('pages', n.data.id, n.data.revision, A)
      expect(await pub.getPageBySlug('pg-draft')).toBeNull()
      expect((await pub.getPageBySlug('pg-live'))?.path).toBe('/pages/pg-live')
      const sm = (await pub.getSitemapEntries()).map(e => e.path)
      expect(sm).toContain('/pages/pg-live'); expect(sm).not.toContain('/pages/pg-draft'); expect(sm).not.toContain('/pages/pg-noindex')
      expect(sm).toEqual(expect.arrayContaining(['/terms', '/privacy', '/cookies', '/support/shipping-returns', '/support/faq']))
      const live = await svc.get('pages', a.data.id)
      await svc.unpublish('pages', a.data.id, live.revision, A)
      expect(await pub.getPageBySlug('pg-live')).toBeNull()
      expect((await pub.getSitemapEntries()).map(e => e.path)).not.toContain('/pages/pg-live')
      expect(b.data.id).toBeTruthy()
    })

    test('translated variants carry state; unpublished translations never reach the storefront', async () => {
      const c = await svc.create('pages', { slug: 'tr-page', title: 'Care', body: body('Hello'), navEligible: false, seo: {} }, A)
      await svc.publish('pages', c.data.id, c.data.revision, A)
      await svc.saveTranslation('pages', c.data.id, { locale: 'es', field: 'title', value: 'Cuidado', status: 'draft' }, A)
      let v = await pub.getPageBySlug('tr-page')
      expect(v!.variants.es?.data.title ?? 'Care').toBe('Care')
      await svc.saveTranslation('pages', c.data.id, { locale: 'es', field: 'title', value: 'Cuidado', status: 'published' }, A)
      v = await pub.getPageBySlug('tr-page')
      expect(v!.variants.es.data.title).toBe('Cuidado')
      expect(v!.variants.en.data.title).toBe('Care')
    })

    test('size guides: only published + showOnGuidePage, in order; product link resolves published only', async () => {
      const g = await pub.getPublicSizeGuides()
      expect(g!.map(x => x.id)).toEqual(expect.arrayContaining(['kvrn-hoodie', 'kvrn-sweatpants']))
      await svc.assignSizeGuide(p1, 'kvrn-hoodie', A)
      expect((await pub.getSizeGuideForProduct(p1))?.id).toBe('kvrn-hoodie')
      expect(await pub.getSizeGuideForProduct(p2)).toBeNull()
    })

    test('shell: (adopted) navigation/footer/announcement are returned; announcement window and disabled state are honoured', async () => {
      const sh = await pub.getShell()
      expect(sh.navigation?.desktop.length).toBeGreaterThan(0)
      expect(sh.footer?.groups.length).toBeGreaterThan(0)
      const now = new Date('2026-01-01T00:00:00Z')
      const a = await svc.get('announcement')
      const on = { ...a.snapshot, enabled: true, startsAt: '2026-02-01T00:00:00Z', endsAt: '2026-03-01T00:00:00Z' }
      const s = await svc.saveDraft('announcement', undefined, on, a.revision, A)
      await svc.publish('announcement', undefined, s.data.revision, A)
      const sh2 = await pub.getShell()
      expect(activeAnnouncementMessages(sh2.announcement, 'en', sh2.tr.announcement, now)).toEqual([])
      expect(activeAnnouncementMessages(sh2.announcement, 'en', sh2.tr.announcement, new Date('2026-02-15T00:00:00Z')).length).toBeGreaterThan(0)
      expect(activeAnnouncementMessages(sh2.announcement, 'en', sh2.tr.announcement, new Date('2026-03-02T00:00:00Z'))).toEqual([])
      expect(DEFAULT_ANNOUNCEMENT.messages.length).toBeGreaterThan(0)
    })

    test('a database failure yields null (coded fallback), never a throw', async () => {
      const broken = createContentPublic((() => { throw new Error('connection refused: secret-host') }) as any)
      const spy = jest.spyOn(console, 'error').mockImplementation(() => {})
      expect(await broken.getPolicyById('terms')).toBeNull()
      expect(await broken.getFaq()).toBeNull()
      expect(await broken.getCollection('x')).toBeNull()
      expect((await broken.getShell()).navigation).toBeNull()
      expect((await broken.getGlobalSeo()).siteName).toBe('KVRN')
      expect(await broken.getSitemapEntries()).toEqual([])
      spy.mockRestore()
    })

    test('ContentError is exported for route mapping', () => { expect(new ContentError('invalid', 'x').code).toBe('invalid') })
  })
})
