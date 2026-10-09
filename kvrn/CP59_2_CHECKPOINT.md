# KVRN CP59.2 — Local browser cart runner selector correction

Baseline: verified CP58.1, CP57, CP56.1 and CP59.1 local fixture setup; CP59.1 browser test failed waiting for a brittle inline-style scroll-snap locator.

Only `scripts/cp59-local-cart-fixture.mjs` application-adjacent test code is modified. CP59.2 uses the initial desktop product hero, which has native size and Add to Bag controls, as its browser purchase entry point. It scopes M, S, and Add to Bag to that visible hero, keeping real browser pointer interception (no force clicks, DOM dispatch, or live provider access).

CP59.2 was syntax-checked and compared byte for byte to CP59.1 (only the cart QA script differs before adding checkpoint metadata). Full PostgreSQL/Chromium/browser execution remains pending in the owner's Codespaces.

Safety: previous 001–065 migrations, all server and application code and assets, and prior tests are unchanged. Synthetic PG is cloned locally; real Neon HTTP adapter, payment, shipping, authenticated admin and R2 still need separate verification.

Instructions: do not extract the cumulative backup onto live staging. Install the single runner file only after verifying SHA256 of installed CP59.1 runner matches `bc98c6c79c9b4c79aa6e23c0708bb89f984b0f0806e71fbc72074a63ec8f15aa`. The replacement runner's SHA256 is `4e573477ad804689b3390f33d3f2730417d4b57a180390261a484113eb90901d`. Run `node scripts/cp59-local-cart-fixture.mjs` in merged staging.
