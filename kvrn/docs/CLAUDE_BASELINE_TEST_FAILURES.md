# Baseline test failures at CP08 (before any Claude change)

Measured 2026-10-08 on a clean checkout of the CP08 source (tag `cp08-base`), local Postgres 18 on :5433 with
`TEST_DATABASE_URL='postgresql://postgres@localhost:5433/reservationtest?host=/tmp'` (the DB suites refuse any other URL;
without it ~146 more tests fail with 'Unexpected test database configuration' — an environment artefact, not a defect).

**14 suites / 118 tests fail at baseline; 5142 pass.** Claude's changes produce the identical failure set (no regressions).

| Failing tests | Suite | Likely owner |
|---|---|---|
| 15 | `lib/__tests__/admin-ui-refresh.test.ts` | Claude/ChatGPT: Backups pages removed in CP08; guard stale |
| 1 | `lib/__tests__/affiliate-portal-auth.test.ts` | ChatGPT/finance |
| 9 | `lib/__tests__/backup-dashboard-db.test.ts` | ChatGPT |
| 29 | `lib/__tests__/backup-dashboard.test.ts` | ChatGPT |
| 5 | `lib/__tests__/content-cms-equivalence.test.ts` | Claude (CMS goldens vs CP08 copy changes) |
| 1 | `lib/__tests__/content-cms-pure.test.ts` | Claude (CMS goldens vs CP08 copy changes) |
| 1 | `lib/__tests__/content-cms-routes.test.ts` | Claude (CMS goldens vs CP08 copy changes) |
| 9 | `lib/__tests__/content-off-path.test.ts` | Claude |
| 1 | `lib/__tests__/ga4-admin.test.ts` | Claude (GA4) |
| 2 | `lib/__tests__/ga4-runtime-config.test.ts` | Claude (GA4) |
| 1 | `lib/__tests__/marketing-subscribers.test.ts` | ChatGPT |
| 40 | `lib/__tests__/reservations.test.ts` | ChatGPT (inventory) |
| 2 | `lib/__tests__/sms-v581.test.ts` | ChatGPT |
| 2 | `lib/__tests__/support-inbox.test.ts` | investigate |


## After Claude changes (measured 2026-10-08, same environment)
**10 suites / 102 tests fail; 5175 pass** (baseline 14 / 118). The 16 fixed tests are the Claude-owned CMS ones
(`content-cms-equivalence` 5, `content-cms-pure` 1, `content-cms-routes` 1, `content-off-path` 9). No suite fails that did not fail at baseline.
Remaining failures are ChatGPT-owned (backup-dashboard*, reservations, sms-v581, marketing-subscribers, affiliate-portal-auth, support-inbox)
plus Claude-owned `admin-ui-refresh` (stale Backups guard) and the two GA4 suites (being addressed in workstream D).

## After workstreams A–E (measured 2026-10-08, same environment)
**7 suites / 84 tests fail; 5232 pass** (baseline 14 / 118). Every remaining failing suite was failing at baseline and is
outside Claude's ownership: `affiliate-portal-auth` (1), `backup-dashboard-db` (9), `backup-dashboard` (29),
`marketing-subscribers` (1), `reservations` (40), `sms-v581` (2), `support-inbox` (2). All Claude-owned suites pass
(CMS, GA4, admin-ui-refresh, responsive containment, responsive images, PDP/shop goldens).
Note: the 4 PDP golden HTML fixtures were intentionally regenerated for workstream E; the diff is only added `srcSet` attributes.

## Final (all workstreams A–F, measured 2026-10-08, same environment)
**7 suites / 84 tests fail; 5248 pass; 2 skipped (5334 total)** — baseline was 14 / 118 failing, 5142 passing.
Failing suites are unchanged from the baseline list and are ChatGPT-owned: `affiliate-portal-auth` (1), `backup-dashboard-db` (9),
`backup-dashboard` (29), `marketing-subscribers` (1), `reservations` (40), `sms-v581` (2), `support-inbox` (2).
`eslint` on all 99 changed source files: 0 errors. `tsc --noEmit`: 0 errors in any file Claude changed; the remaining errors are the
ChatGPT-owned build blockers documented in `proposals/BUILD_BLOCKERS_CP08.md`. `next build` (production mode) succeeds once those two blockers are patched.
