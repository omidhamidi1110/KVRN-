// The placeholder-seed guard and the "Load October 6 draft" action (C), against real PostgreSQL + pure helpers.
import { createFiDb, HAVE_DB, type FiDb } from './helpers/fi-pg'
import { createContentService, ContentError, type ContentService } from '../content-service'
import { createContentPublic, type ContentPublic } from '../content-public'
import { OWNER_LEGAL_COPY } from '../owner-legal-generated'
import { parsePolicyPaste } from '../content-paste-import'
import { applyOwnerDraft, hasOwnerDraft, isOwnerNewPolicy, ownerPolicyBase, canonicalJson, OWNER_DRAFT_DATE } from '../content-owner-draft'

const A = 'owner@kvrn.test'
const d = HAVE_DB ? describe : describe.skip
const invalidate = async (t: any) => ({ id: null, ok: true, paths: t.paths ?? [], tags: t.tags ?? [] })
const rejects = async (p: Promise<any>, code: string) => { try { await p } catch (e: any) { expect(e.code).toBe(code); return e } throw new Error('expected rejection ' + code) }

describe('owner draft (pure)', () => {
  test('only terms, privacy and the two messaging policies have an owner draft (no invented cookies / shipping-returns text)', () => {
    for (const id of ['terms', 'privacy', 'messaging-terms', 'messaging-privacy']) expect(hasOwnerDraft(id)).toBe(true)
    expect(hasOwnerDraft('cookies') || hasOwnerDraft('shipping-returns')).toBe(false)
  })
  test('messaging policies are "new" (not seeded); terms/privacy are not', () => {
    expect(isOwnerNewPolicy('messaging-terms') && isOwnerNewPolicy('messaging-privacy')).toBe(true)
    expect(isOwnerNewPolicy('terms') || isOwnerNewPolicy('privacy') || isOwnerNewPolicy('cookies')).toBe(false)
  })
  test('the body is the owner text converted verbatim; other fields are kept', () => {
    const cur = { slug: 'terms', title: 'Terms of Service', style: 'legal', seo: { title: 'x' }, effectiveDate: '2026-08-12', body: { v: 1, blocks: [] } }
    const out: any = applyOwnerDraft(cur, 'terms')
    expect(out.title).toBe('Terms of Service'); expect(out.seo).toEqual({ title: 'x' }); expect(out.effectiveDate).toBe(OWNER_DRAFT_DATE)
    expect(canonicalJson(out.body)).toBe(canonicalJson(parsePolicyPaste(OWNER_LEGAL_COPY.terms).body))
  })
  test('canonicalJson ignores key order', () => { expect(canonicalJson({ a: 1, b: { d: 1, c: 2 } })).toBe(canonicalJson({ b: { c: 2, d: 1 }, a: 1 })) })
})

