// Migration 027 against real PostgreSQL: atomic draft/publish/rollback/schedule/archive,
// stale-edit protection, slug uniqueness + redirects, immutability, settings, translations.
import { createFiDb, HAVE_DB, type FiDb } from './helpers/fi-pg'
import { createCms, CmsError } from '../cms-core'
import { putSetting, getSetting, SettingsStaleError } from '../site-settings'
import { upsertTranslation } from '../translations'

const d = HAVE_DB ? describe : describe.skip
const A = 'owner@kvrn.test'

d('027 CMS foundation (real PG)', () => {
  let db: FiDb, cms: ReturnType<typeof createCms>
  beforeAll(async () => { db = await createFiDb('cms027'); cms = createCms(db.sql) }, 120000)
  afterAll(async () => { await db?.close() })

  const rejects = async (p: Promise<any>, code: string) => {
    try { await p } catch (e: any) { expect(e).toBeInstanceOf(CmsError); expect(e.code).toBe(code); return }
    throw new Error('expected rejection ' + code)
  }

  test('create → autosave keeps ONE draft version, revision increments', async () => {
    const a = await cms.saveDraft('page', 'p1', { slug: 'care', title: 'Care' }, 0, A)
    expect(a).toMatchObject({ version_no: 1, revision: 1, created: true })
    const b = await cms.saveDraft('page', 'p1', { slug: 'care', title: 'Care v2' }, 1, A)
    expect(b).toMatchObject({ version_no: 1, revision: 2, created: false })
    expect((await cms.history('page', 'p1'))).toHaveLength(1)
  })

  test('stale revision is rejected, never silently overwritten', async () => {
    await rejects(cms.saveDraft('page', 'p1', { slug: 'care', title: 'X' }, 1, A), 'stale')
    await rejects(cms.saveDraft('page', 'new-but-claims-rev', { slug: 'n' }, 5, A), 'stale')
    const row = await cms.get('page', 'p1')
    expect(row.draft_snapshot.title).toBe('Care v2')
  })

  test('publish is atomic: draft → live, audit row written, draft cleared', async () => {
    const r = await cms.publish('page', 'p1', 2, A, '/pages')
    expect(r).toMatchObject({ version_no: 1, slug: 'care', revision: 3 })
    const row = await cms.get('page', 'p1')
    expect(row.status).toBe('published'); expect(row.draft_version_no).toBeNull(); expect(row.published_version_no).toBe(1)
    expect((await cms.getPublishedBySlug('page', 'CARE')).snapshot.title).toBe('Care v2')
    const aud = await db.q(`SELECT action, actor_email FROM admin_audit_logs WHERE resource='page' AND resource_id='p1'`)
    expect(aud).toEqual([{ action: 'cms.publish', actor_email: A }])
  })

  test('editing after publish creates version 2 draft; live content is untouched until publish', async () => {
    const s = await cms.saveDraft('page', 'p1', { slug: 'care-guide', title: 'Care guide' }, 3, A)
    expect(s).toMatchObject({ version_no: 2, created: false })
    expect((await cms.getPublishedBySlug('page', 'care')).snapshot.title).toBe('Care v2')   // still live
    expect(await cms.getPublishedBySlug('page', 'care-guide')).toBeNull()
  })

  test('slug change on publish creates a 301 redirect and flattens chains', async () => {
    const r = await cms.publish('page', 'p1', 4, A, '/pages')
    expect(r).toMatchObject({ slug: 'care-guide', previous_slug: 'care', redirect_created: true })
    expect(await db.q(`SELECT from_path, to_path, status_code FROM content_redirects ORDER BY from_path`))
      .toEqual([{ from_path: '/pages/care', to_path: '/pages/care-guide', status_code: 301 }])
    // change again → old redirect is flattened to the newest live path
    await cms.saveDraft('page', 'p1', { slug: 'care-final', title: 'F' }, 5, A)
    await cms.publish('page', 'p1', 6, A, '/pages')
    const reds = await db.q(`SELECT from_path, to_path FROM content_redirects ORDER BY from_path`)
    expect(reds).toEqual([
      { from_path: '/pages/care', to_path: '/pages/care-final' },
      { from_path: '/pages/care-guide', to_path: '/pages/care-final' },
    ])
  })

  test('republishing an old slug removes the redirect that would shadow it (no loop)', async () => {
    await cms.saveDraft('page', 'p1', { slug: 'care', title: 'Back' }, 7, A)
    await cms.publish('page', 'p1', 8, A, '/pages')
    const reds = await db.q(`SELECT from_path, to_path FROM content_redirects ORDER BY from_path`)
    expect(reds.find((r: any) => r.from_path === '/pages/care')).toBeUndefined()
    expect(reds.every((r: any) => r.to_path === '/pages/care')).toBe(true)
  })

  test('live slug is unique per entity type (case-insensitive); other types may reuse', async () => {
    await cms.saveDraft('page', 'p2', { slug: 'CARE', title: 'dup' }, 0, A)
    await rejects(cms.publish('page', 'p2', 1, A, '/pages'), 'slug_taken')
    // failed publish rolled back completely
    const row = await cms.get('page', 'p2'); expect(row.status).toBe('draft'); expect(row.published_version_no).toBeNull()
    await cms.saveDraft('policy', 'pol1', { slug: 'care', title: 'other type' }, 0, A)
    await expect(cms.publish('policy', 'pol1', 1, A)).resolves.toBeDefined()
  })

  test('rollback = NEW version with the old snapshot (history append-only)', async () => {
    const before = await cms.history('page', 'p1')
    const head = await cms.get('page', 'p1')
    const r = await cms.rollback('page', 'p1', 1, head.revision, A, '/pages')
    const after = await cms.history('page', 'p1')
    expect(after.length).toBe(before.length + 1)
    expect(after[0]).toMatchObject({ rolled_back_from: 1, state: 'published' })
    expect((await cms.getPublishedBySlug('page', r.slug!)).snapshot.title).toBe('Care v2')
    expect(await cms.getVersion('page', 'p1', 1)).toMatchObject({ state: 'superseded' })
  })

  test('published/superseded versions are immutable at the database level', async () => {
    expect(await db.err(`UPDATE content_versions SET snapshot='{"x":1}' WHERE entity_type='page' AND entity_id='p1' AND version_no=1`)).toMatch(/CONTENT_VERSION_IMMUTABLE/)
    expect(await db.err(`DELETE FROM content_versions WHERE entity_type='page' AND entity_id='p1' AND version_no=1`)).toMatch(/CONTENT_VERSION_IMMUTABLE/)
  })

  test('unpublish removes it from the storefront read path; republish needs a draft', async () => {
    const head = await cms.get('page', 'p1')
    await cms.unpublish('page', 'p1', head.revision, A)
    expect(await cms.getPublishedBySlug('page', 'care')).toBeNull()
    await rejects(cms.publish('page', 'p1', head.revision + 1, A, '/pages'), 'no_draft')
  })

  test('archive blocks edits; restore never auto-publishes', async () => {
    let h = await cms.get('page', 'p1')
    await cms.archive('page', 'p1', h.revision, A)
    h = await cms.get('page', 'p1')
    await rejects(cms.saveDraft('page', 'p1', { slug: 'x' }, h.revision, A), 'archived')
    await cms.restore('page', 'p1', h.revision, A)
    h = await cms.get('page', 'p1')
    expect(['draft', 'unpublished']).toContain(h.status)
    expect(await cms.getPublishedBySlug('page', 'care')).toBeNull()
  })

  test('scheduling: validates, then the due-runner publishes and unpublishes', async () => {
    await cms.saveDraft('product', 'pr1', { slug: 'sched-prod', title: 'S' }, 0, A)
    const soon = new Date(Date.now() + 3600_000)
    await rejects(cms.schedule('product', 'pr1', new Date(Date.now() - 1000), null, 1, A), 'bad_schedule')
    await rejects(cms.schedule('product', 'pr1', soon, new Date(soon.getTime() - 1), 1, A), 'bad_schedule')
    await cms.schedule('product', 'pr1', soon, null, 1, A)
    expect((await cms.get('product', 'pr1')).status).toBe('scheduled')
    // not due yet
    expect(await cms.applyDue()).toEqual([])
    // make it due (simulating time passing) and run
    await db.q(`UPDATE content_entities SET publish_at = NOW() - interval '1 minute' WHERE entity_id='pr1'`)
    const out = await cms.applyDue()
    expect(out).toEqual([{ entity_type: 'product', entity_id: 'pr1', action: 'publish', ok: true }])
    expect((await cms.getPublishedBySlug('product', 'sched-prod')).snapshot.title).toBe('S')
    await db.q(`UPDATE content_entities SET unpublish_at = NOW() - interval '1 second' WHERE entity_id='pr1'`)
    expect((await cms.applyDue())[0]).toMatchObject({ action: 'unpublish', ok: true })
    expect(await cms.getPublishedBySlug('product', 'sched-prod')).toBeNull()
    // idempotent: running again does nothing
    expect(await cms.applyDue()).toEqual([])
  })

  test('scheduled publish blocked by a slug taken meanwhile does not break other entities', async () => {
    await cms.saveDraft('product', 'a1', { slug: 'dup-s' }, 0, A)
    await cms.schedule('product', 'a1', new Date(Date.now() + 3600_000), null, 1, A)
    await cms.saveDraft('product', 'a2', { slug: 'dup-s' }, 0, A)
    await db.q(`UPDATE content_entities SET status='published', slug='dup-s', published_version_no=1, draft_version_no=NULL WHERE entity_id='a2'`)
    await db.q(`UPDATE content_versions SET state='published' WHERE entity_id='a2'`)
    await cms.saveDraft('product', 'a3', { slug: 'ok-s' }, 0, A)
    await cms.schedule('product', 'a3', new Date(Date.now() + 3600_000), null, 1, A)
    await db.q(`UPDATE content_entities SET publish_at = NOW() - interval '1 minute' WHERE entity_id IN ('a1','a3')`)
    const out = await cms.applyDue()
    expect(out.find(o => o.entity_id === 'a1')).toMatchObject({ ok: false })
    expect(out.find(o => o.entity_id === 'a3')).toMatchObject({ ok: true })
  })

  test('settings: optimistic revision + audit', async () => {
    expect((await getSetting(db.sql, 'seo.global', { t: 'x' }))).toEqual({ value: { t: 'x' }, revision: 0 })
    expect(await putSetting(db.sql, 'seo.global', { t: 1 }, 0, A)).toEqual({ revision: 1 })
    await expect(putSetting(db.sql, 'seo.global', { t: 2 }, 0, A)).rejects.toBeInstanceOf(SettingsStaleError)
    expect(await putSetting(db.sql, 'seo.global', { t: 2 }, 1, A)).toEqual({ revision: 2 })
    expect((await getSetting(db.sql, 'seo.global', null)).value).toEqual({ t: 2 })
    expect((await db.q(`SELECT count(*)::int n FROM admin_audit_logs WHERE resource='site_settings'`))[0].n).toBe(2)
  })

  test('translations: machine-generated text can never be published; locale format enforced', async () => {
    await upsertTranslation(db.sql, { entityType: 'page', entityId: 'p1', locale: 'es', field: 'title', value: 'x', status: 'published', machineGenerated: true, actor: A })
    expect((await db.q(`SELECT status FROM content_translations WHERE locale='es'`))[0].status).toBe('draft')
    expect(await db.err(`INSERT INTO content_translations(entity_type,entity_id,locale,field,value,status,machine_generated) VALUES('p','1','es','f','v','published',true)`)).toMatch(/no_machine_publish/)
    expect(await db.err(`INSERT INTO content_translations(entity_type,entity_id,locale,field,value) VALUES('p','1','English!','f','v')`)).toMatch(/locale_chk/)
  })

  test('media: sha256 unique (no duplicate binary), SVG mime impossible, usages restrict delete', async () => {
    const sha = 'a'.repeat(64)
    await db.q(`INSERT INTO media_assets(storage_key,sha256,mime_type,byte_size,filename) VALUES('media/aa/${sha}/original.webp','${sha}','image/webp',10,'a.webp')`)
    expect(await db.err(`INSERT INTO media_assets(storage_key,sha256,mime_type,byte_size,filename) VALUES('media/aa/other/original.webp','${sha}','image/webp',10,'b.webp')`)).toMatch(/sha256_uq/)
    expect(await db.err(`INSERT INTO media_assets(storage_key,sha256,mime_type,byte_size,filename) VALUES('k','${'b'.repeat(64)}','image/svg+xml',10,'b.svg')`)).toMatch(/mime_chk/)
    const [{ id }] = await db.q(`SELECT id FROM media_assets LIMIT 1`)
    await db.q(`INSERT INTO media_usages(asset_id,owner_type,owner_id,slot) VALUES($1,'product','x','hero')`, [id])
    expect(await db.err(`DELETE FROM media_assets WHERE id=$1`, [id])).toMatch(/RESTRICT setting of foreign key|violates foreign key constraint "media_usages_asset_id_fkey"/)
  })

  test('migration 027 is idempotent (re-apply is a no-op)', async () => {
    const fs = require('fs'), path = require('path')
    const sqlText = fs.readFileSync(path.join(__dirname, '../../db/migrations/027_cms_foundation.sql'), 'utf8')
    await expect(db.db.query(sqlText)).resolves.toBeDefined()
  })
})

