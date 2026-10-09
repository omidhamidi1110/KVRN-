// Migration 030 against real PostgreSQL: idempotent, seeds present + published + valid,
// policy publish/rollback with slug-change redirects, size-guide assignment constraints.
import fs from 'fs'
import path from 'path'
import { createFiDb, HAVE_DB, ROOT, type FiDb } from './helpers/fi-pg'
import { createCms } from '../cms-core'
import { validateSnapshot, KINDS, kindForType, policyPath } from '../content-schemas'
import { adoptSeeds } from './helpers/cms-adopt'
import { buildSeedSql, seedEntities, SEED_BEGIN, SEED_END } from '../content-seed'

const A = 'owner@kvrn.test'
const FILE = path.join(ROOT, 'db/migrations/030_site_content_cms.sql')

describe('030 migration file', () => {
  const sql = fs.readFileSync(FILE, 'utf8')
  test('generated seed block equals lib/content-seed.ts output (no drift)', () => {
    const a = sql.indexOf(SEED_BEGIN), b = sql.indexOf(SEED_END) + SEED_END.length
    expect(a).toBeGreaterThan(0)
    expect(sql.slice(a, b)).toBe(buildSeedSql())
  })
  test('does not edit frozen migrations or replace existing functions other than cms_path_prefix', () => {
    const replaced = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (\w+)/g)].map(m => m[1]).sort()
    expect(replaced).toEqual(['cms_path_prefix', 'content_collection_archive', 'content_collection_save', 'content_collection_set_products', 'content_collection_version', 'content_policy_go_live', 'content_policy_path'])
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|FUNCTION|COLUMN)\b/i)
    expect(sql).not.toMatch(/\bALTER\s+TABLE\s+(?!IF)/i)
  })
  test('every seed snapshot passes its validator', () => {
    for (const e of seedEntities()) {
      const kind = kindForType(e.type)!
      expect(kind).toBeTruthy()
      const v = validateSnapshot(kind, e.snapshot, { entityId: e.id })
      if (!v.ok) throw new Error(`${e.type}/${e.id}: ${v.errors.join('; ')}`)
    }
  })
})

