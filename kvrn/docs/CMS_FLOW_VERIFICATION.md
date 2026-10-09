# CMS flow verification (Workstream B, 2026-10-08) — LOCAL scratch database only

**Status: code-complete and locally verified. NOT production-validated** (no production data, no R2 uploads, no real Cloudflare cache).
Run against the dev server with `KVRN_FLAG_CMS_PUBLIC_CONTENT=on KVRN_FLAG_CMS_PRODUCT_ROUTING=on` and a scratch Postgres (all migrations incl. unapplied 038–047 applied LOCALLY only).

| Area | Script | What it proves |
|---|---|---|
| Policies (terms/privacy/…) | `qa/cms-e2e/policy-lifecycle.mjs` | owner draft is draft-only; publish; edit; stale save 409; rollback; placeholder-seed rollback refused |
| Products | `qa/cms-e2e/product-lifecycle.mjs` | draft/publish/rollback incl. SHIPPING_REQUIRED publish gate |
| Announcement, navigation, footer, About, Contact | `qa/cms-e2e/singleton-lifecycle.mjs` | draft not public; stale revision 409; publish becomes public; 2nd edit; rollback restores the earlier text |
| Generic pages | `qa/cms-e2e/pages-collections-lifecycle.mjs` | draft 404 → publish renders + `<title>` + canonical + in sitemap → unpublish 404 + out of sitemap |
| Collections | same script | create → renders + canonical + in sitemap → rename (old URL 308 → new) → archive 404 → restore stays hidden (by design; UI says so) → re-activate serves |

All pass. Notes / limits:
- Restoring an archived collection leaves it **hidden** until "Show on the site" is switched on (migration 030 behaviour; UI text says so). Not a bug.
- Media upload/R2, FAQ and size-guide flows were not re-run in this pass (R2 is not reachable from the sandbox).
- Admin preview renders drafts client-side from `/api/admin/content/preview-context`; no draft is served on a public URL (verified: drafts never appear in public HTML in the scripts above).
- Defect found and fixed: `InfoTip`'s invisible touch-target pad extended 8px past the right edge when the tip sat flush right, widening every such Admin page to 398px on phones. Now vertical padding only. All 29 static Admin routes and 12 Content tabs measure exactly 390px in a 390px mobile emulation (scratch DB is mostly empty, so data-heavy layouts still need a check with real data).

How to re-run (all refuse non-localhost and write only to the scratch DB):
```
KVRN_E2E_BASE=http://localhost:3111 node qa/cms-e2e/singleton-lifecycle.mjs
KVRN_E2E_BASE=http://localhost:3111 node qa/cms-e2e/pages-collections-lifecycle.mjs
```
