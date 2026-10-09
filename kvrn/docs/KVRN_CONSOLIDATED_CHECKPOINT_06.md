# KVRN cumulative development checkpoint 06 — production-safe browser QA

## Scope
This is another cumulative, local, development-only archive of the original owner-confirmed `07ac61f` source and all prior checkpoints. No production changes, deployments, migrations or provider sends occurred. **Do not stack checkpoints.**

## New since Checkpoint 05
- `scripts/browser-smoke.mjs`: reject `kvrn.shop`, `www.kvrn.shop`, unsafe HTTP external origins, malformed staging origins and URLs with paths/queries/credentials before trying to import Playwright or making requests. Even when a staging deployment redirects or imports assets from `kvrn.shop`, browser request interception blocks production-host traffic.
- `scripts/browser-responsive-audit.mjs`: same redirect/network isolation, stricter staging URL validation, and additional coverage for messaging terms/privacy, tracking/contact, Admin Marketing, Live View, Store Credit and Media pages. Optional authentication storage is needed for Admin route coverage.
- `scripts/test-browser-qa-guards.mjs`: offline spawned-process negative tests, no browsers launched. Added `qa:browser-guards` to `qa:consolidated-offline` so accidental live-site browser smoke is a test failure.

## Still untested / gate
- **Actual** Chromium/WebKit tests, real viewport screenshots and staging auth, full Jest/build/TypeScript, Postgres concurrency and real provider integration require dependency installation and separately authorized staging setup. Production automated browser tests are forbidden.