const d = HAVE_DB ? describe : describe.skip
d('030 site content CMS (real PG)', () => {
  let db: FiDb, cms: ReturnType<typeof createCms>
  beforeAll(async () => { db = await createFiDb('cms030'); cms = createCms(db.sql) }, 120000)
  afterAll(async () => { await db?.close() })

  test('seeds exist and are PUBLISHED with one version each', async () => {
    for (const e of seedEntities()) {
      const row = await cms.get(e.type, e.id)
      expect(row).toBeTruthy()
      expect(row.status).toBe('published')
      expect(row.published_version_no).toBe(1)
      expect(row.draft_version_no).toBeNull()
    }
    // Global SEO is not seeded (absent = coded defaults); provisioning leaves the audit log empty.
    expect(await db.q(`SELECT 1 FROM site_settings WHERE key='seo.global'`)).toEqual([])
    expect(await db.q(`SELECT 1 FROM admin_audit_logs WHERE actor_email = 'seed@kvrn.internal'`)).toEqual([])
    const col = await db.q(`SELECT slug, is_active FROM collections WHERE slug='project-kvrn'`)
    expect(col).toEqual([{ slug: 'project-kvrn', is_active: true }])
  })

  test('seeded policies exist under their legacy slug but are deferred to the coded copy until a human publishes', async () => {
    for (const slug of ['terms', 'privacy', 'cookies', 'shipping-returns']) {
      expect(await cms.getPublishedBySlug('policy', slug)).toBeNull()          // seed-published => not served
      const rows = await db.q(`SELECT entity_id FROM content_entities WHERE entity_type='policy' AND slug=$1 AND status='published'`, [slug])
      expect(rows.length).toBe(1)                                              // …but the entity is seeded and routable
      expect(policyPath(rows[0].entity_id, slug)).toBe(slug === 'shipping-returns' ? '/support/shipping-returns' : `/${slug}`)
    }
    await adoptSeeds(db.q, ['policy'])
    for (const slug of ['terms', 'privacy', 'cookies', 'shipping-returns']) expect(await cms.getPublishedBySlug('policy', slug)).toBeTruthy()
  })

  test('re-applying 030 is a no-op (no duplicate seeds, no errors, editor changes kept)', async () => {
    await cms.saveDraft('about', 'main', { ...(await cms.get('about', 'main')).published_snapshot, lead: 'Edited lead.' }, 2, A)
    const before = await db.q(`SELECT count(*)::int AS n FROM content_entities`)
    const versions = await db.q(`SELECT count(*)::int AS n FROM content_versions`)
    const sql = fs.readFileSync(FILE, 'utf8')
    await db.db.query(sql)
    await db.db.query(sql)
    expect(await db.q(`SELECT count(*)::int AS n FROM content_entities`)).toEqual(before)
    expect(await db.q(`SELECT count(*)::int AS n FROM content_versions`)).toEqual(versions)
    expect((await cms.get('about', 'main')).draft_snapshot.lead).toBe('Edited lead.')   // not re-seeded over
    expect(await db.q(`SELECT count(*)::int AS n FROM collections WHERE slug='project-kvrn'`)).toEqual([{ n: 1 }])
  })

  test('cms_path_prefix keeps product/collection and adds page', async () => {
    const r = await db.q(`SELECT cms_path_prefix('product') a, cms_path_prefix('collection') b, cms_path_prefix('page') c, cms_path_prefix('faq') d`)
    expect(r[0]).toEqual({ a: '/products', b: '/collections', c: '/pages', d: null })
  })

  test('policy slug change publishes atomically and redirects old path → new path', async () => {
    const e = await cms.get('policy', 'terms')
    const snap = { ...e.published_snapshot, slug: 'terms-of-service' }
    const s = await cms.saveDraft('policy', 'terms', snap, e.revision, A)
    const r = (await db.q(`SELECT content_policy_go_live('terms', $1, $2) AS r`, [s.revision, A]))[0].r
    expect(r).toMatchObject({ slug: 'terms-of-service', previous_slug: 'terms', path: '/legal/terms-of-service', previous_path: '/terms', redirect_created: true })
    expect(await db.q(`SELECT from_path, to_path, status_code FROM content_redirects WHERE entity_id='terms'`))
      .toEqual([{ from_path: '/terms', to_path: '/legal/terms-of-service', status_code: 301 }])
    const aud = await db.q(`SELECT action FROM admin_audit_logs WHERE resource='policy' AND resource_id='terms' ORDER BY created_at`)
    expect(aud.map((x: any) => x.action)).toContain('cms.publish')
  })

  test('rolling the policy back restores the legacy URL and drops the redirect that would shadow it', async () => {
    const e = await cms.get('policy', 'terms')
    const r = (await db.q(`SELECT content_policy_go_live('terms', $1, $2, 1) AS r`, [e.revision, A]))[0].r
    expect(r).toMatchObject({ slug: 'terms', path: '/terms', previous_path: '/legal/terms-of-service', redirect_created: true })
    const reds = await db.q(`SELECT from_path, to_path FROM content_redirects WHERE entity_id='terms' ORDER BY from_path`)
    expect(reds).toEqual([{ from_path: '/legal/terms-of-service', to_path: '/terms' }])   // /terms is live: never a redirect source
  })

  test('stale revision fails the whole policy publish (nothing changes)', async () => {
    const e = await cms.get('policy', 'privacy')
    await cms.saveDraft('policy', 'privacy', { ...e.published_snapshot, title: 'Privacy Notice' }, e.revision, A)
    const err = await db.err(`SELECT content_policy_go_live('privacy', $1, $2)`, [e.revision, A])
    expect(err).toContain('CMS_STALE_REVISION')
    expect((await cms.get('policy', 'privacy')).published_snapshot.title).toBe('Privacy Policy')
  })

  test('product_size_guides: one guide per product, many products per guide, guide must be a size_guide', async () => {
    const prods = await db.q(`INSERT INTO products (drop_code, product_code, name, slug, price_cents)
      VALUES ('D001','TST1','Test one','test-one',1000), ('D001','TST2','Test two','test-two',1000) RETURNING id`)
    await db.q(`INSERT INTO product_size_guides (product_id, size_guide_id) VALUES ($1,'kvrn-hoodie'), ($2,'kvrn-hoodie')`, [prods[0].id, prods[1].id])
    expect(await db.err(`INSERT INTO product_size_guides (product_id, size_guide_id) VALUES ($1,'kvrn-sweatpants')`, [prods[0].id])).toMatch(/duplicate key/)
    expect(await db.err(`UPDATE product_size_guides SET size_guide_id='terms' WHERE product_id=$1`, [prods[0].id])).toMatch(/foreign key/)
  })

  test('content_block_usages scope check', async () => {
    expect(await db.err(`INSERT INTO content_block_usages (block_id, owner_type, owner_id, scope) VALUES ('b','page','p','weird')`)).toMatch(/check/)
  })

  test('KINDS cover every seeded entity type', () => {
    const types = new Set(Object.values(KINDS).map(k => k.type))
    for (const e of seedEntities()) expect(types.has(e.type)).toBe(true)
  })
})
