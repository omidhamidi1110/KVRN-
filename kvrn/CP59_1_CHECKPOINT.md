# KVRN CP59.1 — browser flow test correction

**Baseline:** CP59 (failed in owner Codespaces on 2026-10-08). CP58.1 public browser, CP57 local edge, CP56 financial tests stay verified.

**Failure cause:** Playwright used an unscoped size-button selector while the PDP's snap hero/gallery remained open; the fixed image overlay intercepted clicks. A visitor cookie banner also appeared during the attempted click. The local PostgreSQL fixture, 12 queried variants, and safe cleanup had passed.

**Change:** only `scripts/cp59-local-cart-fixture.mjs` changes, to click **Deny non-essential**, use the PDP's gallery **Shop** control to exit the snap overlay, then click an in-stock M size in the regular purchase panel. Strict Playwright pointer hit-testing is preserved (no `force:true`). S must remain disabled. No changes to any app or finance code, SQL or prior test runners.

**Verification:** JavaScript syntax and self-test verified in package-building environment; full isolated PostgreSQL + Chromium run remains necessary in owner's Codespaces.

**Commands** (upload CP59_1_CART_QA_FIX.zip to `/workspaces/KVRN-/` first):

```bash
cd /workspaces/KVRN-
unzip -oq KVRN_CP59_1_CART_QA_FIX.zip -d cp59-1-fix
python3 cp59-1-fix/CP59_1_APPLY_PATCH.py
cd kvrn-merged-staging
node scripts/cp59-local-cart-fixture.mjs
```

**Expected:** `CP59 CART UI PASS`, followed by safe local DB cleanup. This proves only synthetic, browser-intercepted stock-to-cart flow; real Neon HTTP inventory, payment and shipping remain unverified.
