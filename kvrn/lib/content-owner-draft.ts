// lib/content-owner-draft.ts — pure helpers for the "Load the October 6 draft" action and the placeholder-seed guard.
//
// WHY: migration 030 seeded the CMS with an OLDER copy of the policies (change note "Seeded from the coded storefront content").
// The storefront deliberately ignores seed-published versions (lib/content-seed-actor.ts) and serves the coded October 6 owner copy.
// Without a guard, an editor who opens a seeded policy and clicks Publish would silently replace the October 6 text with the older
// seed. So: (1) publishing/rolling back to an unchanged seed is refused, and (2) the editor can load the owner's October 6 text
// into the DRAFT — still unpublished, still needing owner approval and legal review.
//
// This module never touches the database and never publishes anything.
import { parsePolicyPaste } from './content-paste-import'
import { OWNER_LEGAL_COPY } from './owner-legal-generated'
import { seedEntities } from './content-seed'

/** Policies for which the owner supplied an October 6 text (verbatim source: content/legal/*.txt). */
export const OWNER_DRAFT_POLICIES = ['terms', 'privacy', 'messaging-terms', 'messaging-privacy'] as const
export type OwnerDraftPolicy = (typeof OWNER_DRAFT_POLICIES)[number]
export const OWNER_DRAFT_DATE = '2026-10-06'
export const OWNER_DRAFT_NOTE = 'Loaded from the owner’s October 6 draft. Needs owner approval and legal review before publishing.'

/**
 * Policies that are NOT seeded by migration 030: the CMS row does not exist until an editor creates it. For these the editor opens a
 * blank default and "Load October 6 draft" CREATES the draft row (still unpublished; the public route additionally stays 404 unless
 * KVRN_SMS_POLICY_PUBLIC_ENABLED=true). Nothing here touches SMS consent machinery.
 */
export const OWNER_NEW_POLICY_TITLES: Readonly<Record<string, string>> = {
  'messaging-terms': 'Messaging Terms & Conditions',
  'messaging-privacy': 'Messaging Privacy Policy',
}
export const isOwnerNewPolicy = (id: string): boolean => Object.prototype.hasOwnProperty.call(OWNER_NEW_POLICY_TITLES, id)

/** Blank starting snapshot for a not-yet-created owner policy (body is filled by applyOwnerDraft). */
export function ownerPolicyBase(id: string): Record<string, unknown> {
  const title = OWNER_NEW_POLICY_TITLES[id]
  return { slug: id, title, heroTitle: title, heroBreadcrumb: title, style: 'legal', body: { v: 1, blocks: [] }, seo: {} }
}

export const hasOwnerDraft = (id: string): id is OwnerDraftPolicy => (OWNER_DRAFT_POLICIES as readonly string[]).includes(id)

/** Stable JSON (sorted keys) so two snapshots compare by content, not key order. */
export function canonicalJson(v: unknown): string {
  const norm = (x: any): any => Array.isArray(x) ? x.map(norm)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map(k => [k, norm(x[k])])) : x
  return JSON.stringify(norm(v))
}

/** Replace the body (and effective date) of a policy snapshot with the owner's October 6 text; everything else is kept. */
export function applyOwnerDraft(current: Record<string, unknown>, id: OwnerDraftPolicy): Record<string, unknown> {
  const doc = parsePolicyPaste(OWNER_LEGAL_COPY[id])
  return { ...current, body: doc.body, effectiveDate: OWNER_DRAFT_DATE }
}

/** Only these types were seeded with copy that has since drifted from the coded October 6 pages. */
const GUARDED_TYPES = new Set(['policy', 'faq'])

/**
 * True when `parsedSnapshot` (already validated/normalised) is exactly the migration-030 placeholder for this entity.
 * `parseSeed` must be the same normaliser used for `parsedSnapshot` so both sides are comparable.
 */
export function isPlaceholderSeed(type: string, id: string, parsedSnapshot: unknown, parseSeed: (seed: unknown) => unknown): boolean {
  if (!GUARDED_TYPES.has(type)) return false
  const seed = seedEntities().find(e => e.type === type && e.id === id)
  if (!seed) return false
  try { return canonicalJson(parseSeed(seed.snapshot)) === canonicalJson(parsedSnapshot) } catch { return false }
}

export const SEED_COPY_MESSAGE =
  'This is the original placeholder text installed by the migration, not the copy the site shows now (the version built into the site’s code). ' +
  'Publishing it unchanged would replace that copy. Edit it first (for terms and privacy you can use “Load October 6 draft”), then publish after owner approval and legal review.'
