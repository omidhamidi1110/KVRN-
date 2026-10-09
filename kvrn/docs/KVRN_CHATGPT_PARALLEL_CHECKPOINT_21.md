# ChatGPT parallel Checkpoint 21 — October 8, 2026

Cumulative from shared Checkpoint 08 + all ChatGPT work through Checkpoint 20; not production-ready.

## Added after Checkpoint 20
- New **pure SMS message composer**: KVRN identity prefix and full STOP opt-out instruction are included before estimating final SMS length/segments. Avoids the underquoted segment-count issue where adding the footer after the preview turns one segment into two.
- Rejects unsupported dynamic/PII tokens, HTML, control chars, suspicious URL schemes, invalid source and messages exceeding initial one-segment cap; still never guarantees actual carrier billing.
- Both main Marketing campaign previews and reusable template editor use final composed text/segment estimator. No send, schedule, or budget reservation is triggered by preview.
- 8/8 new composition tests; amended outdated source guard to assert composed pricing rather than pre-footer estimation.

## Verification and deployment gate

`npm run qa:consolidated-offline` PASSED, including 48/48 development gates, 8/8 SMS composer tests, 144 parsed TS/TSX files and 254 routed surfaces registered. Full Jest/Next/build, database/provider and browser tests remain pending. Zero production changes. Migrations 038–056 unapplied. Claude owns a separate CMS/SEO/front-end branch; merge later with conflict review.
