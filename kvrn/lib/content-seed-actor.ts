// lib/content-seed-actor.ts — the actor that migration 030 records on every SEEDED content version.
// Kept in its own tiny module so the storefront read path can use it without importing the seed data.
export const SEED_ACTOR = 'seed@kvrn.internal'
