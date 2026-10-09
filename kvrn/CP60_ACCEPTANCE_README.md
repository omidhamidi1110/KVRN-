# CP60 final acceptance — reconciled metadata installer

This package corrects the CP60 installation blocker identified from the Codespaces
read-only diagnostic: 1,261 of 1,267 baseline paths matched, four old checkpoint
notes/manifests were absent, and two recovery docs differed locally.

## Strict reconciliation, no app changes

- Restore only the canonical CP54_README.txt, CP54_SOURCE_MANIFEST.json,
  CP55_README.txt, and CP59_2_CHECKPOINT.md from pinned CP59.2 archive hashes.
- Preserve (do not replace) `MANIFEST_SHA256.json` and `README_RECOVERY.txt`.
  Their local SHA-256 values are reported for future investigation, not silently
  considered identical to canonical CP59.2 copies.
- Every other file in the 1,267-entry manifest, including all application code,
  financial migrations, configs, and test runners, must have its exact CP59.2 hash.
  Unexpected changes fail before any files are copied.
- CP60 introduces only local QA scripts and reports. No Git merge, migrations,
  Neon writes, Cloudflare deployment, provider network actions, or other production
  modifications are performed.

## Run once in existing Codespaces

From `/workspaces/KVRN-`:

```
unzip -oq KVRN_CP60_ACCEPTANCE_RECONCILED.zip -d cp60-reconciled
python3 cp60-reconciled/CP60_INSTALL.py
cd kvrn-merged-staging
node scripts/cp60-final-acceptance.mjs
```

Don't use `set -e` in your interactive shell; the installer itself exits nonzero
on any error and `&&` may be used to gate later steps.

## What CP60 tests

- TypeScript in current Codespaces node_modules
- 11 targeted backend/admin/checkout/shipping/webhook Jest suites
- 18 local Cloudflare Worker API failure/permission checks with providers disabled
- read-only source delta against original `kvrn` for later manual Git integration
- npm production dependency advisory review (may flag REVIEW)

The acceptance report is `/tmp/kvrn-cp60-acceptance.json`, and merge plan is
`/tmp/kvrn-cp60-merge-plan.json`. A CP60 LOCAL ACCEPTANCE PASS is a **local** gate,
not real Stripe, Shippo, R2, authenticated CMS, or production release approval.
