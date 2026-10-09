// Test helper: simulate a HUMAN adopting the migration-030 seed content.
// The storefront deliberately ignores seed-published versions (see lib/content-seed-actor.ts), so a test that wants
// the "seed became live" behaviour must record a human as the publisher, exactly as the Admin "Publish" button would.
import { SEED_ACTOR } from '../../content-seed-actor'

type Q = (text: string, params?: unknown[]) => Promise<any[]>

/** Re-attribute seeded published versions to a human. Optionally limited to entity types. Returns rows changed. */
export async function adoptSeeds(q: Q, types?: string[], human = 'owner@kvrn.test'): Promise<number> {
  const r = types?.length
    ? await q(`UPDATE content_versions SET published_by = $1
               WHERE published_by = $2 AND entity_type = ANY($3::text[]) RETURNING entity_id`, [human, SEED_ACTOR, types])
    : await q(`UPDATE content_versions SET published_by = $1 WHERE published_by = $2 RETURNING entity_id`, [human, SEED_ACTOR])
  return r.length
}
