# KVRN SEO baseline — measured 2026-10-08 (LOCAL only)

**Scope and honesty.** Measured against a local dev server (`http://localhost:3111`, CMS flags ON, local Postgres with migrations 001–047). It measures *crawlable, well-formed* output. It says nothing about indexing, impressions, rankings, Core Web Vitals in the field, or the production site. Production figures require Search Console / GA4 access (status: ACCESS NEEDED — see runbook).

Reproduce: `KVRN_SEO_BASE=http://localhost:3111 node scripts/seo-crawl.mjs --json out.json` (GET-only, no redirects followed, refuses production hosts, no provider APIs).

## robots.txt
`Allow: /` · `Disallow: /admin /checkout /api/` · `Sitemap:` present · does not block everything.

## Sitemap
12 URLs, 0 duplicates, 0 foreign origins, 0 URLs disallowed by robots. (Locally the origin is `localhost`; in production it comes from `NEXT_PUBLIC_SITE_URL` — verify after deploy.)

## Page lint (16 URLs fetched)
| | Before | After this branch |
|---|---|---|
| Pages with ≥1 finding | 15 / 16 | 15 / 16 |
| Findings | 21 | 19 |
| Missing canonical | `/`, `/collections/project-kvrn` | none |
| Duplicate meta descriptions | contact = size-guide = site default | none |
| `BreadcrumbList` JSON-LD | none | PDP + CMS collections |
| PDP twitter title/description | site-wide text | product text |
| `/checkout*` robots meta | `index, follow` (success) | `noindex, nofollow, nocache` |

### Remaining findings (all pages unless noted)
| Finding | Where | Disposition |
|---|---|---|
| `missing og:image` | every page except PDPs | **Owner action:** upload a 1200×630 JPG/PNG share image in Admin → Content → SEO (`shareImageId`). Not invented in code: the only brand images in `/public` are WebP, which several social crawlers handle inconsistently. |
| `h1 count 2` | `/shop`, collections, PDPs | Responsive duplicate (desktop + mobile heading, one `display:none`). Harmless to users/AT; left to avoid touching the premium layout. |
| `title long` (81/85 chars) | PDPs | Coded product titles bake in "Founder Price $80". If the price changes the title goes stale; recommend dropping the price from titles when the CMS owns product SEO (owner copy decision). |
| 404 | `/messaging-terms`, `/messaging-privacy` | Gated off by `KVRN_SMS_POLICY_PUBLIC_ENABLED` (ChatGPT/SMS owner); expected until that flag is on. Add to the sitemap only when they go live. |

## Structured data present
Home/all pages: `ClothingStore` (Organization). PDP: `Product` (+ `Offer` only with canonical price; availability only when known), `BreadcrumbList`. No `AggregateRating`/`Review` (none exist — never add without real reviews). No `ProductGroup` (see research doc).

## Not measured (no access in this environment)
Search Console coverage/queries, GA4 data, Merchant Center diagnostics, Bing/IndexNow state, production headers/redirect chains, field Core Web Vitals. See runbook for the exact steps and statuses.
