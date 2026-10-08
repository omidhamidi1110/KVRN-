// lib/content-seed.ts — builds the idempotent SEED section of migration 030 from the coded
// content, so the SQL file and the TypeScript source of truth cannot drift:
//   lib/__tests__/content-seed-equivalence.test.ts regenerates this SQL and requires it to be
//   byte-identical to the block inside db/migrations/030_site_content_cms.sql.
//
// Every seed runs only when its entity does not exist yet (re-applying 030 is a no-op, and an
// editor's later changes are never overwritten). Entities are created through the foundation
// functions (cms_save_draft + cms_publish) so versions and audit rows are real.

import {
  DEFAULT_NAVIGATION, DEFAULT_FOOTER, DEFAULT_ANNOUNCEMENT, DEFAULT_ABOUT, DEFAULT_CONTACT,
  DEFAULT_SIZE_GUIDE_PAGE, DEFAULT_GLOBAL_SEO,
} from './content-defaults'
import { SEED_POLICIES, SEED_FAQ, SEED_SIZE_GUIDES } from './content-seed-data'

export const SEED_BEGIN = '-- BEGIN GENERATED SEED (lib/content-seed.ts — do not edit by hand)'
export const SEED_END = '-- END GENERATED SEED'
export const SEED_ACTOR = 'seed@kvrn.internal'

export interface SeedEntity { type: string; id: string; snapshot: unknown }

export function seedEntities(): SeedEntity[] {
  return [
    ...SEED_POLICIES.map(p => ({ type: 'policy', id: p.id, snapshot: p.snapshot })),
    ...SEED_SIZE_GUIDES.map(g => ({ type: 'size_guide', id: g.id, snapshot: g.snapshot })),
    { type: 'faq', id: 'main', snapshot: SEED_FAQ },
    { type: 'support_page', id: 'size-guide', snapshot: DEFAULT_SIZE_GUIDE_PAGE },
    { type: 'about', id: 'main', snapshot: DEFAULT_ABOUT },
    { type: 'contact', id: 'main', snapshot: DEFAULT_CONTACT },
    { type: 'announcement', id: 'main', snapshot: DEFAULT_ANNOUNCEMENT },
    { type: 'navigation', id: 'main', snapshot: DEFAULT_NAVIGATION },
    { type: 'footer', id: 'main', snapshot: DEFAULT_FOOTER },
  ]
}

const q = (s: string) => `'${s.replace(/'/g, "''")}'`
/** Dollar-quoted JSON literal. The tag cannot occur in our JSON (asserted). */
function jsonLit(v: unknown): string {
  const json = JSON.stringify(v)
  if (json.includes('$kvrn$')) throw new Error('seed JSON contains the dollar-quote tag')
  return `$kvrn$${json}$kvrn$::jsonb`
}

export function buildSeedSql(): string {
  const lines: string[] = [SEED_BEGIN, 'DO $kvrn_seed$', 'BEGIN']
  for (const e of seedEntities()) {
    lines.push(
      `  IF NOT EXISTS (SELECT 1 FROM content_entities WHERE entity_type = ${q(e.type)} AND entity_id = ${q(e.id)}) THEN`,
      `    PERFORM cms_save_draft(${q(e.type)}, ${q(e.id)}, ${jsonLit(e.snapshot)}, 0, ${q(SEED_ACTOR)}, 'Seeded from the coded storefront content');`,
      `    PERFORM cms_publish(${q(e.type)}, ${q(e.id)}, 1, ${q(SEED_ACTOR)}, NULL);`,
      '  END IF;',
    )
  }
  lines.push(
    // Provisioning is not an admin action: drop the audit rows the lifecycle functions just wrote for
    // the seed actor so a fresh database starts with an empty audit log (provenance stays on the
    // version rows: created_by / published_by = the seed actor). Global SEO is deliberately NOT seeded:
    // an absent `seo.global` setting already resolves to the coded defaults, and the first admin save creates it.
    `  DELETE FROM admin_audit_logs WHERE actor_email = ${q(SEED_ACTOR)};`,
    // The existing coded collection page, so /collections/project-kvrn has a CMS record to edit.
    `  INSERT INTO collections (slug, name, description, is_active, sort_order, seo, created_by)`,
    `  VALUES ('project-kvrn', 'Project KVRN', 'Shop the Project KVRN collection. 500 GSM French terry, enzyme washed, pre-shrunk.', TRUE, 1,`,
    `          ${jsonLit({ title: 'Project KVRN — Available Now', description: 'Shop the Project KVRN collection. 500 GSM French terry, enzyme washed, pre-shrunk.' })}, ${q(SEED_ACTOR)})`,
    `  ON CONFLICT (slug) DO NOTHING;`,
    // Mirror the coded collection (Project KVRN hoodie + sweatpants) — only when it has no products yet.
    `  INSERT INTO collection_products (collection_id, product_id, position)`,
    `  SELECT c.id, p.id, ROW_NUMBER() OVER (ORDER BY p.product_code)::int`,
    `    FROM collections c JOIN products p ON p.product_code IN ('PKHH', 'PKHSP')`,
    `   WHERE c.slug = 'project-kvrn'`,
    `     AND NOT EXISTS (SELECT 1 FROM collection_products cp WHERE cp.collection_id = c.id)`,
    `  ON CONFLICT DO NOTHING;`,
    'END',
    '$kvrn_seed$;',
    SEED_END,
  )
  return lines.join('\n')
}