d('placeholder-seed guard (real PG)', () => {
  let db: FiDb, svc: ContentService, pub: ContentPublic
  beforeAll(async () => { db = await createFiDb('content_owner_draft'); svc = createContentService(db.sql, { invalidate }); pub = createContentPublic(db.sql) }, 120000)
  afterAll(async () => { await db?.close() })

  test('the editor payload flags the unchanged seed and offers the owner draft only where owner text exists', async () => {
    const t = await svc.get('policies', 'terms'); const c = await svc.get('policies', 'cookies'); const f = await svc.get('faq')
    expect([t.placeholderSeed, t.ownerDraftAvailable]).toEqual([true, true])
    expect([c.placeholderSeed, c.ownerDraftAvailable]).toEqual([true, false])
    expect(f.placeholderSeed).toBe(true)
    const a = await svc.get('about'); expect(a.placeholderSeed).toBe(false)   // seed == coded copy: nothing to guard
  })

  test('publishing the unchanged seed is refused (409) and nothing goes live', async () => {
    const cur = await svc.get('policies', 'cookies')
    const saved = await svc.saveDraft('policies', 'cookies', cur.snapshot, cur.revision, A)
    const e = await rejects(svc.publish('policies', 'cookies', saved.data.revision, A), 'seed_copy')
    expect(e.status).toBe(409)
    expect(await pub.getPolicyById('cookies')).toBeNull()
  })

  test('rolling back to the seed version is refused too', async () => {
    const cur = await svc.get('policies', 'privacy')
    await rejects(svc.rollback('policies', 'privacy', 1, cur.revision, A), 'seed_copy')
  })

  test('an edited policy can be published; Load October 6 draft writes an unpublished draft that can then be published after review', async () => {
    const before = await svc.get('policies', 'terms')
    const r = await svc.loadOwnerDraft('terms', before.revision, A)
    expect(r.data.blocks).toBeGreaterThan(20)
    expect(await pub.getPolicyById('terms')).toBeNull()                          // still not public: a draft
    const after = await svc.get('policies', 'terms')
    expect(after.hasDraft).toBe(true); expect(after.placeholderSeed).toBe(false)
    expect((after.snapshot as any).effectiveDate).toBe(OWNER_DRAFT_DATE)
    const hist = await svc.history('policies', 'terms')
    expect(hist[0].change_note).toMatch(/October 6 draft.*legal review/)
    await svc.publish('policies', 'terms', after.revision, A)                    // a human publish after review
    const live = await pub.getPolicyById('terms')
    expect(live?.path).toBe('/terms')
    expect(JSON.stringify(live!.variants.en.data.body)).toContain('Terms')
  })

  test('Load October 6 draft is refused for policies without owner text, and needs a current revision', async () => {
    const c = await svc.get('policies', 'cookies')
    await rejects(svc.loadOwnerDraft('cookies', c.revision, A), 'forbidden')
    const p = await svc.get('policies', 'privacy')
    await expect(svc.loadOwnerDraft('privacy', p.revision + 5, A)).rejects.toBeTruthy()
  })

  test('ContentError exposes the new code', () => { expect(new ContentError('seed_copy', 'x').status).toBe(409) })

  test('Messaging Terms/Privacy: not in the CMS until created; "Load October 6 draft" creates a DRAFT only and never publishes', async () => {
    for (const id of ['messaging-terms', 'messaging-privacy'] as const) {
      const before = await svc.get('policies', id)
      expect([before.exists, before.ownerDraftAvailable, before.placeholderSeed]).toEqual([false, true, false])
      expect((before.snapshot as any).style).toBe('legal')
      const r = await svc.loadOwnerDraft(id, 0, A)
      expect(r.data.blocks).toBeGreaterThan(5)
      const after = await svc.get('policies', id)
      expect([after.exists, after.hasDraft, after.isLive, after.publishedVersion]).toEqual([true, true, false, null])
      expect(canonicalJson((after.snapshot as any).body)).toBe(canonicalJson(parsePolicyPaste(OWNER_LEGAL_COPY[id]).body))
      expect(await pub.getPolicyById(id)).toBeNull()          // nothing public until a person publishes
    }
  })
  test('a stale revision is refused when the messaging draft already exists', async () => {
    await rejects(svc.loadOwnerDraft('messaging-terms', 0, A), 'stale')
  })
})

describe('policy audit separates placeholders from live content', () => {
  const { inspectPublishedContent } = require('../content-policy-audit')
  const { SEED_ACTOR } = require('../content-seed-actor')
  const stale = { body: { blocks: [{ text: 'Contact returns@kvrn.shop. UK GDPR.' }] } }
  test('seed-published rows are placeholders: not linted, not counted as live, reported as info', () => {
    const r = inspectPublishedContent([{ entity_type: 'policy', entity_id: 'terms', published_at: null, snapshot: stale, published_by: SEED_ACTOR }])
    expect(r.placeholders).toEqual(['terms']); expect(r.live).toBe(0)
    expect(r.issues.some((i: any) => i.code === 'old_returns_email')).toBe(false)
    expect(r.issues.find((i: any) => i.entityId === 'terms')?.severity).toBe('info')
  })
  test('a person-published row is linted as before', () => {
    const r = inspectPublishedContent([{ entity_type: 'policy', entity_id: 'terms', published_at: '2026-10-06T00:00:00Z', snapshot: stale, published_by: 'owner@kvrn.test' }])
    expect(r.live).toBe(1); expect(r.issues.some((i: any) => i.code === 'old_returns_email')).toBe(true)
  })

})