import { syncMediaUsages, listMediaUsages, findUnusableAssets } from '../media-usage'
d('media usage sync (real PG)', () => {
  let db2: FiDb
  const A1 = '11111111-1111-4111-8111-111111111111', A2 = '22222222-2222-4222-8222-222222222222'
  beforeAll(async () => {
    db2 = await createFiDb('media027')
    for (const [id, c] of [[A1, 'c'], [A2, 'd']]) {
      await db2.q(`INSERT INTO media_assets(id,storage_key,sha256,mime_type,byte_size,filename) VALUES($1,$2,$3,'image/webp',5,'f.webp')`, [id, `media/${c}${c}/${c.repeat(64)}/original.webp`, c.repeat(64)])
    }
  }, 120000)
  afterAll(async () => { await db2?.close() })

  test('sync is a REPLACE per owner+scope; draft and published are independent', async () => {
    await syncMediaUsages(db2.sql, { ownerType: 'product', ownerId: 'p', scope: 'draft', refs: [{ slot: 'hero', assetId: A1 }, { slot: 'g1', assetId: A2 }] })
    await syncMediaUsages(db2.sql, { ownerType: 'product', ownerId: 'p', scope: 'published', refs: [{ slot: 'hero', assetId: A1 }] })
    expect((await listMediaUsages(db2.sql, A1)).map(u => u.scope).sort()).toEqual(['draft', 'published'])
    await syncMediaUsages(db2.sql, { ownerType: 'product', ownerId: 'p', scope: 'draft', refs: [{ slot: 'hero', assetId: A1 }] })
    expect(await listMediaUsages(db2.sql, A2)).toEqual([])
    await syncMediaUsages(db2.sql, { ownerType: 'product', ownerId: 'p', scope: 'published', refs: [] })
    expect((await listMediaUsages(db2.sql, A1)).map(u => u.scope)).toEqual(['draft'])
  })
  test('unknown asset ids are ignored (no FK crash) and archived/missing assets are flagged unusable', async () => {
    await syncMediaUsages(db2.sql, { ownerType: 'page', ownerId: 'x', scope: 'draft', refs: [{ slot: 's', assetId: '33333333-3333-4333-8333-333333333333' }] })
    expect(await db2.q(`SELECT 1 FROM media_usages WHERE owner_id='x'`)).toEqual([])
    await db2.q(`UPDATE media_assets SET status='archived' WHERE id=$1`, [A2])
    expect(await findUnusableAssets(db2.sql, [A1, A2, '33333333-3333-4333-8333-333333333333'])).toEqual([A2, '33333333-3333-4333-8333-333333333333'])
  })
})
